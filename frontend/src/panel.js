/**
 * Pannello di Desk Companion: chat e impostazioni, staccati dal personaggio.
 *
 * E' una finestra a parte con una sua connessione WebSocket al backend: il
 * backend manda tutto a tutti, quindi qui arrivano gli stessi messaggi del
 * personaggio. Il pannello li usa per la chat (`user`, `token`, `reply`...)
 * e ignora l'audio, che suona solo la finestra del personaggio.
 *
 * Le impostazioni vanno in tre posti diversi:
 *  - voce e lingua delle risposte -> al backend (messaggio `settings`);
 *  - dimensione, primo piano, fantasma, finestre -> al processo Electron;
 *  - bocca, gesti spontanei, debug -> al personaggio, tramite Electron.
 * Le preferenze si salvano in localStorage, che il personaggio condivide
 * (stessa origine) e rilegge all'avvio.
 */

import { wsUrl } from './config.js';
import { EnginesPanel } from './engines.js';
import { CompanionSocket } from './ws.js';

const $ = (id) => document.getElementById(id);
const companion = window.companion ?? null;

let enginesLoaded = false;
const engines = new EnginesPanel(document.getElementById('engines-root'), {
  onChanged: (result) => {
    // Cambiando motore di sintesi cambia tutto l'elenco delle voci.
    if (result.kind === 'tts' && Array.isArray(result.voices)) setVoices(result.voices);
  },
});

const HISTORY_KEY = 'dc:chat';
const HISTORY_LIMIT = 200;

/** La prima lettera delle voci Kokoro dice la lingua. */
const VOICE_LANGUAGES = {
  a: 'Inglese (americano)',
  b: 'Inglese (britannico)',
  e: 'Spagnolo',
  f: 'Francese',
  h: 'Hindi',
  i: 'Italiano',
  j: 'Giapponese',
  p: 'Portoghese',
  z: 'Cinese',
};
const VOICE_LANGUAGE_NAMES = { a: 'English', b: 'English', e: 'Spanish', f: 'French', i: 'Italian', j: 'Japanese', p: 'Portuguese' };

const els = {
  status: $('status'),
  openclaw: $('openclaw'),
  dock: $('btn-dock'),
  pin: $('btn-pin'),
  hide: $('btn-hide'),
  tabs: document.querySelectorAll('.tab-btn'),
  messages: $('messages'),
  empty: $('empty'),
  typing: $('typing'),
  composer: $('composer'),
  input: $('input'),
  send: $('btn-send'),
  sayMode: $('say-mode'),
  stop: $('btn-stop'),
  clear: $('btn-clear'),
  voice: $('voice'),
  replyLanguage: $('reply-language'),
  languageHint: $('language-hint'),
  gain: $('gain'),
  gainValue: $('gain-value'),
  scale: $('scale'),
  scaleValue: $('scale-value'),
  toggleTop: $('toggle-top'),
  toggleWindows: $('toggle-windows'),
  toggleSpontaneous: $('toggle-spontaneous'),
  toggleDance: $('toggle-dance'),
  nowPlaying: $('now-playing'),
  nowPlayingText: $('now-playing-text'),
  toggleGhost: $('toggle-ghost'),
  toggleDebug: $('toggle-debug'),
  model: $('btn-model'),
  quit: $('btn-quit'),
  statusLine: $('status-line'),
};

// ---------------------------------------------------------------- preferenze
function readSetting(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeSetting(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* localStorage non disponibile: la preferenza vale fino alla chiusura */
  }
}

// -------------------------------------------------------------------- schede
function showTab(name) {
  for (const button of els.tabs) button.classList.toggle('active', button.dataset.tab === name);
  $('tab-chat').classList.toggle('hidden', name !== 'chat');
  $('tab-menu').classList.toggle('hidden', name !== 'menu');
  $('tab-engines').classList.toggle('hidden', name !== 'engines');
  writeSetting('dc:panel-tab', name);
  if (name === 'chat') {
    scrollToEnd();
    els.input.focus();
  }
  // Caricata alla prima apertura: interrogare i motori a ogni avvio del
  // pannello sarebbe lavoro inutile per chi non li cambia mai.
  if (name === 'engines' && !enginesLoaded) {
    enginesLoaded = true;
    engines.load();
  }
}

for (const button of els.tabs) button.addEventListener('click', () => showTab(button.dataset.tab));

// ---------------------------------------------------------------------- chat
/** Messaggi della chat: `{role: 'user'|'assistant'|'say'|'system', text, turn?, error?}`. */
let history = readSetting(HISTORY_KEY, []);
/** Messaggio della risposta in corso, per turno del backend. */
const pending = new Map();

