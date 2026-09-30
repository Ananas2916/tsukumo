/**
 * Primo avvio: una presentazione in sei passi dentro il pannello.
 *
 * 1. chi e' e come si usa (tasto destro, doppio click, trascinarla);
 * 2. come la vuoi: con il corpo (il VRM, e la fiammella quando vuoi) o solo
 *    la fiammella, senza corpo: il VRM allora non si carica nemmeno. Si
 *    vede subito sul personaggio: esce dal corpo, o ci rientra;
 * 3. come ti chiami (diventa un ricordo, vedi backend/memory.py) e il suo nome;
 * 4. il cervello, fra quelli trovati sul PC (backend/llm/detect.py): si
 *    aspetta che il riconoscimento finisca, appena installata e' ancora li';
 * 5. "ti preparo tutto": con un clic l'ascolto (installa Faster-Whisper se
 *    manca), gli avvisi di Claude Code e Codex, i limiti di Claude Code, e la
 *    voce da ascoltare. Ogni voce si puo' togliere prima di premere;
 * 6. fatto: ti saluta per nome.
 *
 * Ogni passo si puo' saltare, e tutto si cambia dopo dalle schede. Riparte
 * dalla scheda Personaggio ("Rifai la presentazione").
 */

import { apiUrl } from '../config.js';
import { el, readSetting, writeSetting } from '../dom.js';
import { icon } from '../icons.js';
import { applyForm, currentForm } from './character.js';

export const ONBOARDED = 'dc:onboarded';

const TIPS = [
  { icon: 'dots', text: 'Tasto destro su di lei: comandi, voce, microfono.' },
  { icon: 'chat', text: 'Doppio click: le scrivi. Oppure parlale a voce.' },
  { icon: 'hand', text: 'Trascinala dove vuoi: si siede anche sulle finestre.' },
];

const FORMS = [
  {
    value: 'vrm',
    icon: 'character',
    title: 'Con il corpo',
    text: 'Il personaggio 3D. Quando vuoi diventa una fiammella e poi ci rientra.',
  },
  {
    value: 'spirit',
    icon: 'flame',
    title: 'Solo la fiammella',
    text: 'Niente modello 3D: più leggera per il PC. Il corpo si aggiunge quando vuoi.',
  },
];

const GREETING = {
  it: (user, name) => (user ? `Piacere, ${user}! Io sono ${name}. Quando hai bisogno, sono qui.` : `Eccomi! Io sono ${name}. Quando hai bisogno, sono qui.`),
  en: (user, name) => (user ? `Nice to meet you, ${user}! I'm ${name}. I'm here whenever you need me.` : `Here I am! I'm ${name}. I'm here whenever you need me.`),
};

