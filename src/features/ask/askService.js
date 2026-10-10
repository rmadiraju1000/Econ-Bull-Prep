const { BrowserWindow } = require('electron');
const { createStreamingLLM } = require('../common/ai/factory');
// Lazy require helper to avoid circular dependency issues
const getWindowManager = () => require('../../window/windowManager');
const internalBridge = require('../../bridge/internalBridge');

const getWindowPool = () => {
    try {
        return getWindowManager().windowPool;
    } catch {
        return null;
    }
};

const sessionRepository = require('../common/repositories/session');
const askRepository = require('./repositories');
const { getSystemPrompt } = require('../common/prompts/promptBuilder');
const path = require('node:path');
const fs = require('node:fs');
const os = require('os');
const util = require('util');
const execFile = util.promisify(require('child_process').execFile);
const { desktopCapturer } = require('electron');
const modelStateService = require('../common/services/modelStateService');
const { streamAnswer } = require('../listen/summary/fastAnswer');
const groqProvider = require('../common/ai/providers/groq');
const { recognizeText } = require('./ocr');

// Try to load sharp, but don't fail if it's not available
let sharp;
try {
    sharp = require('sharp');
    console.log('[AskService] Sharp module loaded successfully');
} catch (error) {
    console.warn('[AskService] Sharp module not available:', error.message);
    console.warn('[AskService] Screenshot functionality will work with reduced image processing capabilities');
    sharp = null;
}
let lastScreenshot = null;
let pendingScreenshot = null; // { promise, startedAt }

/** Start grabbing the screen now (e.g. when the Ask box opens) so it's ready when you hit Enter. */
function prefetchScreenshot() {
    const startedAt = Date.now();
    const promise = captureScreenshot().catch(e => ({ success: false, error: e.message }));
    pendingScreenshot = { promise, startedAt };
    return promise;
}

/** Use a screenshot taken in the last 20 s if there is one, otherwise take a fresh one. */
async function getScreenshotFast() {
    if (pendingScreenshot && Date.now() - pendingScreenshot.startedAt < 20000) {
        const r = await pendingScreenshot.promise;
        pendingScreenshot = null;
        if (r?.success) return { ...r, prefetched: true };
    }
    pendingScreenshot = null;
    return captureScreenshot();
}

const ASK_SYSTEM_PROMPT = [
    'You are a fast study helper. You see the user\'s screen (screenshot) and recent call/video transcript.',
    'Answer the question on the screen or the user\'s request IMMEDIATELY.',
    'Format: first line = the answer in bold (a few words or one sentence). Then at most 3 short bullets with the key reasoning or steps.',
    'For multiple choice, give the letter and the option text. For math, show the key steps briefly and the final number.',
    'Economics: get directions right (which curve shifts, left/right), use the correct term. No preamble, no restating the question, under 120 words.',
].join('\n');
const ASK_FIRST_TOKEN_TIMEOUT_MS = 6000;
const ASK_HEDGE_AFTER_MS = 2000; // start a backup model if the first one hasn't started answering yet

async function captureScreenshot(options = {}) {
    if (process.platform === 'darwin') {
        try {
            const tempPath = path.join(os.tmpdir(), `screenshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`);

            await execFile('screencapture', ['-x', '-t', 'jpg', tempPath]);

            const imageBuffer = await fs.promises.readFile(tempPath);
            // Read the screen's text on-device in parallel, then delete the file.
            const ocr = recognizeText(tempPath).finally(() => fs.promises.unlink(tempPath).catch(() => {}));

            if (sharp) {
                try {
                    // Try using sharp for optimal image processing
                    const resizedBuffer = await sharp(imageBuffer)
                        // 384px tall was too small to read questions on screen; 1280 wide keeps text legible.
                        .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
                        .jpeg({ quality: 72 })
                        .toBuffer();

                    const base64 = resizedBuffer.toString('base64');
                    const metadata = await sharp(resizedBuffer).metadata();

                    lastScreenshot = {
                        base64,
                        width: metadata.width,
                        height: metadata.height,
                        timestamp: Date.now(),
                    };

                    return { success: true, base64, width: metadata.width, height: metadata.height, ocr };
                } catch (sharpError) {
                    console.warn('Sharp module failed, falling back to basic image processing:', sharpError.message);
                }
            }
            
            // Fallback: Return the original image without resizing
            console.log('[AskService] Using fallback image processing (no resize/compression)');
            const base64 = imageBuffer.toString('base64');
            
            lastScreenshot = {
                base64,
                width: null, // We don't have metadata without sharp
                height: null,
                timestamp: Date.now(),
            };

            return { success: true, base64, width: null, height: null, ocr };
        } catch (error) {
            console.error('Failed to capture screenshot:', error);
            return { success: false, error: error.message };
        }
    }

    try {
        const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: {
                width: 1920,
                height: 1080,
            },
        });

        if (sources.length === 0) {
            throw new Error('No screen sources available');
        }
        const source = sources[0];
        const buffer = source.thumbnail.toJPEG(70);
        const base64 = buffer.toString('base64');
        const size = source.thumbnail.getSize();

        return {
            success: true,
            base64,
            width: size.width,
            height: size.height,
        };
    } catch (error) {
        console.error('Failed to capture screenshot using desktopCapturer:', error);
        return {
            success: false,
            error: error.message,
        };
    }
}

