/**
 * Presence: if the PC stays idle she dozes off, then falls asleep; when you
 * come back she wakes up and greets you.
 *
 * How long nobody has touched mouse and keyboard comes from Electron's main
 * process (`powerMonitor.getSystemIdleTime`, every few seconds), together
 * with screen lock/unlock and suspend/resume. In the browser this data is
 * missing, so she never falls asleep.
 */

import { readSetting, writeSetting } from './dom.js';

/** After how many seconds without input she gets drowsy, and when she falls asleep (defaults). */
export const DROWSY_AFTER = 120;
export const ASLEEP_AFTER = 300;
/** Below this threshold the user is "here" (polling arrives every 5 s). */
const ACTIVE_BELOW = 6;
/** She doesn't greet twice in a row if you come back and leave again right away. */
const WELCOME_GAP_MS = 60_000;

/** Sleep level for the body (see BodyAnimator.setSleep). */
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

  /** Times chosen in the panel, in minutes. */
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
   * A message from the main process: `{idle}` (seconds without input) or
   * `{event}` (lock-screen, unlock-screen, suspend, resume).
   * @param {{idle?: number, event?: string}} message
   * @param {boolean} busy she's speaking, thinking, dancing or held: no sleep
   */
  update(message, busy = false) {
    if (message?.event === 'unlock-screen' || message?.event === 'resume') {
      this.wake(true);
      return;
    }
    const idle = Number(message?.idle);
    if (!Number.isFinite(idle)) return;
    if (idle < ACTIVE_BELOW || busy || !this.enabled) {
      // If she was really asleep she greets you on return; if only drowsy, she perks up.
      this.wake(this.state === 'asleep');
      return;
    }
    if (idle >= this.asleepAfter) this._set('asleep', false);
    else if (idle >= this.drowsyAfter && this.state === 'awake') this._set('drowsy', false);
  }

  /** Someone touched her or wrote to her: wake up now, without waiting for the polling. */
  touch() {
    this.wake(false);
  }

  wake(welcome) {
    const now = Date.now();
    const greet = welcome && now - this.lastWelcome > WELCOME_GAP_MS;
    if (greet) this.lastWelcome = now;
    if (this.state === 'awake') {
      // Screen unlocked while awake: she greets anyway.
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
