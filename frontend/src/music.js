/**
 * Il ritmo della musica che stai ascoltando.
 *
 * Spotify non espone piu' BPM ed "energy" alle app nuove, quindi il ritmo lo
 * ricaviamo dall'audio vero: Electron cattura l'audio di sistema (loopback,
 * quello che esce dalle casse) e qui lo analizziamo in tempo reale.
 *
 *  - attacchi: flusso spettrale (quanto cresce l'energia banda per banda da un
 *    frame all'altro), con i bassi pesati di piu' perche' la cassa porta il tempo;
 *  - tempo: autocorrelazione degli ultimi secondi di attacchi (smussati),
 *    fra 70 e 180 BPM, sommata sui multipli del periodo (un battito vero si
 *    ripete anche a 2, 3, 4 periodi; un controtempo no), con una preferenza
 *    morbida per i tempi "da ballare" intorno ai 120;
 *  - fase: un oscillatore al tempo stimato, riallineato ogni mezzo secondo
 *    cercando lo sfasamento del "pettine" di battiti che raccoglie piu'
 *    attacchi negli ultimi secondi (vince la cassa, pesata di piu');
 *  - energia: volume relativo, normalizzato su un picco che si adatta, cosi'
 *    non dipende da quanto e' alto il volume del PC.
 *
 * `BeatTracker` e' il calcolo puro (si prova anche in Node con segnali
 * sintetici), `MusicListener` ci aggiunge la cattura dell'audio.
 */

const RATE = 50; // campioni al secondo dell'inviluppo degli attacchi
const HISTORY = RATE * 8;
const MIN_BPM = 70;
const MAX_BPM = 180;
const TEMPO_EVERY = 0.5; // s
const SILENCE = 0.004; // RMS sotto cui e' silenzio (pausa, fine brano)

/** Smussatura dell'inviluppo: un attacco vale anche un campione prima e dopo. */
const KERNEL = [0.25, 0.6, 1, 0.6, 0.25];
/** Pesi dei multipli del periodo nel punteggio del tempo. */
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
   * Un frame di analisi.
   * @param {number} dt secondi dall'ultimo frame
   * @param {number} rms volume del frame
   * @param {Float32Array} spectrumDb spettro in dB (come AnalyserNode.getFloatFrequencyData)
   * @param {number} binHz larghezza di un bin in Hz
   */
  process(dt, rms, spectrumDb, binHz) {
    if (dt <= 0) return;

    // --- energia ----------------------------------------------------------
    this.peak = Math.max(rms, this.peak * Math.exp(-dt / 6));
    const loud = rms > SILENCE;
    this.quietFor = loud ? 0 : this.quietFor + dt;
    this.energy = damp(this.energy, loud ? clamp(rms / Math.max(this.peak, 0.02), 0, 1) : 0, 6, dt);

    // --- attacchi: flusso spettrale log-compresso, bassi pesati di piu' ---
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
    // Frame piu' lunghi accumulano piu' variazione: riportiamo a ~60 fps.
    flux /= Math.max(0.5, dt * 60);

    // Inviluppo a passo fisso: dentro un passo vale l'attacco piu' forte.
    this.pendingFlux = Math.max(this.pendingFlux, flux);
    this.accumulator += dt;
    const step = 1 / RATE;
    while (this.accumulator >= step) {
      this._push(this.pendingFlux);
      this.pendingFlux = 0;
      this.accumulator -= step;
    }

    // --- fase: avanza al tempo stimato ------------------------------------
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

    // Inviluppo in ordine cronologico, smussato e senza media.
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
    // Periodo con passo di mezzo campione: a 50 Hz un campione intero e' troppo grossolano.
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
      // Cambio di tempo netto: lo accettiamo solo se si ripete, non per un'occhiata.
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
   * Fase: di quanti campioni fa e' caduto l'ultimo battito? Proviamo tutti gli
   * sfasamenti di un "pettine" con i denti a distanza di un periodo e teniamo
   * quello che raccoglie piu' attacchi negli ultimi secondi.
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
    // L'ultimo campione e' di `accumulator` secondi fa; l'attacco appare nello
    // spettro circa mezzo frame dopo la cassa vera.
    const since = (bestOffset + 0.5) / RATE + this.accumulator;
    const measured = (since * this.bpm) / 60;
    const error = wrap(this.phase - measured);
    // Primo aggancio secco, poi correzioni morbide (niente scatti a tempo).
    this.phase -= this.locked ? error * 0.5 : error;
    this.locked = true;
  }

  /** Stato letto dal corpo a ogni frame. `phase` e' 0 sul battito. */
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

/** Cattura l'audio di sistema (Electron) e lo passa al BeatTracker. */
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
      // In Electron, chromeMediaSource 'desktop' su audio E video senza un id
      // di sorgente cattura lo schermo intero con il suo audio (loopback).
      // Il video non ci serve: lo chiediamo minuscolo e lo fermiamo subito.
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
      // Solo verso l'analizzatore, mai verso le casse: sarebbe un'eco.
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

  /** Da chiamare a ogni frame; restituisce lo stato del ritmo. */
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
