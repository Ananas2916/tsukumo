/**
 * The flame's gestures made of curves: only data, no three.js, so they can
 * be tested with node (tests/test_flame_motion.py). How the curves read is
 * explained in flame/motion.js.
 */

import { chain, hop, wait } from './motion.js';

const TAU = Math.PI * 2;

/**
 * Gestures made of curves (flame/motion.js): she winds up, snaps, arrives a
 * touch beyond and comes back, then holds a moment so it reads. Channels:
 * `y` jump, `sq` squash (volume is kept), `spin`, `tilt`, `bend` (the tip),
 * `glow`, `es` (eyes), `mouth`, `gx`/`gy` (gaze), the accessories `glasses`,
 * `sweat`, `bang`. Landings are squashed by the contact spring (Squash).
 * The rest (which eyes she makes, the little figures) is in update()'s switch.
 */
export const MOVES = {
  flinch: () => ({
    sq: [1, [0.78, 60, 'out'], [1.12, 110, 'out'], [0.96, 120], [1, 180, 'back']],
    es: [1, [0.8, 60, 'out'], [1, 280, 'back']],
  }),
  pat: () => ({
    sq: [1, [0.84, 150, 'out'], [0.84, 220, 'lin'], [1.08, 160, 'out'], [1, 260, 'back']],
    glow: [0, [0.35, 150, 'out'], [0.35, 380, 'lin'], [0, 300]],
    blush: [0, [0.9, 150, 'out'], [0.9, 380, 'lin'], [0, 300]],
  }),
  pout: () => ({
    sq: [1, [0.92, 120, 'out'], [1.04, 160, 'out'], [1, 220, 'back']],
    tilt: [0, [-0.18, 280, 'back'], [-0.18, 1600, 'lin'], [0, 320]],
  }),
  // Greets: a hop, and the tip waves "hi" like a little hand.
  greet: () =>
    chain(
      {},
      {
        ...hop(0.22, { crouch: 0.12, prep: 100, up: 230, down: 200 }),
        bend: [[0.75, 140, 'out'], [-0.6, 150], [0.6, 150], [-0.45, 150], [0.3, 140], [0, 200, 'back']],
        es: [[1.15, 120, 'out'], [1, 420, 'back']],
        glow: [[0.4, 150, 'out'], [0.4, 600, 'lin'], [0, 300]],
        blush: [[0.5, 150, 'out'], [0.5, 600, 'lin'], [0, 300]],
      },
    ),
  // Looks around: goes, stops, goes the other way, stops.
  look: () => ({
    gx: [0, [-0.9, 260], [-0.9, 420, 'lin'], [0.9, 380], [0.9, 340, 'lin'], [0, 200]],
    gy: [0, [0.12, 260], [0.12, 1140, 'lin'], [0, 200]],
    tilt: [0, [0.08, 260], [0.08, 420, 'lin'], [-0.08, 380], [-0.08, 340, 'lin'], [0, 200]],
  }),
  yawn: () => ({
    sq: [1, [1.14, 600], [1.14, 250, 'lin'], [0.94, 300], [1, 300, 'back']],
    mouth: [0, [1, 600], [1, 250, 'lin'], [0, 300]],
    tilt: [0, [0.1, 600], [0.1, 250, 'lin'], [0, 500]],
  }),
  land: () => ({ es: [1, [0.8, 60, 'out'], [1, 300, 'back']] }),
  // Hearts: a short wind-up, the eyes "burst" into hearts, then she sways blissfully.
  hearts: () =>
    chain(
      {},
      { sq: [[0.9, 120, 'out']], es: [[0.7, 120, 'out']] },
      { ...hop(0.1, { crouch: 0, prep: 0, up: 160, down: 160 }), es: [[1.3, 140, 'out'], [1, 380, 'back']], glow: [[0.35, 140, 'out']] },
      { tilt: [[-0.12, 300], [0.12, 500], [-0.08, 450], [0, 300]], glow: [[0.35, 1250, 'lin'], [0, 300]], blush: [[1, 200, 'out'], [1, 1050, 'lin'], [0, 300]] },
    ),
  // Sunglasses (Blobby does them like this: wait, drop, glint, long pose).
  cool: () =>
    chain(
      {},
      { gy: [[0.6, 250, 'out'], [0.6, 200, 'lin']], sq: [[0.95, 250, 'out'], [0.95, 200, 'lin']] },
      {
        glasses: [[1.06, 280, 'in'], [1, 160, 'back']],
        gy: [[0.05, 220]],
        sq: [[0.95, 280, 'lin'], [0.9, 50, 'out'], [1.04, 110, 'out']],
        tilt: [[0, 280, 'lin'], [-0.16, 160, 'back']],
        mouth: [[0, 280, 'lin'], [0.14, 160, 'out']],
      },
      { sq: [[1.03, 300, 'back'], [1.03, 1100, 'lin']], glasses: [[1, 1400, 'lin']], tilt: [[-0.16, 1400, 'lin']], mouth: [[0.14, 1400, 'lin']], glow: [[0.25, 300], [0.25, 1100, 'lin']] },
      { glasses: [[0, 300]], tilt: [[0, 300]], sq: [[1, 300]], mouth: [[0, 200]], glow: [[0, 300]], gy: [[0, 300]] },
    ),
  sing: () => ({ glow: [0, [0.3, 200, 'out'], [0.3, 2100, 'lin'], [0, 300]], blush: [0, [0.45, 200, 'out'], [0.45, 2100, 'lin'], [0, 300]] }),
  // "...": she stares, the eyes turn into dashes at once, a sweat drop, she sags.
  speechless: () =>
    chain(
      {},
      { es: [[1.08, 120, 'out'], [1.08, 230, 'lin']] },
      { es: [[1, 80, 'out']], sq: [[0.9, 80, 'out'], [0.95, 220, 'back']] },
      { sweat: [[1, 300, 'out'], [1, 1150, 'lin'], [0, 200]], sq: [[0.95, 1450, 'lin'], [1, 200]], glow: [[-0.15, 300], [-0.15, 1150, 'lin'], [0, 200]] },
    ),
  // Startle: the eyes open wider than they should and come back, "!" above.
  surprise: () => ({
    ...chain({}, hop(0.24, { crouch: 0.08, prep: 50, up: 150, down: 260 })),
    es: [1, [0.9, 50, 'out'], [1.3, 120, 'out'], [1.3, 300, 'lin'], [1, 400]],
    bang: [0, [1, 140, 'back'], [1, 700, 'lin'], [0, 160]],
    glow: [0, [0.5, 120, 'out'], [0.5, 400, 'lin'], [0, 400]],
  }),
  // Done: she crouches, jumps spinning, lands, two happy hops, pose.
  cheer: () =>
    chain(
      {},
      { sq: [[0.7, 140, 'out']], glow: [[0.3, 140]] },
      { y: [[0.42, 330, 'out'], [0, 290, 'in']], sq: [[1, 90, 'out']], spin: [[TAU, 560]], glow: [[1, 200, 'out']] },
      wait(140),
      hop(0.09, { crouch: 0.06, prep: 60, up: 140, down: 120 }),
      hop(0.06, { crouch: 0.05, prep: 60, up: 120, down: 110 }),
      { y: [[0, 500, 'lin']], glow: [[0, 500]], blush: [[0.7, 150, 'out'], [0, 350]] },
    ),
  // Against the edge: squashed sideways (tall and narrow), then she recovers.
  bonk: () => ({
    sq: [1, [1.32, 50, 'out'], [0.9, 140, 'out'], [1.05, 140], [1, 220, 'back']],
    es: [1, [0.75, 50, 'out'], [1, 400, 'back']],
  }),
  // Wakes with a start: big eyes, a little hop.
  wake: () => ({
    ...chain({}, hop(0.14, { crouch: 0, prep: 0, up: 140, down: 180 })),
    sq: [1, [1.15, 80, 'out'], [1, 120]],
    es: [1, [1.3, 100, 'out'], [1, 420, 'back']],
    glow: [0, [0.4, 100, 'out'], [0, 500]],
  }),
  flare: () => ({
    sq: [1, [1.18, 90, 'out'], [0.95, 140], [1, 220, 'back']],
    glow: [0, [0.5, 90, 'out'], [0, 400]],
  }),
  // Stretches: gets ready, stretches out, stays up with closed eyes, lets go.
  stretch: () => ({
    sq: [1, [0.9, 200, 'out'], [1.28, 500], [1.28, 450, 'lin'], [0.88, 150, 'in'], [1.04, 200, 'out'], [1, 300, 'back']],
    mouth: [0, [0, 200, 'lin'], [0.35, 500], [0.35, 450, 'lin'], [0, 150]],
    tilt: [0, [0, 200, 'lin'], [0.06, 500], [-0.04, 450], [0, 650]],
  }),
  hop: () => chain({}, hop(0.15, { crouch: 0.14, prep: 120, up: 220, down: 190 }), wait(60), hop(0.08, { crouch: 0.08, prep: 70, up: 150, down: 130 })),
  // Twirl: winds up turning a little backwards, spins and goes a touch beyond.
  spin: () => ({
    spin: [0, [-0.45, 220, 'out'], [TAU, 620, 'back']],
    sq: [1, [0.9, 220, 'out'], [1.06, 200, 'out'], [1, 300, 'back']],
    y: [0, [0, 220, 'lin'], [0.1, 250, 'out'], [0, 220, 'in']],
  }),
};
