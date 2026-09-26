#!/usr/bin/env node
/**
 * BVH -> VRMA: da motion capture a clip che Tsukumo sa suonare.
 *
 *   node scripts/bvh2vrma.mjs input.bvh [output.vrma] [--start 1.2] [--end 6.5] [--trim] [--free-facing]
 *
 * --trim toglie l'attesa immobile prima e dopo il gesto; --free-facing lascia
 * che si giri come l'attore (di norma resta rivolta verso di te).
 *
 * Il problema non e' il formato ma la posa di riposo. Una clip VRMA ha le ossa
 * a riposo in T-pose; un BVH no: a rotazioni zero lo scheletro puo' essere in
 * A-pose, in T-pose o (come nei dati Bandai Namco, esportati da Maya) tutto
 * piegato, con ogni osso lungo il proprio asse X. Convertire gli angoli
 * direttamente darebbe braccia e torsioni sbagliate.
 *
 * Qui si usa il primo fotogramma, dove l'attore sta fermo in piedi, come
 * riferimento: per ogni osso si calcola la rotazione che lo porta da come sta
 * in quel fotogramma a come starebbe in T-pose (braccia in fuori, palmi in
 * giu', sguardo verso +Z), e la si applica a tutta la clip. Ossa senza una
 * direzione misurabile (testa, mani, punte dei piedi) seguono il genitore.
 *
 * Nomi delle ossa riconosciuti: Bandai Namco, Mixamo, CMU e i nomi "umani"
 * piu' comuni (vedi BONE_NAMES).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const THREE = await import(pathToFileURL(join(here, '..', 'frontend', 'node_modules', 'three', 'build', 'three.module.js')).href);
const { Matrix4, Quaternion, Vector3 } = THREE;

// ---------------------------------------------------------------------------
// Nomi delle ossa
// ---------------------------------------------------------------------------
const SIDE_NAMES = {
  Shoulder: ['shoulder{s}', '{side}shoulder', '{l}shoulder', '{l}collar', '{side}collar', 'clavicle{s}'],
  UpperArm: ['upperarm{s}', '{side}arm', '{l}arm', '{side}upperarm', '{l}shldr', 'uparm{s}', 'arm{s}'],
  LowerArm: ['lowerarm{s}', '{side}forearm', '{l}forearm', '{side}lowerarm', 'lowarm{s}', 'forearm{s}', 'elbow{s}'],
  Hand: ['hand{s}', '{side}hand', '{l}hand', 'wrist{s}'],
  UpperLeg: ['upperleg{s}', '{side}upleg', '{l}thigh', '{side}upperleg', 'upleg{s}', 'thigh{s}', '{l}upleg'],
  LowerLeg: ['lowerleg{s}', '{side}leg', '{l}shin', '{side}lowerleg', 'leg{s}', 'calf{s}', 'knee{s}', '{l}leg'],
  Foot: ['foot{s}', '{side}foot', '{l}foot', 'ankle{s}'],
  Toes: ['toes{s}', '{side}toebase', '{l}toe', '{side}toes', 'toebase{s}', 'toe{s}', '{side}toe'],
};

const BONE_NAMES = {
  hips: ['hips', 'pelvis', 'hip'],
  spine: ['spine', 'lowerback', 'spine0'],
  chest: ['chest', 'spine1'],
  upperChest: ['upperchest', 'spine2', 'chest2'],
  neck: ['neck', 'neck1'],
  head: ['head'],
};
for (const [part, patterns] of Object.entries(SIDE_NAMES)) {
  for (const [side, s, l] of [
    ['left', 'l', 'l'],
    ['right', 'r', 'r'],
  ]) {
    BONE_NAMES[`${side}${part}`] = patterns.map((p) => p.replace('{s}', s).replace('{side}', side).replace('{l}', l));
  }
}

/** Genitore di ogni osso VRM (solo quelli che scriviamo). */
const PARENT = {
  hips: null,
  spine: 'hips',
  chest: 'spine',
  upperChest: 'chest',
  neck: 'upperChest',
  head: 'neck',
  leftShoulder: 'upperChest',
  leftUpperArm: 'leftShoulder',
  leftLowerArm: 'leftUpperArm',
  leftHand: 'leftLowerArm',
  rightShoulder: 'upperChest',
  rightUpperArm: 'rightShoulder',
  rightLowerArm: 'rightUpperArm',
  rightHand: 'rightLowerArm',
  leftUpperLeg: 'hips',
  leftLowerLeg: 'leftUpperLeg',
  leftFoot: 'leftLowerLeg',
  leftToes: 'leftFoot',
  rightUpperLeg: 'hips',
  rightLowerLeg: 'rightUpperLeg',
  rightFoot: 'rightLowerLeg',
  rightToes: 'rightFoot',
};

