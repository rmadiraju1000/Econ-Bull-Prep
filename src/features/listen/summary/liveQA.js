// Live question answering for Listen mode.
//
// - Watches the live transcript, detects when a question is being asked,
//   and asks the LLM to (1) pick out the MAIN question and (2) answer it.
// - Answers stream in and are KEPT as cards (newest first) so they stay on
//   screen to read; repeats of the same question update the existing card.
// - Rate-safe: at most one early ("speculative") request per utterance, a
//   minimum gap between requests, and an automatic back-off after a 429.

const modelStateService = require('../../common/services/modelStateService');
const { streamAnswer } = require('./fastAnswer');
const { liveModels } = require('../../common/ai/providers/groq');

const SPECULATIVE_PAUSE_MS = 450; // live text must be stable this long before an early answer
const MIN_GAP_MS = 1500; // minimum time between two answer requests
const RATE_LIMIT_BACKOFF_MS = 15000; // pause after a 429 from the provider
const FIRST_TOKEN_TIMEOUT_MS = 3500; // if a model hasn't started answering by then, try the next one

// Live answers prefer Groq (fastest, most reliable) whenever a Groq key is saved,
// then fall back to the model selected in Settings, then a backup Gemini model.
const GROQ_LIVE_MODEL = 'llama-3.3-70b-versatile';
const GEMINI_BACKUP_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.8-flash'];
const MAX_CARDS = 25;

const SYSTEM_PROMPT = [
    'You help the user during a live call by answering the question they are being asked, instantly.',
    'Lines starting with "them:" are the other person; "me:" is the user. The transcript is from speech-to-text and may be messy or cut off.',
    'Step 1: find the MAIN question currently being asked (the most recent real question; ignore small talk and filler).',
    'Step 2: answer it so the user can say it out loud.',
    'Output EXACTLY this format, nothing else:',
    'Q: <the main question, rewritten clearly in under 15 words>',
    'A: <the direct answer in one short sentence>',
    '- <key point: fact, number, example, or reasoning>',
    '- <key point>',
    '- <optional key point>',
    'If no real question is being asked, output only: Q: NONE',
    'Economics questions are common: use correct terms and give brief intuition. Keep the whole answer under 80 words.',
].join('\n');

