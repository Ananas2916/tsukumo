/**
 * Riproduzione dell'audio ricevuto dal backend.
 *
 * Il backend manda una frase alla volta (`speech`), quindi qui teniamo una
 * coda: mentre la prima frase suona le successive vengono decodificate e
 * accodate, cosi' il parlato risulta continuo.
 *
 * Oltre a suonare, la classe misura il livello RMS istantaneo con un
 * AnalyserNode: e' quello che permette al lip-sync di restare agganciato al
 * volume reale anche se la timeline dei visemi sbanda di qualche millisecondo.
 */

/** Converte il WAV in base64 ricevuto via WebSocket in un ArrayBuffer. */
function base64ToArrayBuffer(base64) {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export class SpeechPlayer {
  /**
   * @param {{onClipStart?: Function, onClipEnd?: Function, onIdle?: Function}} [callbacks]
   */
  constructor(callbacks = {}) {
    this.onClipStart = callbacks.onClipStart ?? (() => {});
    this.onClipEnd = callbacks.onClipEnd ?? (() => {});
    this.onIdle = callbacks.onIdle ?? (() => {});

    this.context = null;
    this.analyser = null;
    this.gainNode = null;
    this.timeDomain = null;

    this.queue = [];
    this.source = null;
    this.clip = null;
    this.startedAt = 0;
    this.playing = false;
    this.level = 0; // RMS lisciato, 0..1
    this.volume = 1;
    /** Incrementato a ogni stop(): invalida le decodifiche in volo. */
    this.generation = 0;
  }

  /** Crea (una volta sola) il grafo WebAudio: source -> gain -> analyser -> out. */
  ensureContext() {
    if (this.context) return this.context;

    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    const context = new AudioCtor();

    const gainNode = context.createGain();
    gainNode.gain.value = this.volume;

    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.35;

    gainNode.connect(analyser);
    analyser.connect(context.destination);

    this.context = context;
    this.gainNode = gainNode;
    this.analyser = analyser;
    this.timeDomain = new Uint8Array(analyser.fftSize);
    return context;
  }

  /** I browser bloccano l'audio finche' non c'e' un gesto dell'utente. */
  async resume() {
    const context = this.ensureContext();
    if (context.state === 'suspended') await context.resume();
    return context.state === 'running';
  }

  setVolume(value) {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.gainNode) this.gainNode.gain.value = this.volume;
  }

  /**
   * Decodifica e accoda un messaggio `speech` del backend.
   * @param {{audio: string, visemes: Array, duration: number, text: string}} payload
   */
  async enqueue(payload) {
    if (!payload?.audio) return;
    const context = this.ensureContext();
    const generation = this.generation;

    let buffer;
    try {
      buffer = await context.decodeAudioData(base64ToArrayBuffer(payload.audio));
    } catch (error) {
      console.error('[audio] WAV non decodificabile', error);
      return;
    }

    // Se nel frattempo e' arrivato uno stop(), scartiamo il risultato.
    if (generation !== this.generation) return;

    this.queue.push({ buffer, payload });
    if (!this.playing) this.playNext();
  }

  playNext() {
    const next = this.queue.shift();
    if (!next) {
      this.playing = false;
      this.clip = null;
      this.source = null;
      this.onIdle();
      return;
    }

    const context = this.ensureContext();
    if (context.state === 'suspended') {
      // Senza gesto utente non possiamo suonare: riproviamo appena si sblocca.
      context.resume().catch(() => {});
    }

    const source = context.createBufferSource();
    source.buffer = next.buffer;
    source.connect(this.gainNode);

    const generation = this.generation;
    source.onended = () => {
      if (generation !== this.generation) return;
      this.onClipEnd(next.payload);
      this.playNext();
    };

    this.source = source;
    this.clip = next.payload;
    this.startedAt = context.currentTime;
    this.playing = true;

    source.start();
    this.onClipStart(next.payload);
  }

  /** Secondi trascorsi dall'inizio della clip corrente. */
  get currentTime() {
    if (!this.playing || !this.context || !this.clip) return 0;
    const elapsed = this.context.currentTime - this.startedAt;
    const duration = this.clip.duration || Infinity;
    return Math.max(0, Math.min(elapsed, duration));
  }

  /** Svuota la coda e ferma la riproduzione immediatamente. */
  stop() {
    this.generation += 1;
    this.queue.length = 0;
    if (this.source) {
      try {
        this.source.onended = null;
        this.source.stop();
      } catch {
        /* la sorgente poteva essere gia' finita */
      }
    }
    this.source = null;
    this.clip = null;
    this.playing = false;
    this.level = 0;
    this.onIdle();
  }

  /**
   * Aggiorna il livello RMS. Va chiamata una volta per frame dal render loop.
   * @param {number} dt secondi trascorsi dall'ultimo frame
   */
  update(dt) {
    if (!this.analyser || !this.playing) {
      // Rilascio dolce quando non c'e' audio: evita scatti della mascella.
      this.level += (0 - this.level) * Math.min(1, dt * 12);
      return this.level;
    }

    this.analyser.getByteTimeDomainData(this.timeDomain);
    let sum = 0;
    for (let i = 0; i < this.timeDomain.length; i += 1) {
      const centered = (this.timeDomain[i] - 128) / 128;
      sum += centered * centered;
    }
    const rms = Math.sqrt(sum / this.timeDomain.length);

    // Normalizzazione empirica: il parlato di Kokoro sta intorno a 0.06-0.25 RMS.
    const target = Math.min(1, rms * 4.2);
    // Attacco rapido, rilascio piu' lento: la bocca apre subito e chiude morbida.
    const speed = target > this.level ? 26 : 11;
    this.level += (target - this.level) * Math.min(1, dt * speed);
    return this.level;
  }
}
