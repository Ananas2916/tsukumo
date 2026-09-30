/**
 * La fiammella: la forma piccola di Tsukumo.
 *
 * Nei tsukumogami un'anima entra in un oggetto e lo fa vivere. Qui la
 * fiammella e' l'anima e il VRM il corpo che indossa: cambiare forma vuol dire
 * entrare nel corpo o uscirne (la coreografia la dirige VrmStage). Una goccia
 * lilla con due occhi, tutta geometria: niente file da scaricare o licenziare.
 *
 * Vive nella stessa scena del VRM, dove starebbero i suoi piedi: finestra,
 * fisica (cadute, bordi, barra) e click-through per pixel restano quelli di
 * sempre. Qui c'e' solo come si muove: respiro, sguardo, stati dell'agente,
 * reazioni ai tocchi e lo sprint lungo la barra (la corsa vera la fa
 * electron/pet-physics.js spostando la finestra; qui la scia e la faccia).
 */

import * as THREE from 'three';

/** Altezza della fiammella rispetto a quella del modello VRM. */
export const FLAME_HEIGHT = 0.3;

// Misure della goccia nelle sue unita': bulbo di raggio R, punta fino a UNIT.
const UNIT = 1.2;
const R = 0.42;
/** Fluttua appena sopra la barra. */
const HOVER = 0.14;
const INK = 0x1d1529;
const LILAC = 0xa58bff;
const Z = new THREE.Vector3(0, 0, 1);

const MOTION = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0.35 : 1;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, k) => a + (b - a) * k;
const rand = (a, b) => a + Math.random() * (b - a);
const damp = (current, target, rate, dt) => current + (target - current) * (1 - Math.exp(-rate * dt));
const easeOutCubic = (k) => 1 - Math.pow(1 - clamp(k, 0, 1), 3);

/** Quanto dura ogni reazione, in secondi. */
const REACTIONS = { flinch: 0.55, pat: 0.9, pout: 2.2, greet: 1.3, call: 2.4, dizzy: 2.2, look: 1.6, yawn: 1.6, land: 0.45 };
/** Nomi dei gesti del VRM (body.js) che la fiammella sa rendere a modo suo. */
const GESTURES = { wave: 'greet', greetPop: 'greet', knock: 'call', pout: 'pout', dizzy: 'dizzy', lookAround: 'look', yawn: 'yawn', pat: 'pat' };

// ------------------------------------------------------------------ materiali
const gradient = new THREE.DataTexture(new Uint8Array([120, 200, 255]), 3, 1, THREE.RedFormat);
gradient.minFilter = gradient.magFilter = THREE.NearestFilter;
gradient.generateMipmaps = false;
gradient.needsUpdate = true;
const toon = (color, extra = {}) => new THREE.MeshToonMaterial({ color, gradientMap: gradient, toneMapped: false, ...extra });
const flat = (color, extra = {}) => new THREE.MeshBasicMaterial({ color, toneMapped: false, ...extra });
const SPHERE = new THREE.SphereGeometry(1, 32, 24);
const PLANE = new THREE.PlaneGeometry(1, 1);
const RING = new THREE.RingGeometry(0.92, 1, 72);

