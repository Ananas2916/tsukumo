/**
 * "Chi è e cosa sa di te": nome, carattere e ricordi, uguali per ogni cervello.
 *
 * Il backend (backend/memory.py) aggiunge personalita' e ricordi a ogni turno,
 * che il cervello sia Claude Code, Codex, OpenClaw o un modello locale. I
 * ricordi entrano dicendole "ricordati che...", quando il cervello ne annota
 * uno da solo, oppure da qui; da qui si vedono tutti e si cancellano.
 */

import { apiUrl } from '../config.js';
import { el, iconButton } from '../dom.js';
import { icon } from '../icons.js';

export class MemoryCard {
  /**
   * @param {{socket: object, toast: Function}} app
   * @param {(iconName: string, title: string, ...children: Node[]) => HTMLElement} card costruttore dei riquadri
   */
  constructor(app, card) {
    this.app = app;
    this.facts = [];

    this.name = el('input', { class: 'field-input', type: 'text', maxlength: 40, placeholder: 'Tsukumo' });
    this.traits = el('textarea', {
      class: 'field-input memory-traits',
      rows: 2,
      maxlength: 400,
      placeholder: 'Es. calorosa, concisa e un po’ giocosa',
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
      placeholder: 'Es. «lavoro in Python e odio le riunioni»',
      'aria-label': 'Nuovo ricordo',
      onKeydown: (event) => {
        if (event.key === 'Enter') this._add();
      },
    });
    const add = el('button', { class: 'btn', type: 'button', onClick: () => this._add() }, icon('check', 15), el('span', {}, 'Aggiungi'));
    this.list = el('div', { class: 'agenda-list memory-list' });
    this.clear = el('button', { class: 'link-btn hidden', type: 'button', onClick: () => this._clearAll() }, 'Dimentica tutto');

    this.node = card(
      'book',
      'Chi è e cosa sa di te',
      el('p', { class: 'card-sub' }, 'Vale per ogni cervello: cambiando agente o modello resta la stessa, e si ricorda di te.'),
      el('label', { class: 'row' }, el('span', { class: 'row-label' }, 'Nome'), this.name),
      el('label', { class: 'row' }, el('span', { class: 'row-label' }, 'Carattere'), this.traits),
      el('div', { class: 'agenda-add' }, this.input, add),
      el('p', { class: 'hint' }, 'Oppure dille «ricordati che…»; «cosa ricordi di me?» e «dimentica che…» funzionano a voce.'),
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
      /* arriva comunque col messaggio `memory` */
    }
  }

  _set(memory) {
    this.facts = memory.facts ?? [];
    const persona = memory.persona ?? {};
    // Non riscrivere i campi mentre li stai modificando.
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
    if (!window.confirm('Dimentico tutti i ricordi? Nome e carattere restano.')) return;
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
      if (!response.ok) throw new Error(data.detail ?? `HTTP ${response.status}`);
      return true;
    } catch (error) {
      this.app.toast(error.message, 'error');
      return false;
    }
  }

  _render() {
    this.clear.classList.toggle('hidden', this.facts.length < 2);
    if (!this.facts.length) {
      this.list.replaceChildren(el('p', { class: 'hint' }, 'Ancora nessun ricordo.'));
      return;
    }
    this.list.replaceChildren(
      ...[...this.facts].reverse().map((fact) =>
        el(
          'div',
          { class: 'agenda-item' },
          el('span', { class: 'agenda-icon', title: fact.source === 'brain' ? 'Annotato da lei' : 'Detto da te' }, icon(fact.source === 'brain' ? 'agent' : 'character', 15)),
          el('span', { class: 'agenda-text' }, el('strong', {}, fact.text)),
          iconButton('trash', { title: 'Dimentica', onClick: () => this._request(`/api/memory/facts/${encodeURIComponent(fact.id)}`, 'DELETE') }),
        ),
      ),
    );
  }
}
