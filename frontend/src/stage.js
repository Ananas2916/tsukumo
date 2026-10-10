/**
 * The 3D stage: Three.js scene, camera and render loop, with Tsukumo (the
 * flame, flame.js) in it.
 *
 * Responsibilities:
 *  - scene, lights, camera and the frame loop, at the frame rate she needs;
 *  - tell the flame what happens around her: the cursor, her voice, the
 *    agent at work, being held, thrown or falling, music, sleep, the menu;
 *  - translate between the 3D world and the window's pixels: the anchors the
 *    physics sets her down with, the island's slot, the per-pixel
 *    click-through.
 */

import * as THREE from 'three';

import { DROP, Flame, FLAME_HEIGHT } from './flame.js';

/** After how many seconds of still cursor she stops following it and looks around. */
const GAZE_ATTENTION = 4;

/**
 * The frame is sized for a standing figure this tall (m) with the flame at
 * its feet: window, physics and click-through are all proportional to it.
 */
const FRAME_HEIGHT = 1.6;
/** Framed height, with room above her for hats, jumps and the "!". */
const FULL_FRAME = 1.24;
/** Width always in frame (m): on narrow windows it sets the distance. */
const MIN_SPAN = 0.55;

/**
 * Frames per second according to what she's doing. She's always on screen:
 * drawing her at 144 Hz while she just breathes heats the laptop and drains
 * the battery for nothing. Breathing at 30 fps looks the same; speaking,
 * being held or following the mouse want 60.
 */
const FPS = { active: 60, calm: 30, asleep: 20 };

export class Stage {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;

    this.clock = new THREE.Clock();
    this.elapsed = 0;

    /** Cursor in pixels relative to the window, even outside its edges. */
    this.gazePx = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    this._pointerMovedAt = -Infinity;

    /** State the flame reads every frame. */
    this._speech = { playing: false, level: 0 };
    this._thinking = false;
    this._working = null;
    this._listening = false;
    this._music = null;
    /** The menu is open (it makes her light up). */
    this._menu = false;
    /** The flame's slot in the open island (window pixels), or null. */
    this._menuSlot = null;
    /** A file dragged over her: mouth open, ready to eat it. */
    this._hungry = false;
    /** Last window position while it flies thrown (see flyMove). */
    this._flyAt = null;
    /** Last window position during the sprint, so the trail stays behind. */
    this._sprintX = null;
    this._dancing = true;
    this._sleep = 0;

    // --- mascot mode (Electron) -------------------------------------------
    /** If set, the wheel calls this instead of zooming the camera. */
    this.onWheelScale = null;
    /** Receives the window's anchors (where she rests, her axis). */
    this.onAnchors = null;
    this._anchorsDirty = false;

    this.orbit = { distance: 1.4, targetDistance: 1.4 };
    /** Framing distance; the browser's zoom is a factor of it. */
    this.baseDistance = 1.4;

    this.frameCallbacks = new Set();
    this.fps = 0;
    this._fpsAccumulator = 0;
    this._fpsFrames = 0;
    this._animationId = null;

    /** Pointer position in pixels: needed for the per-pixel alpha test. */
    this.pointerPx = { x: -1, y: -1 };
    this._pixelBuffer = new Uint8Array(4);
    /** true when the cursor is really over an opaque pixel of her. */
    this.pointerOnFlame = false;

