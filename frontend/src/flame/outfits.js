/**
 * How the wardrobe's accessories (flame/wardrobe.js) are made and how they
 * arrive: the old one flies away, the new one falls (or "pops" out) and she
 * squashes when it touches her, like Mochi's clothes. The soft parts (the
 * headband's tails, the hair clip's beads, the lantern) lag behind on a
 * spring when she turns or jumps.
 *
 * All in drop units, with the origin at the bulb's centre (the `pivot`'s
 * pin): bulb of radius R, tip TIP above the centre. The hats cover the tip,
 * which sways in the flame's shader: that's why they bend with the same
 * shader (same uniforms), otherwise the tip pokes through them. The ink
 * outline is a skin pushed along the normals, not a scaled copy: it stays
 * even on pieces far from the centre.
 */

import * as THREE from 'three';

import { canvasTexture, glowSprite, INK, ink, SPHERE, toon } from './look.js';
import { EASE } from './motion.js';
import { OUTFITS } from './wardrobe.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const R = 0.42;
const TIP = 1.2 - R;
const INK_HEX = '#1d1529';

/** The drop's radius at height `y` above (or below) the bulb's centre. */
export function radiusAt(y) {
  if (y <= 0) return Math.sqrt(Math.max(0, R * R - y * y));
  const k = clamp(y / TIP, 0, 1);
  return R * Math.cos((k * Math.PI) / 2) ** 1.5;
}

// ------------------------------------------------------------------ materials
/**
 * A piece's material: `soft` bends it like the flame's tip (it needs the
 * flame's uniforms), `skin` > 0 inflates it along the normals (the outline,
 * seen from behind).
 */
function shaded(material, { uniforms = null, skin = 0 } = {}) {
  const soft = Boolean(uniforms);
  material.onBeforeCompile = (shader) => {
    if (soft) Object.assign(shader.uniforms, uniforms);
    const head = soft ? 'uniform float uTime;\nuniform float uSway;\nuniform float uLean;\n' : '';
    const bend = soft
      ? `float h = smoothstep(0.0, ${TIP.toFixed(3)}, position.y);
         transformed.x += sin(uTime * 3.2 + position.y * 3.0) * 0.1 * uSway * h - uLean * h * h * 0.55;
         transformed.z += cos(uTime * 2.6 + position.y * 2.0) * 0.04 * uSway * h;`
      : '';
    const grow = skin ? `transformed += normalize(normal) * ${skin.toFixed(4)};` : '';
    shader.vertexShader = `${head}${shader.vertexShader}`.replace('#include <begin_vertex>', `#include <begin_vertex>\n${grow}\n${bend}`);
  };
  material.customProgramCacheKey = () => `tsukumo-outfit-${soft ? 's' : 'r'}-${skin ? 'i' : 'b'}`;
  return material;
}

/**
 * A piece with its outline. `geometry` is already in the right position
 * (baking it makes the soft shader work, since it looks at the real y).
 */
function piece(parent, geometry, color, { uniforms = null, line = 0.012, map = null, side = THREE.FrontSide, emissive = 0x000000 } = {}) {
  const material = shaded(toon(color, { map, side, emissive }), { uniforms });
  const mesh = new THREE.Mesh(geometry, material);
  if (line) {
    const outline = new THREE.Mesh(geometry, shaded(new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide, toneMapped: false }), { uniforms, skin: line }));
    mesh.add(outline);
  }
  parent.add(mesh);
  return mesh;
}

/** A painted decal (mask, flower, glasses): a curved plane facing out of the bulb. */
function decal(parent, texture, width, height, { at, normal, roll = 0, curve = 0 }) {
  const geometry = new THREE.PlaneGeometry(width, height, 8, 8);
  if (curve) {
    const p = geometry.attributes.position;
    for (let i = 0; i < p.count; i += 1) p.setZ(i, -curve * (p.getX(i) ** 2 + 0.4 * p.getY(i) ** 2));
  }
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
  mesh.position.copy(at);
  mesh.lookAt(at.clone().add(normal));
  mesh.rotateZ(roll);
  mesh.renderOrder = 2;
  parent.add(mesh);
  return mesh;
}

/** A point on the bulb's surface: height `y`, angle `deg` (0 in front, + to the right), lifted by `lift`. */
function onSurface(y, deg, lift = 0) {
  const a = (deg * Math.PI) / 180;
  const r = radiusAt(y) + lift;
  return new THREE.Vector3(Math.sin(a) * r, y, Math.cos(a) * r);
}

