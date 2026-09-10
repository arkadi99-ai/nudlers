import { pool } from '../pages/api/db.js';
import logger from './logger.js';
import { getAIClient } from './aiClient.js';
import { getForecastInputs } from './forecastDataSource.js';
import { computeForwardBalanceWindow } from './projectionUtils.js';
import { formatISODate } from './dateUtils.js';
import { isCardCompanySettlement } from './transaction_logic.js';

const DEFAULT_SAFETY_BUFFER = 3000;
const FORECAST_WINDOW_DAYS = 45;

const PERSONA_PROMPT = `You are "Nudi" - a warm, funny, slightly cheeky family financial assistant who posts short updates in a family WhatsApp group. Your job: help the family feel good about saving money and gently flag real problems - never boring, never robotic.

Style rules:
- Write in Hebrew, 2-5 short sentences, WhatsApp-casual (emoji OK, sparingly).
- If someone's spending went DOWN vs the comparison period, playfully praise them by name/role (e.g. "אישתך") - be genuinely warm and funny, like the examples: "פייי מי זאת שעפה על עצמה עם רכישה..." or "תקשיבו... נראה שהחיסכון מתחיל לפתוח".
- If a savings goal is progressing, mention it by name and connect it to the good news (e.g. "רואים את [goal name] מתקרב").
- If the forecast is RED (isRed=true) or there's a high-severity anomaly, mention it clearly but kindly - never alarmist, always paired with a concrete next step ("שווה להעביר קצת מהחיסכון").
- Never invent a number, name, or fact not present in the data given to you. If a section is missing/null, simply don't mention it.
- Do not use markdown formatting (no **, no #). Plain WhatsApp text only.`;

async function getCurrentBalance() {
    const res = await pool.query(`
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
    `);
    return res.rows.length > 0 ? parseFloat(res.rows[0].balance) : null;
}

async function getForecast() {
    const currentBalance = await getCurrentBalance();
    if (currentBalance === null) return null;

    const today = new Date();
    const windowEnd = new Date(today);
    windowEnd.setDate(windowEnd.getDate() + FORECAST_WINDOW_DAYS);

    const [forecastInputs, bufferRes] = await Promise.all([
        getForecastInputs({ rangeStart: formatISODate(today), rangeEnd: formatISODate(windowEnd) }),
        pool.query(`SELECT value FROM app_settings WHERE key = 'safety_buffer'`),
    ]);
    const safetyBuffer = bufferRes.rows.length > 0 ? parseFloat(bufferRes.rows[0].value) : DEFAULT_SAFETY_BUFFER;

    const { minEstimatedBalance } = computeForwardBalanceWindow({
        currentBalance,
        fixedRecurring: forecastInputs.fixedRecurring,
        ccPayments: forecastInputs.ccPayments,
        estimatedFutureSpend: forecastInputs.estimatedFutureSpend,
        days: FORECAST_WINDOW_DAYS,
    });

    const isRed = minEstimatedBalance < safetyBuffer;
    return {
        currentBalance: Math.round(currentBalance),
        isRed,
        safeToInvest: isRed ? 0 : Math.round(minEstimatedBalance - safetyBuffer),
        shortfall: isRed ? Math.round(safetyBuffer - minEstimatedBalance) : 0,
    };
}

async function getSavingsGoals() {
    const res = await pool.query(`SELECT name, target_amount, current_amount, target_date FROM savings_goals ORDER BY created_at ASC`);
    return res.rows.map((r) => ({
        name: r.name,
        targetAmount: Math.round(parseFloat(r.target_amount)),
        currentAmount: Math.round(parseFloat(r.current_amount)),
        percentComplete: Math.round((parseFloat(r.current_amount) / parseFloat(r.target_amount)) * 100),
        targetDate: r.target_date,
    }));
}

/**
 * Per-owner card spend, "this month so far" vs the same number of elapsed
 * days last month - a fairer comparison than full-month-to-date, since the
 * family reads this mid-month, not on the 1st. Empty/absent unless the user
 * has actually tagged card owners (see CardVendorsModal's "owner" column).
 */
