import { getDB } from '../pages/api/db.js';
import logger from './logger.js';
import { runChatTurn, SYSTEM_PROMPT } from './aiChatCore.js';
import { telegramProvider } from './messaging/telegramProvider.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const LONG_POLL_TIMEOUT_S = 30;
const IDLE_RECHECK_MS = 30_000;
const ERROR_BACKOFF_MS = 5_000;

async function loadTelegramSettings(client) {
  const result = await client.query(
    `SELECT key, value FROM app_settings
     WHERE key IN ('telegram_enabled', 'telegram_bot_token', 'telegram_to', 'telegram_update_offset', 'telegram_chat_session_id')`
  );
  const settings = {};
  for (const row of result.rows) {
    settings[row.key] = typeof row.value === 'string' ? row.value.replace(/^"|"$/g, '') : row.value;
  }
  return settings;
}

async function saveSetting(client, key, value) {
  await client.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(String(value))]
  );
}

async function getOrCreateTelegramSession(client, existingId) {
  if (existingId) {
    const check = await client.query('SELECT id FROM chat_sessions WHERE id = $1', [existingId]);
    if (check.rows.length > 0) return existingId;
  }
  const created = await client.query(
    `INSERT INTO chat_sessions (title) VALUES ('Telegram') RETURNING id`
  );
  const newId = created.rows[0].id;
  await saveSetting(client, 'telegram_chat_session_id', newId);
  return newId;
}

async function handleIncomingMessage(client, sessionId, text) {
  await client.query(
    'INSERT INTO chat_messages (session_id, role, content) VALUES ($1, $2, $3)',
    [sessionId, 'user', text]
  );

  const historyResult = await client.query(
    `SELECT role, content FROM (
      SELECT id, role, content FROM chat_messages
      WHERE session_id = $1 AND role != 'system'
      ORDER BY id DESC LIMIT 50
    ) AS sub ORDER BY id ASC`,
    [sessionId]
  );

  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const messages = [
    { role: 'system', content: `${SYSTEM_PROMPT}\nToday is ${todayStr}. You are being reached via Telegram - keep replies concise enough for a chat message.` }
  ];
  for (const r of historyResult.rows) {
    if (!r.content || r.content.trim() === '') continue;
    messages.push({ role: r.role === 'assistant' ? 'assistant' : 'user', content: r.content });
  }

  const replyText = await runChatTurn(messages);

  await client.query(
    'INSERT INTO chat_messages (session_id, role, content) VALUES ($1, $2, $3)',
    [sessionId, 'assistant', replyText]
  );

  return replyText;
}

async function pollOnce(state) {
  const client = await getDB();
  try {
    const settings = await loadTelegramSettings(client);

    if (!settings.telegram_enabled || settings.telegram_enabled === 'false' || !settings.telegram_bot_token || !settings.telegram_to) {
      return { idle: true };
    }

    const offset = settings.telegram_update_offset ? parseInt(settings.telegram_update_offset, 10) + 1 : 0;
    const url = `${TELEGRAM_API_BASE}/bot${encodeURIComponent(settings.telegram_bot_token)}/getUpdates?timeout=${LONG_POLL_TIMEOUT_S}&offset=${offset}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), (LONG_POLL_TIMEOUT_S + 10) * 1000);
    let data;
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      data = await res.json();
    } finally {
      clearTimeout(timer);
    }

    if (!data?.ok) {
      logger.warn({ description: data?.description }, '[telegram-listener] getUpdates failed');
      return { idle: false };
    }

    const updates = data.result || [];
    if (updates.length === 0) return { idle: false };

    let maxUpdateId = offset - 1;
    let sessionId = settings.telegram_chat_session_id ? parseInt(settings.telegram_chat_session_id, 10) : null;

    for (const update of updates) {
      maxUpdateId = Math.max(maxUpdateId, update.update_id);

      const message = update.message;
      const text = message?.text;
      const chatId = message?.chat?.id;

      if (!message || !text) continue;

      if (String(chatId) !== String(settings.telegram_to)) {
        logger.warn({ chatId }, '[telegram-listener] Ignoring message from unauthorized chat');
        continue;
      }

      try {
        sessionId = await getOrCreateTelegramSession(client, sessionId);
        logger.info({ sessionId }, '[telegram-listener] Processing incoming message');
        const replyText = await handleIncomingMessage(client, sessionId, text);
        await telegramProvider.send({ body: replyText }, settings);
      } catch (err) {
        logger.error({ error: err.message }, '[telegram-listener] Failed to process message');
        try {
          await telegramProvider.send({ body: `⚠️ Error processing your message: ${err.message}` }, settings);
        } catch { /* best-effort - don't let a failed error-notice crash the loop */ }
      }
    }

    await saveSetting(client, 'telegram_update_offset', maxUpdateId);
    return { idle: false };
  } finally {
    client.release();
  }
}

/**
 * Starts the long-polling loop for incoming Telegram messages. Fire-and-forget -
 * intended to be called once at server startup and left running for the
 * lifetime of the process. Never throws; all errors are caught and logged so
 * one bad iteration can't kill the listener.
 */
export async function startTelegramListener() {
  logger.info('[telegram-listener] Starting long-poll listener');
  const state = {};
  while (true) {
    try {
      const result = await pollOnce(state);
      if (result.idle) {
        await new Promise((resolve) => setTimeout(resolve, IDLE_RECHECK_MS));
      }
    } catch (err) {
      logger.error({ error: err.message }, '[telegram-listener] Poll iteration failed, backing off');
      await new Promise((resolve) => setTimeout(resolve, ERROR_BACKOFF_MS));
    }
  }
}
