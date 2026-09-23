/**
 * Orchestrazione dell'input vocale.
 *
 * Tiene insieme tre cose che da sole non bastano: il microfono (`mic.js`), il
 * WebSocket verso il backend e lo stato del companion. La regola che le lega
 * e' una sola ma non e' ovvia: **mentre il companion parla il microfono non
 * ascolta**. Senza cuffie sentirebbe la propria voce, la scambierebbe per una
 * domanda e si risponderebbe da solo all'infinito.
 *
 * L'eccezione e' voluta: in `push` (premi e parla) l'utente sta deliberatamente
 * tenendo premuto, quindi lo lasciamo interrompere — e' il modo naturale per
 * dire "basta, ascoltami".
 */

import { VoiceInput, matchesWakeWord, toBase64 } from './mic.js';

/** I modi disponibili, nell'ordine in cui compaiono nel pannello. */
export const MODES = ['push', 'vad', 'wake'];

export class VoiceController {
  /**
   * @param {object} deps
   * @param {import('./ws.js').CompanionSocket} deps.socket
   * @param {(event: {type: string, [k: string]: any}) => void} [deps.onEvent]
   */
  constructor({ socket, onEvent = () => {} }) {
    this.socket = socket;
    this.onEvent = onEvent;

    this.mode = 'push';
    this.wakeWord = 'companion';
    this.enabled = false;
    this.interruptOnSpeech = true;
    /** Il companion sta parlando in questo momento. */
    this.speaking = false;

    this.mic = new VoiceInput({
      onUtterance: (pcm16, seconds) => this._onUtterance(pcm16, seconds),
      onLevel: (level) => this.onEvent({ type: 'level', level }),
      onActivity: (speaking) => this._onActivity(speaking),
      onError: (error) => this.onEvent({ type: 'error', message: error.message }),
    });
  }

  get listening() {
    return this.enabled && this.mic.active;
  }

  /** Accende l'ascolto. Va invocato da un gesto dell'utente (permesso microfono). */
  async enable({ mode = this.mode, wakeWord = this.wakeWord, threshold, silenceSeconds } = {}) {
    this.mode = mode;
    this.wakeWord = wakeWord;
    const ok = await this.mic.start({
      mode,
      threshold: threshold ?? 0.02,
      silenceSeconds: silenceSeconds ?? 0.8,
    });
    this.enabled = ok;
    this.onEvent({ type: 'enabled', enabled: ok, mode });
    return ok;
  }

  disable() {
    this.enabled = false;
    this.mic.stop();
    this.onEvent({ type: 'enabled', enabled: false, mode: this.mode });
  }

  async toggle(options = {}) {
    if (this.listening) {
      this.disable();
      return false;
    }
    return this.enable(options);
  }

  setMode(mode) {
    if (!MODES.includes(mode)) return;
    this.mode = mode;
    this.mic.setMode(mode);
    this.onEvent({ type: 'mode', mode });
  }

  setWakeWord(word) {
    this.wakeWord = word;
  }

  /**
   * Lo stato del companion cambia: qui decidiamo se il microfono deve tacere.
   * @param {'idle'|'thinking'|'speaking'} value
   */
  setCompanionState(value) {
    this.speaking = value === 'speaking';
    // In `push` comanda l'utente: non silenziamo mai il suo pulsante.
    const shouldMute = this.speaking && this.mode !== 'push';
    this.mic.setMuted(shouldMute);
  }

  /** Premuto il tasto del push-to-talk. */
  pushStart() {
    if (!this.listening || this.mode !== 'push') return;
    // Parlare sopra al companion significa volerlo interrompere.
    if (this.speaking && this.interruptOnSpeech) this.socket.cancel();
    this.mic.beginPush();
  }

  /** Rilasciato il tasto del push-to-talk. */
  pushEnd() {
    if (this.mode !== 'push') return;
    this.mic.endPush();
  }

  // ------------------------------------------------------------------
  _onActivity(speaking) {
    this.onEvent({ type: 'activity', speaking });
    // In ascolto continuo, chi parla sopra al companion lo interrompe.
    if (speaking && this.speaking && this.interruptOnSpeech && this.mode !== 'push') {
      this.socket.cancel();
    }
  }

  _onUtterance(pcm16, seconds) {
    const audio = toBase64(pcm16);
    this.onEvent({ type: 'utterance', seconds });

    if (this.mode !== 'wake') {
      this.socket.voice(audio, true);
      return;
    }

    // Nel modo a chiamata non sappiamo se la frase e' per noi finche' non e'
    // trascritta: la mandiamo senza farla rispondere e decidiamo dopo, in
    // `handleTranscript`.
    this._pendingWake = true;
    this.socket.voice(audio, false);
  }

  /**
   * Da agganciare al messaggio `transcript` del backend.
   * Nel modo a chiamata e' qui che si decide se la frase era rivolta a noi.
   * @returns {boolean} true se la frase e' stata inoltrata come domanda
   */
  handleTranscript(text) {
    if (this.mode !== 'wake' || !this._pendingWake) return false;
    this._pendingWake = false;

    const stripped = matchesWakeWord(text ?? '', this.wakeWord);
    if (stripped === null) {
      this.onEvent({ type: 'ignored', text });
      return false;
    }
    if (!stripped.trim()) {
      // Ha detto solo il nome: rispondiamo come a una chiamata.
      this.onEvent({ type: 'summoned' });
      this.socket.chat('?');
      return true;
    }
    this.socket.chat(stripped);
    return true;
  }
}
