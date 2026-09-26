/**
 * Presenza: se il PC resta fermo si assopisce, poi si addormenta; quando torni
 * si sveglia e ti saluta.
 *
 * Da quanto tempo nessuno tocca mouse e tastiera lo dice il processo main di
 * Electron (`powerMonitor.getSystemIdleTime`, ogni pochi secondi), insieme a
 * blocco/sblocco dello schermo e sospensione/ripresa. Nel browser questi dati
 * non ci sono, quindi non si addormenta mai.
 */

import { readSetting, writeSetting } from './dom.js';

/** Dopo quanti secondi senza input si fa assonnata, e quando si addormenta (default). */
export const DROWSY_AFTER = 120;
export const ASLEEP_AFTER = 300;
/** Sotto questa soglia l'utente e' "qui" (il polling arriva ogni 5 s). */
const ACTIVE_BELOW = 6;
/** Non saluta due volte di fila se torni e riparti subito. */
const WELCOME_GAP_MS = 60_000;

/** Livello di sonno per il corpo (vedi BodyAnimator.setSleep). */
export const SLEEP_LEVEL = { awake: 0, drowsy: 0.5, asleep: 1 };

export class Presence {
  /**
   * @param {object} options
   * @param {(state: string, info: {welcome: boolean, previous: string}) => void} options.onChange
   */
  constructor({ onChange }) {
    this.onChange = onChange;
    this.enabled = readSetting('dc:sleep', true);
    this.drowsyAfter = readSetting('dc:sleep-drowsy', DROWSY_AFTER / 60) * 60;
    this.asleepAfter = readSetting('dc:sleep-asleep', ASLEEP_AFTER / 60) * 60;
    this.state = 'awake';
    this.lastWelcome = -Infinity;
  }

  /** Tempi scelti dal pannello, in minuti. */
  setTimes(drowsyMinutes, asleepMinutes) {
    this.drowsyAfter = Math.max(1, Number(drowsyMinutes) || 2) * 60;
    this.asleepAfter = Math.max(this.drowsyAfter / 60 + 1, Number(asleepMinutes) || 5) * 60;
  }

  setEnabled(value) {
    this.enabled = Boolean(value);
    writeSetting('dc:sleep', this.enabled);
    if (!this.enabled) this.wake(false);
  }

  /**
   * Un messaggio dal processo main: `{idle}` (secondi senza input) oppure
   * `{event}` (lock-screen, unlock-screen, suspend, resume).
   * @param {{idle?: number, event?: string}} message
   * @param {boolean} busy sta parlando, pensando, ballando o e' in mano: niente sonno
   */
  update(message, busy = false) {
    if (message?.event === 'unlock-screen' || message?.event === 'resume') {
      this.wake(true);
      return;
    }
    const idle = Number(message?.idle);
    if (!Number.isFinite(idle)) return;
    if (idle < ACTIVE_BELOW || busy || !this.enabled) {
      // Se dormiva davvero, al ritorno saluta; se era solo assonnata, si riprende.
      this.wake(this.state === 'asleep');
      return;
    }
    if (idle >= this.asleepAfter) this._set('asleep', false);
    else if (idle >= this.drowsyAfter && this.state === 'awake') this._set('drowsy', false);
  }

  /** Qualcuno l'ha toccata o le ha scritto: sveglia subito, senza aspettare il polling. */
  touch() {
    this.wake(false);
  }

  wake(welcome) {
    const now = Date.now();
    const greet = welcome && now - this.lastWelcome > WELCOME_GAP_MS;
    if (greet) this.lastWelcome = now;
    if (this.state === 'awake') {
      // Sblocco dello schermo da sveglia: saluta lo stesso.
      if (greet) this.onChange?.('awake', { welcome: true, previous: 'awake' });
      return;
    }
    this._set('awake', greet);
  }

  _set(state, welcome) {
    if (state === this.state) return;
    const previous = this.state;
    this.state = state;
    this.onChange?.(state, { welcome, previous });
  }
}
