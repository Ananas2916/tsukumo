/**
 * I due dock ad arco ai lati del personaggio.
 *
 * Ispirati all'immagine di riferimento, ma per quello che serve a un
 * assistente e non a un animaletto da accudire (niente fame e sete):
 *
 *  - a sinistra gli **anelli di stato**: il cervello (agente o modello,
 *    verde se risponde, ambra che gira mentre pensa, rosso se e' spento), la
 *    voce (l'anello si riempie col volume mentre parla; clic = muta), il
 *    microfono (livello mentre ascolta; clic = parla) e la musica (batte a
 *    tempo con Spotify; clic = balla o no);
 *  - a destra la **navigazione**: chat, personaggio, motori, spegni.
 *
 * Si apre col tasto destro sul personaggio e si richiude da solo quando il
 * cursore se ne va. Gli archi seguono il busto: se si siede o si sdraia, i
 * dock vanno con lei.
 */

import { iconSvg } from './icons.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const LEFT = [
  { id: 'agent', icon: 'agent', color: 'var(--ok)' },
  { id: 'voice', icon: 'volume', color: 'var(--accent)' },
  { id: 'mic', icon: 'mic', color: 'var(--info)' },
  { id: 'music', icon: 'music', color: 'var(--pink)' },
];

const RIGHT = [
  { id: 'chat', icon: 'chat', label: 'Chat' },
  { id: 'character', icon: 'character', label: 'Personaggio' },
  { id: 'engines', icon: 'engines', label: 'Motori' },
  { id: 'power', icon: 'power', label: 'Chiudi Tsukumo' },
];

/** Dopo quanti ms senza il cursore sopra il HUD si richiude da solo. */
const AUTO_HIDE_MS = 7000;

const STATE_COLORS = {
  online: 'var(--ok)',
  degraded: 'var(--warn)',
  offline: 'var(--danger)',
  unknown: 'var(--muted)',
  thinking: 'var(--warn)',
  off: 'var(--muted)',
};

const STATE_WORDS = {
  online: 'pronto',
  degraded: 'con qualche problema',
  offline: 'spento',
  unknown: 'in verifica',
  off: 'spento',
};

