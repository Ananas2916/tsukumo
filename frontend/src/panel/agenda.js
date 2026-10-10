/**
 * Agenda tab: timers, reminders, alarms and scheduled actions.
 *
 * They're added in words, as you'd say them to her ("remind me to drink in
 * 20 minutes", "timer 5 minutes", "tomorrow at 9 remind me to call Anna"),
 * or with the quick timers. The same works straight in the chat or by
 * voice: the backend understands the request and puts it here. The list
 * comes from the backend (`GET /api/reminders` and the `reminders` message),
 * with the countdown updated every second.
 */

import { apiUrl } from '../config.js';
import { el, iconButton } from '../dom.js';
import { LOCALE, t, tx } from '../i18n.js';
import { icon } from '../icons.js';

const KIND_ICON = { timer: 'clock', reminder: 'bell', alarm: 'bell', task: 'robot' };
const QUICK_TIMERS = [1, 5, 10, 25];
const EXAMPLES = [t('remind me to drink in 20 minutes'), t('tomorrow at 9 remind me to call Anna'), t('every day at 1pm remind me to have lunch')];

/** "4:32", "1:05:09": the timers' countdown. */
function countdown(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** When it goes off, for the reader: "in 4:32", "today at 18:00", "Sun 29 Dec, 12:00". */
function whenText(item, now = Date.now()) {
  const due = new Date(item.dueIso);
  const left = (due.getTime() - now) / 1000;
  if (left < 3600) return t('in {time}', { time: countdown(left) });
  const time = due.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  const today = new Date(now);
  const days = Math.round((new Date(due.toDateString()) - new Date(today.toDateString())) / 86400000);
  if (days === 0) return t('today at {time}', { time });
  if (days === 1) return t('tomorrow at {time}', { time });
  const day = due.toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });
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
      placeholder: t('E.g. "remind me to drink in 20 minutes"'),
      'aria-label': t('New reminder'),
      onKeydown: (event) => {
        if (event.key === 'Enter') this.addPhrase();
      },
    });
    this.addButton = el('button', { class: 'btn primary', type: 'button', onClick: () => this.addPhrase() }, icon('check', 15), el('span', {}, t('Add')));
    this.error = el('p', { class: 'hint error hidden' });
    const quick = el(
      'div',
      { class: 'chip-row' },
      ...QUICK_TIMERS.map((minutes) =>
        el('button', { class: 'chip', type: 'button', onClick: () => this.addTimer(minutes) }, `Timer ${minutes} min`),
      ),
    );
    const examples = el(
      'div',
      { class: 'agenda-examples' },
      el('span', { class: 'card-sub' }, t('You can also ask in the chat or by voice, for example:')),
      ...EXAMPLES.map((text) => el('button', { class: 'link-btn', type: 'button', onClick: () => this._fill(text) }, `«${text}»`)),
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
        el('header', { class: 'card-head' }, el('span', { class: 'card-icon' }, icon('clock', 16)), el('h3', {}, t('Scheduled'))),
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
      /* the `reminders` message will arrive anyway */
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
      this.app.toast(t("Couldn't remove it: {error}", { error: error.message }), 'error');
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
      if (!response.ok) throw new Error(tx(data.detail) ?? `HTTP ${response.status}`);
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
    // The countdown is needed only if something is due within the hour.
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
      this.list.replaceChildren(el('p', { class: 'hint' }, t('Nothing scheduled. Ask her for a timer or a reminder.')));
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
              item.repeat === 'daily' ? el('span', { class: 'badge info' }, icon('repeat', 11), t('every day')) : null,
            ),
          ),
          iconButton('trash', { title: t('Remove'), onClick: () => this.remove(item) }),
        ),
      ),
    );
  }
}
