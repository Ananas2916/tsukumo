/**
 * The dashboard: the centre of the app. On the left her name and every
 * section (Home, Agenda, Work, Character, Engines); in the
 * middle the section; on the right the chat, with her in the corner above
 * the text field.
 *
 * Home is the grid of tiles: the week (reminders and timers), today, the
 * to-do list, the weather, the agents at work and the park (every agent on
 * this PC). The other sections are
 * the views that used to sit in the panel (panel/*.js, engines.js): the
 * panel is now only the chat, and asking it for a section opens this window
 * on it (Electron sends `panel:focus` here).
 *
 * She is the real companion, docked by Electron onto the window (see
 * `setPetStage` in electron/main.js). "−" closes the dashboard and sends her
 * back to the desktop.
 *
 * Like the panel, it has its own connection to the backend (hub.js) and
 * receives every message; the chat is the same (panel/chat.js).
 */

import { apiUrl } from './config.js';
import { el, iconButton, readSetting } from './dom.js';
import { EnginesView } from './engines.js';
import { parseExtras, resolveOutfit } from './flame/wardrobe.js';
import { AgentsWidget, TodayWidget, TodoWidget, WeatherWidget, WeekWidget } from './dashboard/widgets.js';
import { TileLayout } from './dashboard/layout.js';
import { ParkWidget } from './dashboard/park.js';
import { clock } from './dashboard/time.js';
import { createHub } from './hub.js';
import { LOCALE, t, translateDom, tx, watchLanguage } from './i18n.js';
import { icon } from './icons.js';
import { AgendaView } from './panel/agenda.js';
import { CharacterView } from './panel/character.js';
import { ChatView } from './panel/chat.js';
import { outfitPreview } from './panel/wardrobe-art.js';
import { Welcome } from './panel/welcome.js';
import { WorkView } from './panel/work.js';

const companion = window.companion ?? null;
translateDom();
watchLanguage();
const $ = (id) => document.getElementById(id);

/** Everything the tiles show, updated by the backend's messages. */
const store = {
  reminders: [],
  agents: [],
  park: null,
  usage: null,
  weather: null,
  weatherError: false,
  busy: 'idle',
  persona: '',
};

/**
 * The sections, in the rail's order. The second group is about her (how she
 * looks and sounds, which engines she runs on), the first about your day.
 */
const SECTIONS = [
  { id: 'home', label: t('Home'), icon: 'dashboard' },
  { id: 'agenda', label: t('Agenda'), icon: 'clock', sub: t('Timers, reminders, to-dos and her secretary') },
  { id: 'work', label: t('Work'), icon: 'briefcase', sub: t("Your agents' limits, hooks and notifications") },
  { id: 'character', label: t('Character'), icon: 'character', sub: t('Her look, her voice and what she knows about you'), group: 'her' },
  { id: 'engines', label: t('Engines'), icon: 'engines', sub: t('The brain, the voice and the hearing she runs on'), group: 'her' },
];

const STATE_TEXT = {
  online: t('ready'),
  degraded: t('having some trouble'),
  offline: t('unreachable'),
  unknown: t('checking…'),
  thinking: t('thinking…'),
  speaking: t('speaking'),
};

const app = createHub({ companion, showTab, toast: showToast });
app.tab = 'home';

// ------------------------------------------------------------------- tiles
const widgets = {
  week: new WeekWidget(),
  today: new TodayWidget(),
  weather: new WeatherWidget(),
  agents: new AgentsWidget(),
  todo: new TodoWidget(app),
  park: new ParkWidget(),
};

// The tiles can be dragged around and widened (dashboard/layout.js); this is the default.
let customLayout = false;
const resetLayout = el('button', { class: 'ghost-btn hidden', type: 'button', title: t('Put the tiles back where they were') }, t('Reset layout'));
const layout = new TileLayout(
  $('dash-grid'),
  { week: widgets.week.node, today: widgets.today.node, todo: widgets.todo.node, weather: widgets.weather.node, agents: widgets.agents.node, park: widgets.park.node },
  {
    wide: ['week', 'park'],
    onChange: (custom) => {
      customLayout = custom;
      renderResetLayout();
    },
  },
);
resetLayout.addEventListener('click', () => layout.reset());

function renderResetLayout() {
  resetLayout.classList.toggle('hidden', !customLayout || app.tab !== 'home');
}

const DEPENDS = {
  reminders: ['week', 'today'],
  secretary: ['week', 'today', 'todo'],
  agents: ['agents'],
  park: ['park'],
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

// -------------------------------------------------------- chat and sections
const chat = new ChatView(app, $('view-chat'));
const views = {
  agenda: new AgendaView(app, $('view-agenda')),
  work: new WorkView(app, $('view-work')),
  character: new CharacterView(app, $('view-character')),
  engines: new EnginesView(app, $('view-engines')),
};

const navButtons = new Map();
for (const [index, section] of SECTIONS.entries()) {
  if (section.group && section.group !== SECTIONS[index - 1]?.group) $('rail-nav').append(el('span', { class: 'rail-divider', 'aria-hidden': 'true' }));
  const button = el(
    'button',
    { class: 'rail-item', type: 'button', role: 'tab', title: section.label, dataset: { section: section.id }, onClick: () => showTab(section.id) },
    icon(section.icon, 18),
    el('span', {}, section.label),
  );
  navButtons.set(section.id, button);
  $('rail-nav').append(button);
}

/** Home, a section, or the chat (which is always on the right: it gets the focus). */
function showTab(name, options = {}) {
  if (name === 'chat') {
    chat.shown(options);
    return;
  }
  if (name !== 'home' && !views[name]) name = 'home';
  app.tab = name;
  for (const [id, button] of navButtons) {
    button.classList.toggle('active', id === name);
    button.setAttribute('aria-selected', String(id === name));
  }
  $('dash-grid').classList.toggle('hidden', name !== 'home');
  for (const id of Object.keys(views)) $(`view-${id}`).classList.toggle('hidden', id !== name);
  renderResetLayout();
  renderHeader();
  history.replaceState(null, '', name === 'home' ? location.pathname : `#${name}`);
  views[name]?.shown?.(options);
}

// ------------------------------------------------------------------ header
function renderHeader() {
  const section = SECTIONS.find((item) => item.id === app.tab) ?? SECTIONS[0];
  if (section.id !== 'home') {
    $('page-title').textContent = section.label;
    $('page-sub').textContent = section.sub;
    return;
  }
  const now = new Date();
  const hour = now.getHours();
  $('page-title').textContent = hour < 5 ? t('Good night') : hour < 13 ? t('Good morning') : hour < 18 ? t('Good afternoon') : t('Good evening');
  const day = now.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });
  $('page-sub').textContent = `${day[0].toUpperCase()}${day.slice(1)} · ${clock(now.getTime() / 1000)}`;
}

