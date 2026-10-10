/**
 * Spontaneous actions and speech gestures (see body.js for the axis conventions).
 */

import { BOOTH_ACTIONS } from './booth.js';
import { SIDES } from './constants.js';
import { curve, TAU } from './motion.js';

/**
 * Actions: fixed-length movements layered over the posture. `run` receives
 * the pose, the progress `u` (0..1), the weight, the elapsed time in
 * seconds, the action and the body. `idle` (draw weight) makes them
 * candidates as spontaneous gestures; `modes` says in which body modes they
 * make sense.
 */
export const ACTIONS = {
  /** Stretches: arms to the sky, on tiptoe, eyes closed. */
  stretch: {
    duration: 4,
    idle: 1,
    modes: ['stand', 'sit'],
    run(pose, u, w) {
      const up = curve(u, [[0, 0], [0.3, 1], [0.64, 1], [0.94, 0]]) * w;
      const peak = curve(u, [[0.2, 0], [0.36, 1], [0.6, 1], [0.76, 0]]) * w;
      // Arms in a V rather than straight up: everything stays inside the frame.
      pose.reach('left', 'head', [0.13, 0.3, 0.02], [1, 0.2, -0.4], up);
      pose.reach('right', 'head', [0.13, 0.3, 0.02], [1, 0.2, -0.4], up);
      pose.both('Hand', 0, 0, 0.35, up);
      pose.fingers.left -= 0.7 * up;
      pose.fingers.right -= 0.7 * up;
      pose.add('spine', -0.05 * up, 0, 0);
      pose.add('chest', -0.07 * up, 0, 0);
      pose.add('upperChest', -0.05 * up, 0, 0);
      pose.add('neck', -0.08 * up, 0, 0);
      pose.add('head', -0.14 * up, 0, 0.05 * peak);
      pose.heel.left += 0.3 * peak;
      pose.heel.right += 0.3 * peak;
      pose.mood('happy', 0.75 * peak);
    },
  },

  /** Looks around: first to one side, then to the other. */
  lookAround: {
    duration: 4.8,
    idle: 1.4,
    modes: ['stand', 'sit', 'lie', 'side', 'edge'],
    run(pose, u, w, t, action, body) {
      const s = action.sign;
      const yaw = curve(u, [[0, 0], [0.14, 0.7], [0.38, 0.62], [0.54, -0.6], [0.8, -0.66], [0.96, 0]]) * s;
      const pitch = curve(u, [[0, 0], [0.14, 0.06], [0.38, -0.08], [0.54, 0.04], [0.8, 0.1], [0.96, 0]]);
      const on = curve(u, [[0, 0], [0.08, 1], [0.9, 1], [1, 0]]) * w;
      pose.gaze.yaw += yaw * on;
      pose.gaze.pitch += pitch * on;
      pose.gaze.weight += on;
      pose.add('spine', 0, 0.12 * yaw * on, 0);
      if (body.mode === 'stand') pose.add('hips', 0, 0.05 * yaw * on, 0);
      pose.mood('relaxed', 0.2 * on);
    },
  },

  /** Tucks her hair behind the ear, tilting the head towards the hand. */
  hairTuck: {
    duration: 3.2,
    idle: 1.2,
    modes: ['stand', 'sit'],
    run(pose, u, w, t, action) {
      const side = action.sign > 0 ? 'left' : 'right';
      const s = action.sign;
      const up = curve(u, [[0, 0], [0.28, 1], [0.66, 1], [0.92, 0]]) * w;
      const tuck = curve(u, [[0.3, 0], [0.56, 1], [0.7, 1]]);
      pose.reach(side, 'head', [0.085, 0.035 - 0.015 * tuck, 0.06 - 0.075 * tuck], [1, -0.7, 0.15], up, -0.3);
      pose.side(side, 'Hand', 0, 0, -0.25, up);
      pose.fingers[side] -= 0.5 * up;
      pose.side(side, 'Shoulder', 0, 0, 0.1, up);
      pose.add('head', 0.04 * up, 0.06 * s * up, -0.14 * s * up);
      pose.add('neck', 0, 0, -0.05 * s * up);
      pose.mood('relaxed', 0.4 * up);
    },
  },

  /** Hands behind the back, gently rocking on the heels. */
  handsBehind: {
    duration: 6.5,
    idle: 1,
    modes: ['stand'],
    run(pose, u, w, t) {
      const on = curve(u, [[0, 0], [0.15, 1], [0.85, 1], [1, 0]]) * w;
      const rock = Math.sin(t * TAU * 0.5) * on;
      pose.reach('left', 'hips', [0.05, 0.04, -0.15], [1, -0.4, -0.7], on, 0.4);
      pose.reach('right', 'hips', [0.05, 0.04, -0.15], [1, -0.4, -0.7], on, 0.4);
      pose.both('Shoulder', 0, 0.1, -0.02, on);
      pose.add('chest', -0.05 * on, 0, 0);
      pose.hips.z += 0.012 * rock;
      pose.heel.left += 0.14 * Math.max(0, rock);
      pose.heel.right += 0.14 * Math.max(0, rock);
      pose.add('head', -0.02 * rock, 0, 0.06 * Math.sin(t * TAU * 0.25) * on);
      pose.mood('relaxed', 0.35 * on);
    },
  },

  /** Hums: sways in time, the head following, smiling with closed eyes. */
  hum: {
    duration: 5.5,
    idle: 1,
    modes: ['stand', 'sit'],
    run(pose, u, w, t, action, body) {
      const on = curve(u, [[0, 0], [0.12, 1], [0.86, 1], [1, 0]]) * w;
      const beat = Math.sin(t * TAU * 0.8) * on;
      const bounce = Math.abs(Math.sin(t * TAU * 0.8)) * on;
      // Sitting, the pelvis stays put: only the torso sways.
      if (body.mode === 'stand') {
        pose.hips.x += 0.02 * beat;
        pose.hips.y -= 0.006 * bounce;
        pose.add('hips', 0, 0, -0.04 * beat);
      }
      pose.add('spine', 0, 0, 0.05 * beat);
      pose.add('neck', 0, 0, 0.04 * beat);
      pose.add('head', 0, 0.05 * beat, 0.1 * beat);
      pose.both('UpperArm', 0, 0, 0.06 * bounce);
      pose.mood('happy', 0.45 * on);
    },
  },

  /** Tilts the head, curious. */
  headTilt: {
    duration: 2.8,
    idle: 1.2,
    modes: ['stand', 'sit', 'lie', 'side', 'edge'],
    run(pose, u, w, t, action) {
      const s = action.sign;
      const on = curve(u, [[0, 0], [0.22, 1], [0.72, 1], [1, 0]]) * w;
      pose.add('head', 0.03 * on, 0.08 * s * on, 0.22 * s * on);
      pose.add('neck', 0, 0, 0.06 * s * on);
      pose.add('upperChest', 0, 0, -0.03 * s * on);
      pose.mood('surprised', 0.15 * on);
    },
  },

  /** Sitting: swings her legs harder, happy. */
  swingLegs: {
    duration: 4.5,
    idle: 1.3,
    modes: ['sit'],
    run(pose, u, w, t) {
      const on = curve(u, [[0, 0], [0.12, 1], [0.85, 1], [1, 0]]) * w;
      for (const side of SIDES) {
        const phase = Math.sin(t * TAU * 1.1 + (side === 'left' ? 0 : Math.PI));
        pose.side(side, 'LowerLeg', 0.45 * phase, 0, 0, on);
        pose.side(side, 'Foot', 0.2 * phase, 0, 0, on);
      }
      pose.add('head', 0.04 * Math.sin(t * TAU * 1.1) * on, 0, 0.06 * Math.sin(t * TAU * 0.55) * on);
      pose.mood('happy', 0.4 * on);
    },
  },

  /** Yawns: hand in front of the mouth, head back, eyes closed. When drowsy. */
  yawn: {
    duration: 3.4,
    modes: ['stand', 'sit'],
    run(pose, u, w, t, action) {
      const side = action.sign > 0 ? 'left' : 'right';
      const s = action.sign;
      const open = curve(u, [[0, 0], [0.2, 0.35], [0.42, 1], [0.66, 1], [0.86, 0]]) * w;
      const hand = curve(u, [[0.08, 0], [0.3, 1], [0.72, 1], [0.92, 0]]) * w;
      // The target is the wrist: under the chin, so the fingers cover the mouth.
      pose.reach(side, 'head', [0.02, -0.07, 0.13], [1, -1, -0.2], hand, 0.4);
      pose.fingers[side] -= 0.5 * hand;
      pose.add('head', -0.18 * open, 0, 0.07 * s * open);
      pose.add('neck', -0.06 * open, 0, 0);
      pose.add('upperChest', -0.04 * open, 0, 0);
      pose.both('Shoulder', 0, 0, 0.1, open);
      pose.eyesClosed = Math.max(pose.eyesClosed, 0.95 * open);
      pose.mouthOpen = Math.max(pose.mouthOpen, 0.85 * open);
      pose.mood('relaxed', 0.3 * open);
    },
  },

  /** Knocks on the screen glass, towards you: reminders and notifications. */
  knock: {
    duration: 1.9,
    // A reaction: the voice starting right after doesn't interrupt it.
    reaction: true,
    modes: ['stand', 'sit'],
    run(pose, u, w, t, action) {
      const side = action.sign > 0 ? 'left' : 'right';
      const s = action.sign;
      const up = curve(u, [[0, 0], [0.22, 1], [0.72, 1], [0.95, 0]]) * w;
      // Two knocks: the fist goes forward and back (u 0.30 and 0.40, i.e. ~0.55 s and ~0.75 s).
      const tap = (curve(u, [[0.26, 0], [0.3, 1], [0.34, 0]]) + curve(u, [[0.36, 0], [0.4, 1], [0.44, 0]])) * w;
      pose.reach(side, 'head', [0.1, 0.0, 0.34 + 0.05 * tap], [1, -1, -0.1], up, 0.3);
      pose.fingers[side] += 0.9 * up;
      pose.side(side, 'Hand', -0.25, 0, 0, up);
      pose.add('spine', 0.04 * up, 0, 0);
      pose.add('head', 0.04 * up, 0.04 * s * up, -0.06 * s * up);
      pose.mood('happy', 0.5 * up);
    },
  },

  /** So hot: she fans herself with her hand in front of her face. */
  fanSelf: {
    duration: 3.4,
    modes: ['stand', 'sit'],
    run(pose, u, w, t, action) {
      const side = action.sign > 0 ? 'left' : 'right';
      const s = action.sign;
      const up = curve(u, [[0, 0], [0.15, 1], [0.85, 1], [1, 0]]) * w;
      const flap = Math.sin(t * TAU * 3.2) * curve(u, [[0.12, 0], [0.2, 1], [0.8, 1], [0.88, 0]]);
      pose.reach(side, 'head', [0.13, -0.1, 0.15], [1, -1, -0.2], up, 0.6);
      pose.side(side, 'Hand', 0.35 * flap, 0, 0, up);
      pose.fingers[side] -= 0.7 * up;
      pose.add('head', -0.06 * up, -0.05 * s * up, 0.05 * s * up);
      pose.add('chest', -0.03 * up, 0, 0);
      pose.eyesClosed = Math.max(pose.eyesClosed, 0.35 * up);
      pose.mood('sad', 0.3 * up);
      pose.mood('relaxed', 0.3 * up);
    },
  },

  /** So cold: she hugs her arms and shivers. */
  shiver: {
    duration: 3.2,
    modes: ['stand', 'sit'],
    run(pose, u, w, t) {
      const hug = curve(u, [[0, 0], [0.15, 1], [0.85, 1], [1, 0]]) * w;
      const tremble = Math.sin(t * TAU * 9) * hug;
      // Each hand on the opposite arm (negative x = towards the other side).
      pose.reach('left', 'upperChest', [-0.03, -0.04, 0.12], [1, -0.6, -0.3], hug, 1.3);
      pose.reach('right', 'upperChest', [-0.03, -0.07, 0.15], [1, -0.6, -0.3], hug, 1.3);
      pose.fingers.left += 0.3 * hug;
      pose.fingers.right += 0.3 * hug;
      pose.both('Shoulder', 0, 0, 0.14, hug);
      pose.add('spine', 0.05 * hug, 0, 0.012 * tremble);
      pose.add('chest', 0.03 * hug, 0, 0);
      pose.add('head', 0.08 * hug, 0.02 * tremble, 0.015 * tremble);
      pose.mood('sad', 0.45 * hug);
      pose.mood('surprised', 0.2 * hug);
    },
  },

  /** You spun the cursor around her: her head spins. */
  dizzy: {
    duration: 2.8,
    reaction: true,
    modes: ['stand', 'sit'],
    run(pose, u, w, t, action) {
      const side = action.sign > 0 ? 'left' : 'right';
      const on = curve(u, [[0, 0], [0.08, 1], [0.7, 1], [1, 0]]) * w;
      const spin = curve(u, [[0, 1], [0.7, 0.6], [1, 0.2]]);
      const phase = t * TAU * 1.3;
      pose.add('head', 0.12 * Math.cos(phase) * spin * on, 0.18 * Math.sin(phase) * spin * on, 0.14 * Math.cos(phase) * spin * on);
      pose.add('neck', 0, 0, 0.05 * Math.cos(phase) * spin * on);
      pose.add('spine', 0, 0, 0.05 * Math.sin(phase + 0.8) * spin * on);
      pose.hips.x += 0.015 * Math.sin(phase + 0.8) * spin * on;
      pose.reach(side, 'head', [0.06, 0.07, 0.11], [1, -0.8, 0.2], on, -0.4);
      pose.fingers[side] -= 0.3 * on;
      pose.eyesClosed = Math.max(pose.eyesClosed, 0.45 * on);
      pose.mood('surprised', 0.35 * on);
      pose.mood('sad', 0.2 * on);
      pose.gaze.pitch -= 0.1 * on;
      pose.gaze.yaw += 0.3 * Math.sin(phase) * on;
      pose.gaze.weight += on;
    },
  },

  /** Too many pokes: she folds her arms, turns her head away and sulks. */
  pout: {
    duration: 3.4,
    reaction: true,
    modes: ['stand', 'sit'],
    run(pose, u, w, t, action) {
      const s = action.sign;
      const on = curve(u, [[0, 0], [0.12, 1], [0.82, 1], [1, 0]]) * w;
      pose.reach('left', 'upperChest', [-0.02, -0.13, 0.14], [1, -0.5, -0.4], on, 1.3);
      pose.reach('right', 'upperChest', [-0.02, -0.1, 0.18], [1, -0.5, -0.4], on, 1.3);
      pose.fingers.left += 0.4 * on;
      pose.fingers.right += 0.4 * on;
      pose.add('spine', 0, 0.08 * s * on, 0);
      pose.add('head', -0.08 * on, 0.1 * s * on, -0.05 * s * on);
      pose.gaze.yaw += 0.55 * s * on;
      pose.gaze.pitch -= 0.05 * on;
      pose.gaze.weight += on;
      pose.mood('angry', 0.85 * on);
    },
  },

  /** Waves her hand: starts when the model appears. */
  wave: {
    duration: 2.9,
    modes: ['stand', 'sit'],
    run(pose, u, w, t, action) {
      const side = action.sign > 0 ? 'left' : 'right';
      const s = action.sign;
      const up = curve(u, [[0, 0], [0.18, 1], [0.8, 1], [1, 0]]) * w;
      const swing = Math.sin(t * TAU * 2.1) * curve(u, [[0.15, 0], [0.25, 1], [0.75, 1], [0.85, 0]]);
      pose.reach(side, 'head', [0.27 + 0.05 * swing, 0.1, 0.06], [0.7, -1.4, 0.1], up, -0.9);
      pose.side(side, 'Hand', 0, 0.12 * swing, 0.15, up);
      pose.fingers[side] -= 0.8 * up;
      pose.add('head', 0, 0.05 * s * up, -0.1 * s * up);
      pose.add('spine', 0, 0, -0.03 * s * up);
      pose.mood('happy', 0.8 * up);
    },
  },

  /** Pat on the head: she snuggles up, happy. */
  pat: {
    duration: 1.9,
    reaction: true,
    modes: ['stand', 'sit', 'lie', 'side'],
    run(pose, u, w, t, action, body) {
      const on = curve(u, [[0, 0], [0.12, 1], [0.72, 1], [1, 0]]) * w;
      pose.add('head', 0.15 * on, 0, 0.05 * Math.sin(t * TAU * 1.5) * on);
      pose.add('neck', 0.06 * on, 0, 0);
      pose.add('spine', 0.04 * on, 0, 0);
      pose.both('Shoulder', 0, 0, 0.09, on);
      // Hands joined in front, a little shy (lying down they stay where they are).
      if (body.mode !== 'lie' && body.mode !== 'side') {
        pose.reach('left', 'hips', [-0.02, 0.02, 0.16], [1, -1, 0], 0.7 * on, 0.3);
        pose.reach('right', 'hips', [-0.02, 0.02, 0.16], [1, -1, 0], 0.7 * on, 0.3);
      }
      if (body.mode === 'stand') pose.hips.y -= 0.01 * on;
      pose.mood('happy', 0.95 * on);
    },
  },

  /** Touched on the body: she jumps back, then composes herself. */
  flinch: {
    duration: 1.3,
    reaction: true,
    modes: ['stand', 'sit'],
    run(pose, u, w, t, action, body) {
      const jolt = curve(u, [[0, 0], [0.08, 1], [0.35, 0.75], [1, 0]]) * w;
      const face = curve(u, [[0, 0], [0.06, 1], [0.6, 0.6], [1, 0]]) * w;
      pose.add('spine', -0.1 * jolt, 0, 0);
      pose.add('chest', -0.06 * jolt, 0, 0);
      pose.add('head', -0.06 * jolt, 0, 0);
      if (body.mode === 'stand') pose.hips.z -= 0.02 * jolt;
      pose.both('UpperArm', -0.3, 0, 0.35, jolt);
      pose.both('LowerArm', 0, -0.7, 0, jolt);
      pose.fingers.left -= 0.6 * jolt;
      pose.fingers.right -= 0.6 * jolt;
      pose.mood('surprised', 0.9 * face);
    },
  },
};

// Peek-a-boo hello, the V, the finger gun, twirl, model poses, squat (booth.js).
Object.assign(ACTIONS, BOOTH_ACTIONS);

/**
 * Gestures while she speaks, chosen at every sentence. Coordinates are for
 * the left side and mirrored for the right.
 */
export const GESTURES = {
  explainLeft: [{ side: 'left', offset: [0.14, -0.2, 0.22], pole: [0.5, -1, -0.4], twist: 1.5 }],
  explainRight: [{ side: 'right', offset: [0.14, -0.2, 0.22], pole: [0.5, -1, -0.4], twist: 1.5 }],
  open: [
    { side: 'left', offset: [0.2, -0.17, 0.2], pole: [0.8, -1, -0.3], twist: 1.4 },
    { side: 'right', offset: [0.2, -0.17, 0.2], pole: [0.8, -1, -0.3], twist: 1.4 },
  ],
  // The target is the wrist: the fingers reach ~15 cm further, onto the heart.
  chest: [{ side: 'right', offset: [0.02, -0.05, 0.12], pole: [0.9, -1, -0.1], twist: 0.6 }],
};
