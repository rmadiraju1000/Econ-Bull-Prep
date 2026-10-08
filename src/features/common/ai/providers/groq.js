// Groq provider: OpenAI-compatible API with very fast inference.
// Docs: https://console.groq.com/docs/models  Keys: https://console.groq.com/keys

const BASE_URL = 'https://api.groq.com/openai/v1';

class GroqProvider {
    static async validateApiKey(key) {
        if (!key || typeof key !== 'string') {
            return { success: false, error: 'Invalid Groq API key format.' };
        }
        try {
            const response = await fetch(`${BASE_URL}/models`, {
                headers: { Authorization: `Bearer ${key}` },
            });
            if (response.ok) return { success: true };
            const errorData = await response.json().catch(() => ({}));
            return { success: false, error: errorData.error?.message || `Validation failed with status: ${response.status}` };
        } catch (error) {
            console.error('[GroqProvider] Network error during key validation:', error);
            return { success: false, error: 'A network error occurred during validation.' };
        }
    }
}

// Which chat models this key can actually use. Model availability differs by
// account and changes over time, so ask Groq instead of hard-coding one ID.
const PREFERRED_LIVE_MODELS = [
    'llama-3.3-70b-versatile',
    'openai/gpt-oss-20b',
    'openai/gpt-oss-120b',
    'llama-3.1-8b-instant',
];
const NON_CHAT = /whisper|tts|orpheus|guard|playai|distil|compound|allam/i;
let modelCache = { key: null, at: 0, ids: [] };

async function listModels(apiKey) {
    if (modelCache.key === apiKey && Date.now() - modelCache.at < 30 * 60 * 1000 && modelCache.ids.length) {
        return modelCache.ids;
    }
    const res = await fetch(`${BASE_URL}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) throw new Error(`Groq models ${res.status}`);
    const json = await res.json();
    const ids = (json.data || [])
        .filter(m => m.active !== false && !NON_CHAT.test(m.id))
        .map(m => m.id);
    modelCache = { key: apiKey, at: Date.now(), ids };
    console.log(`[GroqProvider] Models available to this key: ${ids.join(', ')}`);
    return ids;
}

/**
 * Best available chat models for live answers, in preference order.
 * Falls back to whatever chat models the key has if none of the preferred ones exist.
 */
async function liveModels(apiKey, preferred) {
    let ids = [];
    try {
        ids = await listModels(apiKey);
    } catch (e) {
        console.warn('[GroqProvider] Could not list models:', e.message);
        return preferred ? [preferred, ...PREFERRED_LIVE_MODELS] : PREFERRED_LIVE_MODELS;
    }
    const order = [preferred, ...PREFERRED_LIVE_MODELS].filter(Boolean);
    const picked = order.filter((m, i) => ids.includes(m) && order.indexOf(m) === i);
    const others = ids.filter(m => !picked.includes(m));
    return [...picked, ...others];
}

// Groq's text models don't take images: keep only the text parts.
function toTextMessages(messages) {
    return messages.map(m => {
        if (!Array.isArray(m.content)) return { role: m.role, content: m.content };
        const text = m.content
            .map(p => (typeof p === 'string' ? p : p.type === 'text' ? p.text : ''))
            .filter(Boolean)
            .join('\n');
        return { role: m.role, content: text };
    });
}

// gpt-oss models reason before answering; keep that minimal and hidden for speed.
function extraParams(model, reasoningEffort) {
    return /gpt-oss/.test(model) ? { reasoning_effort: reasoningEffort || 'low', reasoning_format: 'hidden' } : {};
}

function buildBody({ model, messages, temperature, maxTokens, stream, reasoningEffort }) {
    return JSON.stringify({
        model,
        messages: toTextMessages(messages),
        temperature,
        max_tokens: maxTokens,
        stream,
        ...extraParams(model, reasoningEffort),
    });
}

async function groqFetch(apiKey, body, signal) {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body,
        signal,
    });
    if (!response.ok) {
        const msg = await response.text().catch(() => '');
        throw new Error(`Groq ${response.status}: ${msg.slice(0, 300)}`);
    }
    return response;
}

function createLLM({ apiKey, model = 'llama-3.3-70b-versatile', temperature = 0.7, maxTokens = 2048 }) {
    const chat = async messages => {
        const res = await groqFetch(apiKey, buildBody({ model, messages, temperature, maxTokens, stream: false }));
        const json = await res.json();
        return { content: json.choices?.[0]?.message?.content || '', raw: json };
    };
    return {
        chat,
        generateContent: async parts => {
            const text = parts.filter(p => typeof p === 'string').join('\n');
            const result = await chat([{ role: 'user', content: text }]);
            return { response: { text: () => result.content } };
        },
    };
}

function createStreamingLLM({ apiKey, model = 'llama-3.3-70b-versatile', temperature = 0.7, maxTokens = 2048, reasoningEffort }) {
    return {
        // Returns an OpenAI-style SSE Response (same shape the other providers return).
        streamChat: async (messages, signal) =>
            groqFetch(apiKey, buildBody({ model, messages, temperature, maxTokens, stream: true, reasoningEffort }), signal),
    };
}

module.exports = { GroqProvider, createLLM, createStreamingLLM, listModels, liveModels };
