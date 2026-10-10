/**
 * "Engines" tab: brain, voice and listening.
 *
 * There's no list of engines written in here. The page builds itself by
 * reading `GET /api/providers`, where every engine declares name, category
 * (agent, local, online), cost, requirements and fields. Adding an engine in
 * the backend makes it appear here without touching this file.
 *
 * Every engine can be *checked* before use (`POST /api/providers/check`): it
 * says whether the key is good, how many voices there are, how much of the
 * plan is left, whether the agent is installed. The voices and models found
 * become suggestions in the matching fields.
 *
 * Secret fields (API keys) come from the backend as a boolean — `true` means
 * "a key is set", never its value. The field stays empty with a placeholder
 * that says so, and is rewritten only to change it.
 *
 * Text written by the backend (names, descriptions, help, errors) goes
 * through `tx()`: English in the registry, Italian from the catalog.
 */

import { apiUrl } from './config.js';
import { el, languageLabel } from './dom.js';
import { LOCALE, t, tx } from './i18n.js';
import { icon } from './icons.js';

const SECTIONS = [
  {
    key: 'llm',
    title: t('Brain'),
    icon: 'agent',
    intro: t('Who thinks up the replies: an agent with its own memory and tools, a model on your computer or an online service.'),
    other: t('Choose another brain'),
  },
  {
    key: 'tts',
    title: t('Voice'),
    icon: 'volume',
    intro: t("How she speaks. Online voices are usually the most natural: the check shows the key, your account's voices and how much of the plan is left."),
    other: t('Choose another voice'),
  },
  {
    key: 'stt',
    title: t('Listening'),
    icon: 'mic',
    intro: t('How she hears you when you talk instead of typing.'),
    other: t('Choose how she listens to you'),
  },
];

const CATEGORIES = [
  { key: 'agent', title: t('Agents'), icon: 'robot', hint: t('They have their own memory and tools: Tsukumo becomes their voice and face.') },
  { key: 'local', title: t('On your computer'), icon: 'laptop', hint: t('No network, no costs.') },
  { key: 'cloud', title: t('Online'), icon: 'cloud', hint: t('External services, usually with an API key.') },
  { key: 'test', title: t('For testing'), icon: 'flask', hint: t('To try without installing anything.') },
];

const PRICING = {
  free: { label: t('Free'), icon: 'gift', tone: 'ok' },
  freemium: { label: t('Free plan'), icon: 'gift', tone: 'info' },
  paid: { label: t('Pay as you go'), icon: 'coin', tone: 'warn' },
  subscription: { label: t('With your subscription'), icon: 'repeat', tone: 'info' },
};

const STATE_TEXT = {
  online: t('Ready'),
  degraded: t('Answers, but with a problem'),
  offline: t('Unreachable'),
  unknown: t('Checking…'),
  off: t('Off'),
};

