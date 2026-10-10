/**
 * Playback of the audio received from the backend.
 *
 * The backend sends one sentence at a time (`speech`), so here we keep a
 * queue: while the first sentence plays the next ones are decoded and
 * queued, so the speech sounds continuous.
 *
 * Besides playing, the class measures the instantaneous RMS level with an
 * AnalyserNode: that's what keeps the lip-sync locked to the real volume even
 * if the viseme timeline drifts by a few milliseconds.
 */

/** Converts the base64 WAV received over the WebSocket into an ArrayBuffer. */
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
    this.level = 0; // smoothed RMS, 0..1
    this.volume = 1;
    /** Incremented at every stop(): invalidates the decodes in flight. */
    this.generation = 0;
  }

  /** Creates (once) the WebAudio graph: source -> gain -> analyser -> out. */
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

  /** Browsers block audio until there's a user gesture. */
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
   * Decodes and queues a `speech` message from the backend.
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
      console.error('[audio] WAV cannot be decoded', error);
      return;
    }

    // If a stop() arrived in the meantime, we drop the result.
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
      // Without a user gesture we can't play: retry as soon as it unlocks.
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

  /** Seconds since the start of the current clip. */
  get currentTime() {
    if (!this.playing || !this.context || !this.clip) return 0;
    const elapsed = this.context.currentTime - this.startedAt;
    const duration = this.clip.duration || Infinity;
    return Math.max(0, Math.min(elapsed, duration));
  }

  /** Empties the queue and stops playback immediately. */
  stop() {
    this.generation += 1;
    this.queue.length = 0;
    if (this.source) {
      try {
        this.source.onended = null;
        this.source.stop();
      } catch {
        /* the source may have already finished */
      }
    }
    this.source = null;
    this.clip = null;
    this.playing = false;
    this.level = 0;
    this.onIdle();
  }

  /**
   * Updates the RMS level. Call it once per frame from the render loop.
   * @param {number} dt seconds since the last frame
   */
  update(dt) {
    if (!this.analyser || !this.playing) {
      // Gentle release when there's no audio: avoids jaw jerks.
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

    // Empirical normalization: Kokoro's speech sits around 0.06-0.25 RMS.
    const target = Math.min(1, rms * 4.2);
    // Fast attack, slower release: the mouth opens at once and closes softly.
    const speed = target > this.level ? 26 : 11;
    this.level += (target - this.level) * Math.min(1, dt * speed);
    return this.level;
  }
}
