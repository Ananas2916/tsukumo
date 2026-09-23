/**
 * Driver del lip-sync.
 *
 * Combina due sorgenti di informazione:
 *
 *  1. la **timeline** calcolata dal backend, `[{t, d, v, w}, ...]`, che dice
 *     *quale* forma deve avere la bocca in ogni istante;
 *  2. il **livello RMS istantaneo** letto da WebAudio, che dice *quanto* la
 *     bocca deve aprirsi in questo esatto frame.
 *
 * Il prodotto delle due cose e' robusto: anche se la timeline e' spostata di
 * 30-40 ms, la bocca continua ad aprirsi e chiudersi a tempo con il volume.
 * Se la timeline manca del tutto (per esempio audio esterno) si ripiega su un
 * movimento guidato solo dall'ampiezza.
 */

import { VISEME_KEYS } from './config.js';

/** Durata della dissolvenza fra un viseme e il successivo (secondi). */
const BLEND_TIME = 0.05;

export class LipSync {
  constructor(options = {}) {
    /** Guadagno globale, regolabile dallo slider "Bocca". */
    this.gain = options.gain ?? 1.15;
    /**
     * Quota di apertura che dipende dal volume istantaneo (0..1).
     * Tenuta bassa di proposito: il peso passa gia' per openness x energia
     * lato backend, e moltiplicare troppi fattori minori di 1 lascerebbe la
     * bocca quasi chiusa.
     */
    this.levelInfluence = options.levelInfluence ?? 0.35;
    /**
     * Curva percettiva applicata al peso finale. Le blendshape VRM sotto ~0.4
     * si notano appena, quindi alziamo i valori medi lasciando fermi gli
     * estremi: 0 resta 0, 1 resta 1, ma 0.4 diventa 0.53.
     */
    this.curve = options.curve ?? 0.7;
    /** Velocita' di apertura / chiusura (unita' al secondo). */
    this.attack = options.attack ?? 24;
    this.release = options.release ?? 13;

    this.timeline = [];
    this.cursor = 0;
    this.activeViseme = 'sil';
    /** Pesi correnti, quelli effettivamente applicati al modello. */
    this.weights = { a: 0, i: 0, u: 0, e: 0, o: 0 };
    this._target = { a: 0, i: 0, u: 0, e: 0, o: 0 };
  }

  /** Installa la timeline della clip che sta per partire. */
  setTimeline(visemes) {
    this.timeline = Array.isArray(visemes) ? visemes : [];
    this.cursor = 0;
  }

  /** Nessuna clip in riproduzione: la bocca tornera' chiusa da sola. */
  clear() {
    this.timeline = [];
    this.cursor = 0;
    this.activeViseme = 'sil';
  }

  /**
   * @param {number} time     posizione nella clip corrente, in secondi
   * @param {number} level    RMS 0..1 dell'audio in questo frame
   * @param {number} dt       secondi dall'ultimo frame
   * @param {boolean} playing true se c'e' davvero audio in riproduzione
   * @returns {{a:number,i:number,u:number,e:number,o:number}}
   */
  update(time, level, dt, playing) {
    for (const key of VISEME_KEYS) this._target[key] = 0;

    if (playing) {
      if (this.timeline.length > 0) {
        this._targetFromTimeline(time, level);
      } else {
        // Fallback puramente acustico: apriamo la "a" a ritmo di volume.
        this._target.a = level;
        this.activeViseme = level > 0.08 ? 'a' : 'sil';
      }
    } else {
      this.activeViseme = 'sil';
    }

    // Smoothing esponenziale indipendente per canale.
    for (const key of VISEME_KEYS) {
      const raw = Math.min(1, Math.max(0, this._target[key]));
      const target = raw > 0 ? Math.min(1, raw ** this.curve * this.gain) : 0;
      const speed = target > this.weights[key] ? this.attack : this.release;
      this.weights[key] += (target - this.weights[key]) * Math.min(1, dt * speed);
      if (this.weights[key] < 0.002) this.weights[key] = 0;
    }
    return this.weights;
  }

  /** Calcola i pesi grezzi leggendo la timeline al tempo indicato. */
  _targetFromTimeline(time, level) {
    const index = this._frameIndexAt(time);
    if (index < 0) {
      this.activeViseme = 'sil';
      return;
    }

    const frame = this.timeline[index];
    // Il volume istantaneo modula il peso previsto dal backend.
    const modulation = 1 - this.levelInfluence + this.levelInfluence * level;

    this._accumulate(frame, modulation, 1);
    this.activeViseme = frame.v;

    // Coarticolazione: negli ultimi millisecondi sfumiamo sul frame successivo.
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
   * Trova il frame che contiene `time`.
   * La riproduzione e' quasi sempre in avanti, quindi partiamo dal cursore
   * precedente: e' O(1) ammortizzato invece di una ricerca a ogni frame.
   */
  _frameIndexAt(time) {
    const frames = this.timeline;
    if (frames.length === 0) return -1;

    if (this.cursor >= frames.length) this.cursor = frames.length - 1;
    // Se il tempo e' tornato indietro (nuova clip, seek) ripartiamo da capo.
    if (time < frames[this.cursor].t) this.cursor = 0;

    while (
      this.cursor < frames.length - 1 &&
      time >= frames[this.cursor].t + frames[this.cursor].d
    ) {
      this.cursor += 1;
    }

    const frame = frames[this.cursor];
    if (time < frame.t) return -1; // silenzio prima dell'inizio
    if (time > frame.t + frame.d && this.cursor === frames.length - 1) return -1;
    return this.cursor;
  }
}
