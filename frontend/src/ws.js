/**
 * Client WebSocket con riconnessione automatica.
 *
 * Espone un mini event-emitter: `on(type, handler)` dove `type` e' il campo
 * `type` dei messaggi del backend, piu' gli eventi locali `open`, `close`,
 * `socketerror` e `*` (tutti i messaggi).
 *
 * Nota sui nomi: l'evento di trasporto si chiama `socketerror` e NON `error`,
 * perche' il backend invia anche messaggi applicativi `{type: "error"}`. Con
 * lo stesso nome lo stesso handler riceverebbe due payload di forma diversa.
 */

export class CompanionSocket {
  /**
   * @param {string} url URL del WebSocket (ws:// o wss://)
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
    this.queue = []; // messaggi inviati mentre la socket era chiusa
    this.reconnectTimer = null;
  }

  /** Registra un handler. Ritorna una funzione per rimuoverlo. */
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
        console.error(`[ws] handler "${type}" ha sollevato un errore`, error);
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
      // Svuota la coda accumulata durante la disconnessione.
      const pending = this.queue.splice(0);
      pending.forEach((message) => this.send(message));
    });

    socket.addEventListener('message', (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (error) {
        console.warn('[ws] messaggio non JSON ignorato', error);
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
      // 'error' e' sempre seguito da 'close': la riconnessione la gestiamo li'.
      this.emit('socketerror', null);
    });
  }

  scheduleReconnect() {
    if (this.closedByUser) return;
    this.attempt += 1;
    // Backoff esponenziale con tetto massimo.
    const delay = Math.min(this.minDelay * 2 ** (this.attempt - 1), this.maxDelay);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /** Invia un messaggio; se la socket e' chiusa lo mette in coda. */
  send(message) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
      return true;
    }
    // Teniamo una coda corta: i messaggi vecchi non servono piu'.
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
   * Invia audio dal microfono da trascrivere.
   *
   * @param {string} audio PCM 16 bit a 16 kHz, mono, in base64
   * @param {boolean} [autoSend] false = trascrivi soltanto, senza rispondere
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
