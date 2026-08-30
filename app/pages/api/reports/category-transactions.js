import { pool } from "../db";
import logger from "../../../utils/logger";

// GET /api/reports/category-transactions?category=X
//
// Powers the "drill down into a category" popup in the monthly calendar's
// estimate breakdown: the real, individual transactions from the last 3
// months that feed that category's 3-month average, each with the business
// name and which card/account it came from.
export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', ['GET']);
        return res.status(405).end(`Method ${req.method} Not Allowed`);
    }

    const category = req.query.category;
    if (!category) {
        return res.status(400).json({ error: 'category is required' });
    }
    // 'לא מסווג' ("uncategorized") is the fallback label this feature uses for
    // a NULL/empty category - match both here.
    const isUncategorized = category === 'לא מסווג';

    try {
        const categoryFilter = isUncategorized ? `(category IS NULL OR category = '')` : `category = $1`;
        const categoryFilterAliased = isUncategorized ? `(t.category IS NULL OR t.category = '')` : `t.category = $1`;
        const params = isUncategorized ? [] : [category];

        const [txResult, avgResult] = await Promise.all([
            pool.query(`
                SELECT
                    t.date, t.name, t.price,
                    COALESCE(cv.card_nickname, vc_card.nickname, t.vendor) as source_name
                FROM transactions t
                LEFT JOIN card_ownership co ON t.vendor = co.vendor AND (CASE WHEN t.vendor = 'riseup' THEN t.account_number ELSE RIGHT(t.account_number, 4) END) = (CASE WHEN co.vendor = 'riseup' THEN co.account_number ELSE RIGHT(co.account_number, 4) END)
                LEFT JOIN vendor_credentials vc_card ON co.credential_id = vc_card.id
                LEFT JOIN card_vendors cv ON (CASE WHEN t.vendor = 'riseup' THEN t.account_number ELSE RIGHT(t.account_number, 4) END) = cv.last4_digits
                WHERE t.transaction_type = 'credit_card'
                  AND (t.commitment_type IS NULL OR t.commitment_type != 'fixed')
                  AND t.price < 0
                  AND ${categoryFilterAliased}
                  AND t.date >= date_trunc('month', CURRENT_DATE) - INTERVAL '3 months'
                  AND t.date < date_trunc('month', CURRENT_DATE)
                ORDER BY t.date DESC
                LIMIT 200
            `, params),
            // Same methodology as month-calendar.js's estimate query (average of
            // active months, not total÷90) - so the reconciliation shown here
            // always matches the figure the user saw in the calendar exactly,
            // even for a category with a gap month.
            pool.query(`
                SELECT AVG(monthly_total) as avg_monthly
                FROM (
                    SELECT date_trunc('month', date) as month, SUM(ABS(price)) as monthly_total
                    FROM transactions
                    WHERE transaction_type = 'credit_card'
                      AND (commitment_type IS NULL OR commitment_type != 'fixed')
                      AND price < 0
                      AND ${categoryFilter}
                      AND date >= date_trunc('month', CURRENT_DATE) - INTERVAL '3 months'
                      AND date < date_trunc('month', CURRENT_DATE)
                    GROUP BY 1
                ) monthly_totals
            `, params)
        ]);

        const transactions = txResult.rows.map(r => ({
            date: r.date,
            name: r.name,
            amount: parseFloat(r.price),
            source: r.source_name
        }));
        // threeMonthTotal is a simple sum of the list shown below (capped at 200
        // rows) - just context for the user, not what avgDaily is derived from.
        const threeMonthTotal = transactions.reduce((sum, t) => sum + t.amount, 0);
        const avgMonthly = parseFloat(avgResult.rows[0]?.avg_monthly ?? 0);
        res.status(200).json({
            category,
            threeMonthTotal: Math.round(threeMonthTotal * 100) / 100,
            avgDaily: -Math.round((avgMonthly / 30) * 100) / 100,
            transactions
        });
    } catch (error) {
        logger.error({ error: error.message, stack: error.stack }, "Error fetching category transactions");
        res.status(500).json({ error: 'Internal Server Error' });
    }
}