function saveHistory() {
  history = history.slice(-HISTORY_LIMIT);
  writeSetting(
    HISTORY_KEY,
    history.map(({ role, text, error, note }) => ({ role, text, error, note })),
  );
}

function renderMessage(message) {
  const node = document.createElement('div');
  node.className = `msg ${message.role}${message.error ? ' error' : ''}`;
  node.textContent = message.text;
  if (message.note) {
    const note = document.createElement('span');
    note.className = 'note';
    note.textContent = message.note;
    node.appendChild(note);
  }
  message.node = node;
  els.messages.appendChild(node);
  els.empty.classList.add('hidden');
  return node;
}

function refreshMessage(message) {
  if (!message.node) return;
  message.node.textContent = message.text;
  if (message.note) {
    const note = document.createElement('span');
    note.className = 'note';
    note.textContent = message.note;
    message.node.appendChild(note);
  }
}

function addMessage(message) {
  history.push(message);
  renderMessage(message);
  scrollToEnd();
  saveHistory();
  return message;
}

function scrollToEnd() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function renderHistory() {
  els.messages.querySelectorAll('.msg').forEach((node) => node.remove());
  els.empty.classList.toggle('hidden', history.length > 0);
  for (const message of history) renderMessage(message);
  scrollToEnd();
}

