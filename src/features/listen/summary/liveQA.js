// Live question answering for Listen mode.
//
// - Watches the live transcript, detects when a question is being asked,
//   and asks the LLM to (1) pick out the MAIN question and (2) answer it.
// - Routing: multi-step questions (numbers, cause/effect, "why", elasticity…)
//   go to the smarter model with more reasoning; simple recall questions go to
//   the fastest model. Optional double-check re-verifies fast answers.
// - Early answers start from the live transcript only when it clearly ends in a
//   question; they show as "draft" until the question is confirmed finished.
// - Repeats, team answers, scores and chatter are ignored (model replies SAME /
//   NONE, and a finished answer is never overwritten by a similar question).
// - Answers stream in and are KEPT as cards (newest first) and can be rated ✓/✗.

const modelStateService = require('../../common/services/modelStateService');
const { streamAnswer } = require('./fastAnswer');
const { listModels } = require('../../common/ai/providers/groq');

const SPECULATIVE_PAUSE_MS = 600; // live text must be stable this long before an early answer (no clear question end)
const QUICK_PAUSE_MS = 150; // a clearly finished question in the live text: answer almost immediately
const MIN_GAP_MS = 1500; // minimum time between two answer requests
const RATE_LIMIT_BACKOFF_MS = 15000; // pause after a 429 from the provider
const FIRST_TOKEN_TIMEOUT_MS = 4000; // if a model hasn't started answering by then, try the next one
const SIMILAR_QUESTION = 0.55; // word-overlap ratio treated as "the same question"
const CARD_MEMORY_MS = 5 * 60 * 1000; // how long a finished answer protects its question from being redone
const MAX_CARDS = 25;

// Model routing (Groq). The first available model in each list is used.
const FAST_MODELS = ['openai/gpt-oss-20b', 'llama-3.1-8b-instant', 'llama-3.3-70b-versatile'];
const SMART_MODELS = ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b'];
const GEMINI_BACKUP_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.8-flash'];

const ANSWER_FORMAT = [
    'Output EXACTLY this format, nothing else:',
    'Q: <the main question, rewritten clearly in under 15 words>',
    'A: <the direct answer in one short sentence>',
    '- <key point: fact, number, example, or reasoning>',
    '- <key point>',
    '- <optional key point>',
].join('\n');

const SYSTEM_PROMPT = [
    'You help the user practice by answering, instantly, the question being asked on a live call or video.',
    'Lines starting with "them:" are the call/system audio; "me:" is the user\'s mic. The transcript is speech-to-text and may be messy or cut off.',
    'Step 1: find the MAIN question currently being asked: the most recent real question.',
    'Step 2: answer it correctly so the user can say it out loud.',
    ANSWER_FORMAT,
    'Special replies (output only that line):',
    '- Q: SAME   if the main question is one already answered (listed below), or the latest lines are only teams/people giving answers, scores, timers ("20 seconds", "boards up"), "repeat your answer", or chatter.',
    '- Q: NONE   if no real question is being asked yet (for example the question is still cut off and cannot be answered).',
    'Never treat someone\'s spoken answer as the correct answer; work it out yourself.',
    'Questions often depend on SETUP given before them: a scenario, numbers, a table, or "use the following information for the next questions". Use all of that setup (also the "Setup given earlier" section) and put the key given numbers/facts in the Q: line.',
    'Quiz cues: a timer like "20 seconds" right after a sentence means that sentence was the question. A sentence ending in "is also known as" / "is called" / "is referred to as" is a fill-in-the-blank: answer with the term.',
    'Economics: use correct terms, get the DIRECTION of every effect right (which curve shifts, left or right; who bears a tax: the more inelastic side), and do any arithmetic step by step before answering. Keep the visible answer under 80 words.',
].join('\n');

const VERIFY_PROMPT = [
    'You are checking a quick answer to a question asked during a live economics quiz or call.',
    'Work it out yourself carefully (directions of shifts, who bears a tax, arithmetic).',
    'If the proposed answer is correct, output exactly: OK',
    'If it is wrong or misleading, output the corrected answer.',
    ANSWER_FORMAT,
].join('\n');

