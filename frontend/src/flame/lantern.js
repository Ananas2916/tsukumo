/**
 * The new version's lantern.
 *
 * Tsukumo is a tsukumogami, a spirit living in an object: a new version is a
 * new home for her. When one is out a paper lantern (chōchin) appears beside
 * her, unlit, with 新 ("new") and the version written on it; now and then she
 * sends it a spark and it flickers. One click on it and she jumps inside: it
 * lights up in her colour while the update downloads. After the update she
 * comes back out of it, and the lantern floats away.
 *
 * All geometry and canvas, in drop units (see flame.js), but a child of the
 * scene, not of her: she must be able to leave her place and go into it.
 */

import * as THREE from 'three';

import { canvasTexture, glowSprite, part, toon } from './look.js';

const damp = (current, target, rate, dt) => current + (target - current) * (1 - Math.exp(-rate * dt));
const pop = (k) => {
  const x = Math.min(1, Math.max(0, k)) - 1;
  return 1 + 2.7 * x * x * x + 1.7 * x * x;
};

/** Where it hangs, from her feet, in drop units: on her left, at the height of her bulb. */
export const LANTERN_SPOT = { x: -0.98, y: 0.86, z: 0.1 };
/** Its size next to her: big enough to read what's written on it. */
const SCALE = 1.35;
/** Half height of the paper and its widest radius. */
const HALF = 0.2;
const WIDE = 0.17;
/** The paper's radius at height `y` (−HALF..HALF): a barrel, flat at the ends. */
const radiusAt = (y) => 0.07 + (WIDE - 0.07) * Math.cos((y / HALF) * Math.PI * 0.5) ** 0.6;

/** 新 in red brush strokes, and the version under it, like the writing on a chōchin. */
function labelTexture(version) {
  return canvasTexture(
    (g, w, h) => {
      g.clearRect(0, 0, w, h);
      g.fillStyle = '#c0283a';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = `700 ${Math.round(h * 0.46)}px "Yu Mincho", "MS Mincho", "Noto Serif JP", serif`;
      g.fillText('新', w / 2, h * 0.34);
      g.fillStyle = '#1d1529';
      g.font = `800 ${Math.round(h * 0.2)}px "Segoe UI", system-ui, sans-serif`;
      g.fillText(version, w / 2, h * 0.79);
    },
    128,
    192,
  );
}

