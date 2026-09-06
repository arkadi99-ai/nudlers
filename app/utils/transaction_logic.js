/**
 * Generates a SQL fragment to determine the "Effective Billing Month" (YYYY-MM) for a transaction.
 * 
 * Logic:
 * 1. If processed_date exists, use it.
 * 2. If processed_date is NULL:
 *    - If transaction day >= startDay: It belongs to next month's bill.
 *    - If transaction day < startDay: It belongs to this month's bill.
 * 
 * @param {number} startDay - The billing cycle start day (default 10)
 * @param {string} dateCol - The name of the date column (default 'date')
 * @param {string} processedDateCol - The name of the processed_date column (default 'processed_date')
 * @returns {string} The SQL fragment returning a 'YYYY-MM' string
 */
export function getBillingCycleSql(startDay = 10, dateCol = 'date', processedDateCol = 'processed_date') {
    return `
        TO_CHAR(
            CASE 
                /* 1. If we have a specific billing date (processed_date) that differs from the transaction date,
                   it already represents a determined billing moment.
                   If it's on or after the startDay, it belongs to this month's cycle.
                   If it's before the startDay, it belongs to the previous month's cycle. */
                WHEN ${processedDateCol} IS NOT NULL AND ${processedDateCol} != ${dateCol}
                THEN (
                    CASE 
                        WHEN EXTRACT(DAY FROM ${processedDateCol}) > ${startDay} 
                        THEN ${processedDateCol}
                        ELSE (${processedDateCol} - INTERVAL '1 month')
                    END
                )
                /* 2. Standard logic for new transactions or bank transactions (where date == processed_date):
                   Anything on or after the startDay belongs to the current month's cycle.
                   Anything before the startDay belongs to the previous month's cycle. */
                WHEN EXTRACT(DAY FROM COALESCE(${processedDateCol}, ${dateCol})) >= ${startDay} 
                THEN COALESCE(${processedDateCol}, ${dateCol})
                ELSE (COALESCE(${processedDateCol}, ${dateCol}) - INTERVAL '1 month')
            END, 
            'YYYY-MM'
        )
    `;
}

/**
 * Israeli credit-card companies show up as a recurring BANK-side line every
 * month for "your card bill got paid" - real, expected, and already counted
 * via the card's own itemized purchases. Any report that sums bank-side
 * transactions as real spending (a Sources & Uses statement, the
 * unflagged_recurring anomaly detector) needs to exclude these by name, or
 * every card purchase gets counted twice - once itemized, once as this
 * lump settlement. Amount-variance alone can't reliably tell "a real
 * recurring bank expense" from "the bank's own label for a card
 * settlement" (a real false positive surfaced this: "ישראכרט בע"מ" swings
 * ₪12k-32k/month, real history since 2024, still looked "recurring").
 */
export const CARD_COMPANY_SETTLEMENT_PATTERN = /ישראכרט|כרטיסי אשראי|כאל|לאומי קארד|מקס(?!ים)/;

export function isCardCompanySettlement(name) {
    return typeof name === 'string' && CARD_COMPANY_SETTLEMENT_PATTERN.test(name);
}
