/**
 * Scheda "Motori": selezione e configurazione di LLM, voce e ascolto.
 *
 * Non c'e' nessun elenco di motori scritto qui dentro. La pagina si costruisce
 * leggendo `GET /api/providers`, dove ogni motore dichiara i propri campi e il
 * tipo di ciascuno. Aggiungere un motore nel backend lo fa comparire qui senza
 * toccare questo file: e' il motivo per cui il registro esiste.
 *
 * I campi segreti (chiavi API) arrivano dal backend come booleano — `true`
 * significa "una chiave e' impostata", mai il suo valore. Il campo resta
 * vuoto con il segnaposto che lo dice, e si riscrive solo per cambiarla.
 */

import { apiUrl } from './config.js';
import './engines.css';

const KINDS = [
  {
    key: 'llm',
    title: 'Cervello',
    hint: 'Chi pensa le risposte. I motori locali non mandano nulla in rete.',
  },
  {
    key: 'tts',
    title: 'Voce',
    hint: 'Come parla. Cambiare voce cambia anche la lingua delle risposte.',
  },
  {
    key: 'stt',
    title: 'Ascolto',
    hint: 'Come ti sente. Serve per il push-to-talk e per l’ascolto continuo.',
  },
];

export class EnginesPanel {
  /**
   * @param {HTMLElement} root
   * @param {{onChanged?: (result: object) => void, onError?: (msg: string) => void}} [hooks]
   */
  constructor(root, hooks = {}) {
    this.root = root;
    this.onChanged = hooks.onChanged ?? (() => {});
    this.onError = hooks.onError ?? ((message) => console.warn('[engines]', message));
    this.data = null;
    /** Modifiche non ancora salvate, per tipo. */
    this.draft = { llm: {}, tts: {}, stt: {} };
    this.chosen = {};
  }

  async load() {
    try {
      const response = await fetch(apiUrl('/api/providers'));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.data = await response.json();
      this.chosen = { ...this.data.selected };
      this.render();
    } catch (error) {
      this.root.innerHTML = '';
      this.root.append(
        el('p', { class: 'hint error' }, `Motori non leggibili: ${error.message}`),
      );
    }
  }

  render() {
    if (!this.data) return;
    this.root.innerHTML = '';
    for (const kind of KINDS) {
      this.root.append(this._renderKind(kind));
    }
  }

  // ------------------------------------------------------------------
  _renderKind({ key, title, hint }) {
    const specs = this.data.providers[key] ?? [];
    const selected = this.chosen[key];
    const spec = specs.find((item) => item.id === selected) ?? specs[0];

    const picker = el('select', { class: 'input', id: `engine-${key}` });
    for (const item of specs) {
      const option = el('option', { value: item.id }, item.label);
      if (item.id === spec?.id) option.selected = true;
      picker.append(option);
    }
    picker.addEventListener('change', () => {
      this.chosen[key] = picker.value;
      this.draft[key] = {}; // i campi del motore precedente non valgono piu'
      this.render();
    });

    const body = el('div', { class: 'engine-body' });
    if (spec) {
      if (spec.description) body.append(el('p', { class: 'hint' }, spec.description));

      const badges = el('div', { class: 'badges' });
      badges.append(
        el(
          'span',
          { class: `badge ${spec.local ? 'ok' : 'warn'}` },
          spec.local ? 'locale' : 'passa da internet',
        ),
      );
      for (const requirement of spec.requires ?? []) {
        badges.append(el('span', { class: 'badge' }, requirement));
      }
      body.append(badges);

      const saved = this.data.options?.[key] ?? {};
      for (const field of spec.fields ?? []) {
        body.append(this._renderField(key, field, saved[field.env]));
      }
    }

    const save = el('button', { class: 'btn primary', type: 'button' }, 'Applica');
    const status = el('span', { class: 'hint engine-status' });
    save.addEventListener('click', () => this._apply(key, spec, save, status));

    const actions = el('div', { class: 'engine-actions' });
    actions.append(save, status);
    body.append(actions);

    const section = el('section', { class: 'engine' });
    section.append(
      el('h3', {}, title),
      el('p', { class: 'hint' }, hint),
      picker,
      body,
    );
    return section;
  }

  _renderField(kind, field, savedValue) {
    const id = `field-${kind}-${field.env}`;
    const wrapper = el('label', { class: 'field', for: id });
    wrapper.append(el('span', { class: 'field-label' }, field.label));

    let input;
    if (field.type === 'select') {
      input = el('select', { class: 'input', id });
      for (const option of field.options ?? []) {
        const node = el('option', { value: option.value }, option.label);
        if (String(savedValue ?? field.default) === option.value) node.selected = true;
        input.append(node);
      }
    } else if (field.type === 'bool') {
      input = el('input', { type: 'checkbox', id });
      input.checked = Boolean(savedValue ?? field.default);
    } else {
      const type = field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text';
      input = el('input', { class: 'input', type, id });
      if (field.secret) {
        // Il valore non arriva mai dal server: `true` dice solo che c'e'.
        input.placeholder = savedValue ? '•••••• (impostata)' : 'nessuna chiave impostata';
      } else {
        input.value = savedValue ?? field.default ?? '';
        if (field.placeholder) input.placeholder = field.placeholder;
      }
    }

    input.addEventListener('input', () => {
      const value = field.type === 'bool' ? input.checked : input.value;
      this.draft[kind][field.env] = value;
    });
    input.addEventListener('change', () => {
      const value = field.type === 'bool' ? input.checked : input.value;
      this.draft[kind][field.env] = value;
    });

    wrapper.append(input);
    if (field.help) wrapper.append(el('span', { class: 'hint field-help' }, field.help));
    return wrapper;
  }

  // ------------------------------------------------------------------
  async _apply(kind, spec, button, status) {
    if (!spec) return;
    button.disabled = true;
    status.className = 'hint engine-status';
    status.textContent = 'Applico…';

    // I campi segreti lasciati vuoti non vengono inviati: vuoto significa
    // "non l'ho toccata", non "cancellala".
    const options = {};
    for (const [env, value] of Object.entries(this.draft[kind])) {
      const field = (spec.fields ?? []).find((item) => item.env === env);
      if (field?.secret && !String(value).trim()) continue;
      options[env] = typeof value === 'boolean' ? String(value) : value;
    }

    try {
      const response = await fetch(apiUrl('/api/providers'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, provider: spec.id, options }),
      });
      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.error ?? result.detail ?? `HTTP ${response.status}`);
      }
      if (!result.ok) {
        // Il backend ha gia' ripristinato la configurazione precedente.
        status.className = 'hint engine-status error';
        status.textContent = result.error ?? 'Non riuscito';
        this.onError(result.error ?? 'Cambio non riuscito');
        return;
      }

      status.className = 'hint engine-status ok';
      status.textContent = 'Attivo';
      this.draft[kind] = {};
      this.onChanged(result);
      await this.load(); // rilegge lo stato vero, segreti mascherati compresi
    } catch (error) {
      status.className = 'hint engine-status error';
      status.textContent = error.message;
      this.onError(error.message);
    } finally {
      button.disabled = false;
    }
  }
}

/** Piccolo helper per costruire nodi senza innerHTML (niente HTML iniettabile). */
function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) node.setAttribute(name, value);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}
