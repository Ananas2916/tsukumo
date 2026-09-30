/**
 * Palcoscenico 3D: Three.js + @pixiv/three-vrm.
 *
 * Responsabilita':
 *  - creare scena, luci, camera e loop di rendering;
 *  - caricare un modello `.vrm` (VRM 0.x o VRM 1.0);
 *  - individuare come pilotare la bocca (espressioni preset oppure morph
 *    target `fcl_mth_*`) e applicare i pesi calcolati dal lip-sync;
 *  - passare al corpo (vedi body.js) quello che succede intorno: dov'e' il
 *    cursore, se sta parlando, se lo stai tenendo in mano, se cade;
 *  - battito di ciglia ed espressioni del viso;
 *  - la forma piccola (flame.js): la fiammella al posto del VRM, e il
 *    passaggio fra le due ("entra nel corpo", "esce dal corpo").
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

import { BodyAnimator } from './body.js';
import { ClipPlayer } from './clips.js';
import { DEFAULT_BLENDSHAPES, VISEME_KEYS } from './config.js';
import { Flame, FLAME_HEIGHT } from './flame.js';
import { HoloPanel } from './holo.js';

/** Espressioni del viso pilotate dal corpo (umore, spavento, sorriso...). */
const MOOD_EXPRESSIONS = ['happy', 'relaxed', 'surprised', 'sad', 'angry'];

/** Dopo quanti secondi di cursore fermo smette di seguirlo e guarda te. */
const GAZE_ATTENTION = 4;

/** Frazione dell'altezza del personaggio inquadrata di default (testa + busto). */
const FRAME_HEIGHT = 0.5;

/** Figura intera: altezza inquadrata, con margine sopra per le braccia alzate. */
const FULL_FRAME = 1.24;

/** Larghezza tipica delle spalle di un avatar VRM, in metri. */
const SHOULDER_SPAN = 0.55;

/** Senza corpo la fiammella si inquadra come se ci fosse un modello alto cosi' (m). */
const SPIRIT_MODEL_HEIGHT = 1.6;

/**
 * Frame al secondo secondo quello che fa. Il personaggio e' sempre sullo
 * schermo: disegnarlo a 144 Hz mentre respira e basta scalda il portatile e
 * consuma batteria per niente. Il respiro a 30 fps e' identico; parlare,
 * essere presa in mano o seguire il mouse invece vogliono 60.
 */
const FPS = { active: 60, calm: 30, asleep: 20 };

