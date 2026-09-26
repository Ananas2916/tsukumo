/**
 * Modi di stare in piedi: timida, cool, elegante, energica, diva...
 *
 * Rifatti guardando i "caratteri" del Photo Booth di VRoid Hub (Standard,
 * Innocent, Cool, Ladylike, Shy, Energetic, Flamboyant, Gentleman, Powerful)
 * fotogramma per fotogramma, di fronte e di lato, e riscritti da zero con
 * gli strumenti del corpo procedurale: nessun dato preso da loro.
 *
 * Ogni modo ha una `base` (come tiene piedi, busto, testa e braccia, sempre)
 * e delle `phrases` che si alternano, ognuna per qualche secondo (la cool
 * tiene una mano sul fianco, poi incrocia le braccia). Le mani della base
 * sono richieste "base": cedono il passo ai gesti del parlato, al pensiero,
 * alle azioni, cosi' le braccia non si incastrano mai.
 *
 * `sway` scala lo spostamento del peso da una gamba all'altra: un'elegante
 * sta composta, un'energica si muove di piu'. Le coordinate delle mani sono
 * per il lato sinistro e specchiate per il destro; `side` e' la mano
 * "dominante" della frase (la destra, come nel riferimento).
 */

import { clamp, curve, TAU } from './motion.js';

const DOMINANT = 'right';
const OTHER = 'left';
/** Segno del lato dominante: +1 sinistra, -1 destra (vedi Pose.side). */
const S = -1;

// ------------------------------------------------------------ pezzi comuni
function handOnHip(pose, side, k) {
  // Polso alla vita (sopra il bacino), gomito ben in fuori.
  pose.reach(side, 'hips', [0.155, 0.1, 0.0], [1, 0.2, -0.4], k, -0.3, true);
  pose.fingers[side] += 0.25 * k;
}

function armsCrossed(pose, k) {
  pose.reach('left', 'upperChest', [-0.09, -0.1, 0.13], [1, -0.5, 0.1], k, 0.7, true);
  pose.reach('right', 'upperChest', [-0.1, -0.075, 0.17], [1, -0.5, 0.1], k, 0.7, true);
  pose.fingers.left += 0.3 * k;
  pose.fingers.right += 0.3 * k;
}

function handsFront(pose, k, height = 0.03) {
  pose.reach('left', 'hips', [0.035, height, 0.14], [1, -1, -0.1], k, 0.9, true);
  pose.reach('right', 'hips', [0.035, height, 0.14], [1, -1, -0.1], k, 0.9, true);
  pose.fingers.left += 0.15 * k;
  pose.fingers.right += 0.15 * k;
}

function handsBehind(pose, k) {
  pose.reach('left', 'hips', [0.05, 0.04, -0.15], [1, -0.4, -0.7], k, 0.4, true);
  pose.reach('right', 'hips', [0.05, 0.04, -0.15], [1, -0.4, -0.7], k, 0.4, true);
  pose.both('Shoulder', 0, 0.1, -0.02, k);
}

/** Piedi vicini (negativo) o larghi (positivo), in metri per piede. */
function feetWidth(pose, amount, k) {
  pose.feet.left.x += amount * k;
  pose.feet.right.x -= amount * k;
}

/** Ci si piega sui fianchi (l'inchino): il bacino arretra per restare in equilibrio. */
function bow(pose, amount) {
  pose.add('hips', 0.55 * amount, 0, 0);
  pose.add('spine', 0.25 * amount, 0, 0);
  pose.add('chest', 0.12 * amount, 0, 0);
  pose.add('head', 0.1 * amount, 0, 0);
  pose.hips.z -= 0.06 * amount;
}

