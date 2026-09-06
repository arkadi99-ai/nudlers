import { pool } from "../pages/api/db";

// Shared building blocks for ANY forward-looking balance projection: known
// fixed monthly commitments (RiseUp), already-scheduled credit-card
// settlements, and a real-billing-date estimate for genuinely recurring
// variable spending. Used by both the monthly calendar view
// (month-calendar.js) and the "safe to invest" forecast
// (account-status.js) - kept in one place so the two never drift out of
// sync (this exact methodology was corrected twice before landing here,
// see projectionUtils.js's generateMonthCalendar doc comment for history).
//
// @param {string} rangeStart - "YYYY-MM-DD", lower bound for scheduled CC settlements
// @param {string} rangeEnd - "YYYY-MM-DD", upper bound for scheduled CC settlements
export async function getForecastInputs({ rangeStart, rangeEnd }) {
    const [ccRes, fixedRes, genuineDaysRes, avgVariableRes, cardBillingRes] = await Promise.all([
        // Already-scheduled future credit-card settlement debits, grouped by
        // CATEGORY + settlement date.
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
        `, [rangeStart, rangeEnd]),
        // RiseUp's own "fixed" bank-side commitments.
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
        // Which (card, day-of-month) combinations are GENUINE recurring
        // billing cycles - see month-calendar.js for the full rationale.
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
        // 3-month average of "not fixed, but real" variable spending, per
        // (card, category, billing day).
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
        // Per (card, day): the most recent known settlement that actually
        // falls on that specific day.
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

    const fixedRecurring = fixedRes.rows.map(r => ({ name: r.name, amount: parseFloat(r.price), day_of_month: r.day_of_month, category: r.category }));
    const ccPayments = ccRes.rows.map(r => ({ amount: parseFloat(r.price), date: r.date, category: r.category }));

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

    return { fixedRecurring, ccPayments, estimatedFutureSpend };
}
