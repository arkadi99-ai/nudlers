import { pool } from "../db";
import logger from "../../../utils/logger";
import { isCardCompanySettlement } from "../../../utils/transaction_logic";

// GET /api/reports/needs-attention
//
// The "did I miss a shekel" proactive queue: real spending from the last 30
// days that's either uncategorized or dumped in a catch-all bucket
// ("אחר"/"לא מסווג") - grouped by description (same merchant), biggest
// unclear total first, so the user's attention goes to what actually
// matters instead of a long flat list of small charges.
const LOOKBACK_DAYS = 30;
const MIN_TOTAL_AMOUNT = 30;
const CATCH_ALL_CATEGORIES = ['אחר', 'לא מסווג', 'Other', 'Uncategorized'];

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', ['GET']);
        return res.status(405).end(`Method ${req.method} Not Allowed`);
    }

    try {
        const result = await pool.query(`
            SELECT name, category, price, transaction_type, date
            FROM transactions
            WHERE date >= CURRENT_DATE - INTERVAL '${LOOKBACK_DAYS} days'
              AND price < 0
              AND (
                COALESCE(TRIM(category), '') = ''
                OR category = ANY($1::text[])
              )
        `, [CATCH_ALL_CATEGORIES]);

        const byName = new Map();
        for (const row of result.rows) {
            if (row.transaction_type === 'bank' && isCardCompanySettlement(row.name)) continue;
            const amount = Math.abs(parseFloat(row.price));
            const key = row.name || 'לא מסווג';
            const entry = byName.get(key) || { description: key, total: 0, count: 0, lastDate: row.date, currentCategory: row.category || null };
            entry.total += amount;
            entry.count += 1;
            if (new Date(row.date) > new Date(entry.lastDate)) entry.lastDate = row.date;
            byName.set(key, entry);
        }

        const items = [...byName.values()]
            .filter(i => i.total >= MIN_TOTAL_AMOUNT)
            .sort((a, b) => b.total - a.total)
            .map(i => ({ ...i, total: Math.round(i.total * 100) / 100 }));

        res.status(200).json({ items });
    } catch (error) {
        logger.error({ error: error.message, stack: error.stack }, "Error generating needs-attention report");
        res.status(500).json({ error: 'Internal Server Error' });
    }
}
