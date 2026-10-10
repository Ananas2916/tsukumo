/**
 * WebSocket client with automatic reconnection.
 *
 * Exposes a mini event emitter: `on(type, handler)` where `type` is the
 * `type` field of the backend's messages, plus the local events `open`,
 * `close`, `socketerror` and `*` (every message).
 *
 * About the names: the transport event is called `socketerror` and NOT
 * `error`, because the backend also sends application messages
 * `{type: "error"}`. With the same name the same handler would receive two
 * payloads of different shapes.
 */

export class CompanionSocket {
  /**
   * @param {string} url WebSocket URL (ws:// or wss://)
   * @param {{minDelay?: number, maxDelay?: number}} [options]
   */
  constructor(url, options = {}) {
    this.url = url;
    this.minDelay = options.minDelay ?? 600;
    this.maxDelay = options.maxDelay ?? 8000;

    this.socket = null;
    this.connected = false;
    this.closedByUser = false;
    this.attempt = 0;
    this.handlers = new Map();
    this.queue = []; // messages sent while the socket was closed
    this.reconnectTimer = null;
  }

  /** Registers a handler. Returns a function that removes it. */
  on(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }

  emit(type, payload) {
    this.handlers.get(type)?.forEach((handler) => {
      try {
        handler(payload);
      } catch (error) {
        console.error(`[ws] handler "${type}" threw an error`, error);
      }
    });
  }

  connect() {
    this.closedByUser = false;
    clearTimeout(this.reconnectTimer);

    let socket;
    try {
      socket = new WebSocket(this.url);
    } catch (error) {
      this.emit('close', { error });
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.connected = true;
      this.attempt = 0;
      this.emit('open', null);
      // Flush the queue built up while disconnected.
      const pending = this.queue.splice(0);
      pending.forEach((message) => this.send(message));
    });

    socket.addEventListener('message', (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (error) {
        console.warn('[ws] non-JSON message ignored', error);
        return;
      }
      this.emit('*', data);
      if (data && typeof data.type === 'string') this.emit(data.type, data);
    });

    socket.addEventListener('close', () => {
      this.connected = false;
      this.emit('close', null);
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // 'error' is always followed by 'close': reconnection is handled there.
      this.emit('socketerror', null);
    });
  }

  scheduleReconnect() {
    if (this.closedByUser) return;
    this.attempt += 1;
    // Exponential backoff with a ceiling.
    const delay = Math.min(this.minDelay * 2 ** (this.attempt - 1), this.maxDelay);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /** Sends a message; if the socket is closed it queues it. */
  send(message) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
      return true;
    }
    // We keep a short queue: old messages are no longer useful.
    this.queue.push(message);
    if (this.queue.length > 16) this.queue.shift();
    return false;
  }

  chat(text) {
    return this.send({ type: 'chat', text });
  }

  say(text, voice) {
    return this.send({ type: 'say', text, voice });
  }

  /**
   * Sends microphone audio to be transcribed.
   *
   * @param {string} audio 16-bit PCM at 16 kHz, mono, in base64
   * @param {boolean} [autoSend] false = only transcribe, don't reply
   */
  voice(audio, autoSend = true) {
    return this.send({ type: 'voice', audio, autoSend });
  }

  cancel() {
    return this.send({ type: 'cancel' });
  }

  reset() {
    return this.send({ type: 'reset' });
  }

  close() {
    this.closedByUser = true;
    clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }
}
