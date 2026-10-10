/**
 * The dashboard: the week (reminders and timers), today, the weather, the
 * agents at work and the chat. She sits in the
 * corner above the text field: it's the real companion, docked by Electron
 * onto the window (see `setPetStage` in electron/main.js). "−" closes the
 * dashboard and sends her back to the desktop.
 *
 * Like the panel, it has its own connection to the backend and receives
 * every message; the chat is the same (panel/chat.js). Settings stay in the
 * panel: "Settings" opens it over the dashboard.
 */

import { apiUrl, wsUrl } from './config.js';
import { el, iconButton, readSetting } from './dom.js';
import { resolveOutfit } from './flame/wardrobe.js';
import { AgentsWidget, TodayWidget, WeatherWidget, WeekWidget } from './dashboard/widgets.js';
import { clock } from './dashboard/time.js';
import { LOCALE, t, translateDom, tx, watchLanguage } from './i18n.js';
import { icon } from './icons.js';
import { ChatView } from './panel/chat.js';
import { outfitPreview } from './panel/wardrobe-art.js';
import { CompanionSocket } from './ws.js';

const companion = window.companion ?? null;
translateDom();
watchLanguage();
const $ = (id) => document.getElementById(id);

/** Everything the tiles show, updated by the backend's messages. */
const store = {
  reminders: [],
  agents: [],
  usage: null,
  weather: null,
  weatherError: false,
  busy: 'idle',
  persona: '',
};

const app = {
  socket: new CompanionSocket(wsUrl),
  companion,
  engines: null,
  settings: {},
  _listeners: new Map(),
  on(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(handler);
  },
  emit(type, payload) {
    this._listeners.get(type)?.forEach((handler) => handler(payload));
  },
  /** The chat is here; the other tabs are in the panel, which opens on top. */
  showTab(name, options = {}) {
    if (name === 'chat') {
      chat.shown(options);
      return;
    }
    if (companion) companion.openPanel({ tab: name, ...options });
    else window.open(`./panel.html#${name}`, '_blank');
  },
  toast(text, kind = 'info') {
    showToast(text, kind);
  },
};

// ------------------------------------------------------------------- tiles
const widgets = {
  week: new WeekWidget(),
  today: new TodayWidget(),
  weather: new WeatherWidget(),
  agents: new AgentsWidget(),
};
$('dash-grid').append(widgets.week.node, widgets.today.node, widgets.weather.node, widgets.agents.node);

const DEPENDS = {
  reminders: ['week', 'today'],
  agents: ['agents'],
  usage: ['agents'],
  weather: ['weather'],
};

let queued = new Set();
/** Redraws the tiles that depend on `part` (at the next frame, once). */
function changed(...parts) {
  const first = queued.size === 0;
  for (const part of parts) for (const name of DEPENDS[part] ?? Object.keys(widgets)) queued.add(name);
  if (first) {
    requestAnimationFrame(() => {
      const names = queued;
      queued = new Set();
      for (const name of names) {
        try {
          widgets[name].render(store);
        } catch (error) {
          console.error(`[dashboard] ${name}:`, error);
        }
      }
    });
  }
}

// -------------------------------------------------------------------- chat
const chat = new ChatView(app, $('view-chat'));

// ------------------------------------------------------------------ header
function renderHeader() {
  const now = new Date();
  const hour = now.getHours();
  const hello = hour < 5 ? t('Good night') : hour < 13 ? t('Good morning') : hour < 18 ? t('Good afternoon') : t('Good evening');
  $('greeting').textContent = hello;
  const day = now.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });
  $('today-line').textContent = `${day[0].toUpperCase()}${day.slice(1)} · ${clock(now.getTime() / 1000)}`;
}

/** Top left there's her: the flame in her colour, with what she's wearing. */
function renderLogo() {
  // SVG made in wardrobe-art.js with already validated colours: no text from outside.
  document.querySelector('.dash-logo').innerHTML = outfitPreview(resolveOutfit(readSetting('dc:flame-outfit', 'auto')), readSetting('dc:flame-color', 'lilac'));
}
renderLogo();
window.addEventListener('storage', (event) => {
  if (event.key === 'dc:flame-outfit' || event.key === 'dc:flame-color') renderLogo();
});

const actions = $('dash-actions');
const startChip = el('button', { class: 'ghost-btn start-chip', type: 'button', role: 'switch', title: t('When you turn on the PC: the dashboard, or just her on the desktop') });
const settingsButton = el('button', { class: 'ghost-btn', type: 'button', onClick: () => app.showTab('engines') }, icon('engines', 15), el('span', {}, t('Settings')));
actions.append(startChip, settingsButton);
if (companion?.minimizeDashboard) {
  actions.append(
    iconButton('maximize', { title: t('Maximize'), className: 'icon-btn', onClick: () => companion.toggleMaximizeDashboard() }),
    iconButton('minimize', { title: t('Minimize: she goes back to the desktop'), className: 'icon-btn dash-min', onClick: () => companion.minimizeDashboard() }),
  );
}

