/**
 * The panel's chat.
 *
 * Text arrives in pieces (`token`) while the brain writes: the bubble
 * updates on the fly and the markdown is rendered when needed. Errors are no
 * longer grey lines to decipher: they're cards with the reason, a tip and a
 * button that takes you straight to where it's fixed.
 */

import { LOCALE, t, tx } from '../i18n.js';

import { apiUrl } from '../config.js';
import { el, iconButton, readSetting, writeSetting } from '../dom.js';
import { icon, iconSvg } from '../icons.js';
import { renderMarkdown } from '../markdown.js';

const HISTORY_KEY = 'dc:chat';
const HISTORY_LIMIT = 200;

const SUGGESTIONS = [
  t('Hi! What can you do?'),
  t("What's the weather tomorrow?"),
  t('Tell me something curious'),
  t('Remind me to take a break in 30 minutes'),
];

const SOURCE_TAB = { llm: 'llm', tts: 'tts', stt: 'stt' };

/** "first voice after 1.4 s · complete in 5.2 s" */
function describeTimings({ firstText, firstVoice, total }) {
  const seconds = (ms) => `${(ms / 1000).toLocaleString(LOCALE, { maximumFractionDigits: 1 })} s`;
  const parts = [];
  if (firstText != null) parts.push(t('first text after {time}', { time: seconds(firstText) }));
  if (firstVoice != null) parts.push(t('first voice after {time}', { time: seconds(firstVoice) }));
  if (total != null) parts.push(t('complete in {time}', { time: seconds(total) }));
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
    /** Files ready to go with the next message: `{name, path, screen}`. */
    this.attachments = [];

    this.mic.innerHTML = iconSvg('mic', 18);
    this.read.innerHTML = iconSvg('volume', 18);
    this.newChat.append(icon('newChat', 16), el('span', {}, t('New')));
    this.attach.innerHTML = iconSvg('clip', 18);
    this.screenButton.append(icon('screen', 16), el('span', {}, t('Screen')));
    this.screenButton.classList.toggle('hidden', !app.companion?.captureScreen);

    /** @type {{role: string, text: string, note?: string, hint?: string, source?: string, node?: HTMLElement}[]} */
    this.history = readSetting(HISTORY_KEY, []);
    /** The reply in progress, per backend turn. */
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
    this.input.addEventListener('input', () => {
      this._autoGrow();
      // She watches you type (a nod at every key, like Blobby).
      this.app.companion?.sendToPet?.({ type: 'typing' });
    });
    this.input.addEventListener('keydown', (event) => {
      // Enter sends, Shift+Enter starts a new line.
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
      this.input.placeholder = this.readMode ? t('Text for her to read…') : t('Write her something…');
      this.input.focus();
    });

    this.mic.addEventListener('click', () => {
      if (!this.app.companion) {
        this.app.toast(t('The microphone is used from the desktop window.'), 'warn');
        return;
      }
      if ((this.app.engines?.stt?.state ?? 'off') === 'off') {
        this.app.showTab('engines', { section: 'stt' });
        this.app.toast(t('First choose how she should listen to you.'), 'warn');
        return;
      }
      this.app.companion.sendToPet({ type: 'mic' });
    });

    this.newChat.addEventListener('click', () => {
      this.socket.reset();
      this.clear();
    });

    this.chip.addEventListener('click', () => this.app.showTab('engines', { section: 'llm' }));

    // Files: paper clip, dragging onto the chat, screenshot.
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
   * In Electron the file has a real path: the agent opens it where it is. In
   * the browser it doesn't, so it's uploaded to the backend (`/api/attachments`).
   */
  async addFiles(files) {
    for (const file of files) {
      let path = this.app.companion?.pathForFile?.(file) ?? null;
      if (!path) {
        try {
          const response = await fetch(apiUrl(`/api/attachments?name=${encodeURIComponent(file.name)}`), { method: 'POST', body: file });
          const data = await response.json();
          if (!response.ok) throw new Error(tx(data.detail) ?? `HTTP ${response.status}`);
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
      this.attachments.push({ name: t('Screen'), path, screen: true });
      this._renderAttachments();
      this.input.focus();
    } catch (error) {
      this.app.toast(t("Can't capture the screen: {error}", { error: error.message }), 'error');
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
            title: t('Remove'),
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
      // "say" doesn't go through the brain and the backend doesn't echo it as a user message.
      this.add({ role: 'say', text, note: t('read aloud') });
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
    this.send.title = stop ? t('Stop') : t('Send (Enter)');
  }

  // ------------------------------------------------------------- backend
  _listen() {
    const { socket, app } = this;

    app.on('busy', (busy) => {
      if (busy === 'thinking' && this.busy !== 'thinking') this._setTypingLabel(t('thinking'));
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
      const files = (message.files ?? []).map((file) => (message.screen ? t('screen') : file.name));
      this.add({ role: 'user', text: message.text, note: files.length ? `📎 ${files.join(', ')}` : undefined });
    });

    // The agent uses a tool: the "thinking" line says what it's doing.
    socket.on('working', (message) => {
      if (message.label) this._setTypingLabel(tx(message.label));
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
        // The text that arrived in pieces stays the one shown (with its markdown);
        // the backend's "clean" version is only for the voice.
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

    socket.on('notice', (message) => this.add({ role: 'notice', text: tx(message.message) }));
    socket.on('error', (message) =>
      this.add({
        role: 'error',
        text: tx(message.message) ?? t('Error'),
        hint: tx(message.hint),
        source: message.source,
        action: message.action,
      }),
    );
    socket.on('transcript', (message) => {
      if (!message.text?.trim()) this.app.toast(t("I didn't catch that, can you repeat?"), 'warn');
    });
    socket.on('reset', () => this.clear());
  }

  _renderChip(engines) {
    const llm = engines?.llm;
    this.chip.querySelector('.dot').dataset.state = llm?.state ?? 'unknown';
    this.root.querySelector('#engine-chip-text').textContent = llm ? llm.label : '…';
    this.chip.title = llm?.detail ? `${tx(llm.label)}: ${tx(llm.detail)}` : t('Change brain');
  }

  // ------------------------------------------------------------ messages
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
                t('Open Engines'),
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
    // How long it made you wait: on mouse hover, for whoever wants to know.
    if (message.timings) bubble.title = describeTimings(message.timings);
    if (message.role === 'assistant') bubble.append(renderMarkdown(message.text));
    else bubble.textContent = message.text;
    node.append(bubble);
    if (message.steps?.length) {
      // The agent's steps, collapsed: whoever wants to know how it got there opens them.
      const count = message.steps.length;
      node.append(
        el(
          'details',
          { class: 'steps' },
          el('summary', {}, count === 1 ? t('1 step') : t('{n} steps', { n: count })),
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
        el('h2', {}, t('Talk to her like a person')),
        el('p', {}, t('She answers by voice and here in writing. With an agent connected she can also search, remember and do things for you.')),
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

