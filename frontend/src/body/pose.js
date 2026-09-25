/**
 * Accumulatore della posa di un frame (vedi body.js).
 */

import * as THREE from 'three';

import { EPSILON, MOODS, SIDES } from './constants.js';

/** Restituito da `Pose.get` per un bone che nessuno strato ha toccato. */
const _zero = new THREE.Vector3();

/**
 * Accumulatore della posa di un frame. Ogni strato (postura, respiro, gesti,
 * azioni, reazioni...) somma il suo contributo gia' pesato; alla fine si
 * applica tutto in un colpo solo.
 */
export class Pose {
  constructor() {
    this.rot = new Map();
    this.hips = new THREE.Vector3();
    this.feet = { left: new THREE.Vector3(), right: new THREE.Vector3() };
    this.heel = { left: 0, right: 0 };
    this.fingers = { left: 0, right: 0 };
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
    }
    for (const mood of MOODS) this.expr[mood] = 0;
    this.gaze.yaw = 0;
    this.gaze.pitch = 0;
    this.gaze.weight = 0;
    /** Peso dell'IK delle gambe: 1 = piedi piantati a terra. */
    this.legIK = 0;
    /** Chiusura forzata degli occhi (0..1), oltre al battito di ciglia. */
    this.eyesClosed = 0;
    /** Bocca aperta senza voce (lo sbadiglio), 0..1: si somma al lip-sync. */
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

  /** Rotazione di un bone laterale scritta per il lato sinistro. */
  side(side, part, x, y, z, w = 1) {
    const s = side === 'left' ? 1 : -1;
    this.add(side + part, x * w, y * s * w, z * s * w);
  }

  both(part, x, y, z, w = 1) {
    this.side('left', part, x, y, z, w);
    this.side('right', part, x, y, z, w);
  }

  mood(name, value) {
    this.expr[name] += value;
  }

  /**
   * Porta una mano in un punto, espresso rispetto a un bone di riferimento
   * (`head`, `upperChest`, `hips`...) e scritto per il lato sinistro: per il
   * destro la X viene specchiata. `pole` e' la direzione verso cui punta il
   * gomito, `twist` ruota l'avambraccio sul suo asse (palmo in su/in giu').
   * Le richieste `base` (le mani appoggiate da seduta o da sdraiata) cedono
   * il passo a gesti e azioni.
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

  /** Come `reach`, ma verso un punto fisso del mondo (il bordo dello schermo). */
  reachWorld(side, point, pole, weight, twist = 0) {
    if (weight <= EPSILON) return;
    const s = side === 'left' ? 1 : -1;
    this.hands[side].push({ world: point, pole: [pole[0] * s, pole[1], pole[2]], weight, twist, base: false });
  }
}
