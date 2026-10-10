/**
 * Tsukumo's menu: a black island, like Coucou's.
 *
 * On right-click the island is born from her (it spreads from her centre)
 * and she slides into it, left of the card, like Mochi in hers: the flame
 * stays the centre of everything. At the top the tabs (chat, dashboard,
 * character) and the tools (voice, microphone, engines); in the card the
 * brain and what it's doing, step by step (done, in progress), and the usage
 * limit closest to running out; below, the pills: the wardrobe, dancing and
 * a small Spotify player while Spotify is open, quit.
 *
 * It's a wide, low strip (Coucou's is 4:1; ours keeps room for her and the
 * steps): about 448 x 210 at scale 1. Grabbing its black, not a button, moves
 * it around the screen with her inside; when it closes she drops from there.
 *
 * It sits UNDER the canvas, so the flame is drawn over the island's black.
 * While it's open the canvas doesn't take clicks (`body.island-open`) and
 * they reach the buttons; a click on her in the card is a pat.
 *
 * The state (engines, voice, agent steps...) is kept by Hud: here we only
 * draw. Text coming from agents always goes into textContent, never markup.
 */

import { OUTFIT_LABELS, parseOutfit, seasonalOutfit, SELECTIONS } from './flame/wardrobe.js';
import { t, tx } from './i18n.js';
import { iconSvg } from './icons.js';
import { outfitPreview } from './panel/wardrobe-art.js';

/**
 * Design height: the window at scale 1 is 460 px tall. The island's scale
 * follows the height (which doesn't change), the width follows the window:
 * when open it widens it to 460 (electron/main.js, setIslandWide).
 */
const DESIGN_HEIGHT = 460;
/** Below this design width the window hasn't widened (yet). */
const WIDE_FROM = 400;
/** A press that moves less than this (px) is a click, not a drag. */
const DRAG_FROM = 4;

const TABS = [
  { id: 'chat', icon: 'chat' },
  { id: 'dashboard', icon: 'dashboard' },
  { id: 'character', icon: 'character' },
];
const TOOLS = [
  { id: 'voice', icon: 'volume' },
  { id: 'mic', icon: 'mic' },
  { id: 'engines', icon: 'engines' },
];
/** The small Spotify player beside the dance pill. */
const PLAYER = [
  { id: 'previous', icon: 'skipBack' },
  { id: 'toggle', icon: 'play' },
  { id: 'next', icon: 'skipForward' },
];

/** How many agent steps are shown in the card. */
const STEPS_SHOWN = 3;

const WINDOW_WORDS = { 300: t('5 hours'), 10080: t('week'), 43200: t('month') };

function usageColor(used) {
  if (used >= 90) return 'var(--danger)';
  if (used >= 70) return 'var(--warn)';
  return 'var(--ok)';
}

function node(tag, className, attrs = {}) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  return element;
}

export class Island {
  /**
   * @param {HTMLElement} root the container (`#island`), before the canvas in the DOM
   * @param {import('./hud.js').Hud} hud keeps the state and receives the actions
   */
  constructor(root, hud) {
    this.root = root;
    this.hud = hud;
    this.open = false;
    this.buttons = new Map();
    this._confirmTimer = null;
    this._drag = null;
    this._build();
  }

