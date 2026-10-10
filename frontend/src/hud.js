/**
 * The right-click menu's state: what the island (island.js) shows.
 *
 * Here are kept the engines and their state, what she's doing (thinking,
 * speaking, the agent's steps), voice and microphone, Spotify, the agents'
 * usage limits and her wardrobe; the island only draws them. It opens with a
 * right-click on her and closes by itself when the cursor leaves it.
 */

import { LOCALE, t, tx } from './i18n.js';
import { Island } from './island.js';

/** What the limit windows are called, for the caption. */
const WINDOW_WORDS = { 300: t('5 hours'), 10080: t('week'), 43200: t('month') };

function resetWords(epoch) {
  if (!epoch) return '';
  const moment = new Date(epoch * 1000);
  const now = new Date();
  const clock = moment.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  if (moment.toDateString() === now.toDateString()) return t('resets at {time}', { time: clock });
  const days = Math.ceil((moment - now) / 86_400_000);
  return days <= 1 ? t('resets tomorrow at {time}', { time: clock }) : t('resets in {n} days', { n: days });
}

/** The island's buttons that only open something: their caption is their name. */
const NAMES = {
  dashboard: 'Dashboard',
  chat: 'Chat',
  character: t('Character'),
  engines: t('Engines'),
};

/** After how many ms without the cursor over the island it closes by itself. */
const AUTO_HIDE_MS = 7000;

/** How many agent steps are remembered for the island (it shows the last ones). */
const STEPS_KEPT = 8;

const STATE_COLORS = {
  online: 'var(--ok)',
  degraded: 'var(--warn)',
  offline: 'var(--danger)',
  unknown: 'var(--muted)',
  thinking: 'var(--warn)',
  off: 'var(--muted)',
};

const STATE_WORDS = {
  online: t('ready'),
  degraded: t('having some trouble'),
  offline: t('off'),
  unknown: t('checking'),
  off: t('off'),
};

export class Hud {
  /** @param {HTMLElement} islandRoot the island's container (under the canvas) */
  constructor(islandRoot) {
    this.visible = false;
    /** Called with the id of the pressed button (and a detail, for the wardrobe and the player). */
    this.onAction = () => {};
    /** The island asks to widen the window (true) or to narrow it again (false). */
    this.onIslandShape = null;
    /** Where she is now (window pixels), for the island to grow from her. */
    this.locate = null;

    this.engines = null;
    this.busy = 'idle';
    this.muted = false;
    this.mic = { available: false, enabled: false };
    /** Spotify, from its window: `{open, playing, artist, title}`. */
    this.music = { open: false, playing: false, artist: '', title: '' };
    this.dancing = true;
    /** The limit closest to running out: `{agent, label, limit}` or null (see setUsage). */
    this.usage = null;
    /** The agent's steps in the current (or last) turn, for the island. */
    this.steps = [];
    this.activeTab = null;
    this.frame = null;
    this._hideTimer = null;

    this.island = new Island(islandRoot, this);
  }

  /** Spotify is playing (the dance pill shows only then). */
  get musicPlaying() {
    return this.music.playing;
  }

  // ------------------------------------------------------------- visibility
  show() {
    this.visible = true;
    document.body.classList.add('island-open');
    this.island.show(this.frame);
    this._keepOpen();
  }

  hide() {
    this.visible = false;
    this.island.hide();
    document.body.classList.remove('island-open');
    clearTimeout(this._hideTimer);
  }

  /** The cursor is over her or the island: don't close. */
  touch() {
    if (this.visible) this._keepOpen();
  }

  _keepOpen() {
    clearTimeout(this._hideTimer);
    this._hideTimer = setTimeout(() => this.hide(), AUTO_HIDE_MS);
  }

  /** The top edge of the open island, in window pixels: the speech bubble sits above it. */
  get top() {
    return this.island.top;
  }

  /** Where the flame must be while the island is open (window pixels), or null. */
  get flameSlot() {
    return this.visible ? this.island.slotRect() : null;
  }

  /** Where she is in the window (centre of the bulb), right before opening: the island grows from there. */
  setFrame(frame) {
    if (frame) this.frame = { x: frame.cx, y: frame.cy };
  }

  // ------------------------------------------------------------------ state
  /** The engines' state from the backend (`engines` message). */
  setEngines(status) {
    this.engines = status;
    this.island.render();
  }

