import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../pages/api/db', () => ({
    getDB: vi.fn()
}));

vi.mock('../utils/logger.js', () => ({
    default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() }
}));

import { getDB } from '../pages/api/db';
import handler from '../pages/api/settings/index';

describe('Settings API (/api/settings)', () => {
    let mockClient: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
    let mockRes: { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn>; setHeader: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        vi.clearAllMocks();
        mockClient = { query: vi.fn(), release: vi.fn() };
        (getDB as any).mockResolvedValue(mockClient);
        mockRes = {
            status: vi.fn().mockReturnThis(),
            json: vi.fn().mockReturnThis(),
            setHeader: vi.fn()
        };
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('GET', () => {
        it('should return all settings as key-value object', async () => {
            mockClient.query.mockResolvedValue({
                rows: [
                    { key: 'scraper_timeout', value: '90', description: 'Timeout in seconds' },
                    { key: 'billing_cycle_start', value: '10', description: 'Billing cycle start day' }
                ]
            });

            await handler({ method: 'GET', query: {} } as any, mockRes as any);

            expect(mockRes.status).toHaveBeenCalledWith(200);
            const data = mockRes.json.mock.calls[0][0];
            expect(data.settings).toEqual({
                scraper_timeout: '90',
                billing_cycle_start: '10'
            });
            expect(data.descriptions).toEqual({
                scraper_timeout: 'Timeout in seconds',
                billing_cycle_start: 'Billing cycle start day'
            });
        });

        it('should return a specific setting by key', async () => {
            mockClient.query.mockResolvedValue({
                rows: [{ key: 'scraper_timeout', value: '90', description: 'Timeout' }]
            });

            await handler({ method: 'GET', query: { key: 'scraper_timeout' } } as any, mockRes as any);

            expect(mockRes.status).toHaveBeenCalledWith(200);
            expect(mockRes.json).toHaveBeenCalledWith({
                key: 'scraper_timeout',
                value: '90',
                description: 'Timeout'
            });
        });

        it('should return 404 when specific setting not found', async () => {
            mockClient.query.mockResolvedValue({ rows: [] });

            await handler({ method: 'GET', query: { key: 'nonexistent' } } as any, mockRes as any);

            expect(mockRes.status).toHaveBeenCalledWith(404);
        });
    });

    describe('PUT', () => {
        it('should update existing settings', async () => {
            // First query: UPDATE returns the updated row
            mockClient.query.mockResolvedValue({
                rows: [{ key: 'scraper_timeout', value: '"120"' }]
            });

            await handler({
                method: 'PUT',
                query: {},
                body: { settings: { scraper_timeout: 120 } }
            } as any, mockRes as any);

            expect(mockRes.status).toHaveBeenCalledWith(200);
            const data = mockRes.json.mock.calls[0][0];
            expect(data.message).toBe('Settings updated successfully');
            expect(data.updated).toEqual([{ key: 'scraper_timeout', value: 120 }]);
        });

        it('should insert settings that do not exist', async () => {
            mockClient.query.mockResolvedValueOnce({ rows: [] }); // INSERT ON CONFLICT

            await handler({
                method: 'PUT',
                query: {},
                body: { settings: { new_setting: 'value' } }
            } as any, mockRes as any);

            expect(mockRes.status).toHaveBeenCalledWith(200);
            // Query should be a single INSERT ON CONFLICT upsert
            const [sql] = mockClient.query.mock.calls[0];
            expect(sql).toContain('INSERT INTO app_settings');
            expect(sql).toContain('ON CONFLICT');
        });

        it('should return 400 when settings object is missing', async () => {
            await handler({
                method: 'PUT',
                query: {},
                body: {}
            } as any, mockRes as any);

            expect(mockRes.status).toHaveBeenCalledWith(400);
        });

        it('should return 400 when settings is not an object', async () => {
            await handler({
                method: 'PUT',
                query: {},
                body: { settings: 'invalid' }
            } as any, mockRes as any);

            expect(mockRes.status).toHaveBeenCalledWith(400);
        });

        it('should reject invalid setting key format', async () => {
            await handler({
                method: 'PUT',
                query: {},
                body: { settings: { 'INVALID-KEY!': 'value' } }
            } as any, mockRes as any);

            expect(mockRes.status).toHaveBeenCalledWith(400);
            expect(mockRes.json.mock.calls[0][0].error).toContain('Invalid setting key');
        });

        it('should accept keys with underscores and digits', async () => {
            mockClient.query.mockResolvedValue({
                rows: [{ key: 'setting_123', value: '"test"' }]
            });

            await handler({
                method: 'PUT',
                query: {},
                body: { settings: { setting_123: 'test' } }
            } as any, mockRes as any);

            expect(mockRes.status).toHaveBeenCalledWith(200);
        });
    });

    describe('Method not allowed', () => {
        it('should return 405 for unsupported methods', async () => {
            await handler({ method: 'DELETE', query: {} } as any, mockRes as any);

            expect(mockRes.status).toHaveBeenCalledWith(405);
        });
    });

    describe('Error handling', () => {
        it('should return 500 on database error', async () => {
            mockClient.query.mockRejectedValue(new Error('DB error'));

            await handler({ method: 'GET', query: {} } as any, mockRes as any);

            expect(mockRes.status).toHaveBeenCalledWith(500);
            expect(mockClient.release).toHaveBeenCalledTimes(1);
        });
    });
});
