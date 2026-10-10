/**
 * The right-click menu, in two forms, and the state they show.
 *
 * **Flame (her usual form): the island** (island.js), black like Coucou's,
 * born from her; she slides into it.
 *
 * **With the body (VRM): the two arc docks** beside the torso, inspired by
 * the reference image, for what an assistant needs and not a pet to look
 * after (no hunger or thirst):
 *
 *  - on the left the **status rings**: the brain (agent or model, green if
 *    it answers, amber spinning while it thinks, red if it's off), the voice
 *    (the ring fills with the volume while she speaks; click = mute), the
 *    microphone (level while listening; click = talk) and the music (beats in
 *    time with Spotify; click = dance or not) and the agents' usage (the ring
 *    is the Claude Code or Codex limit closest to running out; click = Work
 *    tab; only there if something is known);
 *  - on the right the **navigation**: dashboard, chat, character, back to
 *    the flame, engines, quit.
 *
 * It opens with a right-click on the character and closes by itself when
 * the cursor leaves. The arcs follow the torso: if she sits or lies down,
 * the docks go with her.
 */

import { LOCALE, t, tx } from './i18n.js';
import { iconSvg } from './icons.js';
import { Island } from './island.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const LEFT = [
  { id: 'agent', icon: 'agent', color: 'var(--ok)' },
  { id: 'voice', icon: 'volume', color: 'var(--accent)' },
  { id: 'mic', icon: 'mic', color: 'var(--info)' },
  { id: 'music', icon: 'music', color: 'var(--pink)' },
  { id: 'usage', icon: 'gauge', color: 'var(--ok)' },
];

/** What the limit windows are called, for the caption. */
const WINDOW_WORDS = { 300: t('5 hours'), 10080: t('week'), 43200: t('month') };

/** The limit's colour: green, amber from 70%, red from 90%. */
function usageColor(used) {
  if (used >= 90) return 'var(--danger)';
  if (used >= 70) return 'var(--warn)';
  return 'var(--ok)';
}

function resetWords(epoch) {
  if (!epoch) return '';
  const moment = new Date(epoch * 1000);
  const now = new Date();
  const clock = moment.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  if (moment.toDateString() === now.toDateString()) return t('resets at {time}', { time: clock });
  const days = Math.ceil((moment - now) / 86_400_000);
  return days <= 1 ? t('resets tomorrow at {time}', { time: clock }) : t('resets in {n} days', { n: days });
}

const RIGHT = [
  { id: 'dashboard', icon: 'dashboard', label: 'Dashboard' },
  { id: 'chat', icon: 'chat', label: 'Chat' },
  { id: 'character', icon: 'character', label: t('Character') },
  { id: 'form', icon: 'flame', label: t('Back to the flame') },
  { id: 'engines', icon: 'engines', label: t('Engines') },
  { id: 'power', icon: 'power', label: t('Quit Tsukumo') },
];

