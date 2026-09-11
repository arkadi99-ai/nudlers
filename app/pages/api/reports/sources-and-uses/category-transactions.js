import { pool } from "../../db";
import logger from "../../../../utils/logger";
import { isCardCompanySettlement } from "../../../../utils/transaction_logic";

// GET /api/reports/sources-and-uses/category-transactions?category=X&startDate=Y&endDate=Z
//
// Drill-down for the "Uses" list in the Sources & Uses statement: the real,
// individual transactions behind one category's total for the selected
// month. Deliberately mirrors sources-and-uses.js's exact filtering (same
// exclusions: 'Bank' category, credit-card-company settlement lines) so the
// sum of what's returned here always reconciles exactly with the total the
// user saw in the statement - never a "why doesn't this add up" surprise.
export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', ['GET']);
        return res.status(405).end(`Method ${req.method} Not Allowed`);
    }

    const { category, startDate, endDate } = req.query;
    if (!category || !startDate || !endDate) {
        return res.status(400).json({ error: 'category, startDate, and endDate are required' });
    }

    try {
        const result = await pool.query(`
            SELECT
                t.date, t.name, t.price, t.transaction_type, t.commitment_type,
                COALESCE(cv.card_nickname, vc_card.nickname, t.vendor) as source_name
            FROM transactions t
            LEFT JOIN card_ownership co ON t.vendor = co.vendor AND (CASE WHEN t.vendor = 'riseup' THEN t.account_number ELSE RIGHT(t.account_number, 4) END) = (CASE WHEN co.vendor = 'riseup' THEN co.account_number ELSE RIGHT(co.account_number, 4) END)
            LEFT JOIN vendor_credentials vc_card ON co.credential_id = vc_card.id
            LEFT JOIN card_vendors cv ON (CASE WHEN t.vendor = 'riseup' THEN t.account_number ELSE RIGHT(t.account_number, 4) END) = cv.last4_digits
            WHERE t.date >= $2 AND t.date <= $3
              AND t.price < 0
              AND COALESCE(t.category, '') != 'Bank'
              AND COALESCE(NULLIF(t.category, ''), 'לא מסווג') = $1
        `, [category, startDate, endDate]);

        const transactions = result.rows
            .filter(r => !(r.transaction_type === 'bank' && isCardCompanySettlement(r.name)))
            .map(r => ({
                date: r.date,
                name: r.name,
                amount: parseFloat(r.price),
                source: r.source_name,
                isFixed: r.commitment_type === 'fixed'
            }));

        const total = Math.round(transactions.reduce((sum, t) => sum + Math.abs(t.amount), 0) * 100) / 100;

        res.status(200).json({ category, total, transactions });
    } catch (error) {
        logger.error({ error: error.message, stack: error.stack }, "Error fetching sources-and-uses category transactions");
        res.status(500).json({ error: 'Internal Server Error' });
    }
}
