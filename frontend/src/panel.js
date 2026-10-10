/**
 * Tsukumo's panel: chat, character, agenda, work (the agents' usage) and
 * engines, detached from the character.
 *
 * It's a separate window with its own WebSocket connection to the backend:
 * the backend sends everything to everyone, so the same messages as the
 * character's arrive here. The panel uses them for the chat and the
 * engines' state and ignores the audio, which plays only in the character's
 * window.
 *
 * Settings go to three different places:
 *  - voice, reply language, mute -> to the backend (`settings` message);
 *  - size, always on top, ghost mode, windows -> to the Electron process;
 *  - mouth, spontaneous gestures, dances, debug -> to the character, via Electron.
 * Preferences are saved in localStorage, which the character shares (same
 * origin) and reads again at startup.
 */

import { wsUrl } from './config.js';
import { el, iconButton, readSetting, writeSetting } from './dom.js';
import { EnginesView } from './engines.js';
import { t, translateDom, tx, watchLanguage } from './i18n.js';
import { icon } from './icons.js';
import { AgendaView } from './panel/agenda.js';
import { CharacterView } from './panel/character.js';
import { ChatView } from './panel/chat.js';
import { Welcome } from './panel/welcome.js';
import { WorkView } from './panel/work.js';
import { CompanionSocket } from './ws.js';

const companion = window.companion ?? null;
translateDom();
watchLanguage();
const $ = (id) => document.getElementById(id);

const TABS = [
  { id: 'chat', label: t('Chat'), icon: 'chat' },
  { id: 'character', label: t('Character'), icon: 'character' },
  { id: 'agenda', label: t('Agenda'), icon: 'clock' },
  { id: 'work', label: t('Work'), icon: 'briefcase' },
  { id: 'engines', label: t('Engines'), icon: 'engines' },
];

const STATE_TEXT = {
  online: t('ready'),
  degraded: t('having some trouble'),
  offline: t('unreachable'),
  unknown: t('checking…'),
  thinking: t('thinking…'),
  speaking: t('speaking'),
};

/** State shared by the tabs, plus a small event bus. */
const app = {
  socket: new CompanionSocket(wsUrl),
  companion,
  engines: null,
  settings: {},
  voices: [],
  busy: 'idle',
  tab: 'chat',
  _listeners: new Map(),
  on(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(handler);
  },
  emit(type, payload) {
    this._listeners.get(type)?.forEach((handler) => handler(payload));
  },
  showTab(name, options = {}) {
    showTab(name, options);
  },
  toast(text, kind = 'info') {
    showToast(text, kind);
  },
};

// -------------------------------------------------------------------- tabs
const tabButtons = new Map();
for (const tab of TABS) {
  const button = el(
    'button',
    { class: 'tab', type: 'button', role: 'tab', dataset: { tab: tab.id }, onClick: () => showTab(tab.id) },
    icon(tab.icon, 16),
    el('span', {}, tab.label),
  );
  tabButtons.set(tab.id, button);
  $('tabs').append(button);
}

const views = {
  chat: new ChatView(app, $('view-chat')),
  character: new CharacterView(app, $('view-character')),
  agenda: new AgendaView(app, $('view-agenda')),
  work: new WorkView(app, $('view-work')),
  engines: new EnginesView(app, $('view-engines')),
};

function showTab(name, options = {}) {
  if (!views[name]) name = 'chat';
  app.tab = name;
  for (const [id, button] of tabButtons) {
    button.classList.toggle('active', id === name);
    button.setAttribute('aria-selected', String(id === name));
  }
  for (const id of Object.keys(views)) $(`view-${id}`).classList.toggle('hidden', id !== name);
  writeSetting('dc:panel-tab', name);
  companion?.setPanelTab?.(name);
  views[name].shown?.(options);
}

// ------------------------------------------------------------------ header
function renderHeader() {
  const llm = app.engines?.llm;
  const connected = app.socket.connected;
  const busy = app.busy !== 'idle' ? app.busy : null;
  const state = !connected ? 'offline' : busy ?? llm?.state ?? 'unknown';
  $('badge').dataset.state = state;
  const line = $('agent-line');
  if (!connected) {
    line.textContent = t('Backend unreachable, retrying…');
  } else if (llm) {
    const detail = !busy && llm.state !== 'online' && llm.detail ? ` — ${tx(llm.detail)}` : '';
    line.textContent = `${llm.label} · ${STATE_TEXT[state] ?? state}${detail}`;
  } else {
    line.textContent = t('Connected');
  }
  line.title = line.textContent;
}

app.on('engines', renderHeader);
app.on('busy', renderHeader);

