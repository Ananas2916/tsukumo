/**
 * Gesti "da Photo Booth": ciao sbucando dal basso, la V, la pistola con le
 * dita, farsi vedere, la giravolta, le pose da modella, gli squat.
 *
 * Rifatti a mano guardando il Photo Booth di VRoid Hub fotogramma per
 * fotogramma (di fronte e di lato): nessun dato preso dalle loro animazioni,
 * solo il movimento osservato e riscritto con gli strumenti del corpo
 * procedurale (vedi body.js per le convenzioni sugli assi). Per questo si
 * adattano a qualunque avatar e restano mescolati al respiro e allo sguardo.
 *
 * Le coordinate delle mani sono scritte per il lato sinistro e specchiate
 * per il destro; `action.sign` sceglie la mano (-1 destra, +1 sinistra).
 */

import { curve, TAU } from './motion.js';

/** La mano del gesto e quella libera. */
function hands(action) {
  return action.sign > 0 ? ['left', 'right', 1] : ['right', 'left', -1];
}

/** Un piegamento sulle gambe: il bacino scende e arretra, le ginocchia vanno avanti (IK). */
function bend(pose, body, depth) {
  const height = body.hipsRest?.y ?? 0.9;
  pose.hips.y -= depth * height;
  pose.hips.z -= 0.35 * depth * height;
  // Il busto compensa in avanti per restare in equilibrio sui piedi.
  pose.add('spine', 0.5 * depth, 0, 0);
  pose.add('chest', 0.3 * depth, 0, 0);
  pose.add('head', -0.35 * depth, 0, 0);
}

