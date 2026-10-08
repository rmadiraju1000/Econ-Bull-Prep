// Low-latency streaming answers for Listen mode.
//
// Gemini: calls the REST streaming endpoint directly so we can turn "thinking"
// off (thinking adds seconds before the first token on Gemini 3.x) and stream
// tokens to the UI as they arrive. Other providers fall back to the existing
// OpenAI-style streaming handlers.

const { createStreamingLLM } = require('../../common/ai/factory');

// Gemini 3.x uses thinkingLevel, 2.5 uses thinkingBudget. Try the fastest
// setting first and remember which variant the API accepted.
const GEMINI_THINKING_VARIANTS = [
    { thinkingConfig: { thinkingLevel: 'minimal' } },
    { thinkingConfig: { thinkingBudget: 0 } },
    {},
];
let geminiVariantIndex = 0;

async function* readSSE(response, signal) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        while (true) {
            if (signal?.aborted) return;
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, idx).trim();
                buffer = buffer.slice(idx + 1);
                if (line.startsWith('data:')) yield line.slice(5).trim();
            }
        }
        if (buffer.trim().startsWith('data:')) yield buffer.trim().slice(5).trim();
    } finally {
        try { reader.releaseLock(); } catch (_) {}
    }
}

async function streamGemini({ apiKey, model, system, user, temperature, maxTokens, signal, onDelta }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;

    for (let i = geminiVariantIndex; i < GEMINI_THINKING_VARIANTS.length; i++) {
        const body = {
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: user }] }],
            generationConfig: { temperature, maxOutputTokens: maxTokens, ...GEMINI_THINKING_VARIANTS[i] },
        };
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify(body),
            signal,
        });

        if (res.status === 400 && i < GEMINI_THINKING_VARIANTS.length - 1) {
            // This model doesn't accept that thinking setting; try the next one.
            const msg = await res.text().catch(() => '');
            console.warn(`[FastAnswer] Gemini rejected thinking variant ${i}: ${msg.slice(0, 200)}`);
            continue;
        }
        if (!res.ok) {
            const msg = await res.text().catch(() => '');
            throw new Error(`Gemini ${res.status}: ${msg.slice(0, 300)}`);
        }

        geminiVariantIndex = i;
        let full = '';
        for await (const data of readSSE(res, signal)) {
            if (!data || data === '[DONE]') continue;
            let json;
            try { json = JSON.parse(data); } catch (_) { continue; }
            const parts = json?.candidates?.[0]?.content?.parts || [];
            for (const p of parts) {
                if (p.thought || !p.text) continue; // skip any thinking text
                full += p.text;
                onDelta(full);
            }
        }
        return full;
    }
    throw new Error('Gemini request failed');
}

async function streamOpenAIStyle({ provider, apiKey, model, system, user, temperature, maxTokens, reasoningEffort, signal, onDelta }) {
    const llm = createStreamingLLM(provider, {
        apiKey,
        model,
        temperature,
        maxTokens,
        reasoningEffort,
        usePortkey: provider === 'openai-glass',
        portkeyVirtualKey: provider === 'openai-glass' ? apiKey : undefined,
    });
    const response = await llm.streamChat(
        [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ],
        signal
    );
    let full = '';
    for await (const data of readSSE(response, signal)) {
        if (!data || data === '[DONE]') continue;
        let json;
        try { json = JSON.parse(data); } catch (_) { continue; }
        const delta = json?.choices?.[0]?.delta?.content;
        if (delta) {
            full += delta;
            onDelta(full);
        }
    }
    return full;
}

/**
 * Streams an answer. Calls onDelta(fullTextSoFar) as tokens arrive.
 * Resolves with the complete text. Abort with the provided signal.
 */
async function streamAnswer({ provider, apiKey, model, system, user, temperature = 0.3, maxTokens = 300, reasoningEffort, signal, onDelta }) {
    if (provider === 'gemini') {
        return streamGemini({ apiKey, model, system, user, temperature, maxTokens, signal, onDelta });
    }
    return streamOpenAIStyle({ provider, apiKey, model, system, user, temperature, maxTokens, reasoningEffort, signal, onDelta });
}

module.exports = { streamAnswer };
