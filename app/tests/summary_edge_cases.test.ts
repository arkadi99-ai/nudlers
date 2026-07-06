import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateDailySummary } from '../utils/summary.js';
import { getDB } from '../pages/api/db.js';
import { generateText } from '../utils/aiClient.js';

vi.mock('../pages/api/db.js', () => ({
    getDB: vi.fn(),
}));

vi.mock('../utils/aiClient.js', () => ({
    generateText: vi.fn().mockResolvedValue({
        text: 'AI Summary',
        finishReason: 'stop',
        model: 'google/gemini-2.5-flash'
    })
}));

vi.mock('../utils/logger.js', () => ({
    default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() }
}));

function getPromptFromLastCall(): string {
    const calls = (generateText as any).mock.calls;
    return calls[calls.length - 1][0].prompt;
}

describe('Summary Generation', () => {
    let mockClient: any;

    beforeEach(() => {
        mockClient = {
            query: vi.fn(),
            release: vi.fn()
        };
        (getDB as any).mockResolvedValue(mockClient);
        (generateText as any).mockResolvedValue({
            text: 'AI Summary',
            finishReason: 'stop',
            model: 'google/gemini-2.5-flash'
        });
    });

    function setupDefaultSettings(overrides: Record<string, string> = {}) {
        const defaults: Record<string, string> = {
            whatsapp_summary_mode: '"calendar"',
            billing_cycle_start_day: '10',
            ...overrides
        };
        return {
            rows: Object.entries(defaults).map(([key, value]) => ({ key, value }))
        };
    }

    it('should calculate burndown rate and construct prompt correctly', async () => {
        mockClient.query.mockResolvedValueOnce(setupDefaultSettings());
        mockClient.query.mockResolvedValueOnce({
            rows: [
                { date: '2026-01-20', name: 'Test Shop', category: 'Food', price: 100, vendor: 'Visa' }
            ]
        });
        mockClient.query.mockResolvedValueOnce({
            rows: [{ category: 'Food', budget_limit: 1000 }]
        });
        mockClient.query.mockResolvedValueOnce({
            rows: [
                { category: 'Food', actual_spent: 200 },
                { category: 'Unbudgeted', actual_spent: 50 }
            ]
        });
        mockClient.query.mockResolvedValueOnce({
            rows: [{ budget_limit: 5000 }]
        });

        const result = await generateDailySummary();
        expect(result).toBe('AI Summary');

        const prompt = getPromptFromLastCall();
        expect(prompt).toContain('💰 *סיכום הוצאות יומי* 💰');
        expect(prompt).toContain('1️⃣ *10 עסקאות אחרונות');
        expect(prompt).toContain('חובה להציג את כל 10 העסקאות');
        expect(prompt).toContain('2️⃣ *סטטוס תקציב לפי קטגוריות');
        expect(prompt).toContain('3️⃣ *תמונת מצב תקציב כולל');
        expect(prompt).toContain('• *תקציב:* ₪5000');
        expect(prompt).toContain('*Food:* ₪200/₪1000');
        expect(prompt).not.toContain('Unbudgeted:');
        expect(prompt).toContain('20.01: Test Shop - ₪100 (Food)');
    });

    it('should propagate AI provider errors and release client', async () => {
        const err = new Error('AI provider API key not configured. Please add it in App Settings.');
        (err as any).code = 'AI_API_KEY_MISSING';
        (generateText as any).mockRejectedValueOnce(err);

        mockClient.query.mockResolvedValueOnce(setupDefaultSettings());
        mockClient.query.mockResolvedValueOnce({ rows: [] });
        mockClient.query.mockResolvedValueOnce({ rows: [] });
        mockClient.query.mockResolvedValueOnce({ rows: [] });
        mockClient.query.mockResolvedValueOnce({ rows: [] });

        await expect(generateDailySummary()).rejects.toThrow('AI provider API key not configured');
        expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('should handle zero transactions in period', async () => {
        mockClient.query.mockResolvedValueOnce(setupDefaultSettings());
        mockClient.query.mockResolvedValueOnce({ rows: [] });
        mockClient.query.mockResolvedValueOnce({ rows: [{ category: 'Food', budget_limit: 1000 }] });
        mockClient.query.mockResolvedValueOnce({ rows: [] });
        mockClient.query.mockResolvedValueOnce({ rows: [{ budget_limit: 5000 }] });

        const result = await generateDailySummary();
        expect(result).toBe('AI Summary');

        const prompt = getPromptFromLastCall();
        expect(prompt).toContain('💰 *סיכום הוצאות יומי* 💰');
        expect(prompt).toContain('₪0/₪1000');
        expect(prompt).toContain('*הוצאות:* ₪0');
    });

    it('should handle all categories over budget', async () => {
        mockClient.query.mockResolvedValueOnce(setupDefaultSettings());
        mockClient.query.mockResolvedValueOnce({
            rows: [{ date: '2024-01-20', name: 'Store', category: 'Food', price: 500, vendor: 'visaCal' }]
        });
        mockClient.query.mockResolvedValueOnce({
            rows: [
                { category: 'Food', budget_limit: 100 },
                { category: 'Transport', budget_limit: 200 }
            ]
        });
        mockClient.query.mockResolvedValueOnce({
            rows: [
                { category: 'Food', actual_spent: 500 },
                { category: 'Transport', actual_spent: 400 }
            ]
        });
        mockClient.query.mockResolvedValueOnce({ rows: [{ budget_limit: 300 }] });

        const result = await generateDailySummary();
        expect(result).toBe('AI Summary');

        const prompt = getPromptFromLastCall();
        expect(prompt).toContain('⚠️ חריגה!');
        expect(prompt).toContain('*Food:*');
        expect(prompt).toContain('*Transport:*');
    });

    it('should handle missing total budget', async () => {
        mockClient.query.mockResolvedValueOnce(setupDefaultSettings());
        mockClient.query.mockResolvedValueOnce({ rows: [] });
        mockClient.query.mockResolvedValueOnce({ rows: [] });
        mockClient.query.mockResolvedValueOnce({
            rows: [{ category: 'Food', actual_spent: 100 }]
        });
        mockClient.query.mockResolvedValueOnce({ rows: [] });

        const result = await generateDailySummary();
        expect(result).toBe('AI Summary');

        const prompt = getPromptFromLastCall();
        expect(prompt).toContain('*תקציב:* ₪0');
        expect(prompt).not.toContain('מצוין ✅');
    });

    it('should use billing cycle mode when configured', async () => {
        mockClient.query.mockResolvedValueOnce(
            setupDefaultSettings({ whatsapp_summary_mode: '"cycle"' })
        );
        mockClient.query.mockResolvedValueOnce({ rows: [] });
        mockClient.query.mockResolvedValueOnce({ rows: [] });
        mockClient.query.mockResolvedValueOnce({ rows: [] });
        mockClient.query.mockResolvedValueOnce({ rows: [{ budget_limit: 5000 }] });

        const result = await generateDailySummary();
        expect(result).toBe('AI Summary');

        const actualQuery = mockClient.query.mock.calls[3];
        const [, params] = actualQuery;
        expect(params).toHaveLength(2);
        expect(params[0]).toMatch(/^\d{4}-\d{2}$/);
        expect(Array.isArray(params[1])).toBe(true); // bank vendor exclusion list
    });

    it('should release client even when AI provider throws', async () => {
        (generateText as any).mockRejectedValueOnce(new Error('Rate limit exceeded'));

        mockClient.query.mockResolvedValueOnce(setupDefaultSettings());
        mockClient.query.mockResolvedValueOnce({ rows: [] });
        mockClient.query.mockResolvedValueOnce({ rows: [] });
        mockClient.query.mockResolvedValueOnce({ rows: [] });
        mockClient.query.mockResolvedValueOnce({ rows: [] });

        await expect(generateDailySummary()).rejects.toThrow('Rate limit exceeded');
        expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('should exclude unbudgeted categories from budget status', async () => {
        mockClient.query.mockResolvedValueOnce(setupDefaultSettings());
        mockClient.query.mockResolvedValueOnce({ rows: [] });
        mockClient.query.mockResolvedValueOnce({
            rows: [{ category: 'Food', budget_limit: 1000 }]
        });
        mockClient.query.mockResolvedValueOnce({
            rows: [
                { category: 'Food', actual_spent: 300 },
                { category: 'Shopping', actual_spent: 500 }
            ]
        });
        mockClient.query.mockResolvedValueOnce({ rows: [{ budget_limit: 5000 }] });

        const result = await generateDailySummary();
        expect(result).toBe('AI Summary');

        const prompt = getPromptFromLastCall();
        expect(prompt).toContain('*Food:* ₪300/₪1000');
        expect(prompt).not.toContain('*Shopping:*');
    });
});
