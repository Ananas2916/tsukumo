/**
 * Where the mascot is and what she rests on, as in Desktop Mate.
 *
 * States:
 *  - `ground`  on the taskbar (standing, sitting on the edge or lying down);
 *  - `window`  sitting on a window's top edge, travelling with it;
 *  - `edge`    clinging to the left/right screen edge, peeking;
 *  - `falling` in free fall, or flying if you threw her (bouncing off the edges);
 *  - `held`    picked up with the mouse (the drag moves the window);
 *  - `sprint`  the flame runs along the taskbar at full speed.
 *
 * The character's window is bigger than the character: the "anchors" say,
 * as fractions of the window, where the feet, the seat (the bottom of the
 * pelvis) and the body axis are. The renderer measures them, since it knows
 * how the model is framed, and they hold at any scale.
 *
 * The module doesn't depend on Electron: everything it needs comes from
 * `env`, so it can be tested with fake windows.
 */

const GRAVITY = 2600; // px/s^2
const MAX_FALL = 1500; // px/s
const POSTURE_TIME = 0.45; // s: sitting down/standing up on the taskbar

/**
 * The flame's sprint (frontend/src/flame.js): she winds up, sets off at full
 * speed along the taskbar, brakes hard with a bounce and enjoys the moment.
 * Two runs: a dash to another point of the screen and back, or a lap (she
 * leaves from one edge, comes back in from the other and returns home).
 * Speeds in screen widths, so it's the same on every monitor.
 */
const SPRINT = {
  ready: 0.38, // s: winding up before setting off
  speed: 1.4, // screens per second at full speed
  accel: 7, // screens per second^2
  brake: 0.35, // she brakes when this fraction of the window is left to the finish
  stiffness: 160, // braking spring (1/s^2)
  damping: 15, // (1/s)
  settle: 0.5, // s of braking
  look: 0.9, // s looking around before going back
  proud: 0.7, // s of satisfaction at the end
};

/**
 * Throwing the flame (like Blobby): let go with a flick she flies in the
 * gesture's direction, the air slows her down, she bumps and bounces off the
 * screen edges, then gravity brings her down. Speeds in px/s; `edge` and
 * `ceiling` as fractions of the window (where the edge touches her).
 */
const THROW = { min: 650, max: 3200, drag: 1.1, bounce: 0.55, bonk: 350, edge: 0.14, ceiling: 0.3 };

const smoothstep = (t) => t * t * (3 - 2 * t);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

class PetPhysics {
  /**
   * @param {object} env
   * @param {() => {x:number,y:number,width:number,height:number}} env.bounds the character's window
   * @param {(x:number, y:number) => void} env.move
   * @param {(bounds:object) => {x:number,y:number,width:number,height:number}} env.workArea the monitor's work area
   * @param {() => Array} env.windows other programs' windows, topmost first
   * @param {(hwnd:number) => object|null} env.windowRect
   * @param {(message:object) => void} env.emit messages for the renderer
   * @param {() => number} [env.random] for tests: picks the sprint's run and finish
   */
  constructor(env) {
    this.env = env;
    this.random = env.random ?? Math.random;
    this.state = 'ground';
    this.posture = 'stand';
    this.vy = 0;
    this.vx = 0;
    /** Thrown: she also flies horizontally until she lands. */
    this.thrown = false;
    this.surface = null;
    this.transition = null;
    /** The sprint in progress: phase, finish, position and speed of the body axis. */
    this.run = null;
    /** Anchors as fractions of the window: feet and seat on the vertical, body axis on the horizontal. */
    this.anchors = { feet: 0.985, seat: 0.56, center: 0.5 };
    this.windowsEnabled = true;
  }

  setAnchors(anchors) {
    // They come from the renderer: with the window minimized innerHeight is 0
    // and a fraction becomes Infinity or NaN, which would end up in setPosition.
    const next = { ...this.anchors };
    for (const key of ['feet', 'seat', 'center']) {
      const value = Number(anchors?.[key]);
      if (Number.isFinite(value) && value > -1 && value < 2) next[key] = value;
    }
    this.anchors = next;
    this.snap();
  }

  // ------------------------------------------------------------- commands
  grab() {
    if (this.run) this._endSprint();
    this.state = 'held';
    this.surface = null;
    this.transition = null;
    this.vy = 0;
    this.vx = 0;
    this.thrown = false;
  }

