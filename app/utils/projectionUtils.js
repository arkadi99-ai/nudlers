import { formatISODate, getLocalMidnight } from './dateUtils.js';

/**
 * Normalizes transaction dates for projection by gathering transactions that belong to the same card
 * and clustering them if they occur within a specific window (e.g. 2 days) to account for timezone shifts or inconsistencies.
 * 
 * @param {Array} transactions - Array of transaction objects
 */
export function normalizeTransactionDates(transactions) {
    const cardGroups = {};
    transactions.forEach(row => {
        const key = `${row.account_number}-${row.vendor}-${row.last4}`;
        if (!cardGroups[key]) cardGroups[key] = [];

        // Normalize row date to local midnight
        const d = new Date(row.processed_date || row.date);
        d.setHours(0, 0, 0, 0);
        row.normalizedDate = d;
        cardGroups[key].push(row);
    });

    Object.values(cardGroups).forEach(rows => {
        // Sort by date
        rows.sort((a, b) => a.normalizedDate.getTime() - b.normalizedDate.getTime());

        // Cluster rows that are within 5 days of each other
        const clusters = [];
        if (rows.length > 0) {
            let currentCluster = [rows[0]];
            for (let i = 1; i < rows.length; i++) {
                const row = rows[i];
                const prev = currentCluster[currentCluster.length - 1];
                const diffTime = Math.abs(row.normalizedDate.getTime() - prev.normalizedDate.getTime());
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

                if (diffDays < 2) {
                    currentCluster.push(row);
                } else {
                    clusters.push(currentCluster);
                    currentCluster = [row];
                }
            }
            clusters.push(currentCluster);
        }

        // Unify dates within each cluster
        clusters.forEach(cluster => {
            if (cluster.length <= 1) return;

            // Find most frequent date
            const counts = {};
            cluster.forEach(r => {
                const t = r.normalizedDate.getTime();
                counts[t] = (counts[t] || 0) + 1;
            });

            // Pick best (most frequent, tie-break: earliest)
            let bestTime = null;
            let maxCount = -1;

            Object.keys(counts).forEach(ts => {
                const t = parseInt(ts);
                const count = counts[ts];
                if (count > maxCount) {
                    maxCount = count;
                    bestTime = t;
                } else if (count === maxCount) {
                    // tie-break: earliest
                    if (bestTime === null || t < bestTime) {
                        bestTime = t;
                    }
                }
            });

            const consensusDate = new Date(bestTime);
            cluster.forEach(r => {
                r.normalizedDate = consensusDate;
            });
        });
    });
}

/**
 * Generates only the dates within the projection window that match a specific day of month.
 * Handles end-of-month logic (e.g. if day is 31 and month has 30 days, returns 30th).
 * 
 * @param {number} dayOfMonth - User specified day (1-31)
 * @param {Date} start - Start date of projection
 * @param {number} days - Number of days to project
 * @returns {Date[]} Array of dates
 */
function getExampleDates(dayOfMonth, start, days) {
    const dates = [];
    const end = new Date(start);
    end.setDate(start.getDate() + days);

    // Make a copy to iterate
    let current = new Date(start);
    // Align to midnight
    current.setHours(0, 0, 0, 0);

    // Safety check
    if (days > 365) days = 365;

    // Iterate through days is safer/easier for small N (30-90) than complex month logic
    for (let i = 0; i <= days; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        d.setHours(0, 0, 0, 0);

        const year = d.getFullYear();
        const month = d.getMonth();
        const datesInMonth = new Date(year, month + 1, 0).getDate();

        // Target day for this month
        const targetDay = Math.min(dayOfMonth, datesInMonth);

        if (d.getDate() === targetDay) {
            dates.push(d);
        }
    }
    return dates;
}

/**
 * Generates the financial projection.
 *
 * @param {Array} accounts - Accounts with current balances
 * @param {Array} bankRecurring - Detected bank recurring payments (next_payment_date required)
 * @param {Array} manualRecurring - Manual recurring payments (day_of_month required)
 * @param {Array} ccPayments - Future credit card payments (normalizedDate required)
 * @param {number} days - Number of days to project (default 30)
 * @param {Date | null} [startDate]
 * @returns {Array} Array of projection objects
 */
