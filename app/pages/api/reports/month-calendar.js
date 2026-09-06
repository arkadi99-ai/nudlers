import { pool } from "../db";
import logger from "../../../utils/logger";
import { generateMonthCalendar } from "../../../utils/projectionUtils";
import { getForecastInputs } from "../../../utils/forecastDataSource";

// GET /api/reports/month-calendar?month=YYYY-MM
//
// Powers the monthly calendar view in the Projection screen: one square per
// day of the month, each showing the checking account's balance for that day
// (real, reconstructed balance for days up to today; projected for days
// after). See generateMonthCalendar() for how the two halves are stitched
// together.
export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', ['GET']);
        return res.status(405).end(`Method ${req.method} Not Allowed`);
    }

    const monthStr = /^\d{4}-\d{2}$/.test(req.query.month || '')
        ? req.query.month
        : new Date().toISOString().slice(0, 7);

    const [year, monthNum] = monthStr.split('-').map(Number);
    const monthStartStr = `${monthStr}-01`;
    const daysInMonth = new Date(year, monthNum, 0).getDate();
    const monthEndStr = `${monthStr}-${String(daysInMonth).padStart(2, '0')}`;

    try {
        // Every query here runs on its own pooled connection (via `pool`, not a
        // shared client) - see the 2026-08-30 stability fix for why a single
        // client can't safely run concurrent queries.
        const [balanceRes, actualTxRes, forecastInputs] = await Promise.all([
            // 1. Most recently reported real balance for a bank-type account
            // (direct bank scraper, or a RiseUp sub-account confirmed bank-tagged).
            pool.query(`
                SELECT co.balance
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
            // 2. Real, already-happened bank-side transactions. Bridges from the
            // requested month all the way to "today" if they're not the same
            // month (e.g. viewing last month while today is in this one still
            // needs actual data up through today) - actual data never matters
            // past today, so that's always the upper bound.
            // (transaction_type='bank' is vendor-agnostic - correctly identifies
            // bank-side rows for both direct-bank scrapers and RiseUp alike).
            pool.query(`
                SELECT date, price, name, COALESCE(NULLIF(category, ''), 'לא מסווג') as category
                FROM transactions
                WHERE transaction_type = 'bank'
                  AND date >= LEAST($1::date, CURRENT_DATE)
                  AND date <= GREATEST($2::date, CURRENT_DATE)
                  AND date <= CURRENT_DATE
            `, [monthStartStr, monthEndStr]),
            // 3-7. Fixed commitments, scheduled CC settlements, and the
            // real-billing-date variable-spend estimate - shared with the
            // "safe to invest" forecast (account-status.js) so both stay
            // consistent. See forecastDataSource.js for the full rationale.
            getForecastInputs({ rangeStart: monthStartStr, rangeEnd: monthEndStr })
        ]);

        const currentBalance = parseFloat(balanceRes.rows[0]?.balance ?? 0);

        const actualTransactions = actualTxRes.rows.map(r => ({ date: r.date, price: parseFloat(r.price), name: r.name, category: r.category }));
        const { fixedRecurring, ccPayments, estimatedFutureSpend } = forecastInputs;

        const days = generateMonthCalendar({
            currentBalance,
            actualTransactions,
            fixedRecurring,
            ccPayments,
            estimatedFutureSpend,
            monthStr
        });

        res.status(200).json({
            month: monthStr,
            currentBalance,
            hasBalance: balanceRes.rows.length > 0,
            hasEstimates: estimatedFutureSpend.length > 0,
            days
        });
    } catch (error) {
        logger.error({ error: error.message, stack: error.stack }, "Error generating month calendar");
        res.status(500).json({ error: 'Internal Server Error' });
    }
}