  /**
   * Let go: she clings to the screen edge if she's outside it, otherwise she
   * falls. With `velocity` (`{vx, vy}` in px/s, from the renderer) it's a throw.
   */
  release(velocity = null) {
    const bounds = this.env.bounds();
    const area = this.env.workArea(bounds);
    const { center, feet } = this.anchors;
    const cx = bounds.x + bounds.width * center;
    const ground = area.y + area.height;
    const high = bounds.y + bounds.height * feet < ground - bounds.height * 0.2;
    const margin = bounds.width * 0.08;
    const thrown = throwVelocity(velocity);

    if (!thrown && high && (cx > area.x + area.width - margin || cx < area.x + margin)) {
      const side = cx > area.x + area.width / 2 ? 'right' : 'left';
      this._cling(side, bounds, area);
      return;
    }
    this.state = 'falling';
    this.vx = thrown?.vx ?? 0;
    this.vy = thrown?.vy ?? 0;
    this.thrown = Boolean(thrown);
    this.env.emit(thrown ? { state: 'falling', thrown: true, vx: this.vx } : { state: 'falling' });
  }

  /** Sit, stand up, lie down (face down or on her side): only on the taskbar; on windows she always sits. */
  requestPosture(posture) {
    if (this.state !== 'ground' || !['stand', 'sit', 'lie', 'side'].includes(posture) || posture === this.posture) return false;
    const bounds = this.env.bounds();
    this.transition = { from: bounds.y, t: 0 };
    this.posture = posture;
    this.env.emit({ state: 'posture', posture });
    return true;
  }

  /**
   * Starts a sprint, only standing on the taskbar. `kind`: 'dash' (dash and
   * back), 'lap' (a lap) or nothing to pick one at random.
   */
  sprint(kind) {
    if (this.state !== 'ground' || this.posture !== 'stand' || this.transition) return false;
    const bounds = this.env.bounds();
    const area = this.env.workArea(bounds);
    const cx = bounds.x + bounds.width * this.anchors.center;
    // The stops stay inside the screen even with the braking bounce.
    const margin = bounds.width * 0.6;
    const lo = area.x + margin;
    const hi = area.x + area.width - margin;
    const home = clamp(cx, lo, Math.max(lo, hi));
    const far = area.width / 3;
    const leftRoom = Math.max(0, home - far - lo);
    const rightRoom = Math.max(0, hi - (home + far));
    // On a screen too narrow for a long dash she does a lap.
    const lap = kind === 'lap' || leftRoom + rightRoom <= 0 || (kind !== 'dash' && this.random() < 0.45);
    let target = home;
    let dir = this.random() < 0.5 ? -1 : 1;
    if (!lap) {
      const pick = this.random() * (leftRoom + rightRoom);
      target = pick < leftRoom ? lo + pick : home + far + (pick - leftRoom);
      dir = Math.sign(target - home) || dir;
    }
    this.state = 'sprint';
    this.run = { phase: 'ready', t: 0, dir, target, home, lap, wrapped: false, legs: lap ? 1 : 2, x: cx, v: 0, area: { ...area } };
    this.env.emit({ state: 'sprint', phase: 'ready', dir, lap });
    return true;
  }

  // ------------------------------------------------------------- time
  step(dt) {
    switch (this.state) {
      case 'falling':
        this._fall(dt);
        break;
      case 'ground':
        this._ground(dt);
        break;
      case 'window':
        this._ride(dt);
        break;
      case 'sprint':
        this._sprint(dt);
        break;
      default:
        break;
    }
  }

  /** Repositions after a change of scale or anchors, without animations. */
  snap() {
    this.transition = null;
    if (this.state === 'ground') this._ground(0);
    else if (this.state === 'window') this._ride(0);
  }

  /**
   * New bounds for a new window size, keeping still the point she rests on
   * (feet or seat) and the body axis.
   */
  resized(bounds, width, height) {
    const { feet, seat, center } = this.anchors;
    const line = this.state === 'window' || this.posture === 'sit' ? seat : feet;
    const cx = bounds.x + bounds.width * center;
    let y;
    if (this.state === 'ground' || this.state === 'window' || this.state === 'sprint') {
      y = bounds.y + bounds.height * line - height * line;
    } else {
      y = bounds.y + bounds.height / 2 - height / 2;
    }
    return { x: Math.round(cx - width * center), y: Math.round(y), width, height };
  }

