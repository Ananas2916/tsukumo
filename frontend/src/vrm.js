/**
 * 3D stage: Three.js + @pixiv/three-vrm.
 *
 * Responsibilities:
 *  - create scene, lights, camera and render loop;
 *  - load a `.vrm` model (VRM 0.x or VRM 1.0);
 *  - work out how to drive the mouth (preset expressions or `fcl_mth_*`
 *    morph targets) and apply the weights computed by the lip-sync;
 *  - pass to the body (see body.js) what happens around: where the cursor
 *    is, whether it's speaking, whether you're holding it, whether it falls;
 *  - blinking and facial expressions;
 *  - the flame (flame.js), who is Tsukumo: the VRM is an optional body she
 *    can wear, and the switch between the two ("enter the body", "leave the
 *    body") is directed by this class.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

import { BodyAnimator } from './body.js';
import { ClipPlayer } from './clips.js';
import { DEFAULT_BLENDSHAPES, VISEME_KEYS } from './config.js';
import { DROP, Flame, FLAME_HEIGHT } from './flame.js';
import { HoloPanel } from './holo.js';
import { t } from './i18n.js';
/** Facial expressions driven by the body (mood, fright, smile...). */
const MOOD_EXPRESSIONS = ['happy', 'relaxed', 'surprised', 'sad', 'angry'];

/** After how many seconds of still cursor she stops following it and looks at you. */
const GAZE_ATTENTION = 4;

/** Fraction of the character's height framed by default (head + torso). */
const FRAME_HEIGHT = 0.5;

/** Full figure: framed height, with room above for raised arms. */
const FULL_FRAME = 1.24;

/** Typical shoulder width of a VRM avatar, in metres. */
const SHOULDER_SPAN = 0.55;

/** The flame's reactions the body renders with a gesture of its own (body/actions.js). */
const VRM_STAND_IN = { cheer: 'showOff', hearts: 'peace', cool: 'model', sing: 'hum', surprise: 'lookAround', speechless: 'pout', hop: 'squat', gust: 'shiver' };

/** Without a body the flame is framed as if there were a model this tall (m). */
const SPIRIT_MODEL_HEIGHT = 1.6;

/**
 * Frames per second according to what she's doing. The character is always
 * on screen: drawing her at 144 Hz while she just breathes heats the laptop
 * and drains the battery for nothing. Breathing at 30 fps looks the same;
 * speaking, being held or following the mouse instead want 60.
 */
const FPS = { active: 60, calm: 30, asleep: 20 };

/** Form change, in seconds: when the flame reaches the chest and when everything ends. */
const INTO_BODY = { arrive: 0.5, end: 1.45 };
const OUT_OF_BODY = { dissolve: 0.7, end: 1.1 };
/** "Off" clipping plane: high enough not to cut anything. */
const NO_CLIP = 1e4;

const smooth = (k) => {
  const x = Math.min(1, Math.max(0, k));
  return x * x * (3 - 2 * x);
};
const easeOutCubic = (k) => 1 - Math.pow(1 - Math.min(1, Math.max(0, k)), 3);
const easeOutBack = (k) => {
  const x = Math.min(1, Math.max(0, k)) - 1;
  return 1 + 2.7 * x * x * x + 1.7 * x * x;
};