// ------------------------------------------------------------------ modi
export const STANCES = {
  /** Com'e' sempre stata: peso che passa da una gamba all'altra, gesti spontanei. */
  standard: {
    label: 'Normale',
    sway: 1,
    phrases: [
      { hold: [10, 16] },
      {
        hold: [3.5, 4.5],
        /** Mano al mento, pensierosa, guardando di lato. */
        run(pose, k, p) {
          const on = curve(p, [[0, 0], [0.2, 1], [0.8, 1], [1, 0]]) * k;
          pose.reach(DOMINANT, 'head', [0.03, -0.1, 0.1], [1, -1, -0.2], on, 0.4, true);
          pose.fingers[DOMINANT] += 0.6 * on;
          pose.gaze.yaw += 0.35 * S * on;
          pose.gaze.pitch -= 0.12 * on;
          pose.gaze.weight += 0.7 * on;
          pose.add('head', 0, 0.1 * S * on, 0.05 * S * on);
        },
      },
    ],
  },

  /** Innocente: mani dietro la schiena, si dondola, testa inclinata; ogni tanto un dito alle labbra. */
  innocent: {
    label: 'Innocente',
    sway: 0.35,
    base(pose, k, t) {
      handsBehind(pose, k);
      feetWidth(pose, -0.015, k);
      // Si dondola da un piede all'altro: busto e testa si inclinano, il
      // ginocchio della gamba scarica si piega in avanti.
      const rock = Math.sin(t * 1.6);
      pose.hips.x += 0.024 * rock * k;
      pose.add('hips', 0, 0, -0.05 * rock * k);
      pose.add('spine', 0, 0, 0.05 * rock * k);
      pose.add('chest', 0, 0, 0.03 * rock * k);
      pose.add('head', 0.04 * k, 0, (0.08 * rock + 0.06 * Math.sin(t * 0.55)) * k);
      for (const side of ['left', 'right']) {
        const free = Math.max(0, side === 'left' ? -rock : rock) * k;
        pose.feet[side].z += 0.03 * free;
        pose.heel[side] += 0.35 * free;
      }
      pose.mood('happy', 0.25 * k);
    },
    phrases: [
      { hold: [8, 12] },
      {
        hold: [3, 4],
        run(pose, k, p) {
          const on = curve(p, [[0, 0], [0.2, 1], [0.8, 1], [1, 0]]) * k;
          pose.reach(DOMINANT, 'head', [0.02, -0.095, 0.1], [1, -1, -0.2], on, 0.3);
          pose.fingers[DOMINANT] += 1.1 * on;
          pose.point(DOMINANT, ['Index'], on);
          pose.add('head', 0.06 * on, 0, 0.06 * S * on);
          pose.gaze.pitch -= 0.1 * on;
        },
      },
    ],
  },

  /** Cool: mento su, peso su una gamba; mano sul fianco, poi braccia incrociate. */
  cool: {
    label: 'Cool',
    sway: 0.55,
    base(pose, k) {
      feetWidth(pose, 0.02, k);
      pose.add('head', -0.05 * k, 0, 0);
      pose.add('chest', -0.03 * k, 0, 0);
      pose.mood('relaxed', 0.15 * k);
    },
    phrases: [
      {
        hold: [6, 10],
        run(pose, k) {
          handOnHip(pose, DOMINANT, k);
          pose.hips.x += 0.018 * S * k;
          pose.add('hips', 0, 0, 0.04 * S * k);
        },
      },
      { hold: [5, 8], run: (pose, k) => armsCrossed(pose, k) },
    ],
  },

  /** Elegante: piedi uniti, schiena dritta, mani giunte davanti; sorriso a occhi chiusi. */
  ladylike: {
    label: 'Elegante',
    sway: 0.2,
    base(pose, k) {
      feetWidth(pose, -0.03, k);
      pose.add('chest', -0.04 * k, 0, 0);
      pose.add('head', 0.02 * k, 0, 0.05 * k);
      handsFront(pose, k, 0.02);
      pose.both('Shoulder', 0, 0, -0.04, k);
    },
    phrases: [
      { hold: [8, 12] },
      {
        hold: [3, 4],
        run(pose, k, p) {
          const on = curve(p, [[0, 0], [0.25, 1], [0.75, 1], [1, 0]]) * k;
          pose.add('head', 0.04 * on, 0, 0.1 * on);
          pose.mood('happy', 0.7 * on);
        },
      },
    ],
  },

  /** Timida: ginocchia unite, spalle chiuse, sguardo basso; pugno al petto, mano ai capelli, dita che si intrecciano. */
  shy: {
    label: 'Timida',
    sway: 0.3,
    base(pose, k, t) {
      feetWidth(pose, -0.025, k);
      pose.heel.left += 0.08 * k;
      pose.heel.right += 0.08 * k;
      pose.both('Shoulder', 0, 0.12, -0.05, k);
      pose.add('chest', 0.04 * k, 0, 0);
      pose.add('head', 0.1 * k, 0, 0.04 * Math.sin(t * 0.4) * k);
      pose.gaze.pitch += 0.12 * k;
      pose.gaze.yaw += 0.25 * S * (0.5 + 0.5 * Math.sin(t * 0.3)) * k;
      pose.gaze.weight += 0.4 * k;
    },
    phrases: [
      {
        hold: [4, 6],
        run(pose, k) {
          pose.reach(DOMINANT, 'upperChest', [0.02, -0.06, 0.13], [1, -1, 0], k, 0.4, true);
          pose.fingers[DOMINANT] += 1 * k;
          pose.add('head', 0, 0.12 * S * k, 0);
        },
      },
      {
        hold: [4, 6],
        run(pose, k, p, t) {
          pose.reach(DOMINANT, 'head', [0.085, 0.02 + 0.008 * Math.sin(t * 2.2), 0.06], [1, -0.7, 0.15], k, -0.3, true);
          pose.fingers[DOMINANT] += 0.2 * k;
          pose.add('head', 0, 0.15 * S * k, -0.08 * S * k);
        },
      },
      {
        hold: [5, 7],
        run(pose, k, p, t) {
          handsFront(pose, k, 0.05 + 0.01 * Math.sin(t * 3));
          pose.fingers.left += 0.3 * Math.sin(t * 2.7) * k;
          pose.fingers.right += 0.3 * Math.sin(t * 2.3 + 1) * k;
          pose.gaze.pitch -= 0.1 * k;
        },
      },
    ],
  },

  /** Energica: gambe larghe, petto in fuori, un piccolo rimbalzo; ogni tanto guarda lontano. */
  energetic: {
    label: 'Energica',
    sway: 1.2,
    base(pose, k, t) {
      feetWidth(pose, 0.045, k);
      pose.add('chest', -0.05 * k, 0, 0);
      pose.add('head', -0.03 * k, 0, 0);
      pose.hips.y -= 0.008 * Math.abs(Math.sin(t * 2.4)) * k;
      pose.both('UpperArm', 0, 0, 0.12, k);
      pose.mood('happy', 0.35 * k);
    },
    phrases: [
      { hold: [6, 9] },
      {
        hold: [3, 4],
        run(pose, k, p) {
          const on = curve(p, [[0, 0], [0.18, 1], [0.82, 1], [1, 0]]) * k;
          pose.reach(DOMINANT, 'head', [0.05, 0.07, 0.1], [1, -0.3, -0.4], on, 1.7);
          pose.side(OTHER, 'UpperArm', 0, -0.4, 0.4, on);
          pose.gaze.yaw += 0.5 * Math.sin(p * TAU) * S * on;
          pose.gaze.weight += on;
          pose.add('spine', 0.05 * on, 0.08 * S * on, 0);
          pose.heel.left += 0.2 * on;
          pose.heel.right += 0.2 * on;
        },
      },
    ],
  },

  /** Diva: di tre quarti, una gamba incrociata, mento alto; mano sul fianco, "ohoho", colpo di capelli. */
  flamboyant: {
    label: 'Diva',
    sway: 0.4,
    base(pose, k) {
      pose.rootYaw += 0.32 * -S * k;
      pose.feet[OTHER].z += 0.05 * k;
      pose.feet[OTHER].x -= 0.035 * k;
      pose.heel[OTHER] += 0.35 * k;
      pose.hips.x += 0.015 * S * k;
      pose.add('chest', -0.05 * k, 0, 0);
      pose.add('head', -0.06 * k, 0, 0);
      pose.gaze.weight += 0.6 * k;
      pose.mood('relaxed', 0.25 * k);
    },
    phrases: [
      { hold: [5, 8], run: (pose, k) => handOnHip(pose, DOMINANT, k) },
      {
        hold: [3, 4],
        run(pose, k) {
          pose.reach(DOMINANT, 'head', [0.04, -0.085, 0.11], [1, -1, -0.2], k, 1.4);
          pose.fingers[DOMINANT] -= 0.3 * k;
          handOnHip(pose, OTHER, k);
          pose.add('head', -0.04 * k, 0, 0);
          pose.mood('happy', 0.4 * k);
        },
      },
      {
        hold: [3, 4],
        run(pose, k, p) {
          const flip = curve(p, [[0, 0], [0.3, 1], [0.55, 1], [0.9, 0]]) * k;
          pose.reach(DOMINANT, 'head', [0.1, 0.01, -0.03], [1, -0.4, 0.3], flip, -0.3);
          pose.fingers[DOMINANT] -= 0.4 * flip;
          pose.add('head', -0.08 * flip, 0.1 * S * flip, -0.14 * S * flip);
        },
      },
    ],
  },

  /** Gentiluomo: composto, mani giunte davanti; ogni tanto un inchino con la mano sul cuore. */
  gentleman: {
    label: 'Gentiluomo',
    sway: 0.2,
    base(pose, k) {
      feetWidth(pose, -0.03, k);
      pose.add('chest', -0.03 * k, 0, 0);
      handsFront(pose, k, 0.07);
    },
    phrases: [
      { hold: [8, 12] },
      {
        hold: [3.6, 4.4],
        run(pose, k, p) {
          const hand = curve(p, [[0, 0], [0.15, 1], [0.85, 1], [1, 0]]) * k;
          const down = curve(p, [[0.15, 0], [0.35, 1], [0.6, 1], [0.8, 0]]) * k;
          pose.reach(DOMINANT, 'upperChest', [0.03, -0.06, 0.13], [1, -1, 0], hand, 0.8);
          pose.fingers[DOMINANT] -= 0.3 * hand;
          bow(pose, 0.8 * down);
          pose.gaze.weight -= 0.5 * down;
          pose.eyesClosed += 0.4 * down;
        },
      },
    ],
  },

  /** Potente: gambe larghe, petto in fuori; braccia incrociate, mani sui fianchi, pugno al cielo, dito puntato. */
  powerful: {
    label: 'Potente',
    sway: 0.45,
    base(pose, k) {
      feetWidth(pose, 0.055, k);
      pose.add('chest', -0.06 * k, 0, 0);
      pose.add('head', -0.05 * k, 0, 0);
      pose.both('Shoulder', 0, -0.06, 0.02, k);
    },
    phrases: [
      { hold: [5, 7], run: (pose, k) => armsCrossed(pose, k) },
      {
        hold: [5, 7],
        run(pose, k) {
          handOnHip(pose, 'left', k);
          handOnHip(pose, 'right', k);
        },
      },
      {
        hold: [2.5, 3.2],
        run(pose, k, p) {
          const up = curve(p, [[0, 0], [0.25, 1], [0.75, 1], [1, 0]]) * k;
          pose.reach(DOMINANT, 'head', [0.13, 0.32, 0.03], [1, 0, -0.4], up, 0.2);
          pose.fingers[DOMINANT] += 1.1 * up;
          handOnHip(pose, OTHER, up);
          pose.gaze.pitch -= 0.25 * up;
          pose.gaze.weight += up;
          pose.mood('happy', 0.5 * up);
        },
      },
      {
        hold: [3, 4],
        run(pose, k) {
          pose.reach(DOMINANT, 'upperChest', [0.2, -0.16, 0.36], [1, -1, -0.2], k, 0.2);
          pose.fingers[DOMINANT] += 1.1 * k;
          pose.point(DOMINANT, ['Index'], k);
          handOnHip(pose, OTHER, k);
          pose.gaze.weight += k;
        },
      },
    ],
  },
};

