/**
 * Il corpo del personaggio: animazione procedurale in stile Desktop Mate.
 *
 * Desktop Mate anima i suoi personaggi con clip in motion capture. Qui non ne
 * abbiamo, quindi ricostruiamo a mano gli ingredienti che fanno sembrare vivo
 * un corpo, che sono sorprendentemente pochi ma vanno fatti tutti:
 *
 *  - postura: il peso sta su una gamba sola (contrapposto) e ogni tanto passa
 *    all'altra; il bacino si inclina, spalle e testa compensano, le ginocchia
 *    restano morbide invece che bloccate;
 *  - piedi piantati: IK a due ossa sulle gambe, cosi' il bacino puo' muoversi
 *    senza che i piedi scivolino sul pavimento;
 *  - respiro asimmetrico (si inspira piu' in fretta di quanto si espira) che
 *    solleva petto e spalle;
 *  - braccia che pendono per gravita' e seguono il busto in ritardo, mani
 *    rilassate con le dita piegate (le dita dritte sono la firma del robot);
 *  - sguardo a cascata: arrivano prima gli occhi, poi la testa, poi collo e
 *    busto; quando il cursore e' fermo guarda te, con qualche occhiata altrove;
 *  - piccole azioni spontanee: si stiracchia, si guarda intorno, si sistema i
 *    capelli, mette le mani dietro la schiena, canticchia, inclina la testa;
 *  - linguaggio del corpo mentre parla, posa pensierosa mentre l'LLM elabora;
 *  - la vita sul desktop: seduta sul bordo delle finestre con le gambe che
 *    dondolano, sdraiata sulla barra delle applicazioni (a pancia in giu' o
 *    distesa sul fianco), aggrappata al bordo dello schermo, presa per la
 *    collottola col mouse, in caduta, atterrata;
 *  - la musica: quando suona Spotify si muove a tempo (vedi music.js).
 *
 * Modalita' del corpo (sfumano l'una nell'altra): `stand`, `sit`, `lie`,
 * `side`, `edge`, `held`, `fall`. Dove si trova la finestra lo decide il
 * processo Electron (pet-physics.js); qui si decide come sta il corpo.
 *
 * Convenzioni. Le pose sono scritte per un VRM 1.0 (guarda verso +Z, la sua
 * sinistra e' +X) sui bone *normalizzati* di three-vrm, che in T-pose hanno
 * rotazione nulla. I VRM 0.x nel loro spazio guardano verso -Z: basta
 * invertire le componenti X e Z (vedi `flip`). Braccia e gambe si scrivono per
 * il lato SINISTRO; il destro si ottiene a specchio (Y e Z cambiano segno).
 *
 * Promemoria degli assi, per il lato sinistro:
 *   braccio: Z- abbassa dalla T-pose, X- porta avanti; avambraccio: Y- piega il
 *   gomito; mano: Z- flette il polso; dita: Z- chiude; spalla: Z+ alza.
 *   gamba: X- porta avanti, Z+ allarga; ginocchio: X+ piega; piede: X+ punta.
 *   busto/testa: X+ in avanti, Y+ ruota verso la sua sinistra, Z+ inclina
 *   verso la sua destra.
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

// Temporanei riutilizzati: niente allocazioni nel loop di rendering.
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

// ----------------------------------------------------------------- animatore
export class BodyAnimator {
  /**
   * @param {import('@pixiv/three-vrm').VRM} vrm
   * @param {THREE.Object3D} root gruppo che contiene `vrm.scene`: ruotandolo
   *   il corpo intero penzola, si sdraia, si sporge dal bordo.
   * @param {THREE.Object3D} lookTarget oggetto seguito dagli occhi (vrm.lookAt)
   */
  constructor(vrm, root, lookTarget) {
    this.vrm = vrm;
    this.root = root;
    this.lookTarget = lookTarget;
    this.humanoid = vrm.humanoid;
    /** VRM 0.x guarda verso -Z nel suo spazio: X e Z delle pose vanno invertite. */
    this.flip = vrm.meta?.metaVersion === '0' ? -1 : 1;

    this.pose = new Pose();
    this.time = 0;

    this._initSkeleton();

    // --- postura in piedi ---------------------------------------------------
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

    // --- sguardo --------------------------------------------------------
    this.head = { yaw: new Spring(5.5), pitch: new Spring(5.5) };
    this.eyes = { yaw: 0, pitch: 0 };
    this.saccade = { yaw: 0, pitch: 0, timer: 1 };
    this.idleGlance = { yaw: 0, pitch: 0, timer: 2 };
    this.blinkRequested = false;

    // --- parlato ----------------------------------------------------------
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
    // --- sonno: il PC e' fermo da un po' (vedi presence.js) ----------------
    /** 0 = sveglia, 0.5 = assonnata, 1 = addormentata. */
    this.sleepTarget = 0;
    this.sleep = 0;
    /** Colpi di sonno da assonnata: la testa cade piano e si rialza di scatto. */
    this.doze = { drop: 0, falling: false, timer: randomBetween(2, 4), jerk: 0 };
    this.sleepSide = 1;
    this.yawnTimer = randomBetween(3, 8);

    // --- azioni e pose spontanee ------------------------------------------
    this.actions = [];
    this.fidgetTimer = randomBetween(...FIDGET_DELAY);
    this.lastFidget = null;
    /** Gesti e cambi di posa spontanei: si spengono dal pannello. */
    this.spontaneous = true;
    this.postureTimer = randomBetween(...POSTURE_DELAY);
    /** Chiamata quando vuole sedersi/sdraiarsi/alzarsi: la esegue Electron. */
    this.onPostureRequest = null;

    // --- musica -------------------------------------------------------------
    this.music = { active: false, bpm: 0, phase: 0, beat: 0, energy: 0, confidence: 0 };
    /** Quanto si lascia andare alla musica, e quanto e' sicura del tempo. */
    this.vibe = new Spring(1.6);
    this.groove = new Spring(1.2);
    /** Si spegne dal pannello. */
    this.dancing = true;

    // --- modalita' del corpo ----------------------------------------------
    this.mode = 'stand';
    this.modeWeight = { stand: 1, sit: 0, lie: 0, side: 0, edge: 0, held: 0, fall: 0 };
    /** Su cosa poggia: 'ground' (barra), 'window', 'edge' o null (in aria). */
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

    // Seduta: gambe che dondolano, sballottata se la finestra si muove.
    this.legSwing = { amount: new Spring(1.5, 0.5), target: 0.5, timer: 3 };
    this.sitBounce = new Wobble(12, 0.35);
    this.sway = new Wobble(6, 0.22);
    this.carry = { x: null, y: null, px: null, py: null, vx: 0, vy: 0 };

    // Bordo dello schermo: dove stanno le mani e il perno della sporgenza.
    this.edge = {
      sign: 1,
      pivot: new THREE.Vector3(),
      grips: [new THREE.Vector3(), new THREE.Vector3()],
    };

    // --- espressioni ------------------------------------------------------
    this.expressions = Object.fromEntries(MOODS.map((mood) => [mood, 0]));
  }

  // ----------------------------------------------------------- scheletro
  _initSkeleton() {
    const humanoid = this.humanoid;
    // Partiamo da una T-pose pulita: le misure dello scheletro si prendono qui.
    humanoid.resetNormalizedPose?.();

    this.bones = {};
    for (const name of Object.keys(humanoid.humanBones)) {
      const node = humanoid.getNormalizedBoneNode(name);
      if (node) this.bones[name] = node;
    }
    // Occhi e mandibola li governano lookAt ed espressioni, non noi.
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
    /** Proporzioni del modello rispetto a un personaggio di ~1,5 m. */
    this.size = this.height / 1.5;
    this.headRest = head;
    this.hipsRestWorld = hips;

    // Punti notevoli, nello spazio del rig: la collottola per cui la si
    // prende, la seduta (il fondo del bacino) e l'altezza delle spalle.
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

    // Da sdraiata il corpo ruota di 90 gradi intorno al bacino e scende fino
    // a toccare terra con la pancia.
    this.lie = {
      pivot: this.restPoint('hips'),
      // Il petto resta sollevato sui gomiti: la pancia tocca terra, i gomiti non la passano.
      offset: new THREE.Vector3(0, 0.2 * this.size - hips.y, -0.1 * this.size),
    };

    // Sul fianco il corpo ruota di 90 gradi intorno all'asse dello sguardo
    // della camera: resta rivolta verso di te, distesa lungo la barra. Il
    // bacino finisce a mezza larghezza d'anca da terra. `sign` +1 = testa a
    // sinistra (poggia sul fianco destro), -1 = testa a destra. `shift`
    // ricentra il corpo nella finestra: dal bacino le gambe sono piu' lunghe
    // del busto, quindi il perno non e' il centro della figura distesa.
    this.side = {
      sign: 1,
      pivot: this.restPoint('hips'),
      lift: 0.25 * this.size - hips.y,
      shift: 0.12 * this.size,
    };
  }

  /**
   * Catena a due ossa per l'IK. `bend` e' la direzione in cui si sposta
   * l'articolazione di mezzo quando la catena si piega (il ginocchio va
   * avanti, il gomito indietro), nello spazio del rig.
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
   * Punto notevole a riposo (`nape`, `seat`, `hips`, `head`, `shoulder`)
   * nello spazio del gruppo che contiene il modello, cioe' nel mondo quando
   * il corpo non e' ruotato. Serve alla scena per le ancore della finestra.
   */
  restPoint(name, target = new THREE.Vector3()) {
    return target.copy(this.restPoints[name]).applyMatrix4(this.vrm.scene.matrix);
  }

  /** Bone di riferimento per le mani, con ripieghi per i modelli senza upperChest. */
  _anchor(name) {
    const b = this.bones;
    if (name === 'upperChest') return b.upperChest ?? b.chest ?? b.spine;
    if (name === 'chest') return b.chest ?? b.spine;
    return b[name] ?? b.hips;
  }

  /** Vettore scritto nelle convenzioni VRM 1.0, portato nello spazio del rig. */
  _rig(target, x, y, z) {
    return target.set(x * this.flip, y, z * this.flip);
  }

  // ----------------------------------------------------------- comandi
  /** Avvia un'azione per nome (utile anche dalla console: `stage.body.play('stretch')`). */
  play(name, options = {}) {
    const def = ACTIONS[name];
    if (!def || !def.modes.includes(this.mode)) return false;
    // Una reazione interrompe tutto il resto; un'azione non si sovrappone a se stessa.
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

  setThinking(value) {
    this.thinking = Boolean(value);
    if (this.thinking) this._cancelIdleActions();
  }

  /**
   * Sonno: 0 sveglia, 0.5 assonnata, 1 addormentata. Ci si addormenta piano,
   * in una decina di secondi; ci si sveglia in un attimo, sbattendo le palpebre.
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

  /** Dorme davvero (non solo assonnata). */
  get asleep() {
    return this.sleep > 0.75;
  }

  /** Bocca aperta dal corpo (lo sbadiglio), letta dalla scena a ogni frame. */
  get mouthOpen() {
    return this.pose.mouthOpen;
  }

  /** Una nuova frase sta per essere pronunciata: sceglie gesto, umore e testa. */
  onClipStart({ text = '', mood = null, duration = 1, vocal = null } = {}) {
    const speech = this.speech;
    const trimmed = text.trim();
    speech.clipStart = this.time;
    speech.clipDuration = Math.max(0.3, duration);
    speech.question = trimmed.endsWith('?');
    speech.emphatic = trimmed.endsWith('!');
    speech.mood = mood;
    if (vocal) {
      // Un versetto ("Hii!", "Ehehe!") accompagna un gesto gia' in corso,
      // come il saluto: niente gesti delle mani e nessuna interruzione.
      speech.gesture = null;
      speech.yawTarget = 0;
      speech.rollTarget = 0;
      return;
    }

    // Un gesto diverso a ogni frase, ma non sempre: gesticolare di continuo stanca.
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
   * Presa col mouse, per la collottola come un gattino: il corpo penzola da
   * li'. La scena sposta la finestra perche' la collottola finisca sotto il
   * cursore, qualunque punto si sia afferrato.
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

  /** Posizione della finestra mentre e' in mano (pixel dello schermo). */
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
   * Arrivata su qualcosa: sulla barra atterra in piedi piegando le ginocchia,
   * sul bordo di una finestra si siede con un piccolo rimbalzo.
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
   * Cambio di posa sulla barra, deciso qui e confermato da Electron.
   * @param {number} [sign] sul fianco: +1 testa a sinistra, -1 a destra
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
   * Aggrappata al bordo dello schermo. `edgeX` e' la x del bordo nel mondo:
   * le mani ci si appoggiano e il corpo si sporge verso l'interno.
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

  /** La finestra su cui e' seduta si e' spostata (pixel dello schermo). */
  carried(x, y) {
    this.carry.x = x;
    this.carry.y = y;
  }

  /**
   * Tocco: sulla testa e' una carezza, sul corpo un piccolo spavento.
   * Restituisce la reazione partita (`pat`, `flinch`) o `null`.
   */
  poke(region) {
    if (!POSTURES.includes(this.mode)) return null;
    if (region !== 'head' && (this.mode === 'lie' || this.mode === 'side')) return null;
    const name = region === 'head' ? 'pat' : 'flinch';
    return this.play(name) ? name : null;
  }

  /** Ritmo della musica che sta suonando (vedi music.js), a ogni frame. */
  setMusic(state) {
    this.music = state;
  }

  /** Quanto bisogna sopprimere il battito di ciglia (occhi gia' chiusi dal sorriso). */
  get blinkSuppression() {
    return clamp(this.expressions.happy * 1.2, 0, 1);
  }

  /** Il battito di ciglia richiesto da un cambio di sguardo (letto una volta). */
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
   * @param {boolean} ctx.speaking   c'e' audio in riproduzione
   * @param {number} ctx.level       volume istantaneo 0..1
   * @param {THREE.Vector3|null} ctx.gazePoint punto del cursore nel mondo
   * @param {boolean} ctx.gazeFresh  il cursore si e' mosso da poco
   * @param {THREE.Vector3} ctx.viewer posizione della camera (lo spettatore)
   * @param {number} ctx.metersPerPixel scala schermo -> scena, per la fisica
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
   * Pendolo: quando e' in mano il corpo penzola dal punto di presa. La
   * finestra che accelera di lato spinge il corpo nella direzione opposta,
   * poi la gravita' lo riporta giu' con qualche oscillazione.
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

    // Accoppiamento ridotto: con la fisica "vera" uno strattone del mouse lo
    // farebbe girare di 45 gradi e uscire dalla finestra.
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
   * Seduta su una finestra che si sposta: le accelerazioni della finestra la
   * sballottano (busto che ondeggia, gambe che ciondolano, piccoli sobbalzi).
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

    // Gesti spontanei solo quando e' tranquilla: ferma, zitta, senza pensieri.
    const settled = RESTING.includes(this.mode) && this.modeWeight[this.mode] > 0.95;
    const quiet = !this.thinking && !ctx.speaking && this.time - this.speech.lastActive > 2;
    if (!settled || !quiet) return;

    // Assonnata ogni tanto sbadiglia; addormentata non fa nient'altro.
    if (this.sleepTarget > 0 || this.sleep > 0.05) {
      this.yawnTimer -= dt;
      if (this.sleep > 0.25 && this.sleep < 0.7 && this.yawnTimer <= 0 && !this.actions.length) {
        this.yawnTimer = randomBetween(12, 25);
        this.play('yawn');
      }
      return;
    }
    if (!this.spontaneous) return;

    // Sulla barra ogni tanto si siede sul bordo o si sdraia, poi si rialza.
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

    // Mentre balla non si mette a fare altro.
    if (this.actions.length || this.vibe.x > 0.3) return;
    this.fidgetTimer -= dt;
    if (this.fidgetTimer > 0) return;
    this.fidgetTimer = randomBetween(...FIDGET_DELAY);

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

  // ----------------------------------------------------------- strati comuni
  /** Respiro: inspira in ~40% del ciclo, espira nel resto. */
  _breathe(pose, dt, ctx, w) {
    // Nel sonno il respiro rallenta e si fa piu' profondo.
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
   * Le braccia pendono per gravita': quando il busto si inclina le
   * raddrizziamo, con un filo di ritardo, come un peso appeso.
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

  // ----------------------------------------------------------- in piedi
  _stand(pose, dt, w) {
    const t = this.time;
    pose.legIK += w;

    // --- peso su una gamba (contrapposto), cambia ogni tanto ---------------
    this.weightTimer -= dt;
    if (this.weightTimer <= 0) {
      const roll = Math.random();
      this.weightTarget = roll < 0.12 ? 0 : roll < 0.56 ? -1 : 1;
      this.weightTimer = randomBetween(4, 11);
    }
    const weight = this.weight.update(this.weightTarget, dt);
    const lean = Math.abs(weight);
    // Bacino sopra la gamba d'appoggio, piu' alto da quel lato; il busto
    // compensa in senso opposto e la testa torna dritta.
    pose.hips.x += 0.022 * weight * w;
    // Pochi millimetri bastano: vicino alla gamba tesa il ginocchio e'
    // sensibilissimo (5 mm di bacino piu' basso = ~13 gradi di piega).
    pose.hips.y -= (0.002 + 0.0025 * lean) * w;
    pose.add('hips', 0, 0.05 * weight * w, 0.055 * weight * w);
    pose.add('spine', 0, -0.03 * weight * w, -0.045 * weight * w);
    pose.add('chest', 0, -0.02 * weight * w, -0.03 * weight * w);
    pose.add('neck', 0, 0, 0.012 * weight * w);
    pose.add('head', 0, 0, 0.008 * weight * w);
    // La gamba libera va un po' avanti e in fuori, col tallone appena alzato.
    for (const side of SIDES) {
      const s = side === 'left' ? 1 : -1;
      const free = clamp(-weight * s, 0, 1) * w;
      pose.feet[side].x += 0.018 * s * free;
      pose.feet[side].z += 0.045 * free;
      pose.heel[side] += 0.12 * free;
    }

    // --- oscillazione posturale: nessuno sta fermo come una statua ------------
    const n = this.noise;
    pose.hips.x += 0.006 * n.swayX(t) * w;
    pose.hips.z += 0.005 * n.swayZ(t) * w;
    pose.add('spine', 0.008 * n.spine(t) * w, 0, 0.008 * n.swayX(t + 3) * w);

    // --- braccia e mani a riposo -------------------------------------------
    pose.both('Shoulder', 0, 0, -0.03, w);
    pose.both('UpperArm', 0.03, 0.05, -1.24, w);
    pose.both('LowerArm', 0, -0.32, 0, w);
    pose.both('Hand', 0, -0.06, -0.1, w);
    pose.add('spine', 0.02 * w, 0, 0);
    pose.add('chest', -0.015 * w, 0, 0);
  }

  // ----------------------------------------------------------- seduta
  /**
   * Seduta sul bordo (di una finestra o della barra): cosce in avanti,
   * stinchi giu' davanti al bordo, piedi che dondolano, mani sulle cosce.
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
      // Le gambe ciondolano quando la finestra si muove.
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

  // ----------------------------------------------------------- sdraiata
  /**
   * Sdraiata a pancia in giu' sulla barra, rivolta verso di te: appoggiata
   * ai gomiti, mento fra le mani, piedi che scalciano piano in aria.
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

  // ----------------------------------------------------------- sul fianco
  /**
   * Distesa sul fianco lungo la barra, rivolta verso di te: busto sollevato
   * sul gomito, testa appoggiata alla mano, l'altro braccio abbandonato sul
   * fianco, gambe piegate con quella di sopra piu' avanti che dondola piano.
   * La rotazione del corpo intero la fa `_rootTransform`; qui le ossa sono
   * scritte nello spazio del personaggio, come se fosse in piedi.
   */
  _side(pose, w) {
    const t = this.time;
    const sign = this.side.sign;
    const low = sign > 0 ? 'right' : 'left';
    const high = sign > 0 ? 'left' : 'right';
    // Z+ inclina verso la sua destra: il busto si solleva piegandosi verso il fianco di sopra.
    const up = -sign;
    pose.add('spine', 0, 0, 0.22 * up * w);
    pose.add('chest', 0, 0, 0.2 * up * w);
    pose.add('upperChest', 0, 0, 0.12 * up * w);
    pose.add('neck', 0, 0, 0.1 * up * w);
    pose.add('head', 0.04 * w, 0, (0.12 + 0.03 * Math.sin(t * 0.5)) * up * w);

    // Gomito a terra sotto la spalla, la tempia appoggiata nel palmo.
    pose.reach(low, 'head', [0.08, -0.07, 0.05], [1, -0.6, 0.1], w, 0.9, true);
    pose.fingers[low] += 0.1 * w;
    // Il braccio di sopra riposa davanti a lei, la mano sulla coscia.
    pose.reach(high, 'hips', [0.15, -0.1, 0.18], [0.5, -0.2, -0.8], w, 0.2, true);
    pose.fingers[high] += 0.3 * w;

    // La gamba di sopra si apre verso l'alto (cosi' si vede, invece di
    // sovrapporsi all'altra in profondita') e dondola piano.
    for (const leg of SIDES) {
      const top = leg === high;
      const swing = top ? Math.sin(t * TAU * 0.22) : 0;
      pose.side(leg, 'UpperLeg', top ? -0.4 + 0.06 * swing : -0.18, 0, top ? 0.14 : 0.02, w);
      pose.side(leg, 'LowerLeg', top ? 0.7 + 0.12 * swing : 0.3, 0, 0, w);
      pose.side(leg, 'Foot', 0.3, 0, 0, w);
    }
    pose.mood('relaxed', 0.4 * w);
  }

  // ----------------------------------------------------------- musica
  /**
   * Si muove a tempo con la musica: testa che annuisce sul battito, peso che
   * passa da una gamba all'altra ogni due battiti, spalle che molleggiano. Se
   * il tempo non e' affidabile (musica d'atmosfera, parlato) ondeggia piano
   * per conto suo invece di annuire fuori tempo. Mai mentre parla o pensa.
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
    // 1 sul battito, 0 a meta'; "sway" arriva agli estremi sui battiti, alternando lato.
    const bob = (0.5 + 0.5 * Math.cos(TAU * m.phase)) ** 2 * groove;
    const sway = groove * Math.cos(Math.PI * (m.beat + m.phase)) + (1 - groove) * Math.sin(this.time * TAU * 0.3);
    const upright = W.stand + W.sit;

    pose.add('head', 0.13 * bob * amp, 0.05 * sway * amp, -0.09 * sway * amp);
    pose.add('neck', 0.07 * bob * amp, 0, -0.03 * sway * amp);
    pose.add('spine', 0.03 * bob * amp * upright, 0, 0.06 * sway * amp * upright);
    pose.add('chest', 0.02 * bob * amp * upright, 0.05 * sway * amp * upright, 0.03 * sway * amp * upright);
    pose.both('Shoulder', 0, 0, 0.06 * bob * amp * upright);
    // Le braccia seguono il corpo con un filo di ritardo: mezzo battito dopo.
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
      // Batte il piede di sopra a tempo.
      const high = this.side.sign > 0 ? 'left' : 'right';
      pose.side(high, 'LowerLeg', 0.18 * bob, 0, 0, W.side * amp);
      pose.side(high, 'Foot', 0.2 * bob, 0, 0, W.side * amp);
    }
    pose.mood('happy', 0.3 * vibe);
    pose.mood('relaxed', 0.2 * vibe);
  }

  // ----------------------------------------------------------- bordo
  /** Aggrappata al bordo dello schermo: mani sul bordo, sbircia dentro, gambe a penzoloni. */
  _edge(pose, w) {
    const t = this.time;
    const s = this.edge.sign;
    // La mano dal lato del bordo sta piu' in alto, l'altra poco sotto.
    const near = s > 0 ? 'right' : 'left';
    const far = s > 0 ? 'left' : 'right';
    pose.reachWorld(near, this.edge.grips[0], [1, -1, -0.2], w, 0.3);
    pose.reachWorld(far, this.edge.grips[1], [1, -1, -0.2], w, 0.3);
    pose.fingers.left += 0.4 * w;
    pose.fingers.right += 0.4 * w;
    pose.both('UpperArm', -0.3, 0, -0.3, w);
    pose.both('LowerArm', 0, -0.6, 0, w);

    // Testa inclinata verso l'interno, come chi sbircia da dietro un angolo.
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

  // ----------------------------------------------------------- in mano
  /**
   * Presa per la collottola: busto che si incurva in avanti, testa su che
   * guarda chi la tiene, braccia e gambe a penzoloni. Scalcia solo se la scuoti.
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
    // Spalle tirate su verso le orecchie: e' il segno di chi e' preso per il colletto.
    pose.both('Shoulder', 0, 0, 0.2, w);

    // Le braccia compensano l'inclinazione del busto e restano verticali,
    // in ritardo sull'oscillazione.
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
      // Gambe un po' diverse fra loro: due gambe identiche sembrano un manichino.
      const bent = s > 0 ? 0.55 : 0.3;
      pose.side(side, 'UpperLeg', -HOLD_PITCH * 0.5 - 0.1 * (s > 0 ? 1 : 0) - 0.28 * k, 0.04, 0.05, w);
      pose.side(side, 'LowerLeg', bent + 0.45 * Math.max(0, Math.sin(phase + 1.3)) * kick, 0, 0, w);
      pose.side(side, 'Foot', 0.75, 0, 0, w);
      // Le gambe restano indietro rispetto all'oscillazione del corpo.
      pose.add(`${side}UpperLeg`, 0, 0, -0.12 * swing * w);
    }
    pose.mood('relaxed', 0.25 * w);
  }

  // ----------------------------------------------------------- in caduta
  _fall(pose, w) {
    const t = this.time;
    for (const side of SIDES) {
      const s = side === 'left' ? 1 : -1;
      // Braccia in alto che si agitano: "uaaah!".
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

  // ----------------------------------------------------------- parlato e pensiero
  /**
   * @param {number} bodyWeight quanto possono muoversi braccia e busto (in piedi o seduta)
   * @param {number} headWeight quanto puo' annuire la testa (anche sdraiata o aggrappata)
   */
  _speech(pose, dt, ctx, bodyWeight, headWeight) {
    const speech = this.speech;
    if (ctx.speaking) speech.lastActive = this.time;
    // Resta "in conversazione" per un attimo anche fra una frase e l'altra.
    const active = this.time - speech.lastActive < 0.7;
    const engage = speech.engage.update(active ? 1 : 0, dt);

    // Battute: i picchi di volume sopra la media diventano cenni della testa.
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

    // L'umore delle emoji, contenuto: con la bocca che parla un sorriso
    // pieno deformerebbe il lip-sync.
    if (speech.mood) pose.mood(speech.mood, 0.5 * engage);

    const h = engage * headWeight;
    pose.add('head', (0.1 * nod + 0.025 * ctx.level) * h, yaw * h, roll * h);
    pose.add('neck', 0.03 * nod * h, 0, 0);

    const e = engage * bodyWeight;
    if (e < EPSILON) return;
    pose.add('spine', 0.025 * e, 0, 0);

    // Domanda: verso la fine della frase alza le spalle e inclina la testa.
    const progress = clamp((this.time - speech.clipStart) / speech.clipDuration, 0, 1);
    if (speech.question) {
      const shrug = curve(progress, [[0.55, 0], [0.85, 1], [1, 0.6]]) * e;
      pose.both('Shoulder', 0, 0, 0.1, shrug);
      pose.add('head', -0.03 * shrug, 0, 0);
    }

    // Gesti delle mani, con i palmi che "battono" il ritmo delle parole.
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

  _updateSleep(dt) {
    // Addormentarsi richiede una decina di secondi, svegliarsi mezzo secondo.
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
        // Si riprende di soprassalto, sbattendo le palpebre.
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
   * Assonnata: palpebre pesanti, sguardo basso, colpi di sonno. Addormentata:
   * occhi chiusi, testa reclinata di lato, spalle abbandonate.
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

    // Smette di seguire il cursore e abbassa lo sguardo.
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

  /** Posa pensierosa: mano al mento, l'altra a sostenere il gomito, occhi in alto. */
  _thinking(pose, dt, w) {
    const k = this.think.update(this.thinking ? 1 : 0, dt) * w;
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

  _runActions(pose) {
    for (const action of this.actions) {
      const u = action.t / action.def.duration;
      const weight = action.fade * this._modeWeightOf(action.def.modes);
      if (weight > EPSILON) action.def.run(pose, u, weight, action.t, action, this);
    }
  }

  /** Atterraggio: ginocchia che si piegano e rimbalzano, braccia che si aprono. */
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
    // Espressione di spavento (presa, caduta, atterraggio) che sfuma da sola.
    const shock = this.shock.update(this.shockTarget, dt);
    if (this.mode === 'held' && this.time - this.hold.since > 1.6) this.shockTarget = 0.25;
    pose.mood('surprised', shock);
  }

  // ----------------------------------------------------------- sguardo
  /**
   * Gli occhi arrivano subito sul bersaglio, la testa li segue con calma e
   * distribuisce la rotazione su collo e busto. Senza un cursore che si muove
   * guarda lo spettatore, con qualche occhiata altrove ogni tanto.
   */
  _gaze(pose, dt, ctx) {
    const headNode = this.bones.head;
    if (!headNode) return;
    const headPos = headNode.getWorldPosition(_v1);

    // Direzione verso il cursore (o verso la camera) nello spazio del personaggio.
    const target = ctx.gazeFresh && ctx.gazePoint ? ctx.gazePoint : ctx.viewer;
    const local = this._toCharacter(_v2.copy(target).sub(headPos));
    let yaw = Math.atan2(local.x, Math.max(0.05, local.z));
    let pitch = Math.atan2(-local.y, Math.hypot(local.x, local.z));

    if (!ctx.gazeFresh) {
      // Occhiate spontanee: per lo piu' guarda te, a volte distoglie lo sguardo.
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

    // Le azioni (guardarsi intorno, pensare) possono prendersi lo sguardo.
    const override = clamp(pose.gaze.weight, 0, 1);
    if (override > 0) {
      const ow = pose.gaze.weight;
      yaw += (pose.gaze.yaw / ow - yaw) * override;
      pitch += (pose.gaze.pitch / ow - pitch) * override;
    }
    yaw = clamp(yaw, -1.3, 1.3);
    pitch = clamp(pitch, -0.7, 0.7);

    // Un grande spostamento dello sguardo di solito si accompagna a un battito.
    if (Math.abs(yaw - this.eyes.yaw) > 0.45 && Math.random() < 0.7) this.blinkRequested = true;
    this.eyes.yaw = yaw;
    this.eyes.pitch = pitch;

    // Microsaccadi: piccoli salti degli occhi, fermi fra un salto e l'altro.
    const saccade = this.saccade;
    saccade.timer -= dt;
    if (saccade.timer <= 0) {
      saccade.yaw = randomBetween(-0.03, 0.03);
      saccade.pitch = randomBetween(-0.02, 0.02);
      saccade.timer = randomBetween(0.4, 1.8);
    }

    // La testa copre la maggior parte dell'angolo, gli occhi il resto.
    const headYaw = this.head.yaw.update(clamp(yaw, -0.8, 0.8), dt);
    const headPitch = this.head.pitch.update(clamp(pitch, -0.45, 0.45), dt);
    pose.add('upperChest', 0.1 * headPitch, 0.12 * headYaw, 0);
    pose.add('neck', 0.35 * headPitch, 0.3 * headYaw, 0);
    pose.add('head', 0.45 * headPitch, 0.43 * headYaw, -0.08 * headYaw);

    if (!ctx.gazeFresh) {
      pose.add('head', 0, 0, 0.03 * this.noise.headRoll(this.time));
    }

    // Bersaglio degli occhi: un metro davanti alla testa, nella direzione voluta.
    const eyeYaw = yaw + saccade.yaw;
    const eyePitch = pitch + saccade.pitch;
    const dir = this._fromCharacter(
      _v3.set(Math.sin(eyeYaw) * Math.cos(eyePitch), -Math.sin(eyePitch), Math.cos(eyeYaw) * Math.cos(eyePitch)),
    );
    this.lookTarget.position.copy(headPos).add(dir);
  }

  /** Direzione del mondo -> spazio del personaggio (convenzioni VRM 1.0). */
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

  // ----------------------------------------------------------- applicazione
  _applyForwardKinematics(pose) {
    const f = this.flip;

    // Dita: piega di riposo, modulata da quanto la mano e' aperta o chiusa.
    for (const side of SIDES) {
      const curl = clamp(1 + pose.fingers[side], 0, 2.4);
      for (const [finger, bends] of Object.entries(FINGER_REST)) {
        PHALANGES.forEach((phalanx, i) => pose.side(side, finger + phalanx, 0, 0, -bends[i] * curl));
      }
      pose.side(side, 'ThumbMetacarpal', 0, 0.2 * curl, -0.05 * curl);
      pose.side(side, 'ThumbProximal', 0, 0.25 * curl, -0.08 * curl);
      pose.side(side, 'ThumbDistal', 0, 0.2 * curl, -0.05 * curl);
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
   * Trasformazione del corpo intero: penzolare dalla collottola, sdraiarsi,
   * sporgersi dal bordo dello schermo. Ogni modalita' ruota intorno al suo
   * perno; durante i passaggi le rotazioni si mescolano secondo i pesi.
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
      // Media pesata incrementale: slerp verso la nuova rotazione in
      // proporzione al suo peso sul totale accumulato fin qui.
      rotation.slerp(_qMode, w / accumulated);
      position.addScaledVector(offset, w);
    }
    this.root.quaternion.copy(rotation);
    this.root.position.copy(position);
  }

  /** Rotazione `q` e traslazione del gruppo per una modalita'. */
  _rootTransform(mode, q, out) {
    let pivot = null;
    if (mode === 'held') {
      // Appesa a un punto solo gira piano su se stessa, e un po' di piu'
      // quando la sposti: cosi' la si vede anche di tre quarti.
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
    // Ruotare intorno al perno = ruotare intorno all'origine e poi riportare
    // il perno dov'era.
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

    // --- gambe: piedi piantati dove stavano a riposo, piu' gli spostamenti --
    const legWeight = clamp(pose.legIK, 0, 1);
    if (legWeight > EPSILON) {
      for (const side of SIDES) {
        const chain = this.chains[`${side}Leg`];
        if (!chain) continue;
        const s = side === 'left' ? 1 : -1;
        const heel = pose.heel[side];
        const offset = pose.feet[side];
        // Alzare il tallone con la punta a terra solleva la caviglia.
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

    // --- braccia: la media pesata dei punti richiesti da gesti e azioni ----
    for (const side of SIDES) {
      const requests = pose.hands[side];
      const chain = this.chains[`${side}Arm`];
      if (!requests.length || !chain) continue;

      // Le mani "di base" (sulle cosce, sotto il mento) lasciano il posto ai gesti.
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
      // Rotazione dell'avambraccio sul suo asse: gira il palmo.
      chain.lower.quaternion.multiply(_q4.setFromAxisAngle(X_AXIS, (twist / total) * this.flip * weight));
    }
  }

  /**
   * IK analitico a due ossa. Trova la posizione dell'articolazione di mezzo
   * (legge del coseno) sul piano che contiene il bersaglio e il `pole`, poi
   * costruisce le rotazioni dei due segmenti a partire da basi ortonormali:
   * cosi' non c'e' ambiguita' sulla torsione e il ginocchio non "gira".
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
    // u2 = (punta - gomito) normalizzato, con punta = root + dir*dist e gomito = root + u1*l1.
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
