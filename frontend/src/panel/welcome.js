/**
 * Primo avvio: una presentazione in cinque passi dentro il pannello.
 *
 * 1. chi e' e come si usa (tasto destro, doppio click, trascinarla);
 * 2. come ti chiami (diventa un ricordo, vedi backend/memory.py) e il suo nome;
 * 3. il cervello, fra quelli trovati sul PC (backend/llm/detect.py);
 * 4. la voce, da ascoltare subito;
 * 5. fatto: ti saluta per nome.
 *
 * Ogni passo si puo' saltare, e tutto si cambia dopo dalle schede. Riparte
 * dalla scheda Personaggio ("Rifai la presentazione").
 */

import { apiUrl } from '../config.js';
import { el, readSetting, writeSetting } from '../dom.js';
import { icon } from '../icons.js';

export const ONBOARDED = 'dc:onboarded';

const TIPS = [
  { icon: 'dots', text: 'Tasto destro su di lei: comandi, voce, microfono.' },
  { icon: 'chat', text: 'Doppio click: le scrivi. Oppure parlale a voce.' },
  { icon: 'hand', text: 'Trascinala dove vuoi: si siede anche sulle finestre.' },
];

const GREETING = {
  it: (user, name) => (user ? `Piacere, ${user}! Io sono ${name}. Quando hai bisogno, sono qui.` : `Eccomi! Io sono ${name}. Quando hai bisogno, sono qui.`),
  en: (user, name) => (user ? `Nice to meet you, ${user}! I'm ${name}. I'm here whenever you need me.` : `Here I am! I'm ${name}. I'm here whenever you need me.`),
};

async function request(path, method = 'GET', body) {
  const response = await fetch(apiUrl(path), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail ?? `HTTP ${response.status}`);
  return data;
}

export class Welcome {
  /**
   * @param {object} app lo stato del pannello (socket, showTab, settings...)
   * @param {HTMLElement} host dove appoggiare il riquadro (la finestra del pannello)
   */
  constructor(app, host) {
    this.app = app;
    this.host = host;
    this.step = 0;
    this.node = null;
    this.userName = '';
    this.herName = 'Tsukumo';
  }

  /** Al primo avvio (o se richiesto) apre la presentazione. */
  maybeStart() {
    if (!readSetting(ONBOARDED, false)) this.start();
  }