async function getOwnerSpendingComparison() {
    const res = await pool.query(`
        WITH owner_map AS (
            SELECT last4_digits, owner FROM card_vendors WHERE owner IS NOT NULL AND owner != ''
        ),
        tx_keyed AS (
            SELECT
                CASE WHEN vendor = 'riseup' THEN account_number ELSE RIGHT(account_number, 4) END as key,
                price, date
            FROM transactions
            WHERE transaction_type = 'credit_card' AND price < 0
        )
        SELECT
            om.owner,
            SUM(CASE WHEN tk.date >= date_trunc('month', CURRENT_DATE) THEN ABS(tk.price) ELSE 0 END) as this_month,
            SUM(CASE
                WHEN tk.date >= date_trunc('month', CURRENT_DATE) - INTERVAL '1 month'
                 AND tk.date < date_trunc('month', CURRENT_DATE)
                 AND EXTRACT(DAY FROM tk.date) <= EXTRACT(DAY FROM CURRENT_DATE)
                THEN ABS(tk.price) ELSE 0 END) as last_month_same_days
        FROM tx_keyed tk
        JOIN owner_map om ON om.last4_digits = tk.key
        GROUP BY om.owner
    `);
    return res.rows.map((r) => ({
        owner: r.owner,
        thisMonthSoFar: Math.round(parseFloat(r.this_month)),
        lastMonthSameDays: Math.round(parseFloat(r.last_month_same_days)),
    }));
}

async function getRecentHighSeverityAnomalies() {
    const res = await pool.query(`
        SELECT type, title, body
        FROM anomalies
        WHERE status = 'open' AND severity = 'high'
          AND updated_at >= NOW() - INTERVAL '7 days'
        ORDER BY updated_at DESC
        LIMIT 5
    `);
    return res.rows.map((r) => ({ type: r.type, title: r.title }));
}

async function getNeedsAttentionSummary() {
    const res = await pool.query(`
        SELECT name, price, transaction_type
        FROM transactions
        WHERE date >= CURRENT_DATE - INTERVAL '30 days'
          AND price < 0
          AND (COALESCE(TRIM(category), '') = '' OR category IN ('אחר', 'לא מסווג', 'Other', 'Uncategorized'))
    `);
    const merchants = new Set();
    let total = 0;
    for (const row of res.rows) {
        if (row.transaction_type === 'bank' && isCardCompanySettlement(row.name)) continue;
        merchants.add(row.name);
        total += Math.abs(parseFloat(row.price));
    }
    if (!total) return null;
    return { merchantCount: merchants.size, total: Math.round(total) };
}

/**
 * Gathers every real, already-computed fact the message can safely
 * reference, then asks the AI to compose the actual text with the
 * PERSONA_PROMPT. The model never sees raw transactions or gets tool
 * access here - only these pre-validated summary numbers - so there's no
 * risk of it inventing or misreading a number from noisy source data.
 */
export async function generateSocialAgentMessage({ periodLabel } = {}) {
    const [forecast, savingsGoals, ownerSpending, anomalies, needsAttention] = await Promise.all([
        getForecast(),
        getSavingsGoals(),
        getOwnerSpendingComparison(),
        getRecentHighSeverityAnomalies(),
        getNeedsAttentionSummary(),
    ]);

    const facts = { periodLabel: periodLabel || null, forecast, savingsGoals, ownerSpending, anomalies, needsAttention };

    const { openai, model } = await getAIClient();
    const completion = await openai.chat.completions.create({
        model,
        messages: [
            { role: 'system', content: PERSONA_PROMPT },
            { role: 'user', content: `Here is this period's real financial data (JSON). Write the WhatsApp message now:\n\n${JSON.stringify(facts, null, 2)}` },
        ],
        temperature: 0.9,
        // Generous budget: this model emits internal "reasoning" tokens that
        // count against max_tokens before it writes the actual visible reply -
        // a low budget here truncates mid-reasoning and returns garbage
        // (confirmed via finish_reason: "length" during testing).
        max_tokens: 1500,
    });

    const text = completion.choices?.[0]?.message?.content?.trim();
    return { text: text || null, facts };
}

/**
 * Picks the single biggest uncategorized/catch-all merchant from the last
 * 30 days that doesn't already have an open pending question, asks the
 * family group what it was (via AI, warm/short phrasing), and records the
 * outgoing WhatsApp message ID so a later quote-reply can be matched back
 * to it (see whatsappCategorizationListener.js).
 */