export class VrmStage {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{blendshapes?: object}} [options]
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.blendshapes = options.blendshapes ?? DEFAULT_BLENDSHAPES;

    this.vrm = null;
    /** Body animation (body.js), created at every model load. */
    this.body = null;
    this.mouthDriver = { kind: 'none' };
    this.blinkDriver = { kind: 'none' };
    this.moodExpressions = [];

    this.clock = new THREE.Clock();
    this.elapsed = 0;
    this.blinkTimer = 2 + Math.random() * 3;
    this.blinkValue = 0;

    // Gaze: the body decides where to look, the eyes follow this target.
    this.lookTarget = new THREE.Object3D();
    /** Cursor in pixels relative to the window, even outside its edges. */
    this.gazePx = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    this._pointerMovedAt = -Infinity;
    this._gazePoint = new THREE.Vector3();

    /** State the body reads every frame. */
    this._speech = { playing: false, level: 0 };
    this._thinking = false;
    this._working = null;
    this._listening = false;
    this._music = null;
    /** The flame's menu is open (it makes her light up). */
    this._menu = false;
    /** The flame's slot in the open island (window pixels), or null. */
    this._menuSlot = null;
    /** A file dragged over her: mouth open, ready to eat it. */
    this._hungry = false;
    /** Last window position while it flies thrown (see flyMove). */
    this._flyAt = null;

    /** 'vrm' (the character) or 'flame' (the flame, flame.js). */
    this.form = 'vrm';
    /** Without a body: just the flame, the VRM isn't loaded (see useSpirit). */
    this.spiritOnly = false;
    this.floorY = 0;
    /** Form change in progress: `{to, t, fired}`. */
    this._morph = null;
    /** Clips the VRM at the plane's height: makes it appear from the feet or vanish from the head. */
    this._clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), NO_CLIP);
    /** Last window position during the sprint, so the trail stays behind. */
    this._sprintX = null;
    this._spontaneous = true;
    this._dancing = true;
    this._sleep = 0;

    // --- mascot mode (Electron) -------------------------------------------
    /** If set, the wheel calls this instead of zooming the camera. */
    this.onWheelScale = null;
    /** Receives the window's anchors (feet, seat, body axis). */
    this.onAnchors = null;
    /** The body wants to sit/lie down/stand up on the taskbar. */
    this.onPostureRequest = null;
    /** An animated form change ended: receives the new form. */
    this.onMorphEnd = null;
    this._anchorsDirty = false;

    // "Light" camera controls (no OrbitControls: these are enough for us).
    this.orbit = { yaw: 0, targetYaw: 0, distance: 1.4, targetDistance: 1.4, height: 0 };
    /** Framing distance computed at load; the zoom is a factor. */
    this.baseDistance = 1.4;
    this.modelHeight = 0;
    this.dragging = false;
    this.lastPointer = { x: 0, y: 0 };

    this.frameCallbacks = new Set();
    this.fps = 0;
    this._fpsAccumulator = 0;
    this._fpsFrames = 0;
    this._animationId = null;

    // --- desktop "pet" mode ----------------------------------------------
    /** In pet mode dragging moves the window, not the camera. */
    this.dragEnabled = true;
    /** Framing: 'bust' (half bust) or 'full' (full figure). */
    this.framing = 'bust';
    /** Pointer position in pixels: needed for the per-pixel alpha test. */
    this.pointerPx = { x: -1, y: -1 };
    this._pixelBuffer = new Uint8Array(4);
    /** true when the cursor is really over an opaque pixel of the character. */
    this.pointerOnAvatar = false;

    this._initRenderer();
    this._initScene();
    this._bindEvents();
  }

  // ------------------------------------------------------------------ setup
  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true, // essential for Electron's transparent window
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Neutral (Khronos PBR Neutral) and not ACES: ACES desaturates and shifts
    // hues, and on MToon materials it dulled coloured hair and skin; without
    // tone mapping instead the whites burn. Neutral keeps the model's colours
    // and compresses only the strong lights.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1;
    // The form change's clipping plane applies only to the VRM's materials.
    this.renderer.localClippingEnabled = true;
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.add(this.lookTarget);
    this.holo = new HoloPanel(this.scene);

    this.camera = new THREE.PerspectiveCamera(28, 1, 0.05, 40);
    this.cameraTarget = new THREE.Vector3(0, 1.35, 0);
    this.camera.position.set(0, 1.35, 0.9);

    // Three lights: warm key in front, cold fill behind, ambient.
    const key = new THREE.DirectionalLight(0xfff2e0, 2.1);
    key.position.set(1.2, 2.0, 1.8);
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0x9ec7ff, 1.1);
    rim.position.set(-1.6, 1.4, -1.5);
    this.scene.add(rim);

    this.scene.add(new THREE.HemisphereLight(0xdfe7ff, 0x30364a, 1.25));

    this.shadow = this._createShadow();
    this.scene.add(this.shadow);

    this.flame = new Flame(this.scene);
    // The ring running along the body while it appears or vanishes.
    this._scanRing = new THREE.Mesh(
      new THREE.RingGeometry(0.92, 1, 72),
      new THREE.MeshBasicMaterial({ color: 0xa58bff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
    );
    this._scanRing.rotation.x = -Math.PI / 2;
    this._scanRing.visible = false;
    this.scene.add(this._scanRing);

    this._resize();
  }

  /**
   * Soft shadow under the feet: it rests her on the desktop instead of
   * letting her float. A blurred disc and not a real shadow: it costs nothing,
   * and the transparent window has no floor to cast it on.
   */
  _createShadow() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(8, 10, 20, 0.34)');
    gradient.addColorStop(0.55, 'rgba(8, 10, 20, 0.16)');
    gradient.addColorStop(1, 'rgba(8, 10, 20, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 128, 128);
    const texture = new THREE.CanvasTexture(canvas);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = -1;
    mesh.visible = false;
    mesh.frustumCulled = false;
    return mesh;
  }

  /** The shadow follows the hips; it fades when she sits, lies down, is picked up or jumps. */
  _updateShadow() {
    if (this.form === 'flame' && !this.avatarRoot?.visible) {
      const { x, z, size, opacity } = this.flame.shadow;
      this.shadow.visible = opacity > 0.01 && size > 0.001;
      this.shadow.position.set(x, this.floorY + 0.002, z);
      this.shadow.scale.set(size, size * 0.55, 1);
      this.shadow.material.opacity = opacity;
      return;
    }
    const body = this.body;
    const hips = this.vrm?.humanoid?.getRawBoneNode('hips');
    const weight = body ? body.modeWeight.stand : 0;
    if (!hips || weight < 0.02 || !this._hipsRestY) {
      this.shadow.visible = false;
      return;
    }
    const position = hips.getWorldPosition(this._shadowPoint ?? (this._shadowPoint = new THREE.Vector3()));
    // The higher the hips go above rest (a hop, a raised foot), the more the shadow shrinks.
    const lift = Math.max(0, Math.min(1, (position.y - this._hipsRestY) / (0.35 * this._hipsRestY)));
    const size = this._hipsRestY * (1 - 0.35 * lift);
    this.shadow.visible = true;
    this.shadow.position.set(position.x, 0.002, position.z);
    this.shadow.scale.set(size * 0.62, size * 0.34, 1);
    this.shadow.material.opacity = weight * (1 - 0.6 * lift);
  }

  _bindEvents() {
    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);

    // Gaze following the mouse over the whole window.
    this._onPointerMove = (event) => {
      this.setPointer(event.clientX, event.clientY, true);
      if (this.dragging && this.dragEnabled) {
        const dx = event.clientX - this.lastPointer.x;
        const dy = event.clientY - this.lastPointer.y;
        this.orbit.targetYaw -= dx * 0.006;
        this.orbit.height = THREE.MathUtils.clamp(this.orbit.height + dy * 0.0016, -0.3, 0.35);
        this.lastPointer = { x: event.clientX, y: event.clientY };
      }
    };
    window.addEventListener('pointermove', this._onPointerMove);
    // With setIgnoreMouseEvents(..., {forward: true}) Electron forwards the
    // native mouse messages: they arrive as 'mousemove', not as pointer events.
    // Without this second listener, in click-through mode we wouldn't know
    // where the cursor is any more.
    window.addEventListener('mousemove', this._onPointerMove);

    this._onPointerDown = (event) => {
      // Dragging only on the canvas: the UI panels stay clickable.
      if (event.target !== this.canvas || !this.dragEnabled) return;
      this.dragging = true;
      this.lastPointer = { x: event.clientX, y: event.clientY };
      this.canvas.setPointerCapture?.(event.pointerId);
    };
    this._onPointerUp = () => {
      this.dragging = false;
    };
    this.canvas.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointerup', this._onPointerUp);

    this._onWheel = (event) => {
      if (event.target !== this.canvas) return;
      event.preventDefault();
      // In Electron the zoom enlarges the window, not the camera: with the camera
      // the character went past the edges and got cut.
      if (this.onWheelScale) {
        this.onWheelScale(Math.exp(-event.deltaY * 0.0012));
        return;
      }
      // Multiplicative zoom and limits relative to the starting framing: so it
      // behaves the same with models of different heights.
      this.orbit.targetDistance = THREE.MathUtils.clamp(
        this.orbit.targetDistance * (1 + event.deltaY * 0.0009),
        this.baseDistance * 0.3,
        this.baseDistance * 4,
      );
    };
    this.canvas.addEventListener('wheel', this._onWheel, { passive: false });
  }

  _resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.setSize(width, height, false);
    // Widened on one side only (the island near the screen edge): we frame a
    // wider view and show the right part of it, so she stays where she was and
    // only the window around her changes.
    const shift = this._frameShift ?? 0;
    if (shift) {
      const full = width + 2 * Math.abs(shift);
      this.camera.aspect = full / Math.max(1, height);
      this.camera.setViewOffset(full, height, Math.abs(shift) - shift, 0, width, height);
    } else {
      this.camera.aspect = width / Math.max(1, height);
      this.camera.clearViewOffset();
    }
    this.camera.updateProjectionMatrix();
    // Changing the window's proportions also changes the needed distance: we
    // recompute it keeping the zoom chosen by the user.
    this._reframeForAspect();
    this._anchorsDirty = true;
  }

  _reframeForAspect() {
    if (!this.modelHeight) return;
    const zoom = this.baseDistance ? this.orbit.targetDistance / this.baseDistance : 1;
    const span = this.framing === 'full' ? this.modelHeight * FULL_FRAME : this.modelHeight * FRAME_HEIGHT;
    this.baseDistance = this._distanceFor(span);
    this.orbit.targetDistance = this.baseDistance * zoom;
  }

  /** Opaque background (handy in the browser) or transparent (Electron). */
  setBackgroundVisible(visible) {
    this.renderer.setClearAlpha(visible ? 1 : 0);
    this.renderer.setClearColor(0x11141f, visible ? 1 : 0);
  }

  // ------------------------------------------------------------------- load
  /**
   * Loads a VRM model from a URL (or from a blob URL created from a File).
   * @param {string} url
   * @param {(progress: number) => void} [onProgress] 0..1
   */
  async load(url, onProgress) {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    const gltf = await loader.loadAsync(url, (event) => {
      if (onProgress && event.total) onProgress(event.loaded / event.total);
    });

    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error(t('The file has no valid VRM data.'));

    this._disposeVrm();
    // A body again: the flame can go back into it.
    this.spiritOnly = false;

    // Optimizations recommended by three-vrm.
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    // VRM 0.x models face +Z: we turn them so the face is towards the camera.
    VRMUtils.rotateVRM0(vrm);

    vrm.scene.traverse((object) => {
      // Avatars are always in frame: culling costs more than it gives.
      object.frustumCulled = false;
      // The form change's plane, assigned right away: adding it later would
      // recompile the MToon shaders and the transition would start with hiccups.
      if (!object.isMesh) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        material.clippingPlanes = [this._clipPlane];
      }
    });

    // The VRM goes into a group of its own: so we can make it dangle around the
    // grab point without touching vrm.scene.rotation, which for VRM 0.x models
    // is already used by rotateVRM0 (we would overwrite it).
    this.avatarRoot = new THREE.Group();
    this.avatarRoot.add(vrm.scene);
    this.scene.add(this.avatarRoot);
    this.vrm = vrm;

    this.body = new BodyAnimator(vrm, this.avatarRoot, this.lookTarget);
    this.body.setThinking(this._thinking);
    if (this._stance) this.body.setStance(this._stance);
    this.body.spontaneous = this._spontaneous;
    this.body.dancing = this._dancing;
    this.body.setSleep(this._sleep);
    this.body.onPostureRequest = (posture) => this.onPostureRequest?.(posture);
    // .vrma clips (see clips.js): now and then instead of a spontaneous gesture.
    this.clips = new ClipPlayer(vrm, this.body.managed);
    this.body.onIdleClip = () => this.body.mode === 'stand' && this.clips.playRole('idle');
    this.body.isClipPlaying = () => this.clips.playing;
    if (this._clipList) this.clips.load(this._clipList);
    this.mouthDriver = this._detectMouthDriver(vrm);
    this.blinkDriver = this._detectBlinkDriver(vrm);
    this.moodExpressions = MOOD_EXPRESSIONS.filter((name) => vrm.expressionManager?.getExpression(name));

    if (vrm.lookAt) vrm.lookAt.target = this.lookTarget;

    this._frameCamera();
    this._anchorsDirty = true;
    // Height of the hips at rest: sizes the shadow on any model.
    vrm.scene.updateMatrixWorld(true);
    this._hipsRestY = vrm.humanoid?.getRawBoneNode('hips')?.getWorldPosition(new THREE.Vector3()).y ?? 0;
    // The flame measures herself on the model: where the feet would be, about a third as tall.
    this.flame.setHeight(this.modelHeight * FLAME_HEIGHT);
    this.flame.home.set(this.cameraTarget.x, this.floorY, 0);
    this._morph = null;
    this._applyForm();
    return vrm;
  }

  // ------------------------------------------------------------------- form
  /**
   * 'vrm' or 'flame'. With `animate` the flame enters the body (or leaves it);
   * without, it just changes (at startup). False if it's already changing.
   */
  setForm(form, { animate = true } = {}) {
    const next = form === 'flame' ? 'flame' : 'vrm';
    if (this._morph || next === this.form) return false;
    // Without a body there's nowhere to enter: first the VRM loads (load), then she enters.
    if (next === 'vrm' && this.spiritOnly) return false;
    this.form = next;
    this._anchorsDirty = true;
    if (!animate || !this.vrm) this._applyForm();
    else this._morph = { to: next, t: 0, fired: false };
    return true;
  }

  get morphing() {
    return Boolean(this._morph);
  }

  /** There's something to show: a VRM, or the flame alone. */
  get framed() {
    return Boolean(this.vrm) || this.spiritOnly;
  }

  /**
   * Without a body: just the flame, and the VRM isn't even loaded (less memory
   * and GPU). She's framed as if there were a model of average height: window,
   * physics and per-pixel click stay the same, because the framing is
   * proportional to the height. If a VRM was there, it's unloaded.
   */
  useSpirit() {
    this._morph = null;
    this.form = 'flame';
    this.spiritOnly = true;
    this.clips?.stop();
    this._disposeVrm();
    this.clips = null;
    this._frameSpirit();
    this._anchorsDirty = true;
    this._applyForm();
  }

  _frameSpirit() {
    this.modelHeight = SPIRIT_MODEL_HEIGHT;
    this.floorY = 0;
    // Always full figure: the flame sits where the feet would be.
    const span = this.modelHeight * FULL_FRAME;
    this.cameraTarget.set(0, span / 2 - this.modelHeight * 0.015, 0);
    this.baseDistance = this._distanceFor(span);
    this.orbit.targetDistance = this.baseDistance;
    this.orbit.distance = this.baseDistance;
    this.orbit.yaw = 0;
    this.orbit.targetYaw = 0;
    this.orbit.height = 0;
    this.flame.setHeight(this.modelHeight * FLAME_HEIGHT);
    this.flame.home.set(0, this.floorY, 0);
  }

  /** A clean switch: one form visible, the other not, no clipping. */
  _applyForm() {
    const flame = this.form === 'flame';
    if (this.avatarRoot) this.avatarRoot.visible = !flame;
    this.flame.root.visible = flame && this.framed;
    this.flame.travel = 0;
    this.flame.presence = 1;
    this._clipPlane.constant = NO_CLIP;
    this._scanRing.visible = false;
    if (flame) this.clips?.stop();
  }

  /** The VRM's chest, where the flame enters and leaves. */
  _chestPoint(target) {
    const bone = this.vrm?.humanoid?.getNormalizedBoneNode('upperChest') ?? this.vrm?.humanoid?.getNormalizedBoneNode('chest');
    if (bone) return bone.getWorldPosition(target);
    return target.set(this.cameraTarget.x, this.floorY + this.modelHeight * 0.68, 0);
  }

  /**
   * The form change's choreography.
   * Into the body: the flame rises to the chest and shrinks, flash and rings,
   * the VRM appears from the feet to the head. Out of the body: flash at the
   * chest, the VRM vanishes from the head to the feet and the flame comes down.
   */
  _updateMorph(dt) {
    const morph = this._morph;
    if (!morph) return;
    morph.t += dt;
    const k = morph.t;
    const flame = this.flame;
    const bottom = this.floorY - 0.02;
    const top = this.floorY + this.modelHeight * 1.05;
    this._morphChest ??= new THREE.Vector3();
    const chest = this._chestPoint(this._morphChest);
    flame.chest.copy(chest);
    const burst = () => {
      flame.fx.flash(chest, 3 * flame.size);
      flame.fx.ring(chest, { to: 1.1 * flame.size });
      flame.fx.ring(chest, { to: 0.7 * flame.size, delay: 0.12 });
      flame.fx.ring(new THREE.Vector3(chest.x, this.floorY + 0.003, chest.z), { lying: true, to: 0.8 * flame.size, life: 1, delay: 0.1 });
    };

    let cut;
    if (morph.to === 'vrm') {
      const { arrive, end } = INTO_BODY;
      flame.travel = smooth(k / arrive);
      flame.presence = k < arrive ? 1 - 0.85 * flame.travel : Math.max(0, 0.15 * (1 - (k - arrive) / 0.1));
      flame.root.visible = flame.presence > 0.001;
      if (k >= arrive && !morph.fired) {
        morph.fired = true;
        burst();
        this.avatarRoot.visible = true;
      }
      cut = k < arrive ? bottom : bottom + (top - bottom) * easeOutCubic((k - arrive) / (end - arrive - 0.05));
      if (k >= end) {
        this._morph = null;
        this._applyForm();
        this.onMorphEnd?.(this.form);
        return;
      }
    } else {
      const { dissolve, end } = OUT_OF_BODY;
      if (!morph.fired) {
        morph.fired = true;
        burst();
        flame.root.visible = true;
      }
      cut = top + (bottom - top) * smooth(k / dissolve);
      if (k >= dissolve) this.avatarRoot.visible = false;
      const back = Math.min(1, Math.max(0, (k - 0.15) / 0.8));
      flame.travel = 1 - easeOutCubic(back);
      flame.presence = 0.15 + 0.85 * easeOutBack(back);
      if (k >= end) {
        this._morph = null;
        this._applyForm();
        this.onMorphEnd?.(this.form);
        return;
      }
    }
    this._clipPlane.constant = cut;
    // The ring of light on the clipping edge, while the body is halfway.
    const visible = this.avatarRoot?.visible && cut > bottom + 0.01 && cut < top - 0.01;
    this._scanRing.visible = Boolean(visible);
    if (visible) {
      const radius = this.modelHeight * 0.17;
      this._scanRing.position.set(chest.x, cut, chest.z);
      this._scanRing.scale.setScalar(radius);
    }
  }

  // ------------------------------------------------------------ the flame's sprint
  /** Sprint phase from Electron's physics (ready, go, brake, proud, end). */
  setSprint(phase, dir) {
    this.flame.sprint(phase, dir);
    if (phase !== 'go' && phase !== 'brake') this._sprintX = null;
  }

  /** The window advanced to `x` (screen pixels): the trail stays behind. */
  sprintMove(x, speed) {
    this.flame.sprintSpeed(speed);
    if (this._sprintX !== null) this.flame.drift(-(x - this._sprintX) * this.metersPerPixel);
    this._sprintX = x;
  }

  // ------------------------------------------------------------ throwing the flame
  /** You threw her (horizontal speed in px/s): she flies with the trail. */
  flyStart(vx) {
    if (this.form !== 'flame') return;
    this.flame.fly(vx);
    this._flyAt = null;
  }

  /** The window in flight got to (x, y), screen pixels: the trail stays on the desktop. */
  flyMove(x, y) {
    const now = performance.now();
    if (this._flyAt) {
      const mpp = this.metersPerPixel;
      this.flame.drift(-(x - this._flyAt.x) * mpp, (y - this._flyAt.y) * mpp);
      this.flame.flyStep(x - this._flyAt.x, y - this._flyAt.y, (now - this._flyAt.at) / 1000);
    }
    this._flyAt = { x, y, at: now };
  }

  /** She bumped into the screen edge. */
  bonk(side, impact) {
    if (this.form === 'flame') this.flame.bonk(side === 'right' ? 1 : side === 'left' ? -1 : 0, impact);
  }

  /** The flame's colour (flame/palettes.js: a name or a "#rrggbb"). */
  setFlamePalette(name) {
    this.flame.setPalette(name);
  }

  /** What the flame wears (flame/wardrobe.js, already resolved: no "auto"). */
  setFlameOutfit(name) {
    this.flame.setOutfit(name);
  }

  /**
   * How many pixels right of the window's centre she must be (0: centred).
   * The main process sends it when it widens the window for the island on one
   * side only; it applies from the next resize (or right away if the window
   * doesn't change).
   */
  setFrameShift(px) {
    const shift = Number.isFinite(px) ? Math.round(px) : 0;
    if (shift === (this._frameShift ?? 0)) return;
    this._frameShift = shift;
    this._resize();
  }

  /**
   * The flame's menu opens or closes. With `slot` (window pixels: the place
   * left of the island's card) she slides into it.
   */
  setMenu(open, slot = null) {
    this._menu = Boolean(open);
    this._menuSlot = open && slot ? slot : null;
  }

  /** How much to move and shrink the flame so she fits entirely in the card's slot. */
  _menuPose(slot) {
    const mpp = this.metersPerPixel;
    const { UNIT, R } = DROP;
    const size = this.flame.size;
    // What she wears counts: a hat makes her taller, the lantern wider on the right.
    const top = this.flame.wardrobe.top;
    const right = this.flame.wardrobe.right;
    const fit = Math.min((slot.h * 0.86 * mpp) / ((UNIT + top) * size), (slot.w * 0.86 * mpp) / ((R + right) * size), 1);
    this._restCenter ??= new THREE.Vector3();
    const rest = this._toScreen(this.flame.restCenterWorld(this._restCenter));
    // The drop, from the bottom of the bulb to the tip (or the hat), sits in the middle of the slot: the bulb a bit lower.
    const below = (((UNIT + top - 2 * R) / 2) * size * fit) / mpp;
    const x = slot.x + slot.w / 2 - (((right - R) / 2) * size * fit) / mpp;
    const y = slot.y + slot.h / 2 + below;
    return { dx: (x - rest.x) * mpp, dy: -(y - rest.y) * mpp, scale: fit };
  }

  /** You're typing in the chat: for a moment she's all ears, and nods at every key. */
  userTyping() {
    this._typingUntil = performance.now() + 1500;
    if (this.form === 'flame') this.flame.keystroke();
  }

  /** A file dragged over her (true) or gone (false). */
  setHungry(value) {
    this._hungry = Boolean(value);
  }

  /**
   * A gesture by name. The VRM does it with the body (body.js); the flame her
   * own way, if she can. Reactions born for the flame (hearts, sunglasses,
   * party...) are rendered by the body with the closest gesture. False if it
   * didn't start.
   */
  play(name, options) {
    if (this.form === 'flame' || this._morph) return this.flame.react(name);
    return this.body?.play(VRM_STAND_IN[name] ?? name, options) ?? false;
  }

  /** Really asleep (for the "z"s). */
  get asleep() {
    if (this.form === 'flame') return this._sleep >= 0.99;
    return Boolean(this.body?.asleep);
  }

  /** The user is talking to her (the microphone hears the voice). */
  setListening(value) {
    this._listening = Boolean(value);
  }

  /** Waves her hand (she does it when she appears). */
  greet() {
    if (this.form === 'flame') {
      this.flame.react('greet');
      return;
    }
    if (this.body?.mode === 'stand' && this.clips?.playRole('greet')) return;
    // Now and then she peeks up from below waving with both hands (body/booth.js).
    if (this.body?.mode === 'stand' && Math.random() < 0.35 && this.body.play('greetPop', { sign: -1 })) return;
    this.body?.play('wave', { sign: -1 });
  }

  /** The available .vrma clips (from the backend): loaded on the current model and on the next ones. */
  setClipList(list) {
    this._clipList = list ?? [];
    return this.clips ? this.clips.load(this._clipList) : Promise.resolve([]);
  }

  /** Plays a clip on request (from the panel). */
  playClip(name) {
    if (this.form === 'flame' || !this.clips || !['stand', 'sit'].includes(this.body?.mode)) return false;
    return this.clips.play(name);
  }

  /** A clip for a moment (`bow` at a thank-you, `here` when you call her), if there is one and she's standing. */
  playClipRole(role) {
    if (this.form === 'flame') return this.flame.react(role === 'here' ? 'greet' : 'pat');
    if (!this.clips || this.body?.mode !== 'stand' || this.clips.playing) return false;
    return this.clips.playRole(role);
  }

  _disposeVrm() {
    if (!this.vrm) return;
    if (this.avatarRoot) {
      this.scene.remove(this.avatarRoot);
      this.avatarRoot = null;
    } else {
      this.scene.remove(this.vrm.scene);
    }
    VRMUtils.deepDispose(this.vrm.scene);
    this.vrm = null;
    this.body = null;
    this.mouthDriver = { kind: 'none' };
    this.blinkDriver = { kind: 'none' };
  }

  // ---------------------------------------------------------- "pet" mode
  /**
   * Framing: half bust (nice for the lip-sync) or full figure (the look of a
   * mascot walking on the desk).
   * @param {'bust'|'full'} mode
   */
  setFraming(mode) {
    this.framing = mode === 'full' ? 'full' : 'bust';
    if (this.vrm) this._frameCamera();
    else if (this.spiritOnly) this._frameSpirit();
  }

  /**
   * Cursor position in pixels relative to the window. It can be outside the
   * edges too (in Electron we always know it): the character follows it with
   * her gaze wherever it is on the screen, but the pixel test for the
   * click-through only applies inside the window.
   */
  setPointer(x, y, inside) {
    if (Math.abs(x - this.gazePx.x) + Math.abs(y - this.gazePx.y) > 1.5) {
      this._pointerMovedAt = this.elapsed;
    }
    this.gazePx.x = x;
    this.gazePx.y = y;
    this.pointerPx.x = inside ? x : -1;
    this.pointerPx.y = inside ? y : -1;
  }

  /** Audio playing and instantaneous volume, read by the body every frame. */
  setSpeech(playing, level) {
    this._speech.playing = playing;
    this._speech.level = level;
  }

  /** A sentence starts: the body chooses gesture, mood and attitude. */
  startClip(payload) {
    this.body?.onClipStart(payload);
  }

  /** The backend is waiting for the LLM: thoughtful pose. */
  setThinking(value) {
    this._thinking = Boolean(value);
    if (!this._thinking) this._working = null;
    this.body?.setThinking(this._thinking);
  }

  /** How she stands (body/stances.js): it stays chosen even when the model changes. */
  setStance(name) {
    this._stance = name;
    this.body?.setStance(name);
  }

  /** The agent uses a tool (`read`, `write`, `run`...): work pose instead of thoughtful. */
  setWorking(kind) {
    this._working = kind || null;
    this.body?.setWorking(kind);
  }

  /**
   * Picked up with the mouse: she dangles from the scruff. Returns how many
   * pixels to move the window so the scruff ends up under the cursor (px, py),
   * whatever point of the body was grabbed. The flame is picked up by the bulb.
   */
  beginHold(px, py) {
    if (this.form === 'flame') {
      this.flame.setHeld(true);
      const center = this._toScreen(this.flame.centerWorld());
      return { x: px - center.x, y: py - center.y };
    }
    if (!this.body) return { x: 0, y: 0 };
    this.body.beginHold();
    const nape = this._toScreen(this.body.restPoint('nape'));
    return { x: px - nape.x, y: py - nape.y };
  }

  /** Where the dragged window is now, in screen pixels. */
  moveHold(screenX, screenY) {
    if (this.form === 'flame') this.flame.moveHold(screenX);
    else this.body?.moveHold(screenX, screenY);
  }

  endHold() {
    this.flame.setHeld(false);
    this.body?.endHold();
  }

  setFalling() {
    // The hidden body keeps count too: when it comes back it knows whether it's standing or sitting.
    this.body?.setFalling();
    if (this.form === 'flame') this.flame.fall();
  }

  /**
   * @param {number} impact 0..1, how hard she arrived
   * @param {'stand'|'sit'} posture standing on the taskbar or sitting on a window
   */
  landed(impact, posture = 'stand') {
    this.body?.landed(impact, posture);
    if (this.form === 'flame') this.flame.land(impact);
    else this.flame.falling = false;
  }

  /** Sitting, lying down (face down or on her side) or standing on the taskbar. */
  setPosture(posture) {
    // On her side the head goes towards the middle of the screen, where there's room.
    const middle = window.screenX + window.innerWidth / 2;
    const screenMiddle = (window.screen.availLeft ?? 0) + window.screen.availWidth / 2;
    this.body?.setPosture(posture, middle > screenMiddle ? 1 : -1);
  }

  /** The music's rhythm (see music.js), every frame. */
  setMusic(state) {
    this._music = this._dancing ? state : null;
    this.body?.setMusic(state);
    // With a dance*.vrma clip she dances that one, looped, while the music plays.
    const clips = this.clips;
    if (!clips) return;
    const dancing = state?.active && this._dancing && this.form === 'vrm' && this.body?.mode === 'stand';
    const current = clips.active?.clip;
    if (dancing && !current && clips.has('dance')) clips.playRole('dance', { loop: true });
    else if (!dancing && current?.role === 'dance' && !clips.active.stopping) clips.stop();
  }

  /** Dancing to the music can be turned off from the panel. */
  setDancing(value) {
    this._dancing = Boolean(value);
    if (this.body) this.body.dancing = this._dancing;
  }

  /**
   * Clinging to the screen edge: `edgeRatio` is the edge's position in the
   * window, as a fraction of the width.
   */
  setEdge(side, edgeRatio) {
    if (!this.body) return;
    const px = edgeRatio * window.innerWidth;
    const edge = this._rayToPlane(px, window.innerHeight / 2, this.cameraTarget, new THREE.Vector3());
    this.body.setEdge(side, edge.x);
  }

  /** The window she's sitting on is moving (screen pixels). */
  carried(x, y) {
    this.body?.carried(x, y);
  }

  /** Spontaneous gestures and posture changes, from the panel. */
  setSpontaneous(value) {
    this._spontaneous = Boolean(value);
    this.flame.spontaneous = this._spontaneous;
    if (this.body) this.body.spontaneous = this._spontaneous;
  }

  /** Sleep: 0 awake, 0.5 drowsy, 1 asleep (see presence.js). */
  setSleep(level) {
    this._sleep = level;
    this.body?.setSleep(level);
  }

  /** Where the head is, in window pixels: the sleep "z"s rise from there. */
  headScreen() {
    if (this.form === 'flame' && this.framed) return this._toScreen(this.flame.topWorld());
    const head = this.vrm?.humanoid.getNormalizedBoneNode('head');
    if (!head) return null;
    this._headPoint ??= new THREE.Vector3();
    return this._toScreen(head.getWorldPosition(this._headPoint));
  }

  /**
   * Where feet, seat and body axis are in the window, as fractions of its
   * size: Electron needs them to set her on the taskbar or on a window's
   * edge. With proportional framing they don't change with the scale.
   */
  _computeAnchors() {
    if (this.form === 'flame') {
      // The flame rests on her bottom: feet and seat coincide (on a window she sits on top).
      const base = this._toScreen(this.flame.home.clone());
      return { feet: base.y / window.innerHeight, seat: base.y / window.innerHeight, center: base.x / window.innerWidth };
    }
    const body = this.body;
    const hips = body.restPoint('hips');
    const feet = this._toScreen(new THREE.Vector3(hips.x, this.floorY, hips.z));
    const seat = this._toScreen(body.restPoint('seat'));
    const center = this._toScreen(hips.clone());
    return {
      feet: feet.y / window.innerHeight,
      seat: seat.y / window.innerHeight,
      center: center.x / window.innerWidth,
    };
  }

  /**
   * Where the torso is now, in window pixels: the HUD's docks open beside it
   * and follow it (standing, sitting, lying down).
   */
  hudFrame() {
    if (!this.framed) return null;
    if (this.form === 'flame') {
      // The flame's menu goes around her: we also need where the tip reaches and how wide she is.
      const center = this._toScreen(this.flame.centerWorld());
      const top = this._toScreen(this.flame.topWorld());
      return { cx: center.x, cy: center.y, top: top.y, half: this.flame.halfWidth / this.metersPerPixel };
    }
    if (!this.vrm) return null;
    const bone = (name) => this.vrm.humanoid.getNormalizedBoneNode(name);
    const chest = bone('upperChest') ?? bone('chest') ?? bone('spine');
    const hips = bone('hips');
    if (!chest || !hips) return null;
    this._hudChest ??= new THREE.Vector3();
    this._hudHips ??= new THREE.Vector3();
    const top = this._toScreen(chest.getWorldPosition(this._hudChest));
    const bottom = this._toScreen(hips.getWorldPosition(this._hudHips));
    return { cx: bottom.x, cy: top.y * 0.6 + bottom.y * 0.4 };
  }

  /**
   * Click without dragging: on the head it's a pat, on the body a poke.
   * Returns the reaction (`pat`, `flinch`) or `null`.
   */
  poke(px, py) {
    if (this.form === 'flame' && this.framed) {
      const center = this._toScreen(this.flame.centerWorld());
      return this.flame.poke(py < center.y ? 'head' : 'body');
    }
    if (!this.body || !this.vrm) return null;
    const neck = this.vrm.humanoid.getNormalizedBoneNode('neck') ?? this.vrm.humanoid.getNormalizedBoneNode('head');
    const neckY = neck ? this._toScreen(neck.getWorldPosition(new THREE.Vector3())).y : -Infinity;
    return this.body.poke(py < neckY ? 'head' : 'body');
  }

  /** World point -> window pixels. */
  _toScreen(point) {
    point.project(this.camera);
    return {
      x: (point.x * 0.5 + 0.5) * window.innerWidth,
      y: (-point.y * 0.5 + 0.5) * window.innerHeight,
    };
  }

  /** Window pixels -> point on the vertical plane through the character. */
  _pointOnAvatarPlane(px, py, target) {
    return this._rayToPlane(px, py, this.cameraTarget, target);
  }

  /** Ray from the camera through the pixel (px, py), intersected with the plane
   * perpendicular to the camera's gaze passing through `planePoint`. */
  _rayToPlane(px, py, planePoint, target) {
    const origin = this.camera.position;
    const direction = new THREE.Vector3(
      (px / window.innerWidth) * 2 - 1,
      -((py / window.innerHeight) * 2 - 1),
      0.5,
    )
      .unproject(this.camera)
      .sub(origin)
      .normalize();
    const normal = this.camera.getWorldDirection(new THREE.Vector3());
    const distance = planePoint.clone().sub(origin).dot(normal) / Math.max(1e-6, direction.dot(normal));
    return target.copy(origin).addScaledVector(direction, distance);
  }

  /**
   * Where the cursor is looking, in the 3D world. The cursor lives on the
   * screen's glass, i.e. on the camera's side: we project it on a plane
   * halfway between the character and the camera. On that plane a far cursor
   * (even outside the window) produces a wide but sensible angle.
   */
  /**
   * The cursor has been still over her head for a moment: she tries to touch
   * it. Returns the point (on the head's plane) or `null`.
   */
  _updateReachPoint(dt) {
    const { x, y } = this.pointerPx;
    const head = x >= 0 ? this.headScreen() : null;
    const above = head ? head.y - y : 0;
    const over = Boolean(head) && above > 20 && above < 190 && Math.abs(x - head.x) < 120;
    this._overheadFor = over ? (this._overheadFor ?? 0) + dt : 0;
    if (this._overheadFor < 0.8) return null;
    const node = this.vrm.humanoid.getNormalizedBoneNode('head');
    this._reachPlane ??= new THREE.Vector3();
    this._reachPoint ??= new THREE.Vector3();
    return this._rayToPlane(x, y, node.getWorldPosition(this._reachPlane), this._reachPoint);
  }

  _updateGazePoint() {
    const head = this.vrm.humanoid.getNormalizedBoneNode('head');
    if (!head) return null;
    const planePoint = head.getWorldPosition(new THREE.Vector3()).lerp(this.camera.position, 0.5);
    return this._rayToPlane(this.gazePx.x, this.gazePx.y, planePoint, this._gazePoint);
  }

  /** Scene metres per screen pixel, at the character's distance. */
  get metersPerPixel() {
    const visible = 2 * this.orbit.distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    return visible / Math.max(1, window.innerHeight);
  }

  /**
   * Reads the alpha of the pixel exactly under the cursor from the just-drawn
   * framebuffer. That's how you get Desktop Mate's "real" click-through: the
   * mouse goes through the window everywhere except where there are really
   * opaque pixels of the character.
   */
  _sampleAlphaUnderPointer() {
    const { x, y } = this.pointerPx;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return 0;

    const gl = this.renderer.getContext();
    const ratio = this.renderer.getPixelRatio();
    const px = Math.floor(x * ratio);
    // WebGL has its origin at the bottom left, the DOM at the top left.
    const py = Math.floor((window.innerHeight - y) * ratio);
    if (px < 0 || py < 0 || px >= gl.drawingBufferWidth || py >= gl.drawingBufferHeight) return 0;

    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this._pixelBuffer);
    return this._pixelBuffer[3] / 255;
  }

  /** Frames the head of the just-loaded character. */
  _frameCamera() {
    // The world matrices haven't been computed yet: without this the head's
    // position would come out as (0, 0, 0).
    this.vrm.scene.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(this.vrm.scene);
    this.modelHeight = Math.max(0.2, box.max.y - box.min.y);
    this.floorY = box.min.y;

    if (this.framing === 'full') {
      // Full figure with the feet almost on the bottom edge (the window rests on
      // the taskbar) and room above the head for raised arms: stretching and
      // waving must not go out of the frame.
      const span = this.modelHeight * FULL_FRAME;
      box.getCenter(this.cameraTarget);
      this.cameraTarget.y = box.min.y + span / 2 - this.modelHeight * 0.015;
      this.baseDistance = this._distanceFor(span);
    } else {
      const humanoid = this.vrm?.humanoid;
      // The "raw" bone is the real model's, with the actual scale and height; the
      // normalized one is used to drive the poses instead.
      const head = humanoid?.getRawBoneNode?.('head') ?? humanoid?.getNormalizedBoneNode('head');
      if (head) {
        head.getWorldPosition(this.cameraTarget);
      } else {
        box.getCenter(this.cameraTarget);
        this.cameraTarget.y = box.max.y - this.modelHeight * 0.12;
      }
      // We aim a little below the head, so the shoulders fit too.
      this.cameraTarget.y -= this.modelHeight * 0.06;
      this.baseDistance = this._distanceFor(this.modelHeight * FRAME_HEIGHT);
    }

    this.orbit.targetDistance = this.baseDistance;
    this.orbit.distance = this.baseDistance;
    this.orbit.yaw = 0;
    this.orbit.targetYaw = 0;
    this.orbit.height = 0;
  }

  /**
   * Distance needed to frame `span` metres vertically.
   *
   * On narrow windows (Electron's is vertical) the constraint becomes the
   * shoulders' width, otherwise the character would be cut at the sides: so
   * we take the larger of the two distances.
   */
  _distanceFor(span) {
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const vertical = span / 2 / Math.tan(halfFov);
    const horizontal = SHOULDER_SPAN / 2 / (Math.tan(halfFov) * Math.max(0.1, this.camera.aspect));
    return Math.max(vertical, horizontal);
  }

  // ---------------------------------------------------------------- drivers
  /**
   * Decides how to move the mouth:
   *  - `expression`: the model exposes the VRM 1.0 presets (aa/ih/ou/ee/oh);
   *  - `morph`: we drive VRoid's `fcl_mth_*` morph targets directly;
   *  - `none`: no mouth blendshape found.
   */
  _detectMouthDriver(vrm) {
    const manager = vrm.expressionManager;
    if (manager) {
      const map = {};
      const complete = VISEME_KEYS.every((key) => {
        const name = this.blendshapes[key]?.vrm1;
        const expression = name ? manager.getExpression(name) : null;
        if (expression) map[key] = name;
        return Boolean(expression);
      });
      if (complete) return { kind: 'expression', map, label: 'VRM expressions' };
    }

    // Recent VRoid exports "Fcl_MTH_A", older ones "fcl_mth_a": we always
    // compare in lowercase.
    const wanted = new Map(
      VISEME_KEYS.map((key) => [this.blendshapes[key]?.vrm0?.toLowerCase(), key]).filter(
        ([name]) => Boolean(name),
      ),
    );

    const targets = {};
    vrm.scene.traverse((object) => {
      const dictionary = object.morphTargetDictionary;
      if (!dictionary || !object.morphTargetInfluences) return;
      for (const [name, index] of Object.entries(dictionary)) {
        const key = wanted.get(name.toLowerCase());
        if (key) (targets[key] ??= []).push({ mesh: object, index });
      }
    });

    if (Object.keys(targets).length > 0) {
      return { kind: 'morph', targets, label: 'morph Fcl_MTH_*' };
    }
    return { kind: 'none', label: 'no mouth blendshapes' };
  }

  _detectBlinkDriver(vrm) {
    if (vrm.expressionManager?.getExpression('blink')) {
      return { kind: 'expression', name: 'blink' };
    }
    // Only the closing of both eyes: "_L"/"_R" would count twice.
    const wanted = new Set(['fcl_eye_close', 'blink', 'eye_close']);
    const targets = [];
    vrm.scene.traverse((object) => {
      const dictionary = object.morphTargetDictionary;
      if (!dictionary || !object.morphTargetInfluences) return;
      for (const [name, index] of Object.entries(dictionary)) {
        if (wanted.has(name.toLowerCase())) targets.push({ mesh: object, index });
      }
    });
    return targets.length ? { kind: 'morph', targets } : { kind: 'none' };
  }

  /** Readable name of the active driver (shown in the debug panel). */
  get mouthDriverLabel() {
    return this.mouthDriver.label ?? this.mouthDriver.kind;
  }

  // ----------------------------------------------------------------- update
  /** Registers a callback run every frame: `(dt, elapsed) => weights`. */
  onFrame(callback) {
    this.frameCallbacks.add(callback);
    return () => this.frameCallbacks.delete(callback);
  }

  start() {
    if (this._animationId !== null) return;
    let last = -Infinity;
    const loop = (now) => {
      this._animationId = requestAnimationFrame(loop);
      // A couple of ms of tolerance: rAF never falls exactly on the millisecond.
      if (now - last < 1000 / this.targetFps() - 2) return;
      last = now;
      this._tick();
    };
    this._animationId = requestAnimationFrame(loop);
  }

  /** How many frames per second are needed now (see FPS). */
  targetFps() {
    const body = this.body;
    if (!this.framed) return FPS.calm;
    if (this.form === 'flame' || this._morph) {
      const lively =
        this._morph ||
        this.flame.busy ||
        this._speech.playing ||
        this._listening ||
        this.elapsed - this._pointerMovedAt < 1.5 ||
        this._music?.active;
      if (lively) return FPS.active;
      return this._sleep > 0.9 ? FPS.asleep : FPS.calm;
    }
    const moving =
      this._speech.playing ||
      this.elapsed - this._pointerMovedAt < 1.5 ||
      body.modeWeight.held + body.modeWeight.fall > 0.01 ||
      body.actions.length > 0 ||
      this.clips?.playing ||
      (body.dancing && body.music.active);
    if (moving) return FPS.active;
    return body.sleep > 0.9 ? FPS.asleep : FPS.calm;
  }

  stop() {
    if (this._animationId !== null) cancelAnimationFrame(this._animationId);
    this._animationId = null;
  }

  _tick() {
    const dt = Math.min(this.clock.getDelta(), 0.1); // clamp: avoids jumps after a lag
    this.elapsed += dt;

    this._fpsAccumulator += dt;
    this._fpsFrames += 1;
    if (this._fpsAccumulator >= 0.5) {
      this.fps = Math.round(this._fpsFrames / this._fpsAccumulator);
      this._fpsAccumulator = 0;
      this._fpsFrames = 0;
    }

    // The callbacks return the mouth's weights for this frame.
    let mouth = null;
    for (const callback of this.frameCallbacks) {
      const result = callback(dt, this.elapsed);
      if (result) mouth = result;
    }

    this._updateCamera(dt);
    this._updateMorph(dt);

    // The anchors are measured with the camera still, right after its update.
    if (this._anchorsDirty && (this.body || this.spiritOnly) && this.onAnchors) {
      // Minimized window: no measures (it would divide by zero).
      if (Math.abs(this.orbit.distance - this.orbit.targetDistance) < 1e-3 && window.innerWidth && window.innerHeight) {
        this._anchorsDirty = false;
        this.onAnchors(this._computeAnchors());
      }
    }

    if (this.framed && this.flame.root.visible) {
      this.flame.setMenuPose(this._menuSlot && this.form === 'flame' && !this._morph ? this._menuPose(this._menuSlot) : null);
      this.flame.update(dt, {
        speaking: this._speech.playing,
        level: this._speech.level,
        thinking: this._thinking,
        working: this._working,
        listening: this._listening,
        sleep: this._sleep,
        look: this._flameLook(),
        music: this._music,
        hover: this.pointerOnAvatar,
        menu: this._menu,
        hungry: this._hungry,
        typing: performance.now() < (this._typingUntil ?? 0),
      });
    } else if (this.flame.fx.active) {
      // The flash and rings of entering the body finish even with the flame gone.
      this.flame.fx.update(dt);
    }

    // The body hidden behind the flame isn't animated: saves CPU.
    if (this.vrm && this.avatarRoot?.visible) {
      this.body.update(dt, {
        speaking: this._speech.playing,
        level: this._speech.level,
        gazePoint: this._updateGazePoint(),
        reachPoint: this._updateReachPoint(dt),
        gazeFresh: this.elapsed - this._pointerMovedAt < GAZE_ATTENTION,
        viewer: this.camera.position,
        metersPerPixel: this.metersPerPixel,
      });
      // The .vrma clips over the procedural pose; only standing or sitting.
      if (this.clips?.playing && !['stand', 'sit'].includes(this.body.mode)) this.clips.stop();
      this.clips?.apply(dt);
      this._updateBlink(dt);
      this._applyMoods();

      // The yawn opens the mouth even when she isn't speaking.
      const yawn = this.body.mouthOpen;
      if (yawn > 0.001) mouth = { ...mouth, a: Math.max(mouth?.a ?? 0, yawn), o: Math.max(mouth?.o ?? 0, 0.3 * yawn) };

      // Expressions must be set BEFORE vrm.update(), raw morphs AFTER (otherwise
      // the expression manager would overwrite them).
      if (mouth && this.mouthDriver.kind === 'expression') this._applyMouthExpressions(mouth);
      this.vrm.update(dt);
      if (mouth && this.mouthDriver.kind === 'morph') this._applyMouthMorphs(mouth);
    }
    // The holographic tablet/keyboard follow the hands as soon as they've settled.
    this.holo.update(dt, this.vrm, this.form === 'vrm' && !this._morph ? (this.body?.workWeights ?? null) : null);
    this._updateShadow();

    this.renderer.render(this.scene, this.camera);

    // Right AFTER the render, with the frame still in the buffer: so we know
    // whether the cursor is on a pixel of the character or on the transparent void.
    this.lastAlpha = this._sampleAlphaUnderPointer();
    this.pointerOnAvatar = this.lastAlpha > 0.12;
  }

  /**
   * Where the flame looks, from -1 to 1 on both axes: towards the cursor, even
   * outside the window. After a few seconds of still cursor she looks around.
   */
  _flameLook() {
    this._flameCenter ??= new THREE.Vector3();
    const center = this._toScreen(this.flame.centerWorld(this._flameCenter));
    if (this.elapsed - this._pointerMovedAt < GAZE_ATTENTION) {
      return {
        x: THREE.MathUtils.clamp((this.gazePx.x - center.x) / (window.innerWidth * 0.9), -1, 1),
        y: THREE.MathUtils.clamp(-(this.gazePx.y - center.y) / (window.innerHeight * 0.6), -1, 1),
      };
    }
    return { x: Math.sin(this.elapsed * 0.37) * 0.35, y: Math.sin(this.elapsed * 0.23) * 0.15 };
  }

  _updateCamera(dt) {
    const smoothing = Math.min(1, dt * 6);
    this.orbit.yaw += (this.orbit.targetYaw - this.orbit.yaw) * smoothing;
    this.orbit.distance += (this.orbit.targetDistance - this.orbit.distance) * smoothing;

    const x = Math.sin(this.orbit.yaw) * this.orbit.distance;
    const z = Math.cos(this.orbit.yaw) * this.orbit.distance;
    this.camera.position.set(
      this.cameraTarget.x + x,
      this.cameraTarget.y + this.orbit.height,
      this.cameraTarget.z + z,
    );
    this.camera.lookAt(this.cameraTarget);
  }

  /**
   * Blinking: random, sometimes double, and also when the gaze jumps far
   * (we all do it). No blink if the eyes are already closed by a smile: the
   * two closings added together would deform the eyelids.
   */
  _updateBlink(dt) {
    this.blinkTimer -= dt;
    const requested = this.body?.consumeBlinkRequest() && this.blinkValue <= 0 && this.blinkTimer > 0.4;
    if (this.blinkTimer <= 0 || requested) {
      const double = Math.random() < 0.18;
      this.blinkTimer = double ? 0.28 : 1.8 + Math.random() * 4.5;
      this.blinkValue = 1;
    }
    if (this.blinkValue > 0) {
      this.blinkValue = Math.max(0, this.blinkValue - dt * 7.5);
    }

    const blink = this.blinkValue > 0 ? Math.sin(this.blinkValue * Math.PI) : 0;
    const suppression = this.body?.blinkSuppression ?? 0;
    const value = Math.max(blink * (1 - suppression), this.body?.eyesClosed ?? 0);
    if (this.blinkDriver.kind === 'expression') {
      this.vrm.expressionManager.setValue(this.blinkDriver.name, value);
    } else if (this.blinkDriver.kind === 'morph') {
      for (const { mesh, index } of this.blinkDriver.targets) {
        mesh.morphTargetInfluences[index] = value;
      }
    }
  }

  /** Mood, smiles and frights decided by the body, on the preset expressions. */
  _applyMoods() {
    const manager = this.vrm.expressionManager;
    if (!manager) return;
    for (const name of this.moodExpressions) {
      manager.setValue(name, this.body.expressions[name] ?? 0);
    }
  }

  _applyMouthExpressions(weights) {
    const manager = this.vrm.expressionManager;
    for (const key of VISEME_KEYS) {
      const name = this.mouthDriver.map[key];
      if (name) manager.setValue(name, weights[key] ?? 0);
    }
  }

  _applyMouthMorphs(weights) {
    for (const key of VISEME_KEYS) {
      const entries = this.mouthDriver.targets[key];
      if (!entries) continue;
      const value = weights[key] ?? 0;
      for (const { mesh, index } of entries) {
        mesh.morphTargetInfluences[index] = value;
      }
    }
  }

  // ---------------------------------------------------------------- cleanup
  dispose() {
    this.stop();
    this._disposeVrm();
    this.holo.dispose();
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    this.canvas.removeEventListener('wheel', this._onWheel);
    this.renderer.dispose();
  }
}