export class Hud {
  /** @param {HTMLElement} root */
  constructor(root) {
    this.root = root;
    this.visible = false;
    /** Chiamato con l'id del bottone premuto. */
    this.onAction = () => {};

    this.engines = null;
    this.busy = 'idle';
    this.muted = false;
    this.mic = { available: false, enabled: false };
    this.musicPlaying = false;
    this.activeTab = null;
    this.frame = null;
    this._geometry = null;
    this._hideTimer = null;
    this._confirmTimer = null;
    this._hovered = null;
    this._levels = { voice: 0, mic: 0, music: 0 };

    this._build();
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
    // Il tasto destro su un bottone non deve richiudere/riaprire il HUD.
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

  // ------------------------------------------------------- visibilita'
  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  show() {
    this.visible = true;
    this.root.classList.add('visible');
    this._layout(true);
    this._keepOpen();
  }

  hide() {
    this.visible = false;
    this.root.classList.remove('visible');
    clearTimeout(this._hideTimer);
    this.buttons.get('power')?.classList.remove('confirm');
  }

  /** Il cursore e' sopra il personaggio o sui dock: non richiudere. */
  touch() {
    if (this.visible) this._keepOpen();
  }

  _keepOpen() {
    clearTimeout(this._hideTimer);
    this._hideTimer = setTimeout(() => this.hide(), AUTO_HIDE_MS);
  }

  // ------------------------------------------------------------ geometria
  /**
   * Dove sta il corpo nella finestra: centro orizzontale e altezza del petto,
   * in pixel. Lo aggiorna main.js a ogni frame mentre il HUD e' aperto.
   */
  setFrame(frame) {
    if (!frame) return;
    const previous = this.frame;
    // Il busto oscilla col respiro: seguirlo al pixel farebbe tremare i dock.
    const smooth = (a, b) => (previous ? a + (b - a) * 0.18 : b);
    this.frame = {
      cx: smooth(previous?.cx, frame.cx),
      cy: smooth(previous?.cy, frame.cy),
    };
    if (this.visible) this._layout(false);
  }

  _layout(force) {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const cx = this.frame?.cx ?? W / 2;
    const cyRaw = this.frame?.cy ?? H * 0.38;

    const thickness = Math.round(Math.min(46, Math.max(34, W * 0.15)));
    const button = thickness - 8;
    const gap = button + 6;
    const reach = Math.max(thickness, Math.min(cx, W - cx) - thickness / 2 - 3);
    const radius = reach * 1.35;
    const step = gap / radius;
    const halfSpan = (step * (LEFT.length - 1)) / 2;
    const theta = halfSpan + (button / 2 + 7) / radius;
    const halfHeight = radius * Math.sin(theta) + thickness / 2 + 4;
    const cy = Math.min(Math.max(cyRaw, halfHeight), H - halfHeight);

    const key = `${W}x${H}|${Math.round(cx)}|${Math.round(cy)}`;
    if (!force && key === this._geometry) return;
    this._geometry = key;

    this.root.style.setProperty('--dock-thickness', `${thickness}px`);
    this.root.style.setProperty('--btn-size', `${button}px`);
    this.root.style.setProperty('--origin-x', `${cx}px`);
    this.root.style.setProperty('--origin-y', `${cy}px`);
    this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const sides = {
      left: { center: cx + (radius - reach), base: Math.PI, items: LEFT, sign: -1 },
      right: { center: cx - (radius - reach), base: 0, items: RIGHT, sign: 1 },
    };
    for (const [side, spec] of Object.entries(sides)) {
      const point = (angle) => [spec.center + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
      // Dall'alto in basso. A sinistra l'angolo scende da π+θ a π-θ (verso
      // antiorario sullo schermo, sweep 0); a destra sale da -θ a θ (sweep 1).
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
        // Dall'alto in basso: l'angolo "in alto" e' quello con seno negativo.
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
    this.caption.style.top = `${Math.min(H - 30, cy + halfHeight + 6)}px`;
  }

  // ---------------------------------------------------------------- stato
  /** Stato dei motori dal backend (messaggio `engines`). */
  setEngines(status) {
    this.engines = status;
    this._renderStatic();
  }

  /** 'thinking' | 'speaking' | 'idle' */
  setBusy(state) {
    this.busy = state;
    this._renderStatic();
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    this._renderStatic();
  }

  setMic(state) {
    this.mic = { ...this.mic, ...state };
    this._renderStatic();
  }

  setMusic(playing) {
    this.musicPlaying = Boolean(playing);
    this._renderStatic();
  }

  /** Scheda aperta nel pannello (per evidenziare il bottone giusto), o null. */
  setActiveTab(tab) {
    this.activeTab = tab;
    for (const item of RIGHT) {
      this.buttons.get(item.id).classList.toggle('active', item.id === tab);
    }
  }

  /** Livelli istantanei, a ogni frame: voce che parla, microfono, musica. */
  update({ voice = 0, mic = 0, music = 0 } = {}) {
    if (!this.visible) return;
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
  }

  _renderCaption() {
    const text = this._captionFor(this._hovered);
    this.caption.textContent = text;
    this.caption.classList.toggle('shown', Boolean(text));
  }

  _captionFor(id) {
    const llm = this.engines?.llm;
    switch (id) {
      case 'agent': {
        if (!llm) return 'Cervello: in verifica';
        if (this.busy === 'thinking') return `${llm.label} sta pensando…`;
        const detail = llm.state !== 'online' && llm.detail ? ` — ${llm.detail}` : '';
        return `${llm.label}: ${STATE_WORDS[llm.state] ?? llm.state}${detail}`;
      }
      case 'voice': {
        const tts = this.engines?.tts;
        if (this.muted) return 'Voce spenta — clic per riaccenderla';
        return `${tts?.label ?? 'Voce'}${tts?.voice ? ` · ${tts.voice}` : ''} — clic per silenziarla`;
      }
      case 'mic': {
        const stt = this.engines?.stt;
        if (!stt || stt.state === 'off') return 'Ascolto spento — clic per sceglierne uno';
        return this.mic.enabled ? 'Ti sto ascoltando — clic per smettere' : `${stt.label} — clic per parlarle`;
      }
      case 'music':
        return this.musicPlaying ? 'Balla con Spotify — clic per smettere' : 'Nessuna musica da Spotify';
      case 'power':
        return this.buttons.get('power').classList.contains('confirm') ? 'Clicca ancora per chiudere' : 'Chiudi Tsukumo';
      default: {
        const nav = RIGHT.find((item) => item.id === id);
        return nav ? nav.label : '';
      }
    }
  }
}
