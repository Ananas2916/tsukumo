/**
 * Orchestration of voice input.
 *
 * It ties together three things that aren't enough on their own: the
 * microphone (`mic.js`), the WebSocket to the backend and the companion's
 * state. The rule that binds them is a single one but not obvious: **while
 * the companion speaks the microphone doesn't listen**. Without headphones
 * it would hear its own voice, take it for a question and answer itself
 * forever.
 *
 * The exception is deliberate: in `push` (push to talk) the user is holding
 * the key on purpose, so we let them interrupt — it's the natural way to
 * say "stop, listen to me".
 *
 * With "interrupt her by talking" on (`bargeIn`), in continuous and wake-word
 * listening too the microphone stays open while she speaks, but guarded: it
 * takes a loud, sustained voice (mic.js, `setGuarded`), and the backend
 * drops transcriptions that are her own voice (pipeline, `is_echo`).
 */

import { readSetting } from './dom.js';
import { MIC_SETTING, VoiceInput, matchesWakeWord, toBase64 } from './mic.js';

/** Key of the "interrupt her by talking" setting (applies to `vad` and `wake`). */
export const BARGE_IN_SETTING = 'dc:barge-in';

/** The available modes, in the order they appear in the panel. */
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
    /** In continuous or wake-word listening she can be interrupted by talking. */
    this.bargeIn = readSetting(BARGE_IN_SETTING, true);
    /** The companion is speaking right now. */
    this.speaking = false;
    /** The panel is testing the microphone: what you hear isn't for her. */
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

  /** Turns listening on. Must be called from a user gesture (microphone permission). */
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

  /** Changes microphone; if already listening, reopens it on the new one. */
  async setDevice(deviceId) {
    this.deviceId = deviceId || '';
    if (!this.listening) return;
    this.mic.stop();
    await this.enable({ mode: this.mode, wakeWord: this.wakeWord, ...this._options });
  }

  /** Pauses listening while the panel tests the microphone. */
  setPaused(paused) {
    this.paused = Boolean(paused);
    this._applyMute();
  }

  /**
   * The companion's state changes: here we decide whether the microphone must be quiet.
   * @param {'idle'|'thinking'|'speaking'} value
   */
  setCompanionState(value) {
    this.speaking = value === 'speaking';
    this._applyMute();
  }

  /** Turns "interrupt her by talking" on or off. */
  setBargeIn(enabled) {
    this.bargeIn = Boolean(enabled);
    this._applyMute();
  }

  _applyMute() {
    // In `push` the user is in charge: we never mute their button.
    const handsFree = this.speaking && this.mode !== 'push';
    this.mic.setGuarded(handsFree && this.bargeIn && !this.paused);
    this.mic.setMuted(this.paused || (handsFree && !this.bargeIn));
  }

  /** Push-to-talk key pressed. */
  pushStart() {
    if (!this.listening || this.mode !== 'push') return;
    // Talking over the companion means wanting to interrupt it.
    if (this.speaking && this.interruptOnSpeech) this.socket.cancel();
    this.mic.beginPush();
  }

  /** Push-to-talk key released. */
  pushEnd() {
    if (this.mode !== 'push') return;
    this.mic.endPush();
  }

  // ------------------------------------------------------------------
  _onActivity(speaking) {
    this.onEvent({ type: 'activity', speaking });
  }

  /** Someone talked over her (guarded listening): she stops and listens. */
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

    // In wake-word mode we don't know whether the sentence is for us until it's
    // transcribed: we send it without a reply and decide later, in
    // `handleTranscript`.
    this._pendingWake = true;
    this.socket.voice(audio, false);
  }

  /**
   * To be hooked to the backend's `transcript` message.
   * In wake-word mode this is where we decide whether the sentence was for us.
   * @returns {boolean} true if the sentence was forwarded as a question
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
      // Only her name was said: we answer as to a call.
      this.onEvent({ type: 'summoned' });
      this.socket.chat('?');
      return true;
    }
    this.socket.chat(stripped);
    return true;
  }
}
