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
 *
 * While you talk she also reads along: the sentence so far goes to the
 * backend now and then (`voice_partial`) and the words come back as
 * `partial` events. Only engines fast enough to redo the whole sentence in a
 * fraction of a second say yes (Parakeet); the others answer `live: false`
 * and we stop asking until the next sentence. One request at a time, so a
 * slow PC never piles them up, and never in wake-word mode: there we don't
 * know yet whether the sentence is for her.
 */

import { readSetting } from './dom.js';
import { MIC_SETTING, VoiceInput, matchesWakeWord, toBase64 } from './mic.js';

/** Key of the "interrupt her by talking" setting (applies to `vad` and `wake`). */
export const BARGE_IN_SETTING = 'dc:barge-in';

/** The available modes, in the order they appear in the panel. */
export const MODES = ['push', 'vad', 'wake'];

/**
 * Push to talk closes the microphone this long after a sentence ends: kept
 * open, Windows showed it in use forever. A second is enough for a quick
 * follow-up without reopening it.
 */
const PUSH_CLOSE_AFTER_MS = 1000;

/** Live transcription: how often to ask, from how much audio, and up to how much. */
const PARTIAL_EVERY = 0.7;
const PARTIAL_FROM = 0.6;
const PARTIAL_UNTIL = 15;

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
    /** The sentence being captured (its number), and the live transcription's state for it. */
    this._sentence = 0;
    this._partial = { busy: false, askedAt: 0, off: false };

    this.mic = new VoiceInput({
      onUtterance: (pcm16, seconds) => this._onUtterance(pcm16, seconds),
      onLevel: (level) => {
        this.onEvent({ type: 'level', level });
        this._askPartial();
      },
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

  /** Push-to-talk key pressed; `autoEnd` when there's no key to release (a click). */
  pushStart({ autoEnd = false } = {}) {
    if (!this.listening || this.mode !== 'push') return;
    clearTimeout(this._closeTimer);
    // Talking over the companion means wanting to interrupt it.
    if (this.speaking && this.interruptOnSpeech) this.socket.cancel();
    this.mic.beginPush({ autoEnd });
  }

  /** Push-to-talk key released. */
  pushEnd() {
    if (this.mode !== 'push') return;
    this.mic.endPush();
  }

  /** The push-to-talk key turned out to be part of a shortcut: drop what was heard. */
  pushCancel() {
    if (this.mode !== 'push') return;
    this.mic.cancelPush();
  }

  /**
   * To be hooked to the backend's `transcript_partial` message.
   * Late answers (the sentence is over, or it's another one) are dropped.
   */
  handlePartial(message) {
    if (message.sentence !== this._sentence) return;
    this._partial.busy = false;
    if (message.live === false) {
      this._partial.off = true;
      return;
    }
    const text = (message.text ?? '').trim();
    if (text && this.mic.capturing) this.onEvent({ type: 'partial', text });
  }

  _askPartial() {
    const partial = this._partial;
    // Offline it would be queued and arrive stale: better nothing.
    if (partial.busy || partial.off || this.mode === 'wake' || this.mic.muted || !this.socket.connected) return;
    const seconds = this.mic.capturedSeconds;
    if (seconds < PARTIAL_FROM || seconds > PARTIAL_UNTIL) return;
    const now = performance.now() / 1000;
    if (now - partial.askedAt < PARTIAL_EVERY) return;
    const pcm16 = this.mic.snapshot();
    if (!pcm16) return;
    partial.busy = true;
    partial.askedAt = now;
    this.socket.send({ type: 'voice_partial', audio: toBase64(pcm16), sentence: this._sentence });
  }

  // ------------------------------------------------------------------
  _onActivity(speaking) {
    if (speaking) {
      // A new sentence: earlier answers no longer count, and we ask again even
      // if the previous engine said no (it may have been changed from the panel).
      this._sentence += 1;
      this._partial = { busy: false, askedAt: performance.now() / 1000, off: false };
    } else {
      this.closeSoon();
    }
    this.onEvent({ type: 'activity', speaking });
  }

  /** Push to talk: the microphone closes in a moment, unless a new sentence starts. */
  closeSoon() {
    if (this.mode !== 'push') return;
    clearTimeout(this._closeTimer);
    this._closeTimer = setTimeout(() => {
      if (this.mode === 'push' && !this.mic.capturing && this.listening) this.disable();
    }, PUSH_CLOSE_AFTER_MS);
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