function autoGrow() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(120, els.input.scrollHeight)}px`;
}

els.input.addEventListener('input', autoGrow);
els.input.addEventListener('keydown', (event) => {
  // Invio manda, Maiusc+Invio va a capo.
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    els.composer.requestSubmit();
  }
});

els.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = els.input.value.trim();
  if (!text) return;
  els.input.value = '';
  autoGrow();
  if (els.sayMode.checked) {
    // "say" non passa dall'LLM e il backend non lo ripete come messaggio utente.
    addMessage({ role: 'say', text, note: 'letto ad alta voce' });
    socket.say(text);
  } else {
    socket.chat(text);
  }
});

els.stop.addEventListener('click', () => socket.cancel());
els.clear.addEventListener('click', () => {
  socket.reset();
  history = [];
  pending.clear();
  saveHistory();
  renderHistory();
});

// ---------------------------------------------------------------- backend
const socket = new CompanionSocket(wsUrl);
let backendState = 'idle';

function setStatus() {
  const state = !socket.connected ? 'offline' : backendState === 'thinking' ? 'thinking' : 'online';
  els.status.dataset.state = state;
  els.status.title = { offline: 'Backend non raggiungibile', thinking: 'Sta pensando...', online: 'Backend connesso' }[state];
  els.typing.classList.toggle('hidden', backendState !== 'thinking');
}

socket.on('open', setStatus);
socket.on('close', () => {
  backendState = 'idle';
  setStatus();
  els.statusLine.textContent = 'Backend non raggiungibile, riprovo...';
});

socket.on('hello', (message) => {
  setStatus();
  setVoices(message.voices ?? []);
  // Le scelte fatte qui valgono anche dopo un riavvio del backend: se lui
  // e' ripartito coi default, gliele rimandiamo.
  const voice = readSetting('dc:voice', null);
  const replyLanguage = readSetting('dc:reply-language', null);
  const config = message.config ?? {};
  const wanted = {};
  if (voice && voice !== config.voice && (message.voices ?? []).includes(voice)) wanted.voice = voice;
  if (replyLanguage && replyLanguage !== config.replyLanguage) wanted.replyLanguage = replyLanguage;
  applySettings({ ...config, ...wanted });
  if (Object.keys(wanted).length) socket.send({ type: 'settings', ...wanted });
  setOpenClaw(message.openclaw);
  els.statusLine.textContent =
    `LLM: ${config.llmBackend ?? '?'} - voce: ${config.ttsEngine ?? '?'}` + (config.version ? ` - v${config.version}` : '');
});

socket.on('settings', applySettings);
socket.on('openclaw', setOpenClaw);

socket.on('state', (message) => {
  backendState = message.value;
  setStatus();
});

socket.on('user', (message) => {
  addMessage({ role: 'user', text: message.text });
});

socket.on('token', (message) => {
  let reply = pending.get(message.turn);
  if (!reply) {
    reply = addMessage({ role: 'assistant', text: '' });
    pending.set(message.turn, reply);
  }
  reply.text += message.text;
  refreshMessage(reply);
  scrollToEnd();
});

socket.on('reply', (message) => {
  const reply = pending.get(message.turn);
  pending.delete(message.turn);
  if (reply) {
    // Il testo arrivato a pezzi resta quello mostrato (con le sue emoji);
    // la versione "pulita" del backend serve solo alla voce.
    reply.text = reply.text.trim() || message.text;
    if (message.cancelled) reply.note = 'interrotta';
    refreshMessage(reply);
    saveHistory();
  } else if (message.text && message.cancelled !== undefined) {
    addMessage({ role: 'assistant', text: message.text, note: message.cancelled ? 'interrotta' : undefined });
  }
});

socket.on('notice', (message) => addMessage({ role: 'system', text: message.message }));
socket.on('error', (message) => addMessage({ role: 'system', text: message.message ?? 'Errore', error: true }));
socket.on('reset', () => {
  history = [];
  pending.clear();
  saveHistory();
  renderHistory();
});

function setOpenClaw(status) {
  if (!status || status.state === 'disabled') {
    els.openclaw.classList.add('hidden');
    return;
  }
  els.openclaw.classList.remove('hidden');
  els.openclaw.dataset.state = status.state ?? 'unknown';
  const labels = { online: 'OpenClaw connesso', degraded: 'OpenClaw non pronto', offline: 'OpenClaw disconnesso' };
  els.openclaw.title = `${labels[status.state] ?? 'OpenClaw: stato sconosciuto'}${status.error ? `\n${status.error}` : ''}`;
}

// ----------------------------------------------------------- voce e lingua
function voiceLabel(name) {
  const gender = name[1] === 'f' ? 'donna' : name[1] === 'm' ? 'uomo' : '';
  const base = name.includes('_') ? name.split('_').slice(1).join(' ') : name;
  const pretty = base.charAt(0).toUpperCase() + base.slice(1);
  return gender ? `${pretty} (${gender})` : pretty;
}

function setVoices(voices) {
  const current = els.voice.value;
  els.voice.replaceChildren();
  const groups = new Map();
  for (const voice of voices) {
    const language = VOICE_LANGUAGES[voice[0]] ?? 'Altre';
    if (!groups.has(language)) groups.set(language, []);
    groups.get(language).push(voice);
  }
  for (const [language, list] of groups) {
    const group = document.createElement('optgroup');
    group.label = language;
    for (const voice of list) {
      const option = document.createElement('option');
      option.value = voice;
      option.textContent = voiceLabel(voice);
      group.appendChild(option);
    }
    els.voice.appendChild(group);
  }
  if (current) els.voice.value = current;
}

function applySettings(settings) {
  if (settings.voice) {
    // Una voce che il motore non elenca (es. dopo un cambio di motore) va
    // comunque mostrata, altrimenti la tendina resta vuota.
    if (![...els.voice.options].some((option) => option.value === settings.voice)) {
      const option = document.createElement('option');
      option.value = settings.voice;
      option.textContent = voiceLabel(settings.voice);
      els.voice.prepend(option);
    }
    els.voice.value = settings.voice;
  }
  if (settings.replyLanguage) els.replyLanguage.value = settings.replyLanguage;
  updateLanguageHint();
}

/** Avvisa se la lingua delle risposte non e' quella che la voce sa pronunciare. */
function updateLanguageHint() {
  const voice = els.voice.value;
  const voiceLanguage = VOICE_LANGUAGE_NAMES[voice?.[0]];
  const reply = els.replyLanguage.value;
  const hint = els.languageHint;
  hint.classList.remove('warn');
  if (reply === 'auto') {
    hint.textContent = voiceLanguage
      ? `Risponde sempre in ${{ English: 'inglese', Italian: 'italiano', Spanish: 'spagnolo', French: 'francese', Japanese: 'giapponese', Portuguese: 'portoghese' }[voiceLanguage] ?? voiceLanguage}, anche se le scrivi in un'altra lingua.`
      : '';
  } else if (reply === 'same' || (voiceLanguage && reply !== voiceLanguage)) {
    hint.textContent = 'Attenzione: la voce pronuncia bene solo la sua lingua, le risposte in altre lingue suoneranno strane.';
    hint.classList.add('warn');
  } else {
    hint.textContent = '';
  }
}

els.voice.addEventListener('change', () => {
  writeSetting('dc:voice', els.voice.value);
  socket.send({ type: 'settings', voice: els.voice.value });
  updateLanguageHint();
});

els.replyLanguage.addEventListener('change', () => {
  writeSetting('dc:reply-language', els.replyLanguage.value);
  socket.send({ type: 'settings', replyLanguage: els.replyLanguage.value });
  updateLanguageHint();
});

