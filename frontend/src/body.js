/**
 * The character's body: procedural animation, Desktop Mate style.
 *
 * Desktop Mate animates its characters with motion-capture clips. We have
 * none here, so we rebuild by hand the ingredients that make a body look
 * alive, which are surprisingly few but must all be done:
 *
 *  - posture: the weight sits on one leg (contrapposto) and now and then
 *    moves to the other; the pelvis tilts, shoulders and head compensate,
 *    the knees stay soft instead of locked;
 *  - planted feet: two-bone IK on the legs, so the pelvis can move without
 *    the feet sliding on the floor;
 *  - asymmetric breathing (breathing in is faster than breathing out) that
 *    lifts chest and shoulders;
 *  - arms hanging by gravity and following the torso with a delay, relaxed
 *    hands with bent fingers (straight fingers are the robot's signature);
 *  - cascading gaze: first the eyes, then the head, then neck and torso;
 *    when the cursor is still she looks at you, with a few glances away;
 *  - small spontaneous actions: she stretches, looks around, tucks her hair,
 *    puts her hands behind her back, hums, tilts her head;
 *  - body language while she speaks, a thoughtful pose while the LLM works;
 *  - life on the desktop: sitting on window edges with swinging legs, lying
 *    on the taskbar (face down or on her side), clinging to the screen edge,
 *    picked up by the scruff with the mouse, falling, landed;
 *  - music: when Spotify plays she moves in time (see music.js).
 *
 * Body modes (they blend into each other): `stand`, `sit`, `lie`, `side`,
 * `edge`, `held`, `fall`. Where the window is gets decided by the Electron
 * process (pet-physics.js); here we decide how the body is.
 *
 * Conventions. Poses are written for a VRM 1.0 (facing +Z, her left is +X)
 * on three-vrm's *normalized* bones, which have zero rotation in T-pose.
 * VRM 0.x face -Z in their own space: flipping the X and Z components is
 * enough (see `flip`). Arms and legs are written for the LEFT side; the
 * right one is mirrored (Y and Z change sign).
 *
 * Axis reminder, for the left side:
 *   arm: Z- lowers from the T-pose, X- brings forward; forearm: Y- bends the
 *   elbow; hand: Z- flexes the wrist; fingers: Z- closes; shoulder: Z+ raises.
 *   leg: X- brings forward, Z+ spreads; knee: X+ bends; foot: X+ points.
 *   torso/head: X+ forward, Y+ turns towards her left, Z+ tilts towards her
 *   right.
 */

import * as THREE from 'three';

import { ACTIONS, GESTURES } from './body/actions.js';
import {
  EDGE_LEAN,
  EPSILON,
  FIDGET_DELAY,
  FINGER_REST,
  HOLD_PITCH,
  MODE_RATES,
  MODES,
  MOODS,
  PHALANGES,
  POSTURE_DELAY,
  POSTURES,
  RESTING,
  SIDES,
} from './body/constants.js';
import { basisQuat, clamp, curve, damp, makeNoise, randomBetween, smoothstep, Spring, TAU, Wobble } from './body/motion.js';
import { Pose } from './body/pose.js';
import { StanceMixer } from './body/stances.js';

// Reused temporaries: no allocations in the render loop.
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _v6 = new THREE.Vector3();
const _v7 = new THREE.Vector3();
const _v8 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _q4 = new THREE.Quaternion();
const _q5 = new THREE.Quaternion();
const _qRoot = new THREE.Quaternion();
const _qMode = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();
const _e1 = new THREE.Euler();
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** The kind of the agent's tool (backend/llm/activity.py) -> the pose while it works. */
const WORK_STYLE = { read: 'read', search: 'read', web: 'read', write: 'type', run: 'type', tool: 'type' };

// ------------------------------------------------------------------ animator
export class BodyAnimator {
  /**
   * @param {import('@pixiv/three-vrm').VRM} vrm
   * @param {THREE.Object3D} root group containing `vrm.scene`: rotating it the
   *   whole body dangles, lies down, leans out from the edge.
   * @param {THREE.Object3D} lookTarget object followed by the eyes (vrm.lookAt)
   */
  constructor(vrm, root, lookTarget) {
    this.vrm = vrm;
    this.root = root;
    this.lookTarget = lookTarget;
    this.humanoid = vrm.humanoid;
    /** VRM 0.x faces -Z in its space: the poses' X and Z must be flipped. */
    this.flip = vrm.meta?.metaVersion === '0' ? -1 : 1;

    this.pose = new Pose();
    this.time = 0;

    this._initSkeleton();

    // --- standing posture ---------------------------------------------------
    this.breath = { phase: Math.random() };
    this.weight = new Spring(1.8, Math.random() < 0.5 ? -1 : 1);
    this.weightTarget = this.weight.x;
    this.weightTimer = randomBetween(3, 8);
    this.noise = {
      swayX: makeNoise(0.7),
      swayZ: makeNoise(0.55),
      spine: makeNoise(0.45),
      headYaw: makeNoise(0.5),
      headRoll: makeNoise(0.4),
    };
    this.armLag = { roll: new Spring(5), pitch: new Spring(5) };

    // --- gaze -----------------------------------------------------------
    this.head = { yaw: new Spring(5.5), pitch: new Spring(5.5) };
    this.eyes = { yaw: 0, pitch: 0 };
    this.saccade = { yaw: 0, pitch: 0, timer: 1 };
    this.idleGlance = { yaw: 0, pitch: 0, timer: 2 };
    this.blinkRequested = false;

    // --- speech -----------------------------------------------------------
    this.speech = {
      engage: new Spring(4),
      nod: new Spring(16),
      slowLevel: 0,
      lastActive: -Infinity,
      clipStart: 0,
      clipDuration: 1,
      question: false,
      emphatic: false,
      mood: null,
      gesture: null,
      gestures: Object.fromEntries(Object.keys(GESTURES).map((name) => [name, new Spring(4.5)])),
      yaw: new Spring(2.5),
      roll: new Spring(2.5),
      yawTarget: 0,
      rollTarget: 0,
    };
    this.thinking = false;
    this.think = new Spring(3.2);
    /** How she stands: normal, shy, cool, elegant... (body/stances.js). */
    this.stances = new StanceMixer();
    /** An agent at work: what kind of step (see WORK_STYLE) and the two poses. */
    this.work = { kind: null, read: new Spring(2.6), type: new Spring(2.6) };
    /** Weights of the work poses in this frame, for the holographic panel (holo.js). */
    this.workWeights = { reading: 0, typing: 0, taps: [0, 0] };
    // --- sleep: the PC has been idle for a while (see presence.js) ----------
    /** 0 = awake, 0.5 = drowsy, 1 = asleep. */
    this.sleepTarget = 0;
    this.sleep = 0;
    /** Nodding off when drowsy: the head drops slowly and snaps back up. */
    this.doze = { drop: 0, falling: false, timer: randomBetween(2, 4), jerk: 0 };
    this.sleepSide = 1;
    this.yawnTimer = randomBetween(3, 8);
    // --- cursor over the head: she reaches out to touch it ------------------
    this.reachUp = new Spring(4);
    this.reachSide = 'right';
    this.reachTarget = new THREE.Vector3();

    // --- spontaneous actions and poses ------------------------------------
    this.actions = [];
    this.fidgetTimer = randomBetween(...FIDGET_DELAY);
    this.lastFidget = null;
    /** Spontaneous gestures and posture changes: they're turned off from the panel. */
    this.spontaneous = true;
    this.postureTimer = randomBetween(...POSTURE_DELAY);
    /** Called when she wants to sit/lie down/stand up: Electron carries it out. */
    this.onPostureRequest = null;
    /** .vrma clips: a random one instead of a spontaneous gesture (true if it started). */
    this.onIdleClip = null;
    /** While a clip plays the body doesn't start gestures of its own. */
    this.isClipPlaying = () => false;

    // --- music ---------------------------------------------------------------
    this.music = { active: false, bpm: 0, phase: 0, beat: 0, energy: 0, confidence: 0 };
    /** How much she lets go to the music, and how sure she is of the tempo. */
    this.vibe = new Spring(1.6);
    this.groove = new Spring(1.2);
    /** Turned off from the panel. */
    this.dancing = true;

    // --- body modes -----------------------------------------------------------
    this.mode = 'stand';
    this.modeWeight = { stand: 1, sit: 0, lie: 0, side: 0, edge: 0, held: 0, fall: 0 };
    /** What she rests on: 'ground' (taskbar), 'window', 'edge' or null (in the air). */
    this.surface = 'ground';
    this.pendulum = { angle: 0, velocity: 0 };
    this.pivot = new THREE.Vector3();
    this.hold = {
      x: 0,
      y: 0,
      lastX: null,
      lastY: null,
      vx: 0,
      ax: 0,
      speed: 0,
      kick: new Spring(3, 0.15),
      since: 0,
    };
    this.land = new Wobble(13, 0.42);
    this.shock = new Spring(3);
    this.shockTarget = 0;

    // Sitting: swinging legs, jostled if the window moves.
    this.legSwing = { amount: new Spring(1.5, 0.5), target: 0.5, timer: 3 };
    this.sitBounce = new Wobble(12, 0.35);
    this.sway = new Wobble(6, 0.22);
    this.carry = { x: null, y: null, px: null, py: null, vx: 0, vy: 0 };

    // Screen edge: where the hands are and the pivot of leaning out.
    this.edge = {
      sign: 1,
      pivot: new THREE.Vector3(),
      grips: [new THREE.Vector3(), new THREE.Vector3()],
    };

    // --- expressions ------------------------------------------------------
    this.expressions = Object.fromEntries(MOODS.map((mood) => [mood, 0]));
  }