// Broad check for a finished sentence (used for finished turns).
const QUESTION_RE =
    /\b(what|why|how|where|who|whom|whose|which|explain|describe|define|tell (me|us)|walk (me|us) through|compare|contrast|calculate|compute|give (me|us)|can you|could you|would you|do you|did you|have you|is it|is there|are there|what's|should|name (the|this|a)|identify|true or false|known as|referred to as|is called|also called|term for|this (economist|term|concept|curve|law|theory|policy|type|principle|measure|tax|market|index|agency|act))\b/i;
// Quiz commands that are questions without a question word: "Name two reasons…", "List three…".
const IMPERATIVE_RE =
    /(?:^|[.?!:]\s+|\b(?:question|number)\s+\w+[.,:]?\s+)(name|list|identify|give(?!\s+(?:me|us|it|him|her|them)\b)|state|explain|describe|define|calculate|compute|determine|find|predict|draw|graph)\b[^.?!]{10,}/i;
// Stricter check for EARLY answers from the live transcript.
const STRONG_Q_RE =
    /\b(what|which|who|whom|whose|why|how|name (the|this|a)|identify|explain|describe|define|calculate|compute|true or false|this (economist|term|concept|curve|law|theory|policy|type|principle|measure|tax|market|index|agency|act))\b/i;
// If the live text ends with one of these, the question isn't finished yet.
const DANGLING_END_RE =
    /\b(the|a|an|of|by|to|for|in|on|at|from|with|and|or|but|is|are|was|were|be|will|would|can|could|should|does|do|did|has|have|that|which|what|than|as|if|when|its|their|his|her)$/i;
// Questions that need multi-step reasoning go to the smarter model.
const HARD_RE =
    /\d|%|\b(why|explain|effect|affect|impact|happen|result|cause|calculate|compute|value of|bear|burden|incidence|elastic|inelastic|shift|curve|equilibrium|increase|decrease|rise|rises|fall|falls|raise|lower|higher|surplus|deficit|multiplier|marginal|if )\b/i;

function normalize(t) {
    return (t || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}
function lastChars(text, n) {
    const t = (text || '').trim();
    return t.length <= n ? t : '…' + t.slice(-n).replace(/^\S*\s/, '');
}
// Setup that later questions refer back to.
const SETUP_RE =
    /\b(use the following|following (information|data|table|graph|scenario)|for (the )?(next|following) (two|three|four|2|3|4) questions|questions? \w+ (and|through|to) \w+ (refer|are based)|refer to the|based on the (table|graph|information|data)|suppose|assume|given that|consider (a|an|the)|table (shows|below)|the graph)\b/i;
function lastWords(text, n) {
    return (text || '').trim().split(/\s+/).slice(-n).join(' ');
}
const STOP = new Set('the a an of to in on for and or is are was be what which who how why does do did will would this that it its with by as at from'.split(' '));
function contentWords(t) {
    return new Set(normalize(t).split(' ').filter(w => w.length > 2 && !STOP.has(w)));
}
const TIMER_RE = /^\W*(it'?s\s+)?(\d+|five|ten|fifteen|twenty|thirty|forty|sixty)\s+seconds?\W*$/i;
const FILL_IN_END_RE = /\b(known as|referred to as|called|termed|named|the term for)\s*[.?!]*$/i;
function wordCount(t) {
    return (t || '').trim().split(/\s+/).filter(Boolean).length;
}
/**
 * Find a question that has been COMPLETELY spoken in the live text, even if the
 * speaker kept talking ("…what law? 20 seconds."). Looks at the last few sentences.
 * Returns { question, context } or null.
 */
const TRAILING_TIMER_RE = /\s*((?:it'?s\s+)?(?:\d+|five|ten|fifteen|twenty|thirty|forty|sixty)\s+seconds?)\W*$/i;
function completedQuestion(text) {
    // "…is also known as 20 seconds" (no punctuation): split the timer off as its own sentence.
    text = (text || '').replace(TRAILING_TIMER_RE, (m, t, off, all) => (/[.?!]$/.test(all.slice(0, off)) ? m : `. ${t}.`));
    const sentences = ((text || '').match(/[^.?!]+[.?!]+|[^.?!]+$/g) || []).map(x => x.trim()).filter(Boolean);
    for (let i = sentences.length - 1; i >= Math.max(0, sentences.length - 4); i--) {
        const s = sentences[i];
        const next = sentences[i + 1] || '';
        const finished = /[.?!]$/.test(s) || !!next;
        if (!finished || TIMER_RE.test(s)) continue;
        const words = wordCount(s);
        const timerAfter = TIMER_RE.test(next);
        let isQuestion =
            (s.endsWith('?') && words >= 4 && (STRONG_Q_RE.test(s) || words >= 7)) ||
            (/[.!]$/.test(s) && words >= 5 && IMPERATIVE_RE.test(s)) ||
            (FILL_IN_END_RE.test(s) && words >= 5) ||
            (timerAfter && words >= 5);
        if (!isQuestion && timerAfter && words < 5 && i > 0) {
            // "Suppose tuna and peanut butter are substitutes. If there's an… 20 seconds."
            // (fast speech / transcriber dropped words): use the last two sentences.
            const merged = `${sentences[i - 1]} ${s}`;
            if (wordCount(merged) >= 6 && !TIMER_RE.test(sentences[i - 1])) {
                return { question: merged, context: sentences.slice(Math.max(0, i - 4), i + 1).join(' ') };
            }
        }
        if (isQuestion) {
            return { question: s, context: sentences.slice(Math.max(0, i - 3), i + 1).join(' ') };
        }
    }
    return null;
}
function numbersIn(t) {
    return ((t || '').match(/\d+(?:\.\d+)?/g) || []).sort().join(',');
}
/** Same question? Needs most words in common AND the same numbers. */
function sameQuestion(a, b) {
    if (numbersIn(a) !== numbersIn(b)) return false;
    const A = contentWords(a);
    const B = contentWords(b);
    if (!A.size || !B.size) return false;
    let n = 0;
    A.forEach(w => B.has(w) && n++);
    return n / (A.size + B.size - n) >= 0.5; // Jaccard
}
const DIR_RE = /\b(left|right|increas\w*|decreas\w*|rise|rises|rising|fall|falls|falling|up|down|higher|lower|more|less|fewer|consumers?|producers?|buyers?|sellers?|surplus|shortage|elastic|inelastic|unchanged|no change|true|false)\b/gi;
function directions(t) {
    const norm = w => w.toLowerCase().replace(/^increas.*|^ris.*|^higher|^up$/, 'up').replace(/^decreas.*|^fall.*|^lower|^down$/, 'down').replace(/s$/, '');
    return [...new Set(((t || '').match(DIR_RE) || []).map(norm))].sort().join(',');
}
/** Do the quick and the smart answer say the same thing? (headline only) */
function answersAgree(a, b) {
    if (directions(a) !== directions(b)) return false;
    if (numbersIn(a) !== numbersIn(b)) return false;
    return similarity(a, b) >= 0.5 || normalize(a).includes(normalize(b)) || normalize(b).includes(normalize(a));
}
function similarity(a, b) {
    const A = contentWords(a);
    const B = contentWords(b);
    if (!A.size || !B.size) return 0;
    let n = 0;
    A.forEach(w => B.has(w) && n++);
    return n / Math.min(A.size, B.size);
}

class LiveQA {
    constructor(sendToRenderer) {
        this.send = sendToRenderer;
        this.options = { verify: false, ignoreMic: false };
        this.deadModels = new Set();
        this.reset({ silent: true });
    }

    reset({ silent = false } = {}) {
        if (this.abort) this.abort.abort();
        Object.values(this.partialTimers || {}).forEach(t => clearTimeout(t));
        this.cards = []; // newest first
        this.setups = [];
        this.nextId = 1;
        this.requestSeq = 0;
        this.abort = null;
        this.partialTimers = {}; // per speaker
        this.lastRequestAt = 0;
        this.backoffUntil = 0;
        // Early-answer state per speaker, so mic chatter can't reset a call-audio question.
        this.early = { Me: {}, Them: {} };
        this.recentThem = [];
        this.timing = new Map();
        this.confirmedSeqs = new Set(); // early requests whose question has since finished
        this.status = 'idle';
        this.statusDetail = '';
        if (!silent) this.publish();
    }

    setOptions(opts = {}) {
        this.options = { ...this.options, ...opts };
        console.log(`[LiveQA] Options: double-check=${this.options.verify ? 'on' : 'off'}, call audio only=${this.options.ignoreMic ? 'on' : 'off'}`);
        this.publish();
    }

    rate(id, correct) {
        const card = this.cards.find(c => c.id === id);
        if (!card) return;
        card.rating = correct ? 'correct' : 'wrong';
        console.log(`🏷 [LiveQA] Rated ${card.rating.toUpperCase()} (#${id}, ${card.model || '?'}) | Q: ${card.question} | A: ${card.answer}`);
        this.publish();
    }

    // ---------- input filtering ----------

    rememberThem(text) {
        const now = Date.now();
        this.recentThem.push({ t: now, text });
        this.recentThem = this.recentThem.filter(x => now - x.t < 15000).slice(-30);
    }

    /** A "me" line that is really the speakers being picked up by the mic. */
    isEcho(speaker, text) {
        if (speaker !== 'Me') return false;
        const now = Date.now();
        const recent = this.recentThem.filter(x => now - x.t < 15000);
        if (!recent.length) return false;
        if (now - recent[recent.length - 1].t < 1200) return true; // call/video talking right now
        const words = new Set(normalize(text).split(' ').filter(w => w.length > 2));
        if (words.size < 2) return false;
        const themWords = new Set(normalize(recent.map(x => x.text).join(' ')).split(' '));
        let overlap = 0;
        words.forEach(w => themWords.has(w) && overlap++);
        return overlap / words.size >= 0.5;
    }

    ignored(speaker, text) {
        if (speaker === 'Me' && this.options.ignoreMic) return 'call-audio-only mode';
        if (this.isEcho(speaker, text)) return 'mic echo of the call audio';
        return '';
    }

    /** Finished sentence: does it look like a question? */
    looksLikeQuestion(text) {
        const t = (text || '').trim();
        if (t.split(/\s+/).length < 3) return false;
        const tail = lastWords(t, 25);
        if (QUESTION_RE.test(tail) || IMPERATIVE_RE.test(tail)) return true;
        if (completedQuestion(t)) return true;
        return tail.includes('?') && t.split(/\s+/).length >= 6;
    }

    /** Live text: only start early when it clearly ENDS in a complete question. */
    readyForEarlyAnswer(text) {
        const t = (text || '').trim().replace(/[\s.,;:]+$/, '');
        if (t.split(/\s+/).length < 6) return false;
        if (t.endsWith('?')) return STRONG_Q_RE.test(lastWords(t, 25)) || t.split(/\s+/).length >= 8;
        if (DANGLING_END_RE.test(t)) return false; // "…What will", "…rises by", "…name of"
        return STRONG_Q_RE.test(lastWords(t, 10));
    }

    isHard(text) {
        const t = lastWords(text, 60);
        return HARD_RE.test(t) || t.split(/\s+/).length > 25;
    }

    // ---------- timing ----------

    markTiming(seq, field) {
        if (!seq) return;
        const t = this.timing.get(seq) || {};
        if (t[field] == null) t[field] = Date.now();
        this.timing.set(seq, t);
        if (t.firstAt != null && t.endAt != null && !t.logged) {
            t.logged = true;
            const lead = t.firstAt - t.endAt;
            console.log(`⏱ [LiveQA] Answer lead vs end of question: ${lead >= 0 ? '+' : ''}${lead}ms (#${seq})`);
        }
        if (this.timing.size > 60) this.timing.delete(this.timing.keys().next().value);
    }

    // ---------- triggers ----------

    onPartial(speaker, text) {
        if (speaker === 'Them') this.rememberThem(text);
        const st = this.early[speaker] || (this.early[speaker] = {});
        st.fired = st.fired || [];
        if (this.ignored(speaker, text)) {
            clearTimeout(this.partialTimers[speaker]);
            return;
        }

        // 1) A question has been fully spoken (ends in "?", fill-in, or timer cue
        //    after it) — answer right away, even if the speaker keeps talking.
        const cq = completedQuestion(text);
        if (cq) {
            if (st.fired.some(k => sameQuestion(k, cq.question))) return; // already answering this one
            // Same question already queued: don't restart the short wait on every partial.
            if (this.pendingQ?.[speaker] && sameQuestion(this.pendingQ[speaker], cq.question)) return;
            clearTimeout(this.partialTimers[speaker]);
            this.pendingQ = { ...(this.pendingQ || {}), [speaker]: cq.question };
            this.partialTimers[speaker] = setTimeout(() => {
                this.pendingQ[speaker] = null;
                // Send the WHOLE live turn, not just the question sentence: the setup
                // ("Suppose GDP is 20, consumption is 16…") often comes several sentences before.
                this.fireEarly(speaker, lastChars(text, 2500), cq.question, true);
            }, QUICK_PAUSE_MS);
            return;
        }
        clearTimeout(this.partialTimers[speaker]);
        if (this.pendingQ) this.pendingQ[speaker] = null;

        // 2) Otherwise, only when the live text clearly ends in a question and settles.
        if (st.heard) return;
        if (!this.readyForEarlyAnswer(text)) return;
        this.partialTimers[speaker] = setTimeout(() => this.fireEarly(speaker, text.trim(), text.trim(), false), SPECULATIVE_PAUSE_MS);
    }

    fireEarly(speaker, heard, questionText, complete) {
        const st = this.early[speaker] || (this.early[speaker] = {});
        st.fired = st.fired || [];
        const skip = this.blockedReason(!complete); // a clearly finished new question skips the min-gap rule
        if (skip) {
            console.log(`[LiveQA] Skipping early answer: ${skip}`);
            return; // the finished turn will still be answered
        }
        st.heard = heard;
        st.fired.push(questionText);
        st.failed = false;
        st.seq = this.requestSeq + 1;
        console.log(`⚡ [LiveQA] Early answer from partial (${speaker}${complete ? ', question complete' : ''}): "${lastWords(questionText, 22)}"`);
        this.request({ speculative: true, heard, speaker });
    }

    onFinalTurn(speaker, text, history) {
        this.history = history;
        if (speaker !== 'Me' && SETUP_RE.test(text) && wordCount(text) >= 8) {
            this.setups = [...(this.setups || []), { text: text.trim(), at: Date.now() }].slice(-3);
        }
        if (speaker === 'Them') this.rememberThem(text);
        const st = this.early[speaker] || (this.early[speaker] = {});
        clearTimeout(this.partialTimers[speaker]);
        if (this.pendingQ) this.pendingQ[speaker] = null;
        const heardEarly = st.failed ? null : st.heard;
        const earlySeq = st.seq;
        const earlyCardId = st.cardId;
        const fired = st.failed ? [] : st.fired || [];
        this.early[speaker] = {};

        const why = this.ignored(speaker, text);
        if (why) {
            console.log(`[LiveQA] Ignoring ${why}: "${lastWords(text, 12)}"`);
            return;
        }
        if (!this.looksLikeQuestion(text)) return;

        // The last complete question in this turn was already answered early: confirm it.
        const lastQ = completedQuestion(text);
        if (lastQ && fired.some(k => sameQuestion(k, lastQ.question))) {
            console.log('[LiveQA] Final turn matches early answer, keeping it');
            this.markTiming(earlySeq, 'endAt');
            if (earlySeq) this.confirmedSeqs.add(earlySeq);
            this.confirmDraft(earlyCardId);
            return;
        }

        // The early answer already covered this question: confirm the draft.
        if (heardEarly && !lastQ) {
            const a = normalize(heardEarly);
            const b = normalize(text);
            if (b.startsWith(a.slice(0, Math.max(0, a.length - 5))) && b.length - a.length <= 40) {
                console.log('[LiveQA] Final turn matches early answer, keeping it');
                this.markTiming(earlySeq, 'endAt');
                if (earlySeq) this.confirmedSeqs.add(earlySeq); // covers an answer still on its way
                this.confirmDraft(earlyCardId);
                return;
            }
        }
        this.markTiming(this.requestSeq + 1, 'endAt');
        console.log(`▶ [LiveQA] Answering finished question (${speaker})`);
        this.request({ speculative: false, speaker, replaceCardId: earlyCardId });
    }

    setHistory(history) {
        this.history = history;
    }

    confirmDraft(cardId) {
        const card = this.cards.find(c => c.id === cardId);
        if (!card || !card.draft) return;
        card.draft = false;
        this.publish();
        if (card.status === 'done') this.maybeVerify(card);
    }

    blockedReason(speculative) { // speculative=false also used for "clearly finished new question"
        const now = Date.now();
        if (now < this.backoffUntil) return 'rate-limit back-off';
        if (speculative && now - this.lastRequestAt < MIN_GAP_MS) return 'too soon after the last request';
        return '';
    }

    // ---------- models ----------

    async groqModels(apiKey) {
        try {
            return (await listModels(apiKey)).filter(m => !this.deadModels.has(`groq/${m}`));
        } catch (_) {
            return [...new Set([...FAST_MODELS, ...SMART_MODELS])].filter(m => !this.deadModels.has(`groq/${m}`));
        }
    }

    /** Ordered models to try. `hard` routes to the smarter model first. */
    async candidates(hard) {
        const list = [];
        const add = (provider, apiKey, model, effort) => {
            if (provider && apiKey && model && !list.some(c => c.provider === provider && c.model === model)) {
                list.push({ provider, apiKey, model, effort });
            }
        };
        let keys = {};
        try {
            keys = (await modelStateService.getAllApiKeys()) || {};
        } catch (_) {}
        const selected = await modelStateService.getCurrentModelInfo('llm').catch(() => null);

        if (keys.groq) {
            const avail = await this.groqModels(keys.groq);
            const fast = FAST_MODELS.find(m => avail.includes(m));
            const smart = SMART_MODELS.find(m => avail.includes(m));
            if (hard) {
                add('groq', keys.groq, smart, 'medium');
                add('groq', keys.groq, fast, 'low');
            } else {
                add('groq', keys.groq, fast, 'low');
                add('groq', keys.groq, smart, 'low');
            }
        }
        if (selected?.apiKey) add(selected.provider, selected.apiKey, selected.model);
        if (keys.gemini) GEMINI_BACKUP_MODELS.forEach(m => add('gemini', keys.gemini, m));
        return list;
    }

    async smartModel() {
        const keys = (await modelStateService.getAllApiKeys().catch(() => ({}))) || {};
        if (!keys.groq) return null;
        const avail = await this.groqModels(keys.groq);
        const smart = SMART_MODELS.find(m => avail.includes(m));
        return smart ? { provider: 'groq', apiKey: keys.groq, model: smart, effort: 'medium' } : null;
    }

    // ---------- cards ----------

    /** A recent finished card asking essentially the same question. */
    findSimilar(question, excludeId) {
        const now = Date.now();
        return this.cards.find(c => c.id !== excludeId && now - c.updatedAt < CARD_MEMORY_MS && sameQuestion(c.question, question));
    }

    newCard(question, fields) {
        const card = {
            id: this.nextId++,
            question,
            answer: '',
            points: [],
            status: 'streaming',
            draft: false,
            verified: false,
            corrected: false,
            rating: null,
            model: '',
            firstMs: null,
            updatedAt: Date.now(),
            ...fields,
        };
        this.cards.unshift(card);
        this.cards = this.cards.slice(0, MAX_CARDS);
        return card;
    }

    removeCard(id) {
        this.cards = this.cards.filter(c => c.id !== id);
    }

    // ---------- answering ----------

    async request({ speculative, heard = '', speaker = 'Them', replaceCardId = null }) {
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

        const latest = speculative ? heard : (this.history || []).slice(-1)[0] || '';
        const hard = this.isHard(latest);
        const answered = this.cards
            .filter(c => !c.draft && Date.now() - c.updatedAt < CARD_MEMORY_MS)
            .slice(0, 6)
            .map((c, i) => `${i + 1}. ${c.question}`);
        // Recent conversation: up to 16 turns / ~3000 characters, newest kept.
        const hist = this.history || [];
        let recentTurns = [];
        let size = 0;
        for (let i = hist.length - 1; i >= 0 && recentTurns.length < 16; i--) {
            size += hist[i].length;
            if (size > 3000 && recentTurns.length >= 4) break;
            recentTurns.unshift(hist[i]);
        }
        const recent = recentTurns.join('\n');
        // Setup that has already scrolled out of the recent window (kept ~4 min).
        const setups = (this.setups || [])
            .filter(x => Date.now() - x.at < 4 * 60 * 1000 && !recent.includes(x.text.slice(0, 60)))
            .map(x => x.text);
        const user =
            `Already answered (do not answer these again, reply Q: SAME):\n${answered.length ? answered.join('\n') : '(none yet)'}\n\n` +
            (setups.length ? `Setup given earlier (later questions may refer to it):\n${setups.join('\n')}\n\n` : '') +
            `Conversation so far (most recent last):\n${recent}` +
            (speculative && heard ? `\n(still speaking, live transcript): ${heard}` : '');

        let card = null;
        let outcome = 'pending';
        let lastPush = 0;
        let usedModel = null;
        let firstMs = null;
        const render = (text, final) => {
            if (outcome === 'skip') return;
            const parsed = this.parse(text, final);
            if (parsed.none || parsed.same) {
                outcome = parsed.same ? 'same' : 'none';
                if (card && card.createdBy === seq && card.draft) this.removeCard(card.id);
                card = null;
                return;
            }
            if (!parsed.question) return; // wait until the question line is complete
            if (!card) {
                const target = replaceCardId && this.cards.find(c => c.id === replaceCardId);
                const similar = this.findSimilar(parsed.question, target?.id);
                if (similar && !similar.draft && !target) {
                    // Already answered: never overwrite a finished answer with a repeat.
                    outcome = 'skip';
                    console.log(`[LiveQA] Already answered "${similar.question}" – keeping that answer`);
                    abort.abort();
                    return;
                }
                card = target || (similar && similar.draft ? similar : null) || this.newCard(parsed.question, { createdBy: seq });
                if (card !== target && card.createdBy !== seq) card.createdBy = seq;
            }
            outcome = 'answered';
            Object.assign(card, {
                question: parsed.question,
                answer: parsed.answer,
                points: parsed.points,
                status: final ? 'done' : 'streaming',
                draft: speculative && !this.confirmedSeqs.has(seq),
                verified: false,
                corrected: false,
                model: usedModel ? usedModel.model : card.model,
                firstMs: firstMs ?? card.firstMs,
                updatedAt: Date.now(),
            });
            // Link the card to THIS utterance only if it's still the one being spoken.
            if (speculative && this.early[speaker]?.seq === seq) this.early[speaker].cardId = card.id;
            const t = Date.now();
            if (final || t - lastPush >= 60) {
                lastPush = t;
                this.publish();
            }
        };

        let lastError = null;
        const models = await this.candidates(hard);
        if (!models.length) lastError = new Error('No AI model or API key is configured.');

        // Hard question: run the quick model and the smart model AT THE SAME TIME.
        // Show the quick answer right away; the smart one confirms or corrects it.
        let smartRun = null;
        let smartInfo = null;
        if (hard && models[0]?.provider === 'groq' && models[0].effort === 'medium') {
            const fastIdx = models.findIndex((c, i) => i > 0 && c.provider === 'groq');
            if (fastIdx > 0) {
                smartInfo = models[0];
                models.unshift(models.splice(fastIdx, 1)[0]);
                smartRun = streamAnswer({
                    provider: smartInfo.provider,
                    apiKey: smartInfo.apiKey,
                    model: smartInfo.model,
                    reasoningEffort: 'medium',
                    system: SYSTEM_PROMPT,
                    user,
                    temperature: 0.2,
                    maxTokens: 1500,
                    signal: abort.signal,
                    onDelta: () => {},
                })
                    .then(full => ({ full, ms: Date.now() - startedAt }))
                    .catch(error => ({ error }));
            }
        }

        let fastDone = false;
        const downProviders = new Set(); // provider timed out / overloaded: skip its other models this time
        for (const m of models) {
            if (seq !== this.requestSeq || outcome === 'skip') break;
            if (m === smartInfo) continue; // already running in parallel
            if (downProviders.has(m.provider)) continue;
            const attempt = new AbortController();
            const onOuterAbort = () => attempt.abort();
            abort.signal.addEventListener('abort', onOuterAbort);
            let firstAt = 0;
            const timer = setTimeout(() => !firstAt && attempt.abort(), FIRST_TOKEN_TIMEOUT_MS);
            usedModel = m;
            try {
                const t0 = Date.now();
                const full = await streamAnswer({
                    provider: m.provider,
                    apiKey: m.apiKey,
                    model: m.model,
                    reasoningEffort: m.effort,
                    system: SYSTEM_PROMPT,
                    user,
                    temperature: 0.2,
                    maxTokens: m.effort === 'medium' ? 1500 : 700, // includes hidden reasoning tokens
                    signal: attempt.signal,
                    onDelta: text => {
                        if (seq !== this.requestSeq) return;
                        if (!firstAt) {
                            firstAt = Date.now();
                            firstMs = firstAt - startedAt;
                            this.markTiming(seq, 'firstAt');
                            console.log(
                                `⚡ [LiveQA] First words in ${firstMs}ms (${m.provider}/${m.model}${m.effort ? `, ${m.effort}` : ''}, ${hard ? 'hard' : 'simple'}${speculative ? ', early' : ''})`
                            );
                        }
                        render(text, false);
                    },
                });
                if (seq !== this.requestSeq) return;
                if (!full.trim()) throw new Error('Empty response');
                render(full, true);
                const p = this.parse(full, true);
                const tag = p.same ? 'SAME' : p.none ? 'NONE' : p.question;
                console.log(`📝 [LiveQA] (#${seq}) Q: ${tag} | A: ${p.answer} | ${p.points.join(' / ')}`);
                console.log(`⚡ [LiveQA] Done in ${Date.now() - startedAt}ms (attempt took ${Date.now() - t0}ms)`);
                if (smartRun) {
                    fastDone = true;
                    if (card && outcome === 'answered') {
                        card.checking = true;
                        this.publish();
                    }
                    break;
                }
                const stale = replaceCardId && this.cards.find(c => c.id === replaceCardId);
                if (stale && stale.draft && outcome !== 'answered') {
                    // The early draft guessed a question that turned out not to be one.
                    this.removeCard(replaceCardId);
                }
                this.setStatus('idle');
                if (card && outcome === 'answered' && !card.draft) this.maybeVerify(card);
                return;
            } catch (error) {
                if (outcome === 'skip') break;
                if (abort.signal.aborted || seq !== this.requestSeq) return; // superseded by a newer question
                const msg = error.name === 'AbortError' ? `no response within ${FIRST_TOKEN_TIMEOUT_MS}ms` : error.message || String(error);
                console.error(`❌ [LiveQA] ${m.provider}/${m.model} failed: ${msg.slice(0, 200)}`);
                if (/\b404\b|model_not_found|does not exist|not found/i.test(msg)) this.deadModels.add(`${m.provider}/${m.model}`);
                if (/no response within|\b5\d\d\b|overload|unavailable|ECONN|ETIMEDOUT|fetch failed/i.test(msg)) downProviders.add(m.provider);
                lastError = new Error(msg);
                if (firstAt) break; // it had started streaming; don't restart mid-answer
            } finally {
                clearTimeout(timer);
                abort.signal.removeEventListener('abort', onOuterAbort);
            }
        }

        if (outcome === 'skip') {
            this.setStatus('idle');
            return;
        }
        if (seq !== this.requestSeq) return;

        if (smartRun) {
            const r = await smartRun;
            if (seq !== this.requestSeq || outcome === 'skip') return;
            if (card) card.checking = false;
            const p = !r.error && r.full.trim() ? this.parse(r.full, true) : null;
            const smartAnswered = p && !p.none && !p.same && p.answer;
            if (r.error) console.error(`❌ [LiveQA] ${smartInfo.model} review error: ${(r.error.message || r.error).toString().slice(0, 160)}`);
            if (p) {
                const tag = p.same ? 'SAME' : p.none ? 'NONE' : p.answer;
                console.log(`🔍 [LiveQA] 120B review (#${seq}) in ${r.ms}ms: ${tag}`);
            }
            if (outcome === 'answered' && card) {
                if (smartAnswered) {
                    const quick = `${card.answer}`;
                    if (answersAgree(quick, p.answer)) {
                        card.verified = true;
                        console.log(`🔍 [LiveQA] 120B agrees (#${seq}) | ${quick}`);
                    } else {
                        console.log(`🔍 [LiveQA] 120B CORRECTED (#${seq}) | was: ${quick} | now: ${p.answer}`);
                        Object.assign(card, { answer: p.answer, points: p.points.length ? p.points : card.points, corrected: true, model: smartInfo.model });
                    }
                    card.updatedAt = Date.now();
                }
                this.publish();
                this.setStatus('idle');
                return;
            }
            if (smartAnswered && p.question) {
                // Quick model failed or said "no question" but the smart model found one.
                usedModel = smartInfo;
                firstMs = r.ms;
                render(r.full, true);
                console.log(`📝 [LiveQA] (#${seq}) Q: ${p.question} | A: ${p.answer} | ${p.points.join(' / ')}`);
                this.setStatus('idle');
                return;
            }
            if (fastDone) {
                const stale = replaceCardId && this.cards.find(c => c.id === replaceCardId);
                if (stale && stale.draft) this.removeCard(replaceCardId);
                this.setStatus('idle');
                return;
            }
        }
        if (speculative && this.early[speaker]) this.early[speaker].failed = true;
        const msg = lastError?.message || 'Unknown error';
        if (/\b429\b|rate.?limit|quota|RESOURCE_EXHAUSTED/i.test(msg) && models.length <= 1) {
            this.backoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
            this.setStatus('rate-limited');
        } else {
            this.setStatus('error', msg.slice(0, 160));
        }
    }

    /** Double-check a fast answer with the smarter model (when enabled). */
    async maybeVerify(card) {
        if (!this.options.verify || card.verified || card.corrected || card.checking) return;
        const smart = await this.smartModel();
        if (!smart || card.model === smart.model) return; // already answered by the smart model
        card.checking = true;
        this.publish();
        const startedAt = Date.now();
        const context = (this.history || []).slice(-6).join('\n');
        const proposed = `Q: ${card.question}\nA: ${card.answer}\n${card.points.map(p => `- ${p}`).join('\n')}`;
        try {
            const full = await streamAnswer({
                provider: smart.provider,
                apiKey: smart.apiKey,
                model: smart.model,
                reasoningEffort: 'medium',
                system: VERIFY_PROMPT,
                user: `Recent conversation:\n${context}\n\nProposed answer:\n${proposed}`,
                temperature: 0.1,
                maxTokens: 1500,
                onDelta: () => {},
            });
            card.checking = false;
            if (/^\s*OK\b/i.test(full)) {
                card.verified = true;
                console.log(`🔍 [LiveQA] Double-check OK in ${Date.now() - startedAt}ms (${smart.model}) | Q: ${card.question}`);
            } else {
                const p = this.parse(full, true);
                if (p.answer) {
                    console.log(`🔍 [LiveQA] Double-check CORRECTED in ${Date.now() - startedAt}ms | was: ${card.answer} | now: ${p.answer}`);
                    Object.assign(card, {
                        answer: p.answer,
                        points: p.points.length ? p.points : card.points,
                        question: p.question || card.question,
                        corrected: true,
                        model: smart.model,
                    });
                }
            }
        } catch (e) {
            card.checking = false;
            console.error(`❌ [LiveQA] Double-check failed: ${e.message}`);
        }
        card.updatedAt = Date.now();
        this.publish();
    }

    parse(text, final = true) {
        const out = { question: '', answer: '', points: [], none: false, same: false };
        const lines = (text || '').split('\n');
        const qLineDone = final || /^\s*Q\s*[:：][^\n]*\n/i.test(text || '');
        for (const raw of lines) {
            const line = raw.replace(/\*\*/g, '').replace(/^\s*[-*•]\s*(?=[QA]\s*[:：])/i, '').trim(); // "- Q: SAME"
            if (!line) continue;
            const q = line.match(/^Q\s*[:：]\s*(.*)$/i);
            const a = line.match(/^A\s*[:：]\s*(.*)$/i);
            if (q) {
                if (!qLineDone) continue;
                const v = q[1].trim();
                if (/^none\b/i.test(v)) out.none = true;
                else if (/^same\b/i.test(v)) out.same = true;
                else out.question = v;
            } else if (a) {
                out.answer = a[1].trim();
            } else if (/^[-*•]\s*/.test(line)) {
                const p = line.replace(/^[-*•]\s*/, '').trim();
                if (p) out.points.push(p);
            } else if (out.question && !out.answer) {
                out.answer = line;
            }
        }
        out.points = out.points.slice(0, 4);
        return out;
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
            options: this.options,
            cards: this.cards.map(c => ({ ...c, points: [...c.points] })),
        });
    }
}

module.exports = { LiveQA };
module.exports.completedQuestion = completedQuestion;
