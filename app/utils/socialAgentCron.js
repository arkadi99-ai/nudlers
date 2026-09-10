import logger from './logger.js';

const WEEKLY_LAST_SENT_KEY = 'social_agent_last_sent_week';
const MONTHLY_LAST_SENT_KEY = 'social_agent_last_sent_month';
const CATEGORIZATION_QUESTION_LAST_SENT_KEY = 'categorization_question_last_sent';
const MIN_DAYS_BETWEEN_CATEGORIZATION_QUESTIONS = 3;

function isoWeekLabel(d) {
    const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const weekNum = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return `${date.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function monthLabel(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const PENDING_QUESTION_EXPIRY_DAYS = 14;

async function expireStalePendingQuestions({ client }) {
    const res = await client.query(
        `UPDATE pending_categorization_questions
         SET status = 'expired'
         WHERE status = 'open' AND created_at < NOW() - INTERVAL '${PENDING_QUESTION_EXPIRY_DAYS} days'`
    );
    if (res.rowCount > 0) {
        logger.info({ count: res.rowCount }, '[social-agent-cron] Expired stale pending categorization questions');
    }
}

async function maybeAskCategorizationQuestion({ client }) {
    const res = await client.query(`SELECT value FROM app_settings WHERE key = $1`, [CATEGORIZATION_QUESTION_LAST_SENT_KEY]);
    const lastSentRaw = res.rows.length > 0 ? String(res.rows[0].value).replace(/"/g, '') : null;
    const lastSent = lastSentRaw ? new Date(lastSentRaw) : null;
    const daysSince = lastSent ? (Date.now() - lastSent.getTime()) / 86400000 : Infinity;
    if (daysSince < MIN_DAYS_BETWEEN_CATEGORIZATION_QUESTIONS) {
        return { ran: false, reason: 'too_soon' };
    }

    const { askAboutNextUnclearExpense } = await import('./socialAgent.js');
    const outcome = await askAboutNextUnclearExpense();

    if (!outcome.skipped) {
        await client.query(
            `INSERT INTO app_settings (key, value) VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP`,
            [CATEGORIZATION_QUESTION_LAST_SENT_KEY, JSON.stringify(new Date().toISOString())]
        );
    }

    return { ran: true, outcome };
}

async function runIfDue({ settingKey, currentLabel, periodLabel, client }) {
    const res = await client.query(`SELECT value FROM app_settings WHERE key = $1`, [settingKey]);
    const lastSent = res.rows.length > 0 ? String(res.rows[0].value).replace(/"/g, '') : null;
    if (lastSent === currentLabel) {
        return { ran: false, reason: 'already_sent_this_period' };
    }

    const { sendSocialAgentUpdate } = await import('./socialAgent.js');
    const outcome = await sendSocialAgentUpdate({ periodLabel });

    if (!outcome.skipped) {
        await client.query(
            `INSERT INTO app_settings (key, value) VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP`,
            [settingKey, JSON.stringify(currentLabel)]
        );
    }

    return { ran: true, outcome };
}

/**
 * Schedules the family WhatsApp-group social agent: a weekly update (Sunday
 * mornings) and a monthly one (the 1st). Both check-and-run hourly rather
 * than firing at an exact cron minute - matching the existing daily-summary
 * cron's pattern - so a missed hour (container restart, etc.) doesn't skip
 * the whole week/month; it just runs a bit late next time the hourly check
 * fires. Guarded by `whatsapp_enabled` + `whatsapp_group_jid` inside
 * sendSocialAgentUpdate() itself, so this scheduler stays dumb on purpose.
 */
export async function initSocialAgentCron() {
    const cron = await import('node-cron');
    let running = false;

    cron.default.schedule('0 * * * *', async () => {
        if (running) return;
        running = true;
        try {
            const now = new Date();
            const { getDB } = await import('../pages/api/db.js');
            const client = await getDB();
            try {
                // Weekly: only after Sunday 9am local.
                if (now.getDay() === 0 && now.getHours() >= 9) {
                    const weekly = await runIfDue({
                        settingKey: WEEKLY_LAST_SENT_KEY,
                        currentLabel: isoWeekLabel(now),
                        periodLabel: 'weekly',
                        client,
                    });
                    if (weekly.ran) logger.info({ weekly }, '[social-agent-cron] Weekly check');
                }
                // Monthly: only on the 1st, after 9am local.
                if (now.getDate() === 1 && now.getHours() >= 9) {
                    const monthly = await runIfDue({
                        settingKey: MONTHLY_LAST_SENT_KEY,
                        currentLabel: monthLabel(now),
                        periodLabel: 'monthly',
                        client,
                    });
                    if (monthly.ran) logger.info({ monthly }, '[social-agent-cron] Monthly check');
                }
                await expireStalePendingQuestions({ client });

                // Categorization question: checked every hour during
                // reasonable daytime hours, internally rate-limited (min 3
                // days apart) - gentle, not spammy, never a 3am ping.
                if (now.getHours() >= 9 && now.getHours() <= 20) {
                    const categorization = await maybeAskCategorizationQuestion({ client });
                    if (categorization.ran) logger.info({ categorization }, '[social-agent-cron] Categorization question check');
                }
            } finally {
                client.release();
            }
        } catch (error) {
            logger.error({ error: error.message, stack: error.stack }, '[social-agent-cron] Failed');
        } finally {
            running = false;
        }
    });

    logger.info('[startup] Social agent cron initialized (weekly Sundays, monthly on the 1st, both ~9am)');
}