  // ----------------------------------------------------------- skeleton
  _initSkeleton() {
    const humanoid = this.humanoid;
    // We start from a clean T-pose: the skeleton's measures are taken here.
    humanoid.resetNormalizedPose?.();

    this.bones = {};
    for (const name of Object.keys(humanoid.humanBones)) {
      const node = humanoid.getNormalizedBoneNode(name);
      if (node) this.bones[name] = node;
    }
    // Eyes and jaw are governed by lookAt and expressions, not by us.
    this.managed = Object.keys(this.bones).filter((name) => !['leftEye', 'rightEye', 'jaw'].includes(name));

    this.rigRoot = humanoid.normalizedHumanBonesRoot;
    this.vrm.scene.updateWorldMatrix(true, true);

    const scene = this.vrm.scene;
    const rest = (name) => {
      const node = this.bones[name];
      return node ? scene.worldToLocal(node.getWorldPosition(new THREE.Vector3())) : null;
    };

    this.hipsRest = this.bones.hips.position.clone();
    const head = rest('head');
    const hips = rest('hips');
    this.height = Math.max(0.5, (head?.y ?? 1.4) + 0.12);
    /** The model's proportions relative to a ~1.5 m character. */
    this.size = this.height / 1.5;
    this.headRest = head;
    this.hipsRestWorld = hips;

    // Notable points, in the rig's space: the scruff she's picked up by, the
    // seat (the bottom of the pelvis) and the shoulders' height.
    const neck = rest('neck') ?? head;
    this.restPoints = {
      nape: neck.clone().add(new THREE.Vector3(0, 0.03 * this.size, -0.06 * this.size * this.flip)),
      seat: new THREE.Vector3(hips.x, (rest('leftUpperLeg')?.y ?? hips.y - 0.04) - 0.075 * this.size, hips.z),
      hips: hips.clone(),
      head: head.clone(),
      shoulder: rest('leftUpperArm') ?? head.clone(),
    };

    const forward = new THREE.Vector3(0, 0, this.flip);
    const backward = forward.clone().negate();
    this.chains = {};
    for (const side of SIDES) {
      const leg = this._makeChain(`${side}UpperLeg`, `${side}LowerLeg`, `${side}Foot`, forward);
      if (leg) {
        leg.restEnd = rest(`${side}Foot`);
        const toes = rest(`${side}Toes`);
        leg.footLength = toes ? Math.hypot(toes.z - leg.restEnd.z, toes.y - leg.restEnd.y) : 0.12;
        this.chains[`${side}Leg`] = leg;
      }
      const arm = this._makeChain(`${side}UpperArm`, `${side}LowerArm`, `${side}Hand`, backward);
      if (arm) this.chains[`${side}Arm`] = arm;
    }

    // Lying down the body rotates 90 degrees around the pelvis and goes down
    // until the belly touches the ground.
    this.lie = {
      pivot: this.restPoint('hips'),
      // The chest stays raised on the elbows: the belly touches the ground, the elbows don't go through it.
      offset: new THREE.Vector3(0, 0.2 * this.size - hips.y, -0.1 * this.size),
    };

    // On her side the body rotates 90 degrees around the axis of the camera's
    // gaze: she stays facing you, lying along the taskbar. The pelvis ends up
    // half a hip-width off the ground. `sign` +1 = head to the left (resting on
    // the right hip), -1 = head to the right. `shift` recentres the body in the
    // window: from the pelvis the legs are longer than the torso, so the pivot
    // isn't the centre of the lying figure.
    this.side = {
      sign: 1,
      pivot: this.restPoint('hips'),
      lift: 0.25 * this.size - hips.y,
      shift: 0.12 * this.size,
    };
  }

  /**
   * Two-bone chain for the IK. `bend` is the direction the middle joint moves
   * when the chain bends (the knee goes forward, the elbow back), in the
   * rig's space.
   */
  _makeChain(upperName, lowerName, endName, bend) {
    const upper = this.bones[upperName];
    const lower = this.bones[lowerName];
    const end = this.bones[endName];
    if (!upper || !lower || !end) return null;

    const scene = this.vrm.scene;
    const p0 = scene.worldToLocal(upper.getWorldPosition(new THREE.Vector3()));
    const p1 = scene.worldToLocal(lower.getWorldPosition(new THREE.Vector3()));
    const p2 = scene.worldToLocal(end.getWorldPosition(new THREE.Vector3()));
    const a1 = p1.clone().sub(p0);
    const a2 = p2.clone().sub(p1);
    const l1 = a1.length();
    const l2 = a2.length();
    a1.normalize();
    a2.normalize();
    const n1 = new THREE.Vector3().crossVectors(a1, bend).normalize();
    const n2 = new THREE.Vector3().crossVectors(a2, bend).normalize();

    return {
      upper,
      lower,
      end,
      l1,
      l2,
      restInv1: basisQuat(a1, n1, new THREE.Quaternion()).invert(),
      restInv2: basisQuat(a2, n2, new THREE.Quaternion()).invert(),
    };
  }

  /**
   * Notable point at rest (`nape`, `seat`, `hips`, `head`, `shoulder`) in the
   * space of the group containing the model, i.e. in the world when the body
   * isn't rotated. The scene needs it for the window's anchors.
   */
  restPoint(name, target = new THREE.Vector3()) {
    return target.copy(this.restPoints[name]).applyMatrix4(this.vrm.scene.matrix);
  }

  /** Reference bone for the hands, with fallbacks for models without upperChest. */
  _anchor(name) {
    const b = this.bones;
    if (name === 'upperChest') return b.upperChest ?? b.chest ?? b.spine;
    if (name === 'chest') return b.chest ?? b.spine;
    return b[name] ?? b.hips;
  }

  /** A vector written in VRM 1.0 conventions, brought into the rig's space. */
  _rig(target, x, y, z) {
    return target.set(x * this.flip, y, z * this.flip);
  }

  // ----------------------------------------------------------- commands
  /** Starts an action by name (handy from the console too: `stage.body.play('stretch')`). */
  play(name, options = {}) {
    const def = ACTIONS[name];
    if (!def || !def.modes.includes(this.mode)) return false;
    // A reaction interrupts everything else; an action doesn't overlap itself.
    for (const action of this.actions) {
      if (def.reaction || action.name === name) action.cancelled = true;
    }
    this.actions.push({
      name,
      def,
      t: 0,
      fade: 1,
      cancelled: false,
      sign: options.sign ?? (Math.random() < 0.5 ? -1 : 1),
    });
    return true;
  }

  /** Changes the way of standing (`shy`, `cool`, `ladylike`...): it fades into the new one. */
  setStance(name) {
    this.stances.set(name);
  }

  setThinking(value) {
    this.thinking = Boolean(value);
    if (this.thinking) this._cancelIdleActions();
    else this.work.kind = null;
  }

  /**
   * The agent is using a tool (`read`, `write`, `run`...): while it thinks
   * she reads an invisible tablet or types on an invisible keyboard.
   */
  setWorking(kind) {
    this.work.kind = kind || null;
  }

  /**
   * Sleep: 0 awake, 0.5 drowsy, 1 asleep. Falling asleep is slow, about ten
   * seconds; waking up is quick, blinking.
   */
  setSleep(level) {
    const target = clamp(Number(level) || 0, 0, 1);
    if (target > 0 && this.sleepTarget === 0) {
      this._cancelIdleActions();
      this.sleepSide = Math.random() < 0.5 ? -1 : 1;
      this.yawnTimer = randomBetween(3, 8);
    }
    if (target < this.sleepTarget && this.sleep > 0.3) this.blinkRequested = true;
    this.sleepTarget = target;
  }

  /** Really asleep (not just drowsy). */
  get asleep() {
    return this.sleep > 0.75;
  }

  /** Mouth opened by the body (the yawn), read by the scene every frame. */
  get mouthOpen() {
    return this.pose.mouthOpen;
  }

  /** A new sentence is about to be spoken: it chooses gesture, mood and head. */
  onClipStart({ text = '', mood = null, duration = 1, vocal = null } = {}) {
    const speech = this.speech;
    const trimmed = text.trim();
    speech.clipStart = this.time;
    speech.clipDuration = Math.max(0.3, duration);
    speech.question = trimmed.endsWith('?');
    speech.emphatic = trimmed.endsWith('!');
    speech.mood = mood;
    if (vocal) {
      // A vocal ("Hii!", "Ehehe!") goes with a gesture already in progress, like
      // the greeting: no hand gestures and no interruption.
      speech.gesture = null;
      speech.yawTarget = 0;
      speech.rollTarget = 0;
      return;
    }

    // A different gesture at every sentence, but not always: gesturing all the time is tiring.
    const options = speech.question
      ? ['open', 'open', 'explainRight', null]
      : ['explainRight', 'explainLeft', 'open', 'chest', null, null];
    let gesture = options[Math.floor(Math.random() * options.length)];
    if (gesture && gesture === speech.gesture && Math.random() < 0.6) gesture = null;
    speech.gesture = gesture;

    speech.yawTarget = randomBetween(-0.12, 0.12);
    speech.rollTarget = speech.question ? randomBetween(0.08, 0.14) * (Math.random() < 0.5 ? -1 : 1) : randomBetween(-0.06, 0.06);
    this._cancelIdleActions();
  }

