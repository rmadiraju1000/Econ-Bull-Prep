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

const SPECULATIVE_PAUSE_MS = 450; // live text must be stable this long before an early answer
const MIN_GAP_MS = 1500; // minimum time between two answer requests
const RATE_LIMIT_BACKOFF_MS = 15000; // pause after a 429 from the provider
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
    /\b(what|why|how|when|where|who|which|explain|describe|define|tell (me|us)|walk (me|us) through|compare|contrast|calculate|give (me|us)|can you|could you|would you|do you|did you|have you|is it|is there|are there|what's|should)\b/i;

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
        this.speculativeHeard = null; // text an early answer was started from, for this utterance
        this.status = 'idle';
        this.statusDetail = '';
        if (!silent) this.publish();
    }

    /** Does the END of this text look like a question is being asked? */
    looksLikeQuestion(text) {
        const t = (text || '').trim();
        if (t.split(/\s+/).length < 3) return false;
        const tail = lastWords(t, 25);
        return tail.includes('?') || QUESTION_RE.test(tail);
    }

    /** Live (partial) transcript while someone is talking. */
    onPartial(speaker, text) {
        if (this.partialTimer) clearTimeout(this.partialTimer);
        if (this.speculativeHeard) return; // already started early for this utterance
        if (!this.looksLikeQuestion(text) || text.trim().split(/\s+/).length < 5) return;

        this.partialTimer = setTimeout(() => {
            const skip = this.blockedReason(true);
            if (skip) {
                console.log(`[LiveQA] Skipping early answer: ${skip}`);
                return; // the final turn will still be answered
            }
            this.speculativeHeard = text.trim();
            console.log(`⚡ [LiveQA] Early answer from partial: "${lastWords(text, 20)}"`);
            this.request({ speculative: true, heard: text.trim() });
        }, SPECULATIVE_PAUSE_MS);
    }

    /** A finished turn. `history` is the conversation lines so far. */
    onFinalTurn(speaker, text, history) {
        if (this.partialTimer) clearTimeout(this.partialTimer);
        this.history = history;
        const heardEarly = this.speculativeHeard;
        this.speculativeHeard = null; // next utterance may start early again

        if (!this.looksLikeQuestion(text)) return;

        // Already answering from the partial transcript and the final text only
        // added a few words? Keep that answer instead of spending another request.
        if (heardEarly) {
            const a = normalize(heardEarly);
            const b = normalize(text);
            if (b.startsWith(a.slice(0, Math.max(0, a.length - 5))) && b.length - a.length <= 40) {
                console.log('[LiveQA] Final turn matches early answer, keeping it');
                return;
            }
        }
        this.request({ speculative: false });
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

    async request({ speculative, heard = '' }) {
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

        try {
            const modelInfo = await modelStateService.getCurrentModelInfo('llm');
            if (!modelInfo || !modelInfo.apiKey) throw new Error('AI model or API key is not configured.');

            const recent = (this.history || []).slice(-10).join('\n');
            let firstAt = 0;
            const full = await streamAnswer({
                provider: modelInfo.provider,
                apiKey: modelInfo.apiKey,
                model: modelInfo.model,
                system: SYSTEM_PROMPT,
                user: `Conversation so far (most recent last):\n${recent}${
                    speculative && heard ? `\n(still speaking, live transcript): ${heard}` : ''
                }`,
                temperature: 0.2,
                maxTokens: 220,
                signal: abort.signal,
                onDelta: text => {
                    if (seq !== this.requestSeq) return;
                    if (!firstAt) {
                        firstAt = Date.now();
                        console.log(`⚡ [LiveQA] First words in ${firstAt - startedAt}ms (${modelInfo.provider}/${modelInfo.model})`);
                    }
                    render(text, false);
                },
            });
            if (seq !== this.requestSeq) return;
            render(full, true);
            console.log(`⚡ [LiveQA] Done in ${Date.now() - startedAt}ms`);
            this.setStatus('idle');
        } catch (error) {
            if (error.name === 'AbortError' || seq !== this.requestSeq) return;
            const msg = error.message || String(error);
            console.error('❌ [LiveQA] Answer failed:', msg);
            if (/\b429\b|rate.?limit|quota|RESOURCE_EXHAUSTED/i.test(msg)) {
                this.backoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
                this.setStatus('rate-limited');
            } else {
                this.setStatus('error', msg.slice(0, 160));
            }
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
