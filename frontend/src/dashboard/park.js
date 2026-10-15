/**
 * The park: every agent on this PC hanging out on a lawn (backend/park.py).
 *
 * Claude Code sessions are little terracotta blobs (a blue cap in VS Code, a
 * dark one in a terminal), Codex a teal box, OpenClaw a lobster in the pond,
 * LM Studio the kiosk with the model it serves, and Tsukumo floats over the
 * fountain. Who works runs around with a laptop, who's idle sits on the bench
 * and dozes, who waits for you jumps at the front and waves. A message sent:
 * the sender walks over, says what about, and an envelope flies.
 *
 * A canvas animated only while the tile is on screen and the window visible;
 * with "reduce motion" it's a still picture, redrawn when the data changes.
 * All the text drawn comes from the backend as data (fillText: nothing to inject).
 */

import { el, readSetting } from '../dom.js';
import { palette } from '../flame/palettes.js';
import { t } from '../i18n.js';
import { nowSeconds, sinceText } from './time.js';
import { card } from './widgets.js';

const HEIGHT = 250;
const HORIZON = 62;
const FRAME = 1000 / 30;
const REDUCED = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
/** A link newer than this (s) is walked over; older ones are just a thread. */
const FRESH = 120;
const LINK_TTL = 30 * 60;
const TALK = 5;
const FONT = "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif";

const KINDS = {
  claude: { body: '#d97757', dark: '#a9583c', label: 'Claude Code' },
  codex: { body: '#19a383', dark: '#0d7660', label: 'Codex', square: true },
  gemini: { body: '#5b8ff0', dark: '#3563bd', label: 'Gemini CLI' },
  cursor: { body: '#a3a8b6', dark: '#6f7484', label: 'Cursor', square: true },
};
const OTHER = { body: '#b3a9cf', dark: '#7f7699', label: '' };
const CAPS = { vscode: '#3b8eea', terminal: '#26262e', desktop: '#efece4', jetbrains: '#f0476f' };
const WHERE = { vscode: 'VS Code', terminal: t('terminal'), desktop: 'Claude Desktop', jetbrains: 'JetBrains' };
const STATE_TEXT = { working: t('working'), waiting: t('waiting for you'), done: t('done'), idle: t('ready') };
const SPEED = { working: 52, waiting: 64, done: 30, idle: 24, visit: 74, leave: 60 };