  /**
   * Picked up with the mouse, by the scruff like a kitten: the body dangles
   * from there. The scene moves the window so the scruff ends up under the
   * cursor, whatever point was grabbed.
   */
  beginHold() {
    this.mode = 'held';
    this.surface = null;
    this.carry.x = null;
    this._cancelIdleActions();
    this.restPoint('nape', this.pivot);
    this.pendulum.angle = 0;
    this.pendulum.velocity = 0;
    this.hold.lastX = null;
    this.hold.vx = 0;
    this.hold.ax = 0;
    this.hold.since = this.time;
    this.shockTarget = 1;
    this.shock.x = Math.max(this.shock.x, 0.6);
  }

  /** The window's position while it's held (screen pixels). */
  moveHold(x, y) {
    this.hold.x = x;
    this.hold.y = y;
  }

  endHold() {
    if (this.mode === 'held') this.mode = 'fall';
    this.shockTarget = 0;
  }

  setFalling() {
    this.mode = 'fall';
    this.surface = null;
    this.carry.x = null;
    this.shockTarget = 1;
  }

  /**
   * Landed on something: on the taskbar she lands standing, bending her knees,
   * on a window's edge she sits with a small bounce.
   */
  landed(impact = 0.5, posture = 'stand') {
    const strength = clamp(impact, 0.15, 1);
    this.shockTarget = 0;
    this.shock.x = Math.max(this.shock.x, 0.4 + 0.45 * strength);
    this.postureTimer = randomBetween(...POSTURE_DELAY);
    if (posture === 'sit') {
      this.mode = 'sit';
      this.surface = 'window';
      this.sitBounce.v += 2.4 * strength;
    } else {
      this.mode = 'stand';
      this.surface = 'ground';
      this.land.v -= 1.3 * strength;
    }
  }

  /**
   * Posture change on the taskbar, decided here and confirmed by Electron.
   * @param {number} [sign] on her side: +1 head to the left, -1 to the right
   */
  setPosture(posture, sign) {
    if (!POSTURES.includes(posture)) return;
    if (posture === 'side' && this.mode !== 'side') this.side.sign = sign ?? (Math.random() < 0.5 ? -1 : 1);
    this.mode = posture;
    this.surface = 'ground';
    this.carry.x = null;
    this._cancelIdleActions();
  }

  /**
   * Clinging to the screen edge. `edgeX` is the edge's x in the world: the
   * hands rest on it and the body leans inwards.
   */
  setEdge(side, edgeX) {
    this.mode = 'edge';
    this.surface = 'edge';
    this.carry.x = null;
    this._cancelIdleActions();
    const shoulder = this.restPoint('shoulder', _v1);
    const gripY = shoulder.y + 0.04 * this.size;
    this.edge.sign = side === 'right' ? 1 : -1;
    this.edge.pivot.set(edgeX, gripY, 0);
    this.edge.grips[0].set(edgeX, gripY, 0.05 * this.size);
    this.edge.grips[1].set(edgeX, gripY - 0.14 * this.size, 0.05 * this.size);
  }

  /** The window she's sitting on moved (screen pixels). */
  carried(x, y) {
    this.carry.x = x;
    this.carry.y = y;
  }

  /**
   * Touch: on the head it's a pat, on the body a little fright.
   * Returns the reaction that started (`pat`, `flinch`) or `null`.
   */
  poke(region) {
    if (!POSTURES.includes(this.mode)) return null;
    if (region !== 'head' && (this.mode === 'lie' || this.mode === 'side')) return null;
    const name = region === 'head' ? 'pat' : 'flinch';
    return this.play(name) ? name : null;
  }

  /** The rhythm of the music playing (see music.js), every frame. */
  setMusic(state) {
    this.music = state;
  }

  /** How much the blink must be suppressed (eyes already closed by the smile). */
  get blinkSuppression() {
    return clamp(this.expressions.happy * 1.2, 0, 1);
  }

  /** The blink requested by a gaze change (read once). */
  consumeBlinkRequest() {
    const requested = this.blinkRequested;
    this.blinkRequested = false;
    return requested;
  }

  get eyesClosed() {
    return this.pose.eyesClosed;
  }

  _cancelIdleActions() {
    for (const action of this.actions) {
      if (!action.def.reaction) action.cancelled = true;
    }
    this.fidgetTimer = Math.max(this.fidgetTimer, randomBetween(...FIDGET_DELAY));
  }

  _modeWeightOf(modes) {
    let total = 0;
    for (const mode of modes) total += this.modeWeight[mode];
    return total;
  }

  // ----------------------------------------------------------- frame
  /**
   * @param {number} dt
   * @param {object} ctx
   * @param {boolean} ctx.speaking   audio is playing
   * @param {number} ctx.level       instantaneous volume 0..1
   * @param {THREE.Vector3|null} ctx.gazePoint the cursor's point in the world
   * @param {boolean} ctx.gazeFresh  the cursor moved recently
   * @param {THREE.Vector3} ctx.viewer the camera's position (the viewer)
   * @param {number} ctx.metersPerPixel screen -> scene scale, for the physics
   */
  update(dt, ctx) {
    this.time += dt;
    this._updateModes(dt);
    this._updatePendulum(dt, ctx);
    this._updateCarry(dt, ctx);
    this._updateSleep(dt);
    this._updateActions(dt, ctx);

    const pose = this.pose;
    pose.reset();

    const W = this.modeWeight;
    this._breathe(pose, dt, ctx, W.stand + W.sit + W.lie + W.side + W.edge);
    if (W.stand > EPSILON) this._stand(pose, dt, W.stand);
    if (W.sit > EPSILON) this._sit(pose, dt, W.sit);
    if (W.lie > EPSILON) this._lie(pose, W.lie);
    if (W.side > EPSILON) this._side(pose, W.side);
    if (W.edge > EPSILON) this._edge(pose, W.edge);
    if (W.held > EPSILON) this._held(pose, dt, W.held);
    if (W.fall > EPSILON) this._fall(pose, W.fall);

    const upright = W.stand + W.sit;
    this._speech(pose, dt, ctx, upright, upright + W.lie + W.side + W.edge);
    this._thinking(pose, dt, upright);
    this._dance(pose, dt, ctx);
    this._runActions(pose);
    this._reachCursor(pose, dt, ctx, W.stand + W.sit);
    this._sleep(pose, upright, W.lie + W.side + W.edge);
    this._landing(pose, dt, W.stand);
    this._armGravity(pose, dt, upright);
    this._reactions(pose, dt);
    this._gaze(pose, dt, ctx);

    this._applyForwardKinematics(pose);
    this._applyRoot();
    this._applyInverseKinematics(pose);
    this._updateExpressions(pose, dt);
  }

  _updateModes(dt) {
    const rate = MODE_RATES[this.mode];
    let total = 0;
    for (const mode of MODES) {
      const target = mode === this.mode ? 1 : 0;
      this.modeWeight[mode] = damp(this.modeWeight[mode], target, rate, dt);
      total += this.modeWeight[mode];
    }
    for (const mode of MODES) this.modeWeight[mode] /= total;
  }

  /**
   * Pendulum: when held the body dangles from the grab point. The window
   * accelerating sideways pushes the body the opposite way, then gravity
   * brings it back down with a few swings.
   */
  _updatePendulum(dt, ctx) {
    const hold = this.hold;
    const pendulum = this.pendulum;
    const heldNow = this.mode === 'held';

    if (heldNow && hold.lastX !== null && dt > 0) {
      const raw = (hold.x - hold.lastX) / dt;
      const vx = damp(hold.vx, raw, 20, dt);
      hold.ax = damp(hold.ax, (vx - hold.vx) / dt, 14, dt);
      hold.vx = vx;
      hold.speed = Math.hypot(raw, (hold.y - hold.lastY) / dt);
    } else {
      hold.ax = damp(hold.ax, 0, 10, dt);
      hold.vx = damp(hold.vx, 0, 10, dt);
      hold.speed = 0;
    }
    hold.lastX = heldNow ? hold.x : null;
    hold.lastY = heldNow ? hold.y : null;

    // Reduced coupling: with "real" physics a jerk of the mouse would spin her
    // 45 degrees and push her out of the window.
    const metersPerPixel = ctx.metersPerPixel || 0.004;
    const ax = heldNow ? clamp(hold.ax * metersPerPixel * 0.3, -14, 14) : 0;
    const length = 0.55;
    const gravity = 9.8;
    const damping = heldNow ? 2.2 : 7;
    const steps = Math.ceil(dt / 0.008);
    const h = dt / steps;
    for (let i = 0; i < steps; i += 1) {
      const acc =
        -(gravity / length) * Math.sin(pendulum.angle) -
        damping * pendulum.velocity -
        (ax / length) * Math.cos(pendulum.angle);
      pendulum.velocity += acc * h;
      pendulum.angle = clamp(pendulum.angle + pendulum.velocity * h, -0.42, 0.42);
    }
  }

  /**
   * Sitting on a window that moves: the window's accelerations jostle her
   * (swaying torso, dangling legs, small jolts).
   */
  _updateCarry(dt, ctx) {
    const carry = this.carry;
    if (carry.x !== null && dt > 0) {
      if (carry.px === null) {
        carry.px = carry.x;
        carry.py = carry.y;
      }
      const vx = damp(carry.vx, (carry.x - carry.px) / dt, 18, dt);
      const vy = damp(carry.vy, (carry.y - carry.py) / dt, 18, dt);
      const ax = (vx - carry.vx) / dt;
      const ay = (vy - carry.vy) / dt;
      carry.vx = vx;
      carry.vy = vy;
      carry.px = carry.x;
      carry.py = carry.y;
      const metersPerPixel = ctx.metersPerPixel || 0.004;
      this.sway.v += clamp(-ax * metersPerPixel * 0.35, -25, 25) * dt;
      this.sitBounce.v += clamp(ay * metersPerPixel * 0.25, -25, 25) * dt;
    } else {
      carry.px = null;
      carry.vx = 0;
      carry.vy = 0;
    }
    this.sway.update(dt);
    this.sway.x = clamp(this.sway.x, -0.45, 0.45);
  }