/**
 * @class
 * @description
 */
class AskService {
    constructor() {
        this.abortController = null;
        this.state = {
            isVisible: false,
            isLoading: false,
            isStreaming: false,
            currentQuestion: '',
            currentResponse: '',
            showTextInput: true,
        };
        console.log('[AskService] Service instance created.');
    }

    _broadcastState() {
        const askWindow = getWindowPool()?.get('ask');
        if (askWindow && !askWindow.isDestroyed()) {
            askWindow.webContents.send('ask:stateUpdate', this.state);
        }
    }

    async toggleAskButton(inputScreenOnly = false) {
        const askWindow = getWindowPool()?.get('ask');

        let shouldSendScreenOnly = false;
        if (!(askWindow && askWindow.isVisible())) prefetchScreenshot(); // grab the screen while you type
        if (inputScreenOnly && this.state.showTextInput && askWindow && askWindow.isVisible()) {
            shouldSendScreenOnly = true;
            await this.sendMessage('', []);
            return;
        }

        const hasContent = this.state.isLoading || this.state.isStreaming || (this.state.currentResponse && this.state.currentResponse.length > 0);

        if (askWindow && askWindow.isVisible() && hasContent) {
            this.state.showTextInput = !this.state.showTextInput;
            this._broadcastState();
        } else {
            if (askWindow && askWindow.isVisible()) {
                internalBridge.emit('window:requestVisibility', { name: 'ask', visible: false });
                this.state.isVisible = false;
            } else {
                console.log('[AskService] Showing hidden Ask window');
                internalBridge.emit('window:requestVisibility', { name: 'ask', visible: true });
                this.state.isVisible = true;
            }
            if (this.state.isVisible) {
                this.state.showTextInput = true;
                this._broadcastState();
            }
        }
    }

    async closeAskWindow () {
            if (this.abortController) {
                this.abortController.abort('Window closed by user');
                this.abortController = null;
            }
    
            this.state = {
                isVisible      : false,
                isLoading      : false,
                isStreaming    : false,
                currentQuestion: '',
                currentResponse: '',
                showTextInput  : true,
            };
            this._broadcastState();
    
            internalBridge.emit('window:requestVisibility', { name: 'ask', visible: false });
    
            return { success: true };
        }
    

    /**
     * 
     * @param {string[]} conversationTexts
     * @returns {string}
     * @private
     */
    _formatConversationForPrompt(conversationTexts) {
        if (!conversationTexts || conversationTexts.length === 0) {
            return 'No conversation history available.';
        }
        return conversationTexts.slice(-30).join('\n');
    }

