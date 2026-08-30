import { pool } from "../db";
import logger from "../../../utils/logger";

// GET /api/reports/account-status
//
// Powers the main-dashboard "account status" card: current checking balance,
// total known fixed monthly obligations, and the variable (card) spending
// due to hit the account on the next scheduled credit-card settlement date.
export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', ['GET']);
        return res.status(405).end(`Method ${req.method} Not Allowed`);
    }

    try {
        const [balanceRes, fixedRes, ccRes] = await Promise.all([
            pool.query(`
                SELECT co.balance, co.balance_updated_at
                FROM card_ownership co
                WHERE co.balance IS NOT NULL
                  AND (
                    co.vendor IN ('hapoalim', 'leumi', 'mizrahi', 'discount', 'yahav', 'union', 'fibi', 'jerusalem', 'onezero', 'pepper', 'otsarHahayal', 'beinleumi', 'massad', 'pagi')
                    OR EXISTS (
                        SELECT 1 FROM transactions t
                        WHERE t.vendor = co.vendor AND t.account_number = co.account_number AND t.transaction_type = 'bank'
                    )
                  )
                ORDER BY co.balance_updated_at DESC NULLS LAST
                LIMIT 1
            `),
            // RiseUp's own "fixed" bank-side commitments - same source as the
            // projection/calendar views, so all three stay consistent with
            // each other. Expenses only (negative amounts).
            pool.query(`
                SELECT DISTINCT ON (name, account_number)
                    name, price
                FROM transactions
                WHERE vendor = 'riseup'
                  AND transaction_type = 'bank'
                  AND commitment_type = 'fixed'
                  AND price < 0
                  AND date >= CURRENT_DATE - INTERVAL '45 days'
                ORDER BY name, account_number, date DESC
            `),
            // Already-scheduled future credit-card settlement debits, same query
            // shape as projection.js's "Future CC Payments".
            pool.query(`
                SELECT t.price, COALESCE(t.processed_date, t.date) as date,
                    COALESCE(cv.card_nickname, vc_card.nickname, t.vendor) as card_name
                FROM transactions t
                LEFT JOIN card_ownership co ON t.vendor = co.vendor AND (CASE WHEN t.vendor = 'riseup' THEN t.account_number ELSE RIGHT(t.account_number, 4) END) = (CASE WHEN co.vendor = 'riseup' THEN co.account_number ELSE RIGHT(co.account_number, 4) END)
                LEFT JOIN vendor_credentials vc_card ON co.credential_id = vc_card.id
                LEFT JOIN card_vendors cv ON (CASE WHEN t.vendor = 'riseup' THEN t.account_number ELSE RIGHT(t.account_number, 4) END) = cv.last4_digits
                WHERE t.transaction_type = 'credit_card'
                  AND (
                    (t.processed_date >= CURRENT_DATE)
                    OR
                    (t.processed_date IS NULL AND t.date >= CURRENT_DATE)
                  )
                ORDER BY date ASC
            `)
        ]);

        const currentBalance = parseFloat(balanceRes.rows[0]?.balance ?? 0);
        const hasBalance = balanceRes.rows.length > 0;

        const fixedMonthlyTotal = fixedRes.rows.reduce((sum, r) => sum + Math.abs(parseFloat(r.price)), 0);

        // Group scheduled CC settlements by their exact date, find the nearest one.
        let nextCardSettlement = null;
        if (ccRes.rows.length > 0) {
            const nextDate = ccRes.rows[0].date;
            const sameDay = ccRes.rows.filter(r => r.date instanceof Date
                ? r.date.getTime() === new Date(nextDate).getTime()
                : r.date === nextDate);
            const total = sameDay.reduce((sum, r) => sum + Math.abs(parseFloat(r.price)), 0);
            const cardNames = [...new Set(sameDay.map(r => r.card_name).filter(Boolean))];
            nextCardSettlement = {
                date: nextDate,
                amount: total,
                cards: cardNames
            };
        }

        res.status(200).json({
            currentBalance,
            hasBalance,
            balanceUpdatedAt: balanceRes.rows[0]?.balance_updated_at ?? null,
            fixedMonthlyTotal,
            nextCardSettlement
        });
    } catch (error) {
        logger.error({ error: error.message, stack: error.stack }, "Error generating account status");
        res.status(500).json({ error: 'Internal Server Error' });
    }
}
