import { pool } from "../db";
import logger from "../../../utils/logger";
import { generateMonthCalendar } from "../../../utils/projectionUtils";

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
        const [balanceRes, actualTxRes, ccRes, fixedRes, genuineDaysRes, avgVariableRes, cardBillingRes] = await Promise.all([
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
            // 3. Already-scheduled future credit-card settlement debits, grouped by
            // CATEGORY + settlement date (one line per category per day, for the
            // click-to-see-breakdown popup - "why is this much leaving," not a
            // per-card ledger). Bridges from "today" to the requested month for
            // the same reason as query 2 above.
            pool.query(`
                SELECT
                    SUM(t.price) as price,
                    COALESCE(t.processed_date, t.date) as date,
                    COALESCE(NULLIF(t.category, ''), 'לא מסווג') as category
                FROM transactions t
                WHERE t.transaction_type = 'credit_card'
                  AND (
                    (t.processed_date >= CURRENT_DATE)
                    OR
                    (t.processed_date IS NULL AND t.date >= CURRENT_DATE)
                  )
                  AND COALESCE(t.processed_date, t.date) BETWEEN LEAST($1::date, CURRENT_DATE) AND GREATEST($2::date, CURRENT_DATE)
                GROUP BY COALESCE(t.processed_date, t.date), COALESCE(NULLIF(t.category, ''), 'לא מסווג')
            `, [monthStartStr, monthEndStr]),
            // 4. RiseUp's own "fixed" bank-side commitments, same as projection.js.
            pool.query(`
                SELECT DISTINCT ON (name, account_number)
                    name, price, EXTRACT(DAY FROM date)::int as day_of_month,
                    COALESCE(NULLIF(category, ''), 'לא מסווג') as category
                FROM transactions
                WHERE vendor = 'riseup'
                  AND transaction_type = 'bank'
                  AND commitment_type = 'fixed'
                  AND date >= CURRENT_DATE - INTERVAL '45 days'
                ORDER BY name, account_number, date DESC
            `),
            // 5. Which (card, day-of-month) combinations are GENUINE recurring
            // billing cycles - a day only counts if it actually recurs across at
            // least 2 distinct months in the last 6, not a one-off (an
            // installment plan's odd date, a holiday-shifted posting, etc). A
            // card can legitimately have more than one real cycle (e.g. a
            // family's two cards under the same account hash settling on
            // different days) - this is discovered from real settlement dates,
            // never assumed to be exactly one day per card.
            pool.query(`
                SELECT account_number, day
                FROM (
                    SELECT
                        account_number,
                        EXTRACT(DAY FROM COALESCE(processed_date, date))::int as day,
                        COUNT(DISTINCT date_trunc('month', COALESCE(processed_date, date))) as distinct_months
                    FROM transactions
                    WHERE transaction_type = 'credit_card'
                      AND COALESCE(processed_date, date) >= CURRENT_DATE - INTERVAL '6 months'
                    GROUP BY 1, 2
                ) day_recurrence
                WHERE distinct_months >= 2
            `),
            // 6. Estimate for "not fixed, but real" spending (e.g. groceries): the
            // average of the last 3 FULL months' variable (non-fixed) card
            // spending, PER CARD PER CATEGORY PER BILLING DAY - the amount is
            // estimated, but WHICH DAY it lands on is not a guess (query 5
            // filters this to genuine days below). This is a rough estimate, not
            // a guarantee - the frontend shows it in a visually distinct pastel
            // color for exactly that reason. Once a real month passes and gets
            // synced, its actual total replaces the estimate automatically (the
            // average shifts forward every month).
            pool.query(`
                SELECT account_number, category, day, AVG(monthly_total) as avg_monthly
                FROM (
                    SELECT
                        account_number,
                        COALESCE(NULLIF(category, ''), 'לא מסווג') as category,
                        EXTRACT(DAY FROM COALESCE(processed_date, date))::int as day,
                        date_trunc('month', date) as month,
                        SUM(ABS(price)) as monthly_total
                    FROM transactions
                    WHERE transaction_type = 'credit_card'
                      AND (commitment_type IS NULL OR commitment_type != 'fixed')
                      AND price < 0
                      AND date >= date_trunc('month', CURRENT_DATE) - INTERVAL '3 months'
                      AND date < date_trunc('month', CURRENT_DATE)
                    GROUP BY 1, 2, 3, 4
                ) monthly_by_card_category_day
                GROUP BY account_number, category, day
            `),
            // 7. Per (card, day): the most recent known settlement (real or
            // already-scheduled) that actually falls on that specific day - the
            // estimate only needs to cover the NEXT cycle beyond that, since
            // anything already scheduled is real, not estimated.
            pool.query(`
                SELECT
                    account_number,
                    EXTRACT(DAY FROM COALESCE(processed_date, date))::int as day,
                    MAX(COALESCE(processed_date, date)) as max_known_date
                FROM transactions
                WHERE transaction_type = 'credit_card'
                GROUP BY account_number, EXTRACT(DAY FROM COALESCE(processed_date, date))::int
            `)
        ]);

        const currentBalance = parseFloat(balanceRes.rows[0]?.balance ?? 0);

        const actualTransactions = actualTxRes.rows.map(r => ({ date: r.date, price: parseFloat(r.price), name: r.name, category: r.category }));
        const ccPayments = ccRes.rows.map(r => ({ amount: parseFloat(r.price), date: r.date, category: r.category }));
        const fixedRecurring = fixedRes.rows.map(r => ({ name: r.name, amount: parseFloat(r.price), day_of_month: r.day_of_month, category: r.category }));

        // The amount is estimated (3-month average), but WHICH DAY it lands on
        // is not a guess: it's a real, recurring billing day for that specific
        // card (confirmed to actually repeat across multiple months - query 5),
        // one cycle beyond the last real settlement that landed on that exact
        // day (anything already scheduled is real, not estimated).
        const genuineDays = new Set(genuineDaysRes.rows.map(r => `${r.account_number}|${r.day}`));

        const maxKnownDateByAccountDay = new Map();
        for (const row of cardBillingRes.rows) {
            maxKnownDateByAccountDay.set(`${row.account_number}|${row.day}`, new Date(row.max_known_date));
        }

        const nextBillingDateAfter = (maxKnownDate, billingDay) => {
            const year = maxKnownDate.getFullYear();
            const month = maxKnownDate.getMonth() + 1; // one cycle after the last known settlement
            const daysInTargetMonth = new Date(year, month + 1, 0).getDate();
            return new Date(year, month, Math.min(billingDay, daysInTargetMonth));
        };

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const estimatedFutureSpend = [];
        for (const row of avgVariableRes.rows) {
            const key = `${row.account_number}|${row.day}`;
            if (!genuineDays.has(key)) continue; // a one-off date, not a real recurring cycle - skip it
            const maxKnownDate = maxKnownDateByAccountDay.get(key);
            const avgMonthly = parseFloat(row.avg_monthly);
            if (!maxKnownDate || !avgMonthly) continue;
            const targetDate = nextBillingDateAfter(maxKnownDate, row.day);
            if (targetDate <= today) continue; // stale info - don't misplace an estimate in the past
            estimatedFutureSpend.push({
                date: targetDate,
                category: row.category,
                amount: -avgMonthly
            });
        }

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
