/**
 * Tsukumo on the phone: text chat only, from Safari or the Home Screen.
 *
 * The link comes from the QR code on the PC (backend/phone.py) and carries
 * the token after "#": the browser never sends it to the server. The page
 * trades it for a cookie (POST /api/phone/session), which then goes along
 * with the WebSocket. The link stays whole in the address bar: "Add to Home
 * Screen" takes it along, and the Home Screen app (which can't see Safari's
 * data) starts again from there.
 *
 * The WebSocket opens with ?mode=text: the backend sends it no audio, and
 * the turns written here aren't spoken aloud on the PC at home.
 */

import { t, translateDom, tx } from '../i18n.js';

import { renderMarkdown } from '../markdown.js';
import { CompanionSocket } from '../ws.js';

translateDom();

const TOKEN_KEY = 'tsukumo:phone-token';
const HISTORY_KEY = 'tsukumo:phone-chat';
const SYNCED_KEY = 'tsukumo:phone-seq';
const MAX_HISTORY = 80;

const $ = (id) => document.getElementById(id);
const log = $('log');
const input = $('input');
const send = $('send');
const statusLine = $('status');

function load(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key, value) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* private mode: carry on without it */
  }
}

function readToken() {
  const fromLink = new URLSearchParams(window.location.hash.slice(1)).get('t');
  if (fromLink) store(TOKEN_KEY, fromLink);
  return fromLink || load(TOKEN_KEY);
}

// ---------------------------------------------------------------------------
// Messages

/** @type {{role: string, text: string, note?: string, el?: HTMLElement, pending?: boolean, broken?: boolean}[]} */
let messages = [];
const replies = new Map(); // turn -> assistant message on its way
let renderTimer = null;
// The last line numbered by the backend (seq) we've seen: when reconnecting
// only the later ones are taken from the hello.
let synced = Number(load(SYNCED_KEY)) || 0;

function saveHistory() {
  const kept = messages.filter((m) => !m.pending && m.text).slice(-MAX_HISTORY);
  store(HISTORY_KEY, JSON.stringify(kept.map(({ role, text, note }) => ({ role, text, note }))));
  store(SYNCED_KEY, String(synced));
}

function seen(message) {
  synced = Math.max(synced, Number(message.seq) || 0);
}

/**
 * The lines that arrived while Safari kept the page suspended (the hello's
 * ``transcript``). The first time, with a history already full whose numbers
 * we don't know, we take them as seen: better to lose one than to double them.
 */
function catchUp(lines) {
  if (!Array.isArray(lines) || !lines.length) return;
  const fresh = lines.filter((line) => line && typeof line.text === 'string' && Number(line.seq) > synced);
  const known = synced > 0 || !messages.length;
  lines.forEach(seen);
  if (!known || !fresh.length) {
    saveHistory();
    return;
  }
  for (const line of fresh.sort((a, b) => a.seq - b.seq)) {
    if (line.role === 'user') {
      const mine = messages.find((m) => m.pending && m.text.trim() === line.text.trim());
      if (mine) {
        mine.pending = false;
        draw(mine);
      } else if (line.text) {
        add({ role: 'user', text: line.text });
      }
    } else if (line.role === 'assistant') {
      // The turn halfway through when the page was suspended: it completes there.
      const partial = replies.get(line.turn);
      const note = line.cancelled ? 'interrotta' : undefined;
      if (partial) {
        replies.delete(line.turn);
        Object.assign(partial, { text: line.text, note, streaming: false, broken: false });
        draw(partial);
      } else {
        add({ role: 'assistant', text: line.text, note });
      }
    }
  }
  scrollDown();
  saveHistory();
}