/** Direzione di ogni osso (verso il figlio) in T-pose, VRM 1.0: guarda +Z, la sinistra e' +X. */
const T_DIRECTION = {
  hips: [0, 1, 0],
  spine: [0, 1, 0],
  chest: [0, 1, 0],
  upperChest: [0, 1, 0],
  neck: [0, 1, 0],
  leftShoulder: [1, 0, 0],
  leftUpperArm: [1, 0, 0],
  leftLowerArm: [1, 0, 0],
  rightShoulder: [-1, 0, 0],
  rightUpperArm: [-1, 0, 0],
  rightLowerArm: [-1, 0, 0],
  leftUpperLeg: [0, -1, 0],
  leftLowerLeg: [0, -1, 0],
  rightUpperLeg: [0, -1, 0],
  rightLowerLeg: [0, -1, 0],
};

/** L'osso figlio che da' la direzione (se c'e' nel BVH). */
const DIRECTION_CHILD = {
  hips: ['spine', 'chest', 'upperChest', 'neck'],
  spine: ['chest', 'upperChest', 'neck'],
  chest: ['upperChest', 'neck'],
  upperChest: ['neck'],
  neck: ['head'],
  leftShoulder: ['leftUpperArm'],
  leftUpperArm: ['leftLowerArm'],
  leftLowerArm: ['leftHand'],
  rightShoulder: ['rightUpperArm'],
  rightUpperArm: ['rightLowerArm'],
  rightLowerArm: ['rightHand'],
  leftUpperLeg: ['leftLowerLeg'],
  leftLowerLeg: ['leftFoot'],
  rightUpperLeg: ['rightLowerLeg'],
  rightLowerLeg: ['rightFoot'],
};

const normalName = (name) =>
  name
    .toLowerCase()
    .replace(/^(mixamorig\d*|bip0?1|bip|def|jnt|joint|character\d*|cc_base)[:_ ]*/, '')
    .replace(/[^a-z0-9]/g, '');

// ---------------------------------------------------------------------------
// BVH
// ---------------------------------------------------------------------------
export function parseBVH(text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  let index = 0;
  const next = () => tokens[index++];
  const joints = [];

  function readJoint(parent) {
    const kind = next(); // ROOT / JOINT / End
    if (kind === 'End') {
      next(); // Site
      next(); // {
      next(); // OFFSET
      const offset = [Number(next()), Number(next()), Number(next())];
      next(); // }
      return { endSite: true, offset };
    }
    const joint = { name: next(), parent, offset: [0, 0, 0], channels: [], children: [], endOffset: null };
    joints.push(joint);
    next(); // {
    for (;;) {
      const token = next();
      if (token === 'OFFSET') joint.offset = [Number(next()), Number(next()), Number(next())];
      else if (token === 'CHANNELS') {
        const count = Number(next());
        for (let i = 0; i < count; i++) joint.channels.push(next());
      } else if (token === 'JOINT' || token === 'End') {
        index--;
        const child = readJoint(joint);
        if (child.endSite) joint.endOffset = child.offset;
        else joint.children.push(child);
      } else if (token === '}') break;
      else throw new Error(`BVH: token inatteso ${token}`);
    }
    return joint;
  }

  if (next() !== 'HIERARCHY') throw new Error('BVH: manca HIERARCHY');
  readJoint(null);
  if (next() !== 'MOTION') throw new Error('BVH: manca MOTION');
  next(); // Frames:
  const frameCount = Number(next());
  next(); // Frame
  next(); // Time:
  const frameTime = Number(next());
  const width = joints.reduce((sum, joint) => sum + joint.channels.length, 0);
  const frames = [];
  for (let f = 0; f < frameCount; f++) {
    const values = new Float64Array(width);
    for (let i = 0; i < width; i++) values[i] = Number(next());
    frames.push(values);
  }
  return { joints, frames, frameTime };
}

