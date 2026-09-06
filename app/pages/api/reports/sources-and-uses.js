import { pool } from "../db";
import logger from "../../../utils/logger";
import { isCardCompanySettlement } from "../../../utils/transaction_logic";
import { formatISODate } from "../../../utils/dateUtils";

// GET /api/reports/sources-and-uses?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
//
// A real accounting-style statement for the period: every income SOURCE
// (grouped by name - RiseUp force-categorizes ALL positive amounts as
// "Income", so grouping by category alone would collapse salary/child
// allowance/refunds into one meaningless bucket) and every expense USE
// (grouped by category, the conventional breakdown), each with its share
// of the total. Excludes 'Bank' category (RiseUp's own internal-transfer
// tag) and the credit-card company's own bank-side settlement line (would
// otherwise double-count every card purchase - once itemized, once as the
// lump sum that pays for it).
export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', ['GET']);
        return res.status(405).end(`Method ${req.method} Not Allowed`);
    }

    const today = new Date();
    const defaultStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const defaultEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.startDate || '')
        ? req.query.startDate
        : formatISODate(defaultStart);
    const endDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.endDate || '')
        ? req.query.endDate
        : formatISODate(defaultEnd);

    try {
        const result = await pool.query(`
            SELECT name, category, price, transaction_type
            FROM transactions
            WHERE date >= $1 AND date <= $2
              AND COALESCE(category, '') != 'Bank'
        `, [startDate, endDate]);

        const sourcesMap = new Map();
        const usesMap = new Map();
        let totalIncome = 0;
        let totalExpenses = 0;

        for (const row of result.rows) {
            const price = parseFloat(row.price);
            if (!price) continue;
            if (row.transaction_type === 'bank' && isCardCompanySettlement(row.name)) continue;

            if (price > 0) {
                totalIncome += price;
                const key = row.name || 'לא מסווג';
                const entry = sourcesMap.get(key) || { name: key, total: 0, count: 0 };
                entry.total += price;
                entry.count += 1;
                sourcesMap.set(key, entry);
            } else {
                const amount = Math.abs(price);
                totalExpenses += amount;
                const key = (row.category || '').trim() || 'לא מסווג';
                const entry = usesMap.get(key) || { category: key, total: 0, count: 0 };
                entry.total += amount;
                entry.count += 1;
                usesMap.set(key, entry);
            }
        }

        const sources = [...sourcesMap.values()]
            .sort((a, b) => b.total - a.total)
            .map(s => ({
                ...s,
                total: Math.round(s.total),
                percentOfIncome: totalIncome > 0 ? Math.round((s.total / totalIncome) * 1000) / 10 : 0
            }));

        const uses = [...usesMap.values()]
            .sort((a, b) => b.total - a.total)
            .map(u => ({
                ...u,
                total: Math.round(u.total),
                percentOfExpenses: totalExpenses > 0 ? Math.round((u.total / totalExpenses) * 1000) / 10 : 0
            }));

        res.status(200).json({
            startDate,
            endDate,
            sources,
            uses,
            totals: {
                income: Math.round(totalIncome),
                expenses: Math.round(totalExpenses),
                net: Math.round(totalIncome - totalExpenses)
            }
        });
    } catch (error) {
        logger.error({ error: error.message, stack: error.stack }, "Error generating sources and uses report");
        res.status(500).json({ error: 'Internal Server Error' });
    }
}
