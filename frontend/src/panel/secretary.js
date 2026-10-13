/**
 * The secretary's cards in the Agenda tab (backend/secretary.py): focus time,
 * the to-do list, the notes, the calendars and the mail (read only), the
 * connections (calendar links, mail account, home) and the vault.
 *
 * Everything also works by voice or in the chat ("segnati che devo...",
 * "prendi nota: ...", "cosa ho domani?", "copiami l'IBAN"): here it's
 * shown and edited by hand. The secrets (calendar links, the mail's
 * password, the vault's values) are written, never read back.
 */

import { apiUrl } from '../config.js';
import { el, iconButton } from '../dom.js';
import { LOCALE, t, tx } from '../i18n.js';
import { icon } from '../icons.js';

const FOCUS_CHOICES = [30, 60, 120];
const TOPICS = [
  ['briefing', t('Morning briefing'), t('The first time you sit at the PC in the morning: weather, events, deadlines, list, mail.')],
  ['recap', t('Evening recap'), t("After 20:30: what you did, what's left, tomorrow's first event.")],
  ['agenda', t('Calendar notices'), t('"Leave in 15 minutes" for events with a place, a heads-up before the others, clashes.')],
  ['mail', t('Mail notices'), t('Who wrote, parcels arriving today, bills (put on your list), mails waiting for an answer.')],
  ['todos', t('The list in free moments'), t('Deadlines two days and one day before, and now and then an item of the list when you have a moment.')],
];
const TRAVEL = { car: t('By car'), bike: t('By bike'), foot: t('On foot'), transit: t('Public transport (rough estimate)') };

async function api(path, method = 'GET', body = undefined) {
  const response = await fetch(apiUrl(path), {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(tx(data.detail ?? data.error) ?? `HTTP ${response.status}`);
  return data;
}

function clock(epoch) {
  return new Date(epoch * 1000).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
}

function dayLabel(date) {
  const today = new Date();
  const days = Math.round((new Date(date.toDateString()) - new Date(today.toDateString())) / 86_400_000);
  if (days === 0) return t('Today');
  if (days === 1) return t('Tomorrow');
  return date.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'short' });
}