const AXES = { X: new Vector3(1, 0, 0), Y: new Vector3(0, 1, 0), Z: new Vector3(0, 0, 1) };

/** Rotazioni e posizioni nel mondo di ogni giunto, fotogramma per fotogramma. */
export function forwardKinematics(bvh, frame) {
  const world = new Map();
  let cursor = 0;
  const q = new Quaternion();
  for (const joint of bvh.joints) {
    const local = new Quaternion();
    const translation = new Vector3(...joint.offset);
    let hasPosition = false;
    const position = new Vector3();
    for (const channel of joint.channels) {
      const value = frame[cursor++];
      const axis = channel[0];
      if (channel.endsWith('rotation')) local.multiply(q.setFromAxisAngle(AXES[axis], (value * Math.PI) / 180));
      else {
        hasPosition = true;
        position[axis.toLowerCase()] = value;
      }
    }
    if (hasPosition) translation.copy(position);
    const parent = joint.parent ? world.get(joint.parent.name) : null;
    const rotation = parent ? parent.rotation.clone().multiply(local) : local;
    const point = parent ? parent.position.clone().add(translation.applyQuaternion(parent.rotation)) : translation;
    world.set(joint.name, { rotation, position: point });
  }
  return world;
}

// ---------------------------------------------------------------------------
// Retargeting
// ---------------------------------------------------------------------------
function mapBones(bvh) {
  const byName = new Map(bvh.joints.map((joint) => [normalName(joint.name), joint.name]));
  const mapping = {};
  const used = new Set();
  for (const [bone, candidates] of Object.entries(BONE_NAMES)) {
    for (const candidate of candidates) {
      const found = byName.get(candidate);
      if (found && !used.has(found)) {
        mapping[bone] = found;
        used.add(found);
        break;
      }
    }
  }
  for (const needed of ['hips', 'leftUpperLeg', 'rightUpperLeg', 'leftUpperArm', 'rightUpperArm']) {
    if (!mapping[needed]) throw new Error(`Osso "${needed}" non trovato fra: ${bvh.joints.map((j) => j.name).join(', ')}`);
  }
  return mapping;
}

