import { getDB } from '../db';
import logger from '../../../utils/logger.js';
import { getAIClient, mapAIError } from '../../../utils/aiClient.js';
import { SYSTEM_PROMPT, tools, executeFunction } from '../../../utils/aiChatCore.js';

// Verify auth for AI chat endpoint.
// If NUDLERS_API_KEY is set, require it as Authorization Bearer header.
// Otherwise, allow all requests (local-only mode).
function verifyAuth(req) {
  const requiredKey = process.env.NUDLERS_API_KEY;
  if (!requiredKey) {
    return true;
  }

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ') && authHeader.slice(7) === requiredKey) {
    return true;
  }

  return false;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!verifyAuth(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const db = await getDB();

  try {
    const { message, context, sessionId } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Resolve provider config
    let openai, model;
    try {
      ({ openai, model } = await getAIClient());
    } catch (e) {
      if (e.code === 'AI_API_KEY_MISSING') {
        return res.status(500).json({ error: e.message });
      }
      throw e;
    }

    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const sendEvent = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    let currentSessionId = sessionId;

    if (!currentSessionId) {
      const sessionResult = await db.query(
        'INSERT INTO chat_sessions (title) VALUES ($1) RETURNING id',
        [message.substring(0, 60)]
      );
      currentSessionId = sessionResult.rows[0].id;
    } else {
      await db.query('UPDATE chat_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [currentSessionId]);
    }

    await db.query(
      'INSERT INTO chat_messages (session_id, role, content) VALUES ($1, $2, $3)',
      [currentSessionId, 'user', message]
    );

    sendEvent({ status: 'session_assigned', sessionId: currentSessionId });

    // Fetch prior history (most recent 50, chronological)
    const historyResult = await db.query(
      `SELECT role, content FROM (
        SELECT id, role, content FROM chat_messages
        WHERE session_id = $1 AND role != 'system'
        ORDER BY id DESC LIMIT 50
      ) AS sub ORDER BY id ASC`,
      [currentSessionId]
    );

    // Build context appended to system prompt
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    let contextInfo = `\nToday is ${todayStr}.`;
    if (context?.view) contextInfo += ` User is viewing: ${context.view}.`;
    if (context?.dateRange) {
      contextInfo += ` Current date range filter: ${context.dateRange.startDate} to ${context.dateRange.endDate}.`;
    }

    // Build OpenAI message array. The last row in historyResult is the user message we just saved.
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT + contextInfo }
    ];
    for (const r of historyResult.rows) {
      if (!r.content || r.content.trim() === '') continue;
      const role = r.role === 'assistant' ? 'assistant' : 'user';
      messages.push({ role, content: r.content });
    }

    sendEvent({ status: 'thinking', model });

    let fullText = '';
    let iterationCount = 0;
    const MAX_ITERATIONS = 5;

    // Streaming + tool-call loop
    while (iterationCount < MAX_ITERATIONS) {
      iterationCount++;

      let stream;
      try {
        stream = await openai.chat.completions.create({
          model,
          messages,
          tools,
          temperature: 0.2,
          max_tokens: 2000,
          stream: true
        });
      } catch (err) {
        logger.error({ error: err.message, status: err.status }, 'AI request failed');
        throw err;
      }

      // Assemble streamed deltas: text chunks accumulate into fullText, tool_calls accumulate by index.
      const toolCallAccum = new Map(); // index -> { id, name, args (string) }
      let assistantText = '';

      try {
        for await (const chunk of stream) {
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta || {};

          if (delta.content) {
            assistantText += delta.content;
            fullText += delta.content;
            sendEvent({ status: 'streaming', text: fullText, done: false });
            if (res.flush) res.flush();
          }

          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              const existing = toolCallAccum.get(idx) || { id: '', name: '', args: '' };
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name = tc.function.name;
              if (tc.function?.arguments) existing.args += tc.function.arguments;
              toolCallAccum.set(idx, existing);
            }
          }
        }
      } catch (streamErr) {
        logger.error({ error: streamErr.message }, 'Stream iteration failed');
        if (fullText) break;
        throw streamErr;
      }

      // No tool calls → done
      if (toolCallAccum.size === 0) {
        break;
      }

      // Materialize the assistant turn (with tool_calls) and execute each call.
      // Some non-spec providers may omit `id` — synthesize one so tool_call_id is stable.
      const toolCalls = Array.from(toolCallAccum.entries())
        .sort(([a], [b]) => a - b)
        .map(([idx, tc]) => ({
          id: tc.id || `call_${currentSessionId}_${iterationCount}_${idx}`,
          type: 'function',
          function: { name: tc.name, arguments: tc.args || '{}' }
        }));

      messages.push({
        role: 'assistant',
        content: assistantText || null,
        tool_calls: toolCalls
      });

      logger.info({ count: toolCalls.length, names: toolCalls.map(t => t.function.name) }, 'Received tool calls');

      sendEvent({
        status: 'fetching_data',
        functions: toolCalls.map(t => t.function.name),
        message: `Analyzing: ${toolCalls.map(t => t.function.name.replace(/_/g, ' ')).join(', ')}...`
      });

      for (const tc of toolCalls) {
        let parsedArgs;
        let parseError = null;
        try {
          parsedArgs = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch (e) {
          parseError = e.message;
          logger.warn({ name: tc.function.name, args: tc.function.arguments, err: e.message }, 'Failed to parse tool args');
        }

        let toolResult;
        if (parseError) {
          // Surface parse error to the model so it can retry with valid JSON
          toolResult = { error: `Invalid JSON arguments: ${parseError}` };
        } else {
          try {
            toolResult = await executeFunction(tc.function.name, parsedArgs);
          } catch (err) {
            logger.error({ functionName: tc.function.name, error: err.message }, 'Function execution error');
            toolResult = { error: err.message };
          }
        }

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(toolResult)
        });
      }
      // Loop continues — model now has tool results and will produce final text or more tool calls.
    }

    if (iterationCount >= MAX_ITERATIONS) {
      logger.warn('AI reached max tool call iterations');
      sendEvent({
        status: 'streaming',
        text: fullText + '\n\n*(Note: I reached my limit of analysis steps for this request. Please ask for more details if needed.)*',
        done: false
      });
    }

    if (!fullText) {
      fullText = "I couldn't generate a response. Please try rephrasing your question.";
    }

    await db.query(
      'INSERT INTO chat_messages (session_id, role, content) VALUES ($1, $2, $3)',
      [currentSessionId, 'assistant', fullText]
    );

    sendEvent({
      status: 'complete',
      text: fullText,
      done: true,
      model,
      sessionId: currentSessionId
    });
  } catch (error) {
    logger.error({ error: error.message, stack: error.stack }, 'AI Chat Error');
    if (res.writableEnded) return;

    const userMessage = mapAIError(error, 'AI');

    if (!res.headersSent) {
      return res.status(500).json({ error: userMessage });
    }

    try {
      res.write(`data: ${JSON.stringify({ error: userMessage, status: 'error' })}\n\n`);
    } catch (e) {
      logger.debug({ error: e.message }, 'Failed to send SSE error event (client likely disconnected)');
    }
  } finally {
    db.release();
  }

  res.end();
}

export const config = { api: { bodyParser: true } };