export function generateProjection(accounts, bankRecurring, manualRecurring, ccPayments, days = 30, startDate = null) {
    const today = startDate ? getLocalMidnight(startDate) : getLocalMidnight();
    const eventMap = new Map(); // timestamp -> Array<Item>

    function addEvent(date, item) {
        if (!date || isNaN(date.getTime())) return;
        const key = date.getTime();
        if (!eventMap.has(key)) {
            eventMap.set(key, []);
        }
        eventMap.get(key).push(item);
    }

    // 1. Bank Recurring
    if (bankRecurring && Array.isArray(bankRecurring)) {
        bankRecurring.forEach(rp => {
            if (!rp.next_payment_date) return;
            const d = getLocalMidnight(rp.next_payment_date);

            // Only include if within range
            const maxDate = new Date(today);
            maxDate.setDate(today.getDate() + days);

            if (d >= today && d <= maxDate) {
                addEvent(d, {
                    type: 'bank',
                    name: rp.name,
                    amount: rp.price,
                    category: rp.category,
                    account_number: rp.account_number
                });
            }
        });
    }

    // 2. Manual Recurring
    if (manualRecurring && Array.isArray(manualRecurring)) {
        manualRecurring.forEach(mr => {
            const day = mr.day_of_month;
            if (day) {
                const dates = getExampleDates(day, today, days);
                dates.forEach(d => {
                    const accNum = mr.account_number || accounts[0]?.account_number;
                    addEvent(d, {
                        type: 'manual',
                        name: mr.name,
                        amount: mr.amount,
                        category: mr.category,
                        account_number: accNum,
                        is_manual: true
                    });
                });
            }
        });
    }

    // 3. CC Payments
    if (ccPayments && Array.isArray(ccPayments)) {
        ccPayments.forEach(cc => {
            if (!cc.normalizedDate) return;
            const d = cc.normalizedDate; // Should already be midnight via normalizeTransactionDates

            const targetBankId = cc.linked_bank_account_id;
            const targetAccount = accounts.find(a => a.credential_id === targetBankId);

            if (targetAccount) {
                addEvent(d, {
                    type: 'cc',
                    name: cc.card_name,
                    last4: cc.last4,
                    vendor: cc.vendor,
                    price: parseFloat(cc.price),
                    account_number: targetAccount.account_number
                });
            }
        });
    }

    // 4. Build Projection
    const projection = [];
    const currentAccountBalances = {};
    accounts.forEach(acc => {
        currentAccountBalances[acc.account_number] = acc.balance;
    });

    for (let i = 0; i <= days; i++) {
        const currentDate = new Date(today);
        currentDate.setDate(today.getDate() + i);
        const dateStr = formatISODate(currentDate);
        const dateTs = currentDate.getTime();

        const dailyBankRecurring = [];
        const ccGroupMap = new Map(); // Group by card

        // We only apply transactions for future days (i > 0)
        // i=0 is today, usually we show partial or full balance. 
        // Adhering to previous logic: transactions are applied if i > 0.

        if (i > 0) {
            const events = eventMap.get(dateTs) || [];

            events.forEach(event => {
                if (event.type === 'bank' || event.type === 'manual') {
                    if (currentAccountBalances[event.account_number] !== undefined) {
                        dailyBankRecurring.push({
                            name: event.name,
                            amount: event.amount,
                            category: event.category,
                            account_number: event.account_number,
                            is_manual: event.is_manual
                        });
                        currentAccountBalances[event.account_number] += event.amount;
                    }
                } else if (event.type === 'cc') {
                    const key = `${event.account_number}-${event.vendor}-${event.last4}`;
                    if (!ccGroupMap.has(key)) {
                        ccGroupMap.set(key, {
                            name: event.name,
                            last4: event.last4,
                            amount: 0,
                            vendor: event.vendor,
                            account_number: event.account_number,
                            count: 0
                        });
                    }
                    const grouped = ccGroupMap.get(key);
                    grouped.amount += event.price;
                    grouped.count += 1;

                    currentAccountBalances[event.account_number] += event.price;
                }
            });
        }

        const dailyCCPayments = Array.from(ccGroupMap.values()).map(item => ({
            ...item,
            displayName: `${item.name} ..${item.last4}`
        }));

        const totalBalance = Object.values(currentAccountBalances).reduce((sum, b) => sum + b, 0);

        const dailyChange = (i === 0) ? 0 : (
            dailyBankRecurring.reduce((sum, item) => sum + item.amount, 0) +
            dailyCCPayments.reduce((sum, item) => sum + item.amount, 0)
        );

        projection.push({
            date: dateStr,
            balances: { ...currentAccountBalances },
            totalBalance,
            bankRecurring: dailyBankRecurring,
            ccPayments: dailyCCPayments,
            dailyChange
        });
    }

    return projection;
}