  start() {
    this.step = 0;
    this.node?.remove();
    this.node = el('div', { class: 'welcome', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Benvenuto' });
    this.host.append(this.node);
    this._render();
  }

  finish() {
    writeSetting(ONBOARDED, true);
    this.node?.remove();
    this.node = null;
  }

  _steps() {
    return [() => this._intro(), () => this._names(), () => this._brain(), () => this._voice(), () => this._done()];
  }

  async _render() {
    const steps = this._steps();
    const body = await steps[this.step]();
    if (!this.node) return;
    const dots = el(
      'div',
      { class: 'welcome-dots' },
      ...steps.map((_, index) => el('i', { class: index === this.step ? 'on' : index < this.step ? 'done' : '' })),
    );
    this.node.replaceChildren(el('div', { class: 'welcome-card' }, dots, body));
  }

  _go(delta) {
    this.step = Math.max(0, Math.min(this._steps().length - 1, this.step + delta));
    this._render();
  }

  _footer(next, { nextLabel = 'Avanti', skip = true } = {}) {
    return el(
      'div',
      { class: 'welcome-actions' },
      skip ? el('button', { class: 'link-btn', type: 'button', title: 'Salta la presentazione', onClick: () => this.finish() }, 'Salta') : el('span'),
      el('span', { class: 'spacer' }),
      this.step > 0 ? el('button', { class: 'btn', type: 'button', onClick: () => this._go(-1) }, 'Indietro') : null,
      el('button', { class: 'btn primary', type: 'button', onClick: next }, el('span', {}, nextLabel), icon('chevronRight', 15)),
    );
  }

  // ---------------------------------------------------------------- passi
  async _intro() {
    try {
      this.herName = (await request('/api/memory')).persona?.name || this.herName;
    } catch {
      /* il backend sta ancora partendo: resta il nome di default */
    }
    return el(
      'div',
      { class: 'welcome-step' },
      el('h2', {}, `Ciao! Sono ${this.herName}.`),
      el(
        'p',
        {},
        'Vivo sulla tua scrivania e sono la voce e la faccia del cervello che scegli: un agente come Claude Code, Codex o OpenClaw, un modello sul tuo PC o un servizio in rete.',
      ),
      el('ul', { class: 'welcome-tips' }, ...TIPS.map((tip) => el('li', {}, icon(tip.icon, 16), el('span', {}, tip.text)))),
      this._footer(() => this._go(1), { nextLabel: 'Cominciamo' }),
    );
  }

  async _names() {
    const user = el('input', { class: 'field-input', type: 'text', maxlength: 40, placeholder: 'Il tuo nome', value: this.userName });
    const her = el('input', { class: 'field-input', type: 'text', maxlength: 40, placeholder: 'Tsukumo', value: this.herName });
    const next = async () => {
      this.userName = user.value.trim();
      const name = her.value.trim() || 'Tsukumo';
      try {
        if (name !== this.herName) await request('/api/memory/persona', 'PUT', { name });
        this.herName = name;
        // Il nome diventa un ricordo: vale per ogni cervello, anche cambiandolo.
        if (this.userName) await request('/api/memory/facts', 'POST', { text: `Si chiama ${this.userName}` }).catch(() => {});
      } catch (error) {
        this.app.toast?.(error.message, 'error');
      }
      this._go(1);
    };
    setTimeout(() => user.focus(), 50);
    user.addEventListener('keydown', (event) => event.key === 'Enter' && next());
    return el(
      'div',
      { class: 'welcome-step' },
      el('h2', {}, 'Come ti chiami?'),
      el('p', {}, 'Me lo ricordo, qualunque cervello userai. Puoi anche darmi un altro nome.'),
      el('label', { class: 'row' }, el('span', { class: 'row-label' }, 'Tu'), user),
      el('label', { class: 'row' }, el('span', { class: 'row-label' }, 'Io'), her),
      this._footer(next),
    );
  }

  async _brain() {
    let data = null;
    try {
      data = await request('/api/providers');
    } catch (error) {
      return el('div', { class: 'welcome-step' }, el('h2', {}, 'Il cervello'), el('p', { class: 'hint error' }, error.message), this._footer(() => this._go(1)));
    }
    const specs = new Map((data.providers?.llm ?? []).map((spec) => [spec.id, spec]));
    const found = Object.entries(data.detected?.llm ?? {})
      .filter(([, result]) => result?.found)
      .map(([id]) => specs.get(id))
      .filter(Boolean);
    let selected = data.selected?.llm;
    const list = el('div', { class: 'welcome-choices' });
    const status = el('p', { class: 'hint' });
    const render = () => {
      list.replaceChildren(
        ...found.map((spec) =>
          el(
            'button',
            {
              type: 'button',
              class: `welcome-choice${spec.id === selected ? ' on' : ''}`,
              onClick: async () => {
                status.textContent = `Collego ${spec.label}…`;
                try {
                  const result = await request('/api/providers', 'POST', { kind: 'llm', provider: spec.id, options: {} });
                  if (!result.ok) throw new Error(result.error ?? 'non risponde');
                  selected = spec.id;
                  status.textContent = `${spec.label} è il mio cervello.`;
                } catch (error) {
                  status.textContent = `${spec.label}: ${error.message}`;
                }
                render();
              },
            },
            el('strong', {}, spec.label),
            el('small', {}, spec.tagline ?? ''),
          ),
        ),
      );
    };
    render();
    const current = specs.get(selected);
    status.textContent = current ? `Adesso uso ${current.label}.` : '';
    return el(
      'div',
      { class: 'welcome-step' },
      el('h2', {}, 'Il cervello'),
      el(
        'p',
        {},
        found.length
          ? 'Sul tuo PC ho trovato questi. Scegline uno: gli altri (e i servizi in rete) sono nella scheda Motori.'
          : 'Non ho trovato agenti o modelli sul PC. Nella scheda Motori puoi collegarne uno: Claude Code, Codex, LM Studio, Ollama o una chiave di un servizio.',
      ),
      list,
      status,
      el(
        'button',
        { class: 'link-btn', type: 'button', onClick: () => this.app.showTab?.('engines', { section: 'llm' }) },
        'Tutti i cervelli, in Motori',
        icon('chevronRight', 14),
      ),
      this._footer(() => this._go(1)),
    );
  }

  async _voice() {
    const settings = this.app.settings ?? {};
    const voice = (this.app.voices ?? []).find((item) => item.id === settings.voice);
    const engine = this.app.engines?.tts?.label ?? settings.ttsEngine;
    const language = (settings.voiceLanguage || 'it').startsWith('it') ? 'it' : 'en';
    const sample = language === 'it' ? `Ciao! Io sono ${this.herName}, e questa è la mia voce.` : `Hi! I'm ${this.herName}, and this is my voice.`;
    return el(
      'div',
      { class: 'welcome-step' },
      el('h2', {}, 'La mia voce'),
      el('p', {}, voice ? `Sto usando ${voice.name ?? voice.id}${engine ? `, con ${engine}` : ''}.` : 'La voce si sceglie nella scheda Personaggio.'),
      el(
        'div',
        { class: 'welcome-row' },
        el('button', { class: 'btn', type: 'button', onClick: () => this.app.socket.say(sample) }, icon('play', 15), el('span', {}, 'Ascoltala')),
        el('button', { class: 'btn', type: 'button', onClick: () => this.app.showTab?.('character') }, icon('volume', 15), el('span', {}, 'Cambia voce')),
      ),
      el('p', { class: 'hint' }, 'Per parlarle a voce scegli un motore di ascolto in Motori → Ascolto; poi Ctrl+Spazio, o l’ascolto continuo.'),
      this._footer(() => this._go(1)),
    );
  }

  async _done() {
    return el(
      'div',
      { class: 'welcome-step' },
      el('h2', {}, 'Tutto pronto'),
      el('p', {}, 'Chiedimi quello che vuoi. Posso anche ricordarti le cose («tra 20 minuti ricordami di bere»), ricordarmi di te («ricordati che…») e avvisarti quando Claude Code o Codex hanno finito.'),
      this._footer(
        () => {
          const language = (this.app.settings?.voiceLanguage || 'it').startsWith('it') ? 'it' : 'en';
          this.app.socket.say(GREETING[language](this.userName, this.herName));
          this.app.companion?.sendToPet({ type: 'greet' });
          this.finish();
        },
        { nextLabel: 'Andiamo', skip: false },
      ),
    );
  }
}
