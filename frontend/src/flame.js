/**
 * The flame: Tsukumo.
 *
 * In tsukumogami a soul enters an object and brings it to life. Here the
 * flame is her: a drop with two eyes, all geometry, no files to download or
 * license. The stage (stage.js) frames her and tells her what happens around.
 *
 * Here is how she moves: breathing, gaze, the agent's states
 * (thinking, working with her little terminal, the page or the magnifying
 * glass), reactions to touches, dancing, sleep with the bubble, the file she
 * eats, the sprint and the flight when you throw her (the real run is done
 * by electron/pet-physics.js moving the window; here the trail and the face).
 *
 * Ideas also come from those who make similar things (VS Code's Blobby,
 * Coucou's Mochi), redone her own way: no clones, a flame stays a flame.
 */

import * as THREE from 'three';

import { FlameFx } from './flame/fx.js';
import { DEFAULT_PALETTE, flat, glowSprite, INK, makeEye, palette, paletteKey, part, PLANE, SPHERE, TEX, toon } from './flame/look.js';
import { duration, play, Spring, Squash } from './flame/motion.js';
import { MOVES } from './flame/moves.js';
import { Wardrobe } from './flame/outfits.js';
import { Accessories, WorkProps } from './flame/props.js';

export { PALETTES } from './flame/look.js';

/** The flame's height relative to the framed figure's (stage.js, FRAME_HEIGHT). */
export const FLAME_HEIGHT = 0.3;

// The drop's measures in its own units: bulb of radius R, tip up to UNIT.
const UNIT = 1.2;
const R = 0.42;
/** She floats just above the taskbar. */
const HOVER = 0.14;
/** The drop's measures, for whoever must fit her somewhere (the menu island). */
export const DROP = { UNIT, R, HOVER };

const MOTION = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0.35 : 1;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, k) => a + (b - a) * k;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const damp = (current, target, rate, dt) => current + (target - current) * (1 - Math.exp(-rate * dt));
const smooth = (k) => {
  const x = clamp(k, 0, 1);
  return x * x * (3 - 2 * x);
};
/** A real jump is a parabola, not a sinusoid: `p` 0..1 from ground to ground. */
const arc = (p) => 4 * p * (1 - p);
const TAU = Math.PI * 2;

/** The minimum length of each reaction, in seconds (those made of curves last as long as the curves). */
const REACTIONS = {
  flinch: 0.55,
  pat: 0.9,
  pout: 2.2,
  greet: 1.3,
  call: 2.4,
  dizzy: 2.2,
  look: 1.6,
  yawn: 1.6,
  land: 0.45,
  hearts: 1.9,
  cool: 2.6,
  sing: 2.6,
  speechless: 2.2,
  surprise: 1.1,
  cheer: 2.1,
  gulp: 1.7,
  bonk: 0.7,
  wake: 0.7,
  flare: 0.5,
  stretch: 1.9,
  hop: 0.9,
  spin: 1.1,
  gust: 1.4,
};

/** Gesture names the backend sends with a spontaneous comment (proactive.py), in her own way. */
const GESTURES = {
  wave: 'greet',
  greetPop: 'greet',
  knock: 'call',
  pout: 'pout',
  dizzy: 'dizzy',
  lookAround: 'look',
  yawn: 'yawn',
  pat: 'pat',
  hum: 'sing',
  stretch: 'stretch',
  spin: 'spin',
  peace: 'cool',
  model: 'cool',
  showOff: 'cheer',
  squat: 'hop',
  shiver: 'gust',
  fanSelf: 'speechless',
  shoot: 'surprise',
};

/** A poke on the body: one of these, never the same twice in a row. */
const POKES = ['flinch', 'flinch', 'hearts', 'cool', 'sing', 'speechless', 'surprise'];
/** When she's doing nothing, now and then. */
const FIDGETS = ['look', 'look', 'stretch', 'hop', 'spin', 'gust'];
const FIDGET_EVERY = [9, 22];
/** Shaken while you hold her: many fast reversals in a short time and her head spins. */
const SHAKE = { speed: 900, turns: 4, window: 1.2 };

export class Flame {
  /**
   * @param {THREE.Scene} scene
   * @param {string} [paletteName] one of PALETTES
   */
  constructor(scene, paletteName = DEFAULT_PALETTE) {
    this.scene = scene;
    this.paletteName = paletteName;
    this.colors = palette(paletteName);
    this.fx = new FlameFx(scene, this.colors);

    // root: where she is and how big; body: squashes (pivot on the taskbar);
    // pivot: gaze and tilt, pivoting in the bulb (tilted while running she
    // doesn't sink into the taskbar).
    this.root = new THREE.Group();
    this.root.visible = false;
    this.body = new THREE.Group();
    this.pivot = new THREE.Group();
    this.pivot.position.y = HOVER + R;
    this.root.add(this.body);
    this.body.add(this.pivot);
    scene.add(this.root);
    this._build();
    this.props = new WorkProps(this.root, { HOVER, R, UNIT }, this.geometry, this.colors);
    this.acc = new Accessories(this.root, this.pivot, { HOVER, R, UNIT }, this.colors);
    // The wardrobe (flame/outfits.js): when the new accessory touches her she squashes.
    this.wardrobe = new Wardrobe(this.root, this.pivot, this.uniforms);
    this.wardrobe.onArrive = (item) => this.squash.impact(item.hat ? 0.16 : 0.08);

    /** Feet (bottom of the drop at rest), in the world. */
    this.home = new THREE.Vector3();
    /** Scene metres per drop unit. */
    this.size = 0.4;
    /** Spontaneous gestures when she does nothing (they can be turned off from the panel). */
    this.spontaneous = true;

    this.t = 0;
    this.look = new THREE.Vector2();
    this.blinkAt = rand(0.5, 2.5);
    /** Now and then two blinks in a row (like Mochi, about one in five). */
    this._blinkAgain = false;
    // The springs (flame/motion.js): the landing that squashes, the eyes that
    // "pop" when the expression changes, the tip that lags behind and then
    // overshoots, the mid-air somersault that rights itself.
    this.squash = new Squash();
    this.eyeScale = new Spring(1, 0.26, 0.38);
    this.tip = new Spring(0, 0.36, 0.3);
    this._eyesMode = 'normal';
    this._base = { sx: 1, sy: 1 };
    this._lean = 0;
    this._leanPrev = 0;
    /** Somersault in flight (radians around the bulb): she rights herself coming down and landing. */
    this.roll = 0;
    this._rollSpeed = 0;
    this._rollSpring = null;
    this.swayPhase = 0;
    this.spinY = 0;
    this.mouthOpen = 0;
    this.mouthRound = 0;
    this.dotsAmount = 0;
    this.reaction = null;
    this._queued = null;
    this._lastPoke = null;
    this.run = null;
    this.held = false;
    this.falling = false;
    /** Thrown with the mouse: `{dir, speed}` until she lands. */
    this.flying = null;
    this.holdVelocity = 0;
    this._holdLast = null;
    this._turns = [];
    this._shaken = false;
    this._hover = false;
    this._menu = false;
    this._asleep = false;
    this._beat = 0;
    this._beatPhase = 0;
    this._noteAt = 0;
    this._nextFidgetAt = rand(...FIDGET_EVERY);
    this._acc = { bubble: 0, glasses: 0, bang: 0, sweat: 0, snack: 0 };
    /** In the menu island: `{dx, dy, scale}` (see setMenuPose) and how far she has gone in, 0..1. */
    this._menuPose = null;
    this._menuWanted = false;
    this._menuAmount = 0;
    this._point = new THREE.Vector3();
    /** Shadow for the stage: where and how big, in metres, and how dark. */
    this.shadow = { x: 0, z: 0, size: 0, opacity: 0 };
  }