  // ------------------------------------------------------------------ DOM
  _build() {
    this.box = node('div', 'island');
    this.box.dataset.solid = '';

    const top = node('div', 'island-top');
    const tabs = node('div', 'island-group');
    const tools = node('div', 'island-group');
    for (const item of TABS) tabs.append(this._icon(item));
    for (const item of TOOLS) tools.append(this._icon(item));
    top.append(tabs, tools);

    // The card: on the left the slot for her, on the right brain, steps and usage.
    this.card = node('div', 'island-card');
    this.card.addEventListener('click', () => this.hud.onAction('agent'));
    this.slot = node('button', 'island-slot', { type: 'button', 'aria-label': 'Tsukumo' });
    this.slot.addEventListener('click', (event) => {
      event.stopPropagation();
      this.hud.onAction('flame');
    });
    const info = node('div', 'island-info');
    const title = node('div', 'island-title');
    this.dot = node('span', 'island-dot');
    this.brain = node('strong');
    this.model = node('small');
    title.append(this.dot, this.brain, this.model);
    this.steps = node('ul', 'island-steps');
    this.usage = node('button', 'island-usage', { type: 'button' });
    this.usageLabel = node('span');
    this.usageValue = node('b');
    const usageHead = node('span', 'island-usage-head');
    usageHead.append(this.usageLabel, this.usageValue);
    this.usageBar = node('span', 'island-bar');
    this.usageBar.append(node('i'));
    this.usage.append(usageHead, this.usageBar);
    this.usage.addEventListener('click', (event) => {
      event.stopPropagation();
      this.hud.onAction('usage');
    });
    this._hover(this.usage, 'usage');
    info.append(title, this.steps, this.usage);
    this.info = info;
    // The closet: instead of brain and steps, the card shows what she can wear.
    this.closet = node('div', 'island-closet hidden');
    this.closetHead = node('div', 'island-closet-head');
    this.closetGrid = node('div', 'island-closet-grid');
    this.closet.append(this.closetHead, this.closetGrid);
    this.closet.addEventListener('click', (event) => event.stopPropagation());
    this.card.append(this.slot, info, this.closet);

    // The pills: the wardrobe, the dance and the player (while Spotify is open), quit.
    const pills = node('div', 'island-pills');
    this.wardrobePill = this._pill('wardrobe', 'hanger');
    this.musicPill = this._pill('music', null);
    this.player = node('div', 'island-player');
    this.player.dataset.id = 'player';
    for (const item of PLAYER) this.player.append(this._playerButton(item));
    this._hover(this.player, 'player');
    this.powerPill = this._pill('power', 'power');
    this.powerPill.classList.add('power');
    pills.append(this.wardrobePill, this.musicPill, this.player, this.powerPill);

    this.caption = node('div', 'island-caption');
    this.box.append(top, this.card, pills);
    this.root.append(this.caption, this.box);
    this.root.addEventListener('pointermove', () => this.hud.touch());
    this.root.addEventListener('pointerdown', () => this.hud.touch());
    window.addEventListener('resize', () => this.relayout());
    // Right-click on the island closes it again (as on her); not on the buttons.
    this.box.addEventListener('contextmenu', (event) => event.target !== this.box && event.stopPropagation());
    this._bindDrag();
  }

