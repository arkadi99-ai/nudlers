import type { DetectedAnomaly } from '../types';
import { normalizeMerchant } from '../normalize';
import { isCardCompanySettlement } from '../../transaction_logic';

/**
 * Flag an established recurring charge that was never tagged as a "fixed"
 * commitment (RiseUp's own budget classification) - a likely forgotten
 * subscription. Deliberately fills the gap `new_recurring` leaves open by
 * design: that detector only fires on a merchant's 2nd/3rd charge and stops
 * once month_count > 3 ("by month 4+ it's no longer new" — see
 * newRecurring.ts). A subscription that's been quietly running for a year
 * ages out of that window entirely and would otherwise never resurface.
 *
 * Algorithm:
 *  - Bucket expenses (negative amounts) by normalized merchant + account,
 *    over the trailing LOOKBACK_MONTHS full months (current month excluded).
 *  - Skip anything already tagged commitment_type = 'fixed' — RiseUp already
 *    knows about it, no need to re-surface it here.
 *  - Require the merchant to appear in at least MIN_MONTHS_SEEN of those
 *    months, at a near-constant monthly total (coefficient of variation
 *    <= MAX_COEFFICIENT_OF_VARIATION) - a real recurring charge, not a
 *    coincidental repeat purchase at wildly different amounts.
 */

const LOOKBACK_MONTHS = 4;
const MIN_MONTHS_SEEN = 3;
const MAX_COEFFICIENT_OF_VARIATION = 0.2;
const MIN_AVERAGE_AMOUNT = 15;
const HIGH_SEVERITY_AMOUNT = 50;

export interface UnflaggedRecurringTransaction {
    name: string;
    category: string | null;
    amount: number; // signed; charges are negative.
    date: Date | string;
    accountNumber?: string | null;
    isFixedCommitment: boolean; // RiseUp's own budget classification, if known
}

interface MerchantBucket {
    rawName: string;
    rawNameDate: number;
    category: string | null;
    accountNumber: string | null;
    monthly: Map<string, number>; // month -> total spend
}

export function detectUnflaggedRecurring(transactions: UnflaggedRecurringTransaction[]): DetectedAnomaly[] {
    const now = new Date();
    const currentMonthKey = monthKey(now);
    const cutoff = new Date(now);
    cutoff.setMonth(cutoff.getMonth() - LOOKBACK_MONTHS);

    const byMerchant = new Map<string, MerchantBucket>();
    for (const t of transactions) {
        if (t.amount >= 0) continue;
        if (t.isFixedCommitment) continue;
        if (isCardCompanySettlement(t.name)) continue;
        const date = t.date instanceof Date ? t.date : new Date(t.date);
        if (Number.isNaN(date.getTime())) continue;
        const mKey = monthKey(date);
        if (mKey === currentMonthKey) continue;
        if (date < cutoff) continue;

        const normalized = normalizeMerchant(t.name);
        if (!normalized) continue;
        const key = `${normalized}|${t.accountNumber ?? 'na'}`;
        let entry = byMerchant.get(key);
        if (!entry) {
            entry = {
                rawName: t.name,
                rawNameDate: date.getTime(),
                category: t.category,
                accountNumber: t.accountNumber ?? null,
                monthly: new Map(),
            };
            byMerchant.set(key, entry);
        } else if (date.getTime() > entry.rawNameDate) {
            entry.rawName = t.name;
            entry.rawNameDate = date.getTime();
        }
        entry.monthly.set(mKey, (entry.monthly.get(mKey) ?? 0) + Math.abs(t.amount));
    }

    const out: DetectedAnomaly[] = [];
    for (const [key, entry] of byMerchant) {
        if (entry.monthly.size < MIN_MONTHS_SEEN) continue;

        const monthlyTotals = [...entry.monthly.values()];
        const avg = monthlyTotals.reduce((s, a) => s + a, 0) / monthlyTotals.length;
        if (avg < MIN_AVERAGE_AMOUNT) continue;

        const variance = monthlyTotals.reduce((s, a) => s + (a - avg) ** 2, 0) / monthlyTotals.length;
        const coefficientOfVariation = avg > 0 ? Math.sqrt(variance) / avg : 0;
        if (coefficientOfVariation > MAX_COEFFICIENT_OF_VARIATION) continue;

        const avgAmount = Number(avg.toFixed(2));
        const amountStr = avgAmount.toFixed(2).replace(/\.00$/, '');
        const fingerprint = `unflagged_recurring|${key}`;

        out.push({
            type: 'unflagged_recurring',
            severity: avgAmount >= HIGH_SEVERITY_AMOUNT ? 'high' : 'medium',
            fingerprint,
            title: `Possibly forgotten subscription: ${entry.rawName} (~₪${amountStr}/mo)`,
            body: `${entry.rawName} has charged a similar amount in ${entry.monthly.size} of the last ${LOOKBACK_MONTHS} months but isn't marked as a fixed expense.`,
            payload: {
                merchant: entry.rawName,
                category: entry.category,
                monthsSeen: entry.monthly.size,
                averageAmount: avgAmount,
                accountNumber: entry.accountNumber,
            },
        });
    }
    return out;
}

function monthKey(d: Date | string): string {
    const dt = d instanceof Date ? d : new Date(d);
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
}