  _updateActions(dt, ctx) {
    for (const action of this.actions) {
      action.t += dt;
      if (action.cancelled) action.fade = damp(action.fade, 0, 7, dt);
    }
    this.actions = this.actions.filter(
      (action) => action.t < action.def.duration && !(action.cancelled && action.fade < 0.01),
    );

    // Spontaneous gestures only when she's calm: still, quiet, no thoughts.
    const settled = RESTING.includes(this.mode) && this.modeWeight[this.mode] > 0.95;
    const quiet = !this.thinking && !ctx.speaking && this.time - this.speech.lastActive > 2;
    if (!settled || !quiet) return;

    // Drowsy she yawns now and then; asleep she does nothing else.
    if (this.sleepTarget > 0 || this.sleep > 0.05) {
      this.yawnTimer -= dt;
      if (this.sleep > 0.25 && this.sleep < 0.7 && this.yawnTimer <= 0 && !this.actions.length) {
        this.yawnTimer = randomBetween(12, 25);
        this.play('yawn');
      }
      return;
    }
    if (!this.spontaneous) return;

    // On the taskbar now and then she sits on the edge or lies down, then gets up.
    this.postureTimer -= dt;
    if (this.surface === 'ground' && this.onPostureRequest && this.postureTimer <= 0 && this.actions.length === 0) {
      let next = null;
      if (this.mode === 'stand') {
        const roll = Math.random();
        next = roll < 0.35 ? 'sit' : roll < 0.55 ? 'lie' : roll < 0.78 ? 'side' : null;
        this.postureTimer = next ? randomBetween(18, 45) : randomBetween(...POSTURE_DELAY);
      } else {
        next = 'stand';
        this.postureTimer = randomBetween(...POSTURE_DELAY);
      }
      if (next) this.onPostureRequest(next);
      return;
    }

    // While she dances (or a clip plays) she doesn't start anything else.
    if (this.actions.length || this.vibe.x > 0.3 || this.isClipPlaying()) return;
    this.fidgetTimer -= dt;
    if (this.fidgetTimer > 0) return;
    this.fidgetTimer = randomBetween(...FIDGET_DELAY);
    if (this.onIdleClip && Math.random() < 0.35 && this.onIdleClip()) return;

    const candidates = Object.entries(ACTIONS).filter(
      ([name, def]) => def.idle && def.modes.includes(this.mode) && name !== this.lastFidget,
    );
    const total = candidates.reduce((sum, [, def]) => sum + def.idle, 0);
    let pick = Math.random() * total;
    for (const [name, def] of candidates) {
      pick -= def.idle;
      if (pick <= 0) {
        this.lastFidget = name;
        this.play(name);
        break;
      }
    }
  }

  // ----------------------------------------------------------- shared layers
  /** Breathing: in for ~40% of the cycle, out for the rest. */
  _breathe(pose, dt, ctx, w) {
    // In sleep the breath slows down and gets deeper.
    const breathRate = (ctx.speaking ? 1 / 3.4 : 1 / 4.2) * (1 - 0.35 * this.sleep);
    this.breath.phase = (this.breath.phase + dt * breathRate) % 1;
    if (w < EPSILON) return;
    const phase = this.breath.phase;
    const breath = phase < 0.4 ? smoothstep(phase / 0.4) : 1 - smoothstep((phase - 0.4) / 0.6);
    const depth = w * (1 + 0.8 * this.sleep);
    pose.add('chest', -0.02 * breath * depth, 0, 0);
    pose.add('upperChest', -0.014 * breath * depth, 0, 0);
    pose.add('neck', 0.014 * breath * depth, 0, 0);
    pose.both('Shoulder', 0, 0, 0.035 * breath, depth);
    pose.both('UpperArm', 0, 0, 0.015 * breath, depth);
  }

  /**
   * The arms hang by gravity: when the torso tilts we straighten them, with a
   * slight delay, like a hanging weight.
   */
  _armGravity(pose, dt, w) {
    const roll = ['hips', 'spine', 'chest', 'upperChest'].reduce((sum, bone) => sum + pose.get(bone).z, 0);
    const pitch = ['hips', 'spine', 'chest', 'upperChest'].reduce((sum, bone) => sum + pose.get(bone).x, 0);
    const lagRoll = this.armLag.roll.update(-roll * 0.85, dt);
    const lagPitch = this.armLag.pitch.update(-pitch * 0.7, dt);
    if (w < EPSILON) return;
    pose.add('leftUpperArm', lagPitch * w, 0, lagRoll * w);
    pose.add('rightUpperArm', lagPitch * w, 0, lagRoll * w);
  }

  // ----------------------------------------------------------- standing
  _stand(pose, dt, w) {
    const t = this.time;
    pose.legIK += w;

    // --- weight on one leg (contrapposto), it changes now and then -----------
    this.weightTimer -= dt;
    if (this.weightTimer <= 0) {
      const roll = Math.random();
      this.weightTarget = roll < 0.12 ? 0 : roll < 0.56 ? -1 : 1;
      this.weightTimer = randomBetween(4, 11);
    }
    // An elegant one stays composed, an energetic one moves more (see stances.js).
    const weight = this.weight.update(this.weightTarget, dt) * clamp(this.stances.sway, 0, 1.3);
    const lean = Math.abs(weight);
    // Pelvis over the supporting leg, higher on that side; the torso
    // compensates the other way and the head goes back straight.
    pose.hips.x += 0.022 * weight * w;
    // A few millimetres are enough: near the straight leg the knee is very
    // sensitive (5 mm lower pelvis = ~13 degrees of bend).
    pose.hips.y -= (0.002 + 0.0025 * lean) * w;
    pose.add('hips', 0, 0.05 * weight * w, 0.055 * weight * w);
    pose.add('spine', 0, -0.03 * weight * w, -0.045 * weight * w);
    pose.add('chest', 0, -0.02 * weight * w, -0.03 * weight * w);
    pose.add('neck', 0, 0, 0.012 * weight * w);
    pose.add('head', 0, 0, 0.008 * weight * w);
    // The free leg goes a little forward and out, with the heel just raised.
    for (const side of SIDES) {
      const s = side === 'left' ? 1 : -1;
      const free = clamp(-weight * s, 0, 1) * w;
      pose.feet[side].x += 0.018 * s * free;
      pose.feet[side].z += 0.045 * free;
      pose.heel[side] += 0.12 * free;
    }

    // --- postural sway: nobody stands still like a statue ---------------------
    const n = this.noise;
    pose.hips.x += 0.006 * n.swayX(t) * w;
    pose.hips.z += 0.005 * n.swayZ(t) * w;
    pose.add('spine', 0.008 * n.spine(t) * w, 0, 0.008 * n.swayX(t + 3) * w);

    // --- arms and hands at rest -------------------------------------------
    pose.both('Shoulder', 0, 0, -0.03, w);
    pose.both('UpperArm', 0.03, 0.05, -1.24, w);
    pose.both('LowerArm', 0, -0.32, 0, w);
    pose.both('Hand', 0, -0.06, -0.1, w);
    pose.add('spine', 0.02 * w, 0, 0);
    pose.add('chest', -0.015 * w, 0, 0);

    // The way of standing, over the base posture.
    this.stances.apply(pose, dt, t, w);
  }

  // ----------------------------------------------------------- sitting
  /**
   * Sitting on an edge (of a window or the taskbar): thighs forward, shins
   * down in front of the edge, swinging feet, hands on the thighs.
   */
  _sit(pose, dt, w) {
    const t = this.time;
    const swing = this.legSwing;
    swing.timer -= dt;
    if (swing.timer <= 0) {
      swing.target = Math.random() < 0.3 ? 0.05 : randomBetween(0.25, 1);
      swing.timer = randomBetween(3, 9);
    }
    const amount = swing.amount.update(swing.target, dt);
    const bounce = clamp(this.sitBounce.update(dt), -0.35, 0.35);
    const sway = this.sway.x;

    for (const side of SIDES) {
      const s = side === 'left' ? 1 : -1;
      const phase = Math.sin(t * TAU * 0.6 + (s > 0 ? 0 : Math.PI)) * amount;
      pose.side(side, 'UpperLeg', -1.45 + 0.05 * phase - 0.25 * bounce, 0.04, 0.06, w);
      pose.side(side, 'LowerLeg', 1.4 + 0.38 * phase - 0.5 * bounce, 0, 0, w);
      pose.side(side, 'Foot', 0.2 + 0.12 * phase, 0, 0, w);
      // The legs dangle when the window moves.
      pose.add(`${side}UpperLeg`, 0, 0, -0.25 * sway * w);
    }

    pose.add('spine', (0.05 + 0.3 * bounce) * w, 0, -0.3 * sway * w);
    pose.add('chest', 0.02 * w, 0, 0);
    pose.add('head', -0.2 * bounce * w, 0, 0.15 * sway * w);

    pose.both('Shoulder', 0, 0, -0.03, w);
    pose.both('UpperArm', -0.3, 0.05, -1.2, w);
    pose.both('LowerArm', 0, -0.6, 0, w);
    pose.both('Hand', 0, 0, 0.1, w);
    pose.reach('left', 'hips', [0.1, -0.03, 0.22], [1, -0.4, -0.5], w, 0.1, true);
    pose.reach('right', 'hips', [0.1, -0.03, 0.22], [1, -0.4, -0.5], w, 0.1, true);
  }