  // ------------------------------------------------------------- states
  _fall(dt) {
    const bounds = this.env.bounds();
    const area = this.env.workArea(bounds);
    const { feet, seat, center } = this.anchors;
    this.vy = Math.min(MAX_FALL, this.vy + GRAVITY * dt);
    const x = this.thrown ? this._fly(bounds, area, dt) : bounds.x;
    const dy = this.vy * dt;
    const cx = x + bounds.width * center;

    // Windows first: she lands sitting on the first edge she meets.
    if (this.windowsEnabled) {
      const seatBefore = bounds.y + bounds.height * seat;
      const target = this._landingWindow(seatBefore, seatBefore + dy, cx, bounds, area);
      if (target) {
        const y = Math.round(target.y - bounds.height * seat);
        this.env.move(x, y);
        this.state = 'window';
        this.posture = 'sit';
        // Where her body axis sits on the window, not the window's left edge:
        // a wider window (the menu island, a new scale) keeps her in place.
        this.surface = { hwnd: target.hwnd, axis: cx - target.x, x: target.x, y: target.y };
        this.env.emit({ state: 'landed', surface: 'window', posture: 'sit', impact: this.vy / MAX_FALL });
        this._stopFlying();
        return;
      }
    }

    const ground = area.y + area.height;
    const feetAfter = bounds.y + dy + bounds.height * feet;
    if (feetAfter >= ground) {
      // On the ground she stays fully inside the screen (thrown, as far as the flight took her).
      const half = bounds.width * (this.thrown ? THROW.edge : 0.22);
      const landX = clamp(cx, area.x + half, area.x + area.width - half) - bounds.width * center;
      this.env.move(Math.round(landX), Math.round(ground - bounds.height * feet));
      this.state = 'ground';
      this.posture = 'stand';
      this.env.emit({ state: 'landed', surface: 'ground', posture: 'stand', impact: this.vy / MAX_FALL });
      this._stopFlying();
      return;
    }
    const y = Math.round(bounds.y + dy);
    this.env.move(x, y);
    // The renderer pulls the trail back by how much the window moved.
    if (this.thrown) this.env.emit({ state: 'fly', x, y });
  }

  /**
   * One step of the horizontal flight: the air slows her down, the screen's
   * edges (and the sky) make her bounce. Returns the window's new x.
   */
  _fly(bounds, area, dt) {
    const { center, feet } = this.anchors;
    this.vx *= Math.exp(-THROW.drag * dt);
    const lo = area.x + bounds.width * THROW.edge;
    const hi = area.x + area.width - bounds.width * THROW.edge;
    let cx = bounds.x + bounds.width * center + this.vx * dt;
    if (cx < lo || cx > hi) {
      const side = cx < lo ? 'left' : 'right';
      cx = clamp(cx, lo, hi);
      if (Math.abs(this.vx) > THROW.bonk) this.env.emit({ state: 'bonk', side, impact: Math.min(1, Math.abs(this.vx) / THROW.max) });
      this.vx = -this.vx * THROW.bounce;
    }
    if (this.vy < 0 && bounds.y + bounds.height * feet < area.y + bounds.height * THROW.ceiling) {
      if (-this.vy > THROW.bonk) this.env.emit({ state: 'bonk', side: 'top', impact: Math.min(1, -this.vy / THROW.max) });
      this.vy = -this.vy * THROW.bounce;
    }
    return Math.round(cx - bounds.width * center);
  }

  _stopFlying() {
    this.vy = 0;
    this.vx = 0;
    this.thrown = false;
  }

  /**
   * The window to land on: its top edge is crossed by the seat line in this
   * step, the character fits on it horizontally, there's room for the body
   * above it and that piece of edge isn't covered by another window.
   */
  _landingWindow(before, after, cx, bounds, area) {
    const windows = this.env.windows();
    const margin = bounds.width * 0.12;
    const room = bounds.height * this.anchors.seat * 0.85;
    for (let i = 0; i < windows.length; i += 1) {
      const w = windows[i];
      if (w.maximized || w.y < before - 2 || w.y > after) continue;
      if (cx < w.x + margin || cx > w.x + w.width - margin) continue;
      if (w.y - area.y < room) continue;
      if (this._covered(windows, i, cx, w.y + 3)) continue;
      return w;
    }
    return null;
  }

  _covered(windows, index, x, y) {
    for (let j = 0; j < index; j += 1) {
      const w = windows[j];
      if (x >= w.x && x <= w.x + w.width && y >= w.y && y <= w.y + w.height) return true;
    }
    return false;
  }

  _ground(dt) {
    const bounds = this.env.bounds();
    const area = this.env.workArea(bounds);
    const line = this.posture === 'sit' ? this.anchors.seat : this.anchors.feet;
    const target = area.y + area.height - bounds.height * line;
    let y = target;
    if (this.transition) {
      this.transition.t = Math.min(1, this.transition.t + dt / POSTURE_TIME);
      y = this.transition.from + (target - this.transition.from) * smoothstep(this.transition.t);
      if (this.transition.t >= 1) this.transition = null;
    }
    if (Math.round(y) !== bounds.y) this.env.move(bounds.x, Math.round(y));
  }