    /**
     * 
     * @param {string} userPrompt
     * @returns {Promise<{success: boolean, response?: string, error?: string}>}
     */
    async sendMessage(userPrompt, conversationHistoryRaw=[]) {
        internalBridge.emit('window:requestVisibility', { name: 'ask', visible: true });
        this.state = {
            ...this.state,
            isLoading: true,
            isStreaming: false,
            currentQuestion: userPrompt,
            currentResponse: '',
            showTextInput: false,
        };
        this._broadcastState();

        if (this.abortController) {
            this.abortController.abort('New request received.');
        }
        this.abortController = new AbortController();
        const { signal } = this.abortController;


        let sessionId;

        try {
            console.log(`[AskService] 🤖 Processing message: ${userPrompt.substring(0, 50)}...`);

            const t0 = Date.now();
            // Screenshot (usually already taken when the Ask box opened) and model list in parallel.
            const [shot, imageModels, textModel] = await Promise.all([getScreenshotFast(), this._askModels(), this._textModel()]);
            const screenshotBase64 = shot?.success ? shot.base64 : null;
            console.log(`⏱ [AskService] Screenshot ready in ${Date.now() - t0}ms${shot?.prefetched ? ' (taken when Ask opened)' : ''}${shot?.width ? ` ${shot.width}x${shot.height}` : ''}`);
            // On-device text recognition (usually already done while you typed); don't wait more than 1.5 s for it.
            const screenText = shot?.ocr ? await Promise.race([shot.ocr, new Promise(r => setTimeout(() => r(''), 1500))]) : '';
            console.log(`⏱ [AskService] Screen text ready in ${Date.now() - t0}ms (${screenText.length} chars)`);

            // Save to the database in the background (it used to add ~0.5 s before answering).
            const sessionPromise = sessionRepository
                .getOrCreateActive('ask')
                .then(id => askRepository.addAiMessage({ sessionId: id, role: 'user', content: userPrompt.trim() }).then(() => id))
                .catch(e => console.error('[AskService] DB save failed:', e.message));

            const transcript = this._formatConversationForPrompt(conversationHistoryRaw);
            const request = userPrompt.trim() || 'Answer the question shown on my screen.';
            const user =
                `Recent transcript (may be empty or messy):\n${transcript.slice(-2500)}\n\n` +
                `User request: ${request}` +
                (screenshotBase64 ? '' : '\n(No screenshot available.)');

            // Groq reads the recognized text (fastest); Gemini looks at the picture. Both start together.
            const models = [];
            if (textModel && screenText.length >= 15) {
                models.push({
                    ...textModel,
                    noImage: true,
                    user:
                        `Recent transcript (may be empty or messy):\n${transcript.slice(-2000)}\n\n` +
                        `Text on the user's screen (from OCR, top to bottom; layout may be lost):\n${screenText.slice(0, 6000)}\n\n` +
                        `User request: ${request}`,
                    launchWithNext: true,
                });
            }
            if (screenshotBase64) models.push(...imageModels);
            else if (textModel && !models.length) models.push({ ...textModel, noImage: true });
            if (!models.length) throw new Error('AI model or API key not configured.');

            const full = await this._raceModels({ models, user, imageBase64: screenshotBase64, signal, startedAt: t0 });
            if (signal.aborted) return { success: false, error: 'aborted' };

            this.state = { ...this.state, isLoading: false, isStreaming: false, currentResponse: full };
            this._broadcastState();
            console.log(`⚡ [AskService] Answer finished in ${Date.now() - t0}ms`);
            sessionPromise.then(id => id && full && askRepository.addAiMessage({ sessionId: id, role: 'assistant', content: full }).catch(() => {}));
            return { success: true };

        } catch (error) {
            console.error('[AskService] Error during message processing:', error);
            this.state = {
                ...this.state,
                isLoading: false,
                isStreaming: false,
                showTextInput: true,
            };
            this._broadcastState();

            const askWin = getWindowPool()?.get('ask');
            if (askWin && !askWin.isDestroyed()) {
                const streamError = error.message || 'Unknown error occurred';
                askWin.webContents.send('ask-response-stream-error', { error: streamError });
            }

            return { success: false, error: error.message };
        }
    }

    /**
     * 
     * @param {ReadableStreamDefaultReader} reader
     * @param {BrowserWindow} askWin
     * @param {number} sessionId 
     * @param {AbortSignal} signal
     * @returns {Promise<void>}
     * @private
     */
    /** Fast Groq text model for answering from the screen's recognized text. */
    async _textModel() {
        const keys = (await modelStateService.getAllApiKeys().catch(() => ({}))) || {};
        if (!keys.groq) return null;
        let ids = [];
        try {
            ids = await groqProvider.listModels(keys.groq);
        } catch (_) {
            ids = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'];
        }
        const model = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'].find(m => ids.includes(m)) || ids[0];
        return model ? { provider: 'groq', apiKey: keys.groq, model } : null;
    }

    /** Vision-capable models to try, fastest first. */
    async _askModels() {
        const list = [];
        const add = (provider, apiKey, model) => {
            if (apiKey && model && !list.some(m => m.provider === provider && m.model === model)) list.push({ provider, apiKey, model });
        };
        const keys = (await modelStateService.getAllApiKeys().catch(() => ({}))) || {};
        const selected = await modelStateService.getCurrentModelInfo('llm').catch(() => null);
        if (keys.groq) {
            try {
                const ids = await groqProvider.listModels(keys.groq);
                ids.filter(id => groqProvider.VISION_RE.test(id)).forEach(id => add('groq', keys.groq, id));
            } catch (_) {}
        }
        if (keys.gemini) ['gemini-3.5-flash-lite', 'gemini-3.8-flash'].forEach(m => add('gemini', keys.gemini, m));
        if (selected?.apiKey && selected.provider !== 'groq') add(selected.provider, selected.apiKey, selected.model);
        return list;
    }

