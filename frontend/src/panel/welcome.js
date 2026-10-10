/**
 * First start: a six-step introduction inside the panel.
 *
 * 1. who she is and how to use her (right-click, double click, dragging her);
 * 2. her colour: she changes right away, on the desktop;
 * 3. your name (it becomes a memory, see backend/memory.py) and hers;
 * 4. the brain, among those found on the PC (backend/llm/detect.py): it
 *    waits for the detection to finish, right after install it's still there;
 * 5. "I'll set everything up": with one click listening (installs
 *    Faster-Whisper if missing), Claude Code and Codex notifications, Claude
 *    Code's limits, and the voice to listen to. Each item can be removed
 *    before pressing;
 * 6. done: she greets you by name.
 *
 * Every step can be skipped, and everything can be changed later from the
 * tabs. It starts again from the Character tab ("Redo the introduction").
 */

import { apiUrl } from '../config.js';
import { el, readSetting, writeSetting } from '../dom.js';
import { t, tx } from '../i18n.js';
import { paletteKey, PALETTE_LABELS, swatchColor } from '../flame/palettes.js';
import { icon } from '../icons.js';

export const ONBOARDED = 'dc:onboarded';

const TIPS = [
  { icon: 'dots', text: t('Right-click on her: commands, voice, microphone.') },
  { icon: 'chat', text: t('Double click: write to her. Or talk to her.') },
  { icon: 'hand', text: t('Drag her wherever you like, or throw her: she bounces off the edges and sits on windows.') },
  { icon: 'clip', text: t('Drop a file on her: she eats it and passes it to her brain.') },
];

/** Her named colours (flame/palettes.js), with the swatch colour. */
const COLORS = Object.entries(PALETTE_LABELS).map(([value, label]) => ({ value, label, swatch: swatchColor(value) }));

const GREETING = {
  it: (user, name) => (user ? `Piacere, ${user}! Io sono ${name}. Quando hai bisogno, sono qui.` : `Eccomi! Io sono ${name}. Quando hai bisogno, sono qui.`),
  en: (user, name) => (user ? `Nice to meet you, ${user}! I'm ${name}. I'm here whenever you need me.` : `Here I am! I'm ${name}. I'm here whenever you need me.`),
};

/** How long to wait for the brain detection before showing what's there (s). */
const DETECT_WAIT = 12;

