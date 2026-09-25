/**
 * Scheda Agenda: timer, promemoria, sveglie e azioni programmate.
 *
 * Si aggiungono a parole, come si direbbe a lei ("tra 20 minuti ricordami di
 * bere", "timer 5 minuti", "domani alle 9 ricordami la riunione"), oppure coi
 * timer rapidi. Lo stesso si puo' fare direttamente in chat o a voce: il
 * backend capisce la richiesta e la mette qui. L'elenco arriva dal backend
 * (`GET /api/reminders` e il messaggio `reminders`), con il conto alla
 * rovescia aggiornato ogni secondo.
 */

import { apiUrl } from '../config.js';
import { el, iconButton } from '../dom.js';
import { icon } from '../icons.js';

const KIND_ICON = { timer: 'clock', reminder: 'bell', alarm: 'bell', task: 'robot' };
const QUICK_TIMERS = [1, 5, 10, 25];
const EXAMPLES = ['tra 20 minuti ricordami di bere', 'domani alle 9 ricordami la riunione', 'ogni giorno alle 13 ricordami di pranzare'];

/** "4:32", "1:05:09": il conto alla rovescia dei timer. */
function countdown(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Quando scatta, per chi legge: "tra 4:32", "oggi alle 18:00", "dom 29 dic, 12:00". */
function whenText(item, now = Date.now()) {
  const due = new Date(item.dueIso);
  const left = (due.getTime() - now) / 1000;
  if (left < 3600) return `tra ${countdown(left)}`;
  const time = due.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  const today = new Date(now);
  const days = Math.round((new Date(due.toDateString()) - new Date(today.toDateString())) / 86400000);
  if (days === 0) return `oggi alle ${time}`;
  if (days === 1) return `domani alle ${time}`;
  const day = due.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
  return `${day}, ${time}`;
}

export class AgendaView {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.items = [];
    this.timer = null;

    this.input = el('input', {
      class: 'field-input',
      type: 'text',
      placeholder: 'Es. «tra 20 minuti ricordami di bere»',
      'aria-label': 'Nuovo promemoria',
      onKeydown: (event) => {
        if (event.key === 'Enter') this.addPhrase();
      },
    });
    this.addButton = el('button', { class: 'btn primary', type: 'button', onClick: () => this.addPhrase() }, icon('check', 15), el('span', {}, 'Aggiungi'));
    this.error = el('p', { class: 'hint error hidden' });
    const quick = el(
      'div',
      { class: 'chip-row' },
      ...QUICK_TIMERS.map((minutes) =>
        el('button', { class: 'chip', type: 'button', onClick: () => this.addTimer(minutes) }, `Timer ${minutes} min`),
      ),
    );
    const examples = el(
      'p',
      { class: 'card-sub' },
      'Anche in chat o a voce: ',
      ...EXAMPLES.flatMap((text, index) => [
        el('button', { class: 'link-btn', type: 'button', onClick: () => this._fill(text) }, `«${text}»`),
        index < EXAMPLES.length - 1 ? ', ' : '',
      ]),
    );

    this.list = el('div', { class: 'agenda-list' });
    this.root.append(
      el(
        'section',
        { class: 'card' },
        el('header', { class: 'card-head' }, el('span', { class: 'card-icon' }, icon('bell', 16)), el('h3', {}, 'Nuovo')),
        el('div', { class: 'agenda-add' }, this.input, this.addButton),
        this.error,
        quick,
        examples,
      ),
      el(
        'section',
        { class: 'card' },
        el('header', { class: 'card-head' }, el('span', { class: 'card-icon' }, icon('clock', 16)), el('h3', {}, 'In programma')),
        this.list,
      ),
    );

    app.socket.on('reminders', (message) => this._set(message.reminders ?? []));
    app.socket.on('hello', (message) => this._set(message.reminders ?? []));
    app.socket.on('reminder', (message) => {
      if (message.event === 'fired') this.app.toast(`⏰ ${message.reminder?.label ?? 'Promemoria'}`);
    });
    this._set([]);
  }

  shown() {
    this.load();
    this.input.focus();
  }

  async load() {
    try {
      const response = await fetch(apiUrl('/api/reminders'));
      if (response.ok) this._set((await response.json()).reminders ?? []);
    } catch {
      /* il messaggio `reminders` arrivera' comunque */
    }
  }

  async addPhrase() {
    const phrase = this.input.value.trim();
    if (!phrase) return;
    const ok = await this._post({ phrase });
    if (ok) this.input.value = '';
  }

  addTimer(minutes) {
    return this._post({ kind: 'timer', seconds: minutes * 60 });
  }

  async remove(item) {
    try {
      await fetch(apiUrl(`/api/reminders/${encodeURIComponent(item.id)}`), { method: 'DELETE' });
    } catch (error) {
      this.app.toast(`Non riesco a toglierlo: ${error.message}`, 'error');
    }
  }

  async _post(body) {
    this.error.classList.add('hidden');
    this.addButton.disabled = true;
    try {
      const response = await fetch(apiUrl('/api/reminders'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail ?? `HTTP ${response.status}`);
      return true;
    } catch (error) {
      this.error.textContent = error.message;
      this.error.classList.remove('hidden');
      return false;
    } finally {
      this.addButton.disabled = false;
    }
  }

  _fill(text) {
    this.input.value = text;
    this.input.focus();
  }

  _set(items) {
    this.items = items;
    this._render();
    clearInterval(this.timer);
    // Il conto alla rovescia serve solo se c'e' qualcosa entro l'ora.
    if (items.some((item) => new Date(item.dueIso).getTime() - Date.now() < 3700 * 1000)) {
      this.timer = setInterval(() => this._tick(), 1000);
    }
  }

  _tick() {
    for (const row of this.list.querySelectorAll('[data-id]')) {
      const item = this.items.find((candidate) => candidate.id === row.dataset.id);
      if (item) row.querySelector('.agenda-when').textContent = whenText(item);
    }
  }

  _render() {
    if (!this.items.length) {
      this.list.replaceChildren(el('p', { class: 'hint' }, 'Niente in programma. Chiedile un timer o un promemoria.'));
      return;
    }
    this.list.replaceChildren(
      ...this.items.map((item) =>
        el(
          'div',
          { class: `agenda-item kind-${item.kind}`, dataset: { id: item.id } },
          el('span', { class: 'agenda-icon' }, icon(KIND_ICON[item.kind] ?? 'bell', 16)),
          el(
            'span',
            { class: 'agenda-text' },
            el('strong', {}, item.label),
            el(
              'small',
              {},
              el('span', { class: 'agenda-when' }, whenText(item)),
              item.repeat === 'daily' ? el('span', { class: 'badge info' }, icon('repeat', 11), 'ogni giorno') : null,
            ),
          ),
          iconButton('trash', { title: 'Togli', onClick: () => this.remove(item) }),
        ),
      ),
    );
  }
}