  // ----------------------------------------------------------- lying down
  /**
   * Lying face down on the taskbar, facing you: resting on the elbows, chin in
   * her hands, feet kicking gently in the air.
   */
  _lie(pose, w) {
    const t = this.time;
    pose.add('spine', -0.3 * w, 0, 0);
    pose.add('chest', -0.25 * w, 0, 0);
    pose.add('upperChest', -0.15 * w, 0, 0);
    pose.add('neck', -0.2 * w, 0, 0);
    pose.add('head', -0.1 * w, 0, 0.06 * Math.sin(t * 0.6) * w);
    for (const side of SIDES) {
      const kick = Math.sin(t * TAU * 0.45 + (side === 'left' ? 0 : Math.PI));
      pose.side(side, 'UpperLeg', 0.05, 0, 0.07, w);
      pose.side(side, 'LowerLeg', 1.35 + 0.45 * kick, 0, 0, w);
      pose.side(side, 'Foot', 0.5, 0, 0, w);
    }
    pose.both('UpperArm', -1.2, 0, -0.9, w);
    pose.both('LowerArm', 0, -1.6, 0, w);
    pose.reach('left', 'head', [0.045, -0.1, 0.06], [0.5, -0.6, 1], w, 1.2, true);
    pose.reach('right', 'head', [0.045, -0.1, 0.06], [0.5, -0.6, 1], w, 1.2, true);
    pose.fingers.left += 0.3 * w;
    pose.fingers.right += 0.3 * w;
    pose.mood('relaxed', 0.35 * w);
  }

  // ----------------------------------------------------------- on her side
  /**
   * Lying on her side along the taskbar, facing you: torso raised on the
   * elbow, head resting on the hand, the other arm lying on the hip, legs bent
   * with the upper one further forward, gently swinging. The whole body's
   * rotation is done by `_rootTransform`; here the bones are written in the
   * character's space, as if she were standing.
   */
  _side(pose, w) {
    const t = this.time;
    const sign = this.side.sign;
    const low = sign > 0 ? 'right' : 'left';
    const high = sign > 0 ? 'left' : 'right';
    // Z+ tilts towards her right: the torso rises bending towards the upper hip.
    const up = -sign;
    pose.add('spine', 0, 0, 0.22 * up * w);
    pose.add('chest', 0, 0, 0.2 * up * w);
    pose.add('upperChest', 0, 0, 0.12 * up * w);
    pose.add('neck', 0, 0, 0.1 * up * w);
    pose.add('head', 0.04 * w, 0, (0.12 + 0.03 * Math.sin(t * 0.5)) * up * w);

    // Elbow on the ground under the shoulder, the temple resting in the palm.
    pose.reach(low, 'head', [0.08, -0.07, 0.05], [1, -0.6, 0.1], w, 0.9, true);
    pose.fingers[low] += 0.1 * w;
    // The upper arm rests in front of her, the hand on the thigh.
    pose.reach(high, 'hips', [0.15, -0.1, 0.18], [0.5, -0.2, -0.8], w, 0.2, true);
    pose.fingers[high] += 0.3 * w;

    // The upper leg opens upwards (so it's visible, instead of overlapping the
    // other in depth) and swings gently.
    for (const leg of SIDES) {
      const top = leg === high;
      const swing = top ? Math.sin(t * TAU * 0.22) : 0;
      pose.side(leg, 'UpperLeg', top ? -0.4 + 0.06 * swing : -0.18, 0, top ? 0.14 : 0.02, w);
      pose.side(leg, 'LowerLeg', top ? 0.7 + 0.12 * swing : 0.3, 0, 0, w);
      pose.side(leg, 'Foot', 0.3, 0, 0, w);
    }
    pose.mood('relaxed', 0.4 * w);
  }

  // ----------------------------------------------------------- music
  /**
   * She moves in time with the music: head nodding on the beat, weight moving
   * from one leg to the other every two beats, bouncing shoulders. If the
   * tempo isn't reliable (ambient music, speech) she sways gently on her own
   * instead of nodding out of time. Never while she speaks or thinks.
   */
  _dance(pose, dt, ctx) {
    const W = this.modeWeight;
    const m = this.music;
    const calm = W.stand + W.sit + W.lie + W.side;
    const wanted = this.dancing && m.active && !ctx.speaking && !this.thinking ? 1 : 0;
    const vibe = this.vibe.update(wanted, dt) * calm;
    const groove = this.groove.update(clamp((m.confidence - 0.15) / 0.3, 0, 1), dt);
    if (vibe < EPSILON) return;

    const amp = vibe * (0.55 + 0.45 * m.energy);
    // 1 on the beat, 0 halfway; "sway" reaches the extremes on the beats, alternating sides.
    const bob = (0.5 + 0.5 * Math.cos(TAU * m.phase)) ** 2 * groove;
    const sway = groove * Math.cos(Math.PI * (m.beat + m.phase)) + (1 - groove) * Math.sin(this.time * TAU * 0.3);
    const upright = W.stand + W.sit;

    pose.add('head', 0.13 * bob * amp, 0.05 * sway * amp, -0.09 * sway * amp);
    pose.add('neck', 0.07 * bob * amp, 0, -0.03 * sway * amp);
    pose.add('spine', 0.03 * bob * amp * upright, 0, 0.06 * sway * amp * upright);
    pose.add('chest', 0.02 * bob * amp * upright, 0.05 * sway * amp * upright, 0.03 * sway * amp * upright);
    pose.both('Shoulder', 0, 0, 0.06 * bob * amp * upright);
    // The arms follow the body with a slight delay: half a beat later.
    const lag = groove * Math.cos(Math.PI * (m.beat + m.phase) - 0.6) + (1 - groove) * Math.sin(this.time * TAU * 0.3 - 0.6);
    pose.both('UpperArm', 0, 0, 0.07 * bob * amp * upright);
    pose.add('leftUpperArm', 0, 0, 0.05 * lag * amp * upright);
    pose.add('rightUpperArm', 0, 0, 0.05 * lag * amp * upright);
    pose.both('LowerArm', 0, -0.12 * bob * amp * upright, 0);

    if (W.stand > EPSILON) {
      const s = W.stand * amp;
      pose.hips.x += 0.035 * sway * s;
      pose.hips.y -= 0.022 * bob * s;
      pose.add('hips', 0, 0.06 * sway * s, -0.05 * sway * s);
      pose.heel.left += 0.18 * Math.max(0, -sway) * s;
      pose.heel.right += 0.18 * Math.max(0, sway) * s;
    }
    if (W.sit > EPSILON) {
      const s = W.sit * amp;
      pose.side('left', 'LowerLeg', 0.3 * sway, 0, 0, s);
      pose.side('right', 'LowerLeg', -0.3 * sway, 0, 0, s);
    }
    if (W.lie > EPSILON) {
      const s = W.lie * amp;
      pose.side('left', 'LowerLeg', 0.35 * sway, 0, 0, s);
      pose.side('right', 'LowerLeg', -0.35 * sway, 0, 0, s);
    }
    if (W.side > EPSILON) {
      // She taps the upper foot in time.
      const high = this.side.sign > 0 ? 'left' : 'right';
      pose.side(high, 'LowerLeg', 0.18 * bob, 0, 0, W.side * amp);
      pose.side(high, 'Foot', 0.2 * bob, 0, 0, W.side * amp);
    }
    pose.mood('happy', 0.3 * vibe);
    pose.mood('relaxed', 0.2 * vibe);
  }

  // ----------------------------------------------------------- edge
  /** Clinging to the screen edge: hands on the edge, peeking in, legs dangling. */
  _edge(pose, w) {
    const t = this.time;
    const s = this.edge.sign;
    // The hand on the edge's side is higher, the other a little below.
    const near = s > 0 ? 'right' : 'left';
    const far = s > 0 ? 'left' : 'right';
    pose.reachWorld(near, this.edge.grips[0], [1, -1, -0.2], w, 0.3);
    pose.reachWorld(far, this.edge.grips[1], [1, -1, -0.2], w, 0.3);
    pose.fingers.left += 0.4 * w;
    pose.fingers.right += 0.4 * w;
    pose.both('UpperArm', -0.3, 0, -0.3, w);
    pose.both('LowerArm', 0, -0.6, 0, w);

    // Head tilted inwards, like someone peeking from behind a corner.
    pose.add('head', 0.03 * w, 0, s * 0.16 * w);
    pose.add('neck', 0, 0, s * 0.06 * w);
    for (const side of SIDES) {
      const dangle = Math.sin(t * TAU * 0.4 + (side === 'left' ? 0 : 1.7));
      pose.side(side, 'UpperLeg', -0.1 + 0.08 * dangle, 0.04, 0.05, w);
      pose.side(side, 'LowerLeg', 0.3 + 0.15 * Math.max(0, dangle), 0, 0, w);
      pose.side(side, 'Foot', 0.5, 0, 0, w);
    }
    pose.mood('relaxed', 0.3 * w);
    pose.mood('happy', 0.1 * w);
  }