/** Base ortonormale (colonne: direzione dell'osso, riferimento, terzo asse). */
function basis(primary, reference) {
  const x = primary.clone().normalize();
  let ref = reference.clone();
  if (Math.abs(ref.dot(x)) > 0.9) ref = Math.abs(x.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  const z = ref.sub(x.clone().multiplyScalar(ref.dot(x))).normalize();
  const y = new Vector3().crossVectors(z, x);
  return new Matrix4().makeBasis(x, y, z);
}

function parentMapped(bone, mapping) {
  let parent = PARENT[bone];
  while (parent && !mapping[parent]) parent = PARENT[parent];
  return parent;
}

/**
 * Toglie l'attesa ferma prima e dopo il gesto: nelle riprese l'attore sta
 * immobile qualche secondo prima del "via" e dopo lo "stop". Si misura quanto
 * si muovono tutte le ossa fotogramma per fotogramma e si tiene la parte
 * sopra il 12% del picco, con un margine di 0,4 s ai due lati.
 */
function trimStill(times, tracks, frameTime) {
  const bones = Object.keys(tracks);
  const count = times.length;
  if (count < 10) return;
  const speed = new Float64Array(count);
  for (let i = 1; i < count; i++) {
    for (const bone of bones) speed[i] += 1 - Math.abs(tracks[bone][i].dot(tracks[bone][i - 1]));
  }
  // Media mobile su un terzo di secondo: un tremolio isolato non conta.
  const half = Math.max(1, Math.round(0.17 / frameTime));
  const smooth = speed.map((_, i) => {
    let sum = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(count - 1, i + half); k++) sum += speed[k];
    return sum;
  });
  const peak = Math.max(...smooth);
  if (!(peak > 0)) return;
  const active = [...smooth.keys()].filter((i) => smooth[i] > 0.12 * peak);
  const pad = Math.round(0.4 / frameTime);
  const from = Math.max(0, active[0] - pad);
  const to = Math.min(count - 1, active[active.length - 1] + pad);
  if (from === 0 && to === count - 1) return;
  const offset = times[from];
  times.splice(0, count, ...times.slice(from, to + 1).map((t) => t - offset));
  for (const bone of bones) tracks[bone] = tracks[bone].slice(from, to + 1);
}