/** Top of the rail there's her: the flame in her colour, with what she's wearing. */
function renderLogo() {
  // SVG made in wardrobe-art.js with already validated colours: no text from outside.
  document.querySelector('.dash-logo').innerHTML = outfitPreview(resolveOutfit(readSetting('dc:flame-outfit', 'auto')), readSetting('dc:flame-color', 'lilac'), {
    extras: parseExtras(readSetting('dc:flame-extras', [])),
  });
}
renderLogo();
window.addEventListener('storage', (event) => {
  if (event.key === 'dc:flame-outfit' || event.key === 'dc:flame-color' || event.key === 'dc:flame-extras') renderLogo();
});

/** Under her name, what she's doing: ready, thinking, speaking. */
function renderState() {
  const llm = app.engines?.llm;
  const connected = app.socket.connected;
  const busy = store.busy !== 'idle' ? store.busy : null;
  const state = !connected ? 'offline' : busy ?? llm?.state ?? 'unknown';
  const line = $('her-state');
  line.dataset.state = state;
  line.textContent = STATE_TEXT[state] ?? state;
  line.title = llm ? `${llm.label} · ${line.textContent}${llm.detail && llm.state !== 'online' ? ` — ${tx(llm.detail)}` : ''}` : line.textContent;
}
app.on('engines', renderState);

function showIdentity(persona) {
  const name = persona?.name?.trim();
  if (!name) return;
  store.persona = name;
  $('her-name').textContent = name;
}

const actions = $('dash-actions');
actions.append(resetLayout);
if (companion?.minimizeDashboard) {
  actions.append(
    iconButton('maximize', { title: t('Maximize'), className: 'icon-btn', onClick: () => companion.toggleMaximizeDashboard() }),
    iconButton('minimize', { title: t('Minimize: she goes back to the desktop'), className: 'icon-btn dash-min', onClick: () => companion.minimizeDashboard() }),
  );
}

const startChip = el('button', { class: 'start-chip', type: 'button', role: 'switch', title: t('When you turn on the PC: the dashboard, or just her on the desktop') });
$('rail-foot').append(startChip);

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
  if (playing) {
    $('now-playing-text').textContent = `${music.title} — ${music.artist}`;
    $('now-playing').title = $('now-playing-text').textContent;
  }
}

if (companion) {
  const applyState = (state) => {
    if (!state) return;
    startWith = state.startWith ?? startWith;
    renderStartChip();
    setMusic(state.music);
    app.emit('window-state', state);
    if (state.voice) app.emit('mic', state.voice);
  };
  companion.getState().then(applyState);
  companion.onState(applyState);
  companion.onMusic(setMusic);
  companion.onVoiceCommand?.((command) => {
    if (command?.type === 'state') app.emit('mic', command);
  });
  // Her menu, the tray or the chat window ask for a section (or the chat,
  // with some text). Without one, the dashboard stays where you left it.
  companion.onFocus((focus = {}) => {
    if (focus.tab) showTab(focus.tab, focus);
    if (focus.welcome) app.welcome.maybeStart();
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

socket.on('open', renderState);
socket.on('close', () => {
  store.busy = 'idle';
  renderState();
});
socket.on('hello', (message) => {
  store.reminders = message.reminders ?? [];
  store.agents = message.agents ?? [];
  store.usage = message.usage ?? null;
  store.secretary = message.secretary ?? null;
  store.park = message.park ?? null;
  showIdentity(message.memory?.persona);
  changed('reminders', 'agents', 'usage', 'secretary', 'park');
  renderBubble();
  renderState();
});
socket.on('memory', (message) => showIdentity(message.persona));
socket.on('state', (message) => {
  store.busy = message.value === 'idle' ? 'idle' : message.value;
  renderBubble();
  renderState();
});
socket.on('reminders', (message) => {
  store.reminders = message.reminders ?? [];
  changed('reminders');
});
socket.on('secretary', (message) => {
  store.secretary = message;
  changed('secretary');
});
socket.on('agents', (message) => {
  store.agents = message.agents ?? [];
  changed('agents');
  renderBubble();
});
socket.on('park', (message) => {
  store.park = { agents: message.agents ?? [], links: message.links ?? [], lmstudio: message.lmstudio ?? null };
  changed('park');
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
// "Redo the introduction" (Character) runs here, over the whole dashboard.
app.welcome = new Welcome(app, document.querySelector('.dash'));
showTab((location.hash || '').replace('#', '') || 'home');
renderState();
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

window.tsukumoDashboard = { app, store, widgets, views, showTab };