async function request(path, method = 'GET', body) {
  const response = await fetch(apiUrl(path), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(tx(data.detail) ?? `HTTP ${response.status}`);
  return data;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Welcome {
  /**
   * @param {object} app the panel's state (socket, showTab, settings...)
   * @param {HTMLElement} host where to place the card (the panel's window)
   */
  constructor(app, host) {
    this.app = app;
    this.host = host;
    this.step = 0;
    this.node = null;
    this.userName = '';
    this.herName = 'Tsukumo';
  }

  /** At first start (or on request) it opens the introduction. */
  maybeStart() {
    if (!readSetting(ONBOARDED, false)) this.start();
  }

  start() {
    this.step = 0;
    this.node?.remove();
    this.node = el('div', { class: 'welcome', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('Welcome') });
    this.host.append(this.node);
    this._render();
  }

  finish() {
    writeSetting(ONBOARDED, true);
    this.node?.remove();
    this.node = null;
  }

  _steps() {
    return [() => this._intro(), () => this._look(), () => this._names(), () => this._brain(), () => this._setup(), () => this._done()];
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

  _footer(next, { nextLabel = t('Next'), skip = true } = {}) {
    return el(
      'div',
      { class: 'welcome-actions' },
      skip ? el('button', { class: 'link-btn', type: 'button', title: t('Skip the introduction'), onClick: () => this.finish() }, t('Skip')) : el('span'),
      el('span', { class: 'spacer' }),
      this.step > 0 ? el('button', { class: 'btn', type: 'button', onClick: () => this._go(-1) }, t('Back')) : null,
      el('button', { class: 'btn primary', type: 'button', onClick: next }, el('span', {}, nextLabel), icon('chevronRight', 15)),
    );
  }

  // ------------------------------------------------------------------ steps
  async _intro() {
    try {
      this.herName = (await request('/api/memory')).persona?.name || this.herName;
    } catch {
      /* the backend is still starting: the default name stays */
    }
    return el(
      'div',
      { class: 'welcome-step' },
      el('h2', {}, t("Hi! I'm {name}.", { name: this.herName })),
      el(
        'p',
        {},
        t("I live on your desk and I'm the voice and face of the brain you choose: an agent like Claude Code, Codex or Antigravity, a model on your PC or an online service."),
      ),
      el('ul', { class: 'welcome-tips' }, ...TIPS.map((tip) => el('li', {}, icon(tip.icon, 16), el('span', {}, tip.text)))),
      this._footer(() => this._go(1), { nextLabel: t("Let's start") }),
    );
  }

  /** Her colour: it shows right away on her, with a flare. */
  async _look() {
    let chosen = paletteKey(readSetting('dc:flame-color', 'lilac')) ?? 'lilac';
    const list = el('div', { class: 'swatch-row welcome-swatches', role: 'radiogroup', 'aria-label': t('Flame colour') });
    const name = el('p', { class: 'hint' });
    const render = () => {
      name.textContent = PALETTE_LABELS[chosen] ?? t('Free colour ({color})', { color: chosen });
      list.replaceChildren(
        ...COLORS.map((color) =>
          el('button', {
            type: 'button',
            class: `swatch${color.value === chosen ? ' on' : ''}`,
            role: 'radio',
            'aria-checked': String(color.value === chosen),
            'aria-label': color.label,
            title: color.label,
            style: { background: color.swatch },
            onClick: () => {
              if (color.value === chosen) return;
              chosen = color.value;
              writeSetting('dc:flame-color', chosen);
              this.app.companion?.sendToPet({ type: 'flame-color', value: chosen });
              render();
            },
          }),
        ),
      );
    };
    render();
    return el(
      'div',
      { class: 'welcome-step' },
      el('h2', {}, t('What colour shall I be?')),
      el('p', {}, t('Choose and watch me: I change right away. My wardrobe is in my menu (right-click on me), and everything is in Character → Look.')),
      list,
      name,
      this._footer(() => this._go(1)),
    );
  }

  async _names() {
    const user = el('input', { class: 'field-input', type: 'text', maxlength: 40, placeholder: t('Your name'), value: this.userName });
    const her = el('input', { class: 'field-input', type: 'text', maxlength: 40, placeholder: 'Tsukumo', value: this.herName });
    const next = async () => {
      this.userName = user.value.trim();
      const name = her.value.trim() || 'Tsukumo';
      try {
        if (name !== this.herName) await request('/api/memory/persona', 'PUT', { name });
        this.herName = name;
        // The name becomes a memory: it holds for every brain, even when you change it.
        if (this.userName) await request('/api/memory/facts', 'POST', { text: t("The user's name is {name}", { name: this.userName }) }).catch(() => {});
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
      el('h2', {}, t("What's your name?")),
      el('p', {}, t("I'll remember it, whatever brain you use. You can also give me another name.")),
      el('label', { class: 'row' }, el('span', { class: 'row-label' }, t('You')), user),
      el('label', { class: 'row' }, el('span', { class: 'row-label' }, t('Me')), her),
      this._footer(next),
    );
  }

  /** The step shows right away and fills in when the backend has finished looking at what's on the PC. */
  async _brain() {
    const intro = el('p', {}, t("Looking at what's on your PC…"));
    const list = el('div', { class: 'welcome-choices' });
    const status = el('p', { class: 'hint' });
    const node = el(
      'div',
      { class: 'welcome-step' },
      el('h2', {}, t('The brain')),
      intro,
      list,
      status,
      el(
        'button',
        { class: 'link-btn', type: 'button', onClick: () => this.app.showTab?.('engines', { section: 'llm' }) },
        t('All the brains, in Engines'),
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
      intro.textContent = t("I can't talk to the backend.");
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
                status.textContent = t('Connecting {engine}…', { engine: tx(spec.label) });
                try {
                  const result = await request('/api/providers', 'POST', { kind: 'llm', provider: spec.id, options: {} });
                  if (!result.ok) throw new Error(tx(result.error) ?? t('not answering'));
                  selected = spec.id;
                  status.textContent = t('{engine} is my brain.', { engine: tx(spec.label) });
                } catch (error) {
                  status.textContent = `${tx(spec.label)}: ${error.message}`;
                }
                render();
              },
            },
            el('strong', {}, tx(spec.label)),
            el('small', {}, tx(spec.tagline) ?? ''),
          ),
        ),
      );
    };
    render();
    intro.textContent = found.length
      ? t('I found these on your PC. Pick one: the others (and online services) are in the Engines tab.')
      : t("I didn't find agents or models on the PC. In the Engines tab you can connect one: Claude Code, Codex, LM Studio, Ollama or a service's key.");
    const current = specs.get(selected);
    status.textContent = current ? t("Now I'm using {engine}.", { engine: tx(current.label) }) : '';
  }

  /**
   * "I'll set everything up": what can be done by itself, with one click. It
   * touches files outside Tsukumo (the agents' settings) only for the items
   * left ticked, and each says what it does.
   */
  async _setup() {
    let data = null;
    try {
      data = await request('/api/setup');
    } catch (error) {
      return el('div', { class: 'welcome-step' }, el('h2', {}, t("I'll set everything up")), el('p', { class: 'hint error' }, error.message), this._footer(() => this._go(1)));
    }
    const integrations = data.integrations ?? {};
    const listening = data.listening ?? {};
    const tasks = [];
    const rows = [];

    const addTask = ({ id, title, text, done, disabled, run }) => {
      const check = el('input', { type: 'checkbox', checked: done || !disabled, disabled: done || disabled });
      const state = el('span', { class: `setup-state${done ? ' ok' : ''}` }, done ? t('done|task') : '');
      const detail = el('small', {}, text);
      rows.push(el('label', { class: 'setup-item' }, check, el('span', { class: 'integration-text' }, el('strong', {}, title), detail), state));
      if (!done && !disabled) tasks.push({ id, check, state, detail, run });
    };

    // Listening ------------------------------------------------------------------
    addTask({
      id: 'listening',
      title: t('Hear you speak'),
      text: listening.on
        ? t('Already on: Ctrl+Space and talk to me.')
        : listening.local
          ? t("Faster-Whisper is already there: I'll turn it on. The model downloads the first time (about 150 MB).")
          : t("I'll install Faster-Whisper and its model on the PC: about 300 MB, only once. No cloud."),
      done: listening.on,
      run: (task) => this._enableListening(task),
    });

    // Agents ---------------------------------------------------------------------
    const integration = (id, title, text) => {
      const item = integrations[id];
      if (!item?.available) return;
      addTask({
        id,
        title,
        text: item.conflict ? t("It already has its own notification command: I won't touch it.") : text,
        done: item.installed,
        disabled: item.conflict,
        run: async () => {
          const result = await request('/api/integrations', 'POST', { tool: id, action: 'install' });
          if (!result.ok) throw new Error(tx(result.error) ?? t('failed'));
        },
      });
    };
    integration('claude', t('Notifications from Claude Code'), t("I'll call you when it finishes a job or waits for you. Adds two hooks to ~/.claude/settings.json (with a backup)."));
    integration('codex', t('Notifications from Codex'), t("I'll call you when it's done. Adds a line to ~/.codex/config.toml (with a backup)."));
    integration(
      'claude_usage',
      t("Claude Code's limits"),
      integrations.claude_usage?.wraps
        ? t("I'll tell you how much of the plan is left. Your status line stays as it is: ours shows it the same.")
        : t("I'll tell you how much of the plan is left (Pro or Max, using Claude Code in the terminal). Adds a status line to Claude Code with model, context and limits."),
    );
    if (integrations.codex?.available) {
      rows.push(
        el(
          'div',
          { class: 'setup-item' },
          icon('check', 16),
          el('span', { class: 'integration-text' }, el('strong', {}, t('Codex usage')), el('small', {}, t('I read it from its logs: nothing to connect.'))),
        ),
      );
    }

    // Voice ----------------------------------------------------------------------
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
          el('strong', {}, t('My voice')),
          el('small', {}, voice ? engine ? t('{voice}, with {engine}. You can change it in Character.', { voice: voice.name ?? voice.id, engine }) : t('{voice}. You can change it in Character.', { voice: voice.name ?? voice.id }) : t("It's chosen in the Character tab.")),
        ),
        el('button', { class: 'btn', type: 'button', onClick: () => this.app.socket.say(sample) }, icon('play', 14), el('span', {}, t('Listen to her'))),
      ),
    );

    // The main button does everything; when done (or if there's nothing to do) it becomes "Next".
    const summary = el('p', { class: 'hint' });
    let prepared = false;
    const footer = this._footer(async () => {
      if (prepared || !tasks.some((task) => task.check.checked && !task.check.disabled)) {
        this._go(1);
        return;
      }
      const primary = footer.querySelector('.btn.primary');
      primary.disabled = true;
      primary.querySelector('span').textContent = t('Setting up…');
      const failed = await runTasks();
      primary.disabled = false;
      prepared = !failed;
      primary.querySelector('span').textContent = failed ? t('Retry') : t('Next');
    }, { nextLabel: tasks.length ? t('Set everything up') : t('Next') });
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
          task.state.textContent = t('done|task');
        } catch (error) {
          failed += 1;
          task.state.className = 'setup-state error';
          task.state.textContent = t('error');
          task.detail.textContent = error.message;
          task.check.disabled = false;
        }
      }
      summary.textContent = failed ? t("Something didn't work: you can retry, or fix it later from the tabs.") : t('All set!');
      return failed;
    };

    return el(
      'div',
      { class: 'welcome-step' },
      el('h2', {}, t("I'll set everything up")),
      el('p', {}, t("What I can fix by myself, with one click. Untick what you don't want.")),
      el('div', { class: 'setup-list' }, ...rows),
      summary,
      footer,
    );
  }

  /** Listening: the backend installs, chooses and prepares the model; here we follow how it goes. */
  async _enableListening(task) {
    let job = (await request('/api/setup/listening', 'POST')).job;
    const deadline = Date.now() + 30 * 60_000;
    while (['selecting', 'installing', 'loading'].includes(job?.state) && Date.now() < deadline) {
      if (job.detail) task.detail.textContent = tx(job.detail);
      await sleep(1500);
      job = (await request('/api/setup')).listening?.job;
    }
    if (job?.state !== 'done') throw new Error(tx(job?.detail) || t("didn't start"));
    task.detail.textContent = tx(job.detail);
  }

  async _done() {
    return el(
      'div',
      { class: 'welcome-step' },
      el('h2', {}, t('All set')),
      el(
        'p',
        {},
        t('Ask me anything. I can remind you of things ("remind me to drink in 20 minutes"), remember things about you ("remember that…"), tell you when Claude Code or Codex are done and how much of their limits you have left: it\'s all in the Work tab.'),
      ),
      this._footer(
        () => {
          const language = (this.app.settings?.voiceLanguage || 'it').startsWith('it') ? 'it' : 'en';
          this.app.socket.say(GREETING[language](this.userName, this.herName));
          this.app.companion?.sendToPet({ type: 'greet' });
          this.finish();
        },
        { nextLabel: t("Let's go"), skip: false },
      ),
    );
  }
}