  // ----------------------------------------------------------- held
  /**
   * Held by the scruff: torso curling forward, head up looking at whoever
   * holds her, arms and legs dangling. She kicks only if you shake her.
   */
  _held(pose, dt, w) {
    const t = this.time;
    const kick = this.hold.kick.update(clamp(0.1 + this.hold.speed / 1400, 0, 1.2), dt);
    const swing = this.pendulum.velocity;

    pose.add('spine', 0.22 * w, 0, -0.05 * swing * w);
    pose.add('chest', 0.12 * w, 0, 0);
    pose.add('upperChest', 0.06 * w, 0, 0);
    pose.add('neck', -0.2 * w, 0, 0);
    pose.add('head', -0.12 * w, 0, 0.08 * Math.sin(t * 0.7 + 1) * w);
    // Shoulders pulled up to the ears: the sign of someone held by the collar.
    pose.both('Shoulder', 0, 0, 0.2, w);

    // The arms compensate the torso's tilt and stay vertical, lagging behind
    // the swing.
    const torso = HOLD_PITCH + 0.35;
    pose.both('UpperArm', -torso * 0.9, 0, -1.38, w);
    pose.add('leftUpperArm', 0, 0, -0.15 * swing * w);
    pose.add('rightUpperArm', 0, 0, -0.15 * swing * w);
    pose.both('LowerArm', 0, -0.15, 0, w);
    pose.both('Hand', 0, 0, -0.1, w);
    pose.fingers.left += 0.2 * w;
    pose.fingers.right += 0.2 * w;

    for (const side of SIDES) {
      const s = side === 'left' ? 1 : -1;
      const phase = t * TAU * 1.15 + (s > 0 ? 0 : Math.PI);
      const k = Math.sin(phase) * kick;
      // Legs slightly different from each other: two identical legs look like a mannequin.
      const bent = s > 0 ? 0.55 : 0.3;
      pose.side(side, 'UpperLeg', -HOLD_PITCH * 0.5 - 0.1 * (s > 0 ? 1 : 0) - 0.28 * k, 0.04, 0.05, w);
      pose.side(side, 'LowerLeg', bent + 0.45 * Math.max(0, Math.sin(phase + 1.3)) * kick, 0, 0, w);
      pose.side(side, 'Foot', 0.75, 0, 0, w);
      // The legs lag behind the body's swing.
      pose.add(`${side}UpperLeg`, 0, 0, -0.12 * swing * w);
    }
    pose.mood('relaxed', 0.25 * w);
  }

  // ----------------------------------------------------------- falling
  _fall(pose, w) {
    const t = this.time;
    for (const side of SIDES) {
      const s = side === 'left' ? 1 : -1;
      // Arms up and flailing: "waaah!".
      const flail = Math.sin(t * 11 + (s > 0 ? 0 : 1.7));
      pose.side(side, 'UpperArm', -0.3, 0, 0.55 + 0.18 * flail, w);
      pose.side(side, 'LowerArm', 0, -0.7 - 0.2 * flail, 0, w);
    }
    pose.side('left', 'UpperLeg', -0.45, 0, 0.06, w);
    pose.side('left', 'LowerLeg', 0.75, 0, 0, w);
    pose.side('right', 'UpperLeg', -0.1, 0, 0.06, w);
    pose.side('right', 'LowerLeg', 0.35, 0, 0, w);
    pose.both('Foot', 0.35, 0, 0, w);
    pose.fingers.left -= 0.7 * w;
    pose.fingers.right -= 0.7 * w;
    pose.add('spine', -0.06 * w, 0, 0);
    pose.add('head', 0.12 * w, 0, 0);
  }

  // ----------------------------------------------------------- speech and thought
  /**
   * @param {number} bodyWeight how much arms and torso can move (standing or sitting)
   * @param {number} headWeight how much the head can nod (lying down or clinging too)
   */
  _speech(pose, dt, ctx, bodyWeight, headWeight) {
    const speech = this.speech;
    if (ctx.speaking) speech.lastActive = this.time;
    // She stays "in conversation" for a moment between one sentence and the next.
    const active = this.time - speech.lastActive < 0.7;
    const engage = speech.engage.update(active ? 1 : 0, dt);

    // Beats: volume peaks above the average become head nods.
    speech.slowLevel = damp(speech.slowLevel, ctx.level, 2.5, dt);
    const onset = Math.max(0, ctx.level - speech.slowLevel - 0.04);
    const emphasis = speech.emphatic ? 1.4 : 1;
    const nod = speech.nod.update(onset * 2.4 * emphasis, dt);
    const yaw = speech.yaw.update(active ? speech.yawTarget : 0, dt);
    const roll = speech.roll.update(active ? speech.rollTarget : 0, dt);

    for (const [name, spring] of Object.entries(speech.gestures)) {
      spring.update(active && speech.gesture === name ? 1 : 0, dt);
    }
    if (engage < EPSILON) return;

    // The emojis' mood, restrained: with the mouth speaking a full smile would
    // deform the lip-sync.
    if (speech.mood) pose.mood(speech.mood, 0.5 * engage);

    const h = engage * headWeight;
    pose.add('head', (0.1 * nod + 0.025 * ctx.level) * h, yaw * h, roll * h);
    pose.add('neck', 0.03 * nod * h, 0, 0);

    const e = engage * bodyWeight;
    if (e < EPSILON) return;
    pose.add('spine', 0.025 * e, 0, 0);

    // Question: towards the end of the sentence she shrugs and tilts her head.
    const progress = clamp((this.time - speech.clipStart) / speech.clipDuration, 0, 1);
    if (speech.question) {
      const shrug = curve(progress, [[0.55, 0], [0.85, 1], [1, 0.6]]) * e;
      pose.both('Shoulder', 0, 0, 0.1, shrug);
      pose.add('head', -0.03 * shrug, 0, 0);
    }

    // Hand gestures, with the palms "beating" the rhythm of the words.
    const beat = nod * 0.035 + ctx.level * 0.015;
    for (const [name, spring] of Object.entries(speech.gestures)) {
      const g = spring.x * bodyWeight;
      if (g < EPSILON) continue;
      for (const hand of GESTURES[name]) {
        const [x, y, z] = hand.offset;
        pose.reach(hand.side, 'upperChest', [x, y + beat, z + beat * 0.5], hand.pole, g, hand.twist);
        pose.fingers[hand.side] -= 0.45 * g;
        pose.side(hand.side, 'Hand', 0, 0, 0.1, g);
      }
    }
  }

  /** The cursor stays over her head: she reaches for it, happy (Desktop Mate does it). */
  _reachCursor(pose, dt, ctx, w) {
    const free = !ctx.speaking && !this.thinking && this.sleep < 0.2 && !this.actions.some((action) => action.def.reaction);
    const k = this.reachUp.update(ctx.reachPoint && free ? 1 : 0, dt) * w;
    const head = this.bones.head;
    if (ctx.reachPoint && head) {
      this.reachTarget.copy(ctx.reachPoint);
      const local = this._toCharacter(_v6.copy(ctx.reachPoint).sub(head.getWorldPosition(_v7)));
      // The hand on the cursor's side (+x is the character's left).
      if (k < 0.05) this.reachSide = local.x >= 0 ? 'left' : 'right';
    }
    if (k < EPSILON) return;
    pose.reachWorld(this.reachSide, this.reachTarget, [0.6, -1, 0.2], 0.9 * k, -0.8);
    pose.fingers[this.reachSide] -= 0.7 * k;
    if (this.mode === 'stand') {
      pose.heel.left += 0.25 * k;
      pose.heel.right += 0.25 * k;
    }
    pose.add('spine', -0.03 * k, 0, 0);
    pose.mood('happy', 0.6 * k);
  }

  _updateSleep(dt) {
    // Falling asleep takes about ten seconds, waking up half a second.
    const rate = this.sleepTarget > this.sleep ? 0.35 : 5;
    this.sleep = damp(this.sleep, this.sleepTarget, rate, dt);

    const doze = this.doze;
    doze.jerk = damp(doze.jerk, 0, 4, dt);
    const yawning = this.actions.some((action) => action.name === 'yawn' && !action.cancelled);
    if (this.sleep < 0.2 || this.sleep > 0.75 || yawning) {
      doze.drop = damp(doze.drop, 0, 3, dt);
      doze.falling = false;
      return;
    }
    doze.timer -= dt;
    if (doze.falling) {
      doze.drop = Math.min(1, doze.drop + dt / 3.5);
      if (doze.timer <= 0) {
        // She comes to with a start, blinking.
        doze.falling = false;
        doze.jerk = doze.drop;
        doze.timer = randomBetween(2.5, 5);
        this.blinkRequested = true;
      }
    } else {
      doze.drop = damp(doze.drop, 0, 10, dt);
      if (doze.timer <= 0) {
        doze.falling = true;
        doze.timer = randomBetween(2.5, 4.5);
      }
    }
  }

  /**
   * Drowsy: heavy eyelids, low gaze, nodding off. Asleep: closed eyes, head
   * tilted to the side, slumped shoulders.
   */
  _sleep(pose, upright, lying) {
    const s = this.sleep;
    if (s < EPSILON) return;
    const drowsy = clamp(s / 0.5, 0, 1);
    const deep = clamp((s - 0.5) / 0.5, 0, 1);
    const doze = this.doze;
    const nod = smoothstep(doze.drop) * (1 - deep);
    const all = upright + lying;

    pose.eyesClosed = Math.max(pose.eyesClosed, Math.min(1, Math.max(0.5 * drowsy + 0.45 * nod, deep)) * all);
    pose.mood('relaxed', (0.25 * drowsy + 0.35 * deep) * all);
    pose.mood('surprised', 0.35 * doze.jerk * all);

    // She stops following the cursor and lowers her gaze.
    const g = Math.max(0.6 * drowsy, deep) * all;
    pose.gaze.pitch += 0.18 * g;
    pose.gaze.weight += g;

    if (upright < EPSILON) return;
    const side = this.sleepSide;
    const head = 0.08 * drowsy + 0.4 * nod + 0.3 * deep - 0.12 * doze.jerk;
    pose.add('head', head * upright, 0, 0.18 * side * deep * upright);
    pose.add('neck', (0.04 * drowsy + 0.14 * nod + 0.12 * deep) * upright, 0, 0.06 * side * deep * upright);
    pose.add('spine', 0.04 * deep * upright, 0, 0);
    pose.add('chest', (0.02 * drowsy + 0.05 * deep) * upright, 0, 0);
    pose.both('Shoulder', 0, 0, -0.04 * (drowsy + deep), upright);
  }

