/**
 * Il pannello di Tsukumo: chat, personaggio, agenda, lavoro (i consumi degli
 * agenti) e motori, staccato dal personaggio.
 *
 * E' una finestra a parte con una sua connessione WebSocket al backend: il
 * backend manda tutto a tutti, quindi qui arrivano gli stessi messaggi del
 * personaggio. Il pannello li usa per la chat e per lo stato dei motori e
 * ignora l'audio, che suona solo nella finestra del personaggio.
 *
 * Le impostazioni vanno in tre posti diversi:
 *  - voce, lingua delle risposte, muto -> al backend (messaggio `settings`);
 *  - dimensione, primo piano, fantasma, finestre -> al processo Electron;
 *  - bocca, gesti spontanei, balli, debug -> al personaggio, tramite Electron.
 * Le preferenze si salvano in localStorage, che il personaggio condivide
 * (stessa origine) e rilegge all'avvio.
 */

import { wsUrl } from './config.js';
import { el, iconButton, readSetting, writeSetting } from './dom.js';
import { EnginesView } from './engines.js';
import { icon } from './icons.js';
import { AgendaView } from './panel/agenda.js';
import { CharacterView } from './panel/character.js';
import { ChatView } from './panel/chat.js';
import { Welcome } from './panel/welcome.js';
import { WorkView } from './panel/work.js';
import { CompanionSocket } from './ws.js';

const companion = window.companion ?? null;
const $ = (id) => document.getElementById(id);

const TABS = [
  { id: 'chat', label: 'Chat', icon: 'chat' },
  { id: 'character', label: 'Personaggio', icon: 'character' },
  { id: 'agenda', label: 'Agenda', icon: 'clock' },
  { id: 'work', label: 'Lavoro', icon: 'briefcase' },
  { id: 'engines', label: 'Motori', icon: 'engines' },
];

const STATE_TEXT = {
  online: 'pronta',
  degraded: 'con qualche problema',
  offline: 'non raggiungibile',
  unknown: 'in verifica…',
  thinking: 'sta pensando…',
  speaking: 'sta parlando',
};

/** Stato condiviso fra le schede, piu' un piccolo bus di eventi. */
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

// ------------------------------------------------------------------ schede
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

// ---------------------------------------------------------------- testata
function renderHeader() {
  const llm = app.engines?.llm;
  const connected = app.socket.connected;
  const busy = app.busy !== 'idle' ? app.busy : null;
  const state = !connected ? 'offline' : busy ?? llm?.state ?? 'unknown';
  $('badge').dataset.state = state;
  const line = $('agent-line');
  if (!connected) {
    line.textContent = 'Backend non raggiungibile, riprovo…';
  } else if (llm) {
    const detail = !busy && llm.state !== 'online' && llm.detail ? ` — ${llm.detail}` : '';
    line.textContent = `${llm.label} · ${STATE_TEXT[state] ?? state}${detail}`;
  } else {
    line.textContent = 'Connessa';
  }
  line.title = line.textContent;
}

app.on('engines', renderHeader);
app.on('busy', renderHeader);

// --------------------------------------------------------------- finestra
if (companion) {
  const actions = $('window-actions');
  const dock = iconButton('dock', { title: 'Aggancia al personaggio', className: 'icon-btn' });
  const pin = iconButton('pin', { title: 'Tieni il pannello in primo piano', className: 'icon-btn' });
  const close = iconButton('close', { title: 'Chiudi il pannello (Esc)', className: 'icon-btn' });
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
    dock.title = docked ? 'Agganciato al personaggio: trascina il pannello per staccarlo' : 'Aggancia al personaggio';
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
  // Il personaggio chiede di mostrare una scheda (doppio click o iniziare a
  // scrivere = chat, col primo tasto gia' dentro; i dock = le altre).
  companion.onFocus((focus = {}) => {
    showTab(focus.tab ?? 'chat', focus);
    // Electron sa se e' il primo avvio (nessuna impostazione salvata): allora la presentazione.
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

// ----------------------------------------------------------------- avvisi
let toastTimer = null;
const toast = el('div', { class: 'panel-toast hidden', role: 'status' });
document.body.append(toast);

function showToast(text, kind = 'info') {
  toast.textContent = text;
  toast.className = `panel-toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3200);
}

// ---------------------------------------------------------------- backend
const { socket } = app;

socket.on('open', renderHeader);
socket.on('close', () => {
  app.busy = 'idle';
  app.emit('busy', app.busy);
  renderHeader();
});

socket.on('hello', (message) => {
  showIdentity(message.memory?.persona);
  // Nel browser (senza Electron) il primo avvio si riconosce da localStorage.
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

// Il nome scelto per lei (Personaggio -> Chi e' e cosa sa di te) anche nella barra del titolo.
socket.on('memory', (message) => showIdentity(message.persona));

function showIdentity(persona) {
  const name = persona?.name?.trim();
  if (!name) return;
  document.querySelector('.titles strong').textContent = name;
  document.querySelector('.badge-letter').textContent = name.charAt(0).toUpperCase();
  document.title = `${name} - pannello`;
}

function pickSettings(message) {
  const keys = ['voice', 'ttsEngine', 'replyLanguage', 'replyLanguageResolved', 'voiceLanguage', 'canClone', 'muted'];
  return Object.fromEntries(keys.filter((key) => key in message).map((key) => [key, message[key]]));
}

// ---------------------------------------------------------------- avvio
const welcome = new Welcome(app, document.querySelector('.app'));
app.welcome = welcome;
const initialTab = (location.hash || '').replace('#', '') || readSetting('dc:panel-tab', 'chat');
showTab(initialTab);
renderHeader();
socket.connect();

window.tsukumoPanel = app;