function outward(y, deg, up = 0.25) {
  const a = (deg * Math.PI) / 180;
  return new THREE.Vector3(Math.sin(a), up, Math.cos(a)).normalize();
}

/** A surface of revolution from a profile [[radius, y], ...], then `warp` on the vertices. */
function lathe(profile, warp = null, segments = 48) {
  const geometry = new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(Math.max(0.0005, r), y)),
    segments,
  );
  if (warp) {
    const p = geometry.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i += 1) {
      v.fromBufferAttribute(p, i);
      warp(v);
      p.setXYZ(i, v.x, v.y, v.z);
    }
    geometry.computeVertexNormals();
  }
  return geometry;
}

/** Any geometry moved and turned into its position (baked). */
function baked(geometry, { pos = null, rot = null } = {}) {
  const m = new THREE.Matrix4();
  if (rot) m.makeRotationFromEuler(new THREE.Euler(...rot));
  if (pos) m.setPosition(pos);
  geometry.applyMatrix4(m);
  return geometry;
}

// ------------------------------------------------------------------ textures
const TEXTURES = {};
function texture(name) {
  if (!TEXTURES[name]) TEXTURES[name] = DRAW[name]();
  return TEXTURES[name];
}

const DRAW = {
  // The festival fox mask: white, red ears and make-up, a little flame on the
  // forehead (her).
  kitsune: () =>
    canvasTexture((g, s) => {
      const face = () => {
        g.beginPath();
        g.moveTo(s * 0.5, s * 0.93);
        g.bezierCurveTo(s * 0.3, s * 0.86, s * 0.14, s * 0.66, s * 0.14, s * 0.5);
        g.lineTo(s * 0.17, s * 0.08);
        g.lineTo(s * 0.4, s * 0.3);
        g.quadraticCurveTo(s * 0.5, s * 0.27, s * 0.6, s * 0.3);
        g.lineTo(s * 0.83, s * 0.08);
        g.lineTo(s * 0.86, s * 0.5);
        g.bezierCurveTo(s * 0.86, s * 0.66, s * 0.7, s * 0.86, s * 0.5, s * 0.93);
        g.closePath();
      };
      face();
      g.fillStyle = '#fbf7f2';
      g.fill();
      g.fillStyle = '#d8343f';
      for (const k of [1, -1]) {
        const x = (v) => s * (0.5 + k * (v - 0.5));
        g.beginPath();
        g.moveTo(x(0.21), s * 0.16);
        g.lineTo(x(0.23), s * 0.38);
        g.lineTo(x(0.37), s * 0.31);
        g.closePath();
        g.fill();
        // The make-up above the eyes and the whiskers.
        g.beginPath();
        g.ellipse(x(0.33), s * 0.47, s * 0.11, s * 0.045, k * -0.35, 0, Math.PI * 2);
        g.fill();
        g.lineWidth = s * 0.022;
        g.strokeStyle = '#d8343f';
        g.lineCap = 'round';
        for (const dy of [0, 0.05, 0.1]) {
          g.beginPath();
          g.moveTo(x(0.2), s * (0.62 + dy));
          g.lineTo(x(0.32), s * (0.64 + dy * 0.6));
          g.stroke();
        }
      }
      // Slit eyes.
      ink(g, s, 0.05);
      for (const k of [1, -1]) {
        g.beginPath();
        g.moveTo(s * (0.5 + k * 0.08), s * 0.52);
        g.quadraticCurveTo(s * (0.5 + k * 0.17), s * 0.56, s * (0.5 + k * 0.26), s * 0.5);
        g.stroke();
      }
      // The little flame on the forehead.
      g.fillStyle = '#d8343f';
      g.beginPath();
      g.moveTo(s * 0.5, s * 0.3);
      g.bezierCurveTo(s * 0.53, s * 0.36, s * 0.56, s * 0.39, s * 0.53, s * 0.43);
      g.arc(s * 0.5, s * 0.41, s * 0.035, 0.3, Math.PI - 0.3);
      g.bezierCurveTo(s * 0.44, s * 0.39, s * 0.47, s * 0.36, s * 0.5, s * 0.3);
      g.fill();
      // Snout and nose.
      g.fillStyle = INK_HEX;
      g.beginPath();
      g.ellipse(s * 0.5, s * 0.78, s * 0.04, s * 0.028, 0, 0, Math.PI * 2);
      g.fill();
      ink(g, s, 0.045);
      face();
      g.stroke();
    }, 256),
  // The cherry blossom: five petals notched at the tip.
  sakura: () =>
    canvasTexture((g, s) => {
      const c = s / 2;
      for (let i = 0; i < 5; i += 1) {
        g.save();
        g.translate(c, c);
        g.rotate((i * Math.PI * 2) / 5);
        g.beginPath();
        g.moveTo(0, -s * 0.04);
        g.bezierCurveTo(-s * 0.2, -s * 0.12, -s * 0.16, -s * 0.38, -s * 0.05, -s * 0.44);
        g.lineTo(0, -s * 0.38);
        g.lineTo(s * 0.05, -s * 0.44);
        g.bezierCurveTo(s * 0.16, -s * 0.38, s * 0.2, -s * 0.12, 0, -s * 0.04);
        g.closePath();
        g.fillStyle = '#ffc0dc';
        g.fill();
        g.lineWidth = s * 0.035;
        g.strokeStyle = INK_HEX;
        g.lineJoin = 'round';
        g.stroke();
        g.restore();
      }
      g.fillStyle = '#ff6fa5';
      g.beginPath();
      g.arc(c, c, s * 0.09, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#ffd36b';
      for (let i = 0; i < 5; i += 1) {
        const a = (i * Math.PI * 2) / 5 + Math.PI / 5;
        g.beginPath();
        g.arc(c + Math.sin(a) * s * 0.12, c - Math.cos(a) * s * 0.12, s * 0.025, 0, Math.PI * 2);
        g.fill();
      }
    }, 128),
  // Round golden glasses.
  glasses: () =>
    canvasTexture(
      (g, w, h) => {
        const r = h * 0.36;
        const centers = [w * 0.247, w * 0.753];
        g.lineCap = 'round';
        for (const x of centers) {
          g.beginPath();
          g.arc(x, h * 0.5, r, 0, Math.PI * 2);
          g.fillStyle = 'rgba(255,255,255,0.14)';
          g.fill();
          g.lineWidth = h * 0.1;
          g.strokeStyle = INK_HEX;
          g.stroke();
          g.lineWidth = h * 0.055;
          g.strokeStyle = '#d9ad4f';
          g.stroke();
          g.strokeStyle = 'rgba(255,255,255,0.8)';
          g.lineWidth = h * 0.04;
          g.beginPath();
          g.arc(x, h * 0.5, r * 0.62, Math.PI * 1.1, Math.PI * 1.4);
          g.stroke();
        }
        // The bridge and the temples.
        for (const [width, color] of [[h * 0.09, INK_HEX], [h * 0.045, '#d9ad4f']]) {
          g.lineWidth = width;
          g.strokeStyle = color;
          g.beginPath();
          g.moveTo(centers[0] + r, h * 0.47);
          g.quadraticCurveTo(w * 0.5, h * 0.36, centers[1] - r, h * 0.47);
          g.moveTo(centers[0] - r, h * 0.46);
          g.lineTo(w * 0.04, h * 0.42);
          g.moveTo(centers[1] + r, h * 0.46);
          g.lineTo(w * 0.96, h * 0.42);
          g.stroke();
        }
      },
      256,
      128,
    ),
  // The striped scarf.
  scarf: () => {
    const t = canvasTexture(
      (g, w, h) => {
        for (let i = 0; i < 8; i += 1) {
          g.fillStyle = i % 2 ? '#f5ead8' : '#d9434e';
          g.fillRect((i * w) / 8, 0, w / 8, h);
        }
      },
      128,
      16,
    );
    t.wrapS = THREE.RepeatWrapping;
    t.repeat.set(5, 1);
    return t;
  },
  // Woven straw: dense lines from the centre to the edge.
  straw: () =>
    canvasTexture(
      (g, w, h) => {
        g.fillStyle = '#ecc771';
        g.fillRect(0, 0, w, h);
        for (let i = 0; i < 48; i += 1) {
          g.fillStyle = i % 2 ? 'rgba(170,120,40,0.35)' : 'rgba(255,240,190,0.35)';
          g.fillRect((i * w) / 48, 0, w / 96, h);
        }
      },
      256,
      32,
    ),
  // The party hat: stripes and dots.
  party: () =>
    canvasTexture((g, s) => {
      g.fillStyle = '#ff7eb6';
      g.fillRect(0, 0, s, s);
      g.fillStyle = '#ffffff';
      for (let i = -4; i < 8; i += 2) {
        g.beginPath();
        g.moveTo((i * s) / 6, s);
        g.lineTo(((i + 1) * s) / 6, s);
        g.lineTo(((i + 4) * s) / 6, 0);
        g.lineTo(((i + 3) * s) / 6, 0);
        g.closePath();
        g.fill();
      }
      g.fillStyle = '#ffd166';
      for (let i = 0; i < 9; i += 1) {
        g.beginPath();
        g.arc(((i * 37) % 128) * (s / 128) + 6, ((i * 53) % 128) * (s / 128) + 6, s * 0.04, 0, Math.PI * 2);
        g.fill();
      }
    }, 128),
  // The lantern's paper: red, with ribs and a darker rim.
  lantern: () =>
    canvasTexture(
      (g, w, h) => {
        const shade = g.createLinearGradient(0, 0, 0, h);
        shade.addColorStop(0, '#b52d26');
        shade.addColorStop(0.2, '#e8483c');
        shade.addColorStop(0.8, '#e8483c');
        shade.addColorStop(1, '#b52d26');
        g.fillStyle = shade;
        g.fillRect(0, 0, w, h);
        g.fillStyle = 'rgba(120,20,16,0.45)';
        for (let i = 1; i < 9; i += 1) g.fillRect(0, (i * h) / 9 - 1, w, 2);
        // A white circle with the little flame, in front.
        g.fillStyle = '#fff4e6';
        g.beginPath();
        g.arc(w * 0.25, h * 0.5, h * 0.16, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#e8483c';
        g.beginPath();
        g.moveTo(w * 0.25, h * 0.38);
        g.bezierCurveTo(w * 0.265, h * 0.45, w * 0.29, h * 0.5, w * 0.27, h * 0.56);
        g.arc(w * 0.25, h * 0.545, h * 0.05, 0.3, Math.PI - 0.3);
        g.bezierCurveTo(w * 0.21, h * 0.5, w * 0.235, h * 0.45, w * 0.25, h * 0.38);
        g.fill();
      },
      256,
      128,
    ),
};

// ------------------------------------------------------------------ the accessories
/**
 * Each accessory: `head` (follows the gaze and the squashes, child of
 * pivot), `side` (floats beside her, child of root), `swing(dx, dy, t)` for
 * the soft parts, `hat` if it falls from above, `top` how much it raises the
 * tip.
 */
const BUILD = {
  hachimaki(u) {
    const head = new THREE.Group();
    const y = 0.2;
    const band = baked(new THREE.CylinderGeometry(radiusAt(y + 0.045) + 0.012, radiusAt(y - 0.045) + 0.014, 0.09, 48, 1, true), { pos: new THREE.Vector3(0, y, 0) });
    piece(head, band, 0xf7f4ff, { uniforms: u });
    // The red sun in front.
    const slope = Math.atan((radiusAt(y - 0.045) - radiusAt(y + 0.045)) / 0.09);
    const sun = baked(new THREE.CircleGeometry(0.05, 32), { pos: onSurface(y, 0, 0.016), rot: [-slope, 0, 0] });
    piece(head, sun, 0xe0404a, { uniforms: u, line: 0 });
    // The knot behind on the right, and the two tails flapping.
    const knot = new THREE.Group();
    knot.position.copy(onSurface(y, 118, 0.02));
    head.add(knot);
    piece(knot, new THREE.SphereGeometry(0.04, 16, 12), 0xf7f4ff);
    const tails = [0, 1].map((i) => {
      const tail = new THREE.Group();
      tail.rotation.z = 1.0 + i * 0.4;
      knot.add(tail);
      piece(tail, baked(new THREE.BoxGeometry(0.05, 0.22, 0.012), { pos: new THREE.Vector3(0, -0.11, 0) }), 0xf7f4ff, { line: 0.008 });
      return tail;
    });
    return {
      head,
      swing(dx, dy, t) {
        tails.forEach((tail, i) => {
          tail.rotation.z = 1.0 + i * 0.4 + dx * 0.6 - dy * 0.3 + Math.sin(t * 6 + i * 1.7) * 0.07;
        });
      },
    };
  },

  kitsune() {
    const head = new THREE.Group();
    decal(head, texture('kitsune'), 0.46, 0.46, { at: onSurface(0.17, 40, 0.05), normal: outward(0.17, 40, 0.3), roll: -0.3, curve: 1.1 });
    return { head };
  },

  sakura() {
    const head = new THREE.Group();
    const at = onSurface(0.27, -38, 0.03);
    decal(head, texture('sakura'), 0.3, 0.3, { at, normal: outward(0.27, -38, 0.3), roll: 0.3, curve: 0.8 });
    decal(head, texture('sakura'), 0.17, 0.17, { at: onSurface(0.13, -58, 0.03), normal: outward(0.13, -58, 0.2), roll: -0.5, curve: 0.8 });
    // The beads hanging from the flower.
    const chain = new THREE.Group();
    chain.position.copy(at).add(new THREE.Vector3(-0.02, -0.04, 0.02));
    head.add(chain);
    piece(chain, baked(new THREE.CylinderGeometry(0.004, 0.004, 0.11, 6), { pos: new THREE.Vector3(0, -0.055, 0) }), 0xd9ad4f, { line: 0 });
    piece(chain, baked(new THREE.SphereGeometry(0.026, 12, 10), { pos: new THREE.Vector3(0, -0.07, 0) }), 0xffffff, { line: 0.008 });
    piece(chain, baked(new THREE.SphereGeometry(0.032, 12, 10), { pos: new THREE.Vector3(0, -0.125, 0) }), 0xff86bd, { line: 0.008 });
    return {
      head,
      swing(dx, dy, t) {
        chain.rotation.z = -0.15 + dx * 0.9 + Math.sin(t * 2.2) * 0.05;
        chain.rotation.x = dy * 0.5;
      },
    };
  },

  lantern() {
    // A chochin floating beside her: tsukumogami are lanterns too.
    const side = new THREE.Group();
    side.position.set(0.78, 0.14 + R + 0.42, 0.05);
    const hang = new THREE.Group();
    side.add(hang);
    const body = new THREE.Group();
    body.position.y = -0.27;
    hang.add(body);
    piece(body, new THREE.SphereGeometry(1, 32, 20).scale(0.19, 0.22, 0.19), 0xffffff, { map: texture('lantern'), emissive: 0x5a1a0c });
    for (const y of [0.205, -0.205]) piece(body, baked(new THREE.CylinderGeometry(0.1, 0.1, 0.05, 24), { pos: new THREE.Vector3(0, y, 0) }), 0x2a1d2e, { line: 0.01 });
    piece(hang, baked(new THREE.TorusGeometry(0.06, 0.011, 6, 16, Math.PI), { pos: new THREE.Vector3(0, -0.04, 0) }), 0x2a1d2e, { line: 0 });
    const light = glowSprite(0xffb347, 1.0, 0.45);
    light.position.set(0, -0.27, 0.05);
    hang.add(light);
    body.rotation.y = 0;
    return {
      side,
      right: 0.98,
      swing(dx, dy, t) {
        hang.position.y = Math.sin(t * 1.7) * 0.03;
        hang.rotation.z = -dx * 0.5 + Math.sin(t * 1.3) * 0.08;
        hang.rotation.x = dy * 0.3;
        light.material.opacity = 0.38 + Math.sin(t * 7.3) * 0.04 + Math.sin(t * 2.1) * 0.03;
      },
    };
  },

  glasses() {
    const head = new THREE.Group();
    const lens = decal(head, texture('glasses'), 0.6, 0.3, { at: new THREE.Vector3(0, 0.035, R + 0.055), normal: new THREE.Vector3(0, 0, 1), curve: 0.5 });
    return { head, glasses: lens };
  },

  scarf() {
    const head = new THREE.Group();
    const y = -0.25;
    piece(head, baked(new THREE.TorusGeometry(radiusAt(y) - 0.005, 0.058, 12, 64), { pos: new THREE.Vector3(0, y, 0), rot: [Math.PI / 2, 0, 0] }), 0xffffff, { map: texture('scarf') });
    const tail = new THREE.Group();
    tail.position.copy(onSurface(y - 0.02, -30, 0.05));
    head.add(tail);
    piece(tail, baked(new THREE.BoxGeometry(0.1, 0.2, 0.03), { pos: new THREE.Vector3(0, -0.09, 0) }), 0xffffff, { map: texture('scarf') });
    return {
      head,
      swing(dx, dy, t) {
        tail.rotation.z = -0.12 + dx * 0.7 + Math.sin(t * 1.9) * 0.04;
        tail.rotation.x = 0.15 + dy * 0.6;
      },
    };
  },

  kasa(u) {
    // Conical straw hat: the flame's tip comes out of the hole at the top.
    const head = new THREE.Group();
    const cone = lathe([
      [0.62, 0.29],
      [0.4, 0.38],
      [0.17, 0.5],
    ]);
    piece(head, cone, 0xffffff, { uniforms: u, map: texture('straw'), side: THREE.DoubleSide });
    piece(head, lathe([[0.25, 0.462], [0.212, 0.482]]), 0xd9434e, { uniforms: u, line: 0.006 });
    return { head, hat: true, top: 0 };
  },

  witch(u) {
    const head = new THREE.Group();
    const droop = (v) => {
      if (v.y > 0.62) {
        const d = ((v.y - 0.62) / 0.48) ** 2;
        v.x += 0.22 * d;
        v.y -= 0.06 * d;
      }
    };
    const profile = Array.from({ length: 15 }, (_, i) => {
      const t = i / 14;
      return [0.37 * (1 - t) ** 1.1, 0.24 + t * 0.86];
    });
    piece(head, lathe(profile, droop), 0x5b3fa8, { uniforms: u });
    piece(
      head,
      lathe([
        [0.31, 0.228],
        [0.58, 0.22],
        [0.62, 0.236],
        [0.58, 0.25],
        [0.31, 0.256],
        [0.31, 0.228],
      ]),
      0x4d3494,
      { uniforms: u },
    );
    piece(head, lathe([[0.37, 0.25], [0.335, 0.325]]), 0xf59e2b, { uniforms: u, line: 0.006 });
    const slope = Math.atan(0.035 / 0.075);
    piece(head, baked(new THREE.BoxGeometry(0.075, 0.06, 0.015), { pos: new THREE.Vector3(0, 0.287, 0.357), rot: [-slope, 0, 0] }), 0xffd166, { uniforms: u, line: 0.006 });
    return { head, hat: true, top: 0.28 };
  },

  santa(u) {
    const head = new THREE.Group();
    const droop = (v) => {
      if (v.y > 0.7) {
        const d = ((v.y - 0.7) / 0.34) ** 2;
        v.x += 0.3 * d;
        v.y -= 0.15 * d;
      }
    };
    const profile = Array.from({ length: 15 }, (_, i) => {
      const t = i / 14;
      return [0.37 * (1 - t) ** 0.9, 0.24 + t * 0.8];
    });
    piece(head, lathe(profile, droop), 0xd63846, { uniforms: u });
    piece(head, baked(new THREE.TorusGeometry(0.385, 0.062, 12, 48), { pos: new THREE.Vector3(0, 0.23, 0), rot: [Math.PI / 2, 0, 0] }), 0xf7f4ef, { uniforms: u });
    piece(head, baked(new THREE.SphereGeometry(0.08, 16, 12), { pos: new THREE.Vector3(0.3, 0.89, 0) }), 0xf7f4ef, { uniforms: u });
    return { head, hat: true, top: 0.16 };
  },

  party(u) {
    const head = new THREE.Group();
    piece(head, baked(new THREE.CylinderGeometry(0.0, 0.258, 0.56, 32, 1, true), { pos: new THREE.Vector3(0, 0.68, 0) }), 0xffffff, { uniforms: u, map: texture('party') });
    piece(head, baked(new THREE.SphereGeometry(0.055, 14, 10), { pos: new THREE.Vector3(0, 0.975, 0) }), 0xffd166, { uniforms: u });
    return { head, hat: true, top: 0.24 };
  },
};

/**
 * What she wears and the change: `set(name)` (one of OUTFITS or 'none'),
 * then `update()` every frame. `onArrive` fires when the new accessory
 * touches her (the flame squashes).
 */
export class Wardrobe {
  /**
   * @param {THREE.Object3D} root the flame (position and size)
   * @param {THREE.Object3D} pivot the head (gaze, tilt, squashes)
   * @param {object} uniforms the tip shader's ones (uTime, uSway, uLean)
   */
  constructor(root, pivot, uniforms) {
    this.root = root;
    this.pivot = pivot;
    this.uniforms = uniforms;
    this.items = {};
    this.wearing = 'none';
    this.wanted = 'none';
    this.presence = 0;
    this.onArrive = null;
    this.t = 0;
    // The soft parts' spring (like Mochi: stiffness 60, damping 9).
    this.dx = 0;
    this.dy = 0;
    this.vx = 0;
    this.vy = 0;
    this._prev = null;
  }

  /** How far above the tip what she wears reaches (for speech bubbles and "!"). */
  get top() {
    return this.wearing === 'none' ? 0 : (this.items[this.wearing]?.top ?? 0) * this.presence;
  }

  /** How far right of the centre it reaches (the lantern floats beside her), in drop units. */
  get right() {
    const right = this.wearing === 'none' ? R : (this.items[this.wearing]?.right ?? R);
    return R + (right - R) * this.presence;
  }

  get busy() {
    return this.wearing !== this.wanted || (this.wearing !== 'none' && this.presence < 1) || Math.abs(this.vx) + Math.abs(this.vy) > 0.02;
  }

  set(name) {
    this.wanted = OUTFITS.includes(name) ? name : 'none';
  }

  _item(name) {
    if (!this.items[name]) {
      const item = BUILD[name](this.uniforms);
      if (item.head) this.pivot.add(item.head);
      if (item.side) this.root.add(item.side);
      this.items[name] = item;
      this._show(item, 0, true);
    }
    return this.items[name];
  }

  /** How much of it there is (0..1): hats fall from above, the rest "pops" out. */
  _show(item, presence, entering) {
    const visible = presence > 0.001;
    for (const group of [item.head, item.side]) {
      if (!group) continue;
      group.visible = visible;
      if (!visible) continue;
      if (item.hat) {
        group.position.y = entering ? (1 - EASE.in(presence)) * 0.6 : (1 - presence) * 0.35;
        group.scale.setScalar(entering ? 1 : 0.4 + 0.6 * presence);
      } else {
        group.scale.setScalar(Math.max(0.001, entering ? EASE.back(presence) : presence));
      }
    }
  }

  /**
   * @param {number} dt
   * @param {object} motion `{yaw, lean, y, glasses}`: how she moves (for the
   * spring) and how much of the "cool" reaction's sunglasses there is.
   */
  update(dt, motion) {
    this.t += dt;
    if (dt <= 0) return;
    // The change: the old one leaves (180 ms), the new one arrives (350 ms).
    if (this.wearing !== this.wanted) {
      const old = this.wearing === 'none' ? null : this.items[this.wearing];
      this.presence = old ? Math.max(0, this.presence - dt / 0.18) : 0;
      if (old) this._show(old, this.presence, false);
      if (this.presence <= 0) {
        this.wearing = this.wanted;
        this.presence = 0;
        this._entering = true;
      }
    } else if (this.wearing !== 'none' && this.presence < 1) {
      this.presence = Math.min(1, this.presence + dt / 0.35);
      if (this.presence >= 1 && this._entering) {
        this._entering = false;
        this.onArrive?.(this.items[this.wearing]);
      }
    }
    if (this.wearing === 'none') return;
    const item = this._item(this.wearing);
    this._show(item, this.presence, this.wearing === this.wanted);

    // The soft parts lag behind when she turns her head, bends or jumps.
    const prev = this._prev ?? motion;
    // A finished twirl goes back from 2*PI to 0: that jump isn't movement.
    const turn = motion.yaw - prev.yaw;
    const yawSpeed = Math.abs(turn) > Math.PI ? 0 : turn / dt;
    const ySpeed = (motion.y - prev.y) / dt;
    this._prev = { yaw: motion.yaw, y: motion.y };
    const tx = clamp(-yawSpeed * 0.35 - motion.lean * 2, -1, 1);
    const ty = clamp(ySpeed * 0.5, -1, 1);
    this.vx += (60 * (tx - this.dx) - 9 * this.vx) * dt;
    this.vy += (60 * (ty - this.dy) - 9 * this.vy) * dt;
    this.dx += this.vx * dt;
    this.dy += this.vy * dt;
    item.swing?.(this.dx, this.dy, this.t);

    // The "cool" reaction's sunglasses take the place of the round ones.
    if (item.glasses) item.glasses.visible = (motion.glasses ?? 0) < 0.05;
  }
}