  /** Thinks (hand on the chin), or works: reads or writes, according to the agent's tool. */
  _thinking(pose, dt, w) {
    const style = this.thinking ? WORK_STYLE[this.work.kind] ?? null : null;
    const reading = this.work.read.update(style === 'read' ? 1 : 0, dt) * w;
    const typing = this.work.type.update(style === 'type' ? 1 : 0, dt) * w;
    this.workWeights.reading = reading;
    this.workWeights.typing = typing;
    if (reading > EPSILON) this._reading(pose, reading);
    if (typing > EPSILON) this._typing(pose, typing);

    const k = this.think.update(this.thinking && !style ? 1 : 0, dt) * w;
    if (k < EPSILON) return;
    const t = this.time;
    pose.reach('right', 'head', [-0.01, -0.09, 0.075], [0.25, -1, 0.35], k, -0.5);
    pose.reach('left', 'upperChest', [-0.03, -0.17, 0.12], [1, -0.5, -0.4], k, 1.2);
    pose.fingers.right += 0.9 * k;
    pose.side('right', 'Hand', 0, 0, -0.35, k);
    pose.add('head', -0.05 * k, 0, 0.1 * k);
    pose.add('neck', 0, 0, 0.04 * k);
    pose.add('spine', 0.02 * k, 0, 0);
    pose.gaze.yaw += (0.35 + 0.12 * Math.sin(t * 0.7)) * k;
    pose.gaze.pitch += -0.3 * k;
    pose.gaze.weight += 0.8 * k;
  }

  /** Holds an invisible tablet in front of the chest and reads it line by line. */
  _reading(pose, k) {
    const t = this.time;
    pose.reach('left', 'upperChest', [0.095, -0.03, 0.24], [1, -1.2, -0.3], k, 1.3);
    pose.reach('right', 'upperChest', [0.095, -0.03, 0.24], [1, -1.2, -0.3], k, 1.3);
    pose.fingers.left += 0.35 * k;
    pose.fingers.right += 0.35 * k;
    pose.add('head', 0.2 * k, 0, 0.04 * Math.sin(t * 0.4) * k);
    pose.add('neck', 0.08 * k, 0, 0);
    pose.add('spine', 0.03 * k, 0, 0);
    // The eyes run along the line and snap back to the start.
    const line = (t * 0.55) % 1;
    const sweep = line < 0.85 ? line / 0.85 : 1 - (line - 0.85) / 0.15;
    pose.gaze.yaw += (sweep - 0.5) * 0.3 * k;
    pose.gaze.pitch += 0.42 * k;
    pose.gaze.weight += 0.9 * k;
  }

  /** Types on an invisible keyboard at waist height, in bursts. */
  _typing(pose, k) {
    const t = this.time;
    // Bursts of keys with small pauses, like someone really writing.
    const burst = smoothstep(-0.2, 0.4, Math.sin(t * 0.9) + 0.35 * Math.sin(t * 2.3));
    const tapL = Math.max(0, Math.sin(t * 13)) * burst;
    const tapR = Math.max(0, Math.sin(t * 13 + 2.1)) * burst;
    this.workWeights.taps[0] = tapL;
    this.workWeights.taps[1] = tapR;
    pose.reach('left', 'hips', [0.12, 0.15 + 0.012 * tapL, 0.3], [1, -1, -0.6], k, -0.2);
    pose.reach('right', 'hips', [0.12, 0.15 + 0.012 * tapR, 0.3], [1, -1, -0.6], k, -0.2);
    pose.fingers.left += (0.25 + 0.3 * tapL) * k;
    pose.fingers.right += (0.25 + 0.3 * tapR) * k;
    pose.add('head', 0.24 * k, 0, 0);
    pose.add('neck', 0.1 * k, 0, 0);
    pose.add('spine', 0.05 * k, 0, 0);
    pose.gaze.yaw += 0.06 * Math.sin(t * 1.3) * k;
    pose.gaze.pitch += 0.5 * k;
    pose.gaze.weight += 0.9 * k;
  }

  _runActions(pose) {
    for (const action of this.actions) {
      const u = action.t / action.def.duration;
      const weight = action.fade * this._modeWeightOf(action.def.modes);
      if (weight > EPSILON) action.def.run(pose, u, weight, action.t, action, this);
    }
  }

  /** Landing: knees bending and bouncing, arms opening. */
  _landing(pose, dt, w) {
    const squash = clamp(this.land.update(dt), -0.12, 0.05);
    if (w < EPSILON || (Math.abs(squash) < 0.0005 && Math.abs(this.land.v) < 0.001)) return;
    const down = -squash * w;
    pose.hips.y += squash * w;
    pose.hips.z -= 0.2 * down;
    pose.add('spine', 2 * down, 0, 0);
    pose.add('chest', 0.8 * down, 0, 0);
    pose.add('head', -0.8 * down, 0, 0);
    pose.both('UpperArm', -1.2, 0, 2.5, down);
    pose.both('LowerArm', 0, -2.5, 0, down);
  }

  _reactions(pose, dt) {
    // Fright expression (picked up, falling, landing) that fades by itself.
    const shock = this.shock.update(this.shockTarget, dt);
    if (this.mode === 'held' && this.time - this.hold.since > 1.6) this.shockTarget = 0.25;
    pose.mood('surprised', shock);
  }

  // ----------------------------------------------------------- gaze
  /**
   * The eyes reach the target right away, the head follows calmly and spreads
   * the rotation over neck and torso. Without a moving cursor she looks at the
   * viewer, with a few glances away now and then.
   */
  _gaze(pose, dt, ctx) {
    const headNode = this.bones.head;
    if (!headNode) return;
    const headPos = headNode.getWorldPosition(_v1);

    // Direction towards the cursor (or the camera) in the character's space.
    const target = ctx.gazeFresh && ctx.gazePoint ? ctx.gazePoint : ctx.viewer;
    const local = this._toCharacter(_v2.copy(target).sub(headPos));
    let yaw = Math.atan2(local.x, Math.max(0.05, local.z));
    let pitch = Math.atan2(-local.y, Math.hypot(local.x, local.z));

    if (!ctx.gazeFresh) {
      // Spontaneous glances: mostly she looks at you, sometimes she looks away.
      const glance = this.idleGlance;
      glance.timer -= dt;
      if (glance.timer <= 0) {
        const away = Math.random() < 0.35;
        glance.yaw = away ? randomBetween(-0.5, 0.5) : 0;
        glance.pitch = away ? randomBetween(-0.12, 0.22) : 0;
        glance.timer = away ? randomBetween(0.8, 2) : randomBetween(2.5, 6);
      }
      yaw += glance.yaw + 0.05 * this.noise.headYaw(this.time);
      pitch += glance.pitch;
    }

    // Actions (looking around, thinking) can take over the gaze.
    const override = clamp(pose.gaze.weight, 0, 1);
    if (override > 0) {
      const ow = pose.gaze.weight;
      yaw += (pose.gaze.yaw / ow - yaw) * override;
      pitch += (pose.gaze.pitch / ow - pitch) * override;
    }
    yaw = clamp(yaw, -1.3, 1.3);
    pitch = clamp(pitch, -0.7, 0.7);

    // A big gaze shift usually comes with a blink.
    if (Math.abs(yaw - this.eyes.yaw) > 0.45 && Math.random() < 0.7) this.blinkRequested = true;
    this.eyes.yaw = yaw;
    this.eyes.pitch = pitch;

    // Microsaccades: small jumps of the eyes, still between one jump and the next.
    const saccade = this.saccade;
    saccade.timer -= dt;
    if (saccade.timer <= 0) {
      saccade.yaw = randomBetween(-0.03, 0.03);
      saccade.pitch = randomBetween(-0.02, 0.02);
      saccade.timer = randomBetween(0.4, 1.8);
    }

    // The head covers most of the angle, the eyes the rest.
    const headYaw = this.head.yaw.update(clamp(yaw, -0.8, 0.8), dt);
    const headPitch = this.head.pitch.update(clamp(pitch, -0.45, 0.45), dt);
    pose.add('upperChest', 0.1 * headPitch, 0.12 * headYaw, 0);
    pose.add('neck', 0.35 * headPitch, 0.3 * headYaw, 0);
    pose.add('head', 0.45 * headPitch, 0.43 * headYaw, -0.08 * headYaw);

    if (!ctx.gazeFresh) {
      pose.add('head', 0, 0, 0.03 * this.noise.headRoll(this.time));
    }

    // The eyes' target: one metre in front of the head, in the wanted direction.
    const eyeYaw = yaw + saccade.yaw;
    const eyePitch = pitch + saccade.pitch;
    const dir = this._fromCharacter(
      _v3.set(Math.sin(eyeYaw) * Math.cos(eyePitch), -Math.sin(eyePitch), Math.cos(eyeYaw) * Math.cos(eyePitch)),
    );
    this.lookTarget.position.copy(headPos).add(dir);
  }

  /** World direction -> character's space (VRM 1.0 conventions). */
  _toCharacter(vector) {
    this.vrm.scene.getWorldQuaternion(_q1).invert();
    vector.applyQuaternion(_q1);
    vector.x *= this.flip;
    vector.z *= this.flip;
    return vector;
  }

  _fromCharacter(vector) {
    vector.x *= this.flip;
    vector.z *= this.flip;
    this.vrm.scene.getWorldQuaternion(_q1);
    return vector.applyQuaternion(_q1);
  }