/** Quanto aspettare il riconoscimento dei cervelli prima di mostrare cosa c'e' (s). */
const DETECT_WAIT = 12;

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    return [() => this._intro(), () => this._form(), () => this._names(), () => this._brain(), () => this._setup(), () => this._done()];
  }

  async _render() {
    const steps = this._steps();
    const step = this.step;
    const body = await steps[step]();
    if (!this.node || step !== this.step) return;
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
        'Vivo sulla tua scrivania e sono la voce e la faccia del cervello che scegli: un agente come Claude Code, Codex o Antigravity, un modello sul tuo PC o un servizio in rete.',
      ),
      el('ul', { class: 'welcome-tips' }, ...TIPS.map((tip) => el('li', {}, icon(tip.icon, 16), el('span', {}, tip.text)))),
      this._footer(() => this._go(1), { nextLabel: 'Cominciamo' }),
    );
  }

  /** Con il corpo o solo la fiammella: si vede subito sul personaggio. */
  async _form() {
    let chosen = currentForm() === 'spirit' ? 'spirit' : 'vrm';
    const list = el('div', { class: 'welcome-forms' });
    const render = () => {
      list.replaceChildren(
        ...FORMS.map((form) =>
          el(
            'button',
            {
              type: 'button',
              class: `welcome-form${form.value === chosen ? ' on' : ''}`,
              'aria-pressed': String(form.value === chosen),
              onClick: () => {
                if (form.value === chosen) return;
                chosen = form.value;
                applyForm(chosen);
                this.app.companion?.sendToPet({ type: 'form', value: chosen });
                render();
              },
            },
            icon(form.icon, 30),
            el('strong', {}, form.title),
            el('small', {}, form.text),
          ),
        ),
      );
    };
    render();
    return el(
      'div',
      { class: 'welcome-step' },
      el('h2', {}, 'Come mi vuoi?'),
      el('p', {}, 'Scegli e guardami: cambio subito. Si può rifare quando vuoi da Personaggio → Aspetto.'),
      list,
      this._footer(() => this._go(1)),
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

  /** Il passo si mostra subito e si riempie quando il backend ha finito di guardare cosa c'e' sul PC. */
  async _brain() {
    const intro = el('p', {}, 'Guardo cosa c’è sul tuo PC…');
    const list = el('div', { class: 'welcome-choices' });
    const status = el('p', { class: 'hint' });
    const node = el(
      'div',
      { class: 'welcome-step' },
      el('h2', {}, 'Il cervello'),
      intro,
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
    this._fillBrain(intro, list, status);
    return node;
  }

  async _fillBrain(intro, list, status) {
    let data;
    try {
      await request(`/api/setup?wait=${DETECT_WAIT}`).catch(() => null);
      data = await request('/api/providers');
    } catch (error) {
      intro.textContent = 'Non riesco a parlare col backend.';
      status.textContent = error.message;
      status.classList.add('error');
      return;
    }
    const specs = new Map((data.providers?.llm ?? []).map((spec) => [spec.id, spec]));
    const found = Object.entries(data.detected?.llm ?? {})
      .filter(([, result]) => result?.found)
      .map(([id]) => specs.get(id))
      .filter(Boolean);
    let selected = data.selected?.llm;
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
    intro.textContent = found.length
      ? 'Sul tuo PC ho trovato questi. Scegline uno: gli altri (e i servizi in rete) sono nella scheda Motori.'
      : 'Non ho trovato agenti o modelli sul PC. Nella scheda Motori puoi collegarne uno: Claude Code, Codex, LM Studio, Ollama o una chiave di un servizio.';
    const current = specs.get(selected);
    status.textContent = current ? `Adesso uso ${current.label}.` : '';
  }

  /**
   * "Ti preparo tutto": quello che si puo' fare da soli, con un clic. Tocca
   * file fuori da Tsukumo (le impostazioni degli agenti) solo per le voci
   * lasciate spuntate, e ognuna dice cosa fa.
   */
  async _setup() {
    let data = null;
    try {
      data = await request('/api/setup');
    } catch (error) {
      return el('div', { class: 'welcome-step' }, el('h2', {}, 'Ti preparo tutto'), el('p', { class: 'hint error' }, error.message), this._footer(() => this._go(1)));
    }
    const integrations = data.integrations ?? {};
    const listening = data.listening ?? {};
    const tasks = [];
    const rows = [];

    const addTask = ({ id, title, text, done, disabled, run }) => {
      const check = el('input', { type: 'checkbox', checked: done || !disabled, disabled: done || disabled });
      const state = el('span', { class: `setup-state${done ? ' ok' : ''}` }, done ? 'fatto' : '');
      const detail = el('small', {}, text);
      rows.push(el('label', { class: 'setup-item' }, check, el('span', { class: 'integration-text' }, el('strong', {}, title), detail), state));
      if (!done && !disabled) tasks.push({ id, check, state, detail, run });
    };

    // Ascolto -----------------------------------------------------------------
    addTask({
      id: 'listening',
      title: 'Ascoltarti a voce',
      text: listening.on
        ? 'Già acceso: Ctrl+Spazio e parlami.'
        : listening.local
          ? 'Faster-Whisper c’è già: lo accendo. Il modello si scarica la prima volta (circa 150 MB).'
          : 'Installo Faster-Whisper e il suo modello, sul PC: circa 300 MB, una volta sola. Niente cloud.',
      done: listening.on,
      run: (task) => this._enableListening(task),
    });

    // Agenti --------------------------------------------------------------------
    const integration = (id, title, text) => {
      const item = integrations[id];
      if (!item?.available) return;
      addTask({
        id,
        title,
        text: item.conflict ? 'Ha già un suo comando di avviso: non lo tocco.' : text,
        done: item.installed,
        disabled: item.conflict,
        run: async () => {
          const result = await request('/api/integrations', 'POST', { tool: id, action: 'install' });
          if (!result.ok) throw new Error(result.error ?? 'non riuscito');
        },
      });
    };
    integration('claude', 'Avvisi da Claude Code', 'Ti chiamo quando finisce un lavoro o ti aspetta. Aggiunge due hook a ~/.claude/settings.json (con una copia).');
    integration('codex', 'Avvisi da Codex', 'Ti chiamo quando finisce. Aggiunge una riga a ~/.codex/config.toml (con una copia).');
    integration(
      'claude_usage',
      'Limiti di Claude Code',
      integrations.claude_usage?.wraps
        ? 'Ti dico quanto resta del piano. La tua barra di stato resta com’è: la nostra la mostra uguale.'
        : 'Ti dico quanto resta del piano (Pro o Max, usando Claude Code nel terminale). Aggiunge a Claude Code una barra di stato con modello, contesto e limiti.',
    );
    if (integrations.codex?.available) {
      rows.push(
        el(
          'div',
          { class: 'setup-item' },
          icon('check', 16),
          el('span', { class: 'integration-text' }, el('strong', {}, 'Consumi di Codex'), el('small', {}, 'Li leggo dai suoi log: non serve collegare niente.')),
        ),
      );
    }

    // Voce ---------------------------------------------------------------------
    const settings = this.app.settings ?? {};
    const voice = (this.app.voices ?? []).find((item) => item.id === settings.voice);
    const engine = this.app.engines?.tts?.label ?? settings.ttsEngine;
    const language = (settings.voiceLanguage || 'it').startsWith('it') ? 'it' : 'en';
    const sample = language === 'it' ? `Ciao! Io sono ${this.herName}, e questa è la mia voce.` : `Hi! I'm ${this.herName}, and this is my voice.`;
    rows.push(
      el(
        'div',
        { class: 'setup-item' },
        icon('volume', 16),
        el(
          'span',
          { class: 'integration-text' },
          el('strong', {}, 'La mia voce'),
          el('small', {}, voice ? `${voice.name ?? voice.id}${engine ? `, con ${engine}` : ''}. Si cambia da Personaggio.` : 'Si sceglie nella scheda Personaggio.'),
        ),
        el('button', { class: 'btn', type: 'button', onClick: () => this.app.socket.say(sample) }, icon('play', 14), el('span', {}, 'Ascoltala')),
      ),
    );

    // Il bottone principale fa tutto; finito (o se non c'e' niente da fare) diventa "Avanti".
    const summary = el('p', { class: 'hint' });
    let prepared = false;
    const footer = this._footer(async () => {
      if (prepared || !tasks.some((task) => task.check.checked && !task.check.disabled)) {
        this._go(1);
        return;
      }
      const primary = footer.querySelector('.btn.primary');
      primary.disabled = true;
      primary.querySelector('span').textContent = 'Preparo…';
      const failed = await runTasks();
      primary.disabled = false;
      prepared = !failed;
      primary.querySelector('span').textContent = failed ? 'Riprova' : 'Avanti';
    }, { nextLabel: tasks.length ? 'Prepara tutto' : 'Avanti' });
    const runTasks = async () => {
      const chosen = tasks.filter((task) => task.check.checked && !task.check.disabled);
      let failed = 0;
      for (const task of chosen) {
        task.check.disabled = true;
        task.state.className = 'setup-state';
        task.state.textContent = '…';
        try {
          await task.run(task);
          task.state.className = 'setup-state ok';
          task.state.textContent = 'fatto';
        } catch (error) {
          failed += 1;
          task.state.className = 'setup-state error';
          task.state.textContent = 'errore';
          task.detail.textContent = error.message;
          task.check.disabled = false;
        }
      }
      summary.textContent = failed ? 'Qualcosa non è andato: puoi riprovare, o sistemarlo dopo dalle schede.' : 'Tutto pronto!';
      return failed;
    };

    return el(
      'div',
      { class: 'welcome-step' },
      el('h2', {}, 'Ti preparo tutto'),
      el('p', {}, 'Quello che posso sistemare da sola, con un clic. Togli la spunta a quello che non vuoi.'),
      el('div', { class: 'setup-list' }, ...rows),
      summary,
      footer,
    );
  }

  /** L'ascolto: il backend installa, sceglie e prepara il modello; qui si segue come va. */
  async _enableListening(task) {
    let job = (await request('/api/setup/listening', 'POST')).job;
    const deadline = Date.now() + 30 * 60_000;
    while (['selecting', 'installing', 'loading'].includes(job?.state) && Date.now() < deadline) {
      if (job.detail) task.detail.textContent = job.detail;
      await sleep(1500);
      job = (await request('/api/setup')).listening?.job;
    }
    if (job?.state !== 'done') throw new Error(job?.detail || 'non è partito');
    task.detail.textContent = job.detail;
  }

  async _done() {
    return el(
      'div',
      { class: 'welcome-step' },
      el('h2', {}, 'Tutto pronto'),
      el(
        'p',
        {},
        'Chiedimi quello che vuoi. Posso ricordarti le cose («tra 20 minuti ricordami di bere»), ricordarmi di te («ricordati che…»), avvisarti quando Claude Code o Codex hanno finito e dirti quanto ti resta dei loro limiti: è tutto nella scheda Lavoro.',
      ),
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