export function convert(bvh, { start = 0, end = Infinity, keepFacing = true, trim = false } = {}) {
  const mapping = mapBones(bvh);
  const bones = Object.keys(PARENT).filter((bone) => mapping[bone]);
  const worlds = bvh.frames.map((frame) => forwardKinematics(bvh, frame));
  const first = worlds[0];

  // Unita': centimetri se i fianchi stanno oltre 20 unita' da terra.
  const hipsHeight = first.get(mapping.hips).position.y;
  const scale = hipsHeight > 20 ? 0.01 : 1;

  // Da che parte guarda nel primo fotogramma: quella rotazione sull'asse Y
  // si toglie da tutta la clip, cosi' guarda sempre verso di te. Contano le
  // spalle, non le gambe: in una posa "femminile" i fianchi sono girati di
  // 50 gradi, ma ci si rivolge (e ci si inchina) dove guarda il busto.
  const leftOf = (l, r) => new Vector3().subVectors(first.get(mapping[l]).position, first.get(mapping[r]).position).setY(0).normalize();
  const left = leftOf('leftUpperArm', 'rightUpperArm').multiplyScalar(2).add(leftOf('leftUpperLeg', 'rightUpperLeg')).normalize();
  const forward = new Vector3().crossVectors(left, new Vector3(0, 1, 0)).normalize();
  const yaw = new Quaternion().setFromUnitVectors(forward, new Vector3(0, 0, 1));

  const ahead = new Vector3(0, 0, 1);
  const inverseHips = first.get(mapping.hips).rotation.clone().invert();
  // Correzione di ogni osso: dal primo fotogramma alla T-pose (vedi in testa al file).
  const toTPose = new Map();
  for (const bone of bones) {
    const child = (DIRECTION_CHILD[bone] ?? []).find((name) => mapping[name]);
    const target = T_DIRECTION[bone];
    if (!child || !target) {
      const parent = parentMapped(bone, mapping);
      toTPose.set(bone, parent ? toTPose.get(parent).clone() : new Quaternion());
      continue;
    }
    const from = first.get(mapping[child]).position.clone().sub(first.get(mapping[bone]).position).applyQuaternion(yaw);
    // Stesso riferimento (avanti, +Z) per le due basi: la rotazione che le
    // allinea gira l'osso sulla sua direzione senza aggiungere torsioni.
    const measured = basis(from, ahead);
    const wanted = basis(new Vector3(...target), ahead);
    const matrix = wanted.multiply(measured.invert());
    toTPose.set(bone, new Quaternion().setFromRotationMatrix(matrix));
  }

  // L'attore puo' girarsi durante la ripresa (verso chi saluta, verso dove
  // indica): una mascotte sulla scrivania deve restare rivolta verso di te.
  // Si toglie la direzione dei fianchi mediata su un secondo: le rotazioni
  // lente spariscono, i colpi d'anca di un ballo restano.
  const headings = worlds.map((world) => {
    const facing = ahead.clone().applyQuaternion(yaw.clone().multiply(world.get(mapping.hips).rotation).multiply(inverseHips).multiply(yaw.clone().invert()));
    return Math.atan2(facing.x, facing.z);
  });
  const unwrapped = [];
  for (const [i, angle] of headings.entries()) {
    const previous = unwrapped[i - 1];
    unwrapped.push(previous === undefined ? angle : previous + Math.atan2(Math.sin(angle - previous), Math.cos(angle - previous)));
  }
  const half = Math.max(1, Math.round(0.5 / bvh.frameTime));
  const smoothHeading = unwrapped.map((_, i) => {
    let sum = 0;
    let count = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(unwrapped.length - 1, i + half); k++) {
      sum += unwrapped[k];
      count++;
    }
    return keepFacing ? sum / count : 0;
  });

  const firstIndex = Math.max(0, Math.round(start / bvh.frameTime));
  const lastIndex = Math.min(bvh.frames.length - 1, Math.round(end / bvh.frameTime));
  const times = [];
  const tracks = Object.fromEntries(bones.map((bone) => [bone, []]));
  const inverseFirst = new Map(bones.map((bone) => [bone, first.get(mapping[bone]).rotation.clone().invert()]));
  for (let f = firstIndex; f <= lastIndex; f++) {
    times.push((f - firstIndex) * bvh.frameTime);
    const turn = new Quaternion().setFromAxisAngle(AXES.Y, -smoothHeading[f]);
    const facing = turn.multiply(yaw);
    const normalized = new Map();
    for (const bone of bones) {
      // N = yaw * W_f * W_0^-1 * (yaw^-1) * S^-1: il movimento rispetto al primo
      // fotogramma, espresso nello spazio "girato verso +Z", sopra la T-pose.
      const w = worlds[f].get(mapping[bone]).rotation.clone().multiply(inverseFirst.get(bone));
      const n = facing.clone().multiply(w).multiply(yaw.clone().invert()).multiply(toTPose.get(bone).clone().invert());
      normalized.set(bone, n);
    }
    for (const bone of bones) {
      const parent = parentMapped(bone, mapping);
      const local = parent ? normalized.get(parent).clone().invert().multiply(normalized.get(bone)) : normalized.get(bone).clone();
      local.normalize();
      // Stessa rotazione, segno coerente col fotogramma prima: niente scatti nell'interpolazione.
      const previous = tracks[bone][tracks[bone].length - 1];
      if (previous && previous.dot(local) < 0) local.set(-local.x, -local.y, -local.z, -local.w);
      tracks[bone].push(local);
    }
  }

  if (trim) trimStill(times, tracks, bvh.frameTime);

  // Scheletro in T-pose per i nodi del file (serve soprattutto l'altezza dei fianchi).
  const rest = {};
  for (const bone of bones) {
    const parent = parentMapped(bone, mapping);
    if (!parent) {
      rest[bone] = [0, hipsHeight * scale, 0];
      continue;
    }
    const length = first.get(mapping[bone]).position.distanceTo(first.get(mapping[parent]).position) * scale;
    const direction = T_DIRECTION[parent] ?? [0, 1, 0];
    if (bone.includes('Shoulder') || bone.includes('UpperLeg')) {
      const offset = first.get(mapping[bone]).position.clone().sub(first.get(mapping[parent]).position).applyQuaternion(yaw).multiplyScalar(scale);
      rest[bone] = offset.toArray();
    } else if (bone.includes('Toes')) rest[bone] = [0, 0, length];
    else if (bone.includes('Foot')) rest[bone] = [0, -length, 0];
    else rest[bone] = direction.map((value) => value * length);
  }

  return { bones, mapping, times, tracks, rest, duration: times[times.length - 1] ?? 0 };
}