  // ----------------------------------------------------------- applying
  _applyForwardKinematics(pose) {
    const f = this.flip;

    // Fingers: resting bend, modulated by how open or closed the hand is; the
    // ones extended one by one (the V, the gun) straighten by their weight.
    for (const side of SIDES) {
      const curl = clamp(1 + pose.fingers[side], 0, 2.4);
      const extend = pose.extend[side];
      for (const [finger, bends] of Object.entries(FINGER_REST)) {
        const bend = curl * (1 - clamp(extend[finger] ?? 0, 0, 1));
        PHALANGES.forEach((phalanx, i) => pose.side(side, finger + phalanx, 0, 0, -bends[i] * bend));
      }
      // The V: index and middle spread like scissors.
      const spread = pose.spread[side];
      if (spread > EPSILON) {
        pose.side(side, 'IndexProximal', 0, 0.2 * spread, 0);
        pose.side(side, 'MiddleProximal', 0, -0.12 * spread, 0);
      }
      const thumb = curl * (1 - clamp(extend.Thumb ?? 0, 0, 1));
      pose.side(side, 'ThumbMetacarpal', 0, 0.2 * thumb, -0.05 * thumb);
      pose.side(side, 'ThumbProximal', 0, 0.25 * thumb, -0.08 * thumb);
      pose.side(side, 'ThumbDistal', 0, 0.2 * thumb, -0.05 * thumb);
    }

    for (const name of this.managed) {
      const node = this.bones[name];
      const value = pose.rot.get(name);
      if (value) node.rotation.set(value.x * f, value.y, value.z * f);
      else node.rotation.set(0, 0, 0);
    }

    const hips = this.bones.hips;
    hips.position.set(
      this.hipsRest.x + pose.hips.x * f,
      this.hipsRest.y + pose.hips.y,
      this.hipsRest.z + pose.hips.z * f,
    );
  }

  /**
   * The whole body's transform: dangling from the scruff, lying down, leaning
   * out from the screen edge. Each mode rotates around its pivot; during the
   * transitions the rotations blend according to the weights.
   */
  _applyRoot() {
    const rotation = _qRoot.identity();
    const position = _v8.set(0, 0, 0);
    let accumulated = 0;
    for (const mode of MODES) {
      const w = this.modeWeight[mode];
      if (w < 1e-4) continue;
      accumulated += w;
      const offset = this._rootTransform(mode, _qMode, _v4);
      // Incremental weighted average: slerp towards the new rotation in
      // proportion to its weight on the total accumulated so far.
      rotation.slerp(_qMode, w / accumulated);
      position.addScaledVector(offset, w);
    }
    // Twirls and "showing off": the whole body turns around the feet.
    if (Math.abs(this.pose.rootYaw) > 1e-4) rotation.multiply(_qMode.setFromAxisAngle(Y_AXIS, this.pose.rootYaw));
    this.root.quaternion.copy(rotation);
    this.root.position.copy(position);
  }

  /** Rotation `q` and translation of the group for a mode. */
  _rootTransform(mode, q, out) {
    let pivot = null;
    if (mode === 'held') {
      // Hanging from a single point she slowly turns on herself, and a bit more
      // when you move her: so she's seen in three-quarter view too.
      const twist = 0.42 * Math.sin(this.time * 0.7) + clamp(this.hold.vx * 0.0006, -0.35, 0.35);
      q.setFromEuler(_e1.set(HOLD_PITCH, twist, this.pendulum.angle));
      pivot = this.pivot;
    } else if (mode === 'edge') {
      q.setFromEuler(_e1.set(0, 0, this.edge.sign * EDGE_LEAN + 0.03 * Math.sin(this.time * 0.8)));
      pivot = this.edge.pivot;
    } else if (mode === 'lie') {
      q.setFromEuler(_e1.set(Math.PI / 2, 0, 0));
      pivot = this.lie.pivot;
    } else if (mode === 'side') {
      q.setFromEuler(_e1.set(0, 0, (this.side.sign * Math.PI) / 2));
      pivot = this.side.pivot;
    } else {
      q.identity();
      return out.set(0, 0, 0);
    }
    // Rotating around the pivot = rotating around the origin and then putting
    // the pivot back where it was.
    out.copy(pivot).sub(_v5.copy(pivot).applyQuaternion(q));
    if (mode === 'lie') out.add(this.lie.offset);
    if (mode === 'side') {
      out.y += this.side.lift;
      out.x -= this.side.sign * this.side.shift;
    }
    return out;
  }

  _applyInverseKinematics(pose) {
    this.rigRoot.updateWorldMatrix(true, true);
    const sceneMatrix = this.vrm.scene.matrixWorld;
    const sceneQuat = this.vrm.scene.getWorldQuaternion(_q5);

    // --- legs: feet planted where they were at rest, plus the shifts --------
    const legWeight = clamp(pose.legIK, 0, 1);
    if (legWeight > EPSILON) {
      for (const side of SIDES) {
        const chain = this.chains[`${side}Leg`];
        if (!chain) continue;
        const s = side === 'left' ? 1 : -1;
        const heel = pose.heel[side];
        const offset = pose.feet[side];
        // Raising the heel with the toe on the ground lifts the ankle.
        const target = this._rig(
          _v4,
          offset.x,
          offset.y + chain.footLength * Math.sin(heel),
          offset.z - chain.footLength * (1 - Math.cos(heel)),
        )
          .add(chain.restEnd)
          .applyMatrix4(sceneMatrix);
        const pole = this._fromCharacter(_v5.set(0.12 * s, 0, 1));
        const footQuat = _q4.setFromEuler(_e1.set(heel * this.flip, 0.06 * s, 0)).premultiply(sceneQuat);
        this._solveTwoBone(chain, target, pole, legWeight, footQuat);
        const toes = this.bones[`${side}Toes`];
        if (toes) toes.rotateX(-heel * this.flip * legWeight);
      }
    }

    // --- arms: the weighted average of the points requested by gestures and actions
    for (const side of SIDES) {
      const requests = pose.hands[side];
      const chain = this.chains[`${side}Arm`];
      if (!requests.length || !chain) continue;

      // The "base" hands (on the thighs, under the chin) give way to gestures.
      let override = 0;
      for (const request of requests) if (!request.base) override += request.weight;
      const baseScale = 1 - clamp(override, 0, 1);

      const target = _v4.set(0, 0, 0);
      const pole = _v5.set(0, 0, 0);
      let total = 0;
      let twist = 0;
      for (const request of requests) {
        const weight = request.base ? request.weight * baseScale : request.weight;
        if (weight <= EPSILON) continue;
        let point;
        if (request.world) {
          point = _v1.copy(request.world);
        } else {
          const [x, y, z] = request.offset;
          point = this._anchor(request.anchor).localToWorld(this._rig(_v1, x, y, z));
        }
        target.addScaledVector(point, weight);
        const [px, py, pz] = request.pole;
        pole.addScaledVector(this._fromCharacter(_v2.set(px, py, pz)), weight);
        twist += request.twist * weight;
        total += weight;
      }
      if (total <= EPSILON) continue;
      target.divideScalar(total);
      pole.normalize();
      const weight = Math.min(1, total);
      this._solveTwoBone(chain, target, pole, weight, null);
      // Forearm rotation on its axis: turns the palm.
      chain.lower.quaternion.multiply(_q4.setFromAxisAngle(X_AXIS, (twist / total) * this.flip * weight));
    }
  }

  /**
   * Analytic two-bone IK. It finds the middle joint's position (law of
   * cosines) on the plane containing the target and the `pole`, then builds
   * the rotations of the two segments from orthonormal bases: so there's no
   * ambiguity in the twist and the knee doesn't "spin".
   */
  _solveTwoBone(chain, target, pole, weight, endQuat) {
    const { upper, lower, end, l1, l2 } = chain;
    const root = upper.getWorldPosition(_v1);

    const dir = _v2.subVectors(target, root);
    let dist = dir.length();
    dir.divideScalar(dist || 1);
    dist = clamp(dist, Math.abs(l1 - l2) + 1e-4, (l1 + l2) * 0.9995);

    const bend = _v3.copy(pole).addScaledVector(dir, -pole.dot(dir));
    if (bend.lengthSq() < 1e-8) bend.set(0, 0, 1).addScaledVector(dir, -dir.z);
    bend.normalize();

    const cosA = clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1);
    const sinA = Math.sqrt(1 - cosA * cosA);
    const u1 = _v6.copy(dir).multiplyScalar(cosA).addScaledVector(bend, sinA);
    // u2 = (tip - elbow) normalized, with tip = root + dir*dist and elbow = root + u1*l1.
    const u2 = _v4.copy(dir).multiplyScalar(dist).addScaledVector(u1, -l1).normalize();
    const normal = _v5.crossVectors(dir, bend).normalize();

    const world1 = basisQuat(u1, normal, _q1).multiply(chain.restInv1);
    const world2 = basisQuat(u2, normal, _q2).multiply(chain.restInv2);

    const parent = upper.parent.getWorldQuaternion(_q3).invert();
    upper.quaternion.slerp(parent.multiply(world1), weight);
    const local2 = _q3.copy(world1).invert().multiply(world2);
    lower.quaternion.slerp(local2, weight);
    if (endQuat) {
      const local3 = world2.invert().multiply(endQuat);
      end.quaternion.slerp(local3, weight);
    }
  }

  _updateExpressions(pose, dt) {
    for (const mood of MOODS) {
      const target = clamp(pose.expr[mood], 0, 1);
      const rate = target > this.expressions[mood] ? 6 : 3;
      this.expressions[mood] = damp(this.expressions[mood], target, rate, dt);
    }
  }
}