/** Cambio di forma, in secondi: quando la fiammella arriva al petto e quando finisce tutto. */
const INTO_BODY = { arrive: 0.5, end: 1.45 };
const OUT_OF_BODY = { dissolve: 0.7, end: 1.1 };
/** Piano di taglio "spento": abbastanza in alto da non tagliare niente. */
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
    /** Animazione del corpo (body.js), creata a ogni caricamento del modello. */
    this.body = null;
    this.mouthDriver = { kind: 'none' };
    this.blinkDriver = { kind: 'none' };
    this.moodExpressions = [];

    this.clock = new THREE.Clock();
    this.elapsed = 0;
    this.blinkTimer = 2 + Math.random() * 3;
    this.blinkValue = 0;

    // Sguardo: il corpo decide dove guardare, gli occhi seguono questo target.
    this.lookTarget = new THREE.Object3D();
    /** Cursore in pixel relativi alla finestra, anche fuori dai suoi bordi. */
    this.gazePx = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    this._pointerMovedAt = -Infinity;
    this._gazePoint = new THREE.Vector3();

    /** Stato che il corpo legge a ogni frame. */
    this._speech = { playing: false, level: 0 };
    this._thinking = false;
    this._working = null;
    this._listening = false;
    this._music = null;

    /** 'vrm' (il personaggio) o 'flame' (la fiammella, flame.js). */
    this.form = 'vrm';
    /** Senza corpo: solo la fiammella, il VRM non e' caricato (vedi useSpirit). */
    this.spiritOnly = false;
    this.floorY = 0;
    /** Cambio di forma in corso: `{to, t, fired}`. */
    this._morph = null;
    /** Taglia il VRM all'altezza del piano: lo fa comparire dai piedi o sparire dalla testa. */
    this._clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), NO_CLIP);
    /** Ultima posizione della finestra durante lo sprint, per far restare indietro la scia. */
    this._sprintX = null;
    this._spontaneous = true;
    this._dancing = true;
    this._sleep = 0;

    // --- modalita' mascotte (Electron) ------------------------------------
    /** Se impostata, la rotellina chiama questa invece di zoomare la camera. */
    this.onWheelScale = null;
    /** Riceve le ancore della finestra (piedi, seduta, asse del corpo). */
    this.onAnchors = null;
    /** Il corpo vuole sedersi/sdraiarsi/alzarsi sulla barra. */
    this.onPostureRequest = null;
    /** Finito un cambio di forma animato: riceve la forma nuova. */
    this.onMorphEnd = null;
    this._anchorsDirty = false;

    // Controlli camera "leggeri" (niente OrbitControls: ci bastano questi).
    this.orbit = { yaw: 0, targetYaw: 0, distance: 1.4, targetDistance: 1.4, height: 0 };
    /** Distanza di inquadratura calcolata al caricamento; lo zoom e' un fattore. */
    this.baseDistance = 1.4;
    this.modelHeight = 0;
    this.dragging = false;
    this.lastPointer = { x: 0, y: 0 };

    this.frameCallbacks = new Set();
    this.fps = 0;
    this._fpsAccumulator = 0;
    this._fpsFrames = 0;
    this._animationId = null;

    // --- modalita' "pet" da scrivania -----------------------------------
    /** In modalita' pet il trascinamento sposta la finestra, non la camera. */
    this.dragEnabled = true;
    /** Inquadratura: 'bust' (mezzo busto) oppure 'full' (figura intera). */
    this.framing = 'bust';
    /** Posizione del puntatore in pixel: serve per il test alpha per-pixel. */
    this.pointerPx = { x: -1, y: -1 };
    this._pixelBuffer = new Uint8Array(4);
    /** true quando il cursore e' davvero sopra un pixel opaco del personaggio. */
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
      alpha: true, // indispensabile per la finestra trasparente di Electron
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Neutral (Khronos PBR Neutral) e non ACES: ACES desatura e sposta le
    // tinte, e sui materiali MToon spegneva capelli colorati e pelle; senza
    // tone mapping invece i bianchi bruciano. Neutral tiene i colori del
    // modello e comprime solo le luci forti.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1;
    // Il piano di taglio del cambio di forma vale solo per i materiali del VRM.
    this.renderer.localClippingEnabled = true;
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.add(this.lookTarget);
    this.holo = new HoloPanel(this.scene);

    this.camera = new THREE.PerspectiveCamera(28, 1, 0.05, 40);
    this.cameraTarget = new THREE.Vector3(0, 1.35, 0);
    this.camera.position.set(0, 1.35, 0.9);

    // Tre luci: chiave calda davanti, riempimento freddo dietro, ambiente.
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
    // L'anello che scorre lungo il corpo mentre compare o sparisce.
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
   * Ombra morbida sotto i piedi: la appoggia al desktop invece di farla
   * galleggiare. Un disco sfumato e non un'ombra vera: costa niente, e la
   * finestra trasparente non ha un pavimento su cui proiettarla.
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

  /** L'ombra segue i fianchi; si sfuma quando si siede, si stende, la prendi o salta. */
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
    // Piu' i fianchi salgono sopra il riposo (un saltello, un piede alzato), piu' l'ombra si stringe.
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

    // Sguardo che segue il mouse su tutta la finestra.
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
    // Con setIgnoreMouseEvents(..., {forward: true}) Electron inoltra i
    // messaggi mouse nativi: quelli arrivano come 'mousemove', non come
    // pointer event. Senza questo secondo listener, in modalita'
    // click-through non sapremmo piu' dov'e' il cursore.
    window.addEventListener('mousemove', this._onPointerMove);

    this._onPointerDown = (event) => {
      // Trascinamento solo sul canvas: i pannelli UI restano cliccabili.
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
      // In Electron lo zoom ingrandisce la finestra, non la camera: con la
      // camera il personaggio usciva dai bordi e veniva tagliato.
      if (this.onWheelScale) {
        this.onWheelScale(Math.exp(-event.deltaY * 0.0012));
        return;
      }
      // Zoom moltiplicativo e limiti relativi all'inquadratura di partenza:
      // cosi' si comporta allo stesso modo con modelli di altezze diverse.
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
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    // Cambiando le proporzioni della finestra cambia anche la distanza
    // necessaria: la ricalcoliamo conservando lo zoom scelto dall'utente.
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

  /** Sfondo opaco (utile nel browser) oppure trasparente (Electron). */
  setBackgroundVisible(visible) {
    this.renderer.setClearAlpha(visible ? 1 : 0);
    this.renderer.setClearColor(0x11141f, visible ? 1 : 0);
  }

  // ------------------------------------------------------------------- load
  /**
   * Carica un modello VRM da URL (o da un blob URL creato da un File).
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
    if (!vrm) throw new Error('Il file non contiene dati VRM validi.');

    this._disposeVrm();
    // Un corpo di nuovo: la fiammella puo' tornarci dentro.
    this.spiritOnly = false;

    // Ottimizzazioni consigliate da three-vrm.
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    // I modelli VRM 0.x guardano verso +Z: li giriamo per avere il viso in camera.
    VRMUtils.rotateVRM0(vrm);

    vrm.scene.traverse((object) => {
      // Gli avatar sono sempre inquadrati: il culling costa piu' di quanto rende.
      object.frustumCulled = false;
      // Il piano del cambio di forma, assegnato subito: aggiungerlo dopo
      // ricompilerebbe gli shader MToon e il passaggio partirebbe a scatti.
      if (!object.isMesh) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        material.clippingPlanes = [this._clipPlane];
      }
    });

    // Il VRM va dentro un gruppo suo: cosi' possiamo farlo penzolare intorno
    // al punto di presa senza toccare vrm.scene.rotation, che per i modelli
    // VRM 0.x e' gia' usata da rotateVRM0 (la sovrascriveremmo).
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
    // Clip .vrma (vedi clips.js): ogni tanto al posto di un gesto spontaneo.
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
    // Altezza dei fianchi a riposo: dimensiona l'ombra su qualunque modello.
    vrm.scene.updateMatrixWorld(true);
    this._hipsRestY = vrm.humanoid?.getRawBoneNode('hips')?.getWorldPosition(new THREE.Vector3()).y ?? 0;
    // La fiammella si misura sul modello: dove starebbero i piedi, alta un terzo o giu' di li'.
    this.flame.setHeight(this.modelHeight * FLAME_HEIGHT);
    this.flame.home.set(this.cameraTarget.x, this.floorY, 0);
    this._morph = null;
    this._applyForm();
    return vrm;
  }

  // ------------------------------------------------------------ forma
  /**
   * 'vrm' o 'flame'. Con `animate` la fiammella entra nel corpo (o ne esce);
   * senza, cambia e basta (all'avvio). Falso se sta gia' cambiando.
   */
  setForm(form, { animate = true } = {}) {
    const next = form === 'flame' ? 'flame' : 'vrm';
    if (this._morph || next === this.form) return false;
    // Senza corpo non c'e' dove entrare: prima si carica il VRM (load), poi si entra.
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

  /** C'e' qualcosa da mostrare: un VRM, o la fiammella da sola. */
  get framed() {
    return Boolean(this.vrm) || this.spiritOnly;
  }

  /**
   * Senza corpo: solo la fiammella, e il VRM non si carica nemmeno (meno
   * memoria e GPU). Si inquadra come se ci fosse un modello di altezza media:
   * finestra, fisica e click per pixel restano quelli di sempre, perche'
   * l'inquadratura e' proporzionale all'altezza. Se un VRM c'era, si scarica.
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
    // Sempre a figura intera: la fiammella sta dove starebbero i piedi.
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

  /** Cambio secco: una forma visibile, l'altra no, niente tagli. */
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

  /** Il petto del VRM, dove la fiammella entra ed esce. */
  _chestPoint(target) {
    const bone = this.vrm?.humanoid?.getNormalizedBoneNode('upperChest') ?? this.vrm?.humanoid?.getNormalizedBoneNode('chest');
    if (bone) return bone.getWorldPosition(target);
    return target.set(this.cameraTarget.x, this.floorY + this.modelHeight * 0.68, 0);
  }

  /**
   * La coreografia del cambio di forma.
   * Nel corpo: la fiammella sale al petto e rimpicciolisce, lampo e anelli,
   * il VRM compare dai piedi alla testa. Fuori dal corpo: lampo al petto, il
   * VRM sparisce dalla testa ai piedi e la fiammella scende a terra.
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
    // L'anello di luce sul bordo del taglio, finche' il corpo e' a meta'.
    const visible = this.avatarRoot?.visible && cut > bottom + 0.01 && cut < top - 0.01;
    this._scanRing.visible = Boolean(visible);
    if (visible) {
      const radius = this.modelHeight * 0.17;
      this._scanRing.position.set(chest.x, cut, chest.z);
      this._scanRing.scale.setScalar(radius);
    }
  }

  // ------------------------------------------------------------ sprint della fiammella
  /** Fase dello sprint dalla fisica di Electron (ready, go, brake, proud, end). */
  setSprint(phase, dir) {
    this.flame.sprint(phase, dir);
    if (phase !== 'go' && phase !== 'brake') this._sprintX = null;
  }

  /** La finestra e' avanzata fino a `x` (pixel dello schermo): la scia resta indietro. */
  sprintMove(x, speed) {
    this.flame.sprintSpeed(speed);
    if (this._sprintX !== null) this.flame.drift(-(x - this._sprintX) * this.metersPerPixel);
    this._sprintX = x;
  }

  /**
   * Un gesto per nome. Il VRM lo fa col corpo (body.js); la fiammella a modo
   * suo, se lo sa fare. Falso se non e' partito.
   */
  play(name, options) {
    if (this.form === 'flame' || this._morph) return this.flame.react(name);
    return this.body?.play(name, options) ?? false;
  }

  /** Dorme davvero (per le "zeta"). */
  get asleep() {
    if (this.form === 'flame') return this._sleep >= 0.99;
    return Boolean(this.body?.asleep);
  }

  /** L'utente le sta parlando (il microfono sente la voce). */
  setListening(value) {
    this._listening = Boolean(value);
  }

  /** Saluta con la mano (lo fa quando compare). */
  greet() {
    if (this.form === 'flame') {
      this.flame.react('greet');
      return;
    }
    if (this.body?.mode === 'stand' && this.clips?.playRole('greet')) return;
    // Ogni tanto sbuca dal basso salutando con due mani (body/booth.js).
    if (this.body?.mode === 'stand' && Math.random() < 0.35 && this.body.play('greetPop', { sign: -1 })) return;
    this.body?.play('wave', { sign: -1 });
  }

  /** Le clip .vrma disponibili (dal backend): si caricano sul modello attuale e sui prossimi. */
  setClipList(list) {
    this._clipList = list ?? [];
    return this.clips ? this.clips.load(this._clipList) : Promise.resolve([]);
  }

  /** Suona una clip a richiesta (dal pannello). */
  playClip(name) {
    if (this.form === 'flame' || !this.clips || !['stand', 'sit'].includes(this.body?.mode)) return false;
    return this.clips.play(name);
  }

  /** Una clip per un momento (`bow` a un grazie, `here` quando la chiami), se c'e' e se sta in piedi. */
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

  // ------------------------------------------------------- modalita' "pet"
  /**
   * Inquadratura: mezzo busto (bella per il lip-sync) o figura intera
   * (l'aspetto da mascotte che cammina sulla scrivania).
   * @param {'bust'|'full'} mode
   */
  setFraming(mode) {
    this.framing = mode === 'full' ? 'full' : 'bust';
    if (this.vrm) this._frameCamera();
    else if (this.spiritOnly) this._frameSpirit();
  }

  /**
   * Posizione del cursore in pixel relativi alla finestra. Puo' stare anche
   * fuori dai bordi (in Electron la sappiamo sempre): il personaggio la segue
   * con lo sguardo ovunque sia sullo schermo, ma il test dei pixel per il
   * click-through vale solo dentro la finestra.
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

  /** Audio in riproduzione e volume istantaneo, letti dal corpo a ogni frame. */
  setSpeech(playing, level) {
    this._speech.playing = playing;
    this._speech.level = level;
  }

  /** Inizia una frase: il corpo sceglie gesto, umore e atteggiamento. */
  startClip(payload) {
    this.body?.onClipStart(payload);
  }

  /** Il backend sta aspettando l'LLM: posa pensierosa. */
  setThinking(value) {
    this._thinking = Boolean(value);
    if (!this._thinking) this._working = null;
    this.body?.setThinking(this._thinking);
  }

  /** Come sta in piedi (body/stances.js): resta scelto anche cambiando modello. */
  setStance(name) {
    this._stance = name;
    this.body?.setStance(name);
  }

  /** L'agente usa un tool (`read`, `write`, `run`...): posa da lavoro invece che pensierosa. */
  setWorking(kind) {
    this._working = kind || null;
    this.body?.setWorking(kind);
  }

  /**
   * Presa col mouse: penzola dalla collottola. Restituisce di quanti pixel
   * spostare la finestra perche' la collottola finisca sotto il cursore
   * (px, py), qualunque punto del corpo si sia afferrato. La fiammella si
   * prende per il bulbo.
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

  /** Dove si trova ora la finestra trascinata, in pixel dello schermo. */
  moveHold(screenX, screenY) {
    if (this.form === 'flame') this.flame.moveHold(screenX);
    else this.body?.moveHold(screenX, screenY);
  }

  endHold() {
    this.flame.setHeld(false);
    this.body?.endHold();
  }

  setFalling() {
    // Anche il corpo nascosto tiene il conto: quando torna sa se e' in piedi o seduta.
    this.body?.setFalling();
    if (this.form === 'flame') this.flame.fall();
  }

  /**
   * @param {number} impact 0..1, quanto forte e' arrivata
   * @param {'stand'|'sit'} posture in piedi sulla barra o seduta su una finestra
   */
  landed(impact, posture = 'stand') {
    this.body?.landed(impact, posture);
    if (this.form === 'flame') this.flame.land(impact);
    else this.flame.falling = false;
  }

  /** Seduta, sdraiata (a pancia in giu' o sul fianco) o in piedi sulla barra. */
  setPosture(posture) {
    // Sul fianco la testa va verso il centro dello schermo, dove c'e' spazio.
    const middle = window.screenX + window.innerWidth / 2;
    const screenMiddle = (window.screen.availLeft ?? 0) + window.screen.availWidth / 2;
    this.body?.setPosture(posture, middle > screenMiddle ? 1 : -1);
  }

  /** Ritmo della musica (vedi music.js), a ogni frame. */
  setMusic(state) {
    this._music = this._dancing ? state : null;
    this.body?.setMusic(state);
    // Con una clip dance*.vrma balla quella, in loop, finche' la musica suona.
    const clips = this.clips;
    if (!clips) return;
    const dancing = state?.active && this._dancing && this.form === 'vrm' && this.body?.mode === 'stand';
    const current = clips.active?.clip;
    if (dancing && !current && clips.has('dance')) clips.playRole('dance', { loop: true });
    else if (!dancing && current?.role === 'dance' && !clips.active.stopping) clips.stop();
  }

  /** Ballare con la musica si puo' spegnere dal pannello. */
  setDancing(value) {
    this._dancing = Boolean(value);
    if (this.body) this.body.dancing = this._dancing;
  }

  /**
   * Aggrappata al bordo dello schermo: `edgeRatio` e' la posizione del bordo
   * nella finestra, in frazione della larghezza.
   */
  setEdge(side, edgeRatio) {
    if (!this.body) return;
    const px = edgeRatio * window.innerWidth;
    const edge = this._rayToPlane(px, window.innerHeight / 2, this.cameraTarget, new THREE.Vector3());
    this.body.setEdge(side, edge.x);
  }

  /** La finestra su cui e' seduta si sta spostando (pixel dello schermo). */
  carried(x, y) {
    this.body?.carried(x, y);
  }

  /** Gesti e cambi di posa spontanei, dal pannello. */
  setSpontaneous(value) {
    this._spontaneous = Boolean(value);
    if (this.body) this.body.spontaneous = this._spontaneous;
  }

  /** Sonno: 0 sveglia, 0.5 assonnata, 1 addormentata (vedi presence.js). */
  setSleep(level) {
    this._sleep = level;
    this.body?.setSleep(level);
  }

  /** Dove sta la testa, in pixel della finestra: da li' salgono le "zeta" del sonno. */
  headScreen() {
    if (this.form === 'flame' && this.framed) return this._toScreen(this.flame.topWorld());
    const head = this.vrm?.humanoid.getNormalizedBoneNode('head');
    if (!head) return null;
    this._headPoint ??= new THREE.Vector3();
    return this._toScreen(head.getWorldPosition(this._headPoint));
  }

  /**
   * Dove stanno piedi, seduta e asse del corpo nella finestra, in frazioni
   * delle sue dimensioni: servono a Electron per appoggiarla sulla barra o
   * sul bordo di una finestra. Con l'inquadratura proporzionale non cambiano
   * al cambiare della scala.
   */
  _computeAnchors() {
    if (this.form === 'flame') {
      // La fiammella poggia col fondo: piedi e seduta coincidono (su una finestra ci sta sopra).
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
   * Dove sta il busto adesso, in pixel della finestra: i dock del HUD si
   * aprono ai suoi lati e lo seguono (in piedi, seduta, sdraiata).
   */
  hudFrame() {
    if (!this.framed) return null;
    if (this.form === 'flame') {
      const center = this._toScreen(this.flame.centerWorld());
      return { cx: center.x, cy: center.y };
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
   * Click senza trascinare: sulla testa e' una carezza, sul corpo un colpetto.
   * Restituisce la reazione (`pat`, `flinch`) o `null`.
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

  /** Punto del mondo -> pixel della finestra. */
  _toScreen(point) {
    point.project(this.camera);
    return {
      x: (point.x * 0.5 + 0.5) * window.innerWidth,
      y: (-point.y * 0.5 + 0.5) * window.innerHeight,
    };
  }

  /** Pixel della finestra -> punto sul piano verticale che passa per il personaggio. */
  _pointOnAvatarPlane(px, py, target) {
    return this._rayToPlane(px, py, this.cameraTarget, target);
  }

  /** Raggio dalla camera attraverso il pixel (px, py), intersecato col piano
   * perpendicolare allo sguardo della camera che passa per `planePoint`. */
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
    const t = planePoint.clone().sub(origin).dot(normal) / Math.max(1e-6, direction.dot(normal));
    return target.copy(origin).addScaledVector(direction, t);
  }

  /**
   * Dove sta guardando il cursore, nel mondo 3D. Il cursore vive sul vetro
   * dello schermo, cioe' dalla parte della camera: lo proiettiamo su un piano
   * a meta' strada fra il personaggio e la camera. Su quel piano un cursore
   * lontano (anche fuori dalla finestra) produce un angolo ampio ma sensato.
   */
  /**
   * Il cursore e' fermo sopra la sua testa da un attimo: prova a toccarlo.
   * Restituisce il punto (sul piano della testa) o `null`.
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

  /** Metri di scena per pixel di schermo, alla distanza del personaggio. */
  get metersPerPixel() {
    const visible = 2 * this.orbit.distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    return visible / Math.max(1, window.innerHeight);
  }

  /**
   * Legge l'alpha del pixel esattamente sotto il cursore dal framebuffer
   * appena disegnato. E' cosi' che si ottiene il click-through "vero" di
   * Desktop Mate: il mouse attraversa la finestra ovunque tranne dove ci sono
   * pixel davvero opachi del personaggio.
   */
  _sampleAlphaUnderPointer() {
    const { x, y } = this.pointerPx;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return 0;

    const gl = this.renderer.getContext();
    const ratio = this.renderer.getPixelRatio();
    const px = Math.floor(x * ratio);
    // WebGL ha l'origine in basso a sinistra, il DOM in alto a sinistra.
    const py = Math.floor((window.innerHeight - y) * ratio);
    if (px < 0 || py < 0 || px >= gl.drawingBufferWidth || py >= gl.drawingBufferHeight) return 0;

    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this._pixelBuffer);
    return this._pixelBuffer[3] / 255;
  }

  /** Inquadra la testa del personaggio appena caricato. */
  _frameCamera() {
    // Le matrici mondo non sono ancora state calcolate: senza questo la
    // posizione della testa risulterebbe (0, 0, 0).
    this.vrm.scene.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(this.vrm.scene);
    this.modelHeight = Math.max(0.2, box.max.y - box.min.y);
    this.floorY = box.min.y;

    if (this.framing === 'full') {
      // Figura intera coi piedi quasi sul bordo inferiore (la finestra poggia
      // sulla barra delle applicazioni) e spazio sopra la testa per le
      // braccia alzate: stiracchiarsi e salutare non devono uscire dal quadro.
      const span = this.modelHeight * FULL_FRAME;
      box.getCenter(this.cameraTarget);
      this.cameraTarget.y = box.min.y + span / 2 - this.modelHeight * 0.015;
      this.baseDistance = this._distanceFor(span);
    } else {
      const humanoid = this.vrm?.humanoid;
      // Il bone "raw" e' quello del modello vero, con la scala e l'altezza
      // effettive; quello normalizzato serve invece per pilotare le pose.
      const head = humanoid?.getRawBoneNode?.('head') ?? humanoid?.getNormalizedBoneNode('head');
      if (head) {
        head.getWorldPosition(this.cameraTarget);
      } else {
        box.getCenter(this.cameraTarget);
        this.cameraTarget.y = box.max.y - this.modelHeight * 0.12;
      }
      // Miriamo un po' sotto la testa, cosi' entrano anche le spalle.
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
   * Distanza necessaria per inquadrare `span` metri in verticale.
   *
   * Su finestre strette (quella di Electron e' verticale) il vincolo diventa
   * la larghezza delle spalle, altrimenti il personaggio verrebbe tagliato ai
   * lati: prendiamo quindi la distanza maggiore fra le due.
   */
  _distanceFor(span) {
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const vertical = span / 2 / Math.tan(halfFov);
    const horizontal = SHOULDER_SPAN / 2 / (Math.tan(halfFov) * Math.max(0.1, this.camera.aspect));
    return Math.max(vertical, horizontal);
  }

  // ---------------------------------------------------------------- drivers
  /**
   * Decide come muovere la bocca:
   *  - `expression`: il modello espone i preset VRM 1.0 (aa/ih/ou/ee/oh);
   *  - `morph`: pilotiamo direttamente i morph target `fcl_mth_*` di VRoid;
   *  - `none`: nessuna blendshape della bocca trovata.
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

    // I VRoid recenti esportano "Fcl_MTH_A", i piu' vecchi "fcl_mth_a":
    // confrontiamo sempre in minuscolo.
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
    return { kind: 'none', label: 'nessuna blendshape bocca' };
  }

  _detectBlinkDriver(vrm) {
    if (vrm.expressionManager?.getExpression('blink')) {
      return { kind: 'expression', name: 'blink' };
    }
    // Solo la chiusura di entrambi gli occhi: "_L"/"_R" farebbero doppio conteggio.
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

  /** Nome leggibile del driver attivo (mostrato nel pannello di debug). */
  get mouthDriverLabel() {
    return this.mouthDriver.label ?? this.mouthDriver.kind;
  }

  // ----------------------------------------------------------------- update
  /** Registra una callback eseguita a ogni frame: `(dt, elapsed) => weights`. */
  onFrame(callback) {
    this.frameCallbacks.add(callback);
    return () => this.frameCallbacks.delete(callback);
  }

  start() {
    if (this._animationId !== null) return;
    let last = -Infinity;
    const loop = (now) => {
      this._animationId = requestAnimationFrame(loop);
      // Un paio di ms di tolleranza: rAF non cade mai esattamente sul millisecondo.
      if (now - last < 1000 / this.targetFps() - 2) return;
      last = now;
      this._tick();
    };
    this._animationId = requestAnimationFrame(loop);
  }

  /** Quanti frame al secondo servono adesso (vedi FPS). */
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
    const dt = Math.min(this.clock.getDelta(), 0.1); // clamp: evita salti dopo un lag
    this.elapsed += dt;

    this._fpsAccumulator += dt;
    this._fpsFrames += 1;
    if (this._fpsAccumulator >= 0.5) {
      this.fps = Math.round(this._fpsFrames / this._fpsAccumulator);
      this._fpsAccumulator = 0;
      this._fpsFrames = 0;
    }

    // Le callback restituiscono i pesi della bocca per questo frame.
    let mouth = null;
    for (const callback of this.frameCallbacks) {
      const result = callback(dt, this.elapsed);
      if (result) mouth = result;
    }

    this._updateCamera(dt);
    this._updateMorph(dt);

    // Le ancore si misurano a camera ferma, subito dopo il suo aggiornamento.
    if (this._anchorsDirty && (this.body || this.spiritOnly) && this.onAnchors) {
      if (Math.abs(this.orbit.distance - this.orbit.targetDistance) < 1e-3) {
        this._anchorsDirty = false;
        this.onAnchors(this._computeAnchors());
      }
    }

    if (this.framed && this.flame.root.visible) {
      this.flame.update(dt, {
        speaking: this._speech.playing,
        level: this._speech.level,
        thinking: this._thinking,
        working: this._working,
        listening: this._listening,
        sleep: this._sleep,
        look: this._flameLook(),
        music: this._music,
      });
    } else if (this.flame.fx.active) {
      // Lampo e anelli dell'ingresso nel corpo finiscono anche a fiammella sparita.
      this.flame.fx.update(dt);
    }

    // Il corpo nascosto dietro la fiammella non si anima: risparmia la CPU.
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
      // Le clip .vrma sopra la posa procedurale; solo in piedi o seduta.
      if (this.clips?.playing && !['stand', 'sit'].includes(this.body.mode)) this.clips.stop();
      this.clips?.apply(dt);
      this._updateBlink(dt);
      this._applyMoods();

      // Lo sbadiglio apre la bocca anche quando non sta parlando.
      const yawn = this.body.mouthOpen;
      if (yawn > 0.001) mouth = { ...mouth, a: Math.max(mouth?.a ?? 0, yawn), o: Math.max(mouth?.o ?? 0, 0.3 * yawn) };

      // Le espressioni vanno impostate PRIMA di vrm.update(), i morph grezzi
      // DOPO (altrimenti l'expression manager li sovrascriverebbe).
      if (mouth && this.mouthDriver.kind === 'expression') this._applyMouthExpressions(mouth);
      this.vrm.update(dt);
      if (mouth && this.mouthDriver.kind === 'morph') this._applyMouthMorphs(mouth);
    }
    // Il tablet/tastiera olografici seguono le mani appena posate.
    this.holo.update(dt, this.vrm, this.form === 'vrm' && !this._morph ? (this.body?.workWeights ?? null) : null);
    this._updateShadow();

    this.renderer.render(this.scene, this.camera);

    // Subito DOPO il render, con il frame ancora nel buffer: cosi' sappiamo
    // se il cursore e' su un pixel del personaggio o sul vuoto trasparente.
    this.lastAlpha = this._sampleAlphaUnderPointer();
    this.pointerOnAvatar = this.lastAlpha > 0.12;
  }

  /**
   * Dove guarda la fiammella, da -1 a 1 sui due assi: verso il cursore, anche
   * fuori dalla finestra. Dopo qualche secondo di cursore fermo si guarda intorno.
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
   * Battito di ciglia: casuale, a volte doppio, e anche quando lo sguardo
   * salta lontano (lo facciamo tutti). Niente battito se gli occhi sono gia'
   * chiusi da un sorriso: le due chiusure sommate deformerebbero le palpebre.
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

  /** Umore, sorrisi e spaventi decisi dal corpo, sulle espressioni preset. */
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
