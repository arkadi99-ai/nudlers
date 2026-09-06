import type { DetectedAnomaly } from '../types';

/**
 * Flag a category that has climbed for 3 straight FULL months in a row —
 * a sustained monthly-level drift that a single-week z-score (categorySpike)
 * or a single hiked merchant (priceHike) wouldn't surface on its own: no
 * individual week or transaction looks abnormal, but the trend does.
 *
 * Algorithm:
 *  - Bucket expenses (negative amounts) by category + calendar month,
 *    excluding the current in-progress month (not comparable yet).
 *  - Take the last 3 full months. Flag if each step up is >= MIN_STEP_RATIO
 *    (10%) over the previous one.
 *
 * Severity: 'high' if the trend more than doubled month 1 -> month 3 relative
 * growth (>= 50%), otherwise 'medium'.
 */

const MIN_STEP_RATIO = 1.1;
const HIGH_SEVERITY_TOTAL_GROWTH = 1.5;
const TREND_MONTHS = 3;

export interface RisingTrendTransaction {
    category: string | null;
    amount: number; // signed; charges are negative.
    date: Date | string;
}

export function detectRisingTrends(transactions: RisingTrendTransaction[]): DetectedAnomaly[] {
    const now = new Date();
    const currentMonthKey = monthKey(now);

    const byCategory = new Map<string, Map<string, number>>();
    for (const t of transactions) {
        if (!t.category) continue;
        if (t.amount >= 0) continue;
        const date = t.date instanceof Date ? t.date : new Date(t.date);
        if (Number.isNaN(date.getTime())) continue;
        const mKey = monthKey(date);
        if (mKey === currentMonthKey) continue;

        let months = byCategory.get(t.category);
        if (!months) {
            months = new Map();
            byCategory.set(t.category, months);
        }
        months.set(mKey, (months.get(mKey) ?? 0) + Math.abs(t.amount));
    }

    const out: DetectedAnomaly[] = [];
    for (const [category, months] of byCategory) {
        const sortedKeys = [...months.keys()].sort();
        if (sortedKeys.length < TREND_MONTHS) continue;

        const lastKeys = sortedKeys.slice(-TREND_MONTHS);
        const lastValues = lastKeys.map((k) => months.get(k)!);

        let isRising = true;
        for (let i = 1; i < lastValues.length; i++) {
            if (lastValues[i] < lastValues[i - 1] * MIN_STEP_RATIO) {
                isRising = false;
                break;
            }
        }
        if (!isRising) continue;
        if (lastValues[0] <= 0) continue;

        const totalGrowth = lastValues[lastValues.length - 1] / lastValues[0];
        const severity = totalGrowth >= HIGH_SEVERITY_TOTAL_GROWTH ? 'high' : 'medium';
        const amounts = lastValues.map((v) => Math.round(v));
        const fingerprint = `rising_trend|${category}|${lastKeys[lastKeys.length - 1]}`;

        out.push({
            type: 'rising_trend',
            severity,
            fingerprint,
            title: `${category} is rising 3 months straight (${amounts.map((a) => `₪${a}`).join(' → ')})`,
            body: `Spend in ${category} has been climbing for three straight months: ${amounts.map((a) => `₪${a}`).join(' → ')}.`,
            payload: {
                category,
                months: lastKeys,
                amounts,
            },
        });
    }
    return out;
}

function monthKey(d: Date | string): string {
    const dt = d instanceof Date ? d : new Date(d);
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
}