export class EnginesView {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.section = 'llm';
    this.data = null;
    /** Engine open in the list (id), per section. */
    this.open = {};
    /** Changes not applied yet, per `kind:id`. */
    this.drafts = {};
    /** Result of the last check, per `kind:id`. */
    this.checks = {};
    /** Requests in progress, per `kind:id`. */
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
      this.body.replaceChildren(el('p', { class: 'hint error pad' }, t("Can't read the engines: {error}", { error: error.message })));
    }
  }

  // ---------------------------------------------------------------- drawing
  render() {
    this._renderDots();
    for (const [key, button] of this.sectionButtons) button.classList.toggle('active', key === this.section);
    if (!this.data) {
      this.body.replaceChildren(el('p', { class: 'hint pad' }, t('Loading the available engines…')));
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
      el('span', {}, this.open[this.section] === spec.id ? t('Close settings') : t('Settings')),
    );
    const verify = this._verifyButton(spec);
    const card = el(
      'section',
      { class: 'engine-hero' },
      el(
        'div',
        { class: 'hero-top' },
        this._avatar(spec),
        el('div', { class: 'hero-text' }, el('div', { class: 'hero-name' }, tx(spec.label), el('span', { class: 'in-use' }, t('in use'))), el('div', { class: 'hero-tag' }, spec.tagline)),
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
    if (status?.detail) parts.push(tx(status.detail));
    else if (status?.model && state === 'online') parts.push(String(status.model));
    if (this.section === 'tts' && status?.voice) parts.push(t('voice {name}', { name: status.voice }));
    if (status?.muted) parts.push('silenziata');
    this.heroStatus.replaceChildren(
      el('span', { class: 'dot', dataset: { state } }),
      el('span', {}, parts.join(' — ')),
    );
    if (status?.hint && state !== 'online') this.heroStatus.append(el('small', { class: 'status-hint' }, tx(status.hint)));
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
        el('strong', {}, tx(spec.label), spec.recommended ? el('span', { class: 'star', title: t('Recommended') }, icon('star', 12)) : null, isOpen ? null : this._foundBadge(spec)),
        el('small', {}, tx(spec.tagline)),
      ),
      el('span', { class: 'chevron' }, icon(isOpen ? 'chevronDown' : 'chevronRight', 16)),
    );
    const article = el('article', { class: `engine-row${isOpen ? ' open' : ''}` }, head);
    if (isOpen) {
      article.append(
        el(
          'div',
          { class: 'engine-row-body' },
          spec.description && spec.description !== spec.tagline ? el('p', { class: 'engine-desc' }, tx(spec.description)) : null,
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

  /** "Found on the PC": the backend saw the program or the running service. */
  _foundBadge(spec) {
    const found = this.data?.detected?.[this.section]?.[spec.id];
    if (!found?.found) return null;
    return el('span', { class: 'badge ok', title: tx(found.detail) || null }, icon('check', 12), t('Found on the PC'));
  }

  _badges(spec) {
    const price = PRICING[spec.pricing] ?? PRICING.free;
    return el(
      'div',
      { class: 'badges' },
      this._foundBadge(spec),
      spec.recommended ? el('span', { class: 'badge accent' }, icon('star', 12), t('Recommended')) : null,
      el('span', { class: `badge ${price.tone}` }, icon(price.icon, 12), price.label),
      el('span', { class: 'badge' }, icon(spec.local ? 'laptop' : 'cloud', 12), spec.local ? t('On your PC') : t('Goes through the internet')),
    );
  }

  _requirements(spec) {
    if (!spec.requires?.length && !spec.docs) return null;
    return el(
      'div',
      { class: 'requires' },
      spec.requires?.length ? el('span', {}, t('Needs: {list}', { list: spec.requires.map(tx).join(' · ') })) : null,
      spec.docs ? el('a', { href: spec.docs, target: '_blank', rel: 'noreferrer' }, t('Where to get it'), icon('external', 12)) : null,
    );
  }

  _toggle(spec) {
    this.open[this.section] = this.open[this.section] === spec.id ? null : spec.id;
    this.render();
    if (this.open[this.section]) {
      requestAnimationFrame(() => this.body.querySelector('.engine-row.open, .engine-form')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    }
  }

  // ------------------------------------------------------------------- form
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
          el('summary', {}, t('Advanced')),
          advancedFields.map((field) => this._field(spec, field, saved[field.env], draft, check)),
        )
      : null;

    const apply = el(
      'button',
      { class: 'btn primary', type: 'button', disabled: Boolean(this.working[key]), onClick: () => this._apply(spec) },
      icon('check', 15),
      el('span', {}, isActive ? t('Save') : t('Use this')),
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
        field.options.map((option) => el('option', { value: option.value, selected: String(current) === option.value }, tx(option.label))),
      );
    } else if (field.type === 'bool') {
      input = el('input', { type: 'checkbox', id, checked: current === true || current === 'true' || current === '1' });
    } else if (field.type === 'textarea') {
      input = el('textarea', { class: 'field-input', id, rows: 2, placeholder: tx(field.placeholder) || null });
      input.value = current ?? '';
    } else {
      const type = field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text';
      input = el('input', { class: 'field-input', type, id, step: type === 'number' ? 'any' : null });
      if (field.secret) {
        // The value never comes from the server: `true` only says it's there.
        input.placeholder = savedValue ? t('•••••••• set (type to change it)') : t('no key set');
        input.value = draft[field.env] ?? '';
      } else {
        input.value = current ?? '';
        if (field.placeholder) input.placeholder = tx(field.placeholder);
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
      el('span', { class: 'field-label' }, field.secret ? icon('key', 13) : null, tx(field.label)),
      input,
      input._datalist ?? null,
      field.help ? el('span', { class: 'field-help' }, tx(field.help)) : null,
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

  // ------------------------------------------------------------------ check
  _verifyButton(spec) {
    const key = this._key(spec);
    return el(
      'button',
      { class: 'btn', type: 'button', disabled: Boolean(this.working[key]), onClick: () => this._check(spec) },
      icon('refresh', 15),
      el('span', {}, this.working[key] === 'check' ? t('Checking…') : t('Check')),
    );
  }

  _options(spec) {
    // Empty on a secret = "I didn't touch it": it isn't sent.
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
      el('div', { class: 'verify-head' }, icon(result.ok ? 'check' : 'alert', 15), el('span', {}, tx(result.detail) || (result.ok ? t('Works') : t("Doesn't work")))),
    );
    if (result.hint) box.append(el('p', { class: 'verify-hint' }, tx(result.hint)));
    if (result.account) box.append(this._quota(result.account));
    if (result.ok && Array.isArray(result.voices) && result.voices.length) {
      box.append(el('p', { class: 'verify-hint' }, t('The voices found now appear as suggestions in the Voice field.')));
    }
    if (result.ok && Array.isArray(result.models) && result.models.length) {
      box.append(el('p', { class: 'verify-hint' }, t('Models: {list}', { list: `${result.models.slice(0, 8).join(', ')}${result.models.length > 8 ? '…' : ''}` })));
    }
    if (result.applyError) box.append(el('p', { class: 'verify-hint' }, result.applyError));
    return box;
  }

  _quota(account) {
    const used = Number(account.used) || 0;
    const limit = Number(account.limit) || 0;
    const ratio = limit ? Math.min(1, used / limit) : 0;
    const number = (value) => value.toLocaleString(LOCALE);
    const reset = account.resetsAt ? new Date(account.resetsAt * 1000).toLocaleDateString(LOCALE, { day: 'numeric', month: 'long' }) : null;
    return el(
      'div',
      { class: 'quota' },
      el(
        'div',
        { class: 'quota-text' },
        el('span', {}, account.plan ? t('{plan} plan', { plan: account.plan }) : t('Your plan')),
        el('span', {}, limit ? t('{left} {unit} left of {limit}', { left: number(limit - used), unit: account.unit, limit: number(limit) }) : t('{used} {unit} used', { used: number(used), unit: account.unit })),
      ),
      el('div', { class: `quota-bar${ratio > 0.85 ? ' low' : ''}` }, el('i', { style: { width: `${ratio * 100}%` } })),
      reset ? el('small', {}, t('Renews on {date}', { date: reset })) : null,
    );
  }

  // ------------------------------------------------------------------ apply
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
        // The backend has already restored the previous configuration.
        this.checks[key] = { ok: false, detail: result.error ?? result.detail ?? `HTTP ${response.status}` };
        return;
      }
      delete this.drafts[key];
      this.open[this.section] = null;
      const section = SECTIONS.find((item) => item.key === spec.kind);
      this.app.toast(t('{section}: now {engine}', { section: section.title, engine: tx(spec.label) }), 'ok');
      await this.load();
    } catch (error) {
      this.checks[key] = { ok: false, detail: error.message };
    } finally {
      delete this.working[key];
      this.render();
    }
  }
}