    this._initRenderer();
    this._initScene();
    this._bindEvents();
    this._frame();
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
    // Neutral keeps her colours and compresses only the strong lights (her glow).
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1;
  }

  _initScene() {
    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(28, 1, 0.05, 40);
    this.cameraTarget = new THREE.Vector3(0, 1, 0);

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
    this._resize();
  }

  /**
   * Soft shadow under her: it rests her on the desktop instead of letting her
   * float in the void. A blurred disc and not a real shadow: it costs nothing,
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

  _updateShadow() {
    const { x, z, size, opacity } = this.flame.shadow;
    this.shadow.visible = opacity > 0.01 && size > 0.001;
    this.shadow.position.set(x, 0.002, z);
    this.shadow.scale.set(size, size * 0.55, 1);
    this.shadow.material.opacity = opacity;
  }

  _bindEvents() {
    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);

    // The gaze follows the mouse over the whole window. With
    // setIgnoreMouseEvents(..., {forward: true}) Electron forwards the native
    // mouse messages as 'mousemove', not as pointer events: without this
    // second listener, in click-through we wouldn't know where the cursor is.
    this._onPointerMove = (event) => this.setPointer(event.clientX, event.clientY, true);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('mousemove', this._onPointerMove);

    this._onWheel = (event) => {
      if (event.target !== this.canvas) return;
      event.preventDefault();
      // In Electron the wheel enlarges the window, not the camera: with the
      // camera she would go past the edges and get cut.
      if (this.onWheelScale) {
        this.onWheelScale(Math.exp(-event.deltaY * 0.0012));
        return;
      }
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
    // New proportions want a new distance: the browser's zoom is kept.
    const zoom = this.baseDistance ? this.orbit.targetDistance / this.baseDistance : 1;
    this.baseDistance = this._distanceFor(FRAME_HEIGHT * FULL_FRAME);
    this.orbit.targetDistance = this.baseDistance * zoom;
    this._anchorsDirty = true;
  }

  /** Opaque background (handy in the browser) or transparent (Electron). */
  setBackgroundVisible(visible) {
    this.renderer.setClearAlpha(visible ? 1 : 0);
    this.renderer.setClearColor(0x11141f, visible ? 1 : 0);
  }

  /**
   * Full figure, as for a mascot on the desk: the flame sits at the bottom
   * (the window rests on the taskbar) with room above her.
   */
  _frame() {
    const span = FRAME_HEIGHT * FULL_FRAME;
    this.cameraTarget.set(0, span / 2 - FRAME_HEIGHT * 0.015, 0);
    this.baseDistance = this._distanceFor(span);
    this.orbit.targetDistance = this.baseDistance;
    this.orbit.distance = this.baseDistance;
    this.flame.setHeight(FRAME_HEIGHT * FLAME_HEIGHT);
    this.flame.home.set(0, 0, 0);
    this.flame.root.visible = true;
    this._anchorsDirty = true;
  }

  /**
   * Distance needed to frame `span` metres vertically. On narrow windows the
   * constraint becomes the width, otherwise she'd be cut at the sides: the
   * larger of the two distances wins.
   */
  _distanceFor(span) {
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const vertical = span / 2 / Math.tan(halfFov);
    const horizontal = MIN_SPAN / 2 / (Math.tan(halfFov) * Math.max(0.1, this.camera.aspect));
    return Math.max(vertical, horizontal);
  }

  // ------------------------------------------------------------ the sprint
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

  // ------------------------------------------------------------ throwing her
  /** You threw her (horizontal speed in px/s): she flies with the trail. */
  flyStart(vx) {
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
    this.flame.bonk(side === 'right' ? 1 : side === 'left' ? -1 : 0, impact);
  }

  // ------------------------------------------------------------- her look
  /** Her colour (flame/palettes.js: a name or a "#rrggbb"). */
  setFlamePalette(name) {
    this.flame.setPalette(name);
  }

  /** What she wears (flame/wardrobe.js, already resolved: no "auto"). */
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
   * The menu opens or closes. With `slot` (window pixels: the place left of
   * the island's card) she slides into it.
   */
  setMenu(open, slot = null) {
    this._menu = Boolean(open);
    this._menuSlot = open && slot ? slot : null;
  }

  /** How much to move and shrink her so she fits entirely in the card's slot. */
  _menuPose(slot) {
    const mpp = this.metersPerPixel;
    const { UNIT, R } = DROP;
    const size = this.flame.size;
    // What she wears counts: a hat makes her taller, the lantern or wings wider.
    const { top, left, right } = this.flame.wardrobe;
    const fit = Math.min((slot.h * 0.86 * mpp) / ((UNIT + top) * size), (slot.w * 0.86 * mpp) / ((left + right) * size), 1);
    this._restCenter ??= new THREE.Vector3();
    const rest = this._toScreen(this.flame.restCenterWorld(this._restCenter));
    // The drop, from the bottom of the bulb to the tip (or the hat), sits in the middle of the slot: the bulb a bit lower.
    const below = (((UNIT + top - 2 * R) / 2) * size * fit) / mpp;
    const x = slot.x + slot.w / 2 - (((right - left) / 2) * size * fit) / mpp;
    const y = slot.y + slot.h / 2 + below;
    return { dx: (x - rest.x) * mpp, dy: -(y - rest.y) * mpp, scale: fit };
  }

  // ------------------------------------------------------------- her moods
  /** You're typing in the chat: for a moment she's all ears, and nods at every key. */
  userTyping() {
    this._typingUntil = performance.now() + 1500;
    this.flame.keystroke();
  }

  /** A file dragged over her (true) or gone (false). */
  setHungry(value) {
    this._hungry = Boolean(value);
  }

  /** A reaction or gesture by name (flame.js, REACTIONS). False if it didn't start. */
  play(name) {
    return this.flame.react(name);
  }

  /** Really asleep (for the "z"s). */
  get asleep() {
    return this._sleep >= 0.99;
  }

  /** The user is talking to her (the microphone hears the voice). */
  setListening(value) {
    this._listening = Boolean(value);
  }

  /** She greets (when she appears, when you come back). */
  greet() {
    this.flame.react('greet');
  }

  /**
   * Cursor position in pixels relative to the window. It can be outside the
   * edges too (in Electron we always know it): she follows it with her gaze
   * wherever it is on the screen, but the pixel test for the click-through
   * only applies inside the window.
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

  /** Audio playing, its volume and the vowel being spoken (lipsync.js weights). */
  setSpeech(playing, level, vowels = null) {
    this._speech.playing = playing;
    this._speech.level = level;
    this._speech.vowels = vowels;
  }

  /** The backend is waiting for the brain: thoughtful. */
  setThinking(value) {
    this._thinking = Boolean(value);
    if (!this._thinking) this._working = null;
  }

  /** The agent uses a tool (`read`, `write`, `run`...): she takes out her work props. */
  setWorking(kind) {
    this._working = kind || null;
  }

  /**
   * Picked up with the mouse, by the bulb. Returns how many pixels to move
   * the window so the bulb ends up under the cursor (px, py).
   */
  beginHold(px, py) {
    this.flame.setHeld(true);
    const center = this._toScreen(this.flame.centerWorld());
    return { x: px - center.x, y: py - center.y };
  }

  /** Where the dragged window is now, in screen pixels. */
  moveHold(screenX) {
    this.flame.moveHold(screenX);
  }

  endHold() {
    this.flame.setHeld(false);
  }

  setFalling() {
    this.flame.fall();
  }

  /** @param {number} impact 0..1, how hard she arrived */
  landed(impact) {
    this.flame.land(impact);
  }

  /** The music's rhythm (see music.js), every frame. */
  setMusic(state) {
    this._music = this._dancing ? state : null;
  }

  /** Dancing to the music can be turned off from the panel. */
  setDancing(value) {
    this._dancing = Boolean(value);
  }

  /** Spontaneous gestures, from the panel. */
  setSpontaneous(value) {
    this.flame.spontaneous = Boolean(value);
  }

  /** Sleep: 0 awake, 0.5 drowsy, 1 asleep (see presence.js). */
  setSleep(level) {
    this._sleep = level;
  }

  // ---------------------------------------------------------- measures
  /** Where her tip is (or her hat's), in window pixels: the "z"s and the bubble sit above it. */
  headScreen() {
    return this._toScreen(this.flame.topWorld());
  }

  /**
   * Where she rests and her axis, as fractions of the window: Electron needs
   * them to set her on the taskbar or on a window's edge. With proportional
   * framing they don't change with the scale.
   */
  _computeAnchors() {
    // She rests on her bottom: feet and seat coincide (on a window she sits on top).
    const base = this._toScreen(this.flame.home.clone());
    return { feet: base.y / window.innerHeight, seat: base.y / window.innerHeight, center: base.x / window.innerWidth };
  }

  /** Where she is now, in window pixels: centre of the bulb, tip, half width. The menu grows from here. */
  hudFrame() {
    const center = this._toScreen(this.flame.centerWorld());
    const top = this._toScreen(this.flame.topWorld());
    return { cx: center.x, cy: center.y, top: top.y, half: this.flame.halfWidth / this.metersPerPixel };
  }

  /**
   * Click without dragging: on the tip it's a pat, lower down a poke.
   * Returns the reaction, or `null`.
   */
  poke(px, py) {
    const center = this._toScreen(this.flame.centerWorld());
    return this.flame.poke(py < center.y ? 'head' : 'body');
  }

  /** World point -> window pixels. */
  _toScreen(point) {
    point.project(this.camera);
    return {
      x: (point.x * 0.5 + 0.5) * window.innerWidth,
      y: (-point.y * 0.5 + 0.5) * window.innerHeight,
    };
  }

  /** Scene metres per screen pixel, at her distance. */
  get metersPerPixel() {
    const visible = 2 * this.orbit.distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    return visible / Math.max(1, window.innerHeight);
  }

  /**
   * Reads the alpha of the pixel exactly under the cursor from the just-drawn
   * framebuffer: the mouse goes through the window everywhere except where
   * there are really opaque pixels of her.
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

  // ----------------------------------------------------------------- update
  /** Registers a callback run every frame: `(dt, elapsed) => vowels`. */
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
    const lively =
      this.flame.busy ||
      this._speech.playing ||
      this._listening ||
      this.elapsed - this._pointerMovedAt < 1.5 ||
      this._music?.active;
    if (lively) return FPS.active;
    return this._sleep > 0.9 ? FPS.asleep : FPS.calm;
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

    for (const callback of this.frameCallbacks) callback(dt, this.elapsed);

    this._updateCamera(dt);

    // The anchors are measured with the camera still, right after its update.
    if (this._anchorsDirty && this.onAnchors) {
      // Minimized window: no measures (it would divide by zero).
      if (Math.abs(this.orbit.distance - this.orbit.targetDistance) < 1e-3 && window.innerWidth && window.innerHeight) {
        this._anchorsDirty = false;
        this.onAnchors(this._computeAnchors());
      }
    }

    this.flame.setMenuPose(this._menuSlot ? this._menuPose(this._menuSlot) : null);
    this.flame.update(dt, {
      speaking: this._speech.playing,
      level: this._speech.level,
      vowels: this._speech.vowels,
      thinking: this._thinking,
      working: this._working,
      listening: this._listening,
      sleep: this._sleep,
      look: this._flameLook(),
      music: this._music,
      hover: this.pointerOnFlame,
      menu: this._menu,
      hungry: this._hungry,
      typing: performance.now() < (this._typingUntil ?? 0),
    });
    this._updateShadow();

    this.renderer.render(this.scene, this.camera);

    // Right AFTER the render, with the frame still in the buffer: so we know
    // whether the cursor is on a pixel of her or on the transparent void.
    this.lastAlpha = this._sampleAlphaUnderPointer();
    this.pointerOnFlame = this.lastAlpha > 0.12;
  }

  /**
   * Where she looks, from -1 to 1 on both axes: towards the cursor, even
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
    this.orbit.distance += (this.orbit.targetDistance - this.orbit.distance) * Math.min(1, dt * 6);
    this.camera.position.set(this.cameraTarget.x, this.cameraTarget.y, this.cameraTarget.z + this.orbit.distance);
    this.camera.lookAt(this.cameraTarget);
  }

  // ---------------------------------------------------------------- cleanup
  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('mousemove', this._onPointerMove);
    this.canvas.removeEventListener('wheel', this._onWheel);
    this.renderer.dispose();
  }
}
