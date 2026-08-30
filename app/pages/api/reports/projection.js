import { pool } from "../db";
import { detectRecurringPayments } from "../../../utils/recurringDetection";
import logger from "../../../utils/logger";
import { normalizeTransactionDates, generateProjection } from "../../../utils/projectionUtils";
import { BANK_VENDORS } from "../../../utils/constants";

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', ['GET']);
        return res.status(405).end(`Method ${req.method} Not Allowed`);
    }

    try {
        // Run all independent queries in parallel, each on its own pooled connection
        // (via `pool`, not a single shared client) - a single pg Client can only run
        // one query at a time, and running several concurrently on it triggers
        // "client is already executing a query" (deprecated, hard error in pg@9)
        // and destabilizes the connection.
        const [accountsRes, bankTransRes, manualRes, ccRes, riseupFixedRes] = await Promise.all([
            // 1. Get Accounts. Direct-bank vendors are always a bank account. RiseUp
            // mixes cards and one checking account under a single vendor - include a
            // riseup account here only if it actually has bank-tagged transactions
            // (i.e. it's the checking account, not one of the cards).
            pool.query(`
                SELECT
                    co.id,
                    co.account_number,
                    co.balance,
                    co.balance_updated_at,
                    co.custom_bank_account_nickname,
                    vc.nickname as vendor_nickname,
                    vc.id as credential_id
                FROM card_ownership co
                JOIN vendor_credentials vc ON co.credential_id = vc.id
                WHERE co.is_hidden = false
                  AND (
                    co.vendor = ANY($1)
                    OR (co.vendor = 'riseup' AND EXISTS (
                        SELECT 1 FROM transactions t
                        WHERE t.vendor = 'riseup' AND t.account_number = co.account_number AND t.transaction_type = 'bank'
                    ))
                  )
            `, [BANK_VENDORS]),
            // 2. Get Bank Transactions (for pattern-based recurring detection). RiseUp is
            // excluded here - it has its own authoritative "fixed" classification (query 5
            // below), so running the statistical guesser on it too would double-count.
            pool.query(`
                WITH excluded AS (
                    SELECT LOWER(TRIM(name)) as name, account_number
                    FROM non_recurring_exclusions
                )
                SELECT t.name, t.price, t.category, t.vendor, t.account_number, t.date, t.processed_date, t.transaction_type
                FROM transactions t
                WHERE t.transaction_type = 'bank'
                  AND t.vendor != 'riseup'
                  AND t.date >= CURRENT_DATE - INTERVAL '180 days'
                  AND t.category NOT IN ('Bank', 'Income')
                  AND NOT EXISTS (
                      SELECT 1 FROM excluded e 
                      WHERE LOWER(TRIM(t.name)) = e.name 
                        AND (e.account_number IS NULL OR e.account_number = t.account_number)
                  )
                ORDER BY t.date DESC
            `),
            // 3. Get Manual Recurring
            pool.query(`
                SELECT name, amount, category, account_number, day_of_month, frequency
                FROM manual_recurring_payments
                WHERE is_active = true
            `),
            // 4. Get Future CC Payments
            pool.query(`
                SELECT 
                    t.name, t.price, t.date, t.processed_date, t.vendor, t.account_number, t.category,
                    co.linked_bank_account_id,
                    COALESCE(cv.card_nickname, vc_card.nickname, t.vendor) as card_name,
                    (CASE WHEN t.vendor = 'riseup' THEN t.account_number ELSE RIGHT(t.account_number, 4) END) as last4
                FROM transactions t
                LEFT JOIN card_ownership co ON t.vendor = co.vendor AND (CASE WHEN t.vendor = 'riseup' THEN t.account_number ELSE RIGHT(t.account_number, 4) END) = (CASE WHEN co.vendor = 'riseup' THEN co.account_number ELSE RIGHT(co.account_number, 4) END)
                LEFT JOIN vendor_credentials vc_card ON co.credential_id = vc_card.id
                LEFT JOIN vendor_credentials vc_bank ON co.linked_bank_account_id = vc_bank.id
                LEFT JOIN card_vendors cv ON (CASE WHEN t.vendor = 'riseup' THEN t.account_number ELSE RIGHT(t.account_number, 4) END) = cv.last4_digits AND t.vendor = cv.card_vendor
                WHERE t.transaction_type = 'credit_card'
                  AND (
                    (t.processed_date >= CURRENT_DATE)
                    OR
                    (t.processed_date IS NULL AND t.date >= CURRENT_DATE)
                  )
                AND COALESCE(t.processed_date, t.date) <= CURRENT_DATE + INTERVAL '35 days'
            `),
            // 5. Get RiseUp's own "fixed" bank-side commitments (direct debits / standing
            // orders the user already classified as fixed inside RiseUp itself - e.g.
            // property tax, insurance, utilities) - the most recent occurrence of each,
            // projected forward onto the same day next month. Scoped to bank-tagged
            // transactions only: fixed subscriptions billed via a card are already
            // covered by the "Future CC Payments" query above once they're next charged.
            pool.query(`
                SELECT DISTINCT ON (name, account_number)
                    name, price, category, account_number,
                    EXTRACT(DAY FROM date)::int as day_of_month
                FROM transactions
                WHERE vendor = 'riseup'
                  AND transaction_type = 'bank'
                  AND commitment_type = 'fixed'
                  AND date >= CURRENT_DATE - INTERVAL '45 days'
                ORDER BY name, account_number, date DESC
            `)
        ]);

        const accounts = accountsRes.rows.map(row => ({
            id: row.id,
            account_number: row.account_number,
            balance: parseFloat(row.balance || 0),
            nickname: row.custom_bank_account_nickname || row.vendor_nickname,
            credential_id: row.credential_id
        }));

        const accountMetadata = {};
        accounts.forEach(acc => {
            accountMetadata[acc.account_number] = {
                nickname: acc.nickname,
                account_number: acc.account_number,
                credential_id: acc.credential_id
            };
        });

        // Detect recurring payments from history
        const allRecurring = detectRecurringPayments(bankTransRes.rows);

        // Process CC Data
        const futureCCPayments = ccRes.rows;
        normalizeTransactionDates(futureCCPayments);

        // RiseUp's own "fixed" commitments slot into the same shape generateProjection
        // already expects for manual recurring payments (name/amount/category/account_number/day_of_month).
        const riseupFixedRecurring = riseupFixedRes.rows.map(row => ({
            name: row.name,
            amount: parseFloat(row.price),
            category: row.category,
            account_number: row.account_number,
            day_of_month: row.day_of_month
        }));

        // Generate Projection
        const projection = generateProjection(
            accounts,
            allRecurring,
            [...manualRes.rows, ...riseupFixedRecurring],
            futureCCPayments,
            30
        );

        const summary = {
            startingBalance: accounts.reduce((sum, acc) => sum + acc.balance, 0),
            endingBalance: projection.length > 0 ? projection[projection.length - 1].totalBalance : 0,
            periodDays: 30
        };

        res.status(200).json({
            summary,
            projection,
            accounts,
            accountMetadata
        });
    } catch (error) {
        logger.error({ error: error.message, stack: error.stack }, "Error generating projection");
        res.status(500).json({ error: 'Internal Server Error' });
    }
}
