/**
 * What the panel's views share, in whichever window they live: the backend
 * connection, the settings, voices and engines it sends, and a small event
 * bus the views listen on (`hello`, `engines`, `voices`, `settings`,
 * `providers`, `busy`, plus what the window adds: `mic`, `window-state`).
 *
 * The chat window (panel.js) and the dashboard (dashboard.js, which holds
 * every other section) each make one: the backend sends everything to every
 * client, so both stay in step on their own.
 */

import { wsUrl } from './config.js';
import { readSetting } from './dom.js';
import { CompanionSocket } from './ws.js';

const SETTING_KEYS = ['voice', 'ttsEngine', 'replyLanguage', 'replyLanguageResolved', 'voiceLanguage', 'canClone', 'muted'];

function pickSettings(message) {
  return Object.fromEntries(SETTING_KEYS.filter((key) => key in message).map((key) => [key, message[key]]));
}

/**
 * @param {{companion: object|null, showTab: Function, toast: Function}} options
 *   `showTab(name, options)` is the window's: each one knows which sections it holds.
 */
export function createHub({ companion, showTab, toast }) {
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
    showTab,
    toast,
  };

  const { socket } = app;
  socket.on('close', () => {
    app.busy = 'idle';
    app.emit('busy', app.busy);
  });
  socket.on('hello', (message) => {
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
  return app;
}

/**
 * The voice and reply language chosen in Character hold after a backend
 * restart too: if it started again with the defaults, we send them back.
 * The voice is saved per engine: `af_heart` is a Kokoro voice and means
 * nothing on ElevenLabs. Only the chat window does it, because it's the
 * one that is always loaded (the dashboard may never open).
 */
export function restorePreferences(socket, config) {
  const wanted = {};
  const engine = config.ttsEngine;
  const voice = engine ? readSetting(`dc:voice:${engine}`, null) : null;
  if (voice && voice !== config.voice) wanted.voice = voice;
  const replyLanguage = readSetting('dc:reply-language', null);
  if (replyLanguage && replyLanguage !== config.replyLanguage) wanted.replyLanguage = replyLanguage;
  if (Object.keys(wanted).length) socket.send({ type: 'settings', ...wanted });
}
