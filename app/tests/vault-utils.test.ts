import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';

vi.mock('../pages/api/db', () => ({
    getDB: vi.fn()
}));

vi.mock('../utils/logger.js', () => ({
    default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() }
}));

import { getDB } from '../pages/api/db';
import { unlockVaultWithPassphrase } from '../utils/vault-utils';
import VaultStore from '../pages/api/utils/VaultStore';

const LEGACY_SALT = 'nudlers-vault-salt';
const PASSPHRASE = 'test-passphrase-long';

function wrapMasterKey(masterKey: Buffer, passphrase: string, salt: Buffer): string {
    const wrappingKey = crypto.scryptSync(passphrase, salt, 32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, iv);
    const wrapped = Buffer.concat([cipher.update(masterKey), cipher.final()]);
    return `${iv.toString('hex')}:${wrapped.toString('hex')}:${cipher.getAuthTag().toString('hex')}`;
}

describe('unlockVaultWithPassphrase legacy migration', () => {
    let mockClient: any;
    const masterKey = Buffer.alloc(32, 7);
    const legacyWrapped = wrapMasterKey(masterKey, PASSPHRASE, Buffer.from(LEGACY_SALT));

    beforeEach(() => {
        vi.clearAllMocks();
        VaultStore.clear();
        mockClient = {
            query: vi.fn(),
            release: vi.fn()
        };
        (getDB as any).mockResolvedValue(mockClient);
    });

    afterEach(() => {
        VaultStore.clear();
        vi.restoreAllMocks();
    });

    it('migrates a legacy vault inside a transaction (BEGIN ... COMMIT)', async () => {
        // No vault_salt row → legacy vault.
        mockClient.query.mockImplementation(async (sql: string) =>
            sql.trim().startsWith('SELECT')
                ? { rows: [{ key: 'wrapped_master_key', value: JSON.stringify(legacyWrapped) }] }
                : {}
        );

        const result = await unlockVaultWithPassphrase(PASSPHRASE);
        expect(result.success).toBe(true);

        // Migration is fire-and-forget; wait for the COMMIT.
        await vi.waitFor(() => {
            const calls = mockClient.query.mock.calls.map((c: any[]) => c[0]);
            expect(calls).toContain('COMMIT');
        });

        const calls = mockClient.query.mock.calls.map((c: any[]) => c[0]);
        const beginIdx = calls.indexOf('BEGIN');
        const saltIdx = calls.findIndex((sql: string) => sql.trim().startsWith('INSERT'));
        const keyIdx = calls.findIndex((sql: string) => sql.includes("key = 'wrapped_master_key'"));
        const commitIdx = calls.indexOf('COMMIT');

        expect(beginIdx).toBeGreaterThan(-1);
        expect(saltIdx).toBeGreaterThan(beginIdx);
        expect(keyIdx).toBeGreaterThan(saltIdx);
        expect(commitIdx).toBeGreaterThan(keyIdx);
        expect(calls).not.toContain('ROLLBACK');
    });

    it('rolls back the migration when a statement fails (no partial write)', async () => {
        mockClient.query.mockImplementation(async (sql: string) => {
            if (sql.trim().startsWith('SELECT')) {
                return { rows: [{ key: 'wrapped_master_key', value: JSON.stringify(legacyWrapped) }] };
            }
            if (sql.includes("key = 'wrapped_master_key'")) {
                throw new Error('disk full');
            }
            return {};
        });

        const result = await unlockVaultWithPassphrase(PASSPHRASE);
        expect(result.success).toBe(true);

        await vi.waitFor(() => {
            const calls = mockClient.query.mock.calls.map((c: any[]) => c[0]);
            expect(calls).toContain('ROLLBACK');
        });

        const calls = mockClient.query.mock.calls.map((c: any[]) => c[0]);
        expect(calls).not.toContain('COMMIT');
    });

    it('does not migrate when a random salt is already stored', async () => {
        const salt = crypto.randomBytes(32);
        const wrapped = wrapMasterKey(masterKey, PASSPHRASE, salt);
        mockClient.query.mockResolvedValue({
            rows: [
                { key: 'wrapped_master_key', value: JSON.stringify(wrapped) },
                { key: 'vault_salt', value: JSON.stringify(salt.toString('hex')) },
            ]
        });

        const result = await unlockVaultWithPassphrase(PASSPHRASE);
        expect(result.success).toBe(true);

        // Give any (unexpected) fire-and-forget migration a tick to run.
        await new Promise((r) => setTimeout(r, 10));
        const calls = mockClient.query.mock.calls.map((c: any[]) => c[0]);
        expect(calls).not.toContain('BEGIN');
    });
});
