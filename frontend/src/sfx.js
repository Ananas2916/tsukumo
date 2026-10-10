/**
 * Sound effects: a "pop" when she appears, a thud when she lands, a chime
 * for reminders and notifications, a knock-knock when she taps the glass.
 *
 * No audio files: everything is synthesized with WebAudio, in a context
 * separate from the voice's. So the effects don't go through the lip-sync
 * analyser and the mouth doesn't move at every "ding".
 */

import { readSetting, writeSetting } from './dom.js';

export class Sfx {
  /** @param {{isMuted: () => boolean}} options */
  constructor({ isMuted }) {
    this.isMuted = isMuted;
    this.enabled = readSetting('dc:sfx', true);
    this.volume = 0.45;
    this.context = null;
    this.master = null;
  }

  setEnabled(value) {
    this.enabled = Boolean(value);
    writeSetting('dc:sfx', this.enabled);
  }

  /** The context is created at the first sound; `null` if it can't be (or she must keep quiet). */
  _ready() {
    if (!this.enabled || this.isMuted()) return null;
    if (!this.context) {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return null;
      this.context = new AudioCtor();
      this.master = this.context.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.context.destination);
    }
    if (this.context.state === 'suspended') this.context.resume().catch(() => {});
    return this.context;
  }

  /** A tone that starts loud and fades, with a harmonic for the timbre. */
  _tone(frequency, { at = 0, duration = 0.6, gain = 0.5, type = 'sine', slideTo = null, harmonic = 0 } = {}) {
    const context = this.context;
    const start = context.currentTime + at;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(gain, start + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    envelope.connect(this.master);
    const voices = [[frequency, 1]];
    if (harmonic) voices.push([frequency * 2.76, harmonic]);
    for (const [hz, level] of voices) {
      const oscillator = context.createOscillator();
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(hz, start);
      if (slideTo) oscillator.frequency.exponentialRampToValueAtTime(slideTo * (hz / frequency), start + duration);
      const mix = context.createGain();
      mix.gain.value = level;
      oscillator.connect(mix).connect(envelope);
      oscillator.start(start);
      oscillator.stop(start + duration + 0.05);
    }
  }

  /** Filtered noise: the "wood" part of a knock. */
  _noise({ at = 0, duration = 0.05, gain = 0.4, frequency = 1800, q = 1.2 } = {}) {
    const context = this.context;
    const start = context.currentTime + at;
    const length = Math.max(1, Math.floor(context.sampleRate * duration));
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2;
    const source = context.createBufferSource();
    source.buffer = buffer;
    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const level = context.createGain();
    level.gain.value = gain;
    source.connect(filter).connect(level).connect(this.master);
    source.start(start);
  }

  /** Ding-dong: reminders, timers, notifications. */
  chime() {
    if (!this._ready()) return;
    this._tone(1318.5, { duration: 1.1, gain: 0.35, harmonic: 0.12 });
    this._tone(987.8, { at: 0.16, duration: 1.4, gain: 0.32, harmonic: 0.1 });
  }

  /** She appears on screen. */
  pop() {
    if (!this._ready()) return;
    this._tone(420, { duration: 0.16, gain: 0.3, slideTo: 980 });
  }

  /** She lands: louder if she falls from higher up (`strength` 0..1). */
  thud(strength = 0.5) {
    if (!this._ready()) return;
    const level = 0.15 + 0.45 * Math.min(1, Math.max(0, strength));
    this._tone(110, { duration: 0.22, gain: level, slideTo: 48 });
    this._noise({ duration: 0.06, gain: level * 0.5, frequency: 600, q: 0.8 });
  }

  /** Knock knock on the screen glass. */
  knock() {
    if (!this._ready()) return;
    for (const at of [0, 0.19]) {
      this._noise({ at, duration: 0.05, gain: 0.55, frequency: 2300, q: 2.5 });
      this._tone(240, { at, duration: 0.09, gain: 0.25, slideTo: 170 });
    }
  }

  /** A small "blip" of surprise (her head spins, she gets offended...). */
  blip(up = true) {
    if (!this._ready()) return;
    this._tone(up ? 660 : 880, { duration: 0.14, gain: 0.22, slideTo: up ? 990 : 520, type: 'triangle' });
  }
}
