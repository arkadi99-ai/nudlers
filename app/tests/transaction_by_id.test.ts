import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../pages/api/db', () => ({
    getDB: vi.fn()
}));

vi.mock('../utils/logger.js', () => ({
    default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() }
}));

import { getDB } from '../pages/api/db';
import handler from '../pages/api/transactions/[id]';

describe('Transaction by ID API', () => {
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

    describe('Validation', () => {
        it('should reject unsupported HTTP methods', async () => {
            const req = { method: 'PATCH', query: { id: 'abc|visaCal' } };
            await handler(req as any, mockRes as any);
            expect(mockRes.status).toHaveBeenCalledWith(400);
        });

        it('should reject requests without an ID', async () => {
            const req = { method: 'GET', query: {} };
            await handler(req as any, mockRes as any);
            expect(mockRes.status).toHaveBeenCalledWith(400);
        });

        it('should reject PUT without any valid update fields', async () => {
            const req = { method: 'PUT', query: { id: 'abc|visaCal' }, body: {} };
            await handler(req as any, mockRes as any);
            expect(mockRes.status).toHaveBeenCalledWith(400);
            expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
                error: expect.stringContaining('required for updates')
            }));
        });
    });

    describe('GET', () => {
        it('should return a single transaction by identifier and vendor', async () => {
            const txn = { identifier: 'txn123', vendor: 'visaCal', name: 'Test', price: 100 };
            mockClient.query.mockResolvedValue({ rows: [txn] });

            const req = { method: 'GET', query: { id: 'txn123|visaCal' } };
            await handler(req as any, mockRes as any);

            expect(mockClient.query).toHaveBeenCalledTimes(1);
            const [sql, params] = mockClient.query.mock.calls[0];
            expect(params).toEqual(['txn123', 'visaCal']);
            expect(sql).toContain('SELECT');
            expect(mockRes.status).toHaveBeenCalledWith(200);
            expect(mockRes.json).toHaveBeenCalledWith(txn);
        });

        it('should return null when transaction not found', async () => {
            mockClient.query.mockResolvedValue({ rows: [] });

            const req = { method: 'GET', query: { id: 'missing|visaCal' } };
            await handler(req as any, mockRes as any);

            expect(mockRes.status).toHaveBeenCalledWith(200);
            expect(mockRes.json).toHaveBeenCalledWith(null);
        });

        it('should return 500 for invalid ID format (no pipe separator)', async () => {
            mockClient.query.mockRejectedValue(new Error('Invalid ID format. Expected: identifier|vendor'));

            const req = { method: 'GET', query: { id: 'nopipe' } };
            await handler(req as any, mockRes as any);

            expect(mockRes.status).toHaveBeenCalledWith(500);
        });
    });

    describe('DELETE', () => {
        it('should delete a transaction by identifier and vendor', async () => {
            mockClient.query.mockResolvedValue({ rowCount: 1 });

            const req = { method: 'DELETE', query: { id: 'txn123|visaCal' } };
            await handler(req as any, mockRes as any);

            const [sql, params] = mockClient.query.mock.calls[0];
            expect(sql).toContain('DELETE');
            expect(params).toEqual(['txn123', 'visaCal']);
            expect(mockRes.status).toHaveBeenCalledWith(200);
            expect(mockRes.json).toHaveBeenCalledWith({ success: true });
        });
    });

    describe('PUT', () => {
        it('should update transaction category', async () => {
            mockClient.query.mockResolvedValue({ rowCount: 1 });

            const req = {
                method: 'PUT',
                query: { id: 'txn123|visaCal' },
                body: { category: 'Food' }
            };
            await handler(req as any, mockRes as any);

            const [sql, params] = mockClient.query.mock.calls[0];
            expect(sql).toContain('UPDATE');
            expect(sql).toContain('category');
            expect(sql).toContain("category_source = 'cache'");
            expect(params).toContain('Food');
            expect(mockRes.status).toHaveBeenCalledWith(200);
        });

        it('should update transaction price', async () => {
            mockClient.query.mockResolvedValue({ rowCount: 1 });

            const req = {
                method: 'PUT',
                query: { id: 'txn123|visaCal' },
                body: { price: 99.99 }
            };
            await handler(req as any, mockRes as any);

            const [sql, params] = mockClient.query.mock.calls[0];
            expect(sql).toContain('price');
            expect(params).toContain(99.99);
        });

        it('should update both price and category', async () => {
            mockClient.query.mockResolvedValue({ rowCount: 1 });

            const req = {
                method: 'PUT',
                query: { id: 'txn123|visaCal' },
                body: { price: 50, category: 'Transport' }
            };
            await handler(req as any, mockRes as any);

            const [sql, params] = mockClient.query.mock.calls[0];
            expect(sql).toContain('price');
            expect(sql).toContain('category');
            expect(params).toContain(50);
            expect(params).toContain('Transport');
        });

        it('should update notes', async () => {
            mockClient.query.mockResolvedValue({ rowCount: 1 });

            const req = {
                method: 'PUT',
                query: { id: 'txn123|visaCal' },
                body: { notes: 'New note' }
            };
            await handler(req as any, mockRes as any);

            const [sql, params] = mockClient.query.mock.calls[0];
            expect(sql).toContain('notes = $3');
            expect(params).toContain('New note');
            expect(mockRes.status).toHaveBeenCalledWith(200);
        });
    });

    describe('Client release', () => {
        it('should always release the client', async () => {
            mockClient.query.mockResolvedValue({ rows: [] });
            const req = { method: 'GET', query: { id: 'txn123|visaCal' } };
            await handler(req as any, mockRes as any);
            expect(mockClient.release).toHaveBeenCalledTimes(1);
        });

        it('should release the client even on error', async () => {
            mockClient.query.mockRejectedValue(new Error('DB error'));
            const req = { method: 'GET', query: { id: 'txn123|visaCal' } };
            await handler(req as any, mockRes as any);
            expect(mockClient.release).toHaveBeenCalledTimes(1);
        });
    });
});