function draw(message) {
  const row = message.el ?? document.createElement('div');
  row.className = `msg ${message.role}${message.pending ? ' pending' : ''}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (message.role === 'assistant' && !message.streaming) bubble.append(renderMarkdown(message.text));
  else bubble.textContent = message.text;
  const parts = [bubble];
  if (message.note) {
    const note = document.createElement('span');
    note.className = 'note';
    note.textContent = message.note;
    parts.push(note);
  }
  row.replaceChildren(...parts);
  if (!message.el) {
    message.el = row;
    log.append(row);
  }
  $('empty').classList.toggle('hidden', messages.length > 0);
}

function nearBottom() {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 120;
}

function scrollDown(force = false) {
  if (force || nearBottom()) log.scrollTop = log.scrollHeight;
}

function add(message) {
  const stick = nearBottom();
  messages.push(message);
  draw(message);
  scrollDown(stick || message.role === 'user');
  return message;
}

function clearChat() {
  messages = [];
  replies.clear();
  log.querySelectorAll('.msg').forEach((el) => el.remove());
  $('empty').classList.remove('hidden');
  saveHistory();
}

function restoreHistory() {
  let saved = [];
  try {
    saved = JSON.parse(load(HISTORY_KEY) || '[]');
  } catch {
    saved = [];
  }
  saved.filter((m) => m && typeof m.text === 'string').forEach((m) => add({ role: m.role, text: m.text, note: m.note }));
  scrollDown(true);
}

// ---------------------------------------------------------------------------
// Status at the top and the send/stop button

let busy = false;

function setStatus(state, text) {
  statusLine.dataset.state = state;
  statusLine.textContent = text;
}

function setBusy(value) {
  busy = value;
  updateButton();
}

/** While she thinks, with an empty field, the button stops her. */
function updateButton() {
  const stop = busy && !input.value.trim();
  send.dataset.mode = stop ? 'stop' : 'send';
  send.setAttribute('aria-label', stop ? t('Stop') : t('Send'));
}

function lock(text) {
  $('locked').classList.remove('hidden');
  log.classList.add('hidden');
  $('composer').classList.add('hidden');
  if (text) $('locked-text').textContent = text;
  setStatus('offline', t('Not connected'));
}

// ---------------------------------------------------------------------------
// Connection

/**
 * Trades the token for the WebSocket cookie: 'ok', 'denied', 'offline' (no
 * answer) or the HTTP code of another error.
 */
async function openSession(token) {
  try {
    const response = await fetch('/api/phone/session', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (response.ok) return 'ok';
    if (response.status === 401) return 'denied';
    return response.status >= 500 ? 'offline' : String(response.status);
  } catch {
    return 'offline';
  }
}

function connect() {
  const url = new URL('/ws', window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('mode', 'text');
  const socket = new CompanionSocket(url.toString(), { maxDelay: 6000 });

  socket.on('open', () => setStatus('online', t('Connected')));
  socket.on('close', () => {
    setStatus('offline', t("Can't reach the PC…"));
    setBusy(false);
    // Part of the streaming got lost: in the end the reply's text counts.
    replies.forEach((reply) => {
      reply.broken = true;
    });
  });
  socket.on('hello', (message) => catchUp(message.transcript));

  socket.on('state', (message) => {
    if (message.value === 'thinking') {
      setBusy(true);
      setStatus('busy', t('Thinking…|status'));
    } else if (message.value === 'idle') {
      setBusy(false);
      setStatus('online', t('Connected'));
    }
  });
  socket.on('working', (message) => {
    if (message.label) setStatus('busy', tx(message.label));
  });

  socket.on('user', (message) => {
    seen(message);
    const text = String(message.text ?? '');
    // The message written here comes back from the backend: it becomes "delivered".
    const mine = messages.find((m) => m.pending && m.text.trim() === text.trim());
    if (mine) {
      mine.pending = false;
      draw(mine);
    } else {
      add({ role: 'user', text });
    }
    saveHistory();
  });

  socket.on('token', (message) => {
    let reply = replies.get(message.turn);
    if (!reply) {
      reply = add({ role: 'assistant', text: '', streaming: true });
      replies.set(message.turn, reply);
    }
    reply.text += message.text;
    if (!renderTimer) {
      renderTimer = setTimeout(() => {
        renderTimer = null;
        const stick = nearBottom();
        replies.forEach(draw);
        scrollDown(stick);
      }, 60);
    }
  });

  socket.on('reply', (message) => {
    if (message.said) return;
    seen(message);
    const reply = replies.get(message.turn);
    replies.delete(message.turn);
    if (reply) {
      reply.streaming = false;
      reply.text = (reply.broken ? message.text : reply.text.trim()) || message.text || reply.text.trim();
      reply.broken = false;
      if (message.cancelled) reply.note = 'interrotta';
      if (reply.text) draw(reply);
      else {
        reply.el?.remove();
        messages = messages.filter((m) => m !== reply);
      }
    } else if (message.text && message.cancelled !== undefined && !message.failed) {
      // Reminders and notifications: she speaks on her own.
      add({ role: 'assistant', text: message.text });
    }
    scrollDown();
    saveHistory();
  });

  socket.on('notice', (message) => add({ role: 'notice', text: tx(message.message) ?? '' }));
  socket.on('error', (message) => add({ role: 'error', text: tx(message.message) ?? t('Error'), note: tx(message.hint) }));
  socket.on('reset', clearChat);

  socket.connect();
  return socket;
}

// ---------------------------------------------------------------------------
// Composer

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  input.style.overflowY = input.scrollHeight > 140 ? 'auto' : 'hidden';
}

function wire(socket) {
  $('composer').addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy && !input.value.trim()) {
      socket.cancel();
      return;
    }
    const text = input.value.trim();
    if (!text) return;
    add({ role: 'user', text, pending: true });
    socket.chat(text);
    input.value = '';
    autosize();
    updateButton();
  });
  input.addEventListener('input', () => {
    autosize();
    updateButton();
  });
  // Enter sends, Shift+Enter starts a new line (with a physical keyboard).
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $('composer').requestSubmit();
    }
  });
  // With the keyboard open the page shrinks to what's still visible.
  const viewport = window.visualViewport;
  if (viewport) {
    const fit = () => {
      document.documentElement.style.setProperty('--app-height', `${viewport.height}px`);
      window.scrollTo(0, 0);
      scrollDown(true);
    };
    viewport.addEventListener('resize', fit);
    fit();
  }
}

// ---------------------------------------------------------------------------

async function start() {
  const token = readToken();
  if (!token) {
    lock();
    return;
  }
  restoreHistory();
  let session = await openSession(token);
  while (session !== 'ok' && session !== 'denied') {
    // A different error (e.g. 403) isn't "PC off": we say it with its code.
    const why = session === 'offline' ? t("Can't reach the PC: are Tailscale and Tsukumo running?") : t('The PC refuses the connection (error {code})', { code: session });
    setStatus('offline', why);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    session = await openSession(token);
  }
  if (session === 'denied') {
    store(TOKEN_KEY, null);
    lock(t('This link is no longer valid. On the PC open http://127.0.0.1:8770/api/phone and scan the new QR code.'));
    return;
  }
  const socket = connect();
  // The cookie can expire or vanish: we renew it at every drop.
  socket.on('close', () => openSession(token));
  wire(socket);
}

start();
