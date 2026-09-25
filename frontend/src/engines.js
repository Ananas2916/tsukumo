/**
 * Scheda "Motori": cervello, voce e ascolto.
 *
 * Non c'e' nessun elenco di motori scritto qui dentro. La pagina si costruisce
 * leggendo `GET /api/providers`, dove ogni motore dichiara nome, categoria
 * (agente, locale, in rete), costo, requisiti e campi. Aggiungere un motore
 * nel backend lo fa comparire qui senza toccare questo file.
 *
 * Ogni motore si puo' *verificare* prima di usarlo (`POST /api/providers/check`):
 * dice se la chiave e' buona, quante voci ci sono, quanto resta del piano, se
 * l'agente e' installato. Le voci e i modelli trovati diventano suggerimenti
 * nei campi corrispondenti.
 *
 * I campi segreti (chiavi API) arrivano dal backend come booleano — `true`
 * significa "una chiave e' impostata", mai il suo valore. Il campo resta
 * vuoto con il segnaposto che lo dice, e si riscrive solo per cambiarla.
 */

import { apiUrl } from './config.js';
import { el, languageLabel } from './dom.js';
import { icon } from './icons.js';

const SECTIONS = [
  {
    key: 'llm',
    title: 'Cervello',
    icon: 'agent',
    intro: 'Chi pensa le risposte: un agente con memoria e strumenti suoi, un modello sul tuo computer o un servizio in rete.',
    other: 'Scegli un altro cervello',
  },
  {
    key: 'tts',
    title: 'Voce',
    icon: 'volume',
    intro: 'Come parla. Le voci in rete sono di solito le più naturali: la verifica mostra la chiave, le voci del tuo account e quanto resta del piano.',
    other: "Scegli un'altra voce",
  },
  {
    key: 'stt',
    title: 'Ascolto',
    icon: 'mic',
    intro: 'Come ti sente quando le parli invece di scrivere.',
    other: 'Scegli come ascoltarti',
  },
];

const CATEGORIES = [
  { key: 'agent', title: 'Agenti', icon: 'robot', hint: 'Hanno memoria e strumenti propri: Tsukumo ne diventa la voce e la faccia.' },
  { key: 'local', title: 'Sul tuo computer', icon: 'laptop', hint: 'Niente rete, niente costi.' },
  { key: 'cloud', title: 'In rete', icon: 'cloud', hint: 'Servizi esterni, di solito con una chiave API.' },
  { key: 'test', title: 'Di prova', icon: 'flask', hint: 'Per provare senza installare nulla.' },
];

const PRICING = {
  free: { label: 'Gratis', icon: 'gift', tone: 'ok' },
  freemium: { label: 'Piano gratuito', icon: 'gift', tone: 'info' },
  paid: { label: 'A consumo', icon: 'coin', tone: 'warn' },
  subscription: { label: 'Col tuo abbonamento', icon: 'repeat', tone: 'info' },
};

const STATE_TEXT = {
  online: 'Pronto',
  degraded: 'Risponde, ma con un problema',
  offline: 'Non raggiungibile',
  unknown: 'In verifica…',
  off: 'Spento',
};

export class EnginesView {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.section = 'llm';
    this.data = null;
    /** Motore aperto nell'elenco (id), per sezione. */
    this.open = {};
    /** Modifiche non ancora applicate, per `tipo:id`. */
    this.drafts = {};
    /** Esito dell'ultima verifica, per `tipo:id`. */
    this.checks = {};
    /** Richieste in corso, per `tipo:id`. */
    this.working = {};

    this.tabs = el('div', { class: 'segmented', role: 'tablist' });
    this.body = el('div', { class: 'engines-body' });
    this.root.append(this.tabs, this.body);
    this.sectionButtons = new Map();
    for (const section of SECTIONS) {
      const button = el(
        'button',
        { class: 'segment', type: 'button', onClick: () => this.select(section.key) },
        el('span', { class: 'dot', dataset: { state: 'unknown' } }),
        el('span', {}, section.title),
      );
      this.sectionButtons.set(section.key, button);
      this.tabs.append(button);
    }

