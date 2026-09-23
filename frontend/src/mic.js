/**
 * Cattura dal microfono e rilevamento del parlato.
 *
 * Produce direttamente PCM a 16 kHz mono, che e' quello che Whisper vuole e
 * che il backend sa leggere senza alcun decoder audio. Il ricampionamento non
 * lo facciamo a mano: basta chiedere `new AudioContext({ sampleRate: 16000 })`
 * e ci pensa il browser.
 *
 * Tre modi di parlare, come chiesto:
 *
 * - `push`  premi e parla: registra finche' tieni premuto;
 * - `vad`   sempre in ascolto: riconosce da solo inizio e fine della frase;
 * - `wake`  a chiamata: come `vad`, ma la frase vale solo se comincia con la
 *           parola di attivazione (il filtro sta nel testo trascritto, vedi
 *           `matchesWakeWord`).
 *
 * # Perche' non ascoltiamo mentre il companion parla
 *
 * Senza cuffie il microfono risente la voce sintetizzata, il rilevatore la
 * scambia per parlato dell'utente e il companion finisce per rispondere a se
 * stesso in un ciclo infinito. Per questo `setMuted(true)` viene chiamato
 * mentre sta parlando: e' lo stesso accorgimento che usa Open-LLM-VTuber.
 */

/** Frequenza richiesta al browser: quella nativa dei modelli di riconoscimento. */
export const SAMPLE_RATE = 16000;

/** Dimensione del buffer di analisi: ~64 ms a 16 kHz, abbastanza reattivo. */
const FRAME = 1024;

/** Sotto questa durata e' un colpo di tosse o un click, non una frase. */
const MIN_UTTERANCE = 0.35;

/** Oltre questa durata chiudiamo comunque, per non accumulare audio all'infinito. */
const MAX_UTTERANCE = 30;

/** Quanto audio teniamo *prima* dell'attacco, per non tagliare la prima sillaba. */
const PREROLL = 0.3;

export class VoiceInput {
  /**
   * @param {object} options
   * @param {(pcm16: ArrayBuffer, seconds: number) => void} options.onUtterance frase completa
   * @param {(level: number) => void} [options.onLevel] livello 0-1, per l'indicatore
   * @param {(speaking: boolean) => void} [options.onActivity] inizio/fine parlato
   * @param {(error: Error) => void} [options.onError]
   */
  constructor(options = {}) {
    this.onUtterance = options.onUtterance ?? (() => {});
    this.onLevel = options.onLevel ?? (() => {});
    this.onActivity = options.onActivity ?? (() => {});
    this.onError = options.onError ?? ((error) => console.error('[mic]', error));

    this.mode = 'push';
    this.threshold = 0.02;
    this.silenceSeconds = 0.8;

    this.stream = null;
    this.context = null;
    this.source = null;
    this.processor = null;

    this.running = false;
    this.muted = false;
    this.capturing = false; // sta accumulando una frase
    this.buffers = [];
    this.preroll = [];
    this.silentFrames = 0;
    this.capturedFrames = 0;
  }

  get active() {
    return this.running;
  }

  /** Apre il microfono. Va chiamato da un gesto dell'utente la prima volta. */
  async start({ mode = 'push', threshold = 0.02, silenceSeconds = 0.8 } = {}) {
    this.mode = mode;
    this.threshold = threshold;
    this.silenceSeconds = silenceSeconds;
    if (this.running) return true;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      this.onError(new Error(`Microfono non disponibile: ${error.message}`));
      return false;
    }

    // Chiedere direttamente 16 kHz evita di ricampionare a mano.
    this.context = new AudioContext({ sampleRate: SAMPLE_RATE });
    if (this.context.state === 'suspended') await this.context.resume();

    this.source = this.context.createMediaStreamSource(this.stream);
    // ScriptProcessor e' deprecato ma qui e' la scelta giusta: il lavoro per
    // frame e' banale (una media e una copia) e non richiede di caricare un
    // modulo AudioWorklet separato, che in Electron complica il bundling.
    this.processor = this.context.createScriptProcessor(FRAME, 1, 1);
    this.processor.onaudioprocess = (event) => this._onFrame(event.inputBuffer.getChannelData(0));

    this.source.connect(this.processor);
    // Il ScriptProcessor non gira se non e' collegato a un'uscita; un guadagno
    // a zero lo tiene vivo senza far sentire il microfono in altoparlante.
    const silence = this.context.createGain();
    silence.gain.value = 0;
    this.processor.connect(silence);
    silence.connect(this.context.destination);

