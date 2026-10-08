import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';

/**
 * Answers tab: the main question being asked on the call and its answer.
 * Cards are kept (newest on top) so you can keep reading while the call goes on.
 */
export class AnswersView extends LitElement {
    static styles = css`
        :host {
            display: block;
            width: 100%;
        }

        .answers-container {
            overflow-y: auto;
            padding: 10px 14px 14px 14px;
            max-height: 620px;
            font-family: 'Helvetica Neue', sans-serif;
        }

        .answers-container::-webkit-scrollbar {
            width: 8px;
        }
        .answers-container::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.3);
            border-radius: 4px;
        }

        .status {
            display: flex;
            align-items: center;
            gap: 6px;
            color: rgba(255, 255, 255, 0.7);
            font-size: 12px;
            margin: 0 2px 8px 2px;
            min-height: 16px;
        }
        .dot {
            width: 7px;
            height: 7px;
            border-radius: 50%;
            background: #50fa7b;
            flex-shrink: 0;
        }
        .dot.thinking {
            background: #f1fa8c;
            animation: pulse 0.9s ease-in-out infinite;
        }
        .dot.warn {
            background: #ff6e6e;
        }
        @keyframes pulse {
            50% {
                opacity: 0.3;
            }
        }

        .card {
            background: rgba(255, 255, 255, 0.07);
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 10px;
            padding: 12px 14px;
            margin-bottom: 10px;
            user-select: text;
            cursor: text;
        }
        .card.latest {
            background: rgba(255, 255, 255, 0.12);
            border-color: rgba(139, 233, 253, 0.55);
        }
        .card.older {
            opacity: 0.75;
        }

        .question {
            color: #8be9fd;
            font-size: 14px;
            font-weight: 600;
            line-height: 1.35;
            margin-bottom: 8px;
        }

        .answer {
            color: #ffffff;
            font-size: 16px;
            font-weight: 600;
            line-height: 1.4;
            margin-bottom: 6px;
        }

        .points {
            margin: 0;
            padding-left: 18px;
        }
        .points li {
            color: rgba(255, 255, 255, 0.92);
            font-size: 14px;
            line-height: 1.45;
            margin: 3px 0;
        }

        .cursor::after {
            content: '▍';
            color: #8be9fd;
            animation: pulse 0.8s steps(1) infinite;
            margin-left: 2px;
        }

        .toolbar {
            display: flex;
            gap: 14px;
            align-items: center;
            margin: 0 2px 10px 2px;
            color: rgba(255, 255, 255, 0.8);
            font-size: 12px;
        }
        .toolbar label {
            display: flex;
            align-items: center;
            gap: 5px;
            cursor: pointer;
            user-select: none;
        }
        .toolbar input {
            accent-color: #8be9fd;
            cursor: pointer;
        }

        .card-head {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 8px;
            margin-bottom: 6px;
        }
        .badges {
            display: flex;
            gap: 5px;
            flex-wrap: wrap;
        }
        .badge {
            font-size: 10.5px;
            font-weight: 600;
            padding: 2px 7px;
            border-radius: 999px;
            background: rgba(255, 255, 255, 0.12);
            color: rgba(255, 255, 255, 0.85);
            white-space: nowrap;
        }
        .badge.draft {
            background: rgba(241, 250, 140, 0.18);
            color: #f1fa8c;
        }
        .badge.checked {
            background: rgba(80, 250, 123, 0.18);
            color: #50fa7b;
        }
        .badge.corrected {
            background: rgba(255, 184, 108, 0.2);
            color: #ffb86c;
        }
        .meta {
            font-size: 10.5px;
            color: rgba(255, 255, 255, 0.5);
            white-space: nowrap;
        }
        .card.draft {
            border-style: dashed;
        }

        .rate {
            display: flex;
            gap: 6px;
            justify-content: flex-end;
            margin-top: 8px;
        }
        .rate button {
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid rgba(255, 255, 255, 0.15);
            color: rgba(255, 255, 255, 0.75);
            border-radius: 6px;
            font-size: 12px;
            padding: 2px 10px;
            cursor: pointer;
        }
        .rate button:hover {
            background: rgba(255, 255, 255, 0.16);
        }
        .rate button.on.good {
            background: rgba(80, 250, 123, 0.25);
            border-color: #50fa7b;
            color: #ffffff;
        }
        .rate button.on.bad {
            background: rgba(255, 110, 110, 0.25);
            border-color: #ff6e6e;
            color: #ffffff;
        }

        .empty-state {
            color: rgba(255, 255, 255, 0.65);
            font-size: 13px;
            line-height: 1.5;
            text-align: center;
            padding: 28px 12px;
        }
    `;

    static properties = {
        cards: { type: Array },
        status: { type: String },
        detail: { type: String },
        isVisible: { type: Boolean },
        options: { type: Object },
    };

    constructor() {
        super();
        this.cards = [];
        this.status = 'idle';
        this.detail = '';
        this.isVisible = true;
        this.options = this._loadOptions();
        this._onQa = this._onQa.bind(this);
    }