    app.on('engines', () => {
      this._renderDots();
      if (this.data && app.tab === 'engines') this._renderHeroStatus();
    });
    app.on('providers', () => this.load());
  }

  shown(options = {}) {
    if (options.section && SECTIONS.some((section) => section.key === options.section)) this.section = options.section;
    if (!this.data) this.load();
    else this.render();
  }

  select(section) {
    this.section = section;
    this.render();
  }

  async load() {
    try {
      const response = await fetch(apiUrl('/api/providers'));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.data = await response.json();
      this.render();
    } catch (error) {
      this.body.replaceChildren(el('p', { class: 'hint error pad' }, `Motori non leggibili: ${error.message}`));
    }
  }

  // --------------------------------------------------------------- disegno
  render() {
    this._renderDots();
    for (const [key, button] of this.sectionButtons) button.classList.toggle('active', key === this.section);
    if (!this.data) {
      this.body.replaceChildren(el('p', { class: 'hint pad' }, 'Carico i motori disponibili…'));
      return;
    }
    const section = SECTIONS.find((item) => item.key === this.section);
    const specs = this.data.providers[this.section] ?? [];
    const activeId = this.data.selected[this.section];
    const active = specs.find((spec) => spec.id === activeId);

    const nodes = [el('p', { class: 'section-intro' }, section.intro)];
    if (active) nodes.push(this._hero(active));
    nodes.push(el('h3', { class: 'list-title' }, section.other));

    for (const category of CATEGORIES) {
      const items = specs.filter((spec) => spec.category === category.key && spec.id !== activeId);
      if (!items.length) continue;
      nodes.push(
        el(
          'div',
          { class: 'group-title' },
          icon(category.icon, 15),
          el('span', {}, category.title),
          el('small', {}, category.hint),
        ),
        el('div', { class: 'engine-list' }, items.map((spec) => this._row(spec))),
      );
    }
    this.body.replaceChildren(...nodes);
  }

  _renderDots() {
    for (const [key, button] of this.sectionButtons) {
      button.querySelector('.dot').dataset.state = this.app.engines?.[key]?.state ?? 'unknown';
    }
  }

  _hero(spec) {
    const key = this._key(spec);
    this.heroStatus = el('div', { class: 'status-line' });
    const configure = el(
      'button',
      { class: 'btn', type: 'button', onClick: () => this._toggle(spec) },
      icon('engines', 15),
      el('span', {}, this.open[this.section] === spec.id ? 'Chiudi impostazioni' : 'Impostazioni'),
    );
    const verify = this._verifyButton(spec);
    const card = el(
      'section',
      { class: 'engine-hero' },
      el(
        'div',
        { class: 'hero-top' },
        this._avatar(spec),
        el('div', { class: 'hero-text' }, el('div', { class: 'hero-name' }, spec.label, el('span', { class: 'in-use' }, 'in uso')), el('div', { class: 'hero-tag' }, spec.tagline)),
      ),
      this._badges(spec),
      this.heroStatus,
      el('div', { class: 'hero-actions' }, verify, spec.fields.length ? configure : null),
      this._result(key),
      this.open[this.section] === spec.id ? this._form(spec, true) : null,
    );
    this._renderHeroStatus();
    return card;
  }

  _renderHeroStatus() {
    if (!this.heroStatus) return;
    const status = this.app.engines?.[this.section];
    const state = status?.state ?? 'unknown';
    const parts = [STATE_TEXT[state] ?? state];
    if (status?.detail) parts.push(status.detail);
    else if (status?.model && state === 'online') parts.push(String(status.model));
    if (this.section === 'tts' && status?.voice) parts.push(`voce ${status.voice}`);
    if (status?.muted) parts.push('silenziata');
    this.heroStatus.replaceChildren(
      el('span', { class: 'dot', dataset: { state } }),
      el('span', {}, parts.join(' — ')),
    );
    if (status?.hint && state !== 'online') this.heroStatus.append(el('small', { class: 'status-hint' }, status.hint));
  }

  _row(spec) {
    const isOpen = this.open[this.section] === spec.id;
    const head = el(
      'button',
      { class: 'engine-row-head', type: 'button', 'aria-expanded': String(isOpen), onClick: () => this._toggle(spec) },
      this._avatar(spec),
      el(
        'span',
        { class: 'engine-row-text' },
        el('strong', {}, spec.label, spec.recommended ? el('span', { class: 'star', title: 'Consigliato' }, icon('star', 12)) : null, isOpen ? null : this._foundBadge(spec)),
        el('small', {}, spec.tagline),
      ),
      el('span', { class: 'chevron' }, icon(isOpen ? 'chevronDown' : 'chevronRight', 16)),
    );
    const article = el('article', { class: `engine-row${isOpen ? ' open' : ''}` }, head);
    if (isOpen) {
      article.append(
        el(
          'div',
          { class: 'engine-row-body' },
          spec.description && spec.description !== spec.tagline ? el('p', { class: 'engine-desc' }, spec.description) : null,
          this._badges(spec),
          this._requirements(spec),
          this._form(spec, false),
        ),
      );
    }
    return article;
  }

  _avatar(spec) {
    const glyph = { agent: 'robot', local: 'laptop', cloud: 'cloud', test: 'flask' }[spec.category] ?? 'engines';
    return el('span', { class: `engine-avatar cat-${spec.category}` }, icon(glyph, 18));
  }

  /** "Trovato sul PC": il backend ha visto il programma o il servizio acceso. */
  _foundBadge(spec) {
    const found = this.data?.detected?.[this.section]?.[spec.id];
    if (!found?.found) return null;
    return el('span', { class: 'badge ok', title: found.detail || null }, icon('check', 12), 'Trovato sul PC');
  }

  _badges(spec) {
    const price = PRICING[spec.pricing] ?? PRICING.free;
    return el(
      'div',
      { class: 'badges' },
      this._foundBadge(spec),
      spec.recommended ? el('span', { class: 'badge accent' }, icon('star', 12), 'Consigliato') : null,
      el('span', { class: `badge ${price.tone}` }, icon(price.icon, 12), price.label),
      el('span', { class: 'badge' }, icon(spec.local ? 'laptop' : 'cloud', 12), spec.local ? 'Sul tuo PC' : 'Passa da internet'),
    );
  }

  _requirements(spec) {
    if (!spec.requires?.length && !spec.docs) return null;
    return el(
      'div',
      { class: 'requires' },
      spec.requires?.length ? el('span', {}, `Serve: ${spec.requires.join(' · ')}`) : null,
      spec.docs ? el('a', { href: spec.docs, target: '_blank', rel: 'noreferrer' }, 'Dove si trova', icon('external', 12)) : null,
    );
  }

  _toggle(spec) {
    this.open[this.section] = this.open[this.section] === spec.id ? null : spec.id;
    this.render();
    if (this.open[this.section]) {
      requestAnimationFrame(() => this.body.querySelector('.engine-row.open, .engine-form')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    }
  }

  // ------------------------------------------------------------------ form
  _key(spec) {
    return `${spec.kind}:${spec.id}`;
  }

  _form(spec, isActive) {
    const key = this._key(spec);
    const draft = (this.drafts[key] ??= {});
    const saved = this.data.saved?.[spec.kind]?.[spec.id] ?? {};
    const check = this.checks[key];

    const basic = spec.fields.filter((field) => !field.advanced).map((field) => this._field(spec, field, saved[field.env], draft, check));
    const advancedFields = spec.fields.filter((field) => field.advanced);
    const advanced = advancedFields.length
      ? el(
          'details',
          { class: 'advanced' },
          el('summary', {}, 'Avanzate'),
          advancedFields.map((field) => this._field(spec, field, saved[field.env], draft, check)),
        )
      : null;

    const apply = el(
      'button',
      { class: 'btn primary', type: 'button', disabled: Boolean(this.working[key]), onClick: () => this._apply(spec) },
      icon('check', 15),
      el('span', {}, isActive ? 'Salva' : 'Usa questo'),
    );
    return el(
      'div',
      { class: 'engine-form' },
      basic,
      advanced,
      el('div', { class: 'form-actions' }, isActive ? null : this._verifyButton(spec), apply),
      isActive ? null : this._result(key),
    );
  }

  _field(spec, field, savedValue, draft, check) {
    const id = `f-${spec.kind}-${spec.id}-${field.env}`;
    const current = field.env in draft ? draft[field.env] : savedValue ?? field.default ?? '';
    let input;

    if (field.type === 'select') {
      input = el(
        'select',
        { class: 'field-input', id },
        field.options.map((option) => el('option', { value: option.value, selected: String(current) === option.value }, option.label)),
      );
    } else if (field.type === 'bool') {
      input = el('input', { type: 'checkbox', id, checked: current === true || current === 'true' || current === '1' });
    } else if (field.type === 'textarea') {
      input = el('textarea', { class: 'field-input', id, rows: 2, placeholder: field.placeholder || null });
      input.value = current ?? '';
    } else {
      const type = field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text';
      input = el('input', { class: 'field-input', type, id, step: type === 'number' ? 'any' : null });
      if (field.secret) {
        // Il valore non arriva mai dal server: `true` dice solo che c'e'.
        input.placeholder = savedValue ? '•••••••• impostata (scrivi per cambiarla)' : 'nessuna chiave impostata';
        input.value = draft[field.env] ?? '';
      } else {
        input.value = current ?? '';
        if (field.placeholder) input.placeholder = field.placeholder;
      }
      const suggestions = this._suggestions(field, check);
      if (suggestions.length) {
        const listId = `${id}-list`;
        input.setAttribute('list', listId);
        input._datalist = el(
          'datalist',
          { id: listId },
          suggestions.map((item) => el('option', { value: item.value }, item.label)),
        );
      }
    }

    const update = () => {
      draft[field.env] = field.type === 'bool' ? String(input.checked) : input.value;
    };
    input.addEventListener('input', update);
    input.addEventListener('change', update);

    const wrapper = el(
      'label',
      { class: 'field', for: id },
      el('span', { class: 'field-label' }, field.secret ? icon('key', 13) : null, field.label),
      input,
      input._datalist ?? null,
      field.help ? el('span', { class: 'field-help' }, field.help) : null,
    );
    return wrapper;
  }

  _suggestions(field, check) {
    if (!check) return [];
    if (field.source === 'voices' && Array.isArray(check.voices)) {
      return check.voices.map((voice) => ({
        value: voice.id,
        label: [voice.name !== voice.id ? voice.name : null, languageLabel(voice.language), voice.gender === 'female' ? 'donna' : voice.gender === 'male' ? 'uomo' : null]
          .filter(Boolean)
          .join(' · '),
      }));
    }
    if (field.source === 'models' && Array.isArray(check.models)) {
      return check.models.map((model) => ({ value: model, label: model }));
    }
    return [];
  }

  // ------------------------------------------------------------- verifica
  _verifyButton(spec) {
    const key = this._key(spec);
    return el(
      'button',
      { class: 'btn', type: 'button', disabled: Boolean(this.working[key]), onClick: () => this._check(spec) },
      icon('refresh', 15),
      el('span', {}, this.working[key] === 'check' ? 'Verifico…' : 'Verifica'),
    );
  }

  _options(spec) {
    // Vuoto su un segreto = "non l'ho toccata": non si manda.
    const draft = this.drafts[this._key(spec)] ?? {};
    const options = {};
    for (const [env, value] of Object.entries(draft)) {
      const field = spec.fields.find((item) => item.env === env);
      if (!field) continue;
      if (field.secret && !String(value).trim()) continue;
      options[env] = value;
    }
    return options;
  }

  async _check(spec) {
    const key = this._key(spec);
    this.working[key] = 'check';
    this.render();
    try {
      const response = await fetch(apiUrl('/api/providers/check'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: spec.kind, provider: spec.id, options: this._options(spec) }),
      });
      const result = await response.json().catch(() => ({}));
      this.checks[key] = response.ok ? result : { ok: false, detail: result.error ?? `HTTP ${response.status}` };
    } catch (error) {
      this.checks[key] = { ok: false, detail: error.message };
    } finally {
      delete this.working[key];
      this.render();
    }
  }

  _result(key) {
    const result = this.checks[key];
    if (!result) return null;
    const box = el(
      'div',
      { class: `verify ${result.ok ? 'ok' : 'fail'}` },
      el('div', { class: 'verify-head' }, icon(result.ok ? 'check' : 'alert', 15), el('span', {}, result.detail || (result.ok ? 'Funziona' : 'Non funziona'))),
    );
    if (result.hint) box.append(el('p', { class: 'verify-hint' }, result.hint));
    if (result.account) box.append(this._quota(result.account));
    if (result.ok && Array.isArray(result.voices) && result.voices.length) {
      box.append(el('p', { class: 'verify-hint' }, 'Le voci trovate ora compaiono come suggerimenti nel campo Voce.'));
    }
    if (result.ok && Array.isArray(result.models) && result.models.length) {
      box.append(el('p', { class: 'verify-hint' }, `Modelli: ${result.models.slice(0, 8).join(', ')}${result.models.length > 8 ? '…' : ''}`));
    }
    if (result.applyError) box.append(el('p', { class: 'verify-hint' }, result.applyError));
    return box;
  }

  _quota(account) {
    const used = Number(account.used) || 0;
    const limit = Number(account.limit) || 0;
    const ratio = limit ? Math.min(1, used / limit) : 0;
    const number = (value) => value.toLocaleString('it-IT');
    const reset = account.resetsAt ? new Date(account.resetsAt * 1000).toLocaleDateString('it-IT', { day: 'numeric', month: 'long' }) : null;
    return el(
      'div',
      { class: 'quota' },
      el(
        'div',
        { class: 'quota-text' },
        el('span', {}, account.plan ? `Piano ${account.plan}` : 'Il tuo piano'),
        el('span', {}, limit ? `${number(limit - used)} ${account.unit} rimasti su ${number(limit)}` : `${number(used)} ${account.unit} usati`),
      ),
      el('div', { class: `quota-bar${ratio > 0.85 ? ' low' : ''}` }, el('i', { style: { width: `${ratio * 100}%` } })),
      reset ? el('small', {}, `Si rinnova il ${reset}`) : null,
    );
  }

  // ------------------------------------------------------------- applica
  async _apply(spec) {
    const key = this._key(spec);
    this.working[key] = 'apply';
    this.render();
    try {
      const response = await fetch(apiUrl('/api/providers'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: spec.kind, provider: spec.id, options: this._options(spec) }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) {
        // Il backend ha gia' rimesso la configurazione precedente.
        this.checks[key] = { ok: false, detail: result.error ?? result.detail ?? `HTTP ${response.status}` };
        return;
      }
      delete this.drafts[key];
      this.open[this.section] = null;
      const section = SECTIONS.find((item) => item.key === spec.kind);
      this.app.toast(`${section.title}: ora ${spec.label}`, 'ok');
      await this.load();
    } catch (error) {
      this.checks[key] = { ok: false, detail: error.message };
    } finally {
      delete this.working[key];
      this.render();
    }
  }
}
