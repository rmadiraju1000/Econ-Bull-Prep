const { BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const { createSTT } = require('../../common/ai/factory');
const modelStateService = require('../../common/services/modelStateService');

// How long a speaker must pause before their sentence counts as finished.
// Lower = faster live answers; too low can split one question into two.
const COMPLETION_DEBOUNCE_MS = 1100;

/**
 * If `full` begins with the same words as `prefix` (ignoring case/punctuation),
 * return the remaining words of `full`; otherwise return null.
 */
function stripLeadingWords(full, prefix) {
    const norm = w => w.toLowerCase().replace(/[^a-z0-9']/g, '');
    const fw = (full || '').trim().split(/\s+/).filter(Boolean);
    const pw = (prefix || '').trim().split(/\s+/).filter(Boolean);
    if (!pw.length || pw.length > fw.length) return null;
    for (let i = 0; i < pw.length; i++) {
        if (norm(fw[i]) !== norm(pw[i])) return null;
    }
    return fw.slice(pw.length).join(' ');
}

// ── New heartbeat / renewal constants ────────────────────────────────────────────
// Interval to send low-cost keep-alive messages so the remote service does not
// treat the connection as idle. One minute is safely below the typical 2-5 min
// idle timeout window seen on provider websockets.
const KEEP_ALIVE_INTERVAL_MS = 60 * 1000;         // 1 minute

// Interval after which we pro-actively tear down and recreate the STT sessions
// to dodge the 30-minute hard timeout enforced by some providers. 20 minutes
// gives a 10-minute safety buffer.
const SESSION_RENEW_INTERVAL_MS = 20 * 60 * 1000; // 20 minutes

// Duration to allow the old and new sockets to run in parallel so we don't
// miss any packets at the exact swap moment.
const SOCKET_OVERLAP_MS = 2 * 1000; // 2 seconds

class SttService {
    constructor() {
        this.mySttSession = null;
        this.theirSttSession = null;
        this.myCurrentUtterance = '';
        this.theirCurrentUtterance = '';
        
        // Turn-completion debouncing
        this.myCompletionBuffer = '';
        this.theirCompletionBuffer = '';
        this.myCompletionTimer = null;
        this.theirCompletionTimer = null;
        
        // System audio capture
        this.systemAudioProc = null;

        // Keep-alive / renewal timers
        this.keepAliveInterval = null;
        this.sessionRenewTimeout = null;

        // Callbacks
        this.onTranscriptionComplete = null;
        this.onStatusUpdate = null;

        this.modelInfo = null; 
    }

    setCallbacks({ onTranscriptionComplete, onStatusUpdate, onPartialTranscript }) {
        this.onTranscriptionComplete = onTranscriptionComplete;
        this.onPartialTranscript = onPartialTranscript;
        this.onStatusUpdate = onStatusUpdate;
    }

    sendToRenderer(channel, data) {
        // Listen 관련 이벤트는 Listen 윈도우에만 전송 (Ask 윈도우 충돌 방지)
        const { windowPool } = require('../../../window/windowManager');
        const listenWindow = windowPool?.get('listen');
        
        if (listenWindow && !listenWindow.isDestroyed()) {
            listenWindow.webContents.send(channel, data);
        }
    }

    async handleSendSystemAudioContent(data, mimeType) {
        try {
            await this.sendSystemAudioContent(data, mimeType);
            this.sendToRenderer('system-audio-data', { data });
            return { success: true };
        } catch (error) {
            console.error('Error sending system audio:', error);
            return { success: false, error: error.message };
        }
    }

    flushMyCompletion() {
        const finalText = [this.myCompletionBuffer, this.myCurrentUtterance].map(t => (t || '').trim()).filter(Boolean).join(' ');
        if (!this.modelInfo || !finalText) return;

        // Notify completion callback
        if (this.onTranscriptionComplete) {
            this.onTranscriptionComplete('Me', finalText);
        }
        
        // Send to renderer as final
        this.sendToRenderer('stt-update', {
            speaker: 'Me',
            text: finalText,
            isPartial: false,
            isFinal: true,
            timestamp: Date.now(),
        });

        this.myCompletionBuffer = '';
        this.myCompletionTimer = null;
        this.myCurrentUtterance = '';
        
        if (this.onStatusUpdate) {
            this.onStatusUpdate('Listening...');
        }
    }

    flushTheirCompletion() {
        const finalText = [this.theirCompletionBuffer, this.theirCurrentUtterance].map(t => (t || '').trim()).filter(Boolean).join(' ');
        if (!this.modelInfo || !finalText) return;
        
        // Notify completion callback
        if (this.onTranscriptionComplete) {
            this.onTranscriptionComplete('Them', finalText);
        }
        
        // Send to renderer as final
        this.sendToRenderer('stt-update', {
            speaker: 'Them',
            text: finalText,
            isPartial: false,
            isFinal: true,
            timestamp: Date.now(),
        });

        this.theirCompletionBuffer = '';
        this.theirCompletionTimer = null;
        this.theirCurrentUtterance = '';
        
        if (this.onStatusUpdate) {
            this.onStatusUpdate('Listening...');
        }
    }

    debounceMyCompletion(text) {
        if (this.modelInfo?.provider === 'gemini') {
            this.myCompletionBuffer += text;
        } else {
            this.myCompletionBuffer += (this.myCompletionBuffer ? ' ' : '') + text;
        }

        if (this.myCompletionTimer) clearTimeout(this.myCompletionTimer);
        this.myCompletionTimer = setTimeout(() => this.flushMyCompletion(), COMPLETION_DEBOUNCE_MS);
    }

    debounceTheirCompletion(text) {
        if (this.modelInfo?.provider === 'gemini') {
            this.theirCompletionBuffer += text;
        } else {
            this.theirCompletionBuffer += (this.theirCompletionBuffer ? ' ' : '') + text;
        }

        if (this.theirCompletionTimer) clearTimeout(this.theirCompletionTimer);
        this.theirCompletionTimer = setTimeout(() => this.flushTheirCompletion(), COMPLETION_DEBOUNCE_MS);
    }

    /**
     * Gemini transcribe-live sends:
     *  - serverContent.interimInputTranscription: fast partial text while speaking
     *  - serverContent.inputTranscription: final text for a segment after a pause
     *  - serverContent.turnComplete: end of the speaker's turn
     * Interim text is shown immediately (and keeps the sentence "open");
     * final text is committed to the buffer and debounced into a full turn.
     */
    handleGeminiTranscript(message, speaker) {
        const isMe = speaker === 'Me';
        const content = message?.serverContent;
        if (!content) {
            if (message?.error) console.error(`[Gemini STT - ${speaker}]`, message.error);
            return;
        }

        const bufferKey = isMe ? 'myCompletionBuffer' : 'theirCompletionBuffer';
        const interimKey = isMe ? 'myCurrentUtterance' : 'theirCurrentUtterance';
        const timerKey = isMe ? 'myCompletionTimer' : 'theirCompletionTimer';
        const flush = () => (isMe ? this.flushMyCompletion() : this.flushTheirCompletion());
        const clean = t => (t && t.trim() && t.trim() !== '<noise>' ? t : '');
        const join = (a, b) => (!a ? b : !b ? a : /\s$/.test(a) || /^\s/.test(b) ? a + b : `${a} ${b}`);

        // transcribe-live repeats everything said so far in the current turn in
        // each new final/interim message. Keep only the words we haven't seen,
        // otherwise the same sentence piles up again and again.
        this.geminiSegment = this.geminiSegment || { Me: '', Them: '' };
        const seen = this.geminiSegment[speaker];
        const newPart = text => {
            if (!text) return '';
            const rest = stripLeadingWords(text, seen);
            return rest === null ? text : rest;
        };

        const rawInterim = clean(content.interimInputTranscription?.text);
        const rawFinal = clean(content.inputTranscription?.text);
        const interim = rawInterim ? newPart(rawInterim) : '';
        const final = rawFinal ? newPart(rawFinal) : '';

        if (rawFinal) {
            // Remember the longest cumulative text for this turn.
            this.geminiSegment[speaker] = rawFinal;
            if (final) this[bufferKey] = join(this[bufferKey], final);
            this[interimKey] = '';
        } else if (rawInterim) {
            this[interimKey] = interim;
        }

        if (final || interim) {
            // Still talking: push the live text and restart the end-of-sentence timer.
            const liveText = join(this[bufferKey], this[interimKey]).trim();
            this.onPartialTranscript?.(speaker, liveText);
            this.sendToRenderer('stt-update', {
                speaker,
                text: liveText,
                isPartial: true,
                isFinal: false,
                timestamp: Date.now(),
            });
            if (this[timerKey]) clearTimeout(this[timerKey]);
            this[timerKey] = setTimeout(flush, COMPLETION_DEBOUNCE_MS);
        }

        if (content.turnComplete) {
            this.geminiSegment[speaker] = ''; // next turn starts fresh
            if (this[bufferKey] || this[interimKey]) {
                if (this[timerKey]) clearTimeout(this[timerKey]);
                flush();
            }
        }
    }

    async initializeSttSessions(language = 'en') {
        const effectiveLanguage = process.env.OPENAI_TRANSCRIBE_LANG || language || 'en';

        const modelInfo = await modelStateService.getCurrentModelInfo('stt');
        if (!modelInfo || !modelInfo.apiKey) {
            throw new Error('AI model or API key is not configured.');
        }
        this.modelInfo = modelInfo;
        this.sttClosing = false;
        this.sttLanguage = language;
        const gen = (this.sttGen = (this.sttGen || 0) + 1);
        const onUnexpectedClose = (who, event) => {
            console.log(`${who} STT session closed:`, event?.reason);
            if (gen !== this.sttGen || this.sttClosing) return; // old session after hand-off, or user stopped
            this.scheduleSttReconnect(`${who} session closed`);
        };
        console.log(`[SttService] Initializing STT for ${modelInfo.provider} using model ${modelInfo.model}`);

        const handleMyMessage = message => {
            if (!this.modelInfo) {
                console.log('[SttService] Ignoring message - session already closed');
                return;
            }
            // console.log('[SttService] handleMyMessage', message);
            
            if (this.modelInfo.provider === 'whisper') {
                // Whisper STT emits 'transcription' events with different structure
                if (message.text && message.text.trim()) {
                    const finalText = message.text.trim();
                    
                    // Filter out Whisper noise transcriptions
                    const noisePatterns = [
                        '[BLANK_AUDIO]',
                        '[INAUDIBLE]',
                        '[MUSIC]',
                        '[SOUND]',
                        '[NOISE]',
                        '(BLANK_AUDIO)',
                        '(INAUDIBLE)',
                        '(MUSIC)',
                        '(SOUND)',
                        '(NOISE)'
                    ];
                    
                    const isNoise = noisePatterns.some(pattern => 
                        finalText.includes(pattern) || finalText === pattern
                    );
                    
                    
                    if (!isNoise && finalText.length > 2) {
                        this.debounceMyCompletion(finalText);
                        
                        this.sendToRenderer('stt-update', {
                            speaker: 'Me',
                            text: finalText,
                            isPartial: false,
                            isFinal: true,
                            timestamp: Date.now(),
                        });
                    } else {
                        console.log(`[Whisper-Me] Filtered noise: "${finalText}"`);
                    }
                }
                return;
            } else if (this.modelInfo.provider === 'gemini') {
                this.handleGeminiTranscript(message, 'Me');

            // Deepgram 
            } else if (this.modelInfo.provider === 'deepgram') {
                const text = message.channel?.alternatives?.[0]?.transcript;
                if (!text || text.trim().length === 0) return;

                const isFinal = message.is_final;
                console.log(`[SttService-Me-Deepgram] Received: isFinal=${isFinal}, text="${text}"`);

                if (isFinal) {
                    // 최종 결과가 도착하면, 현재 진행중인 부분 발화는 비우고
                    // 최종 텍스트로 debounce를 실행합니다.
                    this.myCurrentUtterance = ''; 
                    this.debounceMyCompletion(text); 
                } else {
                    // 부분 결과(interim)인 경우, 화면에 실시간으로 업데이트합니다.
                    if (this.myCompletionTimer) clearTimeout(this.myCompletionTimer);
                    this.myCompletionTimer = null;

                    this.myCurrentUtterance = text;
                    
                    const continuousText = (this.myCompletionBuffer + ' ' + this.myCurrentUtterance).trim();

                    this.sendToRenderer('stt-update', {
                        speaker: 'Me',
                        text: continuousText,
                        isPartial: true,
                        isFinal: false,
                        timestamp: Date.now(),
                    });
                }
                
            } else {
                const type = message.type;
                const text = message.transcript || message.delta || (message.alternatives && message.alternatives[0]?.transcript) || '';

                if (type === 'conversation.item.input_audio_transcription.delta') {
                    if (this.myCompletionTimer) clearTimeout(this.myCompletionTimer);
                    this.myCompletionTimer = null;
                    this.myCurrentUtterance += text;
                    const continuousText = this.myCompletionBuffer + (this.myCompletionBuffer ? ' ' : '') + this.myCurrentUtterance;
                    if (text && !text.includes('vq_lbr_audio_')) {
                        this.sendToRenderer('stt-update', {
                            speaker: 'Me',
                            text: continuousText,
                            isPartial: true,
                            isFinal: false,
                            timestamp: Date.now(),
                        });
                    }
                } else if (type === 'conversation.item.input_audio_transcription.completed') {
                    if (text && text.trim()) {
                        const finalUtteranceText = text.trim();
                        this.myCurrentUtterance = '';
                        this.debounceMyCompletion(finalUtteranceText);
                    }
                }
            }

            if (message.error) {
                console.error('[Me] STT Session Error:', message.error);
            }
        };

        const handleTheirMessage = message => {
            if (!message || typeof message !== 'object') return;

            if (!this.modelInfo) {
                console.log('[SttService] Ignoring message - session already closed');
                return;
            }
            
            if (this.modelInfo.provider === 'whisper') {
                // Whisper STT emits 'transcription' events with different structure
                if (message.text && message.text.trim()) {
                    const finalText = message.text.trim();
                    
                    // Filter out Whisper noise transcriptions
                    const noisePatterns = [
                        '[BLANK_AUDIO]',
                        '[INAUDIBLE]',
                        '[MUSIC]',
                        '[SOUND]',
                        '[NOISE]',
                        '(BLANK_AUDIO)',
                        '(INAUDIBLE)',
                        '(MUSIC)',
                        '(SOUND)',
                        '(NOISE)'
                    ];
                    
                    const isNoise = noisePatterns.some(pattern => 
                        finalText.includes(pattern) || finalText === pattern
                    );
                    
                    
                    // Only process if it's not noise, not a false positive, and has meaningful content
                    if (!isNoise && finalText.length > 2) {
                        this.debounceTheirCompletion(finalText);
                        
                        this.sendToRenderer('stt-update', {
                            speaker: 'Them',
                            text: finalText,
                            isPartial: false,
                            isFinal: true,
                            timestamp: Date.now(),
                        });
                    } else {
                        console.log(`[Whisper-Them] Filtered noise: "${finalText}"`);
                    }
                }
                return;
            } else if (this.modelInfo.provider === 'gemini') {
                this.handleGeminiTranscript(message, 'Them');

            // Deepgram
            } else if (this.modelInfo.provider === 'deepgram') {
                const text = message.channel?.alternatives?.[0]?.transcript;
                if (!text || text.trim().length === 0) return;

                const isFinal = message.is_final;

                if (isFinal) {
                    this.theirCurrentUtterance = ''; 
                    this.debounceTheirCompletion(text); 
                } else {
                    if (this.theirCompletionTimer) clearTimeout(this.theirCompletionTimer);
                    this.theirCompletionTimer = null;

                    this.theirCurrentUtterance = text;
                    
                    const continuousText = (this.theirCompletionBuffer + ' ' + this.theirCurrentUtterance).trim();

                    this.sendToRenderer('stt-update', {
                        speaker: 'Them',
                        text: continuousText,
                        isPartial: true,
                        isFinal: false,
                        timestamp: Date.now(),
                    });
                }

            } else {
                const type = message.type;
                const text = message.transcript || message.delta || (message.alternatives && message.alternatives[0]?.transcript) || '';
                if (type === 'conversation.item.input_audio_transcription.delta') {
                    if (this.theirCompletionTimer) clearTimeout(this.theirCompletionTimer);
                    this.theirCompletionTimer = null;
                    this.theirCurrentUtterance += text;
                    const continuousText = this.theirCompletionBuffer + (this.theirCompletionBuffer ? ' ' : '') + this.theirCurrentUtterance;
                    if (text && !text.includes('vq_lbr_audio_')) {
                        this.sendToRenderer('stt-update', {
                            speaker: 'Them',
                            text: continuousText,
                            isPartial: true,
                            isFinal: false,
                            timestamp: Date.now(),
                        });
                    }
                } else if (type === 'conversation.item.input_audio_transcription.completed') {
                    if (text && text.trim()) {
                        const finalUtteranceText = text.trim();
                        this.theirCurrentUtterance = '';
                        this.debounceTheirCompletion(finalUtteranceText);
                    }
                }
            }
            
            if (message.error) {
                console.error('[Them] STT Session Error:', message.error);
            }
        };

        const mySttConfig = {
            language: effectiveLanguage,
            callbacks: {
                onmessage: handleMyMessage,
                onerror: error => console.error('My STT session error:', error.message),
                onclose: event => onUnexpectedClose('My', event),
            },
        };
        
        const theirSttConfig = {
            language: effectiveLanguage,
            callbacks: {
                onmessage: handleTheirMessage,
                onerror: error => console.error('Their STT session error:', error.message),
                onclose: event => onUnexpectedClose('Their', event),
            },
        };
        
        const sttOptions = {
            apiKey: this.modelInfo.apiKey,
            language: effectiveLanguage,
            usePortkey: this.modelInfo.provider === 'openai-glass',
            portkeyVirtualKey: this.modelInfo.provider === 'openai-glass' ? this.modelInfo.apiKey : undefined,
        };

        // Add sessionType for Whisper to distinguish between My and Their sessions
        const myOptions = { ...sttOptions, callbacks: mySttConfig.callbacks, sessionType: 'my' };
        const theirOptions = { ...sttOptions, callbacks: theirSttConfig.callbacks, sessionType: 'their' };

        [this.mySttSession, this.theirSttSession] = await Promise.all([
            createSTT(this.modelInfo.provider, myOptions),
            createSTT(this.modelInfo.provider, theirOptions),
        ]);

        console.log('✅ Both STT sessions initialized successfully.');

        // ── Setup keep-alive heart-beats ────────────────────────────────────────
        if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
        this.keepAliveInterval = setInterval(() => {
            this._sendKeepAlive();
        }, KEEP_ALIVE_INTERVAL_MS);

        // ── Schedule session auto-renewal ───────────────────────────────────────
        if (this.sessionRenewTimeout) clearTimeout(this.sessionRenewTimeout);
        this.sessionRenewTimeout = setTimeout(async () => {
            try {
                console.log('[SttService] Auto-renewing STT sessions…');
                await this.renewSessions(language);
            } catch (err) {
                console.error('[SttService] Failed to renew STT sessions:', err);
            }
        }, SESSION_RENEW_INTERVAL_MS);

        return true;
    }

    /**
     * Send a lightweight keep-alive to prevent idle disconnects.
     * Currently only implemented for OpenAI provider because Gemini's SDK
     * already performs its own heart-beats.
     */
    _sendKeepAlive() {
        if (!this.isSessionActive()) return;

        if (this.modelInfo?.provider === 'openai') {
            try {
                this.mySttSession?.keepAlive?.();
                this.theirSttSession?.keepAlive?.();
            } catch (err) {
                console.error('[SttService] keepAlive error:', err.message);
            }
        }
    }

    /**
     * Gracefully tears down then recreates the STT sessions. Should be invoked
     * on a timer to avoid provider-side hard timeouts.
     */
    /** Reconnect transcription after an unexpected drop (network blip, idle timeout). */
    scheduleSttReconnect(reason) {
        if (this.sttReconnectTimer || this.sttClosing) return;
        const attempt = (this.sttReconnectAttempts = (this.sttReconnectAttempts || 0) + 1);
        const delay = Math.min(500 * attempt, 5000);
        console.warn(`🔁 [SttService] Transcription dropped (${reason}); reconnecting in ${delay}ms (attempt ${attempt})`);
        this.sendToRenderer('update-status', 'Reconnecting transcription…');
        this.sttReconnectTimer = setTimeout(async () => {
            this.sttReconnectTimer = null;
            if (this.sttClosing) return;
            const oldMy = this.mySttSession;
            const oldTheir = this.theirSttSession;
            try {
                await this.initializeSttSessions(this.sttLanguage || 'en');
                this.sttReconnectAttempts = 0;
                console.log('✅ [SttService] Transcription reconnected');
                this.sendToRenderer('update-status', 'Connected. Ready to listen.');
                try { oldMy?.close?.(); oldTheir?.close?.(); } catch (_) {}
            } catch (err) {
                console.error('[SttService] Reconnect failed:', err.message);
                this.scheduleSttReconnect('reconnect failed');
            }
        }, delay);
    }

    async renewSessions(language = 'en') {
        if (!this.isSessionActive()) {
            console.warn('[SttService] renewSessions called but no active session.');
            return;
        }

        const oldMySession = this.mySttSession;
        const oldTheirSession = this.theirSttSession;

        console.log('[SttService] Spawning fresh STT sessions in the background…');

        // We reuse initializeSttSessions to create fresh sessions with the same
        // language and handlers. The method will update the session pointers
        // and timers, but crucially it does NOT touch the system audio capture
        // pipeline, so audio continues flowing uninterrupted.
        await this.initializeSttSessions(language);

        // Close the old sessions after a short overlap window.
        setTimeout(() => {
            try {
                oldMySession?.close?.();
                oldTheirSession?.close?.();
                console.log('[SttService] Old STT sessions closed after hand-off.');
            } catch (err) {
                console.error('[SttService] Error closing old STT sessions:', err.message);
            }
        }, SOCKET_OVERLAP_MS);
    }

    async sendMicAudioContent(data, mimeType) {
        // const provider = await this.getAiProvider();
        // const isGemini = provider === 'gemini';
        
        if (!this.mySttSession) {
            throw new Error('User STT session not active');
        }

        let modelInfo = this.modelInfo;
        if (!modelInfo) {
            console.warn('[SttService] modelInfo not found, fetching on-the-fly as a fallback...');
            modelInfo = await modelStateService.getCurrentModelInfo('stt');
        }
        if (!modelInfo) {
            throw new Error('STT model info could not be retrieved.');
        }

        let payload;
        if (modelInfo.provider === 'gemini') {
            payload = { audio: { data, mimeType: mimeType || 'audio/pcm;rate=24000' } };
        } else if (modelInfo.provider === 'deepgram') {
            payload = Buffer.from(data, 'base64'); 
        } else {
            payload = data;
        }
        await this.mySttSession.sendRealtimeInput(payload);
    }

    async sendSystemAudioContent(data, mimeType) {
        if (!this.theirSttSession) {
            throw new Error('Their STT session not active');
        }

        let modelInfo = this.modelInfo;
        if (!modelInfo) {
            console.warn('[SttService] modelInfo not found, fetching on-the-fly as a fallback...');
            modelInfo = await modelStateService.getCurrentModelInfo('stt');
        }
        if (!modelInfo) {
            throw new Error('STT model info could not be retrieved.');
        }

        let payload;
        if (modelInfo.provider === 'gemini') {
            payload = { audio: { data, mimeType: mimeType || 'audio/pcm;rate=24000' } };
        } else if (modelInfo.provider === 'deepgram') {
            payload = Buffer.from(data, 'base64');
        } else {
            payload = data;
        }

        await this.theirSttSession.sendRealtimeInput(payload);
    }

    killExistingSystemAudioDump() {
        return new Promise(resolve => {
            console.log('Checking for existing SystemAudioDump processes...');

            const killProc = spawn('pkill', ['-f', 'SystemAudioDump'], {
                stdio: 'ignore',
            });

            killProc.on('close', code => {
                if (code === 0) {
                    console.log('Killed existing SystemAudioDump processes');
                } else {
                    console.log('No existing SystemAudioDump processes found');
                }
                resolve();
            });

            killProc.on('error', err => {
                console.log('Error checking for existing processes (this is normal):', err.message);
                resolve();
            });

            setTimeout(() => {
                killProc.kill();
                resolve();
            }, 2000);
        });
    }

    async startMacOSAudioCapture() {
        if (process.platform !== 'darwin' || !this.theirSttSession) return false;
        this.wantSystemAudio = true;

        await this.killExistingSystemAudioDump();
        console.log('Starting macOS audio capture for "Them"...');

        const { app } = require('electron');
        const path = require('path');
        const systemAudioPath = app.isPackaged
            ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'ui', 'assets', 'SystemAudioDump')
            : path.join(app.getAppPath(), 'src', 'ui', 'assets', 'SystemAudioDump');

        console.log('SystemAudioDump path:', systemAudioPath);

        const proc = spawn(systemAudioPath, [], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        this.systemAudioProc = proc;
        this.lastSystemAudioAt = Date.now();
        const restart = why => {
            if (proc !== this.systemAudioProc && this.systemAudioProc) return; // a newer capture is running
            this.restartSystemAudio(why);
        };

        if (!this.systemAudioProc.pid) {
            console.error('Failed to start SystemAudioDump');
            return false;
        }

        console.log('SystemAudioDump started with PID:', this.systemAudioProc.pid);

        const CHUNK_DURATION = 0.1;
        const SAMPLE_RATE = 24000;
        const BYTES_PER_SAMPLE = 2;
        const CHANNELS = 2;
        const CHUNK_SIZE = SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS * CHUNK_DURATION;

        let audioBuffer = Buffer.alloc(0);

        // const provider = await this.getAiProvider();
        // const isGemini = provider === 'gemini';

        let modelInfo = this.modelInfo;
        if (!modelInfo) {
            console.warn('[SttService] modelInfo not found, fetching on-the-fly as a fallback...');
            modelInfo = await modelStateService.getCurrentModelInfo('stt');
        }
        if (!modelInfo) {
            throw new Error('STT model info could not be retrieved.');
        }

        proc.stdout.on('data', async data => {
            this.lastSystemAudioAt = Date.now();
            if (this.systemAudioRestarts) {
                console.log('✅ [SttService] Computer audio is flowing again');
                this.systemAudioRestarts = 0;
            }
            audioBuffer = Buffer.concat([audioBuffer, data]);

            while (audioBuffer.length >= CHUNK_SIZE) {
                const chunk = audioBuffer.slice(0, CHUNK_SIZE);
                audioBuffer = audioBuffer.slice(CHUNK_SIZE);

                const monoChunk = CHANNELS === 2 ? this.convertStereoToMono(chunk) : chunk;
                const base64Data = monoChunk.toString('base64');

                this.sendToRenderer('system-audio-data', { data: base64Data });

                if (this.theirSttSession) {
                    try {
                        let payload;
                        if (modelInfo.provider === 'gemini') {
                            payload = { audio: { data: base64Data, mimeType: 'audio/pcm;rate=24000' } };
                        } else if (modelInfo.provider === 'deepgram') {
                            payload = Buffer.from(base64Data, 'base64');
                        } else {
                            payload = base64Data;
                        }

                        await this.theirSttSession.sendRealtimeInput(payload);
                    } catch (err) {
                        console.error('Error sending system audio:', err.message);
                    }
                }
            }
        });

        proc.stderr.on('data', data => {
            const msg = data.toString();
            console.error('SystemAudioDump stderr:', msg);
            // e.g. "Stream stopped with error … Failed to find any displays" (screen locked,
            // display changed, remote control started). The process may linger without audio.
            if (/stream stopped|failed to find|SCStreamError/i.test(msg)) restart('capture stream stopped');
        });

        proc.on('close', code => {
            console.log('SystemAudioDump process closed with code:', code);
            if (proc === this.systemAudioProc) {
                this.systemAudioProc = null;
                restart(`process exited (${code})`);
            }
        });

        proc.on('error', err => {
            console.error('SystemAudioDump process error:', err);
            if (proc === this.systemAudioProc) this.systemAudioProc = null;
        });

        // Watchdog: the capture normally sends audio (even silence) every 100 ms.
        clearInterval(this.systemAudioWatchdog);
        this.systemAudioWatchdog = setInterval(() => {
            if (!this.wantSystemAudio) return clearInterval(this.systemAudioWatchdog);
            if (Date.now() - this.lastSystemAudioAt > 5000) restart('no audio for 5 s');
        }, 2000);

        return true;
    }

    convertStereoToMono(stereoBuffer) {
        const samples = stereoBuffer.length / 4;
        const monoBuffer = Buffer.alloc(samples * 2);

        for (let i = 0; i < samples; i++) {
            const leftSample = stereoBuffer.readInt16LE(i * 4);
            monoBuffer.writeInt16LE(leftSample, i * 2);
        }

        return monoBuffer;
    }

    /** Restart computer-audio capture after it stops on its own, retrying until it works. */
    restartSystemAudio(why) {
        if (!this.wantSystemAudio || this.systemAudioRestartTimer) return;
        const n = (this.systemAudioRestarts = (this.systemAudioRestarts || 0) + 1);
        const delay = Math.min(1000 * n, 5000);
        console.warn(`🔁 [SttService] Computer audio capture stopped (${why}); restarting in ${delay}ms (attempt ${n})`);
        this.sendToRenderer('update-status', 'Computer audio dropped – reconnecting…');
        this.systemAudioRestartTimer = setTimeout(async () => {
            this.systemAudioRestartTimer = null;
            if (!this.wantSystemAudio) return;
            this.lastSystemAudioAt = Date.now(); // give the restart time before the watchdog fires again
            const old = this.systemAudioProc;
            this.systemAudioProc = null;
            try { old?.kill('SIGTERM'); } catch (_) {}
            try {
                if (!this.theirSttSession) throw new Error('transcription not connected yet');
                const ok = await this.startMacOSAudioCapture();
                if (!ok) throw new Error('could not start');
                this.lastSystemAudioAt = Date.now();
            } catch (err) {
                console.error('[SttService] Audio restart failed:', err.message);
                this.restartSystemAudio('restart failed');
            }
        }, delay);
    }

    stopMacOSAudioCapture() {
        this.wantSystemAudio = false;
        clearInterval(this.systemAudioWatchdog);
        if (this.systemAudioRestartTimer) {
            clearTimeout(this.systemAudioRestartTimer);
            this.systemAudioRestartTimer = null;
        }
        if (this.systemAudioProc) {
            console.log('Stopping SystemAudioDump...');
            this.systemAudioProc.kill('SIGTERM');
            this.systemAudioProc = null;
        }
    }

    isSessionActive() {
        return !!this.mySttSession && !!this.theirSttSession;
    }

    async closeSessions() {
        this.sttClosing = true;
        if (this.sttReconnectTimer) {
            clearTimeout(this.sttReconnectTimer);
            this.sttReconnectTimer = null;
        }
        this.stopMacOSAudioCapture();

        // Clear heartbeat / renewal timers
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
        if (this.sessionRenewTimeout) {
            clearTimeout(this.sessionRenewTimeout);
            this.sessionRenewTimeout = null;
        }

        // Clear timers
        if (this.myCompletionTimer) {
            clearTimeout(this.myCompletionTimer);
            this.myCompletionTimer = null;
        }
        if (this.theirCompletionTimer) {
            clearTimeout(this.theirCompletionTimer);
            this.theirCompletionTimer = null;
        }

        const closePromises = [];
        if (this.mySttSession) {
            closePromises.push(this.mySttSession.close());
            this.mySttSession = null;
        }
        if (this.theirSttSession) {
            closePromises.push(this.theirSttSession.close());
            this.theirSttSession = null;
        }

        await Promise.all(closePromises);
        console.log('All STT sessions closed.');

        // Reset state
        this.myCurrentUtterance = '';
        this.theirCurrentUtterance = '';
        this.myCompletionBuffer = '';
        this.theirCompletionBuffer = '';
        this.modelInfo = null; 
    }
}

module.exports = SttService; 