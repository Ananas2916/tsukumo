/**
 * Effetti sonori: un "pop" quando compare, un tonfo quando atterra, un
 * campanello per promemoria e notifiche, un toc-toc quando bussa sul vetro.
 *
 * Niente file audio: tutto sintetizzato con WebAudio, in un contesto separato
 * da quello della voce. Cosi' gli effetti non passano dall'analizzatore del
 * lip-sync e la bocca non si muove a ogni "ding".
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

  /** Il contesto nasce al primo suono; `null` se non si puo' (o se deve tacere). */
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

  /** Un tono che parte forte e sfuma, con un'armonica per il timbro. */
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

  /** Rumore filtrato: la parte "legno" di un colpo. */
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

  /** Din-don: promemoria, timer, notifiche. */
  chime() {
    if (!this._ready()) return;
    this._tone(1318.5, { duration: 1.1, gain: 0.35, harmonic: 0.12 });
    this._tone(987.8, { at: 0.16, duration: 1.4, gain: 0.32, harmonic: 0.1 });
  }

  /** Compare sullo schermo. */
  pop() {
    if (!this._ready()) return;
    this._tone(420, { duration: 0.16, gain: 0.3, slideTo: 980 });
  }

  /** Atterra: piu' forte se cade da piu' in alto (`strength` 0..1). */
  thud(strength = 0.5) {
    if (!this._ready()) return;
    const level = 0.15 + 0.45 * Math.min(1, Math.max(0, strength));
    this._tone(110, { duration: 0.22, gain: level, slideTo: 48 });
    this._noise({ duration: 0.06, gain: level * 0.5, frequency: 600, q: 0.8 });
  }

  /** Toc toc sul vetro dello schermo. */
  knock() {
    if (!this._ready()) return;
    for (const at of [0, 0.19]) {
      this._noise({ at, duration: 0.05, gain: 0.55, frequency: 2300, q: 2.5 });
      this._tone(240, { at, duration: 0.09, gain: 0.25, slideTo: 170 });
    }
  }

  /** Un piccolo "blip" di sorpresa (le gira la testa, si offende...). */
  blip(up = true) {
    if (!this._ready()) return;
    this._tone(up ? 660 : 880, { duration: 0.14, gain: 0.22, slideTo: up ? 990 : 520, type: 'triangle' });
  }
}
