/**
 * Lip-sync driver.
 *
 * It combines two sources of information:
 *
 *  1. the **timeline** computed by the backend, `[{t, d, v, w}, ...]`, which
 *     says *which* shape the mouth must have at each moment;
 *  2. the **instantaneous RMS level** read from WebAudio, which says *how
 *     much* the mouth must open in this exact frame.
 *
 * The product of the two is robust: even if the timeline is off by 30-40 ms,
 * the mouth keeps opening and closing in time with the volume. If the
 * timeline is missing altogether (external audio, for example) it falls back
 * to a movement driven only by amplitude.
 */

import { VISEME_KEYS } from './config.js';

/** Duration of the cross-fade between a viseme and the next (seconds). */
const BLEND_TIME = 0.05;

export class LipSync {
  constructor(options = {}) {
    /** Global gain, set by the "Mouth" slider. */
    this.gain = options.gain ?? 1.15;
    /**
     * Share of the opening that depends on the instantaneous volume (0..1).
     * Kept low on purpose: the weight already goes through openness x energy on
     * the backend, and multiplying too many factors below 1 would leave the
     * mouth almost closed.
     */
    this.levelInfluence = options.levelInfluence ?? 0.35;
    /**
     * Perceptual curve applied to the final weight. VRM blendshapes below ~0.4
     * are barely visible, so we raise the middle values keeping the extremes:
     * 0 stays 0, 1 stays 1, but 0.4 becomes 0.53.
     */
    this.curve = options.curve ?? 0.7;
    /** Opening / closing speed (units per second). */
    this.attack = options.attack ?? 24;
    this.release = options.release ?? 13;

    this.timeline = [];
    this.cursor = 0;
    this.activeViseme = 'sil';
    /** Current weights, the ones actually applied to the model. */
    this.weights = { a: 0, i: 0, u: 0, e: 0, o: 0 };
    this._target = { a: 0, i: 0, u: 0, e: 0, o: 0 };
  }

  /** Installs the timeline of the clip about to start. */
  setTimeline(visemes) {
    this.timeline = Array.isArray(visemes) ? visemes : [];
    this.cursor = 0;
  }

  /** No clip playing: the mouth will close by itself. */
  clear() {
    this.timeline = [];
    this.cursor = 0;
    this.activeViseme = 'sil';
  }

  /**
   * @param {number} time     position in the current clip, in seconds
   * @param {number} level    RMS 0..1 of the audio in this frame
   * @param {number} dt       seconds since the last frame
   * @param {boolean} playing true if audio is really playing
   * @returns {{a:number,i:number,u:number,e:number,o:number}}
   */
  update(time, level, dt, playing) {
    for (const key of VISEME_KEYS) this._target[key] = 0;

    if (playing) {
      if (this.timeline.length > 0) {
        this._targetFromTimeline(time, level);
      } else {
        // Purely acoustic fallback: we open the "a" to the rhythm of the volume.
        this._target.a = level;
        this.activeViseme = level > 0.08 ? 'a' : 'sil';
      }
    } else {
      this.activeViseme = 'sil';
    }

    // Independent exponential smoothing per channel.
    for (const key of VISEME_KEYS) {
      const raw = Math.min(1, Math.max(0, this._target[key]));
      const target = raw > 0 ? Math.min(1, raw ** this.curve * this.gain) : 0;
      const speed = target > this.weights[key] ? this.attack : this.release;
      this.weights[key] += (target - this.weights[key]) * Math.min(1, dt * speed);
      if (this.weights[key] < 0.002) this.weights[key] = 0;
    }
    return this.weights;
  }

  /** Computes the raw weights reading the timeline at the given time. */
  _targetFromTimeline(time, level) {
    const index = this._frameIndexAt(time);
    if (index < 0) {
      this.activeViseme = 'sil';
      return;
    }

    const frame = this.timeline[index];
    // The instantaneous volume modulates the weight predicted by the backend.
    const modulation = 1 - this.levelInfluence + this.levelInfluence * level;

    this._accumulate(frame, modulation, 1);
    this.activeViseme = frame.v;

    // Coarticulation: in the last milliseconds we blend into the next frame.
    const next = this.timeline[index + 1];
    if (next) {
      const remaining = frame.t + frame.d - time;
      if (remaining < BLEND_TIME) {
        const mix = Math.min(1, Math.max(0, 1 - remaining / BLEND_TIME)) * 0.5;
        this._scale(1 - mix);
        this._accumulate(next, modulation, mix);
        if (mix > 0.35) this.activeViseme = next.v;
      }
    }
  }

  _accumulate(frame, modulation, amount) {
    if (!frame || frame.v === 'sil') return;
    const key = frame.v;
    if (!(key in this._target)) return;
    this._target[key] += frame.w * modulation * amount;
  }

  _scale(factor) {
    for (const key of VISEME_KEYS) this._target[key] *= factor;
  }

  /**
   * Finds the frame that contains `time`.
   * Playback almost always moves forward, so we start from the previous
   * cursor: amortized O(1) instead of a search every frame.
   */
  _frameIndexAt(time) {
    const frames = this.timeline;
    if (frames.length === 0) return -1;

    if (this.cursor >= frames.length) this.cursor = frames.length - 1;
    // If time went back (new clip, seek) we start over.
    if (time < frames[this.cursor].t) this.cursor = 0;

    while (
      this.cursor < frames.length - 1 &&
      time >= frames[this.cursor].t + frames[this.cursor].d
    ) {
      this.cursor += 1;
    }

    const frame = frames[this.cursor];
    if (time < frame.t) return -1; // silence before the start
    if (time > frame.t + frame.d && this.cursor === frames.length - 1) return -1;
    return this.cursor;
  }
}
