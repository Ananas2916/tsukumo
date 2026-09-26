/**
 * Versetti: brevi esclamazioni con la voce scelta ("Hii!" quando saluta,
 * "Ehehe!" a una carezza, "Waah!" se cade).
 *
 * Il backend li sintetizza con il motore e la voce in uso, nella lingua della
 * voce, e li tiene in cache (`POST /api/vocal`). Qui si decide *quando*: mai
 * sopra una risposta, mai da muta, e non a ogni singolo click, altrimenti da
 * carini diventano fastidiosi.
 */

import { apiUrl } from './config.js';
import { readSetting, writeSetting } from './dom.js';

/** Pausa minima fra due versetti qualsiasi, e fra due uguali (ms). */
const MIN_GAP_MS = 1200;
const SAME_GAP_MS = 4000;
/** Le reazioni ai tocchi non parlano sempre: sembrerebbe un giocattolo. */
const CHANCE = { pat: 0.75, poke: 0.6, lift: 0.7, fall: 0.8, pout: 1, dizzy: 1 };

/** Saluto adatto all'ora: "Buongiorno!" la mattina, "Buonasera!" la sera. */
export function greetingForNow(date = new Date()) {
  const hour = date.getHours();
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 18 && hour < 23) return 'evening';
  if (hour >= 23 || hour < 5) return 'night';
  return 'greet';
}

export class Vocals {
  /**
   * @param {object} options
   * @param {{enqueue: Function, playing: boolean}} options.player
   * @param {() => boolean} options.isQuiet vero se deve tacere (muta, pensa, parla)
   */
  constructor({ player, isQuiet }) {
    this.player = player;
    this.isQuiet = isQuiet;
    this.enabled = readSetting('dc:vocals', true);
    this.lastAt = 0;
    this.lastByEvent = {};
    this.pending = false;
  }

  setEnabled(value) {
    this.enabled = Boolean(value);
    writeSetting('dc:vocals', this.enabled);
  }

  /**
   * Chiede e suona un versetto. Non solleva mai: un versetto mancato non e'
   * un problema, al massimo resta il gesto senza voce.
   * @param {string} event greet, morning, evening, night, welcome, pat, poke, lift, fall, pout, dizzy
   */
  async say(event) {
    if (!this.enabled || this.pending || this.isQuiet()) return false;
    const now = performance.now();
    if (now - this.lastAt < MIN_GAP_MS || now - (this.lastByEvent[event] ?? -Infinity) < SAME_GAP_MS) return false;
    if (Math.random() > (CHANCE[event] ?? 1)) return false;
    this.lastAt = now;
    this.lastByEvent[event] = now;
    this.pending = true;
    try {
      const response = await fetch(apiUrl('/api/vocal'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event }),
      });
      if (!response.ok) return false;
      const data = await response.json();
      // Nel frattempo e' partita una risposta vera: il versetto non serve piu'.
      if (!data.ok || this.isQuiet()) return false;
      await this.player.enqueue(data.speech);
      return true;
    } catch {
      return false;
    } finally {
      this.pending = false;
    }
  }
}
