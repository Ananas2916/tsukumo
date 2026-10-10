/**
 * Sound effects: little sounds for what she does and what happens, like the
 * ones Coucou's Mochi makes (the island opening and closing, a touch, a
 * slap, dizziness, a finished job, a question, an error, a file eaten...).
 *
 * Coucou's sound files are its own: here everything is synthesized with
 * WebAudio, in Tsukumo's voice, glassy and warm like a flame: bells, soft
 * plucks, breaths of air. No files to ship or license. The context is
 * separate from the voice's, so the effects don't go through the lip-sync
 * analyser and the mouth doesn't move at every "ding"; it's suspended when
 * quiet, so it costs no CPU while nothing plays.
 */

import { readSetting, writeSetting } from './dom.js';

/** Volume 0..1 (the panel's slider); the master gain is this times MAX_GAIN. */
const VOLUME_SETTING = 'dc:sfx-volume';
const MAX_GAIN = 0.75;
/** The same sound again within this time (ms) is dropped: a burst of events doesn't become a machine gun. */
const REPEAT_MS = 90;
/** After this much silence (ms) the audio thread is suspended. */
const IDLE_MS = 2500;

/** Notes in Hz, by name: the sounds are tuned to each other (a pentatonic in E). */
const N = {
  B3: 246.94,
  E4: 329.63,
  Gs4: 415.3,
  A4: 440,
  B4: 493.88,
  Cs5: 554.37,
  E5: 659.25,
  Fs5: 739.99,
  Gs5: 830.61,
  B5: 987.77,
  Cs6: 1108.73,
  E6: 1318.51,
  Gs6: 1661.22,
  B6: 1975.53,
};

export class Sfx {
  /** @param {{isMuted: () => boolean}} options */
  constructor({ isMuted }) {
    this.isMuted = isMuted;
    this.enabled = readSetting('dc:sfx', true);
    this.volume = Math.min(1, Math.max(0, Number(readSetting(VOLUME_SETTING, 0.6)) || 0));
    this.context = null;
    this.master = null;
    this._last = new Map();
    this._idleTimer = null;
  }

  setEnabled(value) {
    this.enabled = Boolean(value);
    writeSetting('dc:sfx', this.enabled);
  }

  /** 0..1, from the panel. */
  setVolume(value) {
    const volume = Math.min(1, Math.max(0, Number(value) || 0));
    this.volume = volume;
    writeSetting(VOLUME_SETTING, volume);
    if (this.master) this.master.gain.value = volume * MAX_GAIN;
  }

  /**
   * Plays an effect by name (the methods below). Unknown names and effects
   * while she must keep quiet are ignored.
   */
  play(name, ...args) {
    if (!SOUNDS.has(name)) return;
    const now = performance.now();
    if (now - (this._last.get(name) ?? -Infinity) < REPEAT_MS) return;
    this._last.set(name, now);
    if (!this._ready()) return;
    this[name](...args);
    this._idleSoon();
  }

  /** The context is created at the first sound; `null` if it can't be (or she must keep quiet). */
  _ready() {
    if (!this.enabled || this.volume <= 0 || this.isMuted()) return null;
    if (!this.context) {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return null;
      this.context = new AudioCtor();
      this.master = this.context.createGain();
      this.master.gain.value = this.volume * MAX_GAIN;
      // A soft limiter: many sounds together don't clip.
      const limiter = this.context.createDynamicsCompressor();
      limiter.threshold.value = -10;
      limiter.ratio.value = 8;
      this.master.connect(limiter).connect(this.context.destination);
    }
    clearTimeout(this._idleTimer);
    if (this.context.state === 'suspended') this.context.resume().catch(() => {});
    return this.context;
  }

