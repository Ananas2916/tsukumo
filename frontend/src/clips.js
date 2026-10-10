/**
 * Recorded animations (.vrma), blended into the procedural body.
 *
 * Tsukumo's movement is all procedural (body.js): breathing, weight,
 * gestures, gaze. A VRMA clip - mocap or hand-made, for example with VRoid or
 * pixiv's free packs - adds movements that are hard to write by hand: a
 * theatrical greeting, a little dance, a stretch.
 *
 * Clips live in `frontend/public/animations/` (the backend lists them with
 * `GET /api/animations`). The name says when to use them:
 *   - `greet*.vrma`  instead of the hand wave, when she appears;
 *   - `idle*.vrma`   now and then, among the spontaneous gestures;
 *   - `dance*.vrma`  looped while Spotify plays;
 *   - `bow*`, `inchino*`         when you thank her;
 *   - `alza*`, `here*`, `raise*` when you call her by name (wake word);
 *   - the others     only on request, from the panel (bow and raise too).
 *
 * From a motion-capture BVH: `scripts/bvh2vrma.mjs`.
 *
 * Only bone rotations are used: no hip translation (the mascot must not
 * leave the window), no expressions or gaze (the body already handles them).
 * The clip fades in and out, and touches only the bones the body rewrites
 * from scratch every frame: when the clip ends nothing stays "stuck".
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createVRMAnimationHumanoidTracks, VRMAnimationLoaderPlugin } from '@pixiv/three-vrm-animation';

const FADE_IN = 0.35;
const FADE_OUT = 0.45;

/** From the file name to the role: greet, idle, dance, action. */
export function clipRole(name) {
  const base = name.toLowerCase();
  if (/^(greet|wave|hello)/.test(base)) return 'greet';
  if (/^idle/.test(base)) return 'idle';
  if (/^dance/.test(base)) return 'dance';
  if (/^(bow|inchino)/.test(base)) return 'bow';
  if (/^(alza|here|raise)/.test(base)) return 'here';
  return 'action';
}

export class ClipPlayer {
  /**
   * @param {import('@pixiv/three-vrm').VRM} vrm
   * @param {Set<string>|string[]} managed bones the body rewrites every frame
   */
  constructor(vrm, managed) {
    this.vrm = vrm;
    this.managed = new Set(managed);
    this.clips = new Map();
    this.active = null;
    this._q = new THREE.Quaternion();
    this.loader = new GLTFLoader();
    this.loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
  }

  /** Loads the clips listed by the backend (`[{name, url}]`); broken ones are skipped. */
  async load(list) {
    const metaVersion = this.vrm.meta?.metaVersion === '0' ? '0' : '1';
    for (const item of list ?? []) {
      try {
        const gltf = await this.loader.loadAsync(item.url);
        const animation = gltf.userData.vrmAnimations?.[0];
        if (!animation) continue;
        const { rotation } = createVRMAnimationHumanoidTracks(animation, this.vrm.humanoid, metaVersion);
        const tracks = [];
        for (const [bone, track] of rotation) {
          const node = this.vrm.humanoid.getNormalizedBoneNode(bone);
          if (!node || !this.managed.has(bone)) continue;
          tracks.push({ node, interpolant: track.createInterpolant(), times: track.times });
        }
        if (!tracks.length) continue;
        const name = item.name.replace(/\.vrma$/i, '');
        this.clips.set(name, { name, role: clipRole(name), duration: animation.duration || 1, tracks });
      } catch (error) {
        console.warn(`[clips] ${item.name} not loaded:`, error);
      }
    }
    return [...this.clips.values()].map(({ name, role, duration }) => ({ name, role, duration }));
  }

  has(role) {
    return [...this.clips.values()].some((clip) => clip.role === role);
  }

  get playing() {
    return this.active !== null;
  }

  /** Plays a clip by name; `loop` for dances. */
  play(name, { loop = false } = {}) {
    const clip = this.clips.get(name);
    if (!clip) return false;
    this.active = { clip, time: 0, loop, stopping: false, weight: this.active?.weight ?? 0 };
    return true;
  }

  /** A random clip of a role. */
  playRole(role, options) {
    const candidates = [...this.clips.values()].filter((clip) => clip.role === role);
    if (!candidates.length) return false;
    return this.play(candidates[Math.floor(Math.random() * candidates.length)].name, options);
  }

  /** Fades out. */
  stop() {
    if (this.active) this.active.stopping = true;
  }

  /**
   * Call after the body has written its pose and before vrm.update(): moves
   * the bones towards the clip, by the current weight.
   */
  apply(dt) {
    const state = this.active;
    if (!state) return;
    const { clip } = state;
    state.time += dt;
    if (state.loop && state.time >= clip.duration) state.time %= clip.duration;
    const ending = !state.loop && state.time >= clip.duration - FADE_OUT;
    const target = state.stopping || ending ? 0 : 1;
    const rate = target > state.weight ? 1 / FADE_IN : 1 / FADE_OUT;
    state.weight = Math.max(0, Math.min(1, state.weight + Math.sign(target - state.weight) * rate * dt));
    if ((state.stopping || ending) && state.weight <= 0) {
      this.active = null;
      return;
    }
    const time = Math.min(state.time, clip.duration);
    // Fade with a smooth start and end: linear shows the "snap" at the start.
    const weight = state.weight * state.weight * (3 - 2 * state.weight);
    for (const { node, interpolant } of clip.tracks) {
      const values = interpolant.evaluate(time);
      this._q.set(values[0], values[1], values[2], values[3]);
      node.quaternion.slerp(this._q, weight);
    }
  }
}
