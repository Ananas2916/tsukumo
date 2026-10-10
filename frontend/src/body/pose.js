/**
 * Accumulator of a frame's pose (see body.js).
 */

import * as THREE from 'three';

import { EPSILON, MOODS, SIDES } from './constants.js';

/** The fingers that can be extended one by one (see `Pose.extend`). */
export const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];

/** Returned by `Pose.get` for a bone no layer touched. */
const _zero = new THREE.Vector3();

/**
 * Accumulator of a frame's pose. Each layer (posture, breathing, gestures,
 * actions, reactions...) adds its already weighted contribution; at the end
 * everything is applied in one go.
 */
export class Pose {
  constructor() {
    this.rot = new Map();
    this.hips = new THREE.Vector3();
    this.feet = { left: new THREE.Vector3(), right: new THREE.Vector3() };
    this.heel = { left: 0, right: 0 };
    this.fingers = { left: 0, right: 0 };
    /**
     * Fingers extended one by one (0..1), on top of the `fingers` curl: the V
     * is the closed hand with Index and Middle extended, the gun Index and Thumb.
     */
    this.extend = { left: {}, right: {} };
    /** Index and middle spread apart (the V), 0..1. */
    this.spread = { left: 0, right: 0 };
    this.hands = { left: [], right: [] };
    this.expr = {};
    this.gaze = { yaw: 0, pitch: 0, weight: 0 };
    this.reset();
  }

  reset() {
    for (const value of this.rot.values()) value.set(0, 0, 0);
    this.hips.set(0, 0, 0);
    for (const side of SIDES) {
      this.feet[side].set(0, 0, 0);
      this.heel[side] = 0;
      this.fingers[side] = 0;
      this.hands[side].length = 0;
      this.spread[side] = 0;
      for (const finger of FINGERS) this.extend[side][finger] = 0;
    }
    /** Rotation of the whole body around the feet (twirl, showing off), radians. */
    this.rootYaw = 0;
    for (const mood of MOODS) this.expr[mood] = 0;
    this.gaze.yaw = 0;
    this.gaze.pitch = 0;
    this.gaze.weight = 0;
    /** Weight of the leg IK: 1 = feet planted on the ground. */
    this.legIK = 0;
    /** Forced eye closing (0..1), on top of blinking. */
    this.eyesClosed = 0;
    /** Mouth open without voice (the yawn), 0..1: added to the lip-sync. */
    this.mouthOpen = 0;
  }

  add(bone, x, y, z) {
    let value = this.rot.get(bone);
    if (!value) {
      value = new THREE.Vector3();
      this.rot.set(bone, value);
    }
    value.x += x;
    value.y += y;
    value.z += z;
  }

  get(bone) {
    return this.rot.get(bone) ?? _zero.set(0, 0, 0);
  }

  /** Rotation of a side bone written for the left side. */
  side(side, part, x, y, z, w = 1) {
    const s = side === 'left' ? 1 : -1;
    this.add(side + part, x * w, y * s * w, z * s * w);
  }

  both(part, x, y, z, w = 1) {
    this.side('left', part, x, y, z, w);
    this.side('right', part, x, y, z, w);
  }

  /** Extends the listed fingers (`['Index', 'Middle']`) by weight `w`. */
  point(side, fingers, w) {
    for (const finger of fingers) this.extend[side][finger] += w;
  }

  mood(name, value) {
    this.expr[name] += value;
  }

  /**
   * Brings a hand to a point, expressed relative to a reference bone (`head`,
   * `upperChest`, `hips`...) and written for the left side: for the right one
   * X is mirrored. `pole` is the direction the elbow points to, `twist`
   * rotates the forearm on its axis (palm up/down). `base` requests (hands
   * resting while sitting or lying down) give way to gestures and actions.
   */
  reach(side, anchor, offset, pole, weight, twist = 0, base = false) {
    if (weight <= EPSILON) return;
    const s = side === 'left' ? 1 : -1;
    this.hands[side].push({
      anchor,
      offset: [offset[0] * s, offset[1], offset[2]],
      pole: [pole[0] * s, pole[1], pole[2]],
      weight,
      twist,
      base,
    });
  }

  /** Like `reach`, but towards a fixed point in the world (the screen edge). */
  reachWorld(side, point, pole, weight, twist = 0) {
    if (weight <= EPSILON) return;
    const s = side === 'left' ? 1 : -1;
    this.hands[side].push({ world: point, pole: [pole[0] * s, pole[1], pole[2]], weight, twist, base: false });
  }
}
