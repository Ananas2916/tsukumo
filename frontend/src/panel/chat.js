/**
 * La chat del pannello.
 *
 * Il testo arriva a pezzi (`token`) mentre il cervello scrive: la bolla si
 * aggiorna al volo e il markdown viene reso quando serve. Gli errori non sono
 * piu' righe grigie da decifrare: sono schede con il motivo, un consiglio e un
 * bottone che porta dritto a dove si sistema.
 */

import { apiUrl } from '../config.js';
import { el, iconButton, readSetting, writeSetting } from '../dom.js';
import { icon, iconSvg } from '../icons.js';
import { renderMarkdown } from '../markdown.js';

const HISTORY_KEY = 'dc:chat';
const HISTORY_LIMIT = 200;

const SUGGESTIONS = [
  'Ciao! Cosa sai fare?',
  'Che tempo fa domani?',
  'Raccontami una cosa curiosa',
  'Ricordami di fare una pausa tra 30 minuti',
];

const SOURCE_TAB = { llm: 'llm', tts: 'tts', stt: 'stt' };

/** "prima voce dopo 1,4 s · risposta completa in 5,2 s" */
function describeTimings({ firstText, firstVoice, total }) {
  const seconds = (ms) => `${(ms / 1000).toLocaleString('it-IT', { maximumFractionDigits: 1 })} s`;
  const parts = [];
  if (firstText != null) parts.push(`primo testo dopo ${seconds(firstText)}`);
  if (firstVoice != null) parts.push(`prima voce dopo ${seconds(firstVoice)}`);
  if (total != null) parts.push(`completa in ${seconds(total)}`);
  return parts.join(' · ');
}

export class ChatView {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.socket = app.socket;
    this.messagesEl = root.querySelector('#messages');
    this.input = root.querySelector('#input');
    this.form = root.querySelector('#composer');
    this.typing = root.querySelector('#typing');
    this.send = root.querySelector('#btn-send');
    this.mic = root.querySelector('#btn-mic');
    this.read = root.querySelector('#btn-read');
    this.chip = root.querySelector('#engine-chip');
    this.newChat = root.querySelector('#btn-new-chat');
    this.attach = root.querySelector('#btn-attach');
    this.screenButton = root.querySelector('#btn-screen');
    this.fileInput = root.querySelector('#file-input');
    this.attachmentsEl = root.querySelector('#attachments');
    /** File pronti da mandare col prossimo messaggio: `{name, path, screen}`. */
    this.attachments = [];

    this.mic.innerHTML = iconSvg('mic', 18);
    this.read.innerHTML = iconSvg('volume', 18);
    this.newChat.append(icon('newChat', 16), el('span', {}, 'Nuova'));
    this.attach.innerHTML = iconSvg('clip', 18);
    this.screenButton.append(icon('screen', 16), el('span', {}, 'Schermo'));
    this.screenButton.classList.toggle('hidden', !app.companion?.captureScreen);

    /** @type {{role: string, text: string, note?: string, hint?: string, source?: string, node?: HTMLElement}[]} */
    this.history = readSetting(HISTORY_KEY, []);
    /** Risposta in corso, per turno del backend. */
    this.pending = new Map();
    this.readMode = false;
    this.busy = 'idle';
    this._renderQueued = new Set();