  /**
   * 'thinking' | 'speaking' | 'idle'. A new turn (she starts thinking) clears
   * the agent's steps; when done, they stay until the next one.
   */
  setBusy(state) {
    if (state === 'thinking' && this.busy !== 'thinking') this.steps = [];
    this.busy = state;
    this.island.render();
  }

  /** One step of the agent (`working` message: "reads main.js"). */
  setWorking(label) {
    const text = String(label || '').trim();
    if (!text) return;
    const step = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
    if (this.steps[this.steps.length - 1] !== step) this.steps = [...this.steps, step].slice(-STEPS_KEPT);
    this.island.render();
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    this.island.render();
  }

  /** Whether she dances to the music (the dance pill says it and changes it). */
  setDancing(value) {
    this.dancing = Boolean(value);
    this.island.render();
  }

  /** Her colour (0xRRGGBB): in the island's card it gives her a halo of that colour. */
  setTint(color) {
    const rgb = [(color >> 16) & 255, (color >> 8) & 255, color & 255].join(', ');
    this.island.root.style.setProperty('--tint', rgb);
  }

  /** Colour of a brain state. */
  stateColor(state) {
    return STATE_COLORS[state] ?? STATE_COLORS.unknown;
  }

  /**
   * The agents' usage (the backend's `usage` message): the limit closest to
   * running out, preferring the active brain if it's one of them.
   */
  setUsage(snapshot, activeBrain) {
    let best = null;
    for (const agent of snapshot?.agents ?? []) {
      for (const limit of agent.limits ?? []) {
        const score = limit.used + (agent.id === activeBrain ? 1000 : 0);
        if (!best || score > best.score) best = { score, agent: agent.label, limit };
      }
    }
    this.usage = best;
    this.island.render();
  }

  setMic(state) {
    this.mic = { ...this.mic, ...state };
    this.island.render();
  }

  /** What Spotify is doing, from its window (electron/spotify.js). */
  setMusic(status) {
    this.music = {
      open: Boolean(status?.open),
      playing: Boolean(status?.playing),
      artist: String(status?.artist ?? ''),
      title: String(status?.title ?? ''),
    };
    this.island.render();
  }

  /** What she wears (`selection` as in the panel, 'auto' too) and her colour: for the island's wardrobe. */
  setWardrobe(selection, color) {
    this.wardrobe = { selection, color };
    this.island.render();
  }

  /** Tab open in the panel (to highlight the right button), or null. */
  setActiveTab(tab) {
    this.activeTab = tab;
    this.island.render();
  }

  /** The words shown above the island for the button under the cursor. */
  _captionFor(id) {
    const llm = this.engines?.llm;
    switch (id) {
      case 'agent': {
        if (!llm) return t('Brain: checking');
        if (this.busy === 'thinking') return t('{name} is thinking…', { name: llm.label });
        const detail = llm.state !== 'online' && llm.detail ? ` — ${tx(llm.detail)}` : '';
        return `${llm.label}: ${STATE_WORDS[llm.state] ?? llm.state}${detail}`;
      }
      case 'voice': {
        const tts = this.engines?.tts;
        if (this.muted) return t('Voice off — click to turn it back on');
        return t('{voice} — click to mute it', { voice: `${tts?.label ?? t('Voice')}${tts?.voice ? ` · ${tts.voice}` : ''}` });
      }
      case 'mic': {
        const stt = this.engines?.stt;
        if (!stt || stt.state === 'off') return t('Listening off — click to choose one');
        return this.mic.enabled ? t("I'm listening — click to stop") : t('{name} — click to talk to her', { name: stt.label });
      }
      case 'music':
        return this.dancing ? t('Dancing to Spotify — click to stop') : t('Still — click to dance to Spotify');
      case 'player': {
        const track = [this.music.artist, this.music.title].filter(Boolean).join(' — ');
        if (this.music.playing) return track || 'Spotify';
        return t('Spotify is paused');
      }
      case 'previous':
        return t('Previous track');
      case 'toggle':
        return this.music.playing ? t('Pause') : t('Play');
      case 'next':
        return t('Next track');
      case 'usage': {
        if (!this.usage) return '';
        const { agent, limit } = this.usage;
        const window = WINDOW_WORDS[limit.windowMinutes] ?? t('limit');
        const reset = resetWords(limit.resetsAt);
        return `${agent}: ${Math.round(limit.used)}% (${window})${reset ? `, ${reset}` : ''}`;
      }
      case 'power':
        return this.island.powerPill.classList.contains('confirm') ? t('Click again to quit') : t('Quit Tsukumo');
      default:
        return NAMES[id] ?? '';
    }
  }
}