    this.running = true;
    return true;
  }

  /** Chiude il microfono e libera la spia di registrazione del sistema. */
  stop() {
    this.running = false;
    this.capturing = false;
    this.buffers = [];
    this.preroll = [];
    this.processor?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.context?.close();
    this.processor = this.source = this.stream = this.context = null;
  }

  /** Cambia modo senza riaprire il microfono. */
  setMode(mode) {
    if (mode === this.mode) return;
    if (this.capturing) this._flush();
    this.mode = mode;
  }

  /**
   * Sospende l'ascolto senza chiudere il microfono.
   * Usato mentre il companion parla, per non fargli sentire la propria voce.
   */
  setMuted(muted) {
    if (muted && this.capturing && this.mode !== 'push') {
      // Quello che stava arrivando e' quasi certamente la sua stessa voce.
      this._discard();
    }
    this.muted = muted;
  }

  /** Modo `push`: inizio a parlare. */
  beginPush() {
    if (!this.running || this.mode !== 'push') return;
    this._reset();
    this.capturing = true;
    this.onActivity(true);
  }

  /** Modo `push`: ho finito, manda quello che ho detto. */
  endPush() {
    if (this.mode !== 'push' || !this.capturing) return;
    this._flush();
  }

  // ------------------------------------------------------------------
  _onFrame(input) {
    if (!this.running) return;

    let sum = 0;
    for (let i = 0; i < input.length; i += 1) sum += input[i] * input[i];
    const level = Math.sqrt(sum / input.length);
    this.onLevel(level);

    if (this.muted) return;

    const frame = new Float32Array(input); // il buffer viene riusato: va copiato
    const seconds = input.length / SAMPLE_RATE;

    if (this.mode === 'push') {
      if (this.capturing) {
        this.buffers.push(frame);
        this.capturedFrames += input.length;
      }
      return;
    }

    // Modi automatici: l'energia decide inizio e fine della frase.
    const loud = level >= this.threshold;

    if (!this.capturing) {
      // Teniamo un po' di audio precedente, o si perde l'attacco della prima parola.
      this.preroll.push(frame);
      const maxPreroll = Math.ceil((PREROLL * SAMPLE_RATE) / FRAME);
      if (this.preroll.length > maxPreroll) this.preroll.shift();

      if (loud) {
        this.capturing = true;
        this.buffers = this.preroll.splice(0);
        this.capturedFrames = this.buffers.length * FRAME;
        this.silentFrames = 0;
        this.onActivity(true);
      }
      return;
    }

    this.buffers.push(frame);
    this.capturedFrames += input.length;
    this.silentFrames = loud ? 0 : this.silentFrames + seconds;

    const tooLong = this.capturedFrames / SAMPLE_RATE >= MAX_UTTERANCE;
    if (this.silentFrames >= this.silenceSeconds || tooLong) this._flush();
  }

  _reset() {
    this.buffers = [];
    this.preroll = [];
    this.silentFrames = 0;
    this.capturedFrames = 0;
  }

  _discard() {
    this.capturing = false;
    this._reset();
    this.onActivity(false);
  }

  _flush() {
    const frames = this.buffers;
    const total = this.capturedFrames;
    this.capturing = false;
    this._reset();
    this.onActivity(false);

    const seconds = total / SAMPLE_RATE;
    if (seconds < MIN_UTTERANCE) return;

    const merged = new Float32Array(total);
    let offset = 0;
    for (const frame of frames) {
      merged.set(frame, offset);
      offset += frame.length;
    }
    this.onUtterance(floatToPcm16(merged), seconds);
  }
}

/** Float32 -1..1 -> PCM 16 bit little-endian, il formato atteso dal backend. */
export function floatToPcm16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out.buffer;
}

/** ArrayBuffer -> base64, a blocchi per non sfondare lo stack con audio lungo. */
export function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Nel modo `wake`, la frase vale solo se comincia con la parola di attivazione.
 * Restituisce il testo ripulito dalla parola, oppure null se non c'e'.
 */
export function matchesWakeWord(text, wakeWord) {
  if (!wakeWord) return text;

  // Confrontiamo parola per parola invece che carattere per carattere: la
  // normalizzazione cambia la lunghezza del testo (toglie punteggiatura e
  // accenti), quindi qualunque conto sugli indici del testo originale
  // sarebbe sbagliato.
  const normalise = (value) =>
    value
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // via gli accenti: "però" -> "pero"
      .replace(/[^\p{L}\p{N}]/gu, '');

  const needle = wakeWord.trim().split(/\s+/).map(normalise).filter(Boolean);
  if (!needle.length) return text;

  const words = text.trim().split(/\s+/);
  if (words.length < needle.length) return null;

  // Deve stare all'inizio, cosi' non si attiva quando la parola viene
  // nominata a meta' di un discorso rivolto a qualcun altro.
  const head = words.slice(0, needle.length).map(normalise);
  if (head.some((word, i) => word !== needle[i])) return null;

  return words.slice(needle.length).join(' ').trim();
}