// ------------------------------------------------------------------ window
if (companion) {
  const actions = $('window-actions');
  const dock = iconButton('dock', { title: t('Attach to the character'), className: 'icon-btn' });
  const pin = iconButton('pin', { title: t('Keep the panel on top'), className: 'icon-btn' });
  const close = iconButton('close', { title: t('Close the panel (Esc)'), className: 'icon-btn' });
  actions.append(dock, pin, close);

  let docked = true;
  let panelPinned = false;
  dock.addEventListener('click', () => companion.setDocked(!docked));
  pin.addEventListener('click', () => companion.setPanelPinned(!panelPinned));
  close.addEventListener('click', () => companion.hidePanel());

  const applyWindowState = (state) => {
    if (!state) return;
    docked = state.docked;
    panelPinned = state.panelPinned;
    dock.classList.toggle('active', docked);
    dock.title = docked ? t('Attached to the character: drag the panel to detach it') : t('Attach to the character');
    pin.classList.toggle('active', panelPinned);
    app.emit('window-state', state);
    if (state.voice) app.emit('mic', state.voice);
    setMusic(state.music);
  };
  companion.getState().then(applyWindowState);
  companion.onState(applyWindowState);
  companion.onMusic(setMusic);
  companion.onVoiceCommand?.((command) => {
    if (command?.type === 'state') app.emit('mic', command);
  });
  // The character asks to show a tab (double click or starting to type =
  // chat, with the first key already inside; the menu = the others).
  companion.onFocus((focus = {}) => {
    showTab(focus.tab ?? 'chat', focus);
    // Electron knows whether it's the first start (no saved settings): then the introduction.
    if (focus.welcome) welcome.maybeStart();
  });
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && companion && !event.defaultPrevented) companion.hidePanel();
});

function setMusic(music) {
  const playing = Boolean(music?.playing);
  $('now-playing').classList.toggle('hidden', !playing);
  if (playing) $('now-playing-text').textContent = `${music.title} — ${music.artist}`;
}

// ----------------------------------------------------------------- notices
let toastTimer = null;
const toast = el('div', { class: 'panel-toast hidden', role: 'status' });
document.body.append(toast);

function showToast(text, kind = 'info') {
  toast.textContent = text;
  toast.className = `panel-toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3200);
}

// ----------------------------------------------------------------- backend
const { socket } = app;

socket.on('open', renderHeader);
socket.on('close', () => {
  app.busy = 'idle';
  app.emit('busy', app.busy);
  renderHeader();
});

socket.on('hello', (message) => {
  showIdentity(message.memory?.persona);
  // In the browser (without Electron) the first start is detected from localStorage.
  if (!companion) welcome.maybeStart();
  app.settings = { ...(message.config ?? {}) };
  app.voices = message.voices ?? [];
  app.engines = message.engines ?? null;
  app.emit('hello', message);
  app.emit('voices', app.voices);
  app.emit('settings', app.settings);
  app.emit('engines', app.engines);
});

socket.on('engines', (message) => {
  app.engines = message;
  app.emit('engines', message);
});

socket.on('voices', (message) => {
  app.voices = message.voices ?? [];
  Object.assign(app.settings, pickSettings(message));
  app.emit('voices', app.voices);
  app.emit('settings', app.settings);
});

socket.on('settings', (message) => {
  Object.assign(app.settings, pickSettings(message));
  app.emit('settings', app.settings);
});

socket.on('providers', (message) => {
  Object.assign(app.settings, pickSettings(message.settings ?? {}));
  app.emit('providers', message);
  app.emit('settings', app.settings);
});

socket.on('state', (message) => {
  app.busy = message.value === 'idle' ? 'idle' : message.value;
  app.emit('busy', app.busy);
});

// The name chosen for her (Character -> Who she is and what she knows about you) in the title bar too.
socket.on('memory', (message) => showIdentity(message.persona));

function showIdentity(persona) {
  const name = persona?.name?.trim();
  if (!name) return;
  document.querySelector('.titles strong').textContent = name;
  document.querySelector('.badge-letter').textContent = name.charAt(0).toUpperCase();
  document.title = t('{name} - panel', { name });
}

function pickSettings(message) {
  const keys = ['voice', 'ttsEngine', 'replyLanguage', 'replyLanguageResolved', 'voiceLanguage', 'canClone', 'muted'];
  return Object.fromEntries(keys.filter((key) => key in message).map((key) => [key, message[key]]));
}

// ----------------------------------------------------------------- startup
const welcome = new Welcome(app, document.querySelector('.app'));
app.welcome = welcome;
const initialTab = (location.hash || '').replace('#', '') || readSetting('dc:panel-tab', 'chat');
showTab(initialTab);
renderHeader();
socket.connect();

window.tsukumoPanel = app;