  /** Sitting on a window: she follows it if it moves, falls if it disappears. */
  _ride() {
    const surface = this.surface;
    const rect = surface ? this.env.windowRect(surface.hwnd) : null;
    const bounds = this.env.bounds();
    const area = this.env.workArea(bounds);
    const { seat, center } = this.anchors;
    const cx = rect ? rect.x + surface.axis : bounds.x + bounds.width * center;
    const margin = bounds.width * 0.08;
    const lost =
      !rect ||
      rect.maximized ||
      rect.y - area.y < bounds.height * seat * 0.6 ||
      cx < rect.x + margin ||
      cx > rect.x + rect.width - margin;
    if (lost) {
      this.state = 'falling';
      this.surface = null;
      this.vy = 0;
      this.env.emit({ state: 'falling' });
      return;
    }

    const x = Math.round(cx - bounds.width * center);
    const y = Math.round(rect.y - bounds.height * seat);
    if (x !== bounds.x || y !== bounds.y) {
      this.env.move(x, y);
      // The renderer uses these positions to jostle her.
      this.env.emit({ state: 'carried', x, y });
    }
    surface.x = rect.x;
    surface.y = rect.y;
  }

  /**
   * One step of the sprint. The finish and the speeds concern the body axis;
   * the window is derived from it, because during the run it widens (see
   * updatePetShape in main.js) to make room for the trail.
   */
  _sprint(dt) {
    const run = this.run;
    const bounds = this.env.bounds();
    const { area } = run;
    run.t += dt;
    if (run.phase === 'ready') {
      if (run.t >= SPRINT.ready) this._sprintPhase('go');
    } else if (run.phase === 'go') {
      const top = SPRINT.speed * area.width;
      run.v = Math.min(top, Math.abs(run.v) + SPRINT.accel * area.width * dt) * run.dir;
      run.x += run.v * dt;
      // Lap: gone completely on one side, she comes back in from the other.
      const off = bounds.width * 0.8;
      if (run.lap && !run.wrapped && (run.dir > 0 ? run.x > area.x + area.width + off : run.x < area.x - off)) {
        run.x = run.dir > 0 ? area.x - off : area.x + area.width + off;
        run.wrapped = true;
      }
      if ((!run.lap || run.wrapped) && (run.target - run.x) * run.dir < bounds.width * SPRINT.brake) this._sprintPhase('brake');
    } else if (run.phase === 'brake') {
      run.v += (-SPRINT.stiffness * (run.x - run.target) - SPRINT.damping * run.v) * dt;
      run.x += run.v * dt;
      if (run.t >= SPRINT.settle) {
        run.x = run.target;
        run.v = 0;
        this._sprintPhase('proud');
      }
    } else if (run.phase === 'proud' && run.t >= (run.legs > 1 ? SPRINT.look : SPRINT.proud)) {
      if (run.legs === 1) {
        this._endSprint();
        return;
      }
      run.legs -= 1;
      run.target = run.home;
      run.dir = Math.sign(run.home - run.x) || 1;
      this._sprintPhase('ready');
    }

    const x = Math.round(run.x - bounds.width * this.anchors.center);
    const y = Math.round(area.y + area.height - bounds.height * this.anchors.feet);
    this.env.move(x, y);
    // The renderer moves the trail back by how much the window advanced.
    if (run.phase === 'go' || run.phase === 'brake') {
      this.env.emit({ state: 'sprint-move', x, speed: Math.min(1, Math.abs(run.v) / (SPRINT.speed * area.width)) });
    }
  }

  _sprintPhase(phase) {
    this.run.phase = phase;
    this.run.t = 0;
    this.env.emit({ state: 'sprint', phase, dir: this.run.dir });
  }

  _endSprint() {
    this.run = null;
    if (this.state === 'sprint') this.state = 'ground';
    this.env.emit({ state: 'sprint', phase: 'end' });
  }

  _cling(side, bounds, area) {
    const { center, feet } = this.anchors;
    // The screen edge goes a little into the body: you see the head peeking,
    // the rest is outside.
    const edge = side === 'right' ? center - 0.14 : center + 0.14;
    const x = side === 'right' ? area.x + area.width - bounds.width * edge : area.x - bounds.width * edge;
    const ground = area.y + area.height;
    const y = clamp(bounds.y, area.y - bounds.height * 0.15, ground - bounds.height * (feet + 0.2));
    this.env.move(Math.round(x), Math.round(y));
    this.state = 'edge';
    this.surface = null;
    this.env.emit({ state: 'edge', side, edge });
  }
}

/**
 * The throw's speed comes from the renderer: only finite numbers are
 * accepted, above the threshold (below it's just letting her go) and capped.
 */
function throwVelocity(velocity) {
  const vx = Number(velocity?.vx);
  const vy = Number(velocity?.vy);
  if (!Number.isFinite(vx) || !Number.isFinite(vy)) return null;
  const speed = Math.hypot(vx, vy);
  if (speed < THROW.min) return null;
  const k = Math.min(1, THROW.max / speed);
  return { vx: vx * k, vy: Math.min(vy * k, MAX_FALL) };
}

module.exports = { PetPhysics, GRAVITY, MAX_FALL, SPRINT, THROW };