// ---------------------------------------------------------------------------
// VRMA (glTF binario con VRMC_vrm_animation)
// ---------------------------------------------------------------------------
export function writeVRMA(result) {
  const { bones, times, tracks, rest } = result;
  const nodeIndex = new Map(bones.map((bone, index) => [bone, index]));
  const nodes = bones.map((bone) => ({ name: bone, translation: rest[bone] }));
  for (const bone of bones) {
    let parent = PARENT[bone];
    while (parent && !nodeIndex.has(parent)) parent = PARENT[parent];
    if (parent) (nodes[nodeIndex.get(parent)].children ??= []).push(nodeIndex.get(bone));
  }

  const chunks = [];
  let byteLength = 0;
  const bufferViews = [];
  const accessors = [];
  const addAccessor = (array, type, count, extra = {}) => {
    const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
    const padding = (4 - (bytes.length % 4)) % 4;
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.length });
    chunks.push(bytes, Buffer.alloc(padding));
    byteLength += bytes.length + padding;
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count, type, ...extra });
    return accessors.length - 1;
  };

  const input = addAccessor(Float32Array.from(times), 'SCALAR', times.length, { min: [times[0]], max: [times[times.length - 1]] });
  const samplers = [];
  const channels = [];
  for (const bone of bones) {
    const values = new Float32Array(times.length * 4);
    tracks[bone].forEach((q, i) => values.set([q.x, q.y, q.z, q.w], i * 4));
    const output = addAccessor(values, 'VEC4', times.length);
    samplers.push({ input, output, interpolation: 'LINEAR' });
    channels.push({ sampler: samplers.length - 1, target: { node: nodeIndex.get(bone), path: 'rotation' } });
  }

  const json = {
    asset: { version: '2.0', generator: 'tsukumo bvh2vrma' },
    extensionsUsed: ['VRMC_vrm_animation'],
    extensions: {
      VRMC_vrm_animation: {
        specVersion: '1.0',
        humanoid: { humanBones: Object.fromEntries(bones.map((bone) => [bone, { node: nodeIndex.get(bone) }])) },
      },
    },
    scene: 0,
    scenes: [{ nodes: [nodeIndex.get('hips')] }],
    nodes,
    animations: [{ name: 'clip', samplers, channels }],
    accessors,
    bufferViews,
    buffers: [{ byteLength }],
  };

  let jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBytes.length + 8 + bin.length, 8);
  const chunkHeader = (length, type) => {
    const buffer = Buffer.alloc(8);
    buffer.writeUInt32LE(length, 0);
    buffer.writeUInt32LE(type, 4);
    return buffer;
  };
  return Buffer.concat([header, chunkHeader(jsonBytes.length, 0x4e4f534a), jsonBytes, chunkHeader(bin.length, 0x004e4942), bin]);
}

// ---------------------------------------------------------------------------
// Riga di comando
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const options = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--start') options.start = Number(argv[++i]);
    else if (arg === '--end') options.end = Number(argv[++i]);
    else if (arg === '--free-facing') options.keepFacing = false;
    else if (arg === '--trim') options.trim = true;
    else options.files.push(arg);
  }
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { files, start, end, keepFacing, trim } = parseArgs(process.argv.slice(2));
  if (!files.length) {
    console.log('Uso: node scripts/bvh2vrma.mjs input.bvh [output.vrma] [--start s] [--end s]');
    process.exit(1);
  }
  const [input, output = join(dirname(input), `${basename(input, extname(input))}.vrma`)] = files;
  const bvh = parseBVH(readFileSync(input, 'utf8'));
  const result = convert(bvh, { start, end, keepFacing, trim });
  writeFileSync(output, writeVRMA(result));
  console.log(`${basename(output)}: ${result.bones.length} ossa, ${result.duration.toFixed(1)} s`);
}