/** Always the same trees and stars for the same width: a seeded random. */
function seeded(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let x = Math.imul(value ^ (value >>> 15), 1 | value);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = (min, max) => min + Math.random() * (max - min);
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const hex = (value) => `#${value.toString(16).padStart(6, '0')}`;

export class ParkWidget {
  constructor() {
    this.legend = el('p', { class: 'w-park-legend' });
    ({ node: this.node, body: this.body } = card('w-park', 'tree', t('The park')));
    this.canvas = el('canvas', { class: 'w-park-canvas', role: 'img' });
    this.tip = el('div', { class: 'w-park-tip hidden', role: 'tooltip' });
    this.scene = el('div', { class: 'w-park-scene' }, this.canvas, this.tip);
    this.body.append(this.scene, this.legend);
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

    new ResizeObserver(() => this.resize()).observe(this.scene);
    new IntersectionObserver((entries) => {
      this.visible = entries.some((entry) => entry.isIntersecting);
      this.loop();
    }).observe(this.scene);
    document.addEventListener('visibilitychange', () => this.loop());
    this.canvas.addEventListener('pointermove', (event) => this.hover(event));
    this.canvas.addEventListener('pointerleave', () => this.tip.classList.add('hidden'));
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
      if (entity.data && entity.data.state !== 'done' && agent.state === 'done') entity.party = 1.6;
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
    this.renderLegend(now);
    if (REDUCED || !this.raf) this.draw();
    this.loop();
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
    this.canvas.setAttribute('aria-label', `${t('The park')}: ${text}`);
  }

  spawn(agent) {
    const entity = { id: agent.id, data: null, x: 0, y: 0, tx: 0, ty: 0, face: 1, pause: 0, walking: false, phase: Math.random() * 6, visits: [], visit: null, bump: 0, party: 0, rest: 0 };
    const gate = this.gate();
    if (this.ready && agent.kind !== 'tsukumo' && agent.kind !== 'openclaw') {
      // Someone new arrives through the gate.
      [entity.x, entity.y] = gate;
    } else {
      [entity.x, entity.y] = this.width ? this.wander() : [0, 0];
    }
    [entity.tx, entity.ty] = [entity.x, entity.y];
    return entity;
  }

  // ---------------------------------------------------------------- layout
  resize() {
    const width = Math.round(this.scene.clientWidth);
    if (!width || width === this.width) return;
    const first = !this.width;
    this.width = width;
    const ratio = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(HEIGHT * ratio);
    this.canvas.style.height = `${HEIGHT}px`;
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const W = width;
    this.places = {
      fountain: { x: W * 0.5, y: 132 },
      bench: { x: Math.min(W - 64, W * 0.8), y: 98 },
      pond: { x: Math.max(74, W * 0.15), y: 204 },
      kiosk: { x: Math.max(48, W * 0.08), y: 92 },
      front: { x: W * 0.5, y: HEIGHT - 22 },
    };
    this.makeScenery();
    for (const entity of this.entities.values()) {
      if (first || entity.x > W) [entity.x, entity.y] = this.wander();
      [entity.tx, entity.ty] = [entity.x, entity.y];
    }
    this.ready = Boolean(this.data);
    this.draw();
    this.loop();
  }

  makeScenery() {
    const random = seeded(this.width);
    this.trees = [];
    for (let x = -10; x < this.width + 20; x += 26 + random() * 34) this.trees.push({ x, r: 13 + random() * 11, dy: random() * 8, hue: random() });
    this.stars = Array.from({ length: Math.round(this.width / 22) }, () => ({ x: random() * this.width, y: random() * (HORIZON - 14), r: 0.5 + random(), tw: random() * 6 }));
    this.tufts = Array.from({ length: Math.round(this.width / 16) }, () => ({ x: random() * this.width, y: HORIZON + 18 + random() * (HEIGHT - HORIZON - 22) }));
    this.lamps = [this.width * 0.3, this.width * 0.68];
  }

  gate() {
    return [-14, HEIGHT - 58];
  }

  blocked(x, y) {
    const { fountain, pond, kiosk, bench } = this.places;
    const inside = (place, rx, ry) => ((x - place.x) / rx) ** 2 + ((y - place.y) / ry) ** 2 < 1;
    return inside(fountain, 78, 30) || inside(pond, 70, 28) || (this.data?.lmstudio && Math.abs(x - kiosk.x) < 42 && Math.abs(y - kiosk.y) < 30) || (Math.abs(x - bench.x) < 46 && Math.abs(y - bench.y) < 12);
  }

  wander() {
    for (let tries = 0; tries < 20; tries += 1) {
      const x = rand(26, this.width - 26);
      const y = rand(HORIZON + 34, HEIGHT - 30);
      if (!this.blocked(x, y)) return [x, y];
    }
    return [this.width * 0.5, HEIGHT - 40];
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
    const all = [...this.entities.values()];
    const walkers = all.filter((entity) => entity.data && !['tsukumo', 'openclaw'].includes(entity.data.kind));
    // Seats on the bench for the idle ones, places at the front for who's waiting.
    const idle = walkers.filter((entity) => entity.data.state === 'idle' && !entity.visit && !entity.leaving);
    const waiting = walkers.filter((entity) => entity.data.state === 'waiting' && !entity.visit && !entity.leaving);
    idle.forEach((entity, index) => (entity.seat = index < 3 ? index : -1));
    waiting.forEach((entity, index) => (entity.slot = index - (waiting.length - 1) / 2));
    for (const entity of walkers) this.step(entity, dt);
    for (const entity of all) {
      entity.bump = Math.max(0, entity.bump - dt);
      entity.party = Math.max(0, entity.party - dt);
    }
    const lobster = this.entities.get('openclaw');
    if (lobster) {
      const { pond } = this.places;
      const speed = lobster.data.state === 'working' ? 1.4 : 0.35;
      lobster.phase += dt * speed;
      lobster.x = pond.x + Math.cos(lobster.phase) * 34;
      lobster.y = pond.y + Math.sin(lobster.phase) * 9;
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
        const { fountain } = this.places;
        [entity.tx, entity.ty] = visit.to === 'tsukumo' ? [fountain.x + side * 66, fountain.y + 22] : [other.x + side * 26, other.y + 2];
        speed = SPEED.visit;
        if (Math.hypot(entity.tx - entity.x, entity.ty - entity.y) < 3) {
          visit.talk = TALK;
          this.envelopes.push({ from: entity.id, to: visit.to, t: 0 });
        }
      }
    } else if (state === 'waiting') {
      const { front } = this.places;
      [entity.tx, entity.ty] = [front.x + (entity.slot ?? 0) * 34, front.y];
    } else if (state === 'idle' && entity.seat >= 0) {
      const { bench } = this.places;
      [entity.tx, entity.ty] = [bench.x + (entity.seat - 1) * 24, bench.y + 4];
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

  // ------------------------------------------------------------------ draw
  draw() {
    if (!this.width || !this.places) return;
    const ctx = this.context;
    const hour = new Date().getHours();
    const night = hour < 7 || hour >= 20;
    ctx.clearRect(0, 0, this.width, HEIGHT);
    this.taken = [];
    this.drawScenery(ctx, night);
    this.drawThreads(ctx);
    const lmstudio = this.data?.lmstudio;
    if (lmstudio) this.drawKiosk(ctx, lmstudio);
    this.drawPond(ctx);
    this.drawFountain(ctx);
    this.drawBench(ctx);
    this.drawBrainLinks(ctx);
    // Back to front: who's lower on the lawn is closer.
    const sorted = [...this.entities.values()].filter((entity) => entity.data).sort((a, b) => a.y - b.y);
    for (const entity of sorted) {
      if (entity.data.kind === 'tsukumo') this.drawTsukumo(ctx, entity);
      else if (entity.data.kind === 'openclaw') this.drawLobster(ctx, entity);
      else this.drawAgent(ctx, entity);
    }
    for (const envelope of this.envelopes) this.drawEnvelope(ctx, envelope);
    for (const entity of sorted) this.drawBubble(ctx, entity);
    if (!this.data) this.caption(ctx, t('Looking around the park…'));
  }

  drawScenery(ctx, night) {
    const W = this.width;
    const sky = ctx.createLinearGradient(0, 0, 0, HORIZON + 10);
    sky.addColorStop(0, night ? '#0b1026' : '#2b4a78');
    sky.addColorStop(1, night ? '#1c2348' : '#5b7aa6');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, HORIZON + 10);
    if (night) {
      for (const star of this.stars) {
        ctx.globalAlpha = 0.45 + 0.4 * Math.sin(this.clock * 1.6 + star.tw);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(star.x, star.y, star.r, star.r);
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#f3efd9';
      ctx.beginPath();
      ctx.arc(W - 46, 22, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#0f1530';
      ctx.beginPath();
      ctx.arc(W - 41, 19, 9, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const sun = ctx.createRadialGradient(W - 50, 24, 2, W - 50, 24, 28);
      sun.addColorStop(0, 'rgba(255, 228, 150, 0.95)');
      sun.addColorStop(0.4, 'rgba(255, 210, 120, 0.45)');
      sun.addColorStop(1, 'rgba(255, 210, 120, 0)');
      ctx.fillStyle = sun;
      ctx.fillRect(W - 80, 0, 60, 54);
    }
    for (const tree of this.trees) {
      ctx.fillStyle = night ? '#3a2c22' : '#4c3a2a';
      ctx.fillRect(tree.x - 2, HORIZON - 6 + tree.dy, 4, 14);
      ctx.fillStyle = night ? (tree.hue > 0.5 ? '#14301f' : '#183824') : tree.hue > 0.5 ? '#2c6040' : '#336c47';
      ctx.beginPath();
      ctx.arc(tree.x, HORIZON - 10 + tree.dy, tree.r, 0, Math.PI * 2);
      ctx.fill();
    }
    const lawn = ctx.createLinearGradient(0, HORIZON, 0, HEIGHT);
    lawn.addColorStop(0, night ? '#18361f' : '#2f6538');
    lawn.addColorStop(1, night ? '#102616' : '#24502c');
    ctx.fillStyle = lawn;
    ctx.fillRect(0, HORIZON, W, HEIGHT - HORIZON);
    ctx.strokeStyle = night ? 'rgba(120, 170, 120, 0.25)' : 'rgba(170, 220, 150, 0.3)';
    ctx.lineWidth = 1;
    for (const tuft of this.tufts) {
      ctx.beginPath();
      ctx.moveTo(tuft.x - 2, tuft.y);
      ctx.lineTo(tuft.x - 3, tuft.y - 4);
      ctx.moveTo(tuft.x, tuft.y);
      ctx.lineTo(tuft.x, tuft.y - 5);
      ctx.moveTo(tuft.x + 2, tuft.y);
      ctx.lineTo(tuft.x + 3, tuft.y - 4);
      ctx.stroke();
    }
    // The path from the gate to the plaza and on to the right.
    const { fountain } = this.places;
    const sand = night ? '#4d4436' : '#8b7656';
    ctx.strokeStyle = sand;
    ctx.lineWidth = 18;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-20, HEIGHT - 58);
    ctx.quadraticCurveTo(W * 0.25, HEIGHT - 40, fountain.x, fountain.y + 8);
    ctx.quadraticCurveTo(W * 0.75, HEIGHT - 20, W + 20, HEIGHT - 70);
    ctx.stroke();
    ctx.fillStyle = sand;
    ctx.beginPath();
    ctx.ellipse(fountain.x, fountain.y + 4, 84, 30, 0, 0, Math.PI * 2);
    ctx.fill();
    for (const x of this.lamps) {
      ctx.strokeStyle = '#1c1c22';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, HORIZON + 40);
      ctx.lineTo(x, HORIZON + 8);
      ctx.stroke();
      if (night) {
        const glow = ctx.createRadialGradient(x, HORIZON + 6, 1, x, HORIZON + 6, 30);
        glow.addColorStop(0, 'rgba(255, 220, 140, 0.55)');
        glow.addColorStop(1, 'rgba(255, 220, 140, 0)');
        ctx.fillStyle = glow;
        ctx.fillRect(x - 30, HORIZON - 24, 60, 60);
      }
      ctx.fillStyle = night ? '#ffe3a0' : '#d9d2bd';
      ctx.beginPath();
      ctx.arc(x, HORIZON + 6, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** The chats of the last half hour: a thread that fades. */
  drawThreads(ctx) {
    const now = nowSeconds();
    const pairs = new Map();
    for (const link of this.data?.links ?? []) if (link.kind === 'message') pairs.set([link.from, link.to].sort().join('|'), link);
    ctx.setLineDash([3, 5]);
    ctx.lineWidth = 1.4;
    for (const link of pairs.values()) {
      const a = this.entities.get(link.from);
      const b = this.entities.get(link.to);
      if (!a || !b) continue;
      ctx.strokeStyle = `rgba(214, 200, 255, ${0.55 * Math.max(0.15, 1 - (now - link.at) / LINK_TTL)})`;
      const mx = (a.x + b.x) / 2;
      const my = Math.min(a.y, b.y) - 18 - Math.abs(a.x - b.x) * 0.08;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y - 12);
      ctx.quadraticCurveTo(mx, my, b.x, b.y - 12);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  drawFountain(ctx) {
    const { fountain: f } = this.places;
    ctx.fillStyle = '#6f6e7a';
    ctx.beginPath();
    ctx.ellipse(f.x, f.y, 46, 14, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#3e6f9e';
    ctx.beginPath();
    ctx.ellipse(f.x, f.y - 1, 40, 10, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#8a8996';
    ctx.fillRect(f.x - 4, f.y - 16, 8, 14);
    // Water jets.
    ctx.strokeStyle = 'rgba(170, 215, 255, 0.7)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 4; i += 1) {
      const spread = (i - 1.5) * 9;
      const lift = 10 + Math.sin(this.clock * 3 + i) * 2;
      ctx.beginPath();
      ctx.moveTo(f.x, f.y - 16);
      ctx.quadraticCurveTo(f.x + spread * 0.6, f.y - 16 - lift, f.x + spread * 1.8, f.y - 4);
      ctx.stroke();
    }
  }

  drawPond(ctx) {
    const { pond: p } = this.places;
    ctx.fillStyle = '#20476b';
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, 58, 20, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(160, 200, 240, 0.35)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 3; i += 1) {
      const wave = (this.clock * 6 + i * 14) % 40;
      ctx.beginPath();
      ctx.ellipse(p.x - 20 + i * 18, p.y + 4 - i * 3, 6 + wave * 0.1, 1.5, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  drawBench(ctx) {
    const { bench: b } = this.places;
    ctx.fillStyle = '#7a5434';
    ctx.fillRect(b.x - 40, b.y - 14, 80, 5);
    ctx.fillRect(b.x - 40, b.y - 4, 80, 5);
    ctx.fillStyle = '#3d2c1e';
    ctx.fillRect(b.x - 36, b.y + 1, 3, 8);
    ctx.fillRect(b.x + 33, b.y + 1, 3, 8);
  }

  drawKiosk(ctx, lmstudio) {
    const { kiosk: k } = this.places;
    ctx.fillStyle = '#ece6da';
    ctx.fillRect(k.x - 30, k.y - 6, 60, 26);
    ctx.fillStyle = '#5a4a7a';
    ctx.fillRect(k.x - 30, k.y + 2, 60, 3);
    for (let i = 0; i < 6; i += 1) {
      ctx.fillStyle = i % 2 ? '#f4f0ff' : '#8f7bff';
      ctx.beginPath();
      ctx.moveTo(k.x - 34 + i * 12, k.y - 22);
      ctx.lineTo(k.x - 22 + i * 12, k.y - 22);
      ctx.lineTo(k.x - 22 + i * 12, k.y - 12);
      ctx.arc(k.x - 28 + i * 12, k.y - 12, 6, 0, Math.PI);
      ctx.fill();
    }
    ctx.fillStyle = '#2a2a33';
    ctx.font = `700 9px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('LM Studio', k.x, k.y + 16);
    if (lmstudio.model) this.label(ctx, clip(lmstudio.model.split('/').pop(), 22), k.x, k.y + 32, 'rgba(236, 236, 241, 0.75)', 9);
  }

  drawBrainLinks(ctx) {
    for (const link of this.data?.links ?? []) {
      if (link.kind !== 'brain') continue;
      const from = this.entities.get('tsukumo');
      const target = link.to === 'lmstudio' ? { x: this.places.kiosk.x, y: this.places.kiosk.y + 4 } : this.entities.get(link.to);
      if (!from || !target) continue;
      const fx = from.x;
      const fy = from.y - 30;
      const cx = (fx + target.x) / 2;
      const cy = Math.min(fy, target.y) - 40;
      for (let i = 0; i < 5; i += 1) {
        const p = (this.clock * 0.6 + i / 5) % 1;
        const x = (1 - p) ** 2 * fx + 2 * (1 - p) * p * cx + p ** 2 * target.x;
        const y = (1 - p) ** 2 * fy + 2 * (1 - p) * p * cy + p ** 2 * (target.y - 8);
        ctx.fillStyle = `rgba(200, 180, 255, ${0.8 - p * 0.5})`;
        ctx.beginPath();
        ctx.arc(x, y, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  drawTsukumo(ctx, entity) {
    const { fountain: f } = this.places;
    entity.x = f.x;
    entity.y = f.y - 2;
    const colors = palette(readSetting('dc:flame-color', 'lilac'));
    const working = entity.data.state === 'working';
    const float = Math.sin(this.clock * 2.2) * 3;
    const x = f.x;
    const y = f.y - 40 + float;
    const glow = ctx.createRadialGradient(x, y, 2, x, y, working ? 34 : 26);
    glow.addColorStop(0, `${hex(colors.glow)}aa`);
    glow.addColorStop(1, `${hex(colors.glow)}00`);
    ctx.fillStyle = glow;
    ctx.fillRect(x - 40, y - 40, 80, 80);
    const flick = Math.sin(this.clock * 9) * (working ? 2.5 : 1.2);
    const body = ctx.createLinearGradient(x, y - 22, x, y + 12);
    body.addColorStop(0, hex(colors.high));
    body.addColorStop(1, hex(colors.low));
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(x + flick, y - 22);
    ctx.bezierCurveTo(x + 12, y - 8, x + 13, y + 2, x, y + 11);
    ctx.bezierCurveTo(x - 13, y + 2, x - 12, y - 8, x + flick, y - 22);
    ctx.fill();
    this.eyes(ctx, x, y + 1, 1, '#2a1f45');
    if (working) {
      for (let i = 0; i < 3; i += 1) {
        const p = (this.clock * 0.9 + i / 3) % 1;
        ctx.fillStyle = `rgba(255, 230, 180, ${1 - p})`;
        ctx.fillRect(x - 8 + i * 8 + Math.sin(p * 9) * 3, y - 20 - p * 18, 2, 2);
      }
    }
    this.label(ctx, entity.data.name, x, f.y + 26);
  }

  drawLobster(ctx, entity) {
    const { x, y, face } = entity;
    const working = entity.data.state === 'working';
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(face, 1);
    ctx.fillStyle = '#e2483d';
    ctx.strokeStyle = '#e2483d';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, -5, 10, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(-11, -4, 5, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    const snap = working ? Math.abs(Math.sin(this.clock * 8)) * 0.6 : 0.15;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(7, -6 + side * 3);
      ctx.lineTo(13, -9 + side * 5);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(16, -9 + side * 6, 4, snap, Math.PI * 2 - snap);
      ctx.lineTo(16, -9 + side * 6);
      ctx.fill();
    }
    ctx.strokeStyle = '#f08a7f';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(8, -9);
    ctx.quadraticCurveTo(16, -22, 24, -18);
    ctx.moveTo(6, -10);
    ctx.quadraticCurveTo(12, -24, 20, -22);
    ctx.stroke();
    ctx.restore();
    this.eyes(ctx, x + face * 5, y - 9, face, '#1a1010', 0.8);
    this.label(ctx, entity.data.name, x, y + 14);
  }

  drawAgent(ctx, entity) {
    const { data } = entity;
    const look = KINDS[data.kind] ?? OTHER;
    const state = data.state;
    const seated = state === 'idle' && entity.seat >= 0 && !entity.walking && !entity.visit;
    const asleep = state === 'idle' && !entity.walking && entity.rest > 8;
    let hop = 0;
    if (entity.walking) hop = Math.abs(Math.sin(entity.phase)) * (state === 'working' ? 3 : 2);
    if (state === 'waiting' && !entity.walking) hop = Math.abs(Math.sin(this.clock * 7)) * 7;
    if (entity.bump) hop += Math.sin((0.7 - entity.bump) * 9) * 4;
    if (entity.party) hop += Math.abs(Math.sin(entity.party * 10)) * 5;
    const x = entity.x;
    const ground = entity.y;
    const y = ground - 11 - hop - (seated ? 6 : 0);
    // Shadow.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.beginPath();
    ctx.ellipse(x, ground, 10, 3, 0, 0, Math.PI * 2);
    ctx.fill();
    // Feet.
    if (!seated) {
      ctx.fillStyle = look.dark;
      const swing = entity.walking ? Math.sin(entity.phase) * 3 : 0;
      ctx.fillRect(x - 6 + swing, ground - 4 - hop * 0.3, 4, 4);
      ctx.fillRect(x + 2 - swing, ground - 4 - hop * 0.3, 4, 4);
    }
    // Body.
    ctx.fillStyle = look.body;
    ctx.beginPath();
    if (look.square) ctx.roundRect(x - 10, y - 9, 20, 18, 5);
    else ctx.ellipse(x, y, 11, 10, 0, 0, Math.PI * 2);
    ctx.fill();
    const cap = CAPS[data.where];
    if (cap) {
      ctx.fillStyle = cap;
      ctx.beginPath();
      ctx.ellipse(x, y - 7, 9, 5, 0, Math.PI, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(x + (entity.face > 0 ? 2 : -11), y - 8, 9, 2);
    }
    if (asleep) {
      ctx.strokeStyle = '#2a1712';
      ctx.lineWidth = 1.2;
      for (const dx of [-4, 4]) {
        ctx.beginPath();
        ctx.moveTo(x + dx - 2, y);
        ctx.lineTo(x + dx + 2, y);
        ctx.stroke();
      }
      const p = (this.clock * 0.5 + entity.phase) % 1;
      ctx.fillStyle = `rgba(230, 230, 255, ${1 - p})`;
      ctx.font = `700 ${8 + p * 4}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('z', x + 10 + p * 8, y - 12 - p * 14);
    } else {
      this.eyes(ctx, x + entity.face * 2, y - 1, entity.face, '#2a1712');
    }
    if (state === 'working' && !entity.visit) {
      // The laptop, and its glow on the face.
      ctx.fillStyle = '#2b2d38';
      ctx.fillRect(x + entity.face * 4 - 7, y + 3, 14, 6);
      ctx.fillStyle = '#9fd4ff';
      ctx.fillRect(x + entity.face * 4 - 5, y + 4, 10, 3);
      if (Math.sin(entity.phase * 0.7) > 0.6) {
        ctx.fillStyle = '#9fd4ff';
        ctx.beginPath();
        ctx.arc(x - entity.face * 12, y - 8 + Math.sin(entity.phase) * 2, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (state === 'waiting') {
      ctx.fillStyle = '#f5c451';
      ctx.font = `800 13px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('!', x, y - 16);
      ctx.strokeStyle = look.dark;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      const wave = Math.sin(this.clock * 10) * 0.5;
      ctx.moveTo(x + 9, y - 2);
      ctx.lineTo(x + 9 + Math.cos(-1.2 + wave) * 9, y - 2 + Math.sin(-1.2 + wave) * 9);
      ctx.stroke();
    }
    if (state === 'done' || entity.party) {
      ctx.fillStyle = '#f5c451';
      this.star(ctx, x, y - 18 - Math.sin(this.clock * 3) * 2, 4);
    }
    if (entity.party) {
      for (let i = 0; i < 10; i += 1) {
        const angle = (i / 10) * Math.PI * 2;
        const r = (1.6 - entity.party) * 26;
        ctx.fillStyle = ['#f472b6', '#5cc8ff', '#f5c451', '#3ddc97'][i % 4];
        ctx.fillRect(x + Math.cos(angle) * r, y - 6 + Math.sin(angle) * r * 0.7, 3, 3);
      }
    }
    // Helpers: little copies trotting behind.
    (data.helpers ?? []).forEach((_, index) => {
      const hx = x - entity.face * (16 + index * 10);
      const hy = ground - 5 - Math.abs(Math.sin(entity.phase + index)) * 2;
      ctx.fillStyle = look.body;
      ctx.beginPath();
      ctx.arc(hx, hy, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#2a1712';
      ctx.fillRect(hx + entity.face * 1.5 - 0.6, hy - 1.5, 1.2, 1.6);
    });
    this.label(ctx, clip(data.name, 20), x, ground + 12);
  }

  drawEnvelope(ctx, envelope) {
    const from = this.entities.get(envelope.from);
    const to = this.entities.get(envelope.to);
    if (!from || !to) return;
    const p = envelope.t;
    const x = from.x + (to.x - from.x) * p;
    const y = from.y - 20 + (to.y - from.y) * p - Math.sin(p * Math.PI) * 26;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.sin(p * 8) * 0.2);
    ctx.fillStyle = '#f4f2ff';
    ctx.fillRect(-6, -4, 12, 8);
    ctx.strokeStyle = '#8f7bff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-6, -4);
    ctx.lineTo(0, 1);
    ctx.lineTo(6, -4);
    ctx.stroke();
    ctx.restore();
  }

  drawBubble(ctx, entity) {
    const visit = entity.visit;
    if (!visit || visit.talk <= 0) return;
    const text = clip(visit.label || (visit.kind === 'tsukumo' ? t('Tsukumo, a word…') : '…'), 34);
    ctx.font = `600 10px ${FONT}`;
    const width = ctx.measureText(text).width + 14;
    const x = Math.max(4, Math.min(this.width - width - 4, entity.x - width / 2));
    const y = Math.max(4, entity.y - 52);
    ctx.globalAlpha = Math.min(1, visit.talk * 2);
    ctx.fillStyle = '#f4f2ff';
    ctx.beginPath();
    ctx.roundRect(x, y, width, 18, 7);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(entity.x - 4, y + 17);
    ctx.lineTo(entity.x, y + 23);
    ctx.lineTo(entity.x + 4, y + 17);
    ctx.fill();
    ctx.fillStyle = '#26203d';
    ctx.textAlign = 'left';
    ctx.fillText(text, x + 7, y + 12.5);
    ctx.globalAlpha = 1;
  }

  eyes(ctx, x, y, face, color, scale = 1) {
    for (const dx of [-3.5, 3.5]) {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x + dx * scale, y, 2.6 * scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x + dx * scale + face * 0.9, y + 0.3, 1.3 * scale, 0, Math.PI * 2);
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

  label(ctx, text, x, y, color = 'rgba(236, 236, 241, 0.92)', size = 10) {
    ctx.font = `600 ${size}px ${FONT}`;
    ctx.textAlign = 'center';
    // Two of them chatting side by side: the second name goes a line lower.
    const half = ctx.measureText(text).width / 2 + 3;
    for (let tries = 0; tries < 3 && this.taken?.some((box) => Math.abs(box.x - x) < box.half + half && Math.abs(box.y - y) < size + 1); tries += 1) y += size + 2;
    this.taken?.push({ x, y, half });
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(10, 14, 12, 0.7)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  caption(ctx, text) {
    this.label(ctx, text, this.width / 2, HEIGHT / 2 + 40, 'rgba(236, 236, 241, 0.8)', 12);
  }

  // ----------------------------------------------------------------- hover
  hover(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    let best = null;
    let bestDistance = 22;
    for (const entity of this.entities.values()) {
      if (!entity.data) continue;
      const cy = entity.data.kind === 'tsukumo' ? entity.y - 38 : entity.y - 10;
      const distance = Math.hypot(entity.x - x, cy - y);
      if (distance < bestDistance) [best, bestDistance] = [entity, distance];
    }
    const kiosk = this.places?.kiosk;
    const onKiosk = this.data?.lmstudio && kiosk && Math.abs(x - kiosk.x) < 34 && Math.abs(y - kiosk.y) < 26;
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
    if (agent.kind === 'openclaw') return [[agent.name, t('in the pond')], [STATE_TEXT[agent.state] ?? agent.state]];
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
