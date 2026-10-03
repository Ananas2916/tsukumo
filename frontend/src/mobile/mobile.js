/**
 * Tsukumo sul telefono: solo chat di testo, da Safari o dalla schermata Home.
 *
 * Il link arriva dal QR sul PC (backend/phone.py) e porta il token dopo "#":
 * il browser non lo manda mai al server. La pagina lo scambia con un cookie
 * (POST /api/phone/session), che poi accompagna il WebSocket. Il link resta
 * intero nella barra: "Aggiungi alla schermata Home" se lo porta dietro, e
 * l'app sulla Home (che non vede i dati di Safari) riparte da li'.
 *
 * Il WebSocket si apre con ?mode=text: il backend non le manda l'audio e i
 * turni scritti da qui non parlano ad alta voce sul PC a casa.
 */

import { renderMarkdown } from '../markdown.js';
import { CompanionSocket } from '../ws.js';

const TOKEN_KEY = 'tsukumo:phone-token';
const HISTORY_KEY = 'tsukumo:phone-chat';
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
    /* modalita' privata: si va avanti senza */
  }
}

function readToken() {
  const fromLink = new URLSearchParams(window.location.hash.slice(1)).get('t');
  if (fromLink) store(TOKEN_KEY, fromLink);
  return fromLink || load(TOKEN_KEY);
}

// ---------------------------------------------------------------------------
// Messaggi

/** @type {{role: string, text: string, note?: string, el?: HTMLElement, pending?: boolean}[]} */
let messages = [];
const replies = new Map(); // turno -> messaggio dell'assistente in arrivo
let renderTimer = null;

function saveHistory() {
  const kept = messages.filter((m) => !m.pending && m.text).slice(-MAX_HISTORY);
  store(HISTORY_KEY, JSON.stringify(kept.map(({ role, text, note }) => ({ role, text, note }))));
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
// Stato in alto e tasto invia/ferma

let busy = false;

function setStatus(state, text) {
  statusLine.dataset.state = state;
  statusLine.textContent = text;
}

function setBusy(value) {
  busy = value;
  updateButton();
}

/** Mentre pensa, a campo vuoto, il tasto la ferma. */
function updateButton() {
  const stop = busy && !input.value.trim();
  send.dataset.mode = stop ? 'stop' : 'send';
  send.setAttribute('aria-label', stop ? 'Ferma' : 'Invia');
}

function lock(text) {
  $('locked').classList.remove('hidden');
  log.classList.add('hidden');
  $('composer').classList.add('hidden');
  if (text) $('locked-text').textContent = text;
  setStatus('offline', 'Non collegato');
}

// ---------------------------------------------------------------------------
// Collegamento

/** Scambia il token con il cookie del WebSocket: 'ok', 'denied' o 'offline'. */
async function openSession(token) {
  try {
    const response = await fetch('/api/phone/session', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (response.ok) return 'ok';
    return response.status === 401 ? 'denied' : 'offline';
  } catch {
    return 'offline';
  }
}

function connect() {
  const url = new URL('/ws', window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('mode', 'text');
  const socket = new CompanionSocket(url.toString(), { maxDelay: 6000 });

  socket.on('open', () => setStatus('online', 'Collegata'));
  socket.on('close', () => {
    setStatus('offline', 'Non raggiungo il PC…');
    setBusy(false);
  });

  socket.on('state', (message) => {
    if (message.value === 'thinking') {
      setBusy(true);
      setStatus('busy', 'Sta pensando…');
    } else if (message.value === 'idle') {
      setBusy(false);
      setStatus('online', 'Collegata');
    }
  });
  socket.on('working', (message) => {
    if (message.label) setStatus('busy', message.label);
  });

  socket.on('user', (message) => {
    const text = String(message.text ?? '');
    // Il messaggio scritto qui torna dal backend: diventa "consegnato".
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
    const reply = replies.get(message.turn);
    replies.delete(message.turn);
    if (reply) {
      reply.streaming = false;
      reply.text = reply.text.trim() || message.text || '';
      if (message.cancelled) reply.note = 'interrotta';
      if (reply.text) draw(reply);
      else {
        reply.el?.remove();
        messages = messages.filter((m) => m !== reply);
      }
    } else if (message.text && message.cancelled !== undefined && !message.failed) {
      // Promemoria e notifiche: parla di sua iniziativa.
      add({ role: 'assistant', text: message.text });
    }
    scrollDown();
    saveHistory();
  });

  socket.on('notice', (message) => add({ role: 'notice', text: message.message ?? '' }));
  socket.on('error', (message) => add({ role: 'error', text: message.message ?? 'Errore', note: message.hint }));
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
  // Invio manda, Maiusc+Invio va a capo (con una tastiera fisica).
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $('composer').requestSubmit();
    }
  });
  // Con la tastiera aperta la pagina si accorcia a quello che resta visibile.
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
  while (session === 'offline') {
    setStatus('offline', 'Non raggiungo il PC: Tailscale e Tsukumo sono accesi?');
    await new Promise((resolve) => setTimeout(resolve, 5000));
    session = await openSession(token);
  }
  if (session === 'denied') {
    store(TOKEN_KEY, null);
    lock('Questo link non vale più. Sul PC apri http://127.0.0.1:8770/api/phone e inquadra il QR nuovo.');
    return;
  }
  const socket = connect();
  // Il cookie puo' scadere o sparire: lo rinnoviamo a ogni caduta.
  socket.on('close', () => openSession(token));
  wire(socket);
}

start();