  _icon(item) {
    const button = node('button', 'island-icon', { type: 'button' });
    button.dataset.id = item.id;
    button.innerHTML = iconSvg(item.icon, 17);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      this.hud.onAction(item.id);
    });
    this._hover(button, item.id);
    this.buttons.set(item.id, button);
    return button;
  }

  _pill(id, icon) {
    const button = node('button', 'island-pill', { type: 'button' });
    button.dataset.id = id;
    const glyph = node('span', 'island-pill-icon');
    if (icon) glyph.innerHTML = iconSvg(icon, 15);
    const label = node('span', 'island-pill-label');
    button.append(glyph, label);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (id === 'power') this._confirmPower();
      else if (id === 'wardrobe') this._toggleCloset();
      else this.hud.onAction(id);
    });
    this._hover(button, id);
    this.buttons.set(id, button);
    return button;
  }

  _playerButton(item) {
    const button = node('button', 'island-player-btn', { type: 'button' });
    button.dataset.id = item.id;
    button.innerHTML = iconSvg(item.icon, 14);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      this.hud.onAction('player', item.id);
    });
    this._hover(button, item.id);
    this.buttons.set(item.id, button);
    return button;
  }

  _hover(element, id) {
    element.addEventListener('pointerenter', () => this._caption(id));
    element.addEventListener('pointerleave', (event) => {
      // From a player button back onto the player: its caption (the track) again.
      const parent = event.relatedTarget?.closest?.('[data-id]')?.dataset.id;
      this._caption(parent && parent !== id ? parent : null);
    });
  }

  _caption(id) {
    this._hovered = id;
    const text = !id ? '' : id === 'wardrobe' ? (this.closetOpen ? t('Back to the card') : t('Wardrobe')) : id.startsWith('outfit:') ? this._outfitWords(id.slice(7)) : this.hud._captionFor(id);
    this.caption.textContent = text;
    this.caption.classList.toggle('shown', Boolean(text) && this.open && !this._drag?.moved);
  }

  /** Quit: the first click asks for confirmation, the second really closes. */
  _confirmPower() {
    if (this.powerPill.classList.contains('confirm')) {
      clearTimeout(this._confirmTimer);
      this.hud.onAction('power');
      return;
    }
    this.powerPill.classList.add('confirm');
    this.render();
    this._confirmTimer = setTimeout(() => {
      this.powerPill.classList.remove('confirm');
      this.render();
    }, 3000);
  }

  // ------------------------------------------------------------ moving it
  /**
   * The island's black (not its buttons) is a handle: dragging it moves the
   * window, her and the island together (hud.onIslandDrag, electron/main.js).
   * A press that doesn't move stays a click (the card opens the engines).
   */
  _bindDrag() {
    this.box.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !this.open || event.target.closest('button, .island-closet')) return;
      this._drag = { id: event.pointerId, x: event.screenX, y: event.screenY, moved: false, origin: null };
      this.box.setPointerCapture?.(event.pointerId);
    });
    this.box.addEventListener('pointermove', (event) => {
      const drag = this._drag;
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.screenX - drag.x;
      const dy = event.screenY - drag.y;
      if (!drag.moved) {
        if (Math.abs(dx) + Math.abs(dy) <= DRAG_FROM) return;
        drag.moved = true;
        this.box.classList.add('dragging');
        this._caption(null);
        Promise.resolve(this.hud.onIslandDrag?.('start')).then((origin) => {
          if (this._drag === drag) drag.origin = origin ?? null;
        });
      }
      if (drag.origin) this.hud.onIslandDrag?.('move', { x: drag.origin.x + dx, y: drag.origin.y + dy });
    });
    const end = (event) => {
      const drag = this._drag;
      if (!drag || event.pointerId !== drag.id) return;
      this._drag = null;
      this.box.classList.remove('dragging');
      if (!drag.moved) return;
      this.hud.onIslandDrag?.('end');
      // The click that follows the drag must not open the engines.
      const swallow = (click) => click.stopPropagation();
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
    };
    this.box.addEventListener('pointerup', end);
    this.box.addEventListener('pointercancel', end);
  }

  // ------------------------------------------------------------ geometry
  /** The island's scale: it follows the window's height, i.e. her size. */
  get scale() {
    return window.innerHeight / DESIGN_HEIGHT;
  }

  /** Scale and width (in design pixels) from the window as it is now. */
  _fit() {
    const k = this.scale;
    this.root.style.setProperty('--k', k.toFixed(4));
    this.root.style.setProperty('--iw', `${(window.innerWidth / k).toFixed(1)}px`);
    this.box.classList.toggle('wide', window.innerWidth / k >= WIDE_FROM);
    return k;
  }

  /**
   * It opens growing from her centre. First it asks to widen the window
   * (hud.onIslandShape) and waits for it to happen, then it grows: so you
   * don't see the narrow island changing shape.
   */
  show(origin) {
    const token = (this._token = (this._token ?? 0) + 1);
    clearTimeout(this._narrowTimer);
    this.open = true;
    const reveal = () => {
      if (token === this._token && this.open) this._reveal(origin);
    };
    const shape = this.hud.onIslandShape?.(true);
    if (!shape) {
      reveal();
      return;
    }
    Promise.resolve(shape)
      .then((result) => {
        if (!result?.wide || window.innerWidth / this.scale >= WIDE_FROM) {
          reveal();
          return;
        }
        const done = () => {
          window.removeEventListener('resize', done);
          clearTimeout(timer);
          requestAnimationFrame(reveal);
        };
        const timer = setTimeout(done, 220);
        window.addEventListener('resize', done);
      })
      .catch(reveal);
  }

  /** Positions are read from the layout, not from the animated rectangles. */
  _reveal(fallback) {
    const k = this._fit();
    // Where she is now: widening the window changed her place in pixels.
    const frame = this.hud.locate?.();
    const origin = frame ? { x: frame.cx, y: frame.cy } : fallback;
    const rect = this.root.getBoundingClientRect();
    const x = origin ? (origin.x - rect.left) / k : this.box.offsetWidth / 2;
    const y = origin ? (origin.y - rect.top) / k : this.box.offsetHeight;
    this.box.style.setProperty('--ox', `${x.toFixed(1)}px`);
    this.box.style.setProperty('--oy', `${y.toFixed(1)}px`);
    this.render();
    requestAnimationFrame(() => this.open && this.box.classList.add('open'));
  }

  hide() {
    this.open = false;
    this.closetOpen = false;
    this._token = (this._token ?? 0) + 1;
    this.box.classList.remove('open', 'dragging');
    this.powerPill.classList.remove('confirm');
    this._caption(null);
    if (this._drag?.moved) this.hud.onIslandDrag?.('end');
    this._drag = null;
    // Back inside her, the window goes narrow again.
    clearTimeout(this._narrowTimer);
    this._narrowTimer = setTimeout(() => {
      if (!this.open) this.hud.onIslandShape?.(false);
    }, 320);
  }

  /** The window changed size (widened, new scale): the island adapts. */
  relayout() {
    if (this.open) this._fit();
  }

  /** The top edge of the open island, in window pixels (the speech bubble sits above it). */
  get top() {
    return this.root.getBoundingClientRect().top;
  }

  /** Where she must be: the slot left of the card, in window pixels. */
  slotRect() {
    const k = this.scale;
    const rect = this.root.getBoundingClientRect();
    const x = this.box.offsetLeft + this.card.offsetLeft + this.slot.offsetLeft;
    const y = this.box.offsetTop + this.card.offsetTop + this.slot.offsetTop;
    return { x: rect.left + x * k, y: rect.top + y * k, w: this.slot.offsetWidth * k, h: this.slot.offsetHeight * k };
  }

  // ---------------------------------------------------------------- state
  render() {
    const hud = this.hud;
    const llm = hud.engines?.llm;

    for (const item of TABS) this.buttons.get(item.id).classList.toggle('active', hud.activeTab === item.id);
    this.buttons.get('engines').classList.toggle('active', hud.activeTab === 'engines');
    const voice = this.buttons.get('voice');
    voice.innerHTML = iconSvg(hud.muted ? 'volumeOff' : 'volume', 17);
    voice.classList.toggle('off', hud.muted);
    const mic = this.buttons.get('mic');
    const sttOff = (hud.engines?.stt?.state ?? 'off') === 'off';
    mic.innerHTML = iconSvg(sttOff ? 'micOff' : 'mic', 17);
    mic.classList.toggle('off', sttOff);
    mic.classList.toggle('on', Boolean(hud.mic.enabled));

    // The brain: dot with its state, name, model.
    const state = hud.busy === 'thinking' ? 'thinking' : llm?.state ?? 'unknown';
    this.dot.style.setProperty('--dot', hud.stateColor(state));
    this.brain.textContent = llm?.label ?? t('Brain');
    this.model.textContent = llm?.model ?? '';
    this._renderSteps(llm);

    const usage = hud.usage;
    this.usage.classList.toggle('hidden', !usage);
    if (usage) {
      const used = Math.round(usage.limit.used);
      this.usageLabel.textContent = `${usage.agent} · ${WINDOW_WORDS[usage.limit.windowMinutes] ?? t('limit')}`;
      this.usageValue.textContent = `${used}%`;
      this.usageBar.style.setProperty('--used', `${Math.max(3, Math.min(100, used))}%`);
      this.usageBar.style.setProperty('--bar', usageColor(used));
    }

    const label = (pill, text) => {
      pill.querySelector('.island-pill-label').textContent = text;
    };
    label(this.wardrobePill, t('Wardrobe'));
    this.wardrobePill.classList.toggle('active', Boolean(this.closetOpen));
    this.info.classList.toggle('hidden', Boolean(this.closetOpen));
    // The closet grows the card: every outfit in sight, no scrolling.
    this.card.classList.toggle('closet-open', Boolean(this.closetOpen));
    this.closet.classList.toggle('hidden', !this.closetOpen);
    if (this.closetOpen) this._renderCloset();

    // Dancing only while it plays; the player as long as Spotify is open (paused too).
    const music = hud.music;
    this.musicPill.classList.toggle('hidden', !music.playing);
    this.musicPill.querySelector('.island-pill-icon').innerHTML = hud.dancing
      ? '<span class="island-eq"><b></b><b></b><b></b></span>'
      : iconSvg('music', 15);
    label(this.musicPill, hud.dancing ? t('Dance') : t('Still'));
    this.player.classList.toggle('hidden', !music.open);
    this.player.classList.toggle('playing', music.playing);
    this.buttons.get('toggle').innerHTML = iconSvg(music.playing ? 'pause' : 'play', 14);

    label(this.powerPill, this.powerPill.classList.contains('confirm') ? t('Quit?') : '');
    if (this._hovered) this._caption(this._hovered);
  }

  // ------------------------------------------------------------ closet
  _toggleCloset() {
    this.closetOpen = !this.closetOpen;
    this._closetKey = null;
    this.render();
    this._caption(this._hovered);
  }

  _outfitWords(choice) {
    if (choice !== 'auto') return OUTFIT_LABELS[choice] ?? '';
    const season = seasonalOutfit();
    return season === 'none' ? t('Automatic: nothing this season') : t('Automatic: {outfit}', { outfit: OUTFIT_LABELS[season].toLowerCase() });
  }

  /** The previews are redrawn only when the choice or the colour changes. */
  _renderCloset() {
    const { selection = 'auto', color = 'lilac' } = this.hud.wardrobe ?? {};
    const chosen = parseOutfit(selection);
    const key = `${chosen}|${color}`;
    this.closetHead.textContent = t('Wardrobe · {outfit}', { outfit: this._outfitWords(chosen) });
    if (key === this._closetKey) return;
    this._closetKey = key;
    this.closetGrid.replaceChildren(
      ...SELECTIONS.map((choice) => {
        const tile = node('button', `island-outfit${choice === chosen ? ' on' : ''}`, { type: 'button', 'aria-label': OUTFIT_LABELS[choice] });
        // SVG made in wardrobe-art.js with validated colours: no text from outside.
        tile.innerHTML = outfitPreview(choice === 'auto' ? seasonalOutfit() : choice, color, { badge: choice === 'auto' });
        tile.addEventListener('click', (event) => {
          event.stopPropagation();
          this.hud.onAction('outfit', choice);
        });
        this._hover(tile, `outfit:${choice}`);
        return tile;
      }),
    );
  }

  /**
   * What she's doing, like Coucou's list: the agent's steps (done, in
   * progress), then "Done". Without steps a single line: ready, thinking,
   * answering, listening, or the brain off.
   */
  _renderSteps(llm) {
    const hud = this.hud;
    const rows = [];
    const thinking = hud.busy === 'thinking';
    if (llm && (llm.state === 'offline' || llm.state === 'off')) {
      rows.push({ mark: 'off', text: llm.detail ? t('Off: {detail}', { detail: tx(llm.detail) }) : t('Off: pick one in Engines') });
    } else if (hud.steps.length) {
      const steps = hud.steps.slice(-STEPS_SHOWN + (thinking ? 0 : 1));
      steps.forEach((label, i) => rows.push({ mark: thinking && i === steps.length - 1 ? 'spin' : 'ok', text: label, past: true }));
      if (!thinking) rows.push({ mark: 'ok', text: t('Done') });
    } else if (thinking) {
      rows.push({ mark: 'spin', text: t('Thinking…') });
    } else if (hud.busy === 'speaking') {
      rows.push({ mark: 'spin', text: t('Answering') });
    } else if (hud.mic.enabled) {
      rows.push({ mark: 'spin', text: t("I'm listening") });
    } else {
      rows.push({ mark: llm?.state === 'online' ? 'ok' : 'wait', text: llm?.state === 'online' ? t('Ready') : t('Checking the brain…') });
      rows.push({ mark: 'none', text: t('Write or talk to me whenever you like'), past: true });
    }
    this.steps.replaceChildren(
      ...rows.map((row) => {
        const item = node('li', row.past && row.mark !== 'spin' ? 'past' : '');
        const mark = node('i', row.mark);
        if (row.mark === 'ok') mark.innerHTML = iconSvg('check', 9);
        const text = node('span');
        text.textContent = row.text;
        item.append(mark, text);
        return item;
      }),
    );
  }
}
