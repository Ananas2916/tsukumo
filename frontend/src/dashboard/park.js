/**
 * The park: every agent on this PC hanging out in a Japanese scene of your
 * choice (backend/park.py for who's there, dashboard/scenes.js for where).
 *
 * Claude Code sessions are soft terracotta blobs (a blue beanie in VS Code, a
 * dark one in a terminal), Codex a teal cube, OpenClaw a lobster in the
 * scene's water, LM Studio its stall with the model it serves, and Tsukumo
 * floats at the scene's heart. Who works runs around with a glowing laptop,
 * who's idle sits down (or soaks, at the hot spring) and dozes, who waits for
 * you hops at the front with a "!". A message sent: the sender walks over,
 * says what about, and a paper crane flies; some scenes add their own sign
 * (the bamboo knocks, a firework goes up, the train goes by).
 *
 * The light follows the clock (dawn, day, dusk, night, lanterns lit after
 * dark) and the scenery the season (blossom, fireflies, red leaves, snow).
 * What doesn't move is painted once a minute into a backdrop and copied at
 * every frame. The canvas runs only while the tile is on screen and the
 * window visible; with "reduce motion" it's a still picture, redrawn when the
 * data changes. Below it, one chip per agent. All the text drawn comes from
 * the backend as data (fillText, textContent: nothing to inject).
 */

import { el, readSetting, writeSetting } from '../dom.js';
import { palette } from '../flame/palettes.js';
import { t } from '../i18n.js';
import { SCENES, SCENE_IDS } from './scenes.js';
import { HEIGHT, TAU, along, alpha, crane, mix, seeded, shade } from './scenery.js';
import { nowSeconds, sinceText } from './time.js';
import { card } from './widgets.js';

const SCENE_SETTING = 'dc:park-scene';
const FRAME = 1000 / 30;
const REDUCED = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
/** A link newer than this (s) is walked over; older ones are just a thread. */
const FRESH = 120;
const LINK_TTL = 30 * 60;
const TALK = 5;
/** The backdrop is repainted this often: the light moves with the clock. */
const BACKDROP_EVERY = 60_000;
/** The characters are drawn small and scaled up around their feet. */
const SCALE = 1.35;
const FONT = "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif";

const KINDS = {
  claude: { body: '#e08463', label: 'Claude Code' },
  codex: { body: '#22b493', label: 'Codex', square: true },
  gemini: { body: '#6a9cf6', label: 'Gemini CLI' },
  cursor: { body: '#aeb3c2', label: 'Cursor', square: true },
  openclaw: { body: '#ec5545', label: 'OpenClaw' },
  tsukumo: { body: '#b69cff', label: 'Tsukumo' },
};
const OTHER = { body: '#bcb2da', label: '' };
const CAPS = { vscode: '#3b8eea', terminal: '#2a2a35', desktop: '#efe9dc', jetbrains: '#f0476f' };
const WHERE = { vscode: 'VS Code', terminal: t('terminal'), desktop: 'Claude Desktop', jetbrains: 'JetBrains' };
const STATE_TEXT = { working: t('working'), waiting: t('waiting for you'), done: t('done'), idle: t('ready') };
const STATE_DOT = { working: '#7cc7ff', waiting: '#f5c451', done: '#4fdc9f', idle: '#9a9fb5' };
const SPEED = { working: 52, waiting: 64, done: 30, idle: 24, visit: 74, leave: 60 };

/**
 * The light at four moments of the day; the hours in between blend them.
 * `tint` multiplies the painted scenery (white by day, blue at night): one
 * light for every scene. Muted on purpose: it lives in a dark-glass
 * dashboard, not a game.
 */
const SKIES = {
  night: { top: '#090b1c', low: '#2a2152', tint: '#56599c', light: 0.5, lamps: 1, stars: 1 },
  dawn: { top: '#2d3270', low: '#f0a383', tint: '#e8bcc2', light: 0.85, lamps: 0.3, stars: 0.15 },
  day: { top: '#3c69c2', low: '#bdd5f0', tint: '#ffffff', light: 1, lamps: 0, stars: 0 },
  dusk: { top: '#2a2360', low: '#e57d8e', tint: '#c48ca8', light: 0.7, lamps: 0.85, stars: 0.4 },
};
/** What the trees wear and what falls from the sky, month by month. */
const SEASONS = {
  spring: { name: 'spring', leaf: '#f4b8cc', snow: 0, particle: 'petal' },
  summer: { name: 'summer', leaf: '#4c8c4a', snow: 0, particle: 'firefly' },
  autumn: { name: 'autumn', leaf: '#d8552e', snow: 0, particle: 'leaf' },
  winter: { name: 'winter', leaf: null, snow: 1, particle: 'snow' },
};
const seasonAt = (date = new Date()) => {
  const month = date.getMonth();
  if (month >= 2 && month <= 4) return SEASONS.spring;
  if (month >= 5 && month <= 7) return SEASONS.summer;
  if (month >= 8 && month <= 10) return SEASONS.autumn;
  return SEASONS.winter;
};
const DAY = [
  [0, 'night'],
  [5, 'night'],
  [7, 'dawn'],
  [9, 'day'],
  [17, 'day'],
  [19, 'dusk'],
  [21, 'night'],
  [24, 'night'],
];

const rand = (min, max) => min + Math.random() * (max - min);
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const hex = (value) => `#${value.toString(16).padStart(6, '0')}`;

/** The scene saved in the settings, or the first one. */
const savedScene = () => {
  const id = readSetting(SCENE_SETTING, SCENE_IDS[0]);
  return SCENES[id] ? id : SCENE_IDS[0];
};

/** The scenery painted on its own layer, then multiplied by the hour's light (shapes kept). */
function underLight(layer, tint) {
  const lit = document.createElement('canvas');
  lit.width = layer.width;
  lit.height = layer.height;
  const ctx = lit.getContext('2d');
  ctx.drawImage(layer, 0, 0);
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, lit.width, lit.height);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(layer, 0, 0);
  return lit;
}

function skyAt(date = new Date()) {
  const hour = date.getHours() + date.getMinutes() / 60;
  for (let i = 0; i < DAY.length - 1; i += 1) {
    const [from, a] = DAY[i];
    const [to, b] = DAY[i + 1];
    if (hour >= from && hour < to) {
      const amount = (hour - from) / (to - from);
      const sky = { hour };
      for (const key of Object.keys(SKIES[a])) {
        const x = SKIES[a][key];
        const y = SKIES[b][key];
        sky[key] = typeof x === 'number' ? x + (y - x) * amount : mix(x, y, amount);
      }
      return sky;
    }
  }
  return { ...SKIES.night, hour };
}

