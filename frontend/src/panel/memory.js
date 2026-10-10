/**
 * "Who she is and what she knows about you": name, character and memories,
 * the same for every brain.
 *
 * The backend (backend/memory.py) adds personality and memories at every
 * turn, whether the brain is Claude Code, Codex, OpenClaw or a local model.
 * Memories come in when you tell her "remember that...", when the brain
 * notes one by itself, or from here; here you see them all and delete them.
 */

import { apiUrl } from '../config.js';
import { el, iconButton } from '../dom.js';
import { t, tx } from '../i18n.js';
import { icon } from '../icons.js';

export class MemoryCard {
  /**
   * @param {{socket: object, toast: Function}} app
   * @param {(iconName: string, title: string, ...children: Node[]) => HTMLElement} card builds the cards
   */
  constructor(app, card) {
    this.app = app;
    this.facts = [];

    this.name = el('input', { class: 'field-input', type: 'text', maxlength: 40, placeholder: 'Tsukumo' });
    this.traits = el('textarea', {
      class: 'field-input memory-traits',
      rows: 2,
      maxlength: 400,
      placeholder: t('E.g. warm, concise and a little playful'),
    });
    let timer = null;
    const save = () => {
      clearTimeout(timer);
      timer = setTimeout(() => this._savePersona(), 600);
    };
    this.name.addEventListener('input', save);
    this.traits.addEventListener('input', save);

    this.input = el('input', {
      class: 'field-input',
      type: 'text',
      maxlength: 200,
      placeholder: t('E.g. "I work in Python and hate meetings"'),
      'aria-label': t('New memory'),
      onKeydown: (event) => {
        if (event.key === 'Enter') this._add();
      },
    });
    const add = el('button', { class: 'btn', type: 'button', onClick: () => this._add() }, icon('check', 15), el('span', {}, t('Add')));
    this.list = el('div', { class: 'agenda-list memory-list' });
    this.clear = el('button', { class: 'link-btn hidden', type: 'button', onClick: () => this._clearAll() }, t('Forget everything'));

    this.node = card(
      'book',
      t('Who she is and what she knows about you'),
      el('p', { class: 'card-sub' }, t('The same for every brain: switching agent or model she stays herself, and remembers you.')),
      el('label', { class: 'row' }, el('span', { class: 'row-label' }, 'Nome'), this.name),
      el('label', { class: 'row' }, el('span', { class: 'row-label' }, 'Carattere'), this.traits),
      el('div', { class: 'agenda-add' }, this.input, add),
      el('p', { class: 'hint' }, t('Or tell her "remember that…"; "what do you remember about me?" and "forget that…" work by voice too.')),
      this.list,
      this.clear,
    );

    app.socket.on('hello', (message) => message.memory && this._set(message.memory));
    app.socket.on('memory', (message) => this._set(message));
    this._render();
  }

  async load() {
    try {
      const response = await fetch(apiUrl('/api/memory'));
      if (response.ok) this._set(await response.json());
    } catch {
      /* it arrives anyway with the `memory` message */
    }
  }

  _set(memory) {
    this.facts = memory.facts ?? [];
    const persona = memory.persona ?? {};
    // Don't rewrite the fields while you're editing them.
    if (document.activeElement !== this.name) this.name.value = persona.name ?? '';
    if (document.activeElement !== this.traits) this.traits.value = persona.traits ?? '';
    if (memory.defaults) {
      this.name.placeholder = memory.defaults.name;
      this.traits.placeholder = memory.defaults.traits;
    }
    this._render();
  }

  async _savePersona() {
    await this._request('/api/memory/persona', 'PUT', { name: this.name.value, traits: this.traits.value });
  }

  async _add() {
    const text = this.input.value.trim();
    if (!text) return;
    if (await this._request('/api/memory/facts', 'POST', { text })) this.input.value = '';
  }

  async _clearAll() {
    if (!window.confirm(t('Forget all the memories? Name and character stay.'))) return;
    await this._request('/api/memory/facts', 'DELETE');
  }

  async _request(path, method, body) {
    try {
      const response = await fetch(apiUrl(path), {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(tx(data.detail) ?? `HTTP ${response.status}`);
      return true;
    } catch (error) {
      this.app.toast(error.message, 'error');
      return false;
    }
  }

  _render() {
    this.clear.classList.toggle('hidden', this.facts.length < 2);
    if (!this.facts.length) {
      this.list.replaceChildren(el('p', { class: 'hint' }, t('No memories yet.')));
      return;
    }
    this.list.replaceChildren(
      ...[...this.facts].reverse().map((fact) =>
        el(
          'div',
          { class: 'agenda-item' },
          el('span', { class: 'agenda-icon', title: fact.source === 'brain' ? t('Noted by her') : t('Told by you') }, icon(fact.source === 'brain' ? 'agent' : 'character', 15)),
          el('span', { class: 'agenda-text' }, el('strong', {}, fact.text)),
          iconButton('trash', { title: 'Dimentica', onClick: () => this._request(`/api/memory/facts/${encodeURIComponent(fact.id)}`, 'DELETE') }),
        ),
      ),
    );
  }
}