export class Lantern {
  /**
   * @param {THREE.Scene} scene
   * @param {object} colors her palette (look.js): the lit paper takes her glow
   */
  constructor(scene, colors) {
    this.t = 0;
    // pivot: the top of the handle, it swings from there; body: the lantern under it.
    this.group = new THREE.Group();
    this.group.visible = false;
    this.pivot = new THREE.Group();
    this.body = new THREE.Group();
    this.body.position.y = -(HALF + 0.07);
    this.pivot.add(this.body);
    this.group.add(this.pivot);
    scene.add(this.group);

    const profile = [];
    for (let i = 0; i <= 16; i += 1) {
      const y = -HALF + (i / 16) * HALF * 2;
      profile.push(new THREE.Vector2(radiusAt(y), y));
    }
    this.paper = part(
      this.body,
      new THREE.LatheGeometry(profile, 36),
      toon(0xf4e7d2, { emissive: new THREE.Color(colors.emissive), emissiveIntensity: 0 }),
      { outline: 0.045 },
    );
    // The bamboo ribs.
    const rib = toon(0x8a5a3a);
    for (let i = -3; i <= 3; i += 1) {
      const y = (i / 4) * HALF;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(radiusAt(y) + 0.003, 0.0045, 6, 40), rib);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = y;
      this.body.add(ring);
    }
    // Lacquered caps, the handle and the red tassel.
    const lacquer = toon(0x2a1c24);
    for (const side of [-1, 1]) {
      const cap = part(this.body, new THREE.CylinderGeometry(0.082, 0.082, 0.034, 28), lacquer, { outline: 0.06 });
      cap.position.y = side * (HALF + 0.012);
    }
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.009, 8, 24, Math.PI), lacquer);
    handle.position.y = HALF + 0.03;
    this.body.add(handle);
    const tassel = part(this.body, new THREE.ConeGeometry(0.026, 0.09, 12), toon(0xc0283a), { outline: 0.08 });
    tassel.position.y = -(HALF + 0.08);
    tassel.rotation.x = Math.PI;
    this.tassel = tassel;

    // The writing, on a strip of the same curve as the paper's middle.
    this.labelMaterial = toon(0xffffff, { map: labelTexture(''), transparent: true, depthWrite: false });
    this.label = new THREE.Mesh(new THREE.CylinderGeometry(WIDE + 0.004, WIDE + 0.004, 0.27, 24, 1, true, -0.62, 1.24), this.labelMaterial);
    this.body.add(this.label);
    this.version = '';

    // Her light, through the paper.
    this.halo = glowSprite(colors.emissive, 1.2, 0);
    this.body.add(this.halo);

    this.state = { shown: 0, light: 0, away: 0 };
    this.swing = 0;
    this.swingSpeed = 0;
    this.pulseLight = 0;
  }

  setColors(colors) {
    this.paper.material.emissive.set(colors.emissive);
    this.halo.material.color.set(colors.emissive);
  }

  setVersion(version) {
    const text = String(version ?? '').split('.').slice(0, 2).join('.');
    if (text === this.version) return;
    this.version = text;
    this.labelMaterial.map.dispose();
    this.labelMaterial.map = labelTexture(text ? `v${text}` : '');
  }

  /** A spark of hers got in: a short glow. */
  pulse(amount = 0.55) {
    this.pulseLight = Math.max(this.pulseLight, amount);
  }

  /** A push: it swings from its handle and settles back. */
  push(amount) {
    this.swingSpeed += amount;
  }

  /** The middle of the paper, in the world: she goes in there, the sparks fly there. */
  centerWorld(target = new THREE.Vector3()) {
    return target.set(0, 0, 0).applyMatrix4(this.body.matrixWorld);
  }

  /** The paper's radius in metres, for the click. */
  get radius() {
    return WIDE * this.group.scale.x * 1.2;
  }

  get busy() {
    return this.group.visible;
  }

  /**
   * @param {THREE.Vector3} anchor her feet at home, in the world
   * @param {number} size metres per drop unit
   * @param {{shown: number, light: number, away: number, flicker: number}} want
   *   `shown` 0..1 (it drops in with a little bounce), `light` 0..1, `away` 0..1
   *   (it floats up and shrinks), `flicker` how much the light trembles
   */
  update(dt, anchor, size, want) {
    this.t += dt;
    const t = this.t;
    const s = this.state;
    s.shown = damp(s.shown, want.shown, want.shown > s.shown ? 5 : 9, dt);
    s.light = damp(s.light, want.light, want.light > s.light ? 6 : 3, dt);
    s.away = want.away;
    this.pulseLight = damp(this.pulseLight, 0, 3.5, dt);
    this.group.visible = s.shown > 0.01 && s.away < 0.99;
    if (!this.group.visible) return;

    // A pendulum with friction, plus a breath of air.
    this.swingSpeed += (-this.swing * 9 - this.swingSpeed * 2.2) * dt;
    this.swing += this.swingSpeed * dt;
    this.pivot.rotation.z = this.swing + Math.sin(t * 1.3) * 0.05;
    this.body.rotation.y = Math.sin(t * 0.7) * 0.18;
    this.tassel.rotation.z = -this.pivot.rotation.z * 0.8;

    const appear = pop(s.shown);
    const drop = (1 - Math.min(1, s.shown * 1.4)) * 0.35;
    const rise = s.away * s.away * 1.6;
    const bob = Math.sin(t * 1.6 + 1) * 0.025;
    this.group.position.set(
      anchor.x + LANTERN_SPOT.x * size,
      anchor.y + (LANTERN_SPOT.y + (HALF + 0.07) * SCALE + drop + rise + bob) * size,
      anchor.z + LANTERN_SPOT.z * size,
    );
    this.group.scale.setScalar(Math.max(0.0001, size * SCALE * appear * (1 - s.away * 0.7)));

    const flicker = 1 + (want.flicker ?? 0) * (Math.sin(t * 23) * 0.06 + Math.sin(t * 37) * 0.04);
    const light = Math.min(1, (s.light + this.pulseLight) * flicker) * (1 - s.away);
    // Lit from inside: the paper takes her colour, the light spills around it.
    this.paper.material.emissiveIntensity = light * 1.5;
    this.halo.material.opacity = Math.min(1, light * 1.1);
    this.halo.scale.setScalar(0.7 + light * 0.9);
    this.labelMaterial.opacity = 1 - s.away;
  }
}