export class ParkWidget {
  constructor() {
    this.settingId = savedScene();
    this.setting = SCENES[this.settingId];
    /** What the scene remembers between frames (the train's departure, the fireworks…). */
    this.sceneState = {};
    // The tile's title is the scene's name, and picks the scene.
    this.picker = el(
      'select',
      { class: 'w-park-pick', 'aria-label': t('Scene'), title: t('Change the scene'), onChange: () => this.setScene(this.picker.value, true) },
      ...SCENE_IDS.map((id) => el('option', { value: id }, t(SCENES[id].name))),
    );
    this.picker.value = this.settingId;
    ({ node: this.node, body: this.body } = card('w-park', 'tree', ''));
    this.node.querySelector('h3')?.replaceChildren(this.picker);
    this.canvas = el('canvas', { class: 'w-park-canvas', role: 'img' });
    this.tip = el('div', { class: 'w-park-tip hidden', role: 'tooltip' });
    this.stage = el('div', { class: 'w-park-scene' }, this.canvas, this.tip);
    this.roster = el('ul', { class: 'w-park-roster' });
    this.legend = el('p', { class: 'w-park-legend' });
    this.body.append(this.stage, el('div', { class: 'w-park-foot' }, this.roster, this.legend));
    this.context = this.canvas.getContext('2d');
    this.entities = new Map();
    this.seenLinks = new Set();
    this.envelopes = [];
    this.data = null;
    this.width = 0;
    this.ready = false;
    this.visible = true;
    this.raf = 0;
    this.last = 0;
    this.clock = 0;
    this.backdrop = null;
    this.backdropAt = 0;
    this.backdropKey = '';
    /** The agent under the pointer, in the scene or on its chip. */
    this.focus = null;
    this.flame = palette(readSetting('dc:flame-color', 'lilac'));

    new ResizeObserver(() => this.resize()).observe(this.stage);
    new IntersectionObserver((entries) => {
      this.visible = entries.some((entry) => entry.isIntersecting);
      this.loop();
    }).observe(this.stage);
    document.addEventListener('visibilitychange', () => this.loop());
    window.addEventListener('storage', (event) => {
      if (event.key === 'dc:flame-color') this.flame = palette(readSetting('dc:flame-color', 'lilac'));
      if (event.key === SCENE_SETTING) this.setScene(savedScene(), false);
    });
    this.canvas.addEventListener('pointermove', (event) => this.hover(event));
    this.canvas.addEventListener('pointerleave', () => {
      this.tip.classList.add('hidden');
      this.setFocus(null);
    });
  }

  // ------------------------------------------------------------------ data
  render(store) {
    const park = store.park;
    this.data = park ?? null;
    const now = nowSeconds();
    const seen = new Set();
    for (const agent of park?.agents ?? []) {
      seen.add(agent.id);
      let entity = this.entities.get(agent.id);
      if (!entity) {
        entity = this.spawn(agent);
        this.entities.set(agent.id, entity);
      }
      if (entity.data && entity.data.state !== 'done' && agent.state === 'done') {
        entity.party = 1.6;
        this.setting.party?.(this.sceneState, this.clock, this.width);
      }
      entity.data = agent;
      entity.leaving = false;
    }
    for (const entity of this.entities.values()) {
      if (!seen.has(entity.id)) {
        entity.leaving = true;
        entity.visit = null;
      }
    }
    for (const link of park?.links ?? []) {
      const key = `${link.from}>${link.to}>${link.at}`;
      if (this.seenLinks.has(key)) continue;
      this.seenLinks.add(key);
      const sender = this.entities.get(link.from);
      if (!sender || sender.data.kind === 'tsukumo' || now - link.at > FRESH) continue;
      if (link.kind === 'message' || link.kind === 'tsukumo') sender.visits.push({ to: link.kind === 'tsukumo' ? 'tsukumo' : link.to, label: link.label, kind: link.kind });
    }
    if (this.seenLinks.size > 400) this.seenLinks = new Set([...this.seenLinks].slice(-200));
    this.ready = this.width > 0;
    this.renderRoster();
    this.renderLegend(now);
    if (REDUCED || !this.raf) this.draw();
    this.loop();
  }

  /** One chip per agent, Tsukumo first, then who needs you, who works, who rests. */
  renderRoster() {
    const order = { waiting: 0, working: 1, done: 2, idle: 3 };
    const agents = [...(this.data?.agents ?? [])].sort(
      (a, b) => (a.kind === 'tsukumo' ? -1 : b.kind === 'tsukumo' ? 1 : (order[a.state] ?? 4) - (order[b.state] ?? 4)),
    );
    this.roster.replaceChildren(
      ...agents.map((agent) => {
        const look = KINDS[agent.kind] ?? OTHER;
        const avatar = el('span', { class: `w-park-avatar${look.square ? ' square' : ''}`, 'aria-hidden': 'true' });
        avatar.style.setProperty('--c', look.body);
        const chip = el(
          'li',
          { class: `w-park-chip${agent.id === this.focus ? ' focus' : ''}`, dataset: { state: agent.state ?? 'idle', id: agent.id } },
          avatar,
          el('span', { class: 'w-park-name' }, clip(agent.name ?? '?', 26)),
          el('small', {}, STATE_TEXT[agent.state] ?? agent.state ?? ''),
        );
        chip.addEventListener('pointerenter', () => this.setFocus(agent.id));
        chip.addEventListener('pointerleave', () => this.setFocus(null));
        return chip;
      }),
    );
  }

  renderLegend(now) {
    const agents = (this.data?.agents ?? []).filter((agent) => agent.kind !== 'tsukumo');
    const count = (state) => agents.filter((agent) => agent.state === state).length;
    const parts = [agents.length ? t('{n} online', { n: agents.length }) : t('Nobody else around: just her.')];
    if (count('working')) parts.push(t('{n} at work', { n: count('working') }));
    if (count('waiting')) parts.push(t('{n} waiting for you', { n: count('waiting') }));
    const chat = [...(this.data?.links ?? [])].reverse().find((link) => link.kind === 'message');
    if (chat) {
      const name = (id) => this.entities.get(id)?.data?.name ?? '?';
      parts.push(t('last chat: {from} → {to}, {when}', { from: name(chat.from), to: name(chat.to), when: sinceText(chat.at, now) }));
    }
    const text = parts.join(' · ');
    this.legend.textContent = text;
    this.canvas.setAttribute('aria-label', `${t(this.setting.name)}: ${text}`);
  }

  setFocus(id) {
    if (this.focus === id) return;
    this.focus = id;
    for (const chip of this.roster.children) chip.classList.toggle('focus', chip.dataset.id === id);
    if (REDUCED || !this.raf) this.draw();
  }

  spawn(agent) {
    const entity = {
      id: agent.id,
      data: null,
      x: 0,
      y: 0,
      tx: 0,
      ty: 0,
      face: 1,
      pause: 0,
      walking: false,
      phase: Math.random() * 6,
      visits: [],
      visit: null,
      bump: 0,
      party: 0,
      rest: 0,
      blink: rand(1, 5),
    };
    if (this.ready && this.places && agent.kind !== 'tsukumo' && agent.kind !== 'openclaw') {
      // Someone new arrives through the way in.
      [entity.x, entity.y] = this.gate();
    } else {
      [entity.x, entity.y] = this.places ? this.wander() : [0, 0];
    }
    [entity.tx, entity.ty] = [entity.x, entity.y];
    return entity;
  }

  // ---------------------------------------------------------------- layout
  resize() {
    const width = Math.round(this.stage.clientWidth);
    if (!width || width === this.width) return;
    this.width = width;
    const ratio = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(HEIGHT * ratio);
    this.canvas.style.height = `${HEIGHT}px`;
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.layout();
  }

  /** The scene's places for this width; whoever stood where a prop now is moves. */
  layout() {
    const first = !this.places;
    this.places = this.setting.layout(this.width);
    this.lights = this.setting.lights?.(this.places) ?? [];
    this.backdrop = null;
    for (const entity of this.entities.values()) {
      if (first || entity.x > this.width || this.blocked(entity.x, entity.y)) [entity.x, entity.y] = this.wander();
      [entity.tx, entity.ty] = [entity.x, entity.y];
    }
    this.ready = Boolean(this.data);
    this.draw();
    this.loop();
  }