const QUESTION_RE =
    /\b(what|why|how|when|where|who|which|explain|describe|define|tell (me|us)|walk (me|us) through|compare|contrast|calculate|give (me|us)|can you|could you|would you|do you|did you|have you|is it|is there|are there|what's|should|name (the|this|a)|identify|true or false|this (economist|term|concept|curve|law|theory|policy|type|principle|measure|tax|market|index|agency|act))\b/i;

function normalize(t) {
    return (t || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function lastWords(text, n) {
    const words = (text || '').trim().split(/\s+/);
    return words.slice(-n).join(' ');
}

class LiveQA {
    constructor(sendToRenderer) {
        this.send = sendToRenderer;
        this.reset({ silent: true });
    }

    reset({ silent = false } = {}) {
        if (this.abort) this.abort.abort();
        if (this.partialTimer) clearTimeout(this.partialTimer);
        this.cards = []; // newest first: { id, question, answer, points, status, updatedAt }
        this.nextId = 1;
        this.requestSeq = 0;
        this.abort = null;
        this.partialTimer = null;
        this.lastRequestAt = 0;
        this.backoffUntil = 0;
        // Early-answer state is kept PER SPEAKER, so mic chatter can't reset the
        // tracking for a question coming from the call/system audio.
        this.early = { Me: { heard: null, failed: false }, Them: { heard: null, failed: false } };
        this.recentThem = []; // [{ t, text }] system-audio text from the last few seconds
        this.timing = new Map(); // requestSeq -> { firstAt, endAt, logged } for answer-lead stats
        this.deadModels = this.deadModels || new Set(); // models that returned 'not found' — skip them
        this.status = 'idle';
        this.statusDetail = '';
        if (!silent) this.publish();
    }

    rememberThem(text) {
        const now = Date.now();
        this.recentThem.push({ t: now, text });
        this.recentThem = this.recentThem.filter(x => now - x.t < 15000).slice(-30);
    }

    /**
     * When audio plays through the speakers, the mic hears it too and it shows up
     * as "me". Treat a "me" line as an echo if most of its words were just heard
     * from the system audio, or if system audio was playing at that moment.
     */
    isEcho(speaker, text) {
        if (speaker !== 'Me') return false;
        const now = Date.now();
        const recent = this.recentThem.filter(x => now - x.t < 15000);
        if (!recent.length) return false;
        if (now - recent[recent.length - 1].t < 1200) return true; // the call/video is talking right now
        const words = new Set(normalize(text).split(' ').filter(w => w.length > 2));
        if (words.size < 2) return false;
        const themWords = new Set(normalize(recent.map(x => x.text).join(' ')).split(' '));
        let overlap = 0;
        words.forEach(w => themWords.has(w) && overlap++);
        return overlap / words.size >= 0.5;
    }

    /** Record when a question ended / when its answer first appeared; log the lead once both are known. */
    markTiming(seq, field) {
        if (!seq) return;
        const t = this.timing.get(seq) || {};
        if (t[field] == null) t[field] = Date.now();
        this.timing.set(seq, t);
        if (t.firstAt != null && t.endAt != null && !t.logged) {
            t.logged = true;
            const lead = t.firstAt - t.endAt;
            console.log(`⏱ [LiveQA] Answer lead vs end of question: ${lead >= 0 ? '+' : ''}${lead}ms`);
        }
        if (this.timing.size > 50) this.timing.delete(this.timing.keys().next().value);
    }

    /** Does the END of this text look like a question is being asked? */
    looksLikeQuestion(text) {
        const t = (text || '').trim();
        if (t.split(/\s+/).length < 3) return false;
        const tail = lastWords(t, 25);
        // A bare "?" (e.g. "Are you sure?", "Paris Agreement?") isn't enough on its
        // own: also require a question word or a longer sentence.
        if (QUESTION_RE.test(tail)) return true;
        return tail.includes('?') && t.split(/\s+/).length >= 6;
    }

    /** Live (partial) transcript while someone is talking. */
    onPartial(speaker, text) {
        if (speaker === 'Them') this.rememberThem(text);
        const st = this.early[speaker] || this.early.Them;
        if (this.partialTimer) clearTimeout(this.partialTimer);
        if (st.heard) return; // already started early for this utterance
        if (this.isEcho(speaker, text)) return;
        if (!this.looksLikeQuestion(text) || text.trim().split(/\s+/).length < 5) return;

        this.partialTimer = setTimeout(() => {
            const skip = this.blockedReason(true);
            if (skip) {
                console.log(`[LiveQA] Skipping early answer: ${skip}`);
                return; // the final turn will still be answered
            }
            st.heard = text.trim();
            st.failed = false;
            st.seq = this.requestSeq + 1; // the request about to be sent
            console.log(`⚡ [LiveQA] Early answer from partial (${speaker}): "${lastWords(text, 20)}"`);
            this.request({ speculative: true, heard: text.trim(), speaker });
        }, SPECULATIVE_PAUSE_MS);
    }

    /** A finished turn. `history` is the conversation lines so far. */
    onFinalTurn(speaker, text, history) {
        this.history = history;
        if (speaker === 'Them') this.rememberThem(text);
        const st = this.early[speaker] || this.early.Them;
        const heardEarly = st.failed ? null : st.heard; // a failed early answer doesn't count
        const earlySeq = st.seq;
        st.heard = null; // this speaker's next utterance may start early again
        st.failed = false;
        st.seq = null;

        if (this.isEcho(speaker, text)) {
            console.log(`[LiveQA] Ignoring mic echo of the call audio: "${lastWords(text, 12)}"`);
            return;
        }
        if (!this.looksLikeQuestion(text)) return;

        // Already answering from the partial transcript and the final text only
        // added a few words? Keep that answer instead of spending another request.
        if (heardEarly) {
            const a = normalize(heardEarly);
            const b = normalize(text);
            if (b.startsWith(a.slice(0, Math.max(0, a.length - 5))) && b.length - a.length <= 40) {
                console.log('[LiveQA] Final turn matches early answer, keeping it');
                this.markTiming(earlySeq, 'endAt');
                return;
            }
        }
        this.markTiming(this.requestSeq + 1, 'endAt'); // question ended as this request starts
        console.log(`▶ [LiveQA] Answering finished question (${speaker})`);
        this.request({ speculative: false, speaker });
    }

    setHistory(history) {
        this.history = history;
    }

    /** Why a request can't be sent right now (or '' if it can). */
    blockedReason(speculative) {
        const now = Date.now();
        if (now < this.backoffUntil) return 'rate-limit back-off';
        if (speculative && now - this.lastRequestAt < MIN_GAP_MS) return 'too soon after the last request';
        return '';
    }

    /** Models to try for live answers, fastest/most reliable first. */
    async candidates() {
        const list = [];
        const add = (provider, apiKey, model) => {
            if (provider && apiKey && model && !list.some(c => c.provider === provider && c.model === model)) {
                list.push({ provider, apiKey, model });
            }
        };
        let keys = {};
        try {
            keys = (await modelStateService.getAllApiKeys()) || {};
        } catch (_) {}
        const selected = await modelStateService.getCurrentModelInfo('llm').catch(() => null);

        if (keys.groq) {
            // Ask Groq which models this key can use (cached), best first; try up to two.
            const groqModels = await liveModels(keys.groq, selected?.provider === 'groq' ? selected.model : GROQ_LIVE_MODEL);
            groqModels.filter(m => !this.deadModels.has(`groq/${m}`)).slice(0, 2).forEach(m => add('groq', keys.groq, m));
        }
        if (selected?.apiKey) add(selected.provider, selected.apiKey, selected.model);
        if (keys.gemini) GEMINI_BACKUP_MODELS.forEach(m => add('gemini', keys.gemini, m));
        return list;
    }

    async request({ speculative, heard = '', speaker = 'Them' }) {
        const now = Date.now();
        const blocked = this.blockedReason(speculative);
        if (blocked) {
            console.log(`[LiveQA] Skipping request: ${blocked}`);
            return;
        }

        if (this.abort) this.abort.abort(); // newest question wins
        const abort = new AbortController();
        this.abort = abort;
        const seq = ++this.requestSeq;
        this.lastRequestAt = now;
        const startedAt = now;
        this.setStatus('thinking');

        let card = null;
        let lastPush = 0;
        const render = (text, final) => {
            const parsed = this.parse(text, final);
            if (parsed.none) {
                if (card) this.removeCard(card.id);
                card = null;
                return;
            }
            if (!parsed.question) return; // wait until the question line is known
            if (!card) card = this.upsertCard(parsed.question);
            card.question = parsed.question;
            card.answer = parsed.answer;
            card.points = parsed.points;
            card.status = final ? 'done' : 'streaming';
            card.updatedAt = Date.now();
            const t = Date.now();
            if (final || t - lastPush >= 60) {
                lastPush = t;
                this.publish();
            }
        };

        const recent = (this.history || []).slice(-10).join('\n');
        const user = `Conversation so far (most recent last):\n${recent}${
            speculative && heard ? `\n(still speaking, live transcript): ${heard}` : ''
        }`;

        let lastError = null;
        const models = await this.candidates();
        if (!models.length) lastError = new Error('No AI model or API key is configured.');

        for (const m of models) {
            if (seq !== this.requestSeq) return;
            // Per-attempt controller: aborted by a newer question OR by the first-token timeout.
            const attempt = new AbortController();
            const onOuterAbort = () => attempt.abort();
            abort.signal.addEventListener('abort', onOuterAbort);
            let firstAt = 0;
            const timer = setTimeout(() => {
                if (!firstAt) attempt.abort();
            }, FIRST_TOKEN_TIMEOUT_MS);

            try {
                const t0 = Date.now();
                const full = await streamAnswer({
                    provider: m.provider,
                    apiKey: m.apiKey,
                    model: m.model,
                    system: SYSTEM_PROMPT,
                    user,
                    temperature: 0.2,
                    maxTokens: 220,
                    signal: attempt.signal,
                    onDelta: text => {
                        if (seq !== this.requestSeq) return;
                        if (!firstAt) {
                            firstAt = Date.now();
                            this.markTiming(seq, 'firstAt');
                            console.log(`⚡ [LiveQA] First words in ${firstAt - startedAt}ms (${m.provider}/${m.model})`);
                        }
                        render(text, false);
                    },
                });
                if (seq !== this.requestSeq) return;
                if (!full.trim()) throw new Error('Empty response');
                render(full, true);
                const p = this.parse(full, true);
                console.log(`📝 [LiveQA] Q: ${p.none ? 'NONE' : p.question} | A: ${p.answer} | ${p.points.join(' / ')}`);
                console.log(`⚡ [LiveQA] Done in ${Date.now() - startedAt}ms (attempt took ${Date.now() - t0}ms)`);
                this.setStatus('idle');
                return;
            } catch (error) {
                if (abort.signal.aborted || seq !== this.requestSeq) return; // superseded by a newer question
                const msg = error.name === 'AbortError' ? `no response within ${FIRST_TOKEN_TIMEOUT_MS}ms` : error.message || String(error);
                console.error(`❌ [LiveQA] ${m.provider}/${m.model} failed: ${msg.slice(0, 200)}`);
                if (/\b404\b|model_not_found|does not exist|not found/i.test(msg)) {
                    this.deadModels.add(`${m.provider}/${m.model}`); // don't waste time on it again
                }
                lastError = new Error(msg);
                if (firstAt) break; // it had started streaming; don't restart mid-answer
            } finally {
                clearTimeout(timer);
                abort.signal.removeEventListener('abort', onOuterAbort);
            }
        }

        if (seq !== this.requestSeq) return;
        if (speculative && this.early[speaker]) this.early[speaker].failed = true; // answer the finished question instead
        const msg = lastError?.message || 'Unknown error';
        if (/\b429\b|rate.?limit|quota|RESOURCE_EXHAUSTED/i.test(msg) && models.length <= 1) {
            this.backoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
            this.setStatus('rate-limited');
        } else {
            this.setStatus('error', msg.slice(0, 160));
        }
    }

    parse(text, final = true) {
        const out = { question: '', answer: '', points: [], none: false };
        const lines = (text || '').split('\n');
        // While streaming, the question line only counts once it is complete.
        const qLineDone = final || /^\s*Q\s*[:：][^\n]*\n/i.test(text || '');
        for (const raw of lines) {
            const line = raw.replace(/\*\*/g, '').trim();
            if (!line) continue;
            const q = line.match(/^Q\s*[:：]\s*(.*)$/i);
            const a = line.match(/^A\s*[:：]\s*(.*)$/i);
            if (q) {
                if (!qLineDone) continue;
                if (/^none\b/i.test(q[1].trim())) out.none = true;
                else out.question = q[1].trim();
            } else if (a) {
                out.answer = a[1].trim();
            } else if (/^[-*•]\s*/.test(line)) {
                const p = line.replace(/^[-*•]\s*/, '').trim();
                if (p) out.points.push(p);
            } else if (out.question && !out.answer) {
                out.answer = line; // model skipped the "A:" label
            }
        }
        out.points = out.points.slice(0, 4);
        return out;
    }

    /** Reuse a recent card for the same question, otherwise add a new one on top. */
    upsertCard(question) {
        const n = normalize(question);
        const recent = this.cards.find(c => Date.now() - c.updatedAt < 90000 && normalize(c.question) === n);
        if (recent) {
            this.cards = [recent, ...this.cards.filter(c => c !== recent)];
            return recent;
        }
        const card = { id: this.nextId++, question, answer: '', points: [], status: 'streaming', updatedAt: Date.now() };
        this.cards.unshift(card);
        this.cards = this.cards.slice(0, MAX_CARDS);
        return card;
    }

    removeCard(id) {
        this.cards = this.cards.filter(c => c.id !== id);
        this.publish();
    }

    setStatus(status, detail = '') {
        this.status = status;
        this.statusDetail = detail;
        this.publish();
    }

    publish() {
        this.send?.('qa-update', {
            status: this.status || 'idle',
            detail: this.statusDetail || '',
            cards: this.cards.map(c => ({ ...c, points: [...c.points] })),
        });
    }
}

module.exports = { LiveQA };
