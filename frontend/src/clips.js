/**
 * Animazioni registrate (.vrma), mescolate al corpo procedurale.
 *
 * Il movimento di Tsukumo e' tutto procedurale (body.js): respiro, peso,
 * gesti, sguardo. Una clip VRMA - mocap o fatta a mano, per esempio con VRoid
 * o con i pacchetti gratuiti di pixiv - aggiunge movimenti che a mano sono
 * difficili da scrivere: un saluto teatrale, un balletto, uno stiracchiamento.
 *
 * Le clip stanno in `frontend/public/animations/` (il backend le elenca con
 * `GET /api/animations`). Il nome dice quando usarle:
 *   - `greet*.vrma`  al posto del saluto con la mano, quando compare;
 *   - `idle*.vrma`   ogni tanto, fra i gesti spontanei;
 *   - `dance*.vrma`  in loop mentre Spotify suona;
 *   - le altre       solo a richiesta, dal pannello.
 *
 * Si usano solo le rotazioni delle ossa: niente spostamento dei fianchi (la
 * mascotte non deve uscire dalla finestra), niente espressioni ne' sguardo
 * (li gestisce gia' il corpo). La clip entra e esce in dissolvenza, e tocca
 * solo le ossa che il corpo riscrive da capo a ogni frame: finita la clip non
 * resta niente di "incollato".
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createVRMAnimationHumanoidTracks, VRMAnimationLoaderPlugin } from '@pixiv/three-vrm-animation';

const FADE_IN = 0.35;
const FADE_OUT = 0.45;

/** Dal nome del file al ruolo: greet, idle, dance, action. */
export function clipRole(name) {
  const base = name.toLowerCase();
  if (/^(greet|wave|hello)/.test(base)) return 'greet';
  if (/^idle/.test(base)) return 'idle';
  if (/^dance/.test(base)) return 'dance';
  return 'action';
}

export class ClipPlayer {
  /**
   * @param {import('@pixiv/three-vrm').VRM} vrm
   * @param {Set<string>|string[]} managed ossa che il corpo riscrive a ogni frame
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

  /** Carica le clip elencate dal backend (`[{name, url}]`); quelle rotte si saltano. */
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
        console.warn(`[clips] ${item.name} non caricata:`, error);
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

  /** Suona una clip per nome; `loop` per i balli. */
  play(name, { loop = false } = {}) {
    const clip = this.clips.get(name);
    if (!clip) return false;
    this.active = { clip, time: 0, loop, stopping: false, weight: this.active?.weight ?? 0 };
    return true;
  }

  /** Una clip a caso fra quelle di un ruolo. */
  playRole(role, options) {
    const candidates = [...this.clips.values()].filter((clip) => clip.role === role);
    if (!candidates.length) return false;
    return this.play(candidates[Math.floor(Math.random() * candidates.length)].name, options);
  }

  /** Esce in dissolvenza. */
  stop() {
    if (this.active) this.active.stopping = true;
  }

  /**
   * Da chiamare dopo che il corpo ha scritto la sua posa e prima di vrm.update():
   * porta le ossa verso la clip, del peso corrente.
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
    for (const { node, interpolant } of clip.tracks) {
      const values = interpolant.evaluate(time);
      this._q.set(values[0], values[1], values[2], values[3]);
      node.quaternion.slerp(this._q, state.weight);
    }
  }
}