  _build() {
    const H = UNIT - R;
    const points = [];
    for (let i = 0; i <= 16; i += 1) {
      const a = -Math.PI / 2 + (i / 16) * (Math.PI / 2);
      points.push(new THREE.Vector2(Math.max(0.0001, R * Math.cos(a)), R * Math.sin(a)));
    }
    for (let i = 1; i <= 22; i += 1) {
      const k = i / 22;
      points.push(new THREE.Vector2(Math.max(0.0001, R * Math.pow(Math.cos((k * Math.PI) / 2), 1.5)), k * H));
    }
    this.geometry = new THREE.LatheGeometry(points, 48);
    this.geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(this.geometry.attributes.position.count * 3), 3));
    this._paint();

    this.uniforms = { uTime: { value: 0 }, uSway: { value: 1 }, uLean: { value: 0 } };
    this.material = toon(0xffffff, { vertexColors: true, emissive: new THREE.Color(this.colors.emissive), emissiveIntensity: 0.22 });
    const ink = flat(INK, { side: THREE.BackSide });
    sway(this.material, this.uniforms);
    sway(ink, this.uniforms);
    const drop = new THREE.Mesh(this.geometry, this.material);
    this.pivot.add(drop);
    const outline = new THREE.Mesh(this.geometry, ink);
    outline.scale.setScalar(1.045);
    drop.add(outline);

    const onBulb = (x, y, z, lift) => new THREE.Vector3(x, y, z).normalize().multiplyScalar(R + lift);
    this.eyes = [-1, 1].map((s) => makeEye(this.pivot, onBulb(s * 0.36, 0.06, 0.93, 0.005), new THREE.Vector3(s * 0.36, 0.06, 0.93), 0.085, s === 1));
    // The blush on the cheeks (like Mochi): pats, hearts, greetings, the cursor on her.
    this.blushMaterial = new THREE.MeshBasicMaterial({ map: TEX.blush, color: 0xff5c93, transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
    this.cheeks = [-1, 1].map((s) => {
      const at = onBulb(s * 0.56, -0.16, 0.81, 0.006);
      const cheek = new THREE.Mesh(PLANE, this.blushMaterial);
      cheek.position.copy(at);
      cheek.lookAt(at.clone().multiplyScalar(2));
      cheek.scale.set(0.21, 0.12, 1);
      cheek.visible = false;
      this.pivot.add(cheek);
      return cheek;
    });
    this.blush = 0;
    // The mouth is there only when needed (speaking, laughing, getting scared, eating).
    this.mouth = part(this.pivot, SPHERE, flat(INK), { pos: onBulb(0, -0.3, 0.95, 0.004), scale: [0.05, 0.001, 0.02] });
    this.glow = glowSprite(this.colors.glow, 2.1, 0.45);
    this.glow.position.set(0, 0.2, -0.25);
    this.pivot.add(this.glow);

    // The thought dots, on the side opposite to where she looks while thinking.
    this.dots = new THREE.Group();
    this.dotsMaterial = toon(this.colors.soft);
    const top = HOVER + UNIT;
    for (const [x, y, r] of [[-0.42, top - 0.05, 0.035], [-0.58, top + 0.1, 0.05], [-0.76, top + 0.28, 0.075]]) {
      const dot = part(this.dots, SPHERE, this.dotsMaterial, { pos: new THREE.Vector3(x, y, 0.2), scale: r, outline: 0.1 });
      dot.userData.y = y;
    }
    this.root.add(this.dots);
  }

  /** The full colour at the bottom, the light one towards the tip. */
  _paint() {
    const position = this.geometry.attributes.position;
    const colors = this.geometry.attributes.color;
    const low = new THREE.Color(this.colors.low);
    const high = new THREE.Color(this.colors.high);
    const color = new THREE.Color();
    const H = UNIT - R;
    for (let i = 0; i < position.count; i += 1) {
      color.copy(low).lerp(high, clamp((position.getY(i) + 0.1) / (H + 0.1), 0, 1));
      colors.setXYZ(i, color.r, color.g, color.b);
    }
    colors.needsUpdate = true;
  }

  /** Changes colour (lilac, blue, jade, ember, sakura, moon or a free "#rrggbb"): everything, effects included. */
  setPalette(name) {
    this.paletteName = paletteKey(name) ?? DEFAULT_PALETTE;
    this.colors = palette(this.paletteName);
    this._paint();
    this.material.emissive.set(this.colors.emissive);
    this.glow.material.color.set(this.colors.glow);
    this.dotsMaterial.color.set(this.colors.soft);
    this.fx.setColors(this.colors);
    this.props.setColors(this.colors);
    this.acc.setColors(this.colors);
  }

  // --------------------------------------------------------------- measures
  /** Height in the world (metres). */
  setHeight(height) {
    this.size = height / UNIT;
  }

  /** Centre of the bulb, in the world: she's picked up from there. */
  centerWorld(target = new THREE.Vector3()) {
    return target.set(0, HOVER + R, 0).applyMatrix4(this.root.matrixWorld);
  }

  /** Centre of the bulb at rest, at home: it doesn't follow the floating or the menu. */
  restCenterWorld(target = new THREE.Vector3()) {
    return target.set(this.home.x, this.home.y + (HOVER + R) * this.size, this.home.z);
  }

  /**
   * The menu (the island) is open: `pose` says how far to move the bulb's
   * centre (metres) and how much to shrink her to fit the card. null: back home.
   */
  setMenuPose(pose) {
    this._menuWanted = Boolean(pose);
    if (pose) this._menuPose = pose;
  }

  /** Tip of the flame (or of the hat), in the world: the speech bubble and the "z"s sit above it. */
  topWorld(target = new THREE.Vector3()) {
    return target.set(0, HOVER + UNIT + this.wardrobe.top, 0).applyMatrix4(this.root.matrixWorld);
  }

  /** What she wears (flame/wardrobe.js, OUTFITS, or 'none'): the change is animated. */
  setOutfit(name) {
    this.wardrobe.set(name);
  }

  /** Half width of the bulb, in metres: the menu goes around her at this distance. */
  get halfWidth() {
    return R * this.size;
  }

  /** The bottom of the drop at rest, in metres above the feet. */
  get hoverHeight() {
    return HOVER * this.size;
  }

  /** She's doing something that wants 60 fps. */
  get busy() {
    return Boolean(
      this.run ||
        this.reaction ||
        this.held ||
        this.falling ||
        this.flying ||
        this.fx.active ||
        this.props.active ||
        this.squash.busy ||
        this.wardrobe.busy ||
        !this.eyeScale.settled ||
        !this.tip.settled ||
        this.roll !== 0 ||
        Math.abs(this._menuAmount - (this._menuWanted ? 1 : 0)) > 0.002,
    );
  }

  // ----------------------------------------------------------------- events
  /** A reaction, or a gesture name from the backend (GESTURES); false if she can't do it now. */
  react(name, detail = 0) {
    const key = REACTIONS[name] ? name : GESTURES[name];
    if (!key || this.run) return false;
    const tracks = MOVES[key]?.(detail) ?? null;
    const length = Math.max(REACTIONS[key], tracks ? duration(tracks) : 0);
    this.reaction = { name: key, t: 0, detail, spawned: 0, tracks, length };
    return true;
  }

  /**
   * Click: on the tip it's a pat, lower down a poke that has a different
   * effect every time (she squashes, little hearts, sunglasses, sings...).
   */
  poke(zone) {
    let reaction = 'pat';
    if (zone !== 'head') {
      const choices = POKES.filter((name) => name !== this._lastPoke);
      reaction = pick(choices);
      this._lastPoke = reaction;
    }
    return this.react(reaction) ? reaction : null;
  }

  setHeld(value) {
    const held = Boolean(value);
    // Let go after a good shake: as soon as she lands her head spins.
    if (this.held && !held && this._shaken) this._queued = 'dizzy';
    this.held = held;
    this.holdVelocity = 0;
    this._holdLast = null;
    this._turns = [];
    this._turnSign = 0;
    this._shaken = false;
  }

  /** Where the dragged window is (screen pixels): the speed makes her sway. */
  moveHold(screenX) {
    const now = performance.now();
    if (this._holdLast) {
      const dt = Math.max(1, now - this._holdLast.at) / 1000;
      this.holdVelocity = damp(this.holdVelocity, (screenX - this._holdLast.x) / dt, 12, dt);
      // Count the fast reversals: back and forth, back and forth...
      if (Math.abs(this.holdVelocity) > SHAKE.speed) {
        const sign = Math.sign(this.holdVelocity);
        if (this._turnSign && sign !== this._turnSign) {
          this._turns.push(now);
          while (this._turns.length && now - this._turns[0] > SHAKE.window * 1000) this._turns.shift();
          if (this._turns.length >= SHAKE.turns) this._shaken = true;
        }
        this._turnSign = sign;
      }
    }
    this._holdLast = { x: screenX, at: now };
  }

  fall() {
    this.falling = true;
  }

  /** Thrown: she flies in the throw's direction, with the trail, until she lands. */
  fly(vx) {
    this.falling = true;
    this.flying = { dir: Math.sign(vx) || 1, speed: clamp(Math.abs(vx) / 2400, 0.25, 1), lineAt: 0 };
    this._rollSpring = null;
  }

  /**
   * The window in flight moved by `dx`, `dy` pixels in `dt` seconds. She
   * somersaults in proportion to the distance (like Blobby, 0.65 degrees per
   * pixel) and, when she starts coming down, rights herself.
   */
  flyStep(dx, dy, dt) {
    if (!this.flying || dt <= 0) return;
    const vy = dy / dt;
    const before = this.roll;
    const righting = clamp((vy + 450) / 450, 0, 1);
    this.roll -= dx * 0.0113 * (1 - righting) * MOTION;
    const upright = this._upright(dx < 0 ? 1 : -1);
    const fix = 12.5 * righting * dt;
    const gap = upright - this.roll;
    this.roll = Math.abs(gap) <= fix ? upright : this.roll + Math.sign(gap) * fix;
    // How fast she spins: while she rotates the comet tail doesn't show.
    this._rollSpeed = damp(this._rollSpeed, Math.abs(this.roll - before) / dt, 10, dt);
  }

  /** The nearest "upright" in the direction she's turning (+1 anticlockwise). */
  _upright(dir) {
    const turns = this.roll / TAU;
    return (dir > 0 ? Math.ceil(turns - 0.02) : Math.floor(turns + 0.02)) * TAU;
  }

  /** You pressed a key writing to her: a tiny nod, "mh-mh". */
  keystroke() {
    if (!this.reaction && !this.run && !this.held && !this.falling) this.squash.impact(0.025);
  }

  /** She bumped into the screen edge (`side` +1 right, -1 left, 0 top). */
  bonk(side, impact = 0.5) {
    if (this.flying && side) this.flying.dir = -side;
    this.react('bonk', side);
    const center = this.centerWorld(this._point);
    const s = this.size;
    for (let i = 0; i < 2 + Math.round(impact * 2); i += 1) {
      this.fx.sprite(TEX.star, center.clone().add(new THREE.Vector3(side * R * s, rand(0.1, 0.5) * s, 0.2 * s)), {
        size: 0.22 * s,
        velocity: new THREE.Vector3(-side * rand(0.2, 0.6) * s, rand(0.4, 1.0) * s, 0),
        gravity: 1.8 * s,
        spin: rand(-6, 6),
        life: 0.7,
      });
    }
  }

  land(impact = 0) {
    this.falling = false;
    this.flying = null;
    this.reaction = null;
    this.react('land', impact);
    // Squashed in proportion to the hit (Blobby does the "splat"), then the spring.
    this.squash.impact(0.1 + 0.26 * clamp(impact, 0, 1));
    // Landed crooked: she straightens up with a wobble.
    if (this.roll !== 0) {
      this._rollSpring = new Spring(this.roll, 0.42, 0.42);
      this._rollSpring.target = Math.round(this.roll / TAU) * TAU;
    }
    if (impact > 0.15) this.fx.ring(this._floor(), { lying: true, to: 0.9 * this.size, life: 0.6 });
  }

  /** Sprint phase from the physics: ready, go, brake, proud, end. */
  sprint(phase, dir = 1) {
    if (phase === 'end') {
      this.run = null;
      return;
    }
    this.reaction = null;
    this.run = { phase, dir: dir || this.run?.dir || 1, t: 0, speed: this.run?.speed ?? 0, lineAt: 0 };
    if (phase === 'brake') this.fx.ring(this._floor(), { lying: true, to: 0.7 * this.size, life: 0.6 });
  }

  sprintSpeed(speed) {
    if (this.run) this.run.speed = speed;
  }

  /** The window moved by `dx`, `dy` metres: trail and figures stay behind on the desktop. */
  drift(dx, dy = 0) {
    this.fx.drift(dx, dy);
  }

  _floor() {
    return new THREE.Vector3(this.root.position.x, this.home.y + 0.003, this.home.z);
  }

  /** A little figure flying off the tip (hearts, notes, stars), in drop units. */
  _toss(texture, { x = 0, y = 0, vx = 0, vy = 0.5, size = 0.22, life = 1.3, sway = 0, spin = 0, gravity = 0, color = 0xffffff } = {}) {
    const s = this.size;
    const at = this.topWorld(this._point).add(new THREE.Vector3(x * s, y * s, 0.15 * s));
    this.fx.sprite(texture, at, {
      size: size * s,
      velocity: new THREE.Vector3(vx * s, vy * s, 0),
      gravity: gravity * s,
      sway: sway * s,
      spin,
      life,
      color,
    });
  }

  /** After `k` (0..1) of the reaction it throws `count` of them spread over time. */
  _tossOver(reaction, k, count, spawn) {
    const due = Math.min(count, Math.floor(k * (count + 0.3)) + 1);
    while (reaction.spawned < due) {
      spawn(reaction.spawned);
      reaction.spawned += 1;
    }
  }

  // ------------------------------------------------------------ every frame
  /**
   * @param {number} dt
   * @param {object} input `{speaking, level, thinking, working, listening, sleep, look: {x, y}, music, hover, menu, hungry}`
   */
  update(dt, input) {
    this.t += dt;
    const t = this.t;
    const run = this.run;
    if (run) run.t += dt;
    if (this.reaction) {
      this.reaction.t += dt;
      if (this.reaction.t >= this.reaction.length) {
        this.reaction = null;
        if (this._queued && !this.held && !this.falling) {
          this.react(this._queued);
          this._queued = null;
        }
      }
    }
    const reaction = this.reaction;
    const colors = this.colors;

    let mood = 'idle';
    const sleep = input.sleep ?? 0;
    if (this.held) mood = 'held';
    else if (this.falling) mood = 'fall';
    else if (input.hungry) mood = 'hungry';
    else if (input.speaking) mood = 'speak';
    else if (input.listening) mood = 'listen';
    else if (input.working) mood = 'work';
    else if (input.thinking) mood = 'think';
    else if (sleep > 0.9) mood = 'asleep';
    else if (sleep > 0.4) mood = 'drowsy';

    // She wakes up: the bubble pops and she jolts.
    if (this._asleep && mood !== 'asleep') {
      if (this._acc.bubble > 0.3) {
        const at = this.acc.bubbleWorld(this._point);
        this.fx.flash(at, 0.5 * this.size);
        this.fx.ring(at, { to: 0.3 * this.size, life: 0.35 });
      }
      this._acc.bubble = 0;
      if (!reaction && !run) this.react('wake');
    }
    this._asleep = mood === 'asleep';

    // The cursor on her: she blinks and opens her eyes wide (like Mochi).
    const hover = Boolean(input.hover) && (mood === 'idle' || mood === 'drowsy' || mood === 'think');
    if (hover && !this._hover) this.blinkAt = t;
    this._hover = hover;
    // The menu opens: a flare, as if saying "here I am".
    if (input.menu && !this._menu) this.react('flare');
    this._menu = Boolean(input.menu);

    let sx = 1;
    let sy = 1 + Math.sin(t * 2.3) * 0.02 * MOTION;
    let lean = 0;
    let bend = 0;
    let jump = 0;
    let shake = 0;
    let bob = 1;
    let glow = 0.45 + Math.sin(t * 7.3) * 0.03;
    let flicker = 1;
    let swayAmount = 1;
    let eyes = 'normal';
    let wide = false;
    let open = 1;
    let mouth = 0;
    let round = 0;
    let lookX = input.look?.x ?? 0;
    let lookY = input.look?.y ?? 0;
    let lookRate = 7;
    let tilt = Math.sin(t * 0.7) * 0.03;
    let forward = 0;
    let dots = false;
    let spin = 0;
    const acc = { bubble: 0, glasses: 0, bang: 0, sweat: 0, snack: 0 };

    // The work tools: she takes them out only while the agent uses a tool.
    // In the island the card says the steps: no tools over the text.
    const work = this.props.update(dt, mood === 'work' && !run && !this._menuWanted ? input.working : null);

    // What she's doing (or what the agent is doing for her).
    if (mood === 'speak') {
      // The volume opens the mouth, the vowel shapes it: round on "o" and "u".
      const vowels = input.vowels ?? {};
      mouth = clamp(Math.max((input.level ?? 0) * 2.4, (vowels.a ?? 0) * 0.8), 0, 1);
      round = clamp((vowels.o ?? 0) + (vowels.u ?? 0) - 0.4 * ((vowels.i ?? 0) + (vowels.e ?? 0)), 0, 1);
      sy += mouth * 0.05;
      glow = 0.4 + mouth * 0.7;
      flicker = 1.3;
      tilt = Math.sin(t * 2.1) * 0.06;
      lookX *= 0.35;
      lookY = lookY * 0.35 + 0.05;
    } else if (mood === 'listen') {
      sy += 0.03;
      glow = 0.6;
      flicker = 0.6;
      swayAmount = 0.4;
      wide = true;
      tilt = 0.2;
      forward = 0.08;
      lookX *= 0.35;
      lookY = lookY * 0.35 + 0.05;
    } else if (mood === 'hungry') {
      // A file over her: mouth wide open, "aaah", towards the cursor.
      mouth = 1;
      round = 1;
      wide = true;
      glow = 0.75;
      flicker = 2.2;
      forward = 0.1;
      sy += 0.04 + Math.sin(t * 9) * 0.02;
      lookRate = 12;
    } else if (mood === 'think') {
      glow = 0.35 + 0.35 * (0.5 + 0.5 * Math.sin(t * 2.6));
      flicker = 2.2;
      lookX = -0.5;
      lookY = 0.55;
      tilt = -0.14 + Math.sin(t * 1.3) * 0.05;
      dots = true;
    } else if (mood === 'work') {
      glow = 0.62 + Math.sin(t * 17) * 0.04;
      flicker = 2.6;
      if (work.look) {
        lookX = work.look.x;
        lookY = work.look.y;
        lookRate = 5;
      } else {
        lookX = Math.sin(t * 0.8) * 0.15;
        lookY = -0.6;
        dots = true;
      }
      // She types on the little terminal.
      jump = Math.abs(Math.sin(t * 14)) * (0.015 + 0.02 * work.typing);
      tilt = work.typing ? -0.08 + Math.sin(t * 7) * 0.03 : tilt;
    } else if (mood === 'asleep') {
      eyes = 'closed';
      glow = 0.2;
      flicker = 0.35;
      swayAmount = 0.5;
      bob = 0.4;
      sy = 1 + Math.sin(t * 1.2) * 0.035 * MOTION;
      lookX = 0;
      lookY = -0.2;
      tilt = 0.12;
      acc.bubble = 1;
    } else if (mood === 'drowsy') {
      open = 0.45;
      glow = 0.32;
      flicker = 0.6;
      lookY -= 0.2;
    } else if (mood === 'held') {
      sy = 1.12;
      sx = 0.9;
      lean = clamp(this.holdVelocity / 2500, -0.35, 0.35);
      bend = clamp(this.holdVelocity / 1800, -1, 1);
      wide = true;
      mouth = 0.25;
      glow = 0.6;
      flicker = 2;
      if (this._shaken) eyes = 'spiral';
    } else if (mood === 'fall') {
      sy = 1.25;
      sx = 0.85;
      wide = true;
      mouth = 0.5;
      round = 0.6;
      flicker = 3;
      const fly = this.flying;
      if (fly) {
        // In flight: the tip lags behind as in the wind, the trail on the desktop.
        // While she somersaults no stretching (rotated it would skew her) and the
        // tip goes back relative to the flight, not to her.
        const upright = Math.cos(this.roll) ** 2;
        const still = 1 - clamp(this._rollSpeed / 5, 0, 1);
        sx = 1 + 0.25 * fly.speed * upright;
        sy = 1 - 0.1 * fly.speed * upright;
        lean = fly.dir * 0.22 * fly.speed * upright;
        bend = fly.dir * 0.8 * fly.speed * Math.cos(this.roll) * still;
        lookX = fly.dir;
        lookY = 0;
        lookRate = 16;
        glow = 0.9;
        this._spawnTrail(fly, dt);
      }
    } else if (input.music?.active) {
      // With Spotify she dances in time: a bounce on the beat, one side then the other.
      const phase = input.music.phase ?? 0;
      if (phase < this._beatPhase - 0.5) {
        this._beat += 1;
        if (this._beat % 4 === 0 && t - this._noteAt > 1.2) {
          this._noteAt = t;
          this._toss(TEX.note, { x: rand(-0.3, 0.3), vx: rand(-0.25, 0.25), vy: 0.5, sway: 0.4, color: colors.soft });
        }
      }
      this._beatPhase = phase;
      // How Mochi dances: a hop per beat, squashed only when she touches the
      // ground, and the sway changing side at every beat.
      const energy = Math.min(1, (input.music.energy ?? 0) * 4);
      const up = Math.sin(Math.PI * phase);
      const contact = (1 - up) ** 6;
      const side = Math.sin(Math.PI * (this._beat + phase));
      jump += up * 0.08 * energy;
      sy -= contact * 0.07 * energy;
      sx += contact * 0.05 * energy;
      tilt = side * 0.13 * energy;
      bend += side * 0.25 * energy;
      lookX = side * 0.3;
      glow += contact * 0.25 * energy;
      if (energy > 0.3) eyes = 'happy';
    }

    // You're typing in the chat (like Blobby with its little terminal): she leans in, attentive.
    if (input.typing && (mood === 'idle' || mood === 'drowsy')) {
      wide = true;
      forward = 0.07;
      sy += 0.02;
      glow += 0.1;
      tilt = -0.06;
    }

    // The cursor on her: big eyes, she perks up, she lights up a little.
    if (hover) {
      wide = true;
      sy += 0.03;
      glow += 0.12;
      lookRate = 11;
    }
    if (this._menu && (mood === 'idle' || mood === 'drowsy')) glow += 0.15;

    // Reactions to touches and gestures: over the state, for a moment. The
    // curves (MOVES) give the movement, the switch the faces and the figures.
    let sq = 1;
    let eyeScale = 1;
    let blushing = hover ? 0.3 : 0;
    if (reaction && !run) {
      const k = reaction.t / reaction.length;
      const s = reaction.t;
      if (reaction.tracks) {
        const m = play(reaction.tracks, s);
        if (m.y !== undefined) jump += m.y;
        if (m.sq !== undefined) sq *= m.sq;
        if (m.spin !== undefined) spin = m.spin;
        if (m.tilt !== undefined) tilt += m.tilt;
        if (m.bend !== undefined) bend += m.bend;
        if (m.glow !== undefined) glow += m.glow;
        if (m.es !== undefined) eyeScale *= m.es;
        if (m.mouth !== undefined) mouth = Math.max(mouth, m.mouth);
        if (m.gx !== undefined) lookX = m.gx;
        if (m.gy !== undefined) lookY = m.gy;
        if (m.blush !== undefined) blushing = Math.max(blushing, m.blush);
        for (const name of ['glasses', 'sweat', 'bang']) if (m[name] !== undefined) acc[name] = m[name];
      }
      switch (reaction.name) {
        case 'flinch':
          if (s < 0.35) eyes = 'squint';
          mouth = Math.max(mouth, 0.2);
          break;
        case 'pat':
          eyes = 'happy';
          mouth = Math.max(mouth, 0.3);
          break;
        case 'pout':
          eyes = 'squint';
          lookX = (this.look.x >= 0 ? -1 : 1) * 0.9;
          lookY = 0.1;
          glow = 0.3;
          break;
        case 'greet':
          eyes = 'happy';
          mouth = Math.max(mouth, 0.5);
          break;
        case 'call': {
          // Waiting for you: she hops (real jumps, parabolic), blinks, "!" above the tip.
          const p = (t * 1.6) % 1;
          jump = arc(p) * 0.1;
          glow = p < 0.5 ? 1 : 0.35;
          wide = true;
          mouth = Math.max(mouth, 0.3);
          lookX = 0;
          lookY = 0.05;
          acc.bang = k < 0.9 ? 1 : (1 - k) / 0.1;
          break;
        }
        case 'dizzy':
          tilt = Math.sin(t * 9) * 0.35;
          lookX = Math.sin(t * 6) * 0.8;
          lookY = Math.cos(t * 6) * 0.5;
          eyes = 'spiral';
          mouth = Math.max(mouth, 0.15);
          break;
        case 'yawn':
          round = 0.5;
          if (s > 0.3 && s < 1.3) eyes = 'closed';
          break;
        case 'land':
          if (reaction.detail > 0.3 && s < 0.25) eyes = 'squint';
          break;
        case 'hearts':
          // Heart eyes (after the wind-up) and little hearts rising.
          if (s > 0.12) eyes = 'heart';
          mouth = Math.max(mouth, s > 0.12 ? 0.35 : 0);
          if (s > 0.25) {
            this._tossOver(reaction, (s - 0.25) / (reaction.length - 0.4), 3, (i) =>
              this._toss(TEX.heart, { x: (i % 2 ? 1 : -1) * rand(0.15, 0.4), vx: (i % 2 ? 1 : -1) * 0.15, vy: 0.55, sway: 0.5, size: 0.24 }),
            );
          }
          break;
        case 'cool':
          // First she looks up (here they come), then "ting!" on the lens as soon as they settle.
          lookX = 0.15;
          if (s > 0.9 && !reaction.spawned) {
            reaction.spawned = 1;
            this._toss(TEX.star, { x: 0.27, y: -0.68, vx: 0, vy: 0, size: 0.2, life: 0.5, spin: 4 });
          }
          break;
        case 'sing': {
          // Sings in time: a little hop per beat, the head swaying, the notes.
          const p = (s * 2.3) % 1;
          eyes = 'happy';
          mouth = 0.3 + 0.4 * arc(p);
          round = 0.4;
          tilt = Math.sin(s * Math.PI * 2.3 * 0.5) * 0.16;
          jump = arc(p) * 0.035;
          this._tossOver(reaction, k, 4, (i) =>
            this._toss(TEX.note, { x: 0.15 + i * 0.06, y: -0.35, vx: 0.3, vy: 0.45, sway: 0.5, color: colors.soft, size: 0.22 }),
          );
          break;
        }
        case 'speechless':
          // "...": first she stares, then dash eyes all at once, sweat.
          eyes = s < 0.35 ? 'normal' : 'flat';
          mouth = s < 0.35 ? 0 : 0.09;
          flicker = 0.5;
          swayAmount = 0.4;
          lookX = 0;
          lookY = 0;
          break;
        case 'surprise':
          wide = true;
          open = 1.15;
          mouth = 0.6;
          round = 1;
          flicker = 3;
          lookX = 0;
          lookY = 0.1;
          break;
        case 'cheer':
          // Stars at the top of the jump, a ring when she lands.
          eyes = s < 0.14 ? 'squint' : 'happy';
          mouth = Math.max(mouth, s < 0.14 ? 0.2 : 0.6);
          flicker = 2.5;
          if (s > 0.45 && reaction.spawned === 0) {
            reaction.spawned = 1;
            for (let i = 0; i < 7; i += 1) {
              const a = (i / 7) * TAU + rand(-0.2, 0.2);
              this._toss(TEX.star, { y: -0.4, vx: Math.cos(a) * 0.8, vy: Math.sin(a) * 0.8 + 0.3, gravity: 1.2, spin: rand(-5, 5), life: 0.9, size: 0.2 });
            }
          }
          if (s > 0.76 && reaction.spawned === 1) {
            reaction.spawned = 2;
            this.fx.ring(this._floor(), { lying: true, to: 0.8 * this.size, life: 0.6 });
          }
          break;
        case 'gulp': {
          // You give her a file: she watches it arrive with her mouth open, gulp, chews, happy.
          if (k < 0.3) {
            acc.snack = k / 0.3;
            mouth = 1;
            round = 1;
            wide = true;
            forward = 0.1;
            lookX = 0.5 * (1 - k / 0.3);
            lookY = 0.5 * (1 - k / 0.3);
          } else if (k < 0.38) {
            // Gulp: she swallows it all at once, the spring does the rest.
            if (!reaction.gulped) {
              reaction.gulped = true;
              this.squash.impact(0.2);
            }
            eyes = 'squint';
          } else if (k < 0.74) {
            // Chews: at every bite she squashes and comes back up.
            sq *= 1 - 0.06 * arc((s * 3.2) % 1);
            eyes = 'happy';
          } else {
            const w = Math.sin(((k - 0.74) / 0.26) * Math.PI);
            sy += 0.06 * w;
            glow += 0.5 * w;
            eyes = 'happy';
            mouth = Math.max(mouth, 0.3 * w);
            this._tossOver(reaction, (k - 0.74) / 0.26, 2, () =>
              this._toss(TEX.star, { x: rand(-0.4, 0.4), y: -0.5, vx: 0, vy: 0.3, size: 0.16, life: 0.6, spin: 3 }),
            );
          }
          break;
        }
        case 'bonk':
          // Against the screen edge: squashed sideways (the curves), she shakes for a moment.
          shake = s < 0.2 ? reaction.detail * 0.1 * Math.sin(s * 90) * (1 - s / 0.2) : 0;
          eyes = s < 0.4 ? 'squint' : 'normal';
          mouth = Math.max(mouth, s < 0.4 ? 0.35 : 0);
          round = 0.5;
          break;
        case 'wake':
          wide = true;
          mouth = Math.max(mouth, 0.3);
          round = 0.6;
          break;
        case 'flare':
          flicker = 3;
          break;
        case 'stretch':
          // Eyes closed while she's up, happy when she lets go.
          eyes = s > 0.45 && s < 1.15 ? 'closed' : s >= 1.15 ? 'happy' : 'normal';
          round = 0.6;
          break;
        case 'hop':
          if (jump > 0.05) eyes = 'happy';
          break;
        case 'spin':
          if (s > 0.2 && s < 0.85) eyes = 'happy';
          break;
        case 'gust':
          // A gust of air: the flame bends and flickers.
          bend = Math.sin(t * 11) * 0.7 * (1 - k);
          tilt = Math.sin(t * 7) * 0.08 * (1 - k);
          flicker = 3.2;
          shake = Math.sin(t * 40) * 0.01 * (1 - k);
          if (k < 0.4) eyes = 'squint';
          break;
        default:
          break;
      }
    }

    // The sprint rules over everything.
    if (run) {
      lookX = run.dir;
      lookY = 0;
      lookRate = 16;
      if (run.phase === 'ready') {
        const k = clamp(run.t / 0.38, 0, 1);
        sy = 1 - 0.2 * k;
        sx = 1 + 0.12 * k;
        lean = run.dir * 0.15 * k;
        bend = run.dir * 0.25 * k;
        shake = Math.sin(t * 70) * 0.025 * k;
        glow = 0.5 + 0.4 * k;
        flicker = 2.5;
        eyes = 'squint';
      } else if (run.phase === 'go') {
        const sp = run.speed;
        sx = 1 + 0.4 * sp;
        sy = 1 - 0.2 * sp;
        lean = run.dir * 0.22 * sp;
        bend = run.dir * 0.9 * sp;
        glow = 1;
        flicker = 3;
        eyes = 'squint';
        bob = 0.3;
        this._spawnTrail(run, dt);
      } else if (run.phase === 'brake') {
        const w = Math.sin(clamp(run.t / 0.5, 0, 1) * Math.PI);
        sx = 1 - 0.18 * w;
        sy = 1 + 0.2 * w;
        lean = -run.dir * 0.2 * w;
        bend = -run.dir * 0.6 * w;
        wide = true;
        glow = 0.8;
        flicker = 1.5;
      } else if (run.phase === 'proud') {
        jump = arc((run.t * 2.9) % 1) * 0.1 * Math.max(0, 1 - run.t * 1.5);
        eyes = 'happy';
        mouth = 0.5;
        glow = 0.7;
      }
    }

    // When she's doing nothing, now and then she moves by herself: stretches, hops, turns.
    if (this.spontaneous && mood === 'idle' && !reaction && !run && !hover && !this._menu && !input.music?.active) {
      if (t >= this._nextFidgetAt) {
        this.react(pick(FIDGETS));
        this._nextFidgetAt = t + rand(...FIDGET_EVERY);
      }
    } else {
      this._nextFidgetAt = Math.max(this._nextFidgetAt, t + 6);
    }

    // --- apply
    this.look.x = damp(this.look.x, clamp(lookX, -1, 1), lookRate, dt);
    this.look.y = damp(this.look.y, clamp(lookY, -1, 1), lookRate, dt);
    // The twirl only goes forward: when done, it starts from zero without going back.
    this.spinY = spin;
    this.pivot.rotation.y = this.look.x * 0.45 + this.spinY;
    this.pivot.rotation.x = -this.look.y * 0.28 + forward;

    // The throw's somersault: in flight flyStep does it, then a spring rights her.
    if (!this.flying && this.roll !== 0 && !this._rollSpring) {
      this._rollSpring = new Spring(this.roll, 0.42, 0.42);
      this._rollSpring.target = Math.round(this.roll / TAU) * TAU;
    }
    if (this._rollSpring) {
      this.roll = this._rollSpring.step(dt);
      if (this._rollSpring.settled) {
        this.roll = 0;
        this._rollSpring = null;
      }
    }
    // Upside down the tip would end up below the window's edge: she rises.
    // It's not a jump: the contact spring only looks at `hopY`.
    const hopY = jump;
    jump += Math.abs(Math.sin(this.roll / 2)) * 0.3;

    // Tilt: the bent head, the mid-air sway and, while running, the push.
    const leanTarget = tilt + lean + Math.sin(t * 1.1) * 0.05 * MOTION;
    this._leanPrev = this._lean;
    this._lean = damp(this._lean, leanTarget, run || this.held || this.flying ? 22 : 6, dt);
    this.pivot.rotation.z = this._lean + this.roll;

    // The body: the mood's base arrives softly (no jumps from one state to
    // another), on top the gesture's curves and the contact spring. The volume
    // stays the same: if she squashes in height she widens.
    this._base.sx = damp(this._base.sx, sx, 18, dt);
    this._base.sy = damp(this._base.sy, sy, 18, dt);
    const vertical = sq * this.squash.update(dt, hopY);
    this.body.scale.set(this._base.sx / Math.sqrt(vertical), this._base.sy * vertical, 1);

    // The tip lags behind when she bends suddenly and then overshoots a little
    // (the spring): it's the flame's tail, not a rigid piece.
    const leanSpeed = dt > 0 ? (this._lean - this._leanPrev) / dt : 0;
    this.tip.target = clamp(bend - leanSpeed * 0.12, -1.4, 1.4);
    this.uniforms.uLean.value = this.tip.step(dt);
    this.swayPhase += dt * flicker;
    this.uniforms.uTime.value = this.swayPhase;
    this.uniforms.uSway.value = damp(this.uniforms.uSway.value, swayAmount * MOTION + mouth * 0.6, 8, dt);
    this.glow.material.opacity = damp(this.glow.material.opacity, clamp(glow * 0.75, 0, 1), 18, dt);

    // Position: at home, floating.
    const scale = this.size;
    const float = (Math.sin(t * 1.6) * 0.04 * bob * MOTION + jump) * this.size;
    this.root.position.set(this.home.x + shake * this.size, this.home.y + float, this.home.z);
    this.root.scale.setScalar(Math.max(0.0001, scale));

    // In the menu island: she slides into the slot left of the card, smaller.
    this._menuAmount = damp(this._menuAmount, this._menuWanted ? 1 : 0, this._menuWanted ? 9 : 12, dt);
    const inMenu = this._menuPose ? this._menuAmount : 0;
    if (inMenu > 0.0005) {
      const { dx, dy, scale: fit } = this._menuPose;
      const s = lerp(1, fit, inMenu);
      // The scale's pivot is the bulb's centre, not the feet.
      this.root.position.x += dx * inMenu;
      this.root.position.y += dy * inMenu + (HOVER + R) * scale * (1 - s);
      this.root.scale.multiplyScalar(s);
    } else if (!this._menuWanted) {
      this._menuPose = null;
    }

    // Eyes. The blink closes fast (70 ms) and reopens more slowly (130 ms);
    // about once in five she does two in a row.
    if (t > this.blinkAt + 0.2) {
      this._blinkAgain = !this._blinkAgain && Math.random() < 0.22;
      this.blinkAt = t + (this._blinkAgain ? 0.08 : rand(2, 5));
    }
    let blink = 0;
    if (!run && eyes === 'normal' && t >= this.blinkAt) {
      const b = t - this.blinkAt;
      blink = b < 0.07 ? smooth(b / 0.07) : (1 - clamp((b - 0.07) / 0.13, 0, 1)) ** 3;
    }
    // The expression changes: the new eyes "pop" (small, then beyond, then right).
    if (eyes !== this._eyesMode) {
      this.eyeScale.value = Math.min(this.eyeScale.value, eyes === 'normal' ? 0.75 : 0.5);
      this._eyesMode = eyes;
    }
    this.eyeScale.target = wide ? 1.12 : 1;
    const eyeSize = this.eyeScale.step(dt) * eyeScale;
    for (const eye of this.eyes) eye.update(this.look.x, this.look.y, blink, eyes, eyeSize, open, t);
    this.blush = damp(this.blush, blushing, blushing > this.blush ? 10 : 5, dt);
    this.blushMaterial.opacity = 0.8 * this.blush;
    for (const cheek of this.cheeks) cheek.visible = this.blush > 0.01 && eyes !== 'closed';
    this.mouthOpen = damp(this.mouthOpen, mouth, 20, dt);
    this.mouthRound = damp(this.mouthRound, round, 14, dt);
    this.mouth.visible = this.mouthOpen > 0.03;
    this.mouth.scale.set(
      0.05 * (1 + this.mouthOpen * 0.4) * (1 - this.mouthRound * 0.2),
      Math.max(0.001, this.mouthOpen * 0.045 * (1 + this.mouthRound)),
      0.02,
    );

    this.dotsAmount = damp(this.dotsAmount, dots && !run && !this._menuWanted ? 1 : 0, 10, dt);
    this.dots.visible = this.dotsAmount > 0.01;
    this.dots.scale.setScalar(Math.max(0.001, this.dotsAmount));
    const dotSpeed = mood === 'work' ? 6 : 3;
    this.dots.children.forEach((dot, i) => {
      dot.position.y = dot.userData.y + Math.sin(t * dotSpeed - i * 0.8) * 0.03;
    });

    // Accessories come and go calmly; the sheet's flight doesn't.
    for (const key of ['bubble', 'glasses', 'bang', 'sweat']) {
      const rate = key === 'glasses' ? 40 : acc[key] > this._acc[key] ? 6 : 10;
      this._acc[key] = damp(this._acc[key], acc[key], rate, dt);
    }
    this._acc.snack = acc.snack;
    this.acc.update(dt, this._acc);
    // The "!" sits above the hat, if she has one.
    this.acc.bang.position.y = HOVER + UNIT + 0.24 + this.wardrobe.top;
    this.wardrobe.update(dt, { yaw: this.pivot.rotation.y, lean: this._lean, y: hopY, glasses: this._acc.glasses });

    // The shadow: it shrinks when she jumps, fades while she falls or sits in the island.
    const lift = float / Math.max(1e-6, this.size);
    this.shadow.x = this.root.position.x;
    this.shadow.z = this.home.z;
    this.shadow.size = 0.9 * this.size * (1 - lift * 0.6) * (1 + (sx - 1) * 0.8);
    this.shadow.opacity = this.root.visible ? 0.9 * (this.falling ? 0.25 : 1) * (1 - inMenu) : 0;

    this.fx.update(dt);
  }

  /** The trail behind her, running (`run`) or flying (`flying`): `{dir, lineAt}`. */
  _spawnTrail(motion, dt) {
    const center = this.centerWorld(this._point);
    this.fx.trail(center, 0.95 * this.size);
    motion.lineAt -= dt;
    if (motion.lineAt > 0) return;
    motion.lineAt = 0.035;
    const s = this.size;
    this.fx.line(
      new THREE.Vector3(center.x - motion.dir * rand(0.7, 1.5) * s, center.y + rand(-0.45, 0.45) * s, center.z - 0.1 * s),
      rand(0.7, 1.5) * s,
      0.022 * s,
    );
  }
}

/** The tip sways and while running lags behind (uLean); the outline does the same. */
function sway(material, uniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = `uniform float uTime;\nuniform float uSway;\nuniform float uLean;\n${shader.vertexShader}`.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      float h = smoothstep(0.0, ${(UNIT - R).toFixed(2)}, position.y);
      transformed.x += sin(uTime * 3.2 + position.y * 3.0) * 0.1 * uSway * h - uLean * h * h * 0.55;
      transformed.z += cos(uTime * 2.6 + position.y * 2.0) * 0.04 * uSway * h;`,
    );
  };
}
