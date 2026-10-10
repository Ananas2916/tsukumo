/**
 * The rhythm of the music you're listening to.
 *
 * Spotify no longer exposes BPM and "energy" to new apps, so we derive the
 * rhythm from the real audio: Electron captures the system audio (loopback,
 * what comes out of the speakers) and here we analyse it in real time.
 *
 *  - onsets: spectral flux (how much the energy grows band by band from one
 *    frame to the next), with the bass weighted more because the kick carries
 *    the beat;
 *  - tempo: autocorrelation of the last seconds of (smoothed) onsets,
 *    between 70 and 180 BPM, summed over multiples of the period (a real beat
 *    repeats at 2, 3, 4 periods too; an offbeat doesn't), with a soft
 *    preference for "danceable" tempos around 120;
 *  - phase: an oscillator at the estimated tempo, realigned every half second
 *    by looking for the offset of the beat "comb" that collects the most
 *    onsets in the last seconds (the kick wins, weighted more);
 *  - energy: relative volume, normalized on an adaptive peak, so it doesn't
 *    depend on how loud the PC's volume is.
 *
 * `BeatTracker` is the pure computation (also tested in Node with synthetic
 * signals), `MusicListener` adds the audio capture.
 */

const RATE = 50; // samples per second of the onset envelope
const HISTORY = RATE * 8;
const MIN_BPM = 70;
const MAX_BPM = 180;
const TEMPO_EVERY = 0.5; // s
const SILENCE = 0.004; // RMS below which it's silence (pause, end of track)

/** Envelope smoothing: an onset also counts one sample before and after. */
const KERNEL = [0.25, 0.6, 1, 0.6, 0.25];
/** Weights of the period's multiples in the tempo score. */
const HARMONICS = [1, 0.5, 0.33, 0.25];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const damp = (current, target, rate, dt) => current + (target - current) * (1 - Math.exp(-rate * dt));
const wrap = (value) => value - Math.round(value);

export class BeatTracker {
  constructor() {
    this.envelope = new Float32Array(HISTORY);
    this.raw = new Float32Array(HISTORY);
    this.work = new Float32Array(HISTORY);
    this.reset();
  }

  reset() {
    this.envelope.fill(0);
    this.head = 0;
    this.filled = 0;
    this.previous = null;
    this.pendingFlux = 0;
    this.accumulator = 0;
    this.tempoTimer = 0;
    this.locked = false;
    this.candidate = 0;
    this.candidateVotes = 0;
    this.bpm = 0;
    this.phase = 0;
    this.confidence = 0;
    this.energy = 0;
    this.peak = 0.05;
    this.quietFor = 0;
  }

  /**
   * One analysis frame.
   * @param {number} dt seconds since the last frame
   * @param {number} rms the frame's volume
   * @param {Float32Array} spectrumDb spectrum in dB (like AnalyserNode.getFloatFrequencyData)
   * @param {number} binHz width of a bin in Hz
   */
  process(dt, rms, spectrumDb, binHz) {
    if (dt <= 0) return;

    // --- energy -----------------------------------------------------------
    this.peak = Math.max(rms, this.peak * Math.exp(-dt / 6));
    const loud = rms > SILENCE;
    this.quietFor = loud ? 0 : this.quietFor + dt;
    this.energy = damp(this.energy, loud ? clamp(rms / Math.max(this.peak, 0.02), 0, 1) : 0, 6, dt);

    // --- onsets: log-compressed spectral flux, bass weighted more ---------
    const bins = Math.min(spectrumDb.length, Math.ceil(4000 / binHz));
    const bass = Math.ceil(160 / binHz);
    if (!this.previous || this.previous.length !== bins) this.previous = new Float32Array(bins);
    let flux = 0;
    for (let i = 1; i < bins; i += 1) {
      const db = spectrumDb[i];
      const magnitude = db > -140 ? Math.log1p(1000 * 10 ** (db / 20)) : 0;
      const rise = magnitude - this.previous[i];
      if (rise > 0) flux += i <= bass ? rise * 3 : rise;
      this.previous[i] = magnitude;
    }
    // Longer frames accumulate more change: we bring it back to ~60 fps.
    flux /= Math.max(0.5, dt * 60);

    // Fixed-step envelope: within a step the strongest onset counts.
    this.pendingFlux = Math.max(this.pendingFlux, flux);
    this.accumulator += dt;
    const step = 1 / RATE;
    while (this.accumulator >= step) {
      this._push(this.pendingFlux);
      this.pendingFlux = 0;
      this.accumulator -= step;
    }

    // --- phase: advances at the estimated tempo ---------------------------
    if (this.bpm > 0) this.phase += (dt * this.bpm) / 60;

    this.tempoTimer += dt;
    if (this.tempoTimer >= TEMPO_EVERY) {
      this.tempoTimer = 0;
      this._estimateTempo();
    }
  }

  _push(value) {
    this.envelope[this.head] = value;
    this.head = (this.head + 1) % HISTORY;
    this.filled = Math.min(HISTORY, this.filled + 1);
  }