    this._bind();
    this._listen();
    this.renderAll();
    this._renderSend();
  }

  shown(options = {}) {
    if (options.text) {
      this.input.value += options.text;
      this._autoGrow();
    }
    this._scrollToEnd();
    requestAnimationFrame(() => this.input.focus());
  }

  // ------------------------------------------------------------ composer
  _bind() {
    this.input.addEventListener('input', () => this._autoGrow());
    this.input.addEventListener('keydown', (event) => {
      // Invio manda, Maiusc+Invio va a capo.
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.form.requestSubmit();
      }
    });

    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (this.busy !== 'idle' && !this.input.value.trim()) {
        this.socket.cancel();
        return;
      }
      this.submit(this.input.value);
    });

    this.read.addEventListener('click', () => {
      this.readMode = !this.readMode;
      this.read.classList.toggle('active', this.readMode);
      this.input.placeholder = this.readMode ? 'Testo da farle leggere…' : 'Scrivile qualcosa…';
      this.input.focus();
    });

    this.mic.addEventListener('click', () => {
      if (!this.app.companion) {
        this.app.toast('Il microfono si usa dalla finestra desktop.', 'warn');
        return;
      }
      if ((this.app.engines?.stt?.state ?? 'off') === 'off') {
        this.app.showTab('engines', { section: 'stt' });
        this.app.toast("Scegli prima come deve ascoltarti.", 'warn');
        return;
      }
      this.app.companion.sendToPet({ type: 'mic' });
    });

    this.newChat.addEventListener('click', () => {
      this.socket.reset();
      this.clear();
    });

    this.chip.addEventListener('click', () => this.app.showTab('engines', { section: 'llm' }));

    // File: graffetta, trascinamento sulla chat, screenshot.
    this.attach.addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', () => {
      this.addFiles([...this.fileInput.files]);
      this.fileInput.value = '';
    });
    this.root.addEventListener('dragover', (event) => {
      if (!event.dataTransfer?.types?.includes('Files')) return;
      event.preventDefault();
      this.root.classList.add('drop-target');
    });
    this.root.addEventListener('dragleave', (event) => {
      if (!this.root.contains(event.relatedTarget)) this.root.classList.remove('drop-target');
    });
    this.root.addEventListener('drop', (event) => {
      event.preventDefault();
      this.root.classList.remove('drop-target');
      this.addFiles([...(event.dataTransfer?.files ?? [])]);
    });
    this.screenButton.addEventListener('click', () => this.addScreen());
  }

  /**
   * In Electron il file ha un percorso vero: l'agente lo apre dove sta. Nel
   * browser non c'e', quindi lo si carica sul backend (`/api/attachments`).
   */
  async addFiles(files) {
    for (const file of files) {
      let path = this.app.companion?.pathForFile?.(file) ?? null;
      if (!path) {
        try {
          const response = await fetch(apiUrl(`/api/attachments?name=${encodeURIComponent(file.name)}`), { method: 'POST', body: file });
          const data = await response.json();
          if (!response.ok) throw new Error(data.detail ?? `HTTP ${response.status}`);
          path = data.path;
        } catch (error) {
          this.app.toast(`${file.name}: ${error.message}`, 'error');
          continue;
        }
      }
      this.attachments.push({ name: file.name, path, screen: false });
    }
    this._renderAttachments();
    this.input.focus();
  }

  async addScreen() {
    try {
      const path = await this.app.companion.captureScreen();
      this.attachments.push({ name: 'Schermo', path, screen: true });
      this._renderAttachments();
      this.input.focus();
    } catch (error) {
      this.app.toast(`Non riesco a catturare lo schermo: ${error.message}`, 'error');
    }
  }

  _renderAttachments() {
    this.attachmentsEl.classList.toggle('hidden', !this.attachments.length);
    this.attachmentsEl.replaceChildren(
      ...this.attachments.map((item, index) =>
        el(
          'span',
          { class: 'attachment' },
          icon(item.screen ? 'screen' : 'clip', 13),
          el('span', {}, item.name),
          iconButton('close', {
            title: 'Togli',
            size: 12,
            onClick: () => {
              this.attachments.splice(index, 1);
              this._renderAttachments();
            },
          }),
        ),
      ),
    );
    this._renderSend();
  }

  submit(raw) {
    const text = raw.trim();
    if (this.attachments.length && !this.readMode) {
      const files = this.attachments.map((item) => item.path);
      const screen = this.attachments.some((item) => item.screen);
      this.attachments = [];
      this._renderAttachments();
      this.input.value = '';
      this._autoGrow();
      this.socket.send({ type: 'chat', text, files, screen });
      return;
    }
    if (!text) return;
    this.input.value = '';
    this._autoGrow();
    if (this.readMode) {
      // "say" non passa dal cervello e il backend non lo ripete come messaggio utente.
      this.add({ role: 'say', text, note: 'letto ad alta voce' });
      this.socket.say(text);
    } else {
      this.socket.chat(text);
    }
  }

  _autoGrow() {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(140, this.input.scrollHeight)}px`;
    this._renderSend();
  }

  _renderSend() {
    const stop = this.busy !== 'idle' && !this.input.value.trim() && !this.attachments?.length;
    this.send.innerHTML = iconSvg(stop ? 'stop' : 'send', 17);
    this.send.classList.toggle('stop', stop);
    this.send.title = stop ? 'Interrompi' : 'Invia (Invio)';
  }

  // ------------------------------------------------------------- backend
  _listen() {
    const { socket, app } = this;

    app.on('busy', (busy) => {
      if (busy === 'thinking' && this.busy !== 'thinking') this._setTypingLabel('sta pensando');
      this.busy = busy;
      this.typing.classList.toggle('hidden', busy !== 'thinking');
      this._renderSend();
      if (busy === 'thinking') this._scrollToEnd();
    });

    app.on('engines', (engines) => this._renderChip(engines));
    app.on('mic', (state) => {
      this.mic.classList.toggle('active', Boolean(state.enabled && (state.mode !== 'push' || state.held)));
    });

    socket.on('user', (message) => {
      const files = (message.files ?? []).map((file) => (message.screen ? 'schermo' : file.name));
      this.add({ role: 'user', text: message.text, note: files.length ? `📎 ${files.join(', ')}` : undefined });
    });

    // L'agente usa un tool: la riga "sta pensando" dice cosa sta facendo.
    socket.on('working', (message) => {
      if (message.label) this._setTypingLabel(message.label);
    });

    socket.on('token', (message) => {
      let reply = this.pending.get(message.turn);
      if (!reply) {
        reply = this.add({ role: 'assistant', text: '' });
        this.pending.set(message.turn, reply);
      }
      reply.text += message.text;
      this._queueRender(reply);
    });

    socket.on('reply', (message) => {
      if (message.said) return;
      const reply = this.pending.get(message.turn);
      this.pending.delete(message.turn);
      if (reply) {
        // Il testo arrivato a pezzi resta quello mostrato (col suo markdown);
        // la versione "pulita" del backend serve solo alla voce.
        reply.text = reply.text.trim() || message.text;
        if (message.steps?.length) reply.steps = message.steps.map((step) => step.label);
        if (message.timings) reply.timings = message.timings;
        if (message.cancelled) reply.note = 'interrotta';
        if (!reply.text) this.remove(reply);
        else this._renderNode(reply);
        this._save();
      } else if (message.text && message.cancelled !== undefined && !message.failed) {
        this.add({ role: 'assistant', text: message.text, note: message.cancelled ? 'interrotta' : undefined });
      }
    });

    socket.on('notice', (message) => this.add({ role: 'notice', text: message.message }));
    socket.on('error', (message) =>
      this.add({
        role: 'error',
        text: message.message ?? 'Errore',
        hint: message.hint,
        source: message.source,
        action: message.action,
      }),
    );
    socket.on('transcript', (message) => {
      if (!message.text?.trim()) this.app.toast('Non ho capito, puoi ripetere?', 'warn');
    });
    socket.on('reset', () => this.clear());
  }

  _renderChip(engines) {
    const llm = engines?.llm;
    this.chip.querySelector('.dot').dataset.state = llm?.state ?? 'unknown';
    this.root.querySelector('#engine-chip-text').textContent = llm ? llm.label : '…';
    this.chip.title = llm?.detail ? `${llm.label}: ${llm.detail}` : 'Cambia cervello';
  }

  // ------------------------------------------------------------ messaggi
  add(message) {
    this.history.push(message);
    this.messagesEl.append(this._node(message));
    this._renderEmpty();
    this._scrollToEnd();
    this._save();
    return message;
  }

  remove(message) {
    message.node?.remove();
    this.history = this.history.filter((item) => item !== message);
    this._renderEmpty();
  }

  clear() {
    this.history = [];
    this.pending.clear();
    this._save();
    this.renderAll();
  }

  renderAll() {
    this.messagesEl.replaceChildren();
    for (const message of this.history) this.messagesEl.append(this._node(message));
    this._renderEmpty();
    this._scrollToEnd();
  }

  _queueRender(message) {
    if (this._renderQueued.has(message)) return;
    this._renderQueued.add(message);
    requestAnimationFrame(() => {
      this._renderQueued.delete(message);
      this._renderNode(message);
      this._scrollToEnd(true);
    });
  }

  _node(message) {
    const node = el('div', { class: `msg ${message.role}` });
    message.node = node;
    this._fill(node, message);
    return node;
  }

  _renderNode(message) {
    if (!message.node) return;
    message.node.replaceChildren();
    this._fill(message.node, message);
  }

  _fill(node, message) {
    if (message.role === 'error') {
      node.append(
        el('div', { class: 'msg-icon' }, icon('alert', 16)),
        el(
          'div',
          { class: 'msg-body' },
          el('p', { class: 'msg-title' }, message.text),
          message.hint ? el('p', { class: 'msg-hint' }, message.hint) : null,
          message.action === 'engines'
            ? el(
                'button',
                {
                  class: 'link-btn',
                  type: 'button',
                  onClick: () => this.app.showTab('engines', { section: SOURCE_TAB[message.source] ?? 'llm' }),
                },
                'Apri Motori',
                icon('chevronRight', 14),
              )
            : null,
        ),
      );
      return;
    }
    if (message.role === 'notice') {
      node.append(icon('info', 14), el('span', {}, message.text));
      return;
    }
    const bubble = el('div', { class: 'bubble' });
    // Quanto ha fatto aspettare: al passaggio del mouse, per chi vuole saperlo.
    if (message.timings) bubble.title = describeTimings(message.timings);
    if (message.role === 'assistant') bubble.append(renderMarkdown(message.text));
    else bubble.textContent = message.text;
    node.append(bubble);
    if (message.steps?.length) {
      // I passi dell'agente, chiusi: chi vuole sapere come ci e' arrivato li apre.
      const count = message.steps.length;
      node.append(
        el(
          'details',
          { class: 'steps' },
          el('summary', {}, count === 1 ? '1 passo' : `${count} passi`),
          el('ol', {}, ...message.steps.map((step) => el('li', {}, step))),
        ),
      );
    }
    if (message.note) node.append(el('span', { class: 'note' }, message.note));
  }

  _setTypingLabel(text) {
    const label = this.typing.querySelector('span');
    if (label) label.textContent = text;
  }

  _renderEmpty() {
    this.messagesEl.querySelector('.empty-state')?.remove();
    if (this.history.length) return;
    const suggestions = SUGGESTIONS.map((text) =>
      el('button', { class: 'suggestion', type: 'button', onClick: () => this.submit(text) }, text),
    );
    this.messagesEl.append(
      el(
        'div',
        { class: 'empty-state' },
        el('div', { class: 'empty-art' }, icon('chat', 26)),
        el('h2', {}, 'Parlale come a una persona'),
        el('p', {}, 'Ti risponde a voce e qui per iscritto. Con un agente collegato può anche cercare, ricordare e fare cose per te.'),
        el('div', { class: 'suggestions' }, suggestions),
      ),
    );
  }

  _scrollToEnd(onlyIfNear = false) {
    const box = this.messagesEl;
    if (onlyIfNear && box.scrollHeight - box.scrollTop - box.clientHeight > 120) return;
    box.scrollTop = box.scrollHeight;
  }

  _save() {
    this.history = this.history.slice(-HISTORY_LIMIT);
    writeSetting(
      HISTORY_KEY,
      this.history
        .filter((message) => message.role !== 'assistant' || message.text)
        .map(({ role, text, note, hint, source, action, steps }) => ({ role, text, note, hint, source, action, steps })),
    );
  }
}

