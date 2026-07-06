import OpenAI from 'openai';
import { getDB } from '../pages/api/db.js';
import logger from './logger.js';
import { unwrapSettingValue } from './settingsValue.js';

const SETTING_KEYS = [
    'ai_base_url',
    'ai_api_key',
    'ai_model',
    'ai_extra_headers',
    'gemini_api_key',
    'gemini_model'
];

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'google/gemini-2.5-flash';

function mapLegacyGeminiModel(model) {
    if (!model) return null;
    if (model.startsWith('gemini-')) return `google/${model}`;
    return model;
}

export async function getAIConfig() {
    const client = await getDB();
    try {
        const result = await client.query(
            'SELECT key, value FROM app_settings WHERE key = ANY($1::text[])',
            [SETTING_KEYS]
        );

        const map = {};
        for (const row of result.rows) {
            map[row.key] = unwrapSettingValue(row.value);
        }

        const baseURL = map.ai_base_url || process.env.AI_BASE_URL || DEFAULT_BASE_URL;
        const apiKey = map.ai_api_key
            || map.gemini_api_key
            || process.env.AI_API_KEY
            || process.env.GEMINI_API_KEY;
        const model = map.ai_model
            || process.env.AI_MODEL
            || mapLegacyGeminiModel(map.gemini_model)
            || DEFAULT_MODEL;

        let extraHeaders = {};
        if (map.ai_extra_headers) {
            try {
                extraHeaders = typeof map.ai_extra_headers === 'string'
                    ? JSON.parse(map.ai_extra_headers)
                    : map.ai_extra_headers;
                if (extraHeaders === null || typeof extraHeaders !== 'object' || Array.isArray(extraHeaders)) {
                    extraHeaders = {};
                }
            } catch (e) {
                logger.warn({ err: e.message }, 'Invalid ai_extra_headers, ignoring');
                extraHeaders = {};
            }
        }

        return { baseURL, apiKey, model, extraHeaders };
    } finally {
        client.release();
    }
}

export async function getAIClient() {
    const config = await getAIConfig();
    if (!config.apiKey) {
        const err = new Error('AI provider API key not configured. Please add it in App Settings.');
        err.code = 'AI_API_KEY_MISSING';
        throw err;
    }

    const openai = new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        defaultHeaders: Object.keys(config.extraHeaders).length > 0 ? config.extraHeaders : undefined
    });

    return { openai, model: config.model, baseURL: config.baseURL };
}

export async function generateText({ prompt, system, temperature = 0.7, maxTokens = 2000 }) {
    const { openai, model, baseURL } = await getAIClient();

    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });

    try {
        const response = await openai.chat.completions.create({
            model,
            messages,
            temperature,
            max_tokens: maxTokens
        });

        const choice = response.choices?.[0];
        const text = choice?.message?.content || '';
        const finishReason = choice?.finish_reason;

        logger.info({
            baseURL,
            model: response.model || model,
            finishReason,
            textLength: text.length
        }, 'AI text generated');

        if (!text) {
            const reasons = {
                content_filter: 'Response was blocked by the provider content filter.',
                length: 'Response was truncated by the model max_tokens limit before producing any content.',
                stop: 'Provider returned an empty response.'
            };
            const detail = reasons[finishReason] || `Provider returned no content (finish_reason: ${finishReason || 'unknown'}).`;
            const err = new Error(detail);
            err.code = 'AI_EMPTY_RESPONSE';
            throw err;
        }

        return {
            text,
            finishReason,
            model: response.model || model
        };
    } catch (error) {
        logger.error({ baseURL, model, error: error.message, code: error.code }, 'AI text generation failed');
        throw error;
    }
}

/**
 * Map provider error messages to a user-friendly string.
 * Works across OpenRouter / OpenAI / Anthropic-via-proxy / etc. by inspecting
 * standard fields that most OpenAI-compatible providers expose.
 */
export function mapAIError(error, model) {
    const status = error?.status || error?.response?.status;
    const message = error?.message || '';
    const lower = message.toLowerCase();

    if (status === 401 || lower.includes('invalid api key') || lower.includes('api_key_invalid')) {
        return 'Invalid API key. Please check your AI provider API key in settings.';
    }
    if (status === 402 || lower.includes('insufficient_quota') || lower.includes('insufficient credit')) {
        return 'Insufficient credits with your AI provider. Please top up.';
    }
    if (status === 429 || lower.includes('rate limit') || lower.includes('quota')) {
        return 'Rate limit or quota exceeded. Please try again later or check your provider billing.';
    }
    if (status === 404 || lower.includes('model_not_found') || lower.includes('not found')) {
        return `Model "${model}" not found. Verify the model slug is correct for your provider.`;
    }
    if (lower.includes('safety') || lower.includes('content_filter') || lower.includes('blocked')) {
        return 'Response was blocked by content filters. Please try rephrasing your question.';
    }
    // Do not leak raw provider error messages to clients (see CLAUDE.md).
    return 'Failed to get AI response. Please check your provider settings or try again.';
}
