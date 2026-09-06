import { pool } from '../pages/api/db.js';
import logger from './logger.js';
import { getAIClient } from './aiClient.js';
import { updateCategoryByDescription } from './categorization.js';

const EXTRACT_CATEGORY_PROMPT = `You extract a short spending category from a casual reply in a family WhatsApp chat, answering "what was this charge for?". Reply with ONLY the category name (2-4 words, no punctuation, no explanation, in the same language the reply used). If the reply doesn't actually say what the expense was for (e.g. "who is this", "not now", a joke, an emoji), reply with exactly: UNCLEAR`;

async function extractCategoryFromReply(replyText) {
    const { openai, model } = await getAIClient();
    const completion = await openai.chat.completions.create({
        model,
        messages: [
            { role: 'system', content: EXTRACT_CATEGORY_PROMPT },
            { role: 'user', content: replyText },
        ],
        temperature: 0.2,
        max_tokens: 300,
    });
    const text = completion.choices?.[0]?.message?.content?.trim();
    if (!text || text.toUpperCase().includes('UNCLEAR')) return null;
    return text;
}

/**
 * Handles ONE incoming WhatsApp message. Only acts when it's a direct
 * quote-reply (WhatsApp's own reply-to-message feature) to a message ID we
 * ourselves recorded as an open pending question - every other message in
 * the group (normal family chat, replies to something else) is ignored
 * immediately, cheaply, before any DB or AI call.
 */
export async function handleIncomingGroupMessage(msg) {
    try {
        const remoteJid = msg.key?.remoteJid;
        if (!remoteJid || !remoteJid.endsWith('@g.us')) return; // groups only
        if (msg.key?.fromMe) return; // ignore our own sent messages

        const quotedId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
        if (!quotedId) return; // not a reply to anything

        const replyText = (msg.message?.extendedTextMessage?.text || msg.message?.conversation || '').trim();
        if (!replyText) return;

        const pendingRes = await pool.query(
            `SELECT id, description FROM pending_categorization_questions WHERE wa_message_id = $1 AND status = 'open'`,
            [quotedId]
        );
        if (pendingRes.rows.length === 0) return; // not a reply to one of our questions

        const pending = pendingRes.rows[0];
        const category = await extractCategoryFromReply(replyText);

        if (!category) {
            logger.info({ pendingId: pending.id, replyText }, '[whatsapp-categorization] Reply was unclear - leaving question open');
            return;
        }

        const client = await pool.connect();
        try {
            await updateCategoryByDescription(client, { description: pending.description, newCategory: category, createRule: true });
            await client.query(
                `UPDATE pending_categorization_questions
                 SET status = 'answered', answer_text = $2, resolved_category = $3, answered_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [pending.id, replyText, category]
            );
        } finally {
            client.release();
        }

        const { sendWhatsAppMessage } = await import('./whatsapp.js');
        await sendWhatsAppMessage({ to: remoteJid, body: `מעולה, סיווגתי את "${pending.description.trim()}" בתור "${category}" ✅` })
            .catch((err) => logger.warn({ err: err.message }, '[whatsapp-categorization] Confirmation send failed (categorization itself already succeeded)'));

        logger.info({ pendingId: pending.id, category }, '[whatsapp-categorization] Resolved via group reply');
    } catch (error) {
        // A single malformed/unexpected message must never take down the
        // socket's event loop - log and move on.
        logger.error({ error: error.message, stack: error.stack }, '[whatsapp-categorization] Failed to handle incoming message');
    }
}