    /**
     * Stream from the first model; if it errors (503/429) or hasn't started within
     * ASK_HEDGE_AFTER_MS, start the next one too. The first to produce text wins.
     */
    _raceModels({ models, user, imageBase64, signal, startedAt }) {
        return new Promise((resolve, reject) => {
            let winner = null;
            let next = 0;
            let running = 0;
            let lastErr = null;
            const controllers = [];
            const hedgeTimers = [];
            const cleanup = () => hedgeTimers.forEach(clearTimeout);
            signal.addEventListener('abort', () => controllers.forEach(c => c.abort()));

            const launch = () => {
                if (winner || next >= models.length || signal.aborted) return;
                const m = models[next++];
                const ctrl = new AbortController();
                controllers.push(ctrl);
                running++;
                let started = false;
                const tStart = Date.now();
                const ttft = setTimeout(() => !started && ctrl.abort(), ASK_FIRST_TOKEN_TIMEOUT_MS);
                hedgeTimers.push(setTimeout(() => !started && !winner && launch(), ASK_HEDGE_AFTER_MS));
                if (m.launchWithNext) launch(); // start the picture model at the same time
                streamAnswer({
                    provider: m.provider,
                    apiKey: m.apiKey,
                    model: m.model,
                    system: ASK_SYSTEM_PROMPT,
                    user: m.user || user,
                    imageBase64: m.noImage ? null : imageBase64,
                    temperature: 0.2,
                    maxTokens: 700,
                    reasoningEffort: 'low',
                    signal: ctrl.signal,
                    onDelta: text => {
                        if (winner && winner !== m) return;
                        if (!winner) {
                            winner = m;
                            started = true;
                            cleanup();
                            controllers.forEach(c => c !== ctrl && c.abort()); // stop the slower model
                            console.log(`⚡ [AskService] First words in ${Date.now() - startedAt}ms (${m.provider}/${m.model}, request took ${Date.now() - tStart}ms)`);
                            this.state = { ...this.state, isLoading: false, isStreaming: true };
                        }
                        this.state.currentResponse = text;
                        this._broadcastState();
                    },
                })
                    .then(full => {
                        clearTimeout(ttft);
                        running--;
                        if (winner === m) resolve(full);
                        else if (!winner && !full.trim()) {
                            lastErr = new Error(`${m.model} returned nothing`);
                            launch();
                        }
                        if (!winner && running === 0 && next >= models.length) reject(lastErr || new Error('No answer'));
                    })
                    .catch(err => {
                        clearTimeout(ttft);
                        running--;
                        if (winner === m) return resolve(this.state.currentResponse || '');
                        if (signal.aborted) return resolve('');
                        if (winner) return;
                        const msg = err.name === 'AbortError' ? `no response within ${ASK_FIRST_TOKEN_TIMEOUT_MS}ms` : err.message;
                        console.warn(`[AskService] ${m.provider}/${m.model} failed: ${String(msg).slice(0, 160)}`);
                        lastErr = new Error(msg);
                        launch(); // try the next model right away
                        if (running === 0 && next >= models.length) reject(lastErr);
                    });
            };
            launch();
        });
    }

    async _processStream(reader, askWin, sessionId, signal) {
        const decoder = new TextDecoder();
        let fullResponse = '';

        try {
            this.state.isLoading = false;
            this.state.isStreaming = true;
            this._broadcastState();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value);
                const lines = chunk.split('\n').filter(line => line.trim() !== '');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.substring(6);
                        if (data === '[DONE]') {
                            return; 
                        }
                        try {
                            const json = JSON.parse(data);
                            const token = json.choices[0]?.delta?.content || '';
                            if (token) {
                                fullResponse += token;
                                this.state.currentResponse = fullResponse;
                                this._broadcastState();
                            }
                        } catch (error) {
                        }
                    }
                }
            }
        } catch (streamError) {
            if (signal.aborted) {
                console.log(`[AskService] Stream reading was intentionally cancelled. Reason: ${signal.reason}`);
            } else {
                console.error('[AskService] Error while processing stream:', streamError);
                if (askWin && !askWin.isDestroyed()) {
                    askWin.webContents.send('ask-response-stream-error', { error: streamError.message });
                }
            }
        } finally {
            this.state.isStreaming = false;
            this.state.currentResponse = fullResponse;
            this._broadcastState();
            if (fullResponse) {
                 try {
                    await askRepository.addAiMessage({ sessionId, role: 'assistant', content: fullResponse });
                    console.log(`[AskService] DB: Saved partial or full assistant response to session ${sessionId} after stream ended.`);
                } catch(dbError) {
                    console.error("[AskService] DB: Failed to save assistant response after stream ended:", dbError);
                }
            }
        }
    }

    /**
     * 멀티모달 관련 에러인지 판단
     * @private
     */
    _isMultimodalError(error) {
        const errorMessage = error.message?.toLowerCase() || '';
        return (
            errorMessage.includes('vision') ||
            errorMessage.includes('image') ||
            errorMessage.includes('multimodal') ||
            errorMessage.includes('unsupported') ||
            errorMessage.includes('image_url') ||
            errorMessage.includes('400') ||  // Bad Request often for unsupported features
            errorMessage.includes('invalid') ||
            errorMessage.includes('not supported')
        );
    }

}

const askService = new AskService();

module.exports = askService;