  /** Another scene: everyone finds a spot in it; `save` when it's the user's choice here. */
  setScene(id, save) {
    if (!SCENES[id] || id === this.settingId) return;
    this.settingId = id;
    this.setting = SCENES[id];
    this.sceneState = {};
    this.picker.value = id;
    if (save) writeSetting(SCENE_SETTING, id);
    this.envelopes = [];
    for (const entity of this.entities.values()) entity.visit = null;
    this.places = null;
    if (this.width) this.layout();
    if (this.data) this.renderLegend(nowSeconds());
  }

  gate() {
    return [...this.places.gate];
  }

  blocked(x, y) {
    return (this.places.blocked ?? []).some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
  }

  /** A free spot on the scene's ground: its zones are rectangles or paths, picked by size. */
  wander() {
    const zones = this.places.zones;
    const sizes = zones.map((zone) => (zone.rect ? Math.max(20, zone.rect[2] - zone.rect[0]) : Math.hypot(zone.path.b[0] - zone.path.a[0], zone.path.b[1] - zone.path.a[1])));
    const total = sizes.reduce((sum, size) => sum + size, 0);
    for (let tries = 0; tries < 20; tries += 1) {
      let pick = Math.random() * total;
      const zone = zones.find((_, i) => (pick -= sizes[i]) <= 0) ?? zones[0];
      const [x, y] = zone.rect ? [rand(zone.rect[0], zone.rect[2]), rand(zone.rect[1], zone.rect[3])] : along(zone.path, Math.random());
      if (!this.blocked(x, y)) return [x, y];
    }
    return [this.places.front.x, this.places.front.y];
  }

  // ------------------------------------------------------------- animation
  loop() {
    const run = this.visible && !document.hidden && !REDUCED && this.width > 0;
    if (!run) {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
      return;
    }
    if (this.raf) return;
    this.last = performance.now();
    const frame = (time) => {
      this.raf = requestAnimationFrame(frame);
      if (time - this.last < FRAME) return;
      // A window in the background gets a few frames a second: big steps,
      // not slow motion (every move is clamped to its target anyway).
      const dt = Math.min(0.5, (time - this.last) / 1000);
      this.last = time;
      this.update(dt);
      this.draw();
    };
    this.raf = requestAnimationFrame(frame);
  }

  update(dt) {
    this.clock += dt;
    if (!this.places) return;
    const all = [...this.entities.values()];
    const walkers = all.filter((entity) => entity.data && !['tsukumo', 'openclaw'].includes(entity.data.kind));
    // The scene's seats for the idle ones, places at the front for who's waiting.
    const idle = walkers.filter((entity) => entity.data.state === 'idle' && !entity.visit && !entity.leaving);
    const waiting = walkers.filter((entity) => entity.data.state === 'waiting' && !entity.visit && !entity.leaving);
    const seats = this.places.seats.length;
    for (const entity of walkers) if (!idle.includes(entity)) entity.seat = -1;
    idle.forEach((entity, index) => (entity.seat = index < seats ? index : -1));
    waiting.forEach((entity, index) => (entity.slot = index - (waiting.length - 1) / 2));
    for (const entity of walkers) this.step(entity, dt);
    for (const entity of all) {
      entity.bump = Math.max(0, entity.bump - dt);
      entity.party = Math.max(0, entity.party - dt);
      entity.blink -= dt;
      if (entity.blink < -0.13) entity.blink = rand(2.5, 6);
    }
    const lobster = this.entities.get('openclaw');
    if (lobster) {
      const { pond } = this.places;
      const speed = lobster.data.state === 'working' ? 1.4 : 0.35;
      lobster.phase += dt * speed;
      lobster.x = pond.x + Math.cos(lobster.phase) * pond.rx;
      lobster.y = pond.y + Math.sin(lobster.phase) * pond.ry;
      lobster.face = -Math.sin(lobster.phase) >= 0 ? 1 : -1;
    }
    this.envelopes = this.envelopes.filter((item) => {
      item.t += dt / 0.8;
      if (item.t >= 1) {
        const target = this.entities.get(item.to);
        if (target) target.bump = 0.7;
        return false;
      }
      return true;
    });
  }

  step(entity, dt) {
    const state = entity.data.state;
    let speed = SPEED[state] ?? 30;
    entity.phase += dt * (state === 'working' ? 9 : 6);
    if (!entity.visit && entity.visits.length && !entity.leaving) {
      entity.visit = { ...entity.visits.shift(), talk: 0, timeout: 20 };
    }
    const visit = entity.visit;
    if (entity.leaving) {
      [entity.tx, entity.ty] = this.gate();
      speed = SPEED.leave;
    } else if (visit) {
      visit.timeout -= dt;
      const other = this.entities.get(visit.to);
      if (!other || visit.timeout <= 0) {
        entity.visit = null;
      } else if (visit.talk > 0) {
        visit.talk -= dt;
        speed = 0;
        entity.face = other.x >= entity.x ? 1 : -1;
        if (visit.talk <= 0) entity.visit = null;
      } else {
        const side = entity.x <= other.x ? -1 : 1;
        // To talk to her, one of the two spots the scene keeps beside her.
        const [ax, ay] = this.places.ask[entity.x <= this.places.tsukumo.x ? 0 : 1];
        [entity.tx, entity.ty] = visit.to === 'tsukumo' ? [ax, ay] : [other.x + side * 28, other.y + 2];
        speed = SPEED.visit;
        if (Math.hypot(entity.tx - entity.x, entity.ty - entity.y) < 3) {
          visit.talk = TALK;
          this.envelopes.push({ from: entity.id, to: visit.to, t: 0 });
          this.setting.message?.(this.sceneState, this.clock, this.width);
        }
      }
    } else if (state === 'waiting') {
      const { front } = this.places;
      [entity.tx, entity.ty] = [front.x + (entity.slot ?? 0) * 46, front.y];
    } else if (state === 'idle' && entity.seat >= 0) {
      const seat = this.places.seats[entity.seat];
      [entity.tx, entity.ty] = [seat.x, seat.y];
    } else {
      const arrived = Math.hypot(entity.tx - entity.x, entity.ty - entity.y) < 2;
      if (arrived) {
        entity.pause -= dt;
        if (entity.pause <= 0) {
          [entity.tx, entity.ty] = this.wander();
          entity.pause = state === 'working' ? rand(0.2, 1.2) : state === 'idle' ? rand(6, 14) : rand(1, 4);
        }
      }
    }
    const dx = entity.tx - entity.x;
    const dy = entity.ty - entity.y;
    const distance = Math.hypot(dx, dy);
    entity.walking = distance > 1.5 && speed > 0;
    if (entity.walking) {
      const move = Math.min(distance, speed * dt);
      entity.x += (dx / distance) * move;
      entity.y += (dy / distance) * move;
      if (Math.abs(dx) > 0.5) entity.face = dx > 0 ? 1 : -1;
      entity.rest = 0;
    } else {
      entity.rest += dt;
    }
    if (entity.leaving && distance < 3) this.entities.delete(entity.id);
  }

  // -------------------------------------------------------------- backdrop
  /** LM Studio as the scene shows it: its model's short name, or null when it isn't running. */
  lmStudio() {
    const lm = this.data?.lmstudio;
    if (!lm) return null;
    return { model: lm.model ? clip(lm.model.split('/').pop(), 18) : '' };
  }