  _estimateTempo() {
    const n = this.filled;
    if (n < RATE * 4) return;

    // Envelope in chronological order, smoothed and without the mean.
    const raw = this.raw;
    for (let i = 0; i < n; i += 1) raw[i] = this.envelope[(this.head - n + i + HISTORY) % HISTORY];
    const x = this.work;
    const half = (KERNEL.length - 1) / 2;
    let mean = 0;
    for (let i = 0; i < n; i += 1) {
      let sum = 0;
      for (let k = 0; k < KERNEL.length; k += 1) {
        const j = i + k - half;
        if (j >= 0 && j < n) sum += raw[j] * KERNEL[k];
      }
      x[i] = sum;
      mean += sum;
    }
    mean /= n;
    let energy = 0;
    for (let i = 0; i < n; i += 1) {
      x[i] -= mean;
      energy += x[i] * x[i];
    }
    energy /= n;
    if (energy < 1e-9) return;

    const ac = (lag) => {
      const whole = Math.floor(lag);
      const frac = lag - whole;
      let sum = 0;
      let count = 0;
      for (let i = 0; i + whole + 1 < n; i += 1) {
        sum += x[i] * (x[i + whole] * (1 - frac) + x[i + whole + 1] * frac);
        count += 1;
      }
      return count ? sum / count : 0;
    };
    // Period in half-sample steps: at 50 Hz a whole sample is too coarse.
    const minLag = (RATE * 60) / MAX_BPM;
    const maxLag = (RATE * 60) / MIN_BPM;
    let best = 0;
    let bestScore = -Infinity;
    for (let lag = minLag; lag <= maxLag; lag += 0.25) {
      let score = 0;
      HARMONICS.forEach((weight, index) => {
        const multiple = lag * (index + 1);
        if (multiple < n * 0.75) score += weight * ac(multiple);
      });
      const bpm = (RATE * 60) / lag;
      score *= Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
      if (score > bestScore) {
        bestScore = score;
        best = lag;
      }
    }
    const bpm = (RATE * 60) / best;
    const confidence = clamp(ac(best) / energy, 0, 1);
    this.confidence = damp(this.confidence, confidence, 2, TEMPO_EVERY);

    if (this.bpm === 0) {
      this.bpm = bpm;
    } else if (Math.abs(bpm - this.bpm) / this.bpm < 0.05) {
      this.bpm += (bpm - this.bpm) * 0.3;
      this.candidate = 0;
    } else if (this.candidate && Math.abs(bpm - this.candidate) / this.candidate < 0.05) {
      // A sharp tempo change: we accept it only if it repeats, not at a glance.
      this.candidateVotes += 1;
      if (this.candidateVotes >= 2) {
        this.bpm = bpm;
        this.candidate = 0;
        this.locked = false;
      }
    } else {
      this.candidate = bpm;
      this.candidateVotes = 1;
    }

    this._alignPhase(x, n);
  }

  /**
   * Phase: how many samples ago did the last beat fall? We try every offset of
   * a "comb" with teeth one period apart and keep the one that collects the
   * most onsets in the last seconds.
   */
  _alignPhase(x, n) {
    const period = (RATE * 60) / this.bpm;
    const reach = Math.min(n - 1, RATE * 5);
    let bestOffset = 0;
    let bestScore = -Infinity;
    for (let offset = 0; offset < period; offset += 0.25) {
      let score = 0;
      for (let back = offset; back < reach; back += period) {
        const position = n - 1 - back;
        const whole = Math.floor(position);
        const frac = position - whole;
        score += x[whole] * (1 - frac) + (whole + 1 < n ? x[whole + 1] * frac : 0);
      }
      if (score > bestScore) {
        bestScore = score;
        bestOffset = offset;
      }
    }
    // The last sample is `accumulator` seconds old; the onset shows up in the
    // spectrum about half a frame after the real kick.
    const since = (bestOffset + 0.5) / RATE + this.accumulator;
    const measured = (since * this.bpm) / 60;
    const error = wrap(this.phase - measured);
    // A sharp first lock, then soft corrections (no jumps in time).
    this.phase -= this.locked ? error * 0.5 : error;
    this.locked = true;
  }

  /** State read by the body every frame. `phase` is 0 on the beat. */
  get state() {
    const beat = Math.floor(this.phase);
    return {
      active: this.quietFor < 1.2 && this.energy > 0.05,
      bpm: this.bpm,
      phase: this.phase - beat,
      beat,
      energy: this.energy,
      confidence: this.bpm > 0 ? this.confidence : 0,
    };
  }
}

/** Captures the system audio (Electron) and passes it to the BeatTracker. */
export class MusicListener {
  constructor() {
    this.tracker = new BeatTracker();
    this.stream = null;
    this.context = null;
    this.analyser = null;
    this.starting = null;
  }

  get running() {
    return Boolean(this.analyser);
  }

  async start() {
    if (this.analyser) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      // In Electron, chromeMediaSource 'desktop' on audio AND video without a
      // source id captures the whole screen with its audio (loopback). We don't
      // need the video: we ask for it tiny and stop it right away.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop' } },
        video: { mandatory: { chromeMediaSource: 'desktop', maxWidth: 32, maxHeight: 32, maxFrameRate: 1 } },
      });
      for (const track of stream.getVideoTracks()) track.stop();
      const context = new AudioContext();
      await context.resume().catch(() => {});
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0;
      // Only towards the analyser, never towards the speakers: it would echo.
      context.createMediaStreamSource(stream).connect(analyser);
      this.stream = stream;
      this.context = context;
      this.analyser = analyser;
      this.spectrum = new Float32Array(analyser.frequencyBinCount);
      this.samples = new Float32Array(analyser.fftSize);
      this.tracker.reset();
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  stop() {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.context?.close().catch(() => {});
    this.stream = null;
    this.context = null;
    this.analyser = null;
    this.tracker.reset();
  }

  /** Call every frame; returns the rhythm's state. */
  update(dt) {
    if (this.analyser) {
      this.analyser.getFloatFrequencyData(this.spectrum);
      this.analyser.getFloatTimeDomainData(this.samples);
      let sum = 0;
      for (const sample of this.samples) sum += sample * sample;
      const rms = Math.sqrt(sum / this.samples.length);
      this.tracker.process(dt, rms, this.spectrum, this.context.sampleRate / this.analyser.fftSize);
    }
    return this.tracker.state;
  }
}