let startWith = 'dashboard';
function renderStartChip() {
  const on = startWith === 'dashboard';
  startChip.setAttribute('aria-checked', String(on));
  startChip.replaceChildren(el('span', {}, t('Open at startup')), el('span', { class: `mini-switch${on ? ' on' : ''}`, 'aria-hidden': 'true' }));
  startChip.classList.toggle('hidden', !companion?.setStartWith);
}
startChip.addEventListener('click', async () => {
  startWith = await companion.setStartWith(startWith === 'dashboard' ? 'companion' : 'dashboard');
  renderStartChip();
  app.toast(startWith === 'dashboard' ? t("Next time the PC starts I'll open the dashboard.") : t('Next time the PC starts it will be just her on the desktop.'));
});

function setMusic(music) {
  const playing = Boolean(music?.playing);
  $('now-playing').classList.toggle('hidden', !playing);
  if (playing) $('now-playing-text').textContent = `${music.title} — ${music.artist}`;
}

if (companion) {
  const applyState = (state) => {
    if (!state) return;
    startWith = state.startWith ?? startWith;
    renderStartChip();
    setMusic(state.music);
    if (state.voice) app.emit('mic', state.voice);
  };
  companion.getState().then(applyState);
  companion.onState(applyState);
  companion.onMusic(setMusic);
  companion.onVoiceCommand?.((command) => {
    if (command?.type === 'state') app.emit('mic', command);
  });
}
renderStartChip();

// -------------------------------------------------------------- her corner
const stage = $('stage');
const bubble = $('stage-bubble');

/** Electron puts her window over this tile: we tell it where it is. */
function reportStage() {
  if (!companion?.setDashboardStage) return;
  const rect = stage.getBoundingClientRect();
  companion.setDashboardStage({ x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) });
}
new ResizeObserver(reportStage).observe(stage);
window.addEventListener('resize', reportStage);
if (!companion) stage.classList.add('browser');

function renderBubble() {
  const own = store.agents.find((agent) => agent.internal);
  let text = '';
  if (store.busy === 'thinking') text = own?.step ? `${own.name} ${tx(own.step)}…` : t('Thinking…');
  else if (store.busy === 'speaking') text = '';
  else if (own?.state === 'working' && own.step) text = `${own.name} ${tx(own.step)}…`;
  bubble.textContent = text;
  bubble.classList.toggle('hidden', !text);
}

// ------------------------------------------------------------------ notices
let toastTimer = null;
const toast = el('div', { class: 'panel-toast hidden', role: 'status' });
document.body.append(toast);

function showToast(text, kind = 'info') {
  toast.textContent = text;
  toast.className = `panel-toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3200);
}

// ------------------------------------------------------------------ backend
const { socket } = app;

socket.on('hello', (message) => {
  app.settings = { ...(message.config ?? {}) };
  app.engines = message.engines ?? null;
  store.reminders = message.reminders ?? [];
  store.agents = message.agents ?? [];
  store.usage = message.usage ?? null;
  store.persona = message.memory?.persona?.name ?? '';
  app.emit('hello', message);
  app.emit('settings', app.settings);
  app.emit('engines', app.engines);
  changed('reminders', 'agents', 'usage');
  renderBubble();
});
socket.on('engines', (message) => {
  app.engines = message;
  app.emit('engines', message);
});
socket.on('settings', (message) => {
  Object.assign(app.settings, message);
  app.emit('settings', app.settings);
});
socket.on('state', (message) => {
  store.busy = message.value === 'idle' ? 'idle' : message.value;
  app.emit('busy', store.busy);
  renderBubble();
});
socket.on('reminders', (message) => {
  store.reminders = message.reminders ?? [];
  changed('reminders');
});
socket.on('agents', (message) => {
  store.agents = message.agents ?? [];
  changed('agents');
  renderBubble();
});
socket.on('usage', (message) => {
  store.usage = message;
  changed('usage');
});

async function loadWeather() {
  try {
    const response = await fetch(apiUrl('/api/weather'));
    const data = await response.json();
    store.weather = data.weather ?? store.weather;
    store.weatherError = !data.weather;
  } catch {
    store.weatherError = true;
  }
  changed('weather');
}

// ------------------------------------------------------------------ startup
renderHeader();
setInterval(() => {
  renderHeader();
  // Hours go by: "in 20 min", today's date.
  changed('reminders', 'agents');
}, 30_000);
loadWeather();
setInterval(loadWeather, 30 * 60_000);
changed('reminders', 'agents', 'weather');
socket.connect();
reportStage();

window.tsukumoDashboard = { app, store };