export const STANCE_NAMES = Object.keys(STANCES);

/**
 * Chi sta in piedi e come: il modo scelto sfuma in quello nuovo, e dentro il
 * modo le frasi si alternano, ognuna per qualche secondo.
 */
export class StanceMixer {
  constructor() {
    this.current = 'standard';
    this.weights = Object.fromEntries(STANCE_NAMES.map((name) => [name, name === 'standard' ? 1 : 0]));
    // Ogni modo ha le sue frasi: quando si cambia modo quelle vecchie sfumano, non scattano.
    this.phrases = Object.fromEntries(
      STANCE_NAMES.map((name) => {
        const list = STANCES[name].phrases ?? [];
        return [name, { index: 0, time: 0, hold: randomHold(list[0]), weights: list.map((_, i) => (i === 0 && name === 'standard' ? 1 : 0)) }];
      }),
    );
  }

  set(name) {
    if (!STANCES[name] || name === this.current) return;
    this.current = name;
    const state = this.phrases[name];
    state.index = 0;
    state.time = 0;
    state.hold = randomHold(STANCES[name].phrases?.[0]);
  }

  /** Quanto spostare il peso da una gamba all'altra, secondo i modi attivi. */
  get sway() {
    let total = 0;
    for (const name of STANCE_NAMES) total += this.weights[name] * (STANCES[name].sway ?? 1);
    return total;
  }

