/**
 * Vocals: short exclamations in the chosen voice ("Hii!" when she greets,
 * "Ehehe!" when petted, "Waah!" when she falls).
 *
 * The backend synthesizes them with the engine and voice in use, in the
 * voice's language, and caches them (`POST /api/vocal`). Here we decide
 * *when*: never over a reply, never when muted, and not on every single
 * click, or they go from cute to annoying.
 */

import { apiUrl } from './config.js';
import { readSetting, writeSetting } from './dom.js';

/** Minimum pause between any two vocals, and between two identical ones (ms). */
const MIN_GAP_MS = 1200;
const SAME_GAP_MS = 4000;
/** Reactions to touches don't always speak: it would feel like a toy. */
const CHANCE = { pat: 0.75, poke: 0.6, lift: 0.7, fall: 0.8, pout: 1, dizzy: 1 };

/** A greeting that fits the hour: "Good morning!" in the morning, "Good evening!" at night. */
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
   * @param {() => boolean} options.isQuiet true if she must keep quiet (muted, thinking, speaking)
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
   * Asks for a vocal and plays it. Never throws: a missed vocal is not a
   * problem, at worst the gesture stays without a voice.
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
      // A real reply started in the meantime: the vocal is no longer needed.
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
