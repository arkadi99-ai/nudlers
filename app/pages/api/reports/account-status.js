import { pool } from "../db";
import logger from "../../../utils/logger";
import { getForecastInputs } from "../../../utils/forecastDataSource";
import { computeForwardBalanceWindow } from "../../../utils/projectionUtils";
import { formatISODate } from "../../../utils/dateUtils";

const DEFAULT_SAFETY_BUFFER = 3000;
const FORECAST_WINDOW_DAYS = 45;

// GET /api/reports/account-status
//
// Powers the main-dashboard "account status" card: current checking balance,
// total known fixed monthly obligations, the variable (card) spending due
// to hit the account on the next scheduled credit-card settlement date, and
// the "safe to invest" forecast (how much can be moved to savings today
// without the account dipping below its safety buffer before the next full
// credit-card billing cycle completes - see computeForwardBalanceWindow()).
export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', ['GET']);
        return res.status(405).end(`Method ${req.method} Not Allowed`);
    }

    try {
        const today = new Date();
        const windowEnd = new Date(today);
        windowEnd.setDate(windowEnd.getDate() + FORECAST_WINDOW_DAYS);

        const [balanceRes, fixedRes, ccRes, forecastInputs, bufferRes, snapshotRes] = await Promise.all([
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
            // Local fallback estimate of "fixed" commitments (bank AND card),
            // used only when we don't yet have a fresh snapshot of RiseUp's
            // OWN computed total (see riseup_fixed_expenses_snapshot below -
            // that's the preferred source, since it's RiseUp's own already-
            // reconciled figure). This reconstruction has known edge cases we
            // can't fully close locally: a merchant can bill multiple genuinely
            // separate fixed charges on the same date (e.g. two insurance
            // policies under one company name) - handled by summing every
            // charge on each merchant's own most recent date, not just one row.
            // An installment plan whose last payment already happened should
            // NOT be projected forward - excluded via installments_number <
            // installments_total. Amount is always the MOST RECENT real charge,
            // never an average, so a rent increase is reflected immediately.
            // 100-day window (not 45) to safely cover bi-monthly bills (water,
            // some gas invoices) without requiring a live RiseUp call.
            pool.query(`
                WITH recent_fixed AS (
                    SELECT name, account_number, transaction_type, date, price, installments_number, installments_total
                    FROM transactions
                    WHERE vendor = 'riseup'
                      AND transaction_type IN ('bank', 'credit_card')
                      AND commitment_type = 'fixed'
                      AND price < 0
                      AND date >= CURRENT_DATE - INTERVAL '100 days'
                ),
                latest_date_per_merchant AS (
                    SELECT name, account_number, transaction_type, MAX(date) as latest_date
                    FROM recent_fixed
                    GROUP BY name, account_number, transaction_type
                )
                SELECT rf.price
                FROM recent_fixed rf
                JOIN latest_date_per_merchant l
                  ON rf.name = l.name AND rf.account_number = l.account_number
                  AND rf.transaction_type = l.transaction_type AND rf.date = l.latest_date
                WHERE rf.installments_total IS NULL OR rf.installments_total <= 1
                   OR rf.installments_number < rf.installments_total
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
            `),
            // Fixed commitments, scheduled CC settlements, and the variable-
            // spend estimate for the forecast window - shared with the
            // monthly calendar view (see forecastDataSource.js).
            getForecastInputs({ rangeStart: formatISODate(today), rangeEnd: formatISODate(windowEnd) }),
            // User-configured safety buffer (defaults if never set).
            pool.query(`SELECT value FROM app_settings WHERE key = 'safety_buffer'`),
            // RiseUp's own computed "fixed expenses" total for the current
            // cashflow month, captured at sync time (see fetchCurrentMonthFixedTotal
            // in scrapers/riseup.js) - preferred over the local reconstruction
            // above whenever it's fresh, since RiseUp already does the real
            // reconciliation (completed installments, multi-charge merchants,
            // envelope re-categorization) that a local heuristic can only
            // approximate.
            pool.query(`SELECT value FROM app_settings WHERE key = 'riseup_fixed_expenses_snapshot'`)
        ]);

        const currentBalance = parseFloat(balanceRes.rows[0]?.balance ?? 0);
        const hasBalance = balanceRes.rows.length > 0;

        const FIXED_SNAPSHOT_MAX_AGE_DAYS = 35;
        const snapshot = snapshotRes.rows[0]?.value ?? null;
        const snapshotAgeDays = snapshot?.capturedAt
            ? (Date.now() - new Date(snapshot.capturedAt).getTime()) / (1000 * 60 * 60 * 24)
            : Infinity;

        let fixedMonthlyTotal;
        let fixedMonthlyTotalSource;
        if (snapshot && typeof snapshot.total === 'number' && snapshotAgeDays <= FIXED_SNAPSHOT_MAX_AGE_DAYS) {
            fixedMonthlyTotal = Math.abs(snapshot.total);
            fixedMonthlyTotalSource = 'riseup';
        } else {
            fixedMonthlyTotal = fixedRes.rows.reduce((sum, r) => sum + Math.abs(parseFloat(r.price)), 0);
            fixedMonthlyTotalSource = 'estimated';
        }

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

        const safetyBuffer = bufferRes.rows.length > 0 ? parseFloat(bufferRes.rows[0].value) : DEFAULT_SAFETY_BUFFER;

        // "Safe to invest": how much can move to savings today without the
        // account dipping below its safety buffer at any point before the
        // next full credit-card billing cycle completes (already accounts
        // for real scheduled settlements, installments, fixed obligations,
        // and estimated variable spend - see computeForwardBalanceWindow()).
        let forecast = null;
        if (hasBalance) {
            const { minEstimatedBalance, minEstimatedDate, minGuaranteedBalance, minGuaranteedDate } = computeForwardBalanceWindow({
                currentBalance,
                fixedRecurring: forecastInputs.fixedRecurring,
                ccPayments: forecastInputs.ccPayments,
                estimatedFutureSpend: forecastInputs.estimatedFutureSpend,
                days: FORECAST_WINDOW_DAYS
            });

            const isRed = minEstimatedBalance < safetyBuffer;
            forecast = {
                safetyBuffer,
                minProjectedBalance: minEstimatedBalance,
                minProjectedDate: minEstimatedDate,
                minGuaranteedBalance,
                minGuaranteedDate,
                isRed,
                // Green state: how much is safely movable to savings today.
                safeToInvest: isRed ? 0 : Math.round((minEstimatedBalance - safetyBuffer) * 100) / 100,
                // Red state: how much would need depositing from savings to
                // avoid dipping below the buffer.
                shortfall: isRed ? Math.round((safetyBuffer - minEstimatedBalance) * 100) / 100 : 0
            };
        }

        res.status(200).json({
            currentBalance,
            hasBalance,
            balanceUpdatedAt: balanceRes.rows[0]?.balance_updated_at ?? null,
            fixedMonthlyTotal,
            fixedMonthlyTotalSource,
            nextCardSettlement,
            forecast
        });
    } catch (error) {
        logger.error({ error: error.message, stack: error.stack }, "Error generating account status");
        res.status(500).json({ error: 'Internal Server Error' });
    }
}
