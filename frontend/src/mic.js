/**
 * Microphone capture and speech detection.
 *
 * It produces 16 kHz mono PCM directly, which is what Whisper wants and what
 * the backend can read without any audio decoder. We don't resample by
 * hand: asking for `new AudioContext({ sampleRate: 16000 })` is enough and
 * the browser takes care of it.
 *
 * Three ways of talking, as requested:
 *
 * - `push`  push to talk: records while you hold the key;
 * - `vad`   always listening: detects the start and end of a sentence by itself;
 * - `wake`  wake word: like `vad`, but the sentence counts only if it starts
 *           with the wake word (the filter is on the transcribed text, see
 *           `matchesWakeWord`).
 *
 * # Why we don't listen while the companion speaks
 *
 * Without headphones the microphone hears the synthesized voice again, the
 * detector takes it for the user's speech and the companion ends up
 * answering itself in an endless loop. That's why `setMuted(true)` is called
 * while it's speaking: the same trick Open-LLM-VTuber uses.
 */

import { t } from './i18n.js';

/** Sample rate asked of the browser: the speech-recognition models' native one. */
export const SAMPLE_RATE = 16000;

/** Key (localStorage shared by the character and the panel) of the chosen microphone; empty = default. */
export const MIC_SETTING = 'dc:mic-device';

/**
 * Opens the given microphone, or the system default. If the chosen one is
 * gone (headphones unplugged) it falls back to the default instead of
 * staying mute.
 */
export async function openMicrophone(deviceId = '') {
  const audio = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { ...audio, deviceId: { exact: deviceId } } });
    } catch (error) {
      if (error.name !== 'OverconstrainedError' && error.name !== 'NotFoundError') throw error;
      console.warn('[mic] chosen microphone not found, using the default');
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio });
}

/**
 * The connected microphones, `[{id, label}]`. The browser reveals the names
 * only after permission: if they're missing, it opens and closes the
 * microphone once.
 */
export async function listMicrophones() {
  let inputs = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput');
  if (inputs.length && !inputs[0].label) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    inputs = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput');
  }
  // "default" and "communications" are Windows aliases of a real microphone: the "default" entry covers them.
  return inputs
    .filter((device) => device.deviceId && device.deviceId !== 'default' && device.deviceId !== 'communications')
    .map((device, index) => ({ id: device.deviceId, label: device.label || t('Microphone {n}', { n: index + 1 }) }));
}

/** Size of the analysis buffer: ~64 ms at 16 kHz, responsive enough. */
const FRAME = 1024;

/** Below this length it's a cough or a click, not a sentence. */
const MIN_UTTERANCE = 0.35;

/** Beyond this length we close anyway, so as not to pile up audio forever. */
const MAX_UTTERANCE = 30;

/** How much audio we keep *before* the onset, so as not to cut the first syllable. */
const PREROLL = 0.3;

/**
 * Guarded listening (she's speaking): the threshold is multiplied by this
 * factor and the loud voice must fill almost all of the last half second
 * (`BARGE_FRAMES` frames out of `BARGE_WINDOW`). The browser's echo
 * cancellation removes almost all of her voice from the microphone; what's
 * left is weak and bursty, a person talking isn't.
 */
const GUARD_FACTOR = 2.5;
const BARGE_WINDOW = 8;
const BARGE_FRAMES = 6;
/** In guarded listening the preroll is longer: the sentence has already started. */
const GUARD_PREROLL = 0.8;

export class VoiceInput {
  /**
   * @param {object} options
   * @param {(pcm16: ArrayBuffer, seconds: number) => void} options.onUtterance a complete sentence
   * @param {(level: number) => void} [options.onLevel] level 0-1, for the meter
   * @param {(speaking: boolean) => void} [options.onActivity] speech start/end
   * @param {(error: Error) => void} [options.onError]
   */
  constructor(options = {}) {
    this.onUtterance = options.onUtterance ?? (() => {});
    this.onLevel = options.onLevel ?? (() => {});
    this.onActivity = options.onActivity ?? (() => {});
    this.onError = options.onError ?? ((error) => console.error('[mic]', error));
    /** Someone talked over her long enough: she must be interrupted. */
    this.onBargeIn = options.onBargeIn ?? (() => {});

    this.mode = 'push';
    this.threshold = 0.02;
    this.silenceSeconds = 0.8;

    this.stream = null;
    this.context = null;
    this.source = null;
    this.processor = null;

    this.running = false;
    /** Opening in progress (one at a time) and how many times it was closed. */
    this._starting = null;
    this._generation = 0;
    this.muted = false;
    /** She's speaking: we only listen to whoever really interrupts her. */
    this.guarded = false;
    this.guardWindow = [];
    this.capturing = false; // collecting a sentence
    this.buffers = [];
    this.preroll = [];
    this.silentFrames = 0;
    this.capturedFrames = 0;
  }

  get active() {
    return this.running;
  }

  /** Opens the microphone. The first time it must be called from a user gesture. */
  async start({ mode = 'push', threshold = 0.02, silenceSeconds = 0.8, deviceId = '' } = {}) {
    this.mode = mode;
    this.threshold = threshold;
    this.silenceSeconds = silenceSeconds;
    if (this.running) return true;
    // Two presses close together opened two streams: the first stayed on (with
    // the microphone indicator) and nobody closed it any more.
    this._starting ??= this._open(deviceId).finally(() => {
      this._starting = null;
    });
    return this._starting;
  }