function canvasTexture(draw, size = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  draw(canvas.getContext('2d'), size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const TEX = {
  // "> <": un colpetto, la concentrazione prima di scattare.
  squint: canvasTexture((g, s) => {
    g.strokeStyle = '#1d1529';
    g.lineWidth = s * 0.11;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(s * 0.26, s * 0.24);
    g.lineTo(s * 0.74, s * 0.5);
    g.lineTo(s * 0.26, s * 0.76);
    g.stroke();
  }),
  // "^ ^": contenta. Capovolto diventa l'occhio chiuso del sonno.
  happy: canvasTexture((g, s) => {
    g.strokeStyle = '#1d1529';
    g.lineWidth = s * 0.11;
    g.lineCap = 'round';
    g.beginPath();
    g.arc(s / 2, s * 0.68, s * 0.3, Math.PI * 1.12, Math.PI * 1.88);
    g.stroke();
  }),
  glow: canvasTexture((g, s) => {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.3, 'rgba(255,255,255,0.35)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, s, s);
  }),
};

function part(parent, geometry, material, { pos, scale, outline = 0 } = {}) {
  const mesh = new THREE.Mesh(geometry, material);
  if (pos) mesh.position.copy(pos);
  if (scale !== undefined) {
    if (typeof scale === 'number') mesh.scale.setScalar(scale);
    else mesh.scale.set(...scale);
  }
  if (outline) {
    const ink = new THREE.Mesh(geometry, flat(INK, { side: THREE.BackSide }));
    ink.scale.setScalar(1 + outline);
    mesh.add(ink);
  }
  parent.add(mesh);
  return mesh;
}

function glowSprite(color, size, opacity) {
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: TEX.glow, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
  );
  sprite.scale.setScalar(size);
  return sprite;
}

/** Gli occhi di Tsukumo: ovali scuri con un riflesso, uguali in ogni forma. */
function makeEye(parent, position, normal, size, mirror) {
  const group = new THREE.Group();
  group.position.copy(position);
  group.quaternion.setFromUnitVectors(Z, normal.clone().normalize());
  parent.add(group);
  const inner = new THREE.Group();
  group.add(inner);
  part(inner, SPHERE, flat(INK), { scale: [size * 0.78, size, size * 0.42] });
  part(inner, SPHERE, flat(0xffffff), { pos: new THREE.Vector3(size * 0.26, size * 0.36, size * 0.34), scale: size * 0.27 });
  const overlays = {};
  for (const key of ['squint', 'happy', 'closed']) {
    const material = flat(0xffffff, { map: TEX[key === 'closed' ? 'happy' : key], transparent: true, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(PLANE, material);
    const s = size * 2.5;
    mesh.scale.set(mirror && key === 'squint' ? -s : s, key === 'closed' ? -s : s, 1);
    mesh.position.z = size * 0.45;
    mesh.visible = false;
    group.add(mesh);
    overlays[key] = mesh;
  }
  return {
    update(lookX, lookY, blink, mode, wide, open) {
      const normal = mode === 'normal';
      inner.visible = normal;
      for (const key in overlays) overlays[key].visible = key === mode;
      inner.position.set(lookX * size * 0.16, lookY * size * 0.16, 0);
      const w = wide ? 1.12 : 1;
      group.scale.set(w, normal ? Math.max(0.08, (1 - blink) * open) * w : 1, 1);
    },
  };
}

/** La punta ondeggia e in corsa resta indietro (uLean); il contorno fa lo stesso. */
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

// ------------------------------------------------------------------ effetti
/**
 * Anelli (come i dock), lampi, scia e linee di velocita'. Stanno nel mondo,
 * non sulla fiammella: durante lo sprint la finestra corre e `drift` li tira
 * indietro, cosi' restano fermi sul desktop.
 */
class FlameFx {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
  }

  ring(position, { lying = false, to = 1, life = 0.8, delay = 0 } = {}) {
    const material = flat(LILAC, { transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(RING, material);
    mesh.position.copy(position);
    if (lying) mesh.rotation.x = -Math.PI / 2;
    mesh.scale.setScalar(0.001);
    this.scene.add(mesh);
    this.items.push({ kind: 'ring', mesh, material, to, life: -delay, max: life });
  }

  flash(position, size) {
    const sprite = glowSprite(0xe4d8ff, 0.001, 1);
    sprite.position.copy(position);
    this.scene.add(sprite);
    this.items.push({ kind: 'flash', mesh: sprite, material: sprite.material, size, life: 0, max: 0.5 });
  }

  trail(position, size) {
    const sprite = glowSprite(0xb89cff, size, 0.5);
    sprite.position.copy(position);
    this.scene.add(sprite);
    this.items.push({ kind: 'trail', mesh: sprite, material: sprite.material, size, life: 0, max: 0.32 });
  }

  line(position, length, thickness) {
    const material = flat(0xcdb8ff, { transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false });
    const mesh = new THREE.Mesh(PLANE, material);
    mesh.position.copy(position);
    mesh.scale.set(length, thickness, 1);
    this.scene.add(mesh);
    this.items.push({ kind: 'line', mesh, material, length, life: 0, max: 0.22 });
  }

  drift(dx) {
    for (const item of this.items) item.mesh.position.x += dx;
  }

  get active() {
    return this.items.length > 0;
  }

  update(dt) {
    this.items = this.items.filter((item) => {
      item.life += dt;
      if (item.life < 0) return true;
      const k = item.life / item.max;
      if (k >= 1) {
        this.scene.remove(item.mesh);
        item.material.dispose();
        return false;
      }
      if (item.kind === 'ring') {
        item.mesh.scale.setScalar(Math.max(0.001, item.to * easeOutCubic(k)));
        item.material.opacity = 0.9 * (1 - k);
      } else if (item.kind === 'flash') {
        item.mesh.scale.setScalar(item.size * (0.1 + 0.9 * easeOutCubic(k)));
        item.material.opacity = 1 - k;
      } else if (item.kind === 'trail') {
        item.mesh.scale.setScalar(item.size * (1 - k * 0.6));
        item.material.opacity = 0.5 * (1 - k);
      } else {
        item.mesh.scale.x = item.length * (1 - k * 0.5);
        item.material.opacity = 0.8 * (1 - k);
      }
      return true;
    });
  }
}

// ------------------------------------------------------------------ la fiammella
export class Flame {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this.scene = scene;
    this.fx = new FlameFx(scene);

    // root: dove sta e quanto e' grande; body: schiacciamenti (perno sulla
    // barra); pivot: sguardo e inclinazione, col perno nel bulbo (inclinata
    // in corsa non affonda nella barra).
    this.root = new THREE.Group();
    this.root.visible = false;
    this.body = new THREE.Group();
    this.pivot = new THREE.Group();
    this.pivot.position.y = HOVER + R;
    this.root.add(this.body);
    this.body.add(this.pivot);
    scene.add(this.root);
    this._build();

    /** Piedi (fondo della goccia a riposo), nel mondo. */
    this.home = new THREE.Vector3();
    /** Metri di scena per unita' della goccia. */
    this.size = 0.4;
    /** 0..1: quanto c'e' (durante il cambio di forma rimpicciolisce fino a sparire). */
    this.presence = 1;
    /** 0..1: quanto si e' spostata verso `chest` (entrando o uscendo dal corpo). */
    this.travel = 0;
    this.chest = new THREE.Vector3();

    this.t = 0;
    this.look = new THREE.Vector2();
    this.blinkAt = rand(0.5, 2.5);
    this.swayPhase = 0;
    this.mouthOpen = 0;
    this.dotsAmount = 0;
    this.reaction = null;
    this.run = null;
    this.held = false;
    this.falling = false;
    this.holdVelocity = 0;
    this._holdLast = null;
    this._point = new THREE.Vector3();
    /** Ombra per VrmStage: dove e quanto grande, in metri, e quanto scura. */
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
    const geometry = new THREE.LatheGeometry(points, 48);
    // Lilla in basso, rosa verso la punta.
    const position = geometry.attributes.position;
    const low = new THREE.Color(0x9d84ff);
    const high = new THREE.Color(0xf4a6dc);
    const color = new THREE.Color();
    const colors = [];
    for (let i = 0; i < position.count; i += 1) {
      color.copy(low).lerp(high, clamp((position.getY(i) + 0.1) / (H + 0.1), 0, 1));
      colors.push(color.r, color.g, color.b);
    }
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    this.uniforms = { uTime: { value: 0 }, uSway: { value: 1 }, uLean: { value: 0 } };
    const material = toon(0xffffff, { vertexColors: true, emissive: new THREE.Color(0x7a5cff), emissiveIntensity: 0.22 });
    const ink = flat(INK, { side: THREE.BackSide });
    sway(material, this.uniforms);
    sway(ink, this.uniforms);
    const drop = new THREE.Mesh(geometry, material);
    this.pivot.add(drop);
    const outline = new THREE.Mesh(geometry, ink);
    outline.scale.setScalar(1.045);
    drop.add(outline);

    const onBulb = (x, y, z, lift) => new THREE.Vector3(x, y, z).normalize().multiplyScalar(R + lift);
    this.eyes = [-1, 1].map((s) => makeEye(this.pivot, onBulb(s * 0.36, 0.06, 0.93, 0.005), new THREE.Vector3(s * 0.36, 0.06, 0.93), 0.085, s === 1));
    // La bocca c'e' solo quando serve (parla, ride, si spaventa).
    this.mouth = part(this.pivot, SPHERE, flat(INK), { pos: onBulb(0, -0.3, 0.95, 0.004), scale: [0.05, 0.001, 0.02] });
    this.glow = glowSprite(0xb89cff, 2.1, 0.45);
    this.glow.position.set(0, 0.2, -0.25);
    this.pivot.add(this.glow);

    // I puntini del pensiero, dal lato opposto a dove guarda pensando.
    this.dots = new THREE.Group();
    const top = HOVER + UNIT;
    for (const [x, y, r] of [[-0.42, top - 0.05, 0.035], [-0.58, top + 0.1, 0.05], [-0.76, top + 0.28, 0.075]]) {
      const dot = part(this.dots, SPHERE, toon(0xcbb8ff), { pos: new THREE.Vector3(x, y, 0.2), scale: r, outline: 0.1 });
      dot.userData.y = y;
    }
    this.root.add(this.dots);
  }

  // ------------------------------------------------------------ misure
  /** Altezza nel mondo (metri). */
  setHeight(height) {
    this.size = height / UNIT;
  }

  /** Centro del bulbo, nel mondo: da li' si prende in mano ed entra nel corpo. */
  centerWorld(target = new THREE.Vector3()) {
    return target.set(0, HOVER + R, 0).applyMatrix4(this.root.matrixWorld);
  }

  /** Punta della fiamma, nel mondo: sopra ci stanno il fumetto e le "zeta". */
  topWorld(target = new THREE.Vector3()) {
    return target.set(0, HOVER + UNIT, 0).applyMatrix4(this.root.matrixWorld);
  }

  /** Il fondo della goccia a riposo, in metri sopra i piedi. */
  get hoverHeight() {
    return HOVER * this.size;
  }

  /** Sta facendo qualcosa che vuole 60 fps. */
  get busy() {
    return Boolean(this.run || this.reaction || this.held || this.falling || this.fx.active || this.travel > 0 || this.presence < 1);
  }

  // ------------------------------------------------------------ eventi
  /** Un gesto o una reazione. Accetta anche i nomi dei gesti del VRM; falso se non lo sa fare. */
  react(name, detail = 0) {
    const key = REACTIONS[name] ? name : GESTURES[name];
    if (!key || this.run) return false;
    this.reaction = { name: key, t: 0, detail };
    return true;
  }

  /** Click: sulla punta e' una carezza, sotto un colpetto. */
  poke(zone) {
    const reaction = zone === 'head' ? 'pat' : 'flinch';
    this.react(reaction);
    return reaction;
  }

  setHeld(value) {
    this.held = Boolean(value);
    this.holdVelocity = 0;
    this._holdLast = null;
  }

  /** Dove si trova la finestra trascinata (pixel dello schermo): la velocita' la fa ondeggiare. */
  moveHold(screenX) {
    const now = performance.now();
    if (this._holdLast) {
      const dt = Math.max(1, now - this._holdLast.at) / 1000;
      this.holdVelocity = damp(this.holdVelocity, (screenX - this._holdLast.x) / dt, 12, dt);
    }
    this._holdLast = { x: screenX, at: now };
  }

  fall() {
    this.falling = true;
  }

  land(impact = 0) {
    this.falling = false;
    this.reaction = null;
    this.react('land', impact);
    if (impact > 0.15) this.fx.ring(this._floor(), { lying: true, to: 0.9 * this.size, life: 0.6 });
  }

  /** Fase dello sprint dalla fisica: ready, go, brake, proud, end. */
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

  /** La finestra si e' spostata di `dx` metri: la scia resta indietro sul desktop. */
  drift(dx) {
    this.fx.drift(dx);
  }

  _floor() {
    return new THREE.Vector3(this.root.position.x, this.home.y + 0.003, this.home.z);
  }

  // ------------------------------------------------------------ ogni frame
  /**
   * @param {number} dt
   * @param {object} input `{speaking, level, thinking, working, listening, sleep, look: {x, y}, music}`
   */
  update(dt, input) {
    this.t += dt;
    const t = this.t;
    const run = this.run;
    if (run) run.t += dt;
    const reaction = this.reaction;
    if (reaction) {
      reaction.t += dt;
      if (reaction.t >= REACTIONS[reaction.name]) this.reaction = null;
    }

    let mood = 'idle';
    const sleep = input.sleep ?? 0;
    if (this.held) mood = 'held';
    else if (this.falling) mood = 'fall';
    else if (input.speaking) mood = 'speak';
    else if (input.listening) mood = 'listen';
    else if (input.working) mood = 'work';
    else if (input.thinking) mood = 'think';
    else if (sleep > 0.9) mood = 'asleep';
    else if (sleep > 0.4) mood = 'drowsy';

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
    let lookX = input.look?.x ?? 0;
    let lookY = input.look?.y ?? 0;
    let lookRate = 7;
    let tilt = Math.sin(t * 0.7) * 0.03;
    let forward = 0;
    let dots = false;

    // Cosa sta facendo (o cosa sta facendo l'agente per lei).
    if (mood === 'speak') {
      mouth = clamp((input.level ?? 0) * 2.4, 0, 1);
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
      lookX = Math.sin(t * 0.8) * 0.15;
      lookY = -0.6;
      jump = Math.abs(Math.sin(t * 14)) * 0.015;
      dots = true;
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
    } else if (mood === 'fall') {
      sy = 1.25;
      sx = 0.85;
      wide = true;
      mouth = 0.5;
      flicker = 3;
    } else if (input.music?.active) {
      // Con Spotify balla a tempo: un piccolo rimbalzo a ogni battito.
      const beat = Math.max(0, 1 - input.music.phase * 2.5) * Math.min(1, (input.music.energy ?? 0) * 4);
      sy -= beat * 0.08;
      jump += beat * 0.05;
      tilt = Math.sin(t * 2.2) * 0.1;
      glow += beat * 0.25;
    }

    // Reazioni ai tocchi e gesti: sopra lo stato, per un attimo.
    let squash = 0;
    if (reaction && !run) {
      const k = reaction.t / REACTIONS[reaction.name];
      switch (reaction.name) {
        case 'flinch':
          squash = Math.sin(k * Math.PI * 4) * (1 - k) * 0.2;
          eyes = 'squint';
          mouth = Math.max(mouth, 0.2);
          break;
        case 'pat':
          sy -= 0.08 * Math.sin(k * Math.PI);
          eyes = 'happy';
          glow += 0.3;
          mouth = Math.max(mouth, 0.3);
          break;
        case 'pout':
          eyes = 'squint';
          lookX = (this.look.x >= 0 ? -1 : 1) * 0.9;
          lookY = 0.1;
          tilt = -0.15;
          glow = 0.3;
          break;
        case 'greet':
          jump = Math.abs(Math.sin(k * Math.PI * 2)) * 0.25 * (1 - k * 0.5);
          eyes = 'happy';
          mouth = Math.max(mouth, 0.5);
          glow = 0.8;
          break;
        case 'call':
          jump = Math.abs(Math.sin(t * 9)) * 0.1;
          glow = Math.sin(t * 9) > 0 ? 1 : 0.3;
          wide = true;
          mouth = Math.max(mouth, 0.3);
          lookX = 0;
          lookY = 0.05;
          break;
        case 'dizzy':
          tilt = Math.sin(t * 9) * 0.35;
          lookX = Math.sin(t * 6) * 0.8;
          lookY = Math.cos(t * 6) * 0.5;
          eyes = 'squint';
          break;
        case 'look':
          lookX = Math.sin(k * Math.PI * 2) * 0.9;
          lookY = 0.1;
          break;
        case 'yawn':
          mouth = Math.sin(k * Math.PI);
          eyes = 'closed';
          sy += 0.06 * Math.sin(k * Math.PI);
          break;
        case 'land': {
          const w = Math.sin(k * Math.PI);
          sy = 1 - (0.12 + 0.25 * reaction.detail) * w;
          sx = 1 / Math.sqrt(sy);
          break;
        }
        default:
          break;
      }
    }

    // Lo sprint comanda su tutto.
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
        jump = Math.abs(Math.sin(run.t * 9)) * 0.1 * Math.max(0, 1 - run.t * 1.5);
        eyes = 'happy';
        mouth = 0.5;
        glow = 0.7;
      }
    }

    // --- applica
    this.look.x = damp(this.look.x, clamp(lookX, -1, 1), lookRate, dt);
    this.look.y = damp(this.look.y, clamp(lookY, -1, 1), lookRate, dt);
    this.pivot.rotation.y = this.look.x * 0.45;
    this.pivot.rotation.x = -this.look.y * 0.28 + forward;
    // Inclinazione: la testa piegata, l'ondeggiare a mezz'aria e, in corsa, la spinta.
    const leanTarget = tilt + lean + Math.sin(t * 1.1) * 0.05 * MOTION;
    this.pivot.rotation.z = damp(this.pivot.rotation.z, leanTarget, run || this.held ? 22 : 6, dt);

    this.body.scale.set(sx + squash * 0.6, sy - squash, 1);
    this.uniforms.uLean.value = damp(this.uniforms.uLean.value, bend, 16, dt);
    this.swayPhase += dt * flicker;
    this.uniforms.uTime.value = this.swayPhase;
    this.uniforms.uSway.value = damp(this.uniforms.uSway.value, swayAmount * MOTION + mouth * 0.6, 8, dt);
    glow += this.travel * 0.8;
    this.glow.material.opacity = damp(this.glow.material.opacity, clamp(glow * 0.75, 0, 1), 18, dt);

    // Posizione: a casa (fluttuando), oppure in viaggio verso il petto del VRM.
    const scale = this.size * this.presence;
    const hover = (Math.sin(t * 1.6) * 0.04 * bob * MOTION + jump) * this.size;
    const toChest = this.chest.y - (HOVER + R) * scale;
    this.root.position.set(
      lerp(this.home.x + shake * this.size, this.chest.x, this.travel),
      lerp(this.home.y + hover, toChest, this.travel),
      lerp(this.home.z, this.chest.z, this.travel),
    );
    this.root.scale.setScalar(Math.max(0.0001, scale));

    // Occhi e bocca.
    if (t > this.blinkAt + 0.16) this.blinkAt = t + rand(1.8, 4.8);
    const blink = run || eyes !== 'normal' ? 0 : t >= this.blinkAt ? Math.sin(clamp((t - this.blinkAt) / 0.16, 0, 1) * Math.PI) : 0;
    for (const eye of this.eyes) eye.update(this.look.x, this.look.y, blink, eyes, wide, open);
    this.mouthOpen = damp(this.mouthOpen, mouth, 20, dt);
    this.mouth.visible = this.mouthOpen > 0.03;
    this.mouth.scale.set(0.05 * (1 + this.mouthOpen * 0.4), Math.max(0.001, this.mouthOpen * 0.045), 0.02);

    this.dotsAmount = damp(this.dotsAmount, dots && !run && this.travel === 0 ? 1 : 0, 10, dt);
    this.dots.visible = this.dotsAmount > 0.01;
    this.dots.scale.setScalar(Math.max(0.001, this.dotsAmount));
    const dotSpeed = mood === 'work' ? 6 : 3;
    this.dots.children.forEach((dot, i) => {
      dot.position.y = dot.userData.y + Math.sin(t * dotSpeed - i * 0.8) * 0.03;
    });

    // L'ombra: si stringe quando salta, sparisce mentre entra nel corpo.
    const lift = hover / Math.max(1e-6, this.size);
    this.shadow.x = this.root.position.x;
    this.shadow.z = this.home.z;
    this.shadow.size = 0.9 * this.size * this.presence * (1 - lift * 0.6) * (1 + (sx - 1) * 0.8);
    this.shadow.opacity = this.root.visible ? 0.9 * (1 - this.travel) : 0;

    this.fx.update(dt);
  }

  _spawnTrail(run, dt) {
    const center = this.centerWorld(this._point);
    this.fx.trail(center, 0.95 * this.size);
    run.lineAt -= dt;
    if (run.lineAt > 0) return;
    run.lineAt = 0.035;
    const s = this.size;
    this.fx.line(
      new THREE.Vector3(center.x - run.dir * rand(0.7, 1.5) * s, center.y + rand(-0.45, 0.45) * s, center.z - 0.1 * s),
      rand(0.7, 1.5) * s,
      0.022 * s,
    );
  }
}
