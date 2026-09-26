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
 *
 * Con "interrompila parlando" acceso (`bargeIn`) anche in ascolto continuo e a
 * chiamata il microfono resta aperto mentre lei parla, ma sorvegliato: serve
 * una voce forte e sostenuta (mic.js, `setGuarded`), e il backend scarta le
 * trascrizioni che sono la sua stessa voce (pipeline, `is_echo`).
 */

import { readSetting } from './dom.js';
import { MIC_SETTING, VoiceInput, matchesWakeWord, toBase64 } from './mic.js';

/** Chiave dell'impostazione "interrompila parlando" (vale per `vad` e `wake`). */
export const BARGE_IN_SETTING = 'dc:barge-in';

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
    /** In ascolto continuo o a chiamata la si puo' interrompere parlando. */
    this.bargeIn = readSetting(BARGE_IN_SETTING, true);
    /** Il companion sta parlando in questo momento. */
    this.speaking = false;
    /** Il pannello sta provando il microfono: quello che senti non e' per lei. */
    this.paused = false;
    this.deviceId = readSetting(MIC_SETTING, '');
    this._options = {};

    this.mic = new VoiceInput({
      onUtterance: (pcm16, seconds) => this._onUtterance(pcm16, seconds),
      onLevel: (level) => this.onEvent({ type: 'level', level }),
      onActivity: (speaking) => this._onActivity(speaking),
      onBargeIn: () => this._onBargeIn(),
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
    this._options = { threshold, silenceSeconds };
    const ok = await this.mic.start({
      mode,
      threshold: threshold ?? 0.02,
      silenceSeconds: silenceSeconds ?? 0.8,
      deviceId: this.deviceId,
    });
    this.enabled = ok;
    this._applyMute();
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

  /** Cambia microfono; se sta gia' ascoltando lo riapre sul nuovo. */
  async setDevice(deviceId) {
    this.deviceId = deviceId || '';
    if (!this.listening) return;
    this.mic.stop();
    await this.enable({ mode: this.mode, wakeWord: this.wakeWord, ...this._options });
  }

  /** Sospende l'ascolto mentre il pannello prova il microfono. */
  setPaused(paused) {
    this.paused = Boolean(paused);
    this._applyMute();
  }

  /**
   * Lo stato del companion cambia: qui decidiamo se il microfono deve tacere.
   * @param {'idle'|'thinking'|'speaking'} value
   */
  setCompanionState(value) {
    this.speaking = value === 'speaking';
    this._applyMute();
  }

  /** Accende o spegne "interrompila parlando". */
  setBargeIn(enabled) {
    this.bargeIn = Boolean(enabled);
    this._applyMute();
  }

  _applyMute() {
    // In `push` comanda l'utente: non silenziamo mai il suo pulsante.
    const handsFree = this.speaking && this.mode !== 'push';
    this.mic.setGuarded(handsFree && this.bargeIn && !this.paused);
    this.mic.setMuted(this.paused || (handsFree && !this.bargeIn));
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
  }

  /** Qualcuno ha parlato sopra di lei (ascolto sorvegliato): si ferma e ascolta. */
  _onBargeIn() {
    if (!this.interruptOnSpeech) return;
    this.socket.cancel();
    this.onEvent({ type: 'barge-in' });
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
  handleTranscript(text, echo = false) {
    if (this.mode !== 'wake' || !this._pendingWake) return false;
    if (echo) {
      this._pendingWake = false;
      return false;
    }
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