  async _open(deviceId) {
    const generation = this._generation;
    let stream;
    try {
      stream = await openMicrophone(deviceId);
    } catch (error) {
      this.onError(new Error(t('Microphone unavailable: {error}', { error: error.message })));
      return false;
    }
    if (generation !== this._generation) {
      // stop() arrived while Windows was opening the microphone.
      stream.getTracks().forEach((track) => track.stop());
      return false;
    }
    this.stream = stream;

    try {
      // Asking for 16 kHz directly avoids resampling by hand.
      this.context = new AudioContext({ sampleRate: SAMPLE_RATE });
      if (this.context.state === 'suspended') await this.context.resume();
    } catch (error) {
      this.stop();
      this.onError(new Error(t('Microphone unavailable: {error}', { error: error.message })));
      return false;
    }
    if (generation !== this._generation) return false; // closed during resume()

    this.source = this.context.createMediaStreamSource(this.stream);
    // ScriptProcessor is deprecated but here it's the right choice: the
    // per-frame work is trivial (a mean and a copy) and doesn't need a separate
    // AudioWorklet module, which complicates bundling in Electron.
    this.processor = this.context.createScriptProcessor(FRAME, 1, 1);
    this.processor.onaudioprocess = (event) => this._onFrame(event.inputBuffer.getChannelData(0));

    this.source.connect(this.processor);
    // The ScriptProcessor doesn't run unless it's connected to an output; a
    // zero gain keeps it alive without playing the microphone on the speakers.
    const silence = this.context.createGain();
    silence.gain.value = 0;
    this.processor.connect(silence);
    silence.connect(this.context.destination);

    this.running = true;
    return true;
  }

  /** Closes the microphone and turns off the system's recording indicator. */
  stop() {
    this._generation += 1;
    this.running = false;
    this.capturing = false;
    this.buffers = [];
    this.preroll = [];
    this.processor?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.context?.close().catch(() => {});
    this.processor = this.source = this.stream = this.context = null;
  }

  /** Changes mode without reopening the microphone. */
  setMode(mode) {
    if (mode === this.mode) return;
    if (this.capturing) this._flush();
    this.mode = mode;
  }

  /**
   * Pauses listening without closing the microphone.
   * Used while the companion speaks, so it doesn't hear its own voice.
   */
  setMuted(muted) {
    if (muted && this.capturing && this.mode !== 'push') {
      // What was coming in is almost certainly her own voice.
      this._discard();
    }
    this.muted = muted;
  }

  /**
   * Guarded listening while she speaks (`vad` and `wake` modes): no sentences
   * until someone talks loudly and long, then `onBargeIn` and the sentence is
   * recorded from the start.
   */
  setGuarded(guarded) {
    if (guarded === this.guarded) return;
    this.guarded = guarded;
    this.guardWindow = [];
    // A sentence started while she was speaking and not yet confirmed doesn't count.
    if (guarded && this.capturing && this.mode !== 'push') this._discard();
  }

  /** `push` mode: I start talking. */
  beginPush() {
    if (!this.running || this.mode !== 'push') return;
    this._reset();
    this.capturing = true;
    this.onActivity(true);
  }

  /** `push` mode: I'm done, send what I said. */
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

    const frame = new Float32Array(input); // the buffer is reused: it must be copied
    const seconds = input.length / SAMPLE_RATE;

    if (this.mode === 'push') {
      if (this.capturing) {
        this.buffers.push(frame);
        this.capturedFrames += input.length;
      }
      return;
    }

    // Automatic modes: the energy decides the start and end of the sentence.
    if (this.guarded && !this.capturing) {
      this.preroll.push(frame);
      const maxGuard = Math.ceil((GUARD_PREROLL * SAMPLE_RATE) / FRAME);
      if (this.preroll.length > maxGuard) this.preroll.shift();
      this.guardWindow.push(level >= this.threshold * GUARD_FACTOR);
      if (this.guardWindow.length > BARGE_WINDOW) this.guardWindow.shift();
      if (this.guardWindow.filter(Boolean).length >= BARGE_FRAMES) {
        // Someone is talking over her: the sentence starts from the preroll.
        this.guarded = false;
        this.guardWindow = [];
        this.capturing = true;
        this.buffers = this.preroll.splice(0);
        this.capturedFrames = this.buffers.length * FRAME;
        this.silentFrames = 0;
        this.onBargeIn();
        this.onActivity(true);
      }
      return;
    }

    const loud = level >= this.threshold;

    if (!this.capturing) {
      // We keep a bit of earlier audio, or the onset of the first word gets lost.
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

/** Float32 -1..1 -> 16-bit little-endian PCM, the format the backend expects. */
export function floatToPcm16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out.buffer;
}

/** ArrayBuffer -> base64, in chunks so long audio doesn't blow the stack. */
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
 * In `wake` mode the sentence counts only if it starts with the wake word.
 * Returns the text without the word, or null if it isn't there.
 */
export function matchesWakeWord(text, wakeWord) {
  if (!wakeWord) return text;

  // We compare word by word instead of character by character: normalization
  // changes the text's length (it removes punctuation and accents), so any
  // index arithmetic on the original text would be wrong.
  const normalise = (value) =>
    value
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // strip the accents: "però" -> "pero"
      .replace(/[^\p{L}\p{N}]/gu, '');

  const needle = wakeWord.trim().split(/\s+/).map(normalise).filter(Boolean);
  if (!needle.length) return text;

  const words = text.trim().split(/\s+/);
  if (words.length < needle.length) return null;

  // It must be at the start, so it doesn't trigger when the word is mentioned
  // in the middle of a conversation with someone else.
  const head = words.slice(0, needle.length).map(normalise);
  if (head.some((word, i) => word !== needle[i])) return null;

  return words.slice(needle.length).join(' ').trim();
}