export const BOOTH_ACTIONS = {
  /** Ciao sbucando dal basso: accovacciata, su di scatto salutando con due mani, poi con una. */
  greetPop: {
    duration: 6,
    modes: ['stand'],
    run(pose, u, w, t, action, body) {
      const [side, other, s] = hands(action);
      const crouch = curve(u, [[0, 0], [0.08, 1], [0.16, 1], [0.24, -0.04], [0.3, 0]]) * w;
      const both = curve(u, [[0.14, 0], [0.24, 1], [0.46, 1], [0.54, 0]]) * w;
      const one = curve(u, [[0.46, 0], [0.56, 1], [0.86, 1], [0.97, 0]]) * w;
      const lean = curve(u, [[0.48, 0], [0.6, 1], [0.84, 1], [0.96, 0]]) * w;
      const wiggle = Math.sin(t * 11);

      bend(pose, body, 0.5 * Math.max(0, crouch));
      pose.heel.left += 0.25 * Math.max(0, -crouch * 8) + 0.15 * both;
      pose.heel.right += 0.25 * Math.max(0, -crouch * 8) + 0.15 * both;
      // Accovacciata: mani sulle ginocchia.
      pose.reach('left', 'hips', [0.1, -0.36, 0.3], [1, -0.4, 0.4], Math.max(0, crouch), 0.4);
      pose.reach('right', 'hips', [0.1, -0.36, 0.3], [1, -0.4, 0.4], Math.max(0, crouch), 0.4);

      // Due mani aperte accanto al viso, palmi verso di te, che salutano.
      for (const hand of ['left', 'right']) {
        const k = hand === 'left' ? 1 : -1;
        pose.reach(hand, 'head', [0.19 + 0.025 * wiggle * k, -0.03, 0.1], [1, -0.8, -0.4], both, 1.2);
        pose.fingers[hand] -= 0.8 * both;
      }
      pose.add('head', 0, 0, 0.05 * Math.sin(t * 5.5) * both);

      // Poi una mano sola, alta, piegandosi verso di te.
      pose.reach(side, 'head', [0.14 + 0.035 * wiggle, 0.06, 0.08], [1, -0.6, -0.4], one, 1.2);
      pose.fingers[side] -= 0.8 * one;
      pose.side(other, 'UpperArm', 0, 0, 0.35, one);
      pose.side(other, 'LowerArm', 0, -0.2, 0, one);
      // Tutto il corpo si sporge verso di te, dalle caviglie e dai fianchi.
      pose.hips.z += 0.035 * lean;
      pose.add('hips', 0.12 * lean, 0, 0);
      pose.add('spine', 0.14 * lean, 0, 0.06 * s * lean);
      pose.add('chest', 0.1 * lean, 0, 0);
      pose.add('head', -0.2 * lean, 0, -0.1 * s * lean);
      pose.hips.x -= 0.02 * s * lean;
      pose.feet[other].x += 0.02 * (other === 'left' ? 1 : -1) * lean;
      pose.heel[other] += 0.25 * lean;

      pose.gaze.weight += 0.6 * (both + one);
      pose.mood('happy', 0.55 * Math.max(both, one));
    },
  },

  /** La V accanto all'occhio, testa inclinata, un piede sollevato all'indietro. */
  peace: {
    duration: 4.6,
    modes: ['stand'],
    run(pose, u, w, t, action) {
      const [side, other, s] = hands(action);
      const k = curve(u, [[0, 0], [0.16, 1], [0.84, 1], [1, 0]]) * w;
      const bounce = Math.sin(t * 3.2) * k;

      // Polso all'altezza della guancia, di lato: le dita tese arrivano all'occhio.
      pose.reach(side, 'head', [0.145, -0.02 + 0.006 * bounce, 0.075], [0.5, -1, 0], k, 2.8);
      pose.fingers[side] += 1.1 * k;
      pose.point(side, ['Index', 'Middle'], k);
      pose.spread[side] += k;
      pose.add('head', 0, 0.06 * s * k, -0.16 * s * k);
      pose.add('neck', 0, 0, -0.05 * s * k);
      pose.add('spine', 0, 0.05 * s * k, 0.04 * s * k);

      // Braccio libero morbido in fuori, mano aperta.
      pose.side(other, 'UpperArm', 0, 0, 0.3, k);
      pose.side(other, 'LowerArm', 0, -0.35, 0, k);
      pose.fingers[other] -= 0.4 * k;

      // Peso sulla gamba del lato della V, l'altra piegata col piede dietro.
      pose.hips.x += 0.018 * s * k;
      pose.feet[other].y += 0.1 * k;
      pose.feet[other].z -= 0.1 * k;
      pose.feet[other].x += 0.02 * (other === 'left' ? -1 : 1) * k;
      pose.heel[other] += 0.7 * k;
      pose.hips.y -= 0.006 * (1 + bounce) * k;

      pose.gaze.weight += k;
      pose.mood('happy', 0.45 * k);
    },
  },

  /** La pistola con le dita: mira a te, "bang", poi soffia via il fumo. */
  shoot: {
    duration: 5,
    modes: ['stand', 'sit'],
    run(pose, u, w, t, action) {
      const [side, other, s] = hands(action);
      const aim = curve(u, [[0, 0], [0.12, 1], [0.36, 1], [0.46, 0]]) * w;
      const recoil = curve(u, [[0.2, 0], [0.225, 1], [0.3, 0]]) * w;
      const blow = curve(u, [[0.38, 0], [0.5, 1], [0.8, 1], [0.95, 0]]) * w;
      const puff = curve(u, [[0.52, 0], [0.58, 1], [0.68, 1], [0.74, 0]]) * w;

      // Braccio teso verso di te all'altezza della spalla.
      pose.reach(side, 'upperChest', [0.1, 0.1 + 0.08 * recoil, 0.46 - 0.05 * recoil], [1, -1, -0.2], aim, 0.1);
      pose.add('spine', 0, 0.12 * s * aim, 0);
      pose.add('chest', -0.03 * recoil, 0.06 * s * aim, 0);
      pose.add('head', -0.06 * recoil, 0, 0.05 * s * aim);
      // Il dito davanti alle labbra, per soffiare.
      pose.reach(side, 'head', [0.03, -0.075, 0.12], [1, -1, -0.2], blow, 0.2);
      pose.add('head', 0.04 * blow, 0, -0.08 * s * blow);

      const gun = Math.max(aim, blow);
      pose.fingers[side] += 1.1 * gun;
      pose.point(side, ['Index'], gun);
      pose.point(side, ['Thumb'], aim);
      pose.side(other, 'UpperArm', 0, 0, 0.1, gun);

      pose.mouthOpen += 0.35 * puff;
      pose.eyesClosed += 0.5 * puff;
      pose.gaze.weight += gun;
      pose.mood('happy', 0.6 * aim + 0.4 * blow);
    },
  },

  /** Si mette in mostra: braccia aperte ad A, gira piano il corpo da una parte e dall'altra. */
  showOff: {
    duration: 8,
    modes: ['stand'],
    run(pose, u, w, t, action) {
      const s = action.sign;
      const k = curve(u, [[0, 0], [0.1, 1], [0.9, 1], [1, 0]]) * w;
      const turn = curve(u, [[0.08, 0], [0.3, 0.65], [0.42, 0.65], [0.66, -0.65], [0.78, -0.65], [0.94, 0]]) * s;
      const step = Math.abs(turn) / 0.65;

      pose.both('UpperArm', 0, 0.1, 0.58, k);
      pose.both('LowerArm', 0, -0.12, 0, k);
      pose.both('Hand', 0, 0, 0.1, k);
      pose.fingers.left -= 0.35 * k;
      pose.fingers.right -= 0.35 * k;
      pose.rootYaw += turn * k;
      // Girandosi un piede incrocia davanti all'altro, sulla punta.
      const front = turn * s > 0 ? 'right' : 'left';
      pose.feet[front].z += 0.05 * step * k;
      pose.feet[front].x += 0.05 * (front === 'left' ? -1 : 1) * step * k;
      pose.heel[front] += 0.35 * step * k;
      pose.gaze.weight += k;
      pose.mood('happy', 0.5 * k);
    },
  },

  /** Giravolta: caricamento a braccia incrociate, un giro intero, "ta-da" con una mano alzata. */
  spin: {
    duration: 4.8,
    modes: ['stand'],
    run(pose, u, w, t, action, body) {
      const [side, other, s] = hands(action);
      const wind = curve(u, [[0, 0], [0.14, 1], [0.24, 1], [0.34, 0]]) * w;
      const turn = curve(u, [[0.2, 0], [0.54, 1]]);
      const toes = curve(u, [[0.22, 0], [0.3, 1], [0.5, 1], [0.58, 0]]) * w;
      const tada = curve(u, [[0.5, 0], [0.6, 1], [0.84, 1], [0.97, 0]]) * w;

      // Caricamento: busto girato indietro, braccia strette al petto.
      // Un giro intero e' di nuovo di fronte: finito il giro l'angolo torna a
      // zero invece di scalare col peso (svolgerebbe il giro all'indietro).
      const around = turn >= 1 ? 0 : TAU * turn;
      pose.rootYaw += (-0.55 * wind + around) * -s;
      pose.reach('left', 'upperChest', [-0.06, -0.04, 0.14], [1, -1, -0.2], wind, 0.8);
      pose.reach('right', 'upperChest', [-0.06, -0.04, 0.14], [1, -1, -0.2], wind, 0.8);
      bend(pose, body, 0.05 * wind);
      // Durante il giro sulle punte, braccia un po' aperte.
      pose.heel.left += 0.45 * toes;
      pose.heel.right += 0.45 * toes;
      pose.both('UpperArm', 0, 0, 0.45, toes * (1 - wind));

      // Ta-da: una mano alta accanto alla testa, l'altra aperta in basso, un piede in punta.
      pose.reach(side, 'head', [0.15, 0.1, 0.03], [1, -0.4, -0.5], tada, 1.3);
      pose.fingers[side] -= 0.6 * tada;
      pose.side(other, 'UpperArm', 0, 0.2, 0.55, tada);
      pose.side(other, 'LowerArm', 0, -0.15, 0, tada);
      pose.fingers[other] -= 0.5 * tada;
      pose.feet[other].z += 0.05 * tada;
      pose.feet[other].x += 0.03 * (other === 'left' ? -1 : 1) * tada;
      pose.heel[other] += 0.5 * tada;
      pose.hips.x += 0.015 * s * tada;
      pose.add('head', 0, 0, -0.12 * s * tada);
      pose.add('spine', 0, 0, 0.05 * s * tada);

      pose.gaze.weight += tada;
      pose.mood('happy', 0.5 * tada + 0.3 * toes);
    },
  },

  /** Pose da modella: tre quarti, mano che presenta, mano sul fianco, mano tra i capelli. */
  model: {
    duration: 9,
    modes: ['stand'],
    run(pose, u, w, t, action) {
      const [side, other, s] = hands(action);
      const p1 = curve(u, [[0, 0], [0.07, 1], [0.24, 1], [0.3, 0]]) * w;
      const p2 = curve(u, [[0.25, 0], [0.32, 1], [0.48, 1], [0.54, 0]]) * w;
      const p3 = curve(u, [[0.5, 0], [0.57, 1], [0.94, 1], [1, 0]]) * w;
      const p4 = curve(u, [[0.72, 0], [0.79, 1], [0.93, 1], [0.99, 0]]) * w;

      // 1. Di tre quarti, peso su una gamba, ginocchio dell'altra verso l'interno.
      pose.rootYaw += 0.4 * s * p1;
      pose.hips.x += 0.02 * s * p1;
      pose.feet[other].z += 0.04 * p1;
      pose.feet[other].x += 0.03 * (other === 'left' ? -1 : 1) * p1;
      pose.heel[other] += 0.35 * p1;
      pose.add('head', 0.03 * p1, -0.25 * s * p1, -0.1 * s * p1);

      // 2. Di fronte, una mano che presenta, palmo in su.
      pose.reach(side, 'hips', [0.19, 0.14, 0.24], [1, -1, -0.4], p2, 1.6);
      pose.fingers[side] -= 0.5 * p2;
      pose.add('head', 0, 0, 0.08 * s * p2);

      // 3. Mano sul fianco, gomito in fuori, anca in fuori.
      pose.reach(side, 'hips', [0.17, 0.05, -0.01], [1, 0.1, -0.8], p3, -0.3);
      pose.fingers[side] += 0.2 * p3;
      pose.hips.x += 0.022 * s * p3;
      pose.add('hips', 0, 0, 0.05 * s * p3);
      pose.feet[other].z += 0.03 * p3;
      pose.heel[other] += 0.2 * p3;

      // 4. L'altra mano tra i capelli, testa inclinata.
      pose.reach(other, 'head', [0.1, -0.03, 0.0], [1, -1, 0.1], p4, -0.2);
      pose.fingers[other] -= 0.4 * p4;
      pose.add('head', 0.04 * p4, 0.05 * -s * p4, 0.12 * s * p4);

      pose.gaze.weight += Math.max(p1, p2, p3);
      pose.mood('relaxed', 0.5 * w);
      pose.mood('happy', 0.3 * (p2 + p4));
    },
  },

  /** Squat: braccia incrociate, poi aperte a T, due piegamenti, e ci si scioglie. */
  squat: {
    duration: 8,
    modes: ['stand'],
    run(pose, u, w, t, action, body) {
      const cross = curve(u, [[0, 0], [0.08, 1], [0.2, 1], [0.27, 0]]) * w;
      const arms = curve(u, [[0.22, 0], [0.3, 1], [0.84, 1], [0.93, 0]]) * w;
      const down = curve(u, [[0.32, 0], [0.42, 1], [0.48, 1], [0.56, 0], [0.64, 1], [0.7, 1], [0.8, 0]]) * w;

      // Braccia incrociate sul petto.
      pose.reach('left', 'upperChest', [-0.08, -0.08, 0.15], [1, -0.8, 0], cross, 0.6);
      pose.reach('right', 'upperChest', [-0.08, -0.1, 0.12], [1, -0.8, 0], cross, 0.6);
      // Braccia aperte, dritte, palmi in giu'.
      pose.both('UpperArm', 0, 0, 1.2, arms);
      pose.both('LowerArm', 0, 0.05, 0, arms);
      pose.fingers.left -= 0.5 * arms;
      pose.fingers.right -= 0.5 * arms;
      bend(pose, body, 0.22 * down);
      pose.both('UpperArm', 0, 0.35, 0, down);
      pose.gaze.weight += 0.6 * w;
      pose.mood('happy', 0.3 * arms);
    },
  },
};
