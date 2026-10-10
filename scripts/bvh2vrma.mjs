#!/usr/bin/env node
/**
 * BVH -> VRMA: from motion capture to a clip Tsukumo can play.
 *
 *   node scripts/bvh2vrma.mjs input.bvh [output.vrma] [--start 1.2] [--end 6.5] [--trim] [--free-facing]
 *
 * --trim removes the still wait before and after the gesture; --free-facing lets
 * her turn like the actor (normally she keeps facing you).
 *
 * The problem isn't the format but the rest pose. A VRMA clip has its bones
 * at rest in T-pose; a BVH doesn't: at zero rotations the skeleton can be in
 * A-pose, in T-pose or (as in the Bandai Namco data, exported from Maya) all
 * bent, with every bone along its own X axis. Converting the angles directly
 * would give wrong arms and twists.
 *
 * Here the first frame, where the actor stands still, is the reference: for
 * every bone we compute the rotation that takes it from how it is in that
 * frame to how it would be in T-pose (arms out, palms down, looking towards
 * +Z), and apply it to the whole clip. Bones without a measurable direction
 * (head, hands, toes) follow their parent.
 *
 * Recognized bone names: Bandai Namco, Mixamo, CMU and the most common
 * "human" names (see BONE_NAMES).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const THREE = await import(pathToFileURL(join(here, '..', 'frontend', 'node_modules', 'three', 'build', 'three.module.js')).href);
const { Matrix4, Quaternion, Vector3 } = THREE;

// ---------------------------------------------------------------------------
// Bone names
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

/** The parent of every VRM bone (only those we write). */
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

/** Direction of every bone (towards the child) in T-pose, VRM 1.0: looking at +Z, left is +X. */
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

/** The child bone that gives the direction (if it's in the BVH). */
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

  if (next() !== 'HIERARCHY') throw new Error('BVH: HIERARCHY missing');
  readJoint(null);
  if (next() !== 'MOTION') throw new Error('BVH: MOTION missing');
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

/** World rotations and positions of every joint, frame by frame. */
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
    if (!mapping[needed]) throw new Error(`Bone "${needed}" not found among: ${bvh.joints.map((j) => j.name).join(', ')}`);
  }
  return mapping;
}

/** Orthonormal basis (columns: the bone's direction, reference, third axis). */
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
 * Removes the still wait before and after the gesture: in the takes the actor
 * stands still a few seconds before "go" and after "stop". We measure how
 * much all the bones move frame by frame and keep the part above 12% of the
 * peak, with a margin of 0.4 s on both sides.
 */
function trimStill(times, tracks, frameTime) {
  const bones = Object.keys(tracks);
  const count = times.length;
  if (count < 10) return;
  const speed = new Float64Array(count);
  for (let i = 1; i < count; i++) {
    for (const bone of bones) speed[i] += 1 - Math.abs(tracks[bone][i].dot(tracks[bone][i - 1]));
  }
  // Moving average over a third of a second: an isolated tremor doesn't count.
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

  // Units: centimetres if the hips are more than 20 units above the ground.
  const hipsHeight = first.get(mapping.hips).position.y;
  const scale = hipsHeight > 20 ? 0.01 : 1;

  // Which way she faces in the first frame: that rotation around the Y axis
  // is removed from the whole clip, so she always faces you. The shoulders
  // count, not the legs: in a "feminine" pose the hips are turned by 50
  // degrees, but one faces (and bows) where the chest points.
  const leftOf = (l, r) => new Vector3().subVectors(first.get(mapping[l]).position, first.get(mapping[r]).position).setY(0).normalize();
  const left = leftOf('leftUpperArm', 'rightUpperArm').multiplyScalar(2).add(leftOf('leftUpperLeg', 'rightUpperLeg')).normalize();
  const forward = new Vector3().crossVectors(left, new Vector3(0, 1, 0)).normalize();
  const yaw = new Quaternion().setFromUnitVectors(forward, new Vector3(0, 0, 1));

  const ahead = new Vector3(0, 0, 1);
  const inverseHips = first.get(mapping.hips).rotation.clone().invert();
  // Correction of every bone: from the first frame to the T-pose (see the top of the file).
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
    // Same reference (forward, +Z) for both bases: the rotation that aligns
    // them turns the bone around its direction without adding twists.
    const measured = basis(from, ahead);
    const wanted = basis(new Vector3(...target), ahead);
    const matrix = wanted.multiply(measured.invert());
    toTPose.set(bone, new Quaternion().setFromRotationMatrix(matrix));
  }

  // The actor may turn during the take (towards whoever they greet, towards
  // where they point): a desk mascot must keep facing you. The hips'
  // direction averaged over a second is removed: slow rotations disappear,
  // a dance's hip thrusts stay.
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
      // N = yaw * W_f * W_0^-1 * (yaw^-1) * S^-1: the motion relative to the first
      // frame, expressed in the "turned towards +Z" space, on top of the T-pose.
      const w = worlds[f].get(mapping[bone]).rotation.clone().multiply(inverseFirst.get(bone));
      const n = facing.clone().multiply(w).multiply(yaw.clone().invert()).multiply(toTPose.get(bone).clone().invert());
      normalized.set(bone, n);
    }
    for (const bone of bones) {
      const parent = parentMapped(bone, mapping);
      const local = parent ? normalized.get(parent).clone().invert().multiply(normalized.get(bone)) : normalized.get(bone).clone();
      local.normalize();
      // Same rotation, sign consistent with the previous frame: no jumps in the interpolation.
      const previous = tracks[bone][tracks[bone].length - 1];
      if (previous && previous.dot(local) < 0) local.set(-local.x, -local.y, -local.z, -local.w);
      tracks[bone].push(local);
    }
  }

  if (trim) trimStill(times, tracks, bvh.frameTime);

  // T-pose skeleton for the file's nodes (mostly the hips' height is needed).
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
// VRMA (binary glTF with VRMC_vrm_animation)
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
// Command line
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
    console.log('Usage: node scripts/bvh2vrma.mjs input.bvh [output.vrma] [--start s] [--end s]');
    process.exit(1);
  }
  const [input, output = join(dirname(input), `${basename(input, extname(input))}.vrma`)] = files;
  const bvh = parseBVH(readFileSync(input, 'utf8'));
  const result = convert(bvh, { start, end, keepFacing, trim });
  writeFileSync(output, writeVRMA(result));
  console.log(`${basename(output)}: ${result.bones.length} bones, ${result.duration.toFixed(1)} s`);
}