  /**
   * Sky, then the scene's scenery under the hour's light, then what stands in
   * front of the things that move behind it (`near`): painted once a minute,
   * or when the scene, the season or LM Studio change, not at every frame.
   */
  paintBackdrop(key) {
    const setting = this.setting;
    this.flame = palette(readSetting('dc:flame-color', 'lilac'));
    const now = new Date();
    const sky = setting.night ? { ...skyAt(new Date(2000, 0, 1, 23)), ...setting.sky } : skyAt(now);
    this.sky = sky;
    this.season = seasonAt(now);
    const lm = this.lmStudio();
    const ratio = window.devicePixelRatio || 1;
    const W = this.width;
    const layer = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(W * ratio);
      canvas.height = Math.round(HEIGHT * ratio);
      const ctx = canvas.getContext('2d');
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      return [canvas, ctx];
    };
    const [back, ctx] = layer();
    const air = ctx.createLinearGradient(0, 0, 0, 150);
    air.addColorStop(0, sky.top);
    air.addColorStop(1, sky.low);
    ctx.fillStyle = air;
    ctx.fillRect(0, 0, W, HEIGHT);
    this.paintStars(ctx, sky);
    this.paintCelestial(ctx, sky);
    this.paintClouds(ctx, sky);
    const [far, farCtx] = layer();
    setting.far(farCtx, this.places, this.season, lm);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // The alley lights itself: its colours are already the night's.
    ctx.drawImage(setting.night ? far : underLight(far, sky.tint), 0, 0);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    // The edges fall into shadow: the scene sits in the tile, it doesn't end on a cut.
    const edge = ctx.createLinearGradient(0, 0, W, 0);
    edge.addColorStop(0, 'rgba(6, 6, 16, 0.32)');
    edge.addColorStop(0.12, 'rgba(6, 6, 16, 0)');
    edge.addColorStop(0.88, 'rgba(6, 6, 16, 0)');
    edge.addColorStop(1, 'rgba(6, 6, 16, 0.32)');
    ctx.fillStyle = edge;
    ctx.fillRect(0, 0, W, HEIGHT);
    this.nearLayer = null;
    if (setting.near) {
      const [near, nearCtx] = layer();
      setting.near(nearCtx, this.places, this.season, lm);
      this.nearLayer = setting.night ? near : underLight(near, sky.tint);
    }
    this.backdrop = back;
    this.backdropAt = Date.now();
    this.backdropKey = key;
  }

  paintStars(ctx, sky) {
    if (sky.stars < 0.05) return;
    const random = seeded(this.width);
    for (let i = 0; i < this.width / 12; i += 1) {
      const x = random() * this.width;
      const y = 4 + random() * 100;
      const size = random();
      ctx.fillStyle = `rgba(255, 255, 255, ${sky.stars * (0.25 + size * 0.6)})`;
      ctx.beginPath();
      ctx.arc(x, y, 0.4 + size * 0.9, 0, TAU);
      ctx.fill();
    }
  }

  /** Soft clouds, white by day and slate at night. */
  paintClouds(ctx, sky) {
    const random = seeded(this.width + 9);
    const tone = mix('#3a3560', '#ffffff', sky.light);
    for (let i = 0; i < 4; i += 1) {
      const cx = random() * this.width;
      const cy = 18 + random() * 40;
      const w = 40 + random() * 60;
      for (const [dx, dy, r] of [
        [0, 0, 0.32],
        [0.28, -0.12, 0.26],
        [-0.3, 0.04, 0.24],
        [0.55, 0.05, 0.2],
      ]) {
        const x = cx + dx * w;
        const y = cy + dy * w;
        const radius = r * w;
        const puff = ctx.createRadialGradient(x, y, 0, x, y, radius);
        puff.addColorStop(0, alpha(tone, 0.16 + sky.light * 0.14));
        puff.addColorStop(1, alpha(tone, 0));
        ctx.fillStyle = puff;
        ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      }
    }
  }

  /** The sun on its arc by day, low and warm at dawn and dusk; the moon at night. */
  paintCelestial(ctx, sky) {
    const W = this.width;
    const { hour } = sky;
    if (hour >= 6 && hour < 20) {
      const progress = (hour - 6) / 14;
      const x = W * (0.12 + progress * 0.76);
      const y = 74 - Math.sin(progress * Math.PI) * 56;
      const warm = 1 - Math.sin(progress * Math.PI);
      const core = mix('#fff4cf', '#ffb27a', warm);
      const halo = ctx.createRadialGradient(x, y, 2, x, y, 46 + warm * 20);
      halo.addColorStop(0, alpha(core, 0.9));
      halo.addColorStop(0.25, alpha(core, 0.35));
      halo.addColorStop(1, alpha(core, 0));
      ctx.fillStyle = halo;
      ctx.fillRect(x - 70, y - 70, 140, 140);
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(x, y, 8 + warm * 3, 0, TAU);
      ctx.fill();
    } else {
      const x = W - 58;
      const y = 26;
      const halo = ctx.createRadialGradient(x, y, 4, x, y, 44);
      halo.addColorStop(0, 'rgba(236, 232, 255, 0.35)');
      halo.addColorStop(1, 'rgba(236, 232, 255, 0)');
      ctx.fillStyle = halo;
      ctx.fillRect(x - 44, y - 44, 88, 88);
      const disc = ctx.createRadialGradient(x - 3, y - 3, 1, x, y, 10);
      disc.addColorStop(0, '#fbf8ee');
      disc.addColorStop(1, '#d9d3c4');
      ctx.fillStyle = disc;
      ctx.beginPath();
      ctx.arc(x, y, 9.5, 0, TAU);
      ctx.fill();
      ctx.fillStyle = 'rgba(160, 150, 140, 0.25)';
      for (const [dx, dy, r] of [
        [-3, 2, 2],
        [3, -2, 1.4],
        [2, 4, 1.1],
      ]) {
        ctx.beginPath();
        ctx.arc(x + dx, y + dy, r, 0, TAU);
        ctx.fill();
      }
    }
  }

  // ------------------------------------------------------------------ draw
  draw() {
    if (!this.width || !this.places) return;
    const lm = this.lmStudio();
    const key = `${this.settingId}|${this.width}|${seasonAt().name}|${lm ? lm.model : '-'}`;
    if (!this.backdrop || key !== this.backdropKey || Date.now() - this.backdropAt > BACKDROP_EVERY) this.paintBackdrop(key);
    const ctx = this.context;
    const sky = this.sky;
    const ratio = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.backdrop, 0, 0);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.taken = [];
    this.labels = [];
    const view = {
      P: this.places,
      W: this.width,
      sky,
      season: this.season,
      clock: this.clock,
      state: this.sceneState,
      waiting: [...this.entities.values()].some((entity) => entity.data?.state === 'waiting'),
    };
    this.setting.mid?.(ctx, view);
    if (this.nearLayer) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.nearLayer, 0, 0);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    }
    this.drawGlows(ctx, sky);
    this.setting.props?.(ctx, view);
    this.drawThreads(ctx);
    this.drawBrainLinks(ctx);
    // Back to front: who's lower in the scene is closer.
    const sorted = [...this.entities.values()].filter((entity) => entity.data).sort((a, b) => a.y - b.y);
    for (const entity of sorted) {
      if (entity.id === this.focus) this.drawFocus(ctx, entity);
      if (entity.data.kind === 'tsukumo') this.drawTsukumo(ctx, entity);
      else if (entity.data.kind === 'openclaw') this.drawLobster(ctx, entity, sky);
      else this.drawAgent(ctx, entity, sky);
    }
    this.setting.front?.(ctx, view);
    for (const label of this.labels) this.pill(ctx, ...label);
    for (const envelope of this.envelopes) this.drawEnvelope(ctx, envelope);
    this.drawWeather(ctx, sky);
    for (const entity of sorted) this.drawBubble(ctx, entity);
    if (!this.data) this.pill(ctx, t('Looking around…'), this.width / 2, HEIGHT / 2 + 40, null, 12);
  }

  /** Lanterns, windows and signs lighting up as the day goes. */
  drawGlows(ctx, sky) {
    if (sky.lamps < 0.03) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const light of this.lights) {
      let on = sky.lamps * (light.a ?? 1) * (light.flicker ? 0.85 + 0.15 * Math.sin(this.clock * light.flicker + light.x) : 1);
      // A tired neon tube goes out for a moment now and then.
      if (light.blink && (this.clock * 3.7) % 7 < 0.35) on *= 0.15;
      if (light.w) {
        ctx.fillStyle = alpha(light.color, 0.5 * on);
        ctx.fillRect(light.x, light.y, light.w, light.h);
        continue;
      }
      const glow = ctx.createRadialGradient(light.x, light.y, 0, light.x, light.y, light.r);
      glow.addColorStop(0, alpha(light.color, 0.55 * on));
      glow.addColorStop(0.35, alpha(light.color, 0.18 * on));
      glow.addColorStop(1, alpha(light.color, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(light.x - light.r, light.y - light.r, light.r * 2, light.r * 2);
    }
    ctx.restore();
  }

  /** The season in the air: petals, fireflies after dusk, red leaves, snow; rain in the alley. */
  drawWeather(ctx, sky) {
    const kind = this.setting.particles?.[this.season.name] ?? this.season.particle;
    const W = this.width;
    const clock = this.clock;
    const random = seeded(99);
    if (kind === 'firefly') {
      if (sky.lamps < 0.1) return;
      for (let i = 0; i < Math.max(8, W / 50); i += 1) {
        const sx = random();
        const sy = random();
        const phase = random() * TAU;
        const x = sx * W + Math.sin(clock * 0.5 + phase) * 30;
        const y = 130 + sy * (HEIGHT - 145) + Math.sin(clock * 0.7 + phase * 2) * 12;
        const on = Math.max(0, Math.sin(clock * 1.7 + phase * 3)) * sky.lamps;
        if (on < 0.05) continue;
        const glow = ctx.createRadialGradient(x, y, 0, x, y, 7);
        glow.addColorStop(0, `rgba(214, 255, 140, ${0.8 * on})`);
        glow.addColorStop(1, 'rgba(214, 255, 140, 0)');
        ctx.fillStyle = glow;
        ctx.fillRect(x - 7, y - 7, 14, 14);
      }
      return;
    }
    const count = kind === 'rain' ? W / 10 : W / 30;
    for (let i = 0; i < count; i += 1) {
      const sx = random();
      const sy = random();
      const speed = random();
      const phase = random() * TAU;
      if (kind === 'rain') {
        const y = ((sy * HEIGHT + clock * 380) % (HEIGHT + 20)) - 10;
        const x = ((((sx * (W + 40) - clock * 60) % (W + 40)) + W + 40) % (W + 40)) - 20;
        ctx.strokeStyle = 'rgba(170, 190, 225, 0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - 2, y + 9);
        ctx.stroke();
        continue;
      }
      const vy = kind === 'snow' ? 14 + speed * 16 : 12 + speed * 10;
      const vx = kind === 'snow' ? 4 : 14 + speed * 8;
      const y = ((sy * HEIGHT + clock * vy) % (HEIGHT + 20)) - 10;
      const x = ((sx * (W + 40) + clock * vx + Math.sin(clock * 1.3 + phase) * 12) % (W + 40)) - 20;
      if (kind === 'snow') {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.beginPath();
        ctx.arc(x, y, 1 + speed * 1.6, 0, TAU);
        ctx.fill();
        continue;
      }
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(clock * (kind === 'leaf' ? 3 : 2) + phase);
      ctx.fillStyle = kind === 'petal' ? 'rgba(255, 201, 220, 0.9)' : ['#e0603a', '#f0a040', '#c9402a'][i % 3];
      ctx.beginPath();
      ctx.ellipse(0, 0, kind === 'leaf' ? 3.2 : 2.6, kind === 'leaf' ? 2 : 1.5, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }

  /** Under the ground shadow: a soft ellipse, smaller when they're up in the air. */
  shadow(ctx, x, y, rx, lift = 0) {
    const scale = Math.max(0.55, 1 - lift * 0.05);
    const dark = ctx.createRadialGradient(x, y, 0, x, y, rx * scale);
    dark.addColorStop(0, `rgba(4, 6, 14, ${0.42 * scale})`);
    dark.addColorStop(1, 'rgba(4, 6, 14, 0)');
    ctx.fillStyle = dark;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, 0.32);
    ctx.translate(-x, -y);
    ctx.fillRect(x - rx, y - rx, rx * 2, rx * 2);
    ctx.restore();
  }

  drawFocus(ctx, entity) {
    const y = entity.data.kind === 'tsukumo' ? entity.y + 4 : entity.y;
    const pulse = 0.6 + Math.sin(this.clock * 4) * 0.2;
    ctx.strokeStyle = `rgba(190, 170, 255, ${pulse})`;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.ellipse(entity.x, y, 18, 6, 0, 0, TAU);
    ctx.stroke();
  }

  /** The chats of the last half hour: a glowing thread that fades, with a spark running along. */
  drawThreads(ctx) {
    const now = nowSeconds();
    const pairs = new Map();
    for (const link of this.data?.links ?? []) if (link.kind === 'message') pairs.set([link.from, link.to].sort().join('|'), link);
    for (const link of pairs.values()) {
      const a = this.entities.get(link.from);
      const b = this.entities.get(link.to);
      if (!a || !b) continue;
      const fade = Math.max(0.15, 1 - (now - link.at) / LINK_TTL);
      const mx = (a.x + b.x) / 2;
      const my = Math.min(a.y, b.y) - 22 - Math.abs(a.x - b.x) * 0.08;
      ctx.strokeStyle = `rgba(200, 182, 255, ${0.35 * fade})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y - 14);
      ctx.quadraticCurveTo(mx, my, b.x, b.y - 14);
      ctx.stroke();
      const p = (this.clock * 0.35 + (link.at % 10) / 10) % 1;
      const x = (1 - p) ** 2 * a.x + 2 * (1 - p) * p * mx + p ** 2 * b.x;
      const y = (1 - p) ** 2 * (a.y - 14) + 2 * (1 - p) * p * my + p ** 2 * (b.y - 14);
      ctx.fillStyle = `rgba(230, 220, 255, ${0.8 * fade})`;
      ctx.beginPath();
      ctx.arc(x, y, 1.8, 0, TAU);
      ctx.fill();
    }
  }

  drawBrainLinks(ctx) {
    for (const link of this.data?.links ?? []) {
      if (link.kind !== 'brain') continue;
      const from = this.entities.get('tsukumo');
      const target = link.to === 'lmstudio' ? { x: this.places.kiosk.x, y: this.places.kiosk.y + 4 } : this.entities.get(link.to);
      if (!from || !target) continue;
      const fx = from.x;
      const fy = from.y - 34;
      const cx = (fx + target.x) / 2;
      const cy = Math.min(fy, target.y) - 44;
      for (let i = 0; i < 6; i += 1) {
        const p = (this.clock * 0.55 + i / 6) % 1;
        const x = (1 - p) ** 2 * fx + 2 * (1 - p) * p * cx + p ** 2 * target.x;
        const y = (1 - p) ** 2 * fy + 2 * (1 - p) * p * cy + p ** 2 * (target.y - 8);
        const glow = ctx.createRadialGradient(x, y, 0, x, y, 5);
        glow.addColorStop(0, `rgba(214, 196, 255, ${0.85 - p * 0.5})`);
        glow.addColorStop(1, 'rgba(214, 196, 255, 0)');
        ctx.fillStyle = glow;
        ctx.fillRect(x - 5, y - 5, 10, 10);
      }
    }
  }

  drawTsukumo(ctx, entity) {
    const f = this.places.tsukumo;
    entity.x = f.x;
    entity.y = f.y - 2;
    const colors = this.flame;
    const working = entity.data.state === 'working';
    if (f.pool) {
      // Her light on whatever is under her: water, stone, the platform.
      const pool = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, 36);
      pool.addColorStop(0, `${hex(colors.glow)}55`);
      pool.addColorStop(1, `${hex(colors.glow)}00`);
      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.scale(1, 0.3);
      ctx.translate(-f.x, -f.y);
      ctx.fillStyle = pool;
      ctx.fillRect(f.x - 36, f.y - 36, 72, 72);
      ctx.restore();
    }
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.scale(SCALE * 0.9, SCALE * 0.9);
    ctx.translate(-f.x, -f.y);
    const float = Math.sin(this.clock * 2.2) * 3;
    const x = f.x;
    const y = f.y - 46 + float;
    const glow = ctx.createRadialGradient(x, y, 2, x, y, working ? 40 : 32);
    glow.addColorStop(0, `${hex(colors.glow)}99`);
    glow.addColorStop(0.5, `${hex(colors.glow)}33`);
    glow.addColorStop(1, `${hex(colors.glow)}00`);
    ctx.fillStyle = glow;
    ctx.fillRect(x - 44, y - 44, 88, 88);
    const flick = Math.sin(this.clock * 9) * (working ? 2.5 : 1.2);
    const sway = Math.sin(this.clock * 3.1) * 1.2;
    const body = ctx.createLinearGradient(x, y - 26, x, y + 13);
    body.addColorStop(0, hex(colors.high));
    body.addColorStop(1, hex(colors.low));
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(x + flick, y - 26);
    ctx.bezierCurveTo(x + 14 + sway, y - 10, x + 15, y + 3, x, y + 13);
    ctx.bezierCurveTo(x - 15, y + 3, x - 14 + sway, y - 10, x + flick, y - 26);
    ctx.fill();
    // A warm core and a highlight: she's light, not a sticker.
    const core = ctx.createRadialGradient(x - 2, y + 2, 0, x, y + 2, 10);
    core.addColorStop(0, 'rgba(255, 255, 255, 0.55)');
    core.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.ellipse(x, y + 3, 9, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    this.eyes(ctx, x, y + 1, 1, '#2a1f45', 1.05, entity.blink < 0);
    if (working) {
      for (let i = 0; i < 4; i += 1) {
        const p = (this.clock * 0.9 + i / 4) % 1;
        ctx.fillStyle = `rgba(255, 230, 180, ${1 - p})`;
        ctx.beginPath();
        ctx.arc(x - 10 + i * 7 + Math.sin(p * 9) * 3, y - 22 - p * 20, 1.3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
    this.labels.push([entity.data.name, x, f.y + 30, STATE_DOT[entity.data.state]]);
  }

  drawLobster(ctx, entity, sky) {
    const { x, y, face } = entity;
    const working = entity.data.state === 'working';
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(SCALE, SCALE);
    ctx.translate(-x, -y);
    ctx.strokeStyle = 'rgba(220, 235, 255, 0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(x - face * 8, y + 1, 14, 3, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(face, 1);
    const shell = ctx.createLinearGradient(0, -12, 0, 2);
    shell.addColorStop(0, '#ff7a63');
    shell.addColorStop(1, mix('#c4362c', sky.tint, 0.15));
    ctx.fillStyle = shell;
    ctx.strokeStyle = '#d9483b';
    ctx.lineWidth = 2;
    // Tail in three segments, then the body.
    for (let i = 0; i < 3; i += 1) {
      ctx.beginPath();
      ctx.ellipse(-10 - i * 5, -4 + i * 0.6, 4.4 - i * 0.8, 3.6 - i * 0.6, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.ellipse(0, -5, 10, 6.5, 0, 0, Math.PI * 2);
    ctx.fill();
    const snap = working ? Math.abs(Math.sin(this.clock * 8)) * 0.6 : 0.15;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(7, -6 + side * 3);
      ctx.lineTo(13, -9 + side * 5);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(16.5, -9 + side * 6, 4.4, snap, Math.PI * 2 - snap);
      ctx.lineTo(16.5, -9 + side * 6);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.beginPath();
    ctx.ellipse(-2, -8.5, 5, 1.6, -0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#f39a8e';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(8, -9);
    ctx.quadraticCurveTo(16, -24, 25, -19);
    ctx.moveTo(6, -10);
    ctx.quadraticCurveTo(12, -26, 21, -24);
    ctx.stroke();
    ctx.restore();
    this.eyes(ctx, x + face * 5, y - 10, face, '#1a1010', 0.8, entity.blink < 0);
    ctx.restore();
    this.labels.push([entity.data.name, x, y + 14 * SCALE, STATE_DOT[entity.data.state]]);
  }

  drawAgent(ctx, entity, sky) {
    const { data } = entity;
    const look = KINDS[data.kind] ?? OTHER;
    const state = data.state;
    const seated = state === 'idle' && entity.seat >= 0 && !entity.walking && !entity.visit;
    // A seat may be a crate or a stool (no shadow under them) or the hot water (only the head shows).
    const seat = seated ? this.places.seats[entity.seat] : null;
    const soak = seat?.pose === 'soak';
    const asleep = state === 'idle' && !entity.walking && entity.rest > 8;
    let hop = 0;
    if (entity.walking) hop = Math.abs(Math.sin(entity.phase)) * (state === 'working' ? 3.5 : 2.5);
    if (state === 'waiting' && !entity.walking) hop = Math.abs(Math.sin(this.clock * 7)) * 7;
    if (entity.bump) hop += Math.sin((0.7 - entity.bump) * 9) * 4;
    if (entity.party) hop += Math.abs(Math.sin(entity.party * 10)) * 5;
    // Squash on the ground, stretch in the air; a slow breath when still.
    const moving = entity.walking || state === 'waiting' || entity.party > 0;
    const air = Math.min(1, hop / 6);
    const sy = moving ? 0.9 + air * 0.18 : 1 + Math.sin(this.clock * 2 + entity.phase) * 0.025;
    const sx = 1 / sy;
    const x = entity.x;
    const ground = entity.y;
    ctx.save();
    ctx.translate(x, ground);
    ctx.scale(SCALE, SCALE);
    ctx.translate(-x, -ground);
    const base = soak ? ground + 8 : ground - 2 - hop - (seated ? 7 : 0);
    const rx = 12 * sx;
    const ry = 11 * sy;
    const y = base - ry;
    if (soak) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x - 60, ground - 90, 120, 90);
      ctx.clip();
    } else if (!seat?.perch) {
      this.shadow(ctx, x, ground, 14, hop);
    }
    // Feet.
    if (!seated) {
      ctx.fillStyle = shade(look.body, -0.4);
      const swing = entity.walking ? Math.sin(entity.phase) * 3 : 0;
      for (const [dx, s] of [
        [-5, swing],
        [5, -swing],
      ]) {
        ctx.beginPath();
        ctx.ellipse(x + dx + s, ground - 2 - hop * 0.35, 3.4, 2.2, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // Body: lit from the top left, a rim of light, darker underneath.
    const fill = ctx.createRadialGradient(x - rx * 0.35, y - ry * 0.45, 1, x, y, rx * 1.25);
    fill.addColorStop(0, shade(look.body, 0.32));
    fill.addColorStop(0.55, look.body);
    fill.addColorStop(1, shade(look.body, -0.32));
    ctx.fillStyle = fill;
    ctx.beginPath();
    if (look.square) ctx.roundRect(x - rx * 0.92, y - ry * 0.92, rx * 1.84, ry * 1.84, 6);
    else ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.beginPath();
    ctx.ellipse(x - rx * 0.42, y - ry * 0.5, 2.6, 1.6, -0.5, 0, Math.PI * 2);
    ctx.fill();
    if (sky.light < 0.8) {
      // Dusk and night tint them too.
      ctx.fillStyle = `rgba(30, 24, 70, ${(0.8 - sky.light) * 0.35})`;
      ctx.beginPath();
      if (look.square) ctx.roundRect(x - rx * 0.92, y - ry * 0.92, rx * 1.84, ry * 1.84, 6);
      else ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    const cap = soak ? null : CAPS[data.where];
    if (soak) {
      // In the bath the beanie gives way to a folded towel.
      ctx.fillStyle = '#f7f3ea';
      ctx.beginPath();
      ctx.roundRect(x - 8, y - ry - 3, 16, 5, 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(120, 120, 140, 0.35)';
      ctx.fillRect(x - 6, y - ry - 1, 12, 0.8);
    }
    if (cap) {
      // A little beanie with a highlight and a brim on the side they face.
      const top = y - ry * 0.55;
      const hat = ctx.createLinearGradient(x, top - 6, x, top + 2);
      hat.addColorStop(0, shade(cap, 0.2));
      hat.addColorStop(1, shade(cap, -0.15));
      ctx.fillStyle = hat;
      ctx.beginPath();
      ctx.ellipse(x, top, rx * 0.8, 6.5, 0, Math.PI, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.roundRect(x + (entity.face > 0 ? 1 : -12), top - 1.5, 11, 2.5, 1.2);
      ctx.fill();
      ctx.fillStyle = shade(cap, 0.35);
      ctx.beginPath();
      ctx.arc(x, top - 6.5, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    // Cheeks.
    ctx.fillStyle = 'rgba(255, 140, 150, 0.35)';
    for (const dx of [-7, 7]) {
      ctx.beginPath();
      ctx.ellipse(x + dx + entity.face * 1.5, y + 3.5, 2.4, 1.4, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    if (asleep) {
      ctx.strokeStyle = '#2a1712';
      ctx.lineWidth = 1.2;
      for (const dx of [-4, 4]) {
        ctx.beginPath();
        ctx.arc(x + dx, y, 2, 0.2, Math.PI - 0.2);
        ctx.stroke();
      }
      const p = (this.clock * 0.5 + entity.phase) % 1;
      ctx.fillStyle = `rgba(230, 230, 255, ${1 - p})`;
      ctx.font = `700 ${8 + p * 4}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('z', x + 11 + p * 8, y - 13 - p * 14);
    } else {
      this.eyes(ctx, x + entity.face * 2, y - 1, entity.face, '#2a1712', 1, entity.blink < 0);
    }
    if (state === 'working' && !entity.visit) {
      // The laptop, and its glow on the face.
      const lx = x + entity.face * 5;
      const light = ctx.createRadialGradient(lx, y + 4, 0, lx, y + 2, 16);
      light.addColorStop(0, 'rgba(150, 210, 255, 0.35)');
      light.addColorStop(1, 'rgba(150, 210, 255, 0)');
      ctx.fillStyle = light;
      ctx.fillRect(lx - 16, y - 14, 32, 32);
      ctx.fillStyle = '#23252f';
      ctx.beginPath();
      ctx.roundRect(lx - 8, y + 3, 16, 8, 2);
      ctx.fill();
      ctx.fillStyle = '#a9dcff';
      ctx.beginPath();
      ctx.roundRect(lx - 6, y + 4.5, 12, 4, 1);
      ctx.fill();
      if (Math.sin(entity.phase * 0.7) > 0.6) {
        ctx.fillStyle = '#c9e8ff';
        ctx.beginPath();
        ctx.arc(x - entity.face * 13, y - 9 + Math.sin(entity.phase) * 2, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (state === 'waiting') {
      // An amber badge with the "!", and a waving arm.
      const by = y - ry - 13 - Math.sin(this.clock * 5) * 1.5;
      const halo = ctx.createRadialGradient(x, by, 0, x, by, 14);
      halo.addColorStop(0, 'rgba(245, 196, 81, 0.45)');
      halo.addColorStop(1, 'rgba(245, 196, 81, 0)');
      ctx.fillStyle = halo;
      ctx.fillRect(x - 14, by - 14, 28, 28);
      ctx.fillStyle = '#f5c451';
      ctx.beginPath();
      ctx.arc(x, by, 6.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#3a2a05';
      ctx.font = `800 10px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('!', x, by + 3.6);
      ctx.strokeStyle = shade(look.body, -0.2);
      ctx.lineCap = 'round';
      ctx.lineWidth = 3;
      ctx.beginPath();
      const wave = Math.sin(this.clock * 10) * 0.5;
      ctx.moveTo(x + rx * 0.8, y);
      ctx.lineTo(x + rx * 0.8 + Math.cos(-1.2 + wave) * 8, y + Math.sin(-1.2 + wave) * 8);
      ctx.stroke();
    }
    if (state === 'done' || entity.party) {
      ctx.fillStyle = '#f5c451';
      this.star(ctx, x, y - ry - 9 - Math.sin(this.clock * 3) * 2, 4.5);
    }
    if (entity.party) {
      for (let i = 0; i < 12; i += 1) {
        const angle = (i / 12) * Math.PI * 2;
        const r = (1.6 - entity.party) * 28;
        ctx.fillStyle = ['#f472b6', '#5cc8ff', '#f5c451', '#3ddc97'][i % 4];
        ctx.save();
        ctx.translate(x + Math.cos(angle) * r, y - 6 + Math.sin(angle) * r * 0.7);
        ctx.rotate(angle + entity.party * 6);
        ctx.fillRect(-1.5, -1, 3, 2);
        ctx.restore();
      }
    }
    // Helpers: little copies trotting behind.
    (data.helpers ?? []).forEach((_, index) => {
      const hx = x - entity.face * (17 + index * 11);
      const hy = ground - 6 - Math.abs(Math.sin(entity.phase + index)) * 2;
      this.shadow(ctx, hx, ground, 6);
      const mini = ctx.createRadialGradient(hx - 2, hy - 2, 0, hx, hy, 6);
      mini.addColorStop(0, shade(look.body, 0.3));
      mini.addColorStop(1, shade(look.body, -0.2));
      ctx.fillStyle = mini;
      ctx.beginPath();
      ctx.arc(hx, hy, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#2a1712';
      ctx.fillRect(hx + entity.face * 1.5 - 0.6, hy - 1.5, 1.2, 1.6);
    });
    if (soak) ctx.restore();
    ctx.restore();
    if (soak) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(x, ground, 19 + Math.sin(this.clock * 2 + entity.phase) * 1.5, 3.5, 0, 0, TAU);
      ctx.stroke();
    }
    this.labels.push([clip(data.name, 20), x, ground + 14 * SCALE, STATE_DOT[state]]);
  }

  drawEnvelope(ctx, envelope) {
    const from = this.entities.get(envelope.from);
    const to = this.entities.get(envelope.to);
    if (!from || !to) return;
    const p = envelope.t;
    const x = from.x + (to.x - from.x) * p;
    const y = from.y - 22 + (to.y - from.y) * p - Math.sin(p * Math.PI) * 28;
    const trail = ctx.createRadialGradient(x, y, 0, x, y, 12);
    trail.addColorStop(0, 'rgba(200, 182, 255, 0.4)');
    trail.addColorStop(1, 'rgba(200, 182, 255, 0)');
    ctx.fillStyle = trail;
    ctx.fillRect(x - 12, y - 12, 24, 24);
    // The message flies as a folded paper crane.
    crane(ctx, x, y, this.clock, to.x >= from.x ? 1 : -1);
  }

  drawBubble(ctx, entity) {
    const visit = entity.visit;
    if (!visit || visit.talk <= 0) return;
    const text = clip(visit.label || (visit.kind === 'tsukumo' ? t('Tsukumo, a word…') : '…'), 34);
    ctx.font = `600 10px ${FONT}`;
    const width = ctx.measureText(text).width + 16;
    const x = Math.max(4, Math.min(this.width - width - 4, entity.x - width / 2));
    const y = Math.max(4, entity.y - 58);
    ctx.globalAlpha = Math.min(1, visit.talk * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.beginPath();
    ctx.roundRect(x + 1, y + 2, width, 20, 10);
    ctx.fill();
    ctx.fillStyle = '#f6f4ff';
    ctx.beginPath();
    ctx.roundRect(x, y, width, 20, 10);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(entity.x - 4, y + 19);
    ctx.lineTo(entity.x, y + 25);
    ctx.lineTo(entity.x + 4, y + 19);
    ctx.fill();
    ctx.fillStyle = '#26203d';
    ctx.textAlign = 'left';
    ctx.fillText(text, x + 8, y + 13.5);
    ctx.globalAlpha = 1;
  }

  eyes(ctx, x, y, face, color, scale = 1, closed = false) {
    for (const dx of [-3.8, 3.8]) {
      if (closed) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x + dx * scale - 2 * scale, y);
        ctx.lineTo(x + dx * scale + 2 * scale, y);
        ctx.stroke();
        continue;
      }
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(x + dx * scale, y, 2.8 * scale, 3.1 * scale, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x + dx * scale + face * 0.9, y + 0.4, 1.7 * scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x + dx * scale + face * 0.9 - 0.6, y - 0.5, 0.55 * scale, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  star(ctx, x, y, r) {
    ctx.beginPath();
    for (let i = 0; i < 10; i += 1) {
      const angle = -Math.PI / 2 + (i * Math.PI) / 5;
      const radius = i % 2 ? r * 0.45 : r;
      ctx.lineTo(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
    }
    ctx.closePath();
    ctx.fill();
  }

  /** A name on a small glass pill, with the state's dot; two side by side don't overlap. */
  pill(ctx, text, x, y, dot, size = 10) {
    ctx.font = `600 ${size}px ${FONT}`;
    const width = ctx.measureText(text).width + (dot ? 20 : 12);
    const height = size + 7;
    for (let tries = 0; tries < 3 && this.taken?.some((box) => Math.abs(box.x - x) < (box.width + width) / 2 + 2 && Math.abs(box.y - y) < height); tries += 1) y += height + 2;
    this.taken?.push({ x, y, width });
    const left = Math.max(2, Math.min(this.width - width - 2, x - width / 2));
    ctx.fillStyle = 'rgba(12, 10, 24, 0.62)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(left, y - height / 2, width, height, height / 2);
    ctx.fill();
    ctx.stroke();
    if (dot) {
      ctx.fillStyle = dot;
      ctx.beginPath();
      ctx.arc(left + 8.5, y, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(240, 238, 248, 0.95)';
    ctx.textAlign = 'left';
    ctx.fillText(text, left + (dot ? 15 : 6), y + size * 0.36);
  }

  // ----------------------------------------------------------------- hover
  hover(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    let best = null;
    let bestDistance = 24;
    for (const entity of this.entities.values()) {
      if (!entity.data) continue;
      const cy = entity.data.kind === 'tsukumo' ? entity.y - 52 : entity.y - 14 * SCALE;
      const distance = Math.hypot(entity.x - x, cy - y);
      if (distance < bestDistance) [best, bestDistance] = [entity, distance];
    }
    const kiosk = this.places?.kiosk;
    const onKiosk = this.data?.lmstudio && kiosk && Math.abs(x - kiosk.x) < kiosk.w / 2 && Math.abs(y - kiosk.y) < kiosk.h / 2;
    this.setFocus(best?.id ?? null);
    if (!best && !onKiosk) {
      this.tip.classList.add('hidden');
      return;
    }
    const lines = best ? this.describe(best.data) : [['LM Studio', this.data.lmstudio.model || t('no model loaded')]];
    this.tip.replaceChildren(...lines.map(([main, sub], index) => el(index ? 'small' : 'strong', {}, sub ? `${main} · ${sub}` : main)));
    this.tip.classList.remove('hidden');
    const left = Math.min(this.width - this.tip.offsetWidth - 6, Math.max(6, x + 12));
    this.tip.style.left = `${left}px`;
    this.tip.style.top = `${Math.max(6, y - this.tip.offsetHeight - 10)}px`;
  }

  describe(agent) {
    if (agent.kind === 'tsukumo') return [['Tsukumo', agent.brain && agent.brain !== 'Tsukumo' ? t('brain: {name}', { name: agent.brain }) : ''], [STATE_TEXT[agent.state] ?? agent.state]];
    if (agent.kind === 'openclaw') return [[agent.name, t(this.setting.pondText)], [STATE_TEXT[agent.state] ?? agent.state]];
    const look = KINDS[agent.kind] ?? OTHER;
    const lines = [[agent.name, [look.label || agent.kind, WHERE[agent.where]].filter(Boolean).join(' · ')]];
    if (agent.project) lines.push([t('in {folder}', { folder: agent.project })]);
    const state = STATE_TEXT[agent.state] ?? agent.state;
    lines.push([agent.since && agent.state !== 'idle' ? `${state}, ${sinceText(agent.since)}` : state]);
    if (agent.tasks?.total) lines.push([t('Task list: {done} of {total}', { done: agent.tasks.done, total: agent.tasks.total })]);
    if (agent.helpers?.length) lines.push([t('{n} helpers with them', { n: agent.helpers.length })]);
    return lines;
  }
}
