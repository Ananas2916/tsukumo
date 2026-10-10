/**
 * The flame's effects: rings, flashes, trail, speed lines
 * and little figures flying away (hearts, notes, stars). They live in the
 * world, not on her: when the window runs (sprint, throw) `drift` pulls them
 * back, so they stay still on the desktop.
 */

import * as THREE from 'three';

import { flat, glowSprite, PLANE, RING, textureSprite } from './look.js';

const easeOutCubic = (k) => 1 - Math.pow(1 - Math.min(1, Math.max(0, k)), 3);
const easeOutBack = (k) => {
  const x = Math.min(1, Math.max(0, k)) - 1;
  return 1 + 2.7 * x * x * x + 1.7 * x * x;
};

export class FlameFx {
  constructor(scene, colors) {
    this.scene = scene;
    this.items = [];
    this.setColors(colors);
  }

  setColors(colors) {
    this.colors = colors;
    this.flashColor = new THREE.Color(colors.soft).lerp(new THREE.Color(0xffffff), 0.5);
  }

  ring(position, { lying = false, to = 1, life = 0.8, delay = 0 } = {}) {
    const material = flat(this.colors.accent, { transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(RING, material);
    mesh.position.copy(position);
    if (lying) mesh.rotation.x = -Math.PI / 2;
    mesh.scale.setScalar(0.001);
    this.scene.add(mesh);
    this.items.push({ kind: 'ring', mesh, material, to, life: -delay, max: life });
  }

  flash(position, size) {
    const sprite = glowSprite(this.flashColor, 0.001, 1);
    sprite.position.copy(position);
    this.scene.add(sprite);
    this.items.push({ kind: 'flash', mesh: sprite, material: sprite.material, size, life: 0, max: 0.5 });
  }

  trail(position, size) {
    const sprite = glowSprite(this.colors.glow, size, 0.5);
    sprite.position.copy(position);
    this.scene.add(sprite);
    this.items.push({ kind: 'trail', mesh: sprite, material: sprite.material, size, life: 0, max: 0.32 });
  }

  line(position, length, thickness) {
    const material = flat(this.colors.soft, { transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false });
    const mesh = new THREE.Mesh(PLANE, material);
    mesh.position.copy(position);
    mesh.scale.set(length, thickness, 1);
    this.scene.add(mesh);
    this.items.push({ kind: 'line', mesh, material, length, life: 0, max: 0.22 });
  }

  /**
   * A little figure flying away: it appears with a small bounce, rises (or
   * falls with `gravity`), sways and fades. `velocity` in metres per second.
   */
  sprite(texture, position, { size = 0.1, velocity = new THREE.Vector3(0, 0.2, 0), gravity = 0, life = 1.2, sway = 0, spin = 0, color = 0xffffff, delay = 0 } = {}) {
    const sprite = textureSprite(texture, 0.001);
    sprite.material.color.set(color);
    sprite.material.opacity = 0;
    sprite.position.copy(position);
    this.scene.add(sprite);
    this.items.push({
      kind: 'sprite',
      mesh: sprite,
      material: sprite.material,
      size,
      velocity: velocity.clone(),
      gravity,
      sway,
      spin,
      phase: Math.random() * Math.PI * 2,
      life: -delay,
      max: life,
    });
  }

  drift(dx, dy = 0) {
    for (const item of this.items) {
      item.mesh.position.x += dx;
      item.mesh.position.y += dy;
    }
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
      switch (item.kind) {
        case 'ring':
          item.mesh.scale.setScalar(Math.max(0.001, item.to * easeOutCubic(k)));
          item.material.opacity = 0.9 * (1 - k);
          break;
        case 'flash':
          item.mesh.scale.setScalar(item.size * (0.1 + 0.9 * easeOutCubic(k)));
          item.material.opacity = 1 - k;
          break;
        case 'trail':
          item.mesh.scale.setScalar(item.size * (1 - k * 0.6));
          item.material.opacity = 0.5 * (1 - k);
          break;
        case 'sprite': {
          item.velocity.y -= item.gravity * dt;
          item.mesh.position.addScaledVector(item.velocity, dt);
          item.mesh.position.x += Math.cos(item.life * 5 + item.phase) * item.sway * dt;
          item.material.rotation += item.spin * dt;
          item.mesh.scale.setScalar(Math.max(0.001, item.size * easeOutBack(item.life / 0.22)));
          item.material.opacity = Math.min(1, item.life / 0.08) * (k > 0.65 ? 1 - (k - 0.65) / 0.35 : 1);
          break;
        }
        default:
          item.mesh.scale.x = item.length * (1 - k * 0.5);
          item.material.opacity = 0.8 * (1 - k);
          break;
      }
      return true;
    });
  }
}