  /** Applica i modi (in piedi, peso `w`) alla posa del frame. */
  apply(pose, dt, t, w) {
    for (const name of STANCE_NAMES) {
      const def = STANCES[name];
      const active = name === this.current;
      this.weights[name] += ((active ? 1 : 0) - this.weights[name]) * Math.min(1, dt * 1.6);
      const list = def.phrases ?? [];
      const state = this.phrases[name];
      if (active && list.length) {
        state.time += dt;
        if (state.time >= state.hold) {
          state.index = (state.index + 1) % list.length;
          state.time = 0;
          state.hold = randomHold(list[state.index]);
        }
      }
      list.forEach((_, i) => {
        const target = active && i === state.index ? 1 : 0;
        state.weights[i] += (target - state.weights[i]) * Math.min(1, dt * 2.2);
      });

      const k = this.weights[name] * w;
      if (k < 1e-3 && !state.weights.some((value) => value > 1e-3)) continue;
      def.base?.(pose, k, t);
      const progress = clamp(state.time / state.hold, 0, 1);
      list.forEach((phrase, i) => {
        const weight = state.weights[i] * w;
        if (weight > 1e-3 && phrase.run) phrase.run(pose, weight, active && i === state.index ? progress : 1, t);
      });
    }
  }
}

function randomHold(phrase) {
  const [min, max] = phrase?.hold ?? [6, 9];
  return min + Math.random() * (max - min);
}