  /** A running AudioContext keeps an audio thread busy even in silence: suspend it after the tail. */
  _idleSoon() {
    clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      if (this.context?.state === 'running') this.context.suspend().catch(() => {});
    }, IDLE_MS);
  }

  // ------------------------------------------------------------- building blocks
  /**
   * A tone that starts quickly and fades, with an optional inharmonic partial
   * (bell-like) and a pitch slide.
   */
  _tone(frequency, { at = 0, duration = 0.6, gain = 0.5, type = 'sine', slideTo = null, harmonic = 0, ratio = 2.76, attack = 0.008, vibrato = 0 } = {}) {
    const context = this.context;
    const start = context.currentTime + at;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(gain, start + attack);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    envelope.connect(this.master);
    const voices = [[frequency, 1]];
    if (harmonic) voices.push([frequency * ratio, harmonic]);
    for (const [hz, level] of voices) {
      const oscillator = context.createOscillator();
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(hz, start);
      if (slideTo) oscillator.frequency.exponentialRampToValueAtTime(slideTo * (hz / frequency), start + duration);
      if (vibrato) {
        const lfo = context.createOscillator();
        const depth = context.createGain();
        lfo.frequency.value = vibrato;
        depth.gain.value = hz * 0.04;
        lfo.connect(depth).connect(oscillator.frequency);
        lfo.start(start);
        lfo.stop(start + duration + 0.05);
      }
      const mix = context.createGain();
      mix.gain.value = level;
      oscillator.connect(mix).connect(envelope);
      oscillator.start(start);
      oscillator.stop(start + duration + 0.05);
    }
  }

  /** Filtered noise: wood (knocks), air (whooshes), cloth (the wardrobe). */
  _noise({ at = 0, duration = 0.05, gain = 0.4, frequency = 1800, q = 1.2, type = 'bandpass', sweepTo = null, attack = 0 } = {}) {
    const context = this.context;
    const start = context.currentTime + at;
    const length = Math.max(1, Math.floor(context.sampleRate * duration));
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    const rise = Math.floor(length * attack);
    for (let i = 0; i < length; i += 1) {
      const shape = i < rise ? i / rise : (1 - (i - rise) / Math.max(1, length - rise)) ** 2;
      data[i] = (Math.random() * 2 - 1) * shape;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    const filter = context.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(frequency, start);
    if (sweepTo) filter.frequency.exponentialRampToValueAtTime(sweepTo, start + duration);
    filter.Q.value = q;
    const level = context.createGain();
    level.gain.value = gain;
    source.connect(filter).connect(level).connect(this.master);
    source.start(start);
  }

  /** A short glassy note: the brick of her chimes. */
  _bell(frequency, at = 0, gain = 0.22, duration = 0.9) {
    this._tone(frequency, { at, duration, gain, harmonic: 0.14 });
    this._tone(frequency * 2, { at, duration: duration * 0.45, gain: gain * 0.18 });
  }

  /** A round, soft pluck (a marimba-ish "boop"). */
  _pluck(frequency, at = 0, gain = 0.3, duration = 0.22) {
    this._tone(frequency, { at, duration, gain, type: 'triangle', harmonic: 0.08, ratio: 4 });
  }

  // ------------------------------------------------------------------ the sounds
  /** She appears on screen: a little rising "pop". */
  pop() {
    this._tone(420, { duration: 0.16, gain: 0.3, slideTo: 980 });
  }

  /** She greets: three rising bells, "hi-i-i!". */
  greet() {
    [N.E5, N.Gs5, N.B5].forEach((note, i) => this._bell(note, i * 0.07, 0.17, 0.7));
  }

  /** The island opens: a breath of air rising and two bright notes. */
  open() {
    this._noise({ duration: 0.22, gain: 0.12, frequency: 900, sweepTo: 3800, q: 0.8, attack: 0.4 });
    this._pluck(N.B5, 0.03, 0.16, 0.18);
    this._pluck(N.E6, 0.09, 0.13, 0.24);
  }

  /** The island closes: the same, going down into her. */
  close() {
    this._noise({ duration: 0.18, gain: 0.09, frequency: 3200, sweepTo: 700, q: 0.8 });
    this._pluck(N.E6, 0, 0.11, 0.14);
    this._pluck(N.B5, 0.06, 0.12, 0.2);
  }

  /** The cursor arrives on her: a tiny glass "tink". */
  hover() {
    this._tone(N.B6, { duration: 0.12, gain: 0.07, harmonic: 0.2 });
  }

  /** A pat on the head: a happy boop that goes up. */
  pat() {
    this._tone(N.Gs4, { duration: 0.2, gain: 0.26, slideTo: N.E5, type: 'triangle' });
    this._pluck(N.B5, 0.08, 0.1, 0.2);
  }

  /** A poke on the body: a squishy "boing". */
  poke() {
    this._tone(300, { duration: 0.24, gain: 0.3, slideTo: 170, type: 'sine', vibrato: 18 });
    this._noise({ duration: 0.04, gain: 0.1, frequency: 900, q: 1.5 });
  }

  /** Poked too much: a sulky "hmph", two low notes going down. */
  annoyed() {
    this._tone(N.B3 * 1.5, { duration: 0.12, gain: 0.2, type: 'triangle' });
    this._tone(N.B3, { at: 0.12, duration: 0.28, gain: 0.22, slideTo: N.B3 * 0.85, type: 'triangle' });
  }

  /** Her head spins: a wobbling whistle spiralling down. */
  dizzy() {
    this._tone(N.E6, { duration: 0.9, gain: 0.14, slideTo: N.E5, vibrato: 9 });
    this._tone(N.B5, { at: 0.08, duration: 0.8, gain: 0.08, slideTo: N.B4, vibrato: 7 });
  }

  /** Little hearts: sparkles going up. */
  love() {
    [N.B5, N.E6, N.Gs6, N.B6].forEach((note, i) => this._tone(note, { at: i * 0.06, duration: 0.35, gain: 0.08, harmonic: 0.2 }));
  }

  /** Picked up: a short "hup" of air. */
  lift() {
    this._noise({ duration: 0.12, gain: 0.1, frequency: 700, sweepTo: 2400, q: 1, attack: 0.3 });
    this._tone(N.E5, { duration: 0.1, gain: 0.08, slideTo: N.B5 });
  }

  /** Thrown: a whoosh, stronger if faster (`strength` 0..1). */
  whoosh(strength = 0.6) {
    const level = 0.08 + 0.16 * Math.min(1, Math.max(0, strength));
    this._noise({ duration: 0.38, gain: level, frequency: 500, sweepTo: 2600, q: 0.7, attack: 0.25 });
  }

  /** She lands: louder if she falls from higher up (`strength` 0..1). */
  thud(strength = 0.5) {
    const level = 0.15 + 0.45 * Math.min(1, Math.max(0, strength));
    this._tone(110, { duration: 0.22, gain: level, slideTo: 48 });
    this._noise({ duration: 0.06, gain: level * 0.5, frequency: 600, q: 0.8 });
  }

  /** A file eaten: a low bubble going down, then a tiny happy note. */
  gulp() {
    this._tone(260, { duration: 0.18, gain: 0.3, slideTo: 120, type: 'sine' });
    this._tone(180, { at: 0.13, duration: 0.14, gain: 0.18, slideTo: 300 });
    this._pluck(N.E5, 0.36, 0.12, 0.2);
  }

  /** A job finished (she celebrates): a bright arpeggio. */
  finish() {
    [N.E5, N.Gs5, N.B5, N.E6].forEach((note, i) => this._bell(note, i * 0.085, 0.16, 0.8));
  }

  /** An agent waits for you, or asks something: two notes, the second up, "hm?". */
  question() {
    this._bell(N.B5, 0, 0.17, 0.5);
    this._bell(N.E6, 0.14, 0.17, 0.8);
  }

  /** Something went wrong: two soft low notes, down. */
  error() {
    this._tone(N.E4, { duration: 0.2, gain: 0.2, type: 'triangle', harmonic: 0.06 });
    this._tone(N.B3, { at: 0.16, duration: 0.42, gain: 0.22, type: 'triangle', harmonic: 0.06 });
  }

  /** Your message leaves: a quick breath up. */
  send() {
    this._noise({ duration: 0.14, gain: 0.08, frequency: 1200, sweepTo: 4200, q: 0.9, attack: 0.2 });
    this._tone(N.B5, { duration: 0.12, gain: 0.07, slideTo: N.E6 });
  }

  /** She answers in writing only (voice off or failed): a small soft "pop". */
  reply() {
    this._pluck(N.Gs5, 0, 0.12, 0.16);
  }

  /** She falls asleep: a slow lullaby going down. */
  sleep() {
    [N.B5, N.Gs5, N.E5].forEach((note, i) => this._tone(note, { at: i * 0.22, duration: 0.6, gain: 0.07, harmonic: 0.1 }));
  }

  /** She wakes up: the same, quickly going up. */
  wake() {
    [N.E5, N.B5].forEach((note, i) => this._tone(note, { at: i * 0.09, duration: 0.3, gain: 0.08, harmonic: 0.12 }));
  }

  /** Something new to wear: a rustle of cloth and a sparkle. */
  outfit() {
    this._noise({ duration: 0.2, gain: 0.1, frequency: 2600, q: 0.6, type: 'highpass', attack: 0.2 });
    this._tone(N.Gs6, { at: 0.12, duration: 0.3, gain: 0.06, harmonic: 0.3 });
    this._tone(N.B6, { at: 0.18, duration: 0.35, gain: 0.05 });
  }

  /** A switch flips (dance, voice, microphone): a dry little tick. */
  tick() {
    this._noise({ duration: 0.025, gain: 0.18, frequency: 3400, q: 3 });
    this._tone(N.E6, { duration: 0.04, gain: 0.05 });
  }

  /** She dashes along the taskbar: "zoom". */
  zoom() {
    this._tone(380, { duration: 0.3, gain: 0.1, slideTo: 1400, type: 'sawtooth' });
    this._noise({ duration: 0.3, gain: 0.08, frequency: 800, sweepTo: 3000, q: 0.8, attack: 0.3 });
  }

  /** Ding-dong: reminders, timers, notifications. */
  chime() {
    this._tone(1318.5, { duration: 1.1, gain: 0.35, harmonic: 0.12 });
    this._tone(987.8, { at: 0.16, duration: 1.4, gain: 0.32, harmonic: 0.1 });
  }

  /** Knock knock on the screen glass. */
  knock() {
    for (const at of [0, 0.19]) {
      this._noise({ at, duration: 0.05, gain: 0.55, frequency: 2300, q: 2.5 });
      this._tone(240, { at, duration: 0.09, gain: 0.25, slideTo: 170 });
    }
  }
}

/** The effects `play()` accepts. */
export const SOUNDS = new Set([
  'pop',
  'greet',
  'open',
  'close',
  'hover',
  'pat',
  'poke',
  'annoyed',
  'dizzy',
  'love',
  'lift',
  'whoosh',
  'thud',
  'gulp',
  'finish',
  'question',
  'error',
  'send',
  'reply',
  'sleep',
  'wake',
  'outfit',
  'tick',
  'zoom',
  'chime',
  'knock',
]);