    _loadOptions() {
        try {
            return { verify: false, ignoreMic: false, ...JSON.parse(localStorage.getItem('qaOptions') || '{}') };
        } catch (_) {
            return { verify: false, ignoreMic: false };
        }
    }

    _setOption(key, value) {
        this.options = { ...this.options, [key]: value };
        try {
            localStorage.setItem('qaOptions', JSON.stringify(this.options));
        } catch (_) {}
        window.api?.listenView?.qaSetOptions?.(this.options);
    }

    _rate(card, correct) {
        // Clicking the same choice again clears nothing on the main side; keep it simple.
        window.api?.listenView?.qaRate?.(card.id, correct);
    }

    connectedCallback() {
        super.connectedCallback();
        window.api?.listenView?.onQaUpdate(this._onQa);
        // Push saved settings to the main process on start.
        window.api?.listenView?.qaSetOptions?.(this.options);
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        window.api?.listenView?.removeOnQaUpdate(this._onQa);
    }

    _onQa(event, data) {
        const prevCount = this.cards.length;
        this.cards = data?.cards || [];
        this.status = data?.status || 'idle';
        this.detail = data?.detail || '';
        this.dispatchEvent(
            new CustomEvent('qa-updated', {
                detail: { newCard: this.cards.length > prevCount },
                bubbles: true,
                composed: true,
            })
        );
    }

    resetAnswers() {
        this.cards = [];
        this.status = 'idle';
        this.detail = '';
    }

    getAnswersText() {
        return this.cards
            .map(c => `Q: ${c.question}\nA: ${c.answer}\n${c.points.map(p => `- ${p}`).join('\n')}`)
            .join('\n\n');
    }

    renderStatus() {
        const map = {
            idle: ['', 'Listening for questions…'],
            thinking: ['thinking', 'Answering…'],
            'rate-limited': ['warn', 'Rate limited by the AI provider. Pausing briefly.'],
            error: ['warn', `Error: ${this.detail}`],
        };
        const [cls, text] = map[this.status] || map.idle;
        return html`<div class="status"><span class="dot ${cls}"></span><span>${text}</span></div>`;
    }

    renderCard(c, i) {
        const short = (c.model || '').replace(/^openai\//, '').replace(/-versatile|-instant/, '');
        const badges = [];
        if (c.draft) badges.push(html`<span class="badge draft">Draft – still listening</span>`);
        if (c.checking) badges.push(html`<span class="badge">Double-checking…</span>`);
        if (c.verified) badges.push(html`<span class="badge checked">✓ Double-checked</span>`);
        if (c.corrected) badges.push(html`<span class="badge corrected">✎ Corrected</span>`);
        return html`
            <div class="card ${i === 0 ? 'latest' : 'older'} ${c.draft ? 'draft' : ''}">
                <div class="card-head">
                    <div class="badges">${badges}</div>
                    <div class="meta">${short}${c.firstMs != null ? ` · ${(c.firstMs / 1000).toFixed(2)}s` : ''}</div>
                </div>
                <div class="question">${c.question}</div>
                <div class="answer ${c.status === 'streaming' && !c.points.length ? 'cursor' : ''}">${c.answer || '…'}</div>
                ${c.points.length
                    ? html`<ul class="points ${c.status === 'streaming' ? 'cursor' : ''}">
                          ${c.points.map(p => html`<li>${p}</li>`)}
                      </ul>`
                    : ''}
                ${c.status === 'done'
                    ? html`<div class="rate">
                          <button class="good ${c.rating === 'correct' ? 'on' : ''}" title="Glass was right" @click=${() => this._rate(c, true)}>✓ Right</button>
                          <button class="bad ${c.rating === 'wrong' ? 'on' : ''}" title="Glass was wrong" @click=${() => this._rate(c, false)}>✗ Wrong</button>
                      </div>`
                    : ''}
            </div>
        `;
    }

    render() {
        if (!this.isVisible) return html``;

        return html`
            <div class="answers-container">
                <div class="toolbar">
                    <label title="After a fast answer, check it with the smarter model and fix it if needed (uses an extra request).">
                        <input type="checkbox" .checked=${!!this.options.verify} @change=${e => this._setOption('verify', e.target.checked)} />
                        Double-check answers
                    </label>
                    <label title="Ignore your microphone; only answer questions from the call / computer audio.">
                        <input type="checkbox" .checked=${!!this.options.ignoreMic} @change=${e => this._setOption('ignoreMic', e.target.checked)} />
                        Call audio only
                    </label>
                </div>
                ${this.renderStatus()}
                ${this.cards.length === 0
                    ? html`<div class="empty-state">When someone asks a question, the main question and its answer will appear here and stay on screen.</div>`
                    : this.cards.map((c, i) => this.renderCard(c, i))}
            </div>
        `;
    }
}

customElements.define('answers-view', AnswersView);
