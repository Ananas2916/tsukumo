/**
 * How the flame moves: keyed curves, springs and hops.
 *
 * The craft comes from those who animate small characters well (Coucou's
 * Mochi, VS Code's Blobby): every gesture has an anticipation (she crouches
 * before jumping), a fast action, an arrival that goes a touch beyond and
 * comes back (`back` easing) and a final pause so the gesture "lands". Pure
 * sinusoids instead make everything look half-hearted.
 *
 * A curve is `[start, [value, ms, easing], [value, ms, easing], ...]`: from
 * the previous value to the next in `ms` milliseconds. A pause is a key with
 * the same value. No three.js here: it's tested with node.
 */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export const EASE = {
  lin: (t) => t,
  /** Speeds up: a fall. */
  in: (t) => t * t * t,
  /** Slows down: a rise, a soft arrival. */
  out: (t) => 1 - (1 - t) ** 3,
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  /** Goes a little beyond and comes back: the bouncing arrival. */
  back: (t) => {
    const c1 = 1.7;
    return 1 + (c1 + 1) * (t - 1) ** 3 + c1 * (t - 1) ** 2;
  },
  /** Starts backwards and then snaps: the wind-up before the gesture. */
  anticipate: (t) => {
    const c1 = 1.7;
    return (c1 + 1) * t ** 3 - c1 * t ** 2;
  },
};

/** The value of the curve after `seconds` (past the end it stays on the last key). */
export function sample(keys, seconds) {
  let from = keys[0];
  let ms = Math.max(0, seconds * 1000);
  for (let i = 1; i < keys.length; i += 1) {
    const [to, duration, ease = 'inOut'] = keys[i];
    if (ms < duration) return from + (to - from) * EASE[ease](clamp(ms / duration, 0, 1));
    ms -= duration;
    from = to;
  }
  return from;
}

/** How long a curve lasts, or a piece of curve without a start, in milliseconds. */
export function length(keys) {
  let total = 0;
  for (const key of keys) if (Array.isArray(key)) total += key[1];
  return total;
}

/** At rest: no jump, no squash, normal eyes. */
export const REST = { y: 0, sq: 1, spin: 0, tilt: 0, bend: 0, glow: 0, es: 1, mouth: 0, glasses: 0, sweat: 0, bang: 0, blush: 0 };

const WAIT = Symbol('wait');

/** Still for `ms`: time passes, every channel keeps its value. */
export const wait = (ms) => ({ [WAIT]: ms });

/**
 * Lines up pieces `{channel: [keys without a start]}`. A channel missing
 * from a piece stays still for the whole piece, so all channels stay aligned
 * and end together. `start` holds the starting values (default REST).
 */
export function chain(start, ...parts) {
  const tracks = {};
  const holdUntil = (track, at) => {
    const gap = at - length(track);
    if (gap > 0) track.push([last(track), gap, 'lin']);
  };
  let at = 0;
  for (const part of parts) {
    let span = part[WAIT] ?? 0;
    for (const [name, keys] of Object.entries(part)) {
      if (!tracks[name]) tracks[name] = [start[name] ?? REST[name] ?? 0];
      holdUntil(tracks[name], at);
      tracks[name].push(...keys);
      span = Math.max(span, length(keys));
    }
    at += span;
  }
  for (const track of Object.values(tracks)) holdUntil(track, at);
  return tracks;
}

function last(track) {
  const key = track[track.length - 1];
  return Array.isArray(key) ? key[0] : key;
}

/**
 * A hop `height` tall (drop units): she crouches (`crouch`), rises slowing
 * down and falls speeding up. The landing squash isn't here: the contact
 * spring does it (see Squash), for any jump.
 */
export function hop(height, { crouch = 0.14, prep = 110, up = 260, down = 220 } = {}) {
  return {
    y: [[0, prep, 'lin'], [height, up, 'out'], [0, down, 'in']],
    sq: [[1 - crouch, prep, 'out'], [1, Math.min(90, up), 'out']],
  };
}

/** The values of all the curves after `seconds`. */
export function play(tracks, seconds) {
  const out = {};
  for (const [name, keys] of Object.entries(tracks)) out[name] = sample(keys, seconds);
  return out;
}

/** How long a gesture made of curves lasts, in seconds. */
export function duration(tracks) {
  let ms = 0;
  for (const keys of Object.values(tracks)) ms = Math.max(ms, length(keys));
  return ms / 1000;
}

/**
 * A damped spring (like SwiftUI's `.spring(response:dampingFraction:)`):
 * `response` is the period in seconds, `damping` < 1 oscillates a little.
 * Integrated in small steps, a long frame doesn't make it explode.
 */
export class Spring {
  constructor(value = 0, response = 0.3, damping = 0.4) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.omega = (2 * Math.PI) / response;
    this.zeta = damping;
  }

  /** A push: it changes the velocity, the spring does the rest. */
  kick(velocity) {
    this.velocity += velocity;
  }

  step(dt) {
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    for (let i = 0; i < steps; i += 1) {
      const accel = this.omega * this.omega * (this.target - this.value) - 2 * this.zeta * this.omega * this.velocity;
      this.velocity += accel * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }

  get settled() {
    return Math.abs(this.value - this.target) < 0.0015 && Math.abs(this.velocity) < 0.01;
  }
}

/**
 * Contact squash: when a jump touches the ground the drop squashes in
 * proportion to the speed it arrives with, then oscillates and settles (the
 * spring). In the air it stretches a little along the motion. The volume
 * stays the same: whoever uses `sy` sets `sx = 1 / sqrt(sy)`.
 */
export class Squash {
  constructor() {
    this.spring = new Spring(0, 0.32, 0.32);
    this.prevY = 0;
    this.vy = 0;
  }

  /** A direct push (a hit, a landing from physics): positive = she squashes. */
  impact(amount) {
    this.spring.kick(-amount * this.spring.omega);
  }

  /** `y` is the height of the jump now (drop units). Returns the factor for `sy`. */
  update(dt, y) {
    if (dt <= 0) return 1 + this.spring.value;
    const vy = (y - this.prevY) / dt;
    // She was in the air and now touches down, falling: squashed as much as she was fast.
    if (this.prevY > 0.004 && y <= 0.004 && this.vy < -0.3) this.impact(clamp(-this.vy * 0.075, 0, 0.32));
    this.vy = vy;
    this.prevY = y;
    this.spring.step(dt);
    const stretch = y > 0.004 ? clamp(Math.abs(vy) * 0.045, 0, 0.14) : 0;
    return clamp(1 + this.spring.value + stretch, 0.6, 1.45);
  }

  get busy() {
    return !this.spring.settled || this.prevY > 0.004;
  }
}
