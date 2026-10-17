/**
 * Tsukumo's panel: the chat, beside her on the desktop.
 *
 * It holds only the chat, so it stays light. Character, agenda, work and
 * engines live in the dashboard: asking the panel for one of them
 * (a link in the chat, the brain chip) opens the dashboard on that section.
 *
 * It's a separate window with its own WebSocket connection to the backend
 * (hub.js): the backend sends everything to everyone, so the same messages
 * as the character's arrive here. The audio plays only in her window.
 *
 * It's also the window that is always loaded: the first-run introduction
 * starts here, and so does putting back the voice chosen in Character after
 * a backend restart (`restorePreferences`).
 */

import { el, iconButton } from './dom.js';
import { createHub, restorePreferences } from './hub.js';
import { t, translateDom, tx, watchLanguage } from './i18n.js';
import { ChatView } from './panel/chat.js';
import { Welcome } from './panel/welcome.js';

const companion = window.companion ?? null;
translateDom();
watchLanguage();
const $ = (id) => document.getElementById(id);

const STATE_TEXT = {
  online: t('ready'),
  degraded: t('having some trouble'),
  offline: t('unreachable'),
  unknown: t('checking…'),
  thinking: t('thinking…'),
  speaking: t('speaking'),
};

const app = createHub({ companion, showTab, toast: showToast });
const chat = new ChatView(app, $('view-chat'));

/** The chat is here; any other section opens the dashboard on it. */
function showTab(name, options = {}) {
  if (!name || name === 'chat') {
    chat.shown(options);
    return;
  }
  openDashboard({ ...options, tab: name });
}

function openDashboard(focus = {}) {
  if (companion?.openDashboard) companion.openDashboard(focus);
  else window.open(`./dashboard.html${focus.tab ? `#${focus.tab}` : ''}`, 'tsukumo-dashboard');
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
  const dashboard = iconButton('dashboard', { title: t('Open the dashboard: agenda, character, engines…'), className: 'icon-btn', onClick: () => openDashboard() });
  const dock = iconButton('dock', { title: t('Attach to the character'), className: 'icon-btn' });
  const pin = iconButton('pin', { title: t('Keep the panel on top'), className: 'icon-btn' });
  const close = iconButton('close', { title: t('Close the panel (Esc)'), className: 'icon-btn' });
  actions.append(dashboard, dock, pin, close);

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
  // The character asks for the chat (double click or starting to type, with
  // the first key already inside).
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
socket.on('close', renderHeader);

socket.on('hello', (message) => {
  showIdentity(message.memory?.persona);
  restorePreferences(socket, message.config ?? {});
  // In the browser (without Electron) the first start is detected from localStorage.
  if (!companion) welcome.maybeStart();
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

// ----------------------------------------------------------------- startup
const welcome = new Welcome(app, document.querySelector('.app'));
app.welcome = welcome;
companion?.setPanelTab?.('chat');
chat.shown();
renderHeader();
socket.connect();

window.tsukumoPanel = app;