/**
 * Builds a full-month, day-by-day checking-account balance for the monthly
 * calendar view: real reconstructed balance for days up to and including
 * today, projected balance for days after today.
 *
 * The anchor point is `currentBalance` (the bank's own reported balance, as
 * of right now) placed on "today". Every other day's balance is derived
 * relative to that anchor:
 *   - Future days: walk forward from today, adding each day's *projected*
 *     change (known fixed recurring items + already-scheduled card
 *     settlements) - the same event model generateProjection() uses.
 *   - Past/today days: walk backward from today, undoing each day's
 *     *actual* recorded bank-side transactions - this is real data, not a
 *     guess, so it's exact regardless of category.
 *
 * @param {Object} params
 * @param {number} params.currentBalance - the account's current real balance
 * @param {Array<{date: string, price: number}>} params.actualTransactions - real bank-side transactions (any category) for the account, ideally covering at least the requested month
 * @param {Array<{name: string, amount: number, day_of_month: number}>} params.fixedRecurring - known fixed monthly obligations (RiseUp "fixed" envelope items + manual recurring), amount signed (negative = expense)
 * @param {Array<{name: string, amount: number, date: string}>} params.ccPayments - already-scheduled future credit-card settlement debits hitting this account
 * @param {Array<{category: string, amount: number, date: string|Date}>} params.estimatedFutureSpend - estimated (3-month-average) variable spending, each already placed on the REAL billing date of the card it came from - not a guess about timing, only about amount
 * @param {string} params.monthStr - "YYYY-MM" of the month to render
 * @param {Date} [params.todayDate] - override "today" (for tests); defaults to the real current date
 * @returns {Array<{date: string, day: number, balance: number|null, dailyChange: number, isFuture: boolean, isToday: boolean, dayOfWeek: number}>}
 */