/** After how many ms without the cursor over the HUD it closes by itself. */
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
  /**
   * @param {HTMLElement} root the VRM's docks (above the canvas)
   * @param {HTMLElement} [islandRoot] the flame's island (under the canvas)
   */
  constructor(root, islandRoot) {
    this.root = root;
    this.visible = false;
    /** Called with the id of the pressed button. */
    this.onAction = () => {};

    this.engines = null;
    this.busy = 'idle';
    this.muted = false;
    this.mic = { available: false, enabled: false };
    this.musicPlaying = false;
    this.dancing = true;
    this.form = 'flame';
    /** 'island' around the flame, 'docks' beside the VRM. */
    this.layout = 'island';
    /** Without a body the body button offers to give her one. */
    this.bodiless = false;
    /** The limit closest to running out: `{agent, label, limit}` or null (see setUsage). */
    this.usage = null;
    /** The agent's steps in the current (or last) turn, for the island. */
    this.steps = [];
    /** Hidden buttons: they take no room on the arc. */
    this.hidden = new Set(['usage']);
    this.activeTab = null;
    this.frame = null;
    this._geometry = null;
    this._hideTimer = null;
    this._confirmTimer = null;
    this._hovered = null;
    this._levels = { voice: 0, mic: 0, music: 0 };

    this._build();
    this.island = islandRoot ? new Island(islandRoot, this) : null;
  }

  // ------------------------------------------------------------------ DOM
  _build() {
    this.root.classList.add('hud');
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.classList.add('hud-shapes');
    this.shapes = {};
    for (const side of ['left', 'right']) {
      const border = document.createElementNS(SVG_NS, 'path');
      border.classList.add('dock-border');
      const fill = document.createElementNS(SVG_NS, 'path');
      fill.classList.add('dock-fill');
      fill.dataset.solid = '';
      border.dataset.solid = '';
      this.svg.append(border, fill);
      this.shapes[side] = { border, fill };
    }
    this.root.append(this.svg);

    this.buttons = new Map();
    LEFT.forEach((item) => this.root.append(this._ringButton(item)));
    RIGHT.forEach((item) => this.root.append(this._navButton(item)));

    this.caption = document.createElement('div');
    this.caption.className = 'hud-caption';
    this.root.append(this.caption);

    this.root.addEventListener('pointerenter', () => this._keepOpen(), true);
    this.root.addEventListener('pointermove', () => this._keepOpen());
  }

  _ringButton(item) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'hud-btn ring-btn';
    button.dataset.solid = '';
    button.dataset.id = item.id;
    button.style.setProperty('--ring-color', item.color);
    button.innerHTML =
      '<svg class="ring" viewBox="0 0 40 40" aria-hidden="true">' +
      '<circle class="ring-track" cx="20" cy="20" r="17"/>' +
      '<circle class="ring-value" cx="20" cy="20" r="17"/></svg>' +
      `<span class="glyph">${iconSvg(item.icon, 17)}</span><span class="state-dot"></span>`;
    this._wire(button, item.id);
    this.buttons.set(item.id, button);
    return button;
  }

  _navButton(item) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'hud-btn nav-btn';
    button.dataset.solid = '';
    button.dataset.id = item.id;
    button.innerHTML = `<span class="glyph">${iconSvg(item.icon, 18)}</span>`;
    this._wire(button, item.id);
    this.buttons.set(item.id, button);
    return button;
  }

  _wire(button, id) {
    button.addEventListener('pointerenter', () => {
      this._hovered = id;
      this._renderCaption();
    });
    button.addEventListener('pointerleave', () => {
      if (this._hovered === id) this._hovered = null;
      this._renderCaption();
    });
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (id === 'power') {
        this._confirmPower();
        return;
      }
      this.onAction(id);
    });
    // Right-click on a button must not close/reopen the HUD.
    button.addEventListener('contextmenu', (event) => event.stopPropagation());
  }

  _confirmPower() {
    const button = this.buttons.get('power');
    if (button.classList.contains('confirm')) {
      clearTimeout(this._confirmTimer);
      this.onAction('power');
      return;
    }
    button.classList.add('confirm');
    this._renderCaption();
    this._confirmTimer = setTimeout(() => {
      button.classList.remove('confirm');
      this._renderCaption();
    }, 3000);
  }

  // ------------------------------------------------------------- visibility
  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  show() {
    this.visible = true;
    if (this.layout === 'island' && this.island) {
      document.body.classList.add('island-open');
      this.island.show(this.frame);
    } else {
      this.root.classList.add('visible');
      this._layout(true);
    }
    this._keepOpen();
  }

  hide() {
    this.visible = false;
    this.root.classList.remove('visible');
    this.island?.hide();
    document.body.classList.remove('island-open');
    clearTimeout(this._hideTimer);
    this.buttons.get('power')?.classList.remove('confirm');
  }

  /** The cursor is over the character or the menu: don't close. */
  touch() {
    if (this.visible) this._keepOpen();
  }

  _keepOpen() {
    clearTimeout(this._hideTimer);
    this._hideTimer = setTimeout(() => this.hide(), AUTO_HIDE_MS);
  }

  /** The top edge of the open menu, in window pixels: the speech bubble sits above it. */
  get top() {
    return this.layout === 'island' && this.island ? this.island.top : 0;
  }

  /** Where the flame must be while the island is open (window pixels), or null. */
  get flameSlot() {
    return this.visible && this.layout === 'island' && this.island ? this.island.slotRect() : null;
  }

  // --------------------------------------------------------------- geometry
  /**
   * Where the body is in the window: horizontal centre and chest height (or
   * the flame's bulb), in pixels. main.js updates it every frame while the
   * menu is open, and right before opening it.
   */
  setFrame(frame) {
    if (!frame) return;
    if (!this.visible) {
      this.frame = { x: frame.cx, y: frame.cy, cx: frame.cx, cy: frame.cy };
      return;
    }
    const previous = this.frame;
    // The torso sways with the breath: following it to the pixel would make the docks shake.
    const smooth = (a, b) => (previous ? a + (b - a) * 0.18 : b);
    this.frame = {
      x: previous?.x ?? frame.cx,
      y: previous?.y ?? frame.cy,
      cx: smooth(previous?.cx, frame.cx),
      cy: smooth(previous?.cy, frame.cy),
    };
    if (this.layout === 'docks') this._layout(false);
  }

  _layout(force) {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const cx = this.frame?.cx ?? W / 2;
    const cyRaw = this.frame?.cy ?? H * 0.38;

    const left = LEFT.filter((item) => !this.hidden.has(item.id));
    const right = RIGHT.filter((item) => !this.hidden.has(item.id));
    const thickness = Math.round(Math.min(46, Math.max(34, W * 0.15)));
    const button = thickness - 8;
    const gap = button + 6;
    const reach = Math.max(thickness, Math.min(cx, W - cx) - thickness / 2 - 3);
    const radius = reach * 1.35;
    const step = gap / radius;
    const halfSpan = (step * (Math.max(left.length, right.length) - 1)) / 2;
    const theta = halfSpan + (button / 2 + 7) / radius;
    const halfHeight = radius * Math.sin(theta) + thickness / 2 + 4;
    const cy = Math.min(Math.max(cyRaw, halfHeight), H - halfHeight);

    const key = `${W}x${H}|${Math.round(cx)}|${Math.round(cy)}|${left.length}|${right.length}`;
    if (!force && key === this._geometry) return;
    this._geometry = key;

    this.root.style.setProperty('--dock-thickness', `${thickness}px`);
    this.root.style.setProperty('--btn-size', `${button}px`);
    this.root.style.setProperty('--origin-x', `${cx}px`);
    this.root.style.setProperty('--origin-y', `${cy}px`);
    this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const sides = {
      left: { center: cx + (radius - reach), base: Math.PI, items: left, sign: -1 },
      right: { center: cx - (radius - reach), base: 0, items: right, sign: 1 },
    };
    for (const [id, node] of this.buttons) node.style.display = this.hidden.has(id) ? 'none' : '';
    for (const [side, spec] of Object.entries(sides)) {
      const point = (angle) => [spec.center + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
      // Top to bottom. On the left the angle goes down from π+θ to π-θ
      // (anticlockwise on screen, sweep 0); on the right it goes up from -θ to θ (sweep 1).
      const start = point(spec.base - spec.sign * theta);
      const end = point(spec.base + spec.sign * theta);
      const d =
        `M ${start[0].toFixed(1)} ${start[1].toFixed(1)} ` +
        `A ${radius.toFixed(1)} ${radius.toFixed(1)} 0 0 ${side === 'left' ? 0 : 1} ${end[0].toFixed(1)} ${end[1].toFixed(1)}`;
      this.shapes[side].fill.setAttribute('d', d);
      this.shapes[side].border.setAttribute('d', d);
      this.shapes[side].fill.style.strokeWidth = `${thickness}px`;
      this.shapes[side].border.style.strokeWidth = `${thickness + 2}px`;

      spec.items.forEach((item, index) => {
        // Top to bottom: the "top" angle is the one with a negative sine.
        const offset = (index - (spec.items.length - 1) / 2) * step;
        const angle = side === 'left' ? Math.PI - offset : offset;
        const [x, y] = point(angle);
        const node = this.buttons.get(item.id);
        node.style.left = `${(x - button / 2).toFixed(1)}px`;
        node.style.top = `${(y - button / 2).toFixed(1)}px`;
        node.style.transitionDelay = `${index * 35}ms`;
      });
    }

    this.caption.style.left = `${cx}px`;
    this._captionTop = cy + halfHeight + 6;
    this._placeCaption();
  }

  /** Under the docks, but inside the window even when it wraps. */
  _placeCaption() {
    const limit = window.innerHeight - this.caption.offsetHeight - 8;
    this.caption.style.top = `${Math.max(0, Math.min(this._captionTop ?? limit, limit))}px`;
  }

  // ------------------------------------------------------------------ state
  /** The engines' state from the backend (`engines` message). */
  setEngines(status) {
    this.engines = status;
    this._renderStatic();
  }

  /**
   * 'thinking' | 'speaking' | 'idle'. A new turn (she starts thinking) clears
   * the agent's steps; when done, they stay until the next one.
   */
  setBusy(state) {
    if (state === 'thinking' && this.busy !== 'thinking') this.steps = [];
    this.busy = state;
    this._renderStatic();
  }

  /** One step of the agent (`working` message: "reads main.js"). */
  setWorking(label) {
    const text = String(label || '').trim();
    if (!text) return;
    const step = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
    if (this.steps[this.steps.length - 1] !== step) this.steps = [...this.steps, step].slice(-STEPS_KEPT);
    this.island?.render();
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    this._renderStatic();
  }

  /** 'vrm' or 'flame': the body has the docks, the flame the island. */
  setForm(form) {
    this.form = form === 'vrm' ? 'vrm' : 'flame';
    const layout = this.form === 'vrm' ? 'docks' : 'island';
    if (layout !== this.layout) {
      if (this.visible) this.hide();
      this.layout = layout;
    }
    this._renderCaption();
    this.island?.render();
  }

  /** Without a body the body pill offers to give her one. */
  setBodiless(value) {
    this.bodiless = Boolean(value);
    this.island?.render();
  }

  /** Whether she dances to the music (the music pill says it and changes it). */
  setDancing(value) {
    this.dancing = Boolean(value);
    this.island?.render();
  }

  /** The flame's colour (0xRRGGBB): in the island's card it gives her a halo of that colour. */
  setTint(color) {
    const rgb = [(color >> 16) & 255, (color >> 8) & 255, color & 255].join(', ');
    this.island?.root.style.setProperty('--tint', rgb);
  }

  /** Colour of a brain state (for the island too). */
  stateColor(state) {
    return STATE_COLORS[state] ?? STATE_COLORS.unknown;
  }

  /**
   * The agents' usage (the backend's `usage` message). The ring shows the
   * limit closest to running out, preferring the active brain if it's one of them.
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
    this._setHidden('usage', !best);
    if (best) {
      const color = usageColor(best.limit.used);
      this._ring('usage', Math.max(0.04, best.limit.used / 100), color);
      this._dot('usage', color);
    }
    this._renderCaption();
    this.island?.render();
  }

  _setHidden(id, hidden) {
    if (this.hidden.has(id) === hidden) return;
    if (hidden) this.hidden.add(id);
    else this.hidden.delete(id);
    if (this._hovered === id) this._hovered = null;
    if (this.layout === 'docks') this._layout(true);
  }

  setMic(state) {
    this.mic = { ...this.mic, ...state };
    this._renderStatic();
  }

  setMusic(playing) {
    this.musicPlaying = Boolean(playing);
    this._renderStatic();
  }

  /** What the flame wears (`selection` as in the panel, 'auto' too) and her colour: for the island's wardrobe. */
  setWardrobe(selection, color) {
    this.wardrobe = { selection, color };
    this.island?.render();
  }

  /** Tab open in the panel (to highlight the right button), or null. */
  setActiveTab(tab) {
    this.activeTab = tab;
    for (const item of RIGHT) {
      this.buttons.get(item.id).classList.toggle('active', item.id === tab);
    }
    this.island?.render();
  }

  /** Instant levels, every frame: speaking voice, microphone, music. */
  update({ voice = 0, mic = 0, music = 0 } = {}) {
    if (!this.visible || this.layout !== 'docks') return;
    const ease = (from, to) => from + (to - from) * 0.35;
    this._levels.voice = ease(this._levels.voice, voice);
    this._levels.mic = ease(this._levels.mic, mic);
    this._levels.music = ease(this._levels.music, music);

    if (this.busy === 'speaking' && !this.muted) this._ring('voice', 0.15 + this._levels.voice * 0.85);
    if (this.mic.enabled) this._ring('mic', 0.1 + Math.min(1, this._levels.mic * 3) * 0.9);
    if (this.musicPlaying) this._ring('music', 0.25 + this._levels.music * 0.75);
  }

  _ring(id, fraction, color) {
    const button = this.buttons.get(id);
    const value = button.querySelector('.ring-value');
    const circumference = 2 * Math.PI * 17;
    value.style.strokeDasharray = `${circumference}`;
    value.style.strokeDashoffset = `${circumference * (1 - Math.max(0, Math.min(1, fraction)))}`;
    if (color) button.style.setProperty('--ring-color', color);
  }

  _dot(id, color) {
    this.buttons.get(id).style.setProperty('--dot-color', color ?? 'transparent');
  }

  _renderStatic() {
    const llm = this.engines?.llm;
    const agentState = this.busy === 'thinking' ? 'thinking' : llm?.state ?? 'unknown';
    const agent = this.buttons.get('agent');
    agent.classList.toggle('spinning', agentState === 'thinking');
    const agentFraction = { online: 1, degraded: 0.66, offline: 0.22, unknown: 0.4, thinking: 0.3 }[agentState] ?? 0.4;
    this._ring('agent', agentFraction, STATE_COLORS[agentState]);
    this._dot('agent', STATE_COLORS[agentState]);

    const tts = this.engines?.tts;
    const voice = this.buttons.get('voice');
    voice.querySelector('.glyph').innerHTML = iconSvg(this.muted ? 'volumeOff' : 'volume', 17);
    voice.classList.toggle('dim', this.muted);
    if (this.busy !== 'speaking' || this.muted) {
      this._ring('voice', this.muted ? 0 : tts?.state === 'online' ? 1 : 0.5);
    }
    this._dot('voice', this.muted ? STATE_COLORS.off : STATE_COLORS[tts?.state ?? 'unknown']);

    const mic = this.buttons.get('mic');
    const sttOff = (this.engines?.stt?.state ?? 'off') === 'off';
    mic.querySelector('.glyph').innerHTML = iconSvg(sttOff ? 'micOff' : 'mic', 17);
    mic.classList.toggle('dim', sttOff || !this.mic.enabled);
    if (!this.mic.enabled) this._ring('mic', 0);
    this._dot('mic', this.mic.enabled ? 'var(--info)' : sttOff ? null : STATE_COLORS.off);

    const music = this.buttons.get('music');
    music.classList.toggle('dim', !this.musicPlaying);
    if (!this.musicPlaying) this._ring('music', 0);
    this._dot('music', this.musicPlaying ? 'var(--pink)' : null);

    this._renderCaption();
    this.island?.render();
  }

  _renderCaption() {
    const text = this._captionFor(this._hovered);
    this.caption.textContent = text;
    this.caption.classList.toggle('shown', Boolean(text));
    if (text) this._placeCaption();
  }

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
        if (!this.musicPlaying) return t('No music from Spotify');
        return this.dancing ? t('Dancing to Spotify — click to stop') : t('Still — click to dance to Spotify');
      case 'usage': {
        if (!this.usage) return '';
        const { agent, limit } = this.usage;
        const window = WINDOW_WORDS[limit.windowMinutes] ?? t('limit');
        const reset = resetWords(limit.resetsAt);
        return `${agent}: ${Math.round(limit.used)}% (${window})${reset ? `, ${reset}` : ''}`;
      }
      case 'power': {
        const confirming = this.buttons.get('power').classList.contains('confirm') || this.island?.powerPill.classList.contains('confirm');
        return confirming ? t('Click again to quit') : t('Quit Tsukumo');
      }
      case 'form':
        if (this.form === 'vrm') return t('Back to the flame');
        return this.bodiless ? t('Give her a 3D body (optional)') : t('Enter the 3D body');
      default: {
        const nav = RIGHT.find((item) => item.id === id);
        return nav ? nav.label : '';
      }
    }
  }
}
