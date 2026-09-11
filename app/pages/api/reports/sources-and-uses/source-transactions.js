import { pool } from "../../db";
import logger from "../../../../utils/logger";
import { isCardCompanySettlement } from "../../../../utils/transaction_logic";

// GET /api/reports/sources-and-uses/source-transactions?source=X&startDate=Y&endDate=Z
//
// Drill-down for the "Sources" list in the Sources & Uses statement: the
// real, individual transactions behind one income source's total for the
// selected month. Deliberately mirrors sources-and-uses.js's exact grouping
// for the income side (grouped by name, not category - RiseUp force-tags
// every positive amount as category "Income", so grouping by category would
// collapse salary/child-allowance/refunds into one meaningless bucket) and
// the same exclusions ('Bank' category, credit-card-company settlement
// lines), so the sum here always reconciles exactly with the total the user
// already saw in the statement.
export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', ['GET']);
        return res.status(405).end(`Method ${req.method} Not Allowed`);
    }

    const { source, startDate, endDate } = req.query;
    if (!source || !startDate || !endDate) {
        return res.status(400).json({ error: 'source, startDate, and endDate are required' });
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
              AND t.price > 0
              AND COALESCE(t.category, '') != 'Bank'
              AND COALESCE(NULLIF(t.name, ''), 'לא מסווג') = $1
        `, [source, startDate, endDate]);

        const transactions = result.rows
            .filter(r => !(r.transaction_type === 'bank' && isCardCompanySettlement(r.name)))
            .map(r => ({
                date: r.date,
                name: r.name,
                amount: parseFloat(r.price),
                source: r.source_name,
                isFixed: r.commitment_type === 'fixed'
            }));

        const total = Math.round(transactions.reduce((sum, t) => sum + t.amount, 0) * 100) / 100;

        res.status(200).json({ source, total, transactions });
    } catch (error) {
        logger.error({ error: error.message, stack: error.stack }, "Error fetching sources-and-uses source transactions");
        res.status(500).json({ error: 'Internal Server Error' });
    }
}