// ------------------------------------------------------------ personaggio
const gain = readSetting('dc:gain', 1.15);
els.gain.value = String(gain);
els.gainValue.textContent = Number(gain).toFixed(2);
els.gain.addEventListener('input', () => {
  const value = Number(els.gain.value);
  els.gainValue.textContent = value.toFixed(2);
  writeSetting('dc:gain', value);
  companion?.sendToPet({ type: 'gain', value });
});

els.toggleSpontaneous.checked = readSetting('dc:spontaneous', true);
els.toggleSpontaneous.addEventListener('change', () => {
  writeSetting('dc:spontaneous', els.toggleSpontaneous.checked);
  companion?.sendToPet({ type: 'spontaneous', value: els.toggleSpontaneous.checked });
});

els.toggleDance.checked = readSetting('dc:dance', true);
els.toggleDance.addEventListener('change', () => {
  writeSetting('dc:dance', els.toggleDance.checked);
  companion?.sendToPet({ type: 'dance', value: els.toggleDance.checked });
});

function setMusic(music) {
  const playing = Boolean(music?.playing);
  els.nowPlaying.classList.toggle('hidden', !playing);
  if (playing) els.nowPlayingText.textContent = `${music.title} — ${music.artist}`;
}

els.toggleDebug.addEventListener('change', () => {
  companion?.sendToPet({ type: 'debug', value: els.toggleDebug.checked });
});

let scaleTimer = null;
els.scale.addEventListener('input', () => {
  const value = Number(els.scale.value);
  els.scaleValue.textContent = `${Math.round(value * 100)}%`;
  // Ridimensionare la finestra a ogni pixel dello slider e' pesante: poche volte al secondo bastano.
  clearTimeout(scaleTimer);
  scaleTimer = setTimeout(() => companion?.setScale(value), 40);
});

els.toggleTop.addEventListener('change', () => companion?.toggleAlwaysOnTop());
els.toggleGhost.addEventListener('change', () => companion?.toggleGhost());
els.toggleWindows.addEventListener('change', () => companion?.setWindows(els.toggleWindows.checked));

document.querySelectorAll('[data-play]').forEach((button) => {
  button.addEventListener('click', () => companion?.sendToPet({ type: 'play', name: button.dataset.play }));
});
document.querySelectorAll('[data-posture]').forEach((button) => {
  button.addEventListener('click', () => companion?.sendToPet({ type: 'posture', value: button.dataset.posture }));
});

els.model.addEventListener('click', () => companion?.pickModel());
els.quit.addEventListener('click', () => companion?.quit());

// ------------------------------------------------------------- finestra
let docked = true;
let panelPinned = false;

els.dock.addEventListener('click', () => companion?.setDocked(!docked));
els.pin.addEventListener('click', () => companion?.setPanelPinned(!panelPinned));
els.hide.addEventListener('click', () => companion?.hidePanel());
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') companion?.hidePanel();
});

function applyState(state) {
  if (!state) return;
  docked = state.docked;
  panelPinned = state.panelPinned;
  els.dock.classList.toggle('active', docked);
  els.dock.title = docked ? 'Agganciato al personaggio: trascina il pannello per staccarlo' : 'Aggancia al personaggio';
  els.pin.classList.toggle('active', panelPinned);
  els.toggleTop.checked = state.pinned;
  els.toggleGhost.checked = state.ghost;
  els.toggleWindows.checked = state.windows;
  els.toggleWindows.disabled = !state.windowsAvailable;
  els.scale.value = String(state.scale);
  els.scaleValue.textContent = `${Math.round(state.scale * 100)}%`;
  setMusic(state.music);
}

if (companion) {
  companion.getState().then(applyState);
  companion.onState(applyState);
  companion.onMusic(setMusic);
  // Il personaggio chiede di mostrare una scheda (tasto destro = menu,
  // doppio click o iniziare a scrivere = chat, col primo tasto gia' dentro).
  companion.onFocus(({ tab, text } = {}) => {
    showTab(tab ?? 'chat');
    if (tab === 'chat' && text) {
      els.input.value += text;
      autoGrow();
    }
    if (tab === 'chat') els.input.focus();
  });
} else {
  // Aperto in un browser qualunque: niente comandi per la finestra.
  for (const id of ['btn-dock', 'btn-pin', 'btn-hide']) $(id).classList.add('hidden');
}

renderHistory();
showTab(readSetting('dc:panel-tab', 'chat'));
setStatus();
socket.connect();