export async function askAboutNextUnclearExpense() {
    const settingsRes = await pool.query(`SELECT key, value FROM app_settings WHERE key IN ('whatsapp_group_jid', 'whatsapp_enabled')`);
    const settings = {};
    for (const row of settingsRes.rows) settings[row.key] = row.value;
    const groupJid = typeof settings.whatsapp_group_jid === 'string' ? settings.whatsapp_group_jid.replace(/"/g, '') : null;
    const enabled = settings.whatsapp_enabled === true || settings.whatsapp_enabled === 'true';
    if (!enabled || !groupJid) {
        return { skipped: true, reason: !enabled ? 'whatsapp_disabled' : 'no_group_jid' };
    }

    const res = await pool.query(`
        SELECT name, price, transaction_type
        FROM transactions
        WHERE date >= CURRENT_DATE - INTERVAL '30 days'
          AND price < 0
          AND (COALESCE(TRIM(category), '') = '' OR category IN ('אחר', 'לא מסווג', 'Other', 'Uncategorized'))
    `);

    const byName = new Map();
    for (const row of res.rows) {
        // Same exclusion as needs-attention.js / sources-and-uses.js: the
        // credit-card company's own bank-side settlement line is real and
        // expected every month, not an unclear expense - asking about it
        // was a real false positive caught during live testing.
        if (row.transaction_type === 'bank' && isCardCompanySettlement(row.name)) continue;
        const key = row.name || 'לא מסווג';
        const entry = byName.get(key) || { description: key, total: 0 };
        entry.total += Math.abs(parseFloat(row.price));
        byName.set(key, entry);
    }
    const candidates = [...byName.values()].sort((a, b) => b.total - a.total);
    if (candidates.length === 0) {
        return { skipped: true, reason: 'nothing_unclear' };
    }

    const openRes = await pool.query(`SELECT description FROM pending_categorization_questions WHERE status = 'open'`);
    const alreadyAsked = new Set(openRes.rows.map((r) => r.description));
    const target = candidates.find((c) => !alreadyAsked.has(c.description));
    if (!target) {
        return { skipped: true, reason: 'all_candidates_already_pending' };
    }

    const { openai, model } = await getAIClient();
    const completion = await openai.chat.completions.create({
        model,
        messages: [
            { role: 'system', content: PERSONA_PROMPT + '\n\nYour task right now: ask a short, friendly one-line question in Hebrew about ONE specific unrecognized charge, asking what it was for. End with something like "מה זה?" or similar - keep it casual, one short message.' },
            { role: 'user', content: `Merchant name: ${target.description.trim()}\nAmount: ₪${Math.round(target.total)}` },
        ],
        temperature: 0.8,
        max_tokens: 1200,
    });
    const questionText = completion.choices?.[0]?.message?.content?.trim();
    if (!questionText) {
        return { skipped: true, reason: 'empty_question' };
    }

    const { sendWhatsAppMessage } = await import('./whatsapp.js');
    const sendResult = await sendWhatsAppMessage({ to: groupJid, body: questionText });
    const messageId = sendResult.results?.[0]?.messageId;
    if (!sendResult.success || !messageId) {
        return { skipped: true, reason: 'send_failed', sendResult };
    }

    await pool.query(
        `INSERT INTO pending_categorization_questions (description, amount, wa_message_id, group_jid)
         VALUES ($1, $2, $3, $4)`,
        [target.description, target.total, messageId, groupJid]
    );

    logger.info({ description: target.description, amount: target.total }, '[social-agent] Asked about unclear expense');
    return { skipped: false, description: target.description, amount: target.total, questionText };
}

export async function sendSocialAgentUpdate({ periodLabel } = {}) {
    const settingsRes = await pool.query(`SELECT key, value FROM app_settings WHERE key IN ('whatsapp_group_jid', 'whatsapp_enabled')`);
    const settings = {};
    for (const row of settingsRes.rows) settings[row.key] = row.value;

    const groupJid = typeof settings.whatsapp_group_jid === 'string' ? settings.whatsapp_group_jid.replace(/"/g, '') : null;
    const enabled = settings.whatsapp_enabled === true || settings.whatsapp_enabled === 'true';

    if (!enabled || !groupJid) {
        logger.info({ enabled, hasGroupJid: !!groupJid }, '[social-agent] Skipping - not configured');
        return { skipped: true, reason: !enabled ? 'whatsapp_disabled' : 'no_group_jid' };
    }

    const { text, facts } = await generateSocialAgentMessage({ periodLabel });
    if (!text) {
        logger.warn('[social-agent] AI returned no text - skipping send');
        return { skipped: true, reason: 'empty_message' };
    }

    const { sendWhatsAppMessage } = await import('./whatsapp.js');
    const result = await sendWhatsAppMessage({ to: groupJid, body: text });
    logger.info({ result, facts }, '[social-agent] Update sent');
    return { skipped: false, result, text };
}
