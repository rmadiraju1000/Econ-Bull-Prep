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
    };

    constructor() {
        super();
        this.cards = [];
        this.status = 'idle';
        this.detail = '';
        this.isVisible = true;
        this._onQa = this._onQa.bind(this);
    }

    connectedCallback() {
        super.connectedCallback();
        window.api?.listenView?.onQaUpdate(this._onQa);
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
            'rate-limited': ['warn', 'Rate limited by the AI provider. Pausing briefly (switch to Groq in Settings).'],
            error: ['warn', `Error: ${this.detail}`],
        };
        const [cls, text] = map[this.status] || map.idle;
        return html`<div class="status"><span class="dot ${cls}"></span><span>${text}</span></div>`;
    }

    render() {
        if (!this.isVisible) return html``;

        return html`
            <div class="answers-container">
                ${this.renderStatus()}
                ${this.cards.length === 0
                    ? html`<div class="empty-state">When someone asks a question, the main question and its answer will appear here and stay on screen.</div>`
                    : this.cards.map(
                          (c, i) => html`
                              <div class="card ${i === 0 ? 'latest' : 'older'}">
                                  <div class="question">${c.question}</div>
                                  <div class="answer ${c.status === 'streaming' && !c.points.length ? 'cursor' : ''}">
                                      ${c.answer || '…'}
                                  </div>
                                  ${c.points.length
                                      ? html`<ul class="points ${c.status === 'streaming' ? 'cursor' : ''}">
                                            ${c.points.map(p => html`<li>${p}</li>`)}
                                        </ul>`
                                      : ''}
                              </div>
                          `
                      )}
            </div>
        `;
    }
}

customElements.define('answers-view', AnswersView);