function dueLabel(iso) {
  if (!iso) return '';
  const due = new Date(`${iso}T23:59:59`);
  const days = Math.round((new Date(due.toDateString()) - new Date(new Date().toDateString())) / 86_400_000);
  if (days < 0) return t('overdue');
  if (days === 0) return t('by today');
  if (days === 1) return t('by tomorrow');
  return t('by {day}', { day: due.toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' }) });
}

export class SecretaryCards {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.status = null;
    this.settings = null;
    this.vault = { items: [], protected: true };
    this.topics = {};
    this.important = false;
    this._build();
    app.socket.on('secretary', (message) => this._set(message));
    app.on('hello', (message) => message.secretary && this._set(message.secretary));
  }

  shown() {
    this.load();
  }

  async load() {
    try {
      this._set(await api('/api/secretary'));
    } catch {
      /* the `secretary` message arrives anyway */
    }
    try {
      this._setSettings(await api('/api/secretary/settings'));
      this._setVault(await api('/api/vault'));
      this._setTopics((await api('/api/preferences')).topics ?? {});
    } catch {
      /* from the phone these aren't there: the cards stay as they are */
    }
  }

  // ------------------------------------------------------------------ DOM
  _card(iconName, title, ...children) {
    return el('section', { class: 'card' }, el('header', { class: 'card-head' }, el('span', { class: 'card-icon' }, icon(iconName, 16)), el('h3', {}, title)), ...children);
  }

  _build() {
    // Focus time.
    this.focusText = el('span', { class: 'card-sub' });
    this.focusStop = el('button', { class: 'btn', type: 'button', onClick: () => this._focus(null) }, el('span', {}, t('End')));
    this.focusChips = el(
      'div',
      { class: 'chip-row' },
      ...FOCUS_CHOICES.map((minutes) =>
        el('button', { class: 'chip', type: 'button', onClick: () => this._focus(minutes) }, minutes < 60 ? t('{n} min', { n: minutes }) : minutes === 60 ? t('1 hour') : t('{n} hours', { n: minutes / 60 })),
      ),
    );
    const focusCard = this._card(
      'moon',
      t('Focus time'),
      el('p', { class: 'card-sub' }, t('No chatter, agents only as a bubble, everything told at the end. By voice: "proteggimi le prossime 2 ore".')),
      el('div', { class: 'secretary-focus' }, this.focusChips, this.focusText, this.focusStop),
    );

    // The to-do list.
    this.todoInput = el('input', {
      class: 'field-input',
      type: 'text',
      maxlength: 300,
      placeholder: t('Something to do, e.g. "call the dentist"'),
      'aria-label': t('New to-do'),
      onKeydown: (event) => event.key === 'Enter' && this._addTodo(),
    });
    this.todoDate = el('input', { class: 'field-input secretary-date', type: 'date', title: t('By when (optional)'), 'aria-label': t('By when (optional)') });
    this.todoStar = iconButton('star', { title: t('Important'), onClick: () => this._toggleStar() });
    this.todoList = el('div', { class: 'agenda-list' });
    this.doneList = el('div', { class: 'agenda-list' });
    this.doneBox = el('details', { class: 'secretary-done hidden' }, el('summary', {}, ''), this.doneList);
    const todoCard = this._card(
      'check',
      t('To-do list'),
      el(
        'div',
        { class: 'secretary-add' },
        this.todoInput,
        el('div', { class: 'secretary-add-row' }, this.todoDate, this.todoStar, el('button', { class: 'btn primary', type: 'button', onClick: () => this._addTodo() }, icon('check', 15), el('span', {}, t('Add')))),
      ),
      el('p', { class: 'hint' }, t('Things without a time: she brings them up in a free moment. With a time it becomes a reminder. By voice: "segnati che devo...", "cosa ho da fare?", "fatto il pane".')),
      this.todoList,
      this.doneBox,
    );

    // Notes.
    this.noteInput = el('textarea', { class: 'field-input', rows: 2, maxlength: 1200, placeholder: t('A note to keep, e.g. "the garage key is in the second drawer"'), 'aria-label': t('New note') });
    this.noteSearch = el('input', { class: 'field-input', type: 'search', placeholder: t('Search the notes'), onInput: () => this._renderNotes() });
    this.noteList = el('div', { class: 'agenda-list' });
    const notesCard = this._card(
      'book',
      t('Notes'),
      el('div', { class: 'agenda-add' }, this.noteInput, el('button', { class: 'btn primary', type: 'button', onClick: () => this._addNote() }, icon('check', 15), el('span', {}, t('Keep')))),
      el('p', { class: 'hint' }, t('By voice: "prendi nota: ...", then "dove avevo messo la chiave del garage?".')),
      this.noteSearch,
      this.noteList,
    );

    // Calendars and mail, read only.
    this.calendarList = el('div', { class: 'agenda-list' });
    this.calendarNote = el('p', { class: 'hint' });
    const calendarCard = this._card('calendar', t('Calendar'), this.calendarNote, this.calendarList);
    this.mailSummary = el('p', { class: 'card-sub' });
    this.mailList = el('div', { class: 'agenda-list' });
    this.mailRefresh = iconButton('refresh', { title: t('Read again'), onClick: () => this._refresh() });
    const mailCard = this._card('send', t('Mail'), el('div', { class: 'secretary-mail-head' }, this.mailSummary, this.mailRefresh), this.mailList);

    // The connections: calendar links, mail account, home.
    this.calendarUrls = el('textarea', { class: 'field-input', rows: 2, placeholder: t('Paste your calendar\'s private iCal link (https:// or webcal://)') });
    this.calendarSaved = el('small', { class: 'hint' });
    this.mailUser = el('input', { class: 'field-input', type: 'email', autocomplete: 'off', placeholder: 'nome@gmail.com' });
    this.mailPassword = el('input', { class: 'field-input', type: 'password', autocomplete: 'new-password', placeholder: t('App password') });
    this.mailHost = el('input', { class: 'field-input', type: 'text', placeholder: 'imap.gmail.com' });
    this.mailPort = el('input', { class: 'field-input', type: 'number', min: 1, max: 65535, placeholder: '993' });
    this.home = el('input', { class: 'field-input', type: 'text', maxlength: 160, placeholder: t('Your address, e.g. "Via Roma 1, Genova"') });
    this.travel = el('select', { class: 'field-input' }, ...Object.entries(TRAVEL).map(([value, label]) => el('option', { value }, label)));
    this.linksResult = el('p', { class: 'hint hidden' });
    this.topicSwitches = TOPICS.map(([id, label, hint]) => {
      const input = el('input', { type: 'checkbox', role: 'switch', onChange: () => this._setTopic(id, input.checked) });
      const node = el('label', { class: 'switch-row' }, el('span', { class: 'switch-text' }, el('span', {}, label), el('small', {}, hint)), input, el('span', { class: 'switch' }));
      return { id, input, node };
    });
    const linksCard = this._card(
      'globe',
      t('Connections'),
      el('p', { class: 'card-sub' }, t('Read only: nothing is ever sent, booked or paid. The links and the password stay on this PC (.env) and are never shown again.')),
      el('div', { class: 'row-label' }, t('Calendars')),
      this.calendarUrls,
      this.calendarSaved,
      el('p', { class: 'hint' }, t('Google Calendar: Settings → your calendar → "Secret address in iCal format". Outlook: Settings → Calendar → Shared calendars → Publish → ICS. One link per line.')),
      el('div', { class: 'row-label' }, t('Mail (IMAP)')),
      el('div', { class: 'secretary-grid' }, this.mailUser, this.mailPassword, this.mailHost, this.mailPort),
      el('p', { class: 'hint' }, t('Use an app password, not your real one: Gmail → Google account → Security → 2-Step Verification → App passwords. The server is guessed from the address.')),
      el('div', { class: 'row-label' }, t('Where you leave from')),
      el('div', { class: 'secretary-grid' }, this.home, this.travel),
      el(
        'div',
        { class: 'agenda-add' },
        el('button', { class: 'btn primary', type: 'button', onClick: () => this._saveLinks() }, icon('check', 15), el('span', {}, t('Save'))),
        el('button', { class: 'btn', type: 'button', onClick: () => this._check() }, icon('refresh', 15), el('span', {}, t('Check'))),
        el('button', { class: 'link-btn', type: 'button', onClick: () => this._forget() }, t('Disconnect calendar and mail')),
      ),
      this.linksResult,
      el('div', { class: 'row-label' }, t('What she tells you')),
      ...this.topicSwitches.map((item) => item.node),
    );

    // The vault.
    this.vaultList = el('div', { class: 'agenda-list' });
    this.vaultLabel = el('input', { class: 'field-input', type: 'text', maxlength: 60, placeholder: t('Name, e.g. IBAN') });
    this.vaultValue = el('input', { class: 'field-input', type: 'password', maxlength: 500, autocomplete: 'off', placeholder: t('Value') });
    this.vaultNote = el('p', { class: 'hint' });
    const vaultCard = this._card(
      'key',
      t('Vault'),
      el('p', { class: 'card-sub' }, t('Values to copy on the fly: "copiami l\'IBAN" puts it in the clipboard (emptied after a minute). Encrypted with your Windows account; never shown to a brain or the phone.')),
      el('div', { class: 'agenda-add' }, this.vaultLabel, this.vaultValue, el('button', { class: 'btn primary', type: 'button', onClick: () => this._addSecret() }, icon('check', 15), el('span', {}, t('Add')))),
      this.vaultNote,
      this.vaultList,
    );

    this.root.append(focusCard, todoCard, notesCard, calendarCard, mailCard, linksCard, vaultCard);
    this._renderFocus();
  }

  // ---------------------------------------------------------------- state
  _set(status) {
    this.status = status;
    this._renderFocus();
    this._renderTodos();
    this._renderNotes();
    this._renderCalendar();
    this._renderMail();
  }

  _setSettings(settings) {
    this.settings = settings;
    const mail = settings.mail ?? {};
    this.mailUser.value = mail.user ?? '';
    this.mailPassword.value = '';
    this.mailPassword.placeholder = mail.password ? t('App password saved (type to change it)') : t('App password');
    this.mailHost.value = mail.host ?? '';
    this.mailHost.placeholder = mail.guessedHost || 'imap.gmail.com';
    this.mailPort.value = mail.port && mail.port !== 993 ? mail.port : '';
    this.home.value = settings.home ?? '';
    this.travel.value = settings.travel ?? 'car';
    this.calendarUrls.value = '';
    this.calendarSaved.textContent = settings.calendars ? t('{n} calendar link(s) saved: paste new ones to replace them.', { n: settings.calendars }) : '';
  }

  _setVault(vault) {
    this.vault = vault ?? { items: [] };
    this.vaultNote.textContent = this.vault.protected === false ? t('On this system the values are only obfuscated, not encrypted.') : '';
    this.vaultList.replaceChildren(
      ...(this.vault.items ?? []).map((item) =>
        el(
          'div',
          { class: 'agenda-item' },
          el('span', { class: 'agenda-icon' }, icon('key', 15)),
          el('span', { class: 'agenda-text' }, el('strong', {}, item.label), el('small', {}, item.hint)),
          iconButton('clip', { title: t('Copy'), onClick: () => this._copy(item) }),
          iconButton('trash', { title: t('Remove'), onClick: () => this._removeSecret(item) }),
        ),
      ),
    );
    if (!this.vault.items?.length) this.vaultList.replaceChildren(el('p', { class: 'hint' }, t('Empty. Add the IBAN, the tax code, the plate...')));
  }

  _setTopics(topics) {
    this.topics = topics;
    for (const item of this.topicSwitches) item.input.checked = topics[item.id] !== false;
  }

  // ---------------------------------------------------------------- render
  _renderFocus() {
    const until = this.status?.focus?.until;
    this.focusText.textContent = until ? t('Focus until {time}', { time: clock(until) }) : '';
    this.focusStop.classList.toggle('hidden', !until);
    this.focusChips.classList.toggle('hidden', Boolean(until));
  }

  _renderTodos() {
    const todos = this.status?.notebook?.todos ?? [];
    const open = todos.filter((item) => !item.done);
    const done = todos.filter((item) => item.done);
    this.todoList.replaceChildren(...open.map((item) => this._todoRow(item)));
    if (!open.length) this.todoList.replaceChildren(el('p', { class: 'hint' }, t('Nothing to do. Lucky you!')));
    this.doneBox.classList.toggle('hidden', !done.length);
    this.doneBox.querySelector('summary').textContent = t('Done ({n})', { n: done.length });
    this.doneList.replaceChildren(...done.map((item) => this._todoRow(item)));
  }

  _todoRow(item) {
    const box = el('input', { type: 'checkbox', class: 'secretary-check', 'aria-label': t('Done'), onChange: () => this._updateTodo(item, { done: box.checked }) });
    box.checked = Boolean(item.done);
    const due = dueLabel(item.dueIso);
    return el(
      'div',
      { class: `agenda-item secretary-todo${item.done ? ' done' : ''}${item.important ? ' important' : ''}` },
      box,
      el(
        'span',
        { class: 'agenda-text' },
        el('strong', { title: item.text }, item.text),
        due || item.source === 'mail' ? el('small', {}, due ? el('span', { class: `badge ${due === t('overdue') ? 'danger' : 'info'}` }, due) : null, item.source === 'mail' ? el('span', {}, t('from the mail')) : null) : null,
      ),
      iconButton('star', { title: item.important ? t('Not important') : t('Important'), className: `icon-btn${item.important ? ' on' : ''}`, onClick: () => this._updateTodo(item, { important: !item.important }) }),
      iconButton('trash', { title: t('Remove'), onClick: () => this._removeTodo(item) }),
    );
  }

  _renderNotes() {
    const query = this.noteSearch.value.trim().toLowerCase();
    const notes = (this.status?.notebook?.notes ?? []).filter((note) => !query || note.text.toLowerCase().includes(query));
    this.noteList.replaceChildren(
      ...notes.map((note) =>
        el(
          'div',
          { class: 'agenda-item' },
          el('span', { class: 'agenda-text secretary-note' }, el('span', {}, note.text), el('small', {}, new Date(note.created * 1000).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' }))),
          iconButton('trash', { title: t('Remove'), onClick: () => this._removeNote(note) }),
        ),
      ),
    );
    if (!notes.length) this.noteList.replaceChildren(el('p', { class: 'hint' }, query ? t('No note matches.') : t('No notes yet.')));
  }

  _renderCalendar() {
    const calendar = this.status?.calendar ?? {};
    if (!calendar.configured) {
      this.calendarNote.textContent = t('Connect your calendars in Connections, below: she reads them, never writes.');
      this.calendarList.replaceChildren();
      return;
    }
    const names = (calendar.calendars ?? []).join(', ');
    this.calendarNote.textContent = calendar.error ? t('Not read: {error}', { error: calendar.error }) : names;
    const horizon = Date.now() + 7 * 86_400_000;
    const events = (calendar.events ?? []).filter((event) => event.start * 1000 < horizon);
    const rows = [];
    let lastDay = '';
    for (const event of events) {
      const start = new Date(event.start * 1000);
      const day = start.toDateString();
      if (day !== lastDay) {
        rows.push(el('div', { class: 'agenda-day' }, dayLabel(start)));
        lastDay = day;
      }
      rows.push(
        el(
          'div',
          { class: 'agenda-item' },
          el('span', { class: 'agenda-icon' }, icon('calendar', 15)),
          el('span', { class: 'agenda-text' }, el('strong', { title: event.title }, event.title), el('small', {}, event.allDay ? t('all day') : `${clock(event.start)}–${clock(event.end)}`, event.location ? el('span', {}, event.location) : null)),
        ),
      );
    }
    this.calendarList.replaceChildren(...rows);
    if (!rows.length) this.calendarList.replaceChildren(el('p', { class: 'hint' }, t('Nothing in the next 7 days.')));
  }

  _renderMail() {
    const mail = this.status?.mail ?? {};
    this.mailRefresh.classList.toggle('hidden', !mail.configured);
    if (!mail.configured) {
      this.mailSummary.textContent = t('Connect your mailbox in Connections, below: read only, nothing is marked as read.');
      this.mailList.replaceChildren();
      return;
    }
    const summary = mail.summary ?? {};
    this.mailSummary.textContent = mail.error
      ? t('Not read: {error}', { error: mail.error })
      : t('{account}: {people} from people, {waiting} waiting for an answer, {parcels} parcels, {bills} bills', { account: mail.account, ...summary });
    const section = (title, items) =>
      items?.length
        ? [
            el('div', { class: 'agenda-day' }, title),
            ...items.slice(0, 5).map((item) =>
              el(
                'div',
                { class: `agenda-item${item.seen ? '' : ' unread'}` },
                el('span', { class: 'agenda-text' }, el('strong', { title: item.subject }, item.subject), el('small', {}, `${item.sender} · ${new Date(item.date * 1000).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })}`)),
              ),
            ),
          ]
        : [];
    this.mailList.replaceChildren(
      ...section(t('From people'), mail.important),
      ...section(t('Waiting for your answer'), mail.waiting),
      ...section(t('Parcels'), mail.parcels),
      ...section(t('Bills'), mail.bills),
    );
  }

  // --------------------------------------------------------------- actions
  async _run(action, done) {
    try {
      const result = await action();
      if (done) this.app.toast(done);
      return result;
    } catch (error) {
      this.app.toast(error.message, 'error');
      return null;
    }
  }

  _focus(minutes) {
    return this._run(() => (minutes ? api('/api/focus', 'POST', { minutes }) : api('/api/focus', 'DELETE')));
  }

  _toggleStar() {
    this.important = !this.important;
    this.todoStar.classList.toggle('on', this.important);
  }

  async _addTodo() {
    const text = this.todoInput.value.trim();
    if (!text) return;
    const ok = await this._run(() => api('/api/todos', 'POST', { text, by: this.todoDate.value || null, important: this.important }));
    if (ok) {
      this.todoInput.value = '';
      this.todoDate.value = '';
      if (this.important) this._toggleStar();
    }
  }

  _updateTodo(item, changes) {
    return this._run(() => api(`/api/todos/${encodeURIComponent(item.id)}`, 'POST', changes));
  }

  _removeTodo(item) {
    return this._run(() => api(`/api/todos/${encodeURIComponent(item.id)}`, 'DELETE'));
  }

  async _addNote() {
    const text = this.noteInput.value.trim();
    if (!text) return;
    if (await this._run(() => api('/api/notes', 'POST', { text }))) this.noteInput.value = '';
  }

  _removeNote(note) {
    return this._run(() => api(`/api/notes/${encodeURIComponent(note.id)}`, 'DELETE'));
  }

  _refresh() {
    return this._run(() => api('/api/secretary/refresh', 'POST'));
  }

  async _saveLinks() {
    const body = {
      mailUser: this.mailUser.value.trim(),
      mailHost: this.mailHost.value.trim(),
      home: this.home.value.trim(),
      travel: this.travel.value,
    };
    if (this.calendarUrls.value.trim()) body.calendarUrls = this.calendarUrls.value;
    if (this.mailPassword.value) body.mailPassword = this.mailPassword.value;
    if (this.mailPort.value) body.mailPort = Number(this.mailPort.value);
    const settings = await this._run(() => api('/api/secretary/settings', 'POST', body), t('Saved.'));
    if (settings) this._setSettings(settings);
  }

  async _forget() {
    const settings = await this._run(() => api('/api/secretary/settings', 'POST', { calendarUrls: '', mailUser: '', mailHost: '' }), t('Calendar and mail disconnected.'));
    if (settings) this._setSettings(settings);
  }

  async _check() {
    this.linksResult.classList.remove('hidden');
    this.linksResult.textContent = t('Checking…');
    const result = await this._run(() => api('/api/secretary/check', 'POST'));
    if (!result) {
      this.linksResult.classList.add('hidden');
      return;
    }
    const parts = [];
    if (result.calendar) parts.push(result.calendar.ok ? t('Calendar: {n} events read.', { n: result.calendar.events }) : t('Calendar: {error}', { error: result.calendar.error }));
    if (result.mail) parts.push(result.mail.ok ? t('Mail: connected.') : t('Mail: {error}', { error: result.mail.error }));
    this.linksResult.textContent = parts.join(' ') || t('Nothing to check: save a calendar link or a mail account first.');
  }

  _setTopic(id, value) {
    return this._run(() => api('/api/preferences', 'POST', { topics: { [id]: value } }));
  }

  async _addSecret() {
    const label = this.vaultLabel.value.trim();
    const value = this.vaultValue.value;
    if (!label || !value) return;
    if (await this._run(() => api('/api/vault', 'POST', { label, value }))) {
      this.vaultLabel.value = '';
      this.vaultValue.value = '';
      await this._reloadVault();
    }
  }

  async _removeSecret(item) {
    if (await this._run(() => api(`/api/vault/${encodeURIComponent(item.id)}`, 'DELETE'))) await this._reloadVault();
  }

  async _reloadVault() {
    try {
      this._setVault(await api('/api/vault'));
    } catch {
      /* stays as it was */
    }
  }

  async _copy(item) {
    // In Electron the main process reads the value and copies it: the page never sees it.
    const copied = window.companion?.copySecret
      ? await window.companion.copySecret(item.id)
      : await this._run(async () => {
          const { value } = await api(`/api/vault/${encodeURIComponent(item.id)}`);
          await navigator.clipboard.writeText(value);
          return true;
        });
    this.app.toast(copied ? t('{label} copied', { label: item.label }) : t("Couldn't copy it."), copied ? 'info' : 'error');
  }
}
