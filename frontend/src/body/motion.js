/**
 * Mattoni matematici del movimento: curve, rumore, molle.
 *
 * Niente di specifico dei VRM: sono gli strumenti con cui body.js scrive ogni
 * strato dell'animazione senza scatti, qualunque sia il frame rate.
 */

import * as THREE from 'three';

export const TAU = Math.PI * 2;
export const { clamp } = THREE.MathUtils;

// Temporanei di basisQuat: niente allocazioni nel loop di rendering.
const _cross = new THREE.Vector3();
const _basis = new THREE.Matrix4();

export const smoothstep = (t) => t * t * (3 - 2 * t);

/** Avvicinamento esponenziale indipendente dal frame rate. */
export function damp(current, target, rate, dt) {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

/**
 * Valore di una curva a chiavi `[[u, valore], ...]` con raccordi morbidi:
 * e' il modo piu' compatto di scrivere un movimento "sale, resta, scende".
 */
export function curve(u, keys) {
  if (u <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i += 1) {
    const [u1, v1] = keys[i];
    if (u <= u1) {
      const [u0, v0] = keys[i - 1];
      return v0 + (v1 - v0) * smoothstep((u - u0) / (u1 - u0));
    }
  }
  return keys[keys.length - 1][1];
}

/** Rumore morbido 1D: sinusoidi con frequenze non commensurabili, in -1..1. */
export function makeNoise(frequency) {
  const phase = [Math.random() * TAU, Math.random() * TAU, Math.random() * TAU];
  return (t) =>
    Math.sin(t * frequency + phase[0]) * 0.5 +
    Math.sin(t * frequency * 2.13 + phase[1]) * 0.3 +
    Math.sin(t * frequency * 3.71 + phase[2]) * 0.2;
}

export const randomBetween = (min, max) => min + Math.random() * (max - min);

/**
 * Molla smorzata critica, integrata in modo implicito: arriva al bersaglio
 * senza oscillare ed e' stabile anche se un frame dura molto.
 */
export class Spring {
  constructor(omega, value = 0) {
    this.omega = omega;
    this.x = value;
    this.v = 0;
  }

  update(target, dt) {
    const w = this.omega;
    const f = 1 + 2 * dt * w;
    const hoo = dt * w * w;
    const inv = 1 / (f + dt * hoo);
    const x = (f * this.x + dt * this.v + dt * hoo * target) * inv;
    this.v = (this.v + hoo * (target - this.x)) * inv;
    this.x = x;
    return x;
  }
}

/** Molla sottosmorzata: per i rimbalzi (atterraggi, sballottamenti). */
export class Wobble {
  constructor(omega, zeta) {
    this.omega = omega;
    this.zeta = zeta;
    this.x = 0;
    this.v = 0;
  }

  update(dt) {
    const steps = Math.ceil(dt / 0.01);
    const h = dt / steps;
    for (let i = 0; i < steps; i += 1) {
      this.v += (-2 * this.zeta * this.omega * this.v - this.omega * this.omega * this.x) * h;
      this.x += this.v * h;
    }
    return this.x;
  }
}

/** Base ortonormale [x, y, x*y] come quaternione. */
export function basisQuat(x, y, target) {
  _cross.crossVectors(x, y);
  _basis.makeBasis(x, y, _cross);
  return target.setFromRotationMatrix(_basis);
}
