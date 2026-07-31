import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../pages/api/db', () => ({
    getDB: vi.fn()
}));

vi.mock('../utils/logger.js', () => ({
    default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() }
}));

import { getDB } from '../pages/api/db';
import handler from '../pages/api/cards/ownerships/[id]';

describe('PATCH /api/cards/ownerships/[id]', () => {
    let mockClient: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
    let mockRes: any;

    beforeEach(() => {
        vi.clearAllMocks();
        mockClient = { query: vi.fn(), release: vi.fn() };
        (getDB as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient);
        mockRes = {
            status: vi.fn().mockReturnThis(),
            json: vi.fn().mockReturnThis(),
            setHeader: vi.fn().mockReturnThis()
        };
    });

    const patch = (id: string, body: any) =>
        handler({ method: 'PATCH', query: { id }, body }, mockRes);

    it('updates by numeric id', async () => {
        mockClient.query.mockResolvedValue({ rows: [{ id: 7, linked_bank_account_id: null }] });

        await patch('7', { linked_bank_account_id: 3 });

        const [sql, params] = mockClient.query.mock.calls[0];
        expect(sql).toContain('UPDATE card_ownership');
        expect(params).toEqual(['7', 3]);
        expect(mockRes.status).toHaveBeenCalledWith(200);
    });

    it('creates the ownership row when the card has none (last4 form)', async () => {
        mockClient.query.mockResolvedValue({ rows: [{ id: 42, linked_bank_account_id: null }] });

        await patch('last4:9428', { linked_bank_account_id: 3 });

        const [sql, params] = mockClient.query.mock.calls[0];
        expect(sql).toContain('INSERT INTO card_ownership');
        expect(sql).toContain('ON CONFLICT (vendor, account_number)');
        // last4, linked id, custom number/nickname cleared because a real bank was linked
        expect(params).toEqual(['9428', 3, null, null]);
        expect(mockRes.status).toHaveBeenCalledWith(200);
    });

    it('keeps custom account fields when linking to a custom bank (-1)', async () => {
        mockClient.query.mockResolvedValue({ rows: [{ id: 42 }] });

        await patch('last4:9428', {
            linked_bank_account_id: -1,
            custom_bank_account_number: '12345',
            custom_bank_account_nickname: 'My bank'
        });

        expect(mockClient.query.mock.calls[0][1]).toEqual(['9428', null, '12345', 'My bank']);
    });

    it('fails loudly when nothing matched instead of reporting success', async () => {
        mockClient.query.mockResolvedValue({ rows: [] });

        await patch('last4:0000', { linked_bank_account_id: 3 });

        expect(mockRes.status).toHaveBeenCalledWith(500);
    });
});