export function generateMonthCalendar({ currentBalance, actualTransactions, fixedRecurring, ccPayments, estimatedFutureSpend = [], monthStr, todayDate = null }) {
    const today = todayDate ? getLocalMidnight(todayDate) : getLocalMidnight();
    const [year, monthNum] = monthStr.split('-').map(Number);
    const daysInMonth = new Date(year, monthNum, 0).getDate();
    const monthStart = new Date(year, monthNum - 1, 1);
    const monthEnd = new Date(year, monthNum - 1, daysInMonth);

    const actualByDay = new Map();
    for (const t of actualTransactions || []) {
        const key = getLocalMidnight(t.date).getTime();
        if (!actualByDay.has(key)) actualByDay.set(key, []);
        actualByDay.get(key).push({ name: t.name || 'לא מסווג', category: t.category || null, amount: t.price, type: 'actual' });
    }

    const ccByDay = new Map();
    for (const cc of ccPayments || []) {
        if (!cc.date) continue;
        const key = getLocalMidnight(cc.date).getTime();
        if (!ccByDay.has(key)) ccByDay.set(key, []);
        ccByDay.get(key).push({ name: cc.category || 'לא מסווג', category: cc.category || null, amount: cc.amount, type: 'card' });
    }

    // Estimated spending, already placed by the caller on the real billing date
    // of the card it came from (see month-calendar.js) - kept entirely separate
    // from the "guaranteed" balance walk below, then layered on top as its own
    // cumulative total (estimatedBalance), so a delta's sign is never mistaken
    // for the final result's sign.
    // Keyed by day + category, not just day: two different cards can both bill
    // on the same day and both carry (say) "groceries" spending - merge those
    // into one summed line per category per day, matching "by category" as a
    // single figure rather than one row per contributing card.
    const estimateByDayCategory = new Map();
    for (const est of estimatedFutureSpend || []) {
        if (!est.date) continue;
        const dayKey = getLocalMidnight(est.date).getTime();
        const category = est.category || 'לא מסווג';
        const mapKey = `${dayKey}|${category}`;
        if (!estimateByDayCategory.has(mapKey)) {
            estimateByDayCategory.set(mapKey, { dayKey, name: category, category, amount: 0, type: 'estimate' });
        }
        estimateByDayCategory.get(mapKey).amount += est.amount;
    }
    const estimateByDay = new Map();
    for (const entry of estimateByDayCategory.values()) {
        if (!estimateByDay.has(entry.dayKey)) estimateByDay.set(entry.dayKey, []);
        estimateByDay.get(entry.dayKey).push({ name: entry.name, category: entry.category, amount: entry.amount, type: 'estimate' });
    }

    // Fixed recurring items repeat every month on the same day-of-month (clamped
    // for short months) - evaluate this for ANY date, not just within the
    // requested month, since bridging from "today" to a future/past month may
    // cross other months' occurrences too (e.g. viewing next month from today
    // still needs to know about an occurrence landing between the two).
    const fixedEventsForDate = (d) => {
        const dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        const events = [];
        for (const item of fixedRecurring || []) {
            if (!item.day_of_month) continue;
            const targetDay = Math.min(item.day_of_month, dim);
            if (d.getDate() === targetDay) events.push({ name: item.name, category: item.category || null, amount: item.amount, type: 'fixed' });
        }
        return events;
    };
    const projectedEventsForDate = (d) => [...fixedEventsForDate(d), ...(ccByDay.get(d.getTime()) || [])];
    const projectedChangeForDate = (d) => projectedEventsForDate(d).reduce((sum, e) => sum + e.amount, 0);
    const actualEventsForDate = (d) => actualByDay.get(d.getTime()) || [];
    const actualChangeForDate = (d) => actualEventsForDate(d).reduce((sum, e) => sum + e.amount, 0);

    // Anchor is always "today" = currentBalance, regardless of which month is
    // being displayed - then bridge outward in whichever direction(s) are
    // needed to reach the requested month, one day at a time.
    const balanceAtDate = new Map();
    const estimateCumulativeAtDate = new Map();
    balanceAtDate.set(today.getTime(), currentBalance);
    estimateCumulativeAtDate.set(today.getTime(), 0);

    if (monthEnd.getTime() > today.getTime()) {
        let running = currentBalance;
        let estimateCumulative = 0;
        const cursor = new Date(today);
        while (cursor.getTime() < monthEnd.getTime()) {
            cursor.setDate(cursor.getDate() + 1);
            running += projectedChangeForDate(cursor);
            estimateCumulative += (estimateByDay.get(cursor.getTime()) || []).reduce((sum, e) => sum + e.amount, 0);
            balanceAtDate.set(cursor.getTime(), running);
            estimateCumulativeAtDate.set(cursor.getTime(), estimateCumulative);
        }
    }

    if (monthStart.getTime() < today.getTime()) {
        let running = currentBalance;
        const cursor = new Date(today);
        while (cursor.getTime() > monthStart.getTime()) {
            const changeOnThisDay = actualChangeForDate(cursor);
            cursor.setDate(cursor.getDate() - 1);
            running -= changeOnThisDay;
            balanceAtDate.set(cursor.getTime(), running);
        }
    }

    const allDays = [];
    for (let day = 1; day <= daysInMonth; day++) {
        allDays.push(new Date(year, monthNum - 1, day));
    }

    return allDays.map((d) => {
        const key = d.getTime();
        const isFuture = key > today.getTime();
        const isToday = key === today.getTime();
        // Real events for past/today (itemized actual transactions), scheduled
        // events for the future (fixed obligations + known card settlements) -
        // same shape either way, so the day square and popup don't need to
        // special-case which kind of day they're looking at.
        const dayEvents = isFuture ? projectedEventsForDate(d) : actualEventsForDate(d);
        const dailyChange = dayEvents.reduce((sum, e) => sum + e.amount, 0);
        const balance = balanceAtDate.has(key) ? balanceAtDate.get(key) : null;

        // Estimated balance: the "guaranteed" balance (real transactions for
        // past days; fixed obligations + already-scheduled card settlements
        // for future days) PLUS the cumulative effect of every estimated
        // spend event that has landed between today and this day (inclusive).
        // Only meaningful for future days - past/today are already fully real,
        // nothing left to estimate. Each estimate lands on the real billing
        // date of the card it came from (see month-calendar.js), not smeared
        // evenly across every day - so this day's OWN events only include an
        // estimate line if one actually lands here, while estimatedBalance
        // reflects the running cumulative total up to this point.
        const dayEstimateEvents = isFuture ? (estimateByDay.get(key) || []) : [];
        const events = [...dayEvents, ...dayEstimateEvents];
        let estimatedBalance = null;
        if (isFuture && balance !== null) {
            const cumulative = estimateCumulativeAtDate.get(key) || 0;
            estimatedBalance = Math.round((balance + cumulative) * 100) / 100;
        }

        // income / expenses / estimateTotal: the three line-item sums the
        // calendar square and popup both render as a small styled ledger,
        // distinct from `balance` (the running total) and `estimatedBalance`
        // (the final, once-off summary that includes the estimate).
        const income = Math.round(events.filter(e => e.type !== 'estimate' && e.amount > 0).reduce((sum, e) => sum + e.amount, 0) * 100) / 100;
        const expenses = Math.round(events.filter(e => e.type !== 'estimate' && e.amount < 0).reduce((sum, e) => sum + e.amount, 0) * 100) / 100;
        const estimateTotal = Math.round(events.filter(e => e.type === 'estimate').reduce((sum, e) => sum + e.amount, 0) * 100) / 100;

        return {
            date: formatISODate(d),
            day: d.getDate(),
            balance: balance !== null ? Math.round(balance * 100) / 100 : null,
            dailyChange: Math.round(dailyChange * 100) / 100,
            income,
            expenses,
            estimateTotal,
            estimatedBalance,
            events,
            isFuture,
            isToday,
            dayOfWeek: d.getDay()
        };
    });
}
