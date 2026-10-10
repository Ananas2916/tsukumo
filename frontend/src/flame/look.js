/**
 * How the flame is made: colours, textures drawn on canvas, materials and
 * eyes. All geometry and canvas: no files to download or license.
 */

import * as THREE from 'three';

// The colours live in palettes.js (the panel uses them too, without three.js).
export { DEFAULT_PALETTE, palette, paletteKey, PALETTES } from './palettes.js';

export const INK = 0x1d1529;
export const Z = new THREE.Vector3(0, 0, 1);

// ------------------------------------------------------------------ materials
const gradient = new THREE.DataTexture(new Uint8Array([120, 200, 255]), 3, 1, THREE.RedFormat);
gradient.minFilter = gradient.magFilter = THREE.NearestFilter;
gradient.generateMipmaps = false;
gradient.needsUpdate = true;
export const toon = (color, extra = {}) => new THREE.MeshToonMaterial({ color, gradientMap: gradient, toneMapped: false, ...extra });
export const flat = (color, extra = {}) => new THREE.MeshBasicMaterial({ color, toneMapped: false, ...extra });
export const SPHERE = new THREE.SphereGeometry(1, 32, 24);
export const PLANE = new THREE.PlaneGeometry(1, 1);
export const RING = new THREE.RingGeometry(0.92, 1, 72);

// ------------------------------------------------------------------ textures
export function canvasTexture(draw, width = 128, height = width) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d'), width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A thick, rounded ink stroke, like the eyes. */
export function ink(g, s, width = 0.11) {
  g.strokeStyle = '#1d1529';
  g.lineWidth = s * width;
  g.lineCap = 'round';
  g.lineJoin = 'round';
}

function heartPath(g, cx, cy, w) {
  g.beginPath();
  g.moveTo(cx, cy + w * 0.36);
  g.bezierCurveTo(cx - w * 0.62, cy - w * 0.04, cx - w * 0.36, cy - w * 0.52, cx, cy - w * 0.2);
  g.bezierCurveTo(cx + w * 0.36, cy - w * 0.52, cx + w * 0.62, cy - w * 0.04, cx, cy + w * 0.36);
  g.closePath();
}

function dropPath(g, cx, top, bottom, w) {
  g.beginPath();
  g.moveTo(cx, top);
  g.bezierCurveTo(cx + w * 0.15, top + (bottom - top) * 0.3, cx + w * 0.5, bottom - w * 0.75, cx + w * 0.5, bottom - w * 0.5);
  g.arc(cx, bottom - w * 0.5, w * 0.5, 0, Math.PI);
  g.bezierCurveTo(cx - w * 0.5, bottom - w * 0.75, cx - w * 0.15, top + (bottom - top) * 0.3, cx, top);
  g.closePath();
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

export const TEX = {
  // "> <": a little knock, the concentration before snapping.
  squint: canvasTexture((g, s) => {
    ink(g, s);
    g.beginPath();
    g.moveTo(s * 0.26, s * 0.24);
    g.lineTo(s * 0.74, s * 0.5);
    g.lineTo(s * 0.26, s * 0.76);
    g.stroke();
  }),
  // "^ ^": happy. Upside down it becomes the closed eye of sleep.
  happy: canvasTexture((g, s) => {
    ink(g, s);
    g.beginPath();
    g.arc(s / 2, s * 0.68, s * 0.3, Math.PI * 1.12, Math.PI * 1.88);
    g.stroke();
  }),
  // "- -": speechless.
  flat: canvasTexture((g, s) => {
    ink(g, s);
    g.beginPath();
    g.moveTo(s * 0.24, s * 0.52);
    g.lineTo(s * 0.76, s * 0.52);
    g.stroke();
  }),
  // "@ @": her head spins. It rotates while she's dazed.
  spiral: canvasTexture((g, s) => {
    ink(g, s, 0.085);
    g.beginPath();
    for (let i = 0; i <= 80; i += 1) {
      const a = (i / 80) * Math.PI * 6;
      const r = s * 0.04 + (i / 80) * s * 0.34;
      const x = s / 2 + Math.cos(a) * r;
      const y = s / 2 + Math.sin(a) * r;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }),
  // Heart eyes, when you cuddle her.
  heartEye: canvasTexture((g, s) => {
    heartPath(g, s / 2, s * 0.55, s * 0.92);
    g.fillStyle = '#ff5c8f';
    g.fill();
    ink(g, s, 0.07);
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.beginPath();
    g.ellipse(s * 0.36, s * 0.4, s * 0.07, s * 0.05, -0.6, 0, Math.PI * 2);
    g.fill();
  }),
  glow: canvasTexture((g, s) => {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.3, 'rgba(255,255,255,0.35)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, s, s);
  }),
  // The blush on the cheeks: a soft oval, flat in the middle.
  blush: canvasTexture((g, s) => {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(255,255,255,0.95)');
    gr.addColorStop(0.55, 'rgba(255,255,255,0.7)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, s, s);
  }, 64),
  heart: canvasTexture((g, s) => {
    heartPath(g, s / 2, s * 0.56, s * 0.8);
    g.fillStyle = '#ff6b9a';
    g.fill();
    ink(g, s, 0.06);
    g.stroke();
  }),
  // A quaver with its stem, tinted by the flame's hue (white here).
  note: canvasTexture((g, s) => {
    const draw = () => {
      g.beginPath();
      g.ellipse(s * 0.38, s * 0.72, s * 0.15, s * 0.11, -0.4, 0, Math.PI * 2);
      g.moveTo(s * 0.51, s * 0.7);
      g.lineTo(s * 0.51, s * 0.18);
      g.quadraticCurveTo(s * 0.62, s * 0.34, s * 0.78, s * 0.36);
    };
    ink(g, s, 0.16);
    draw();
    g.stroke();
    g.strokeStyle = '#ffffff';
    g.lineWidth = s * 0.07;
    draw();
    g.stroke();
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.ellipse(s * 0.38, s * 0.72, s * 0.15, s * 0.11, -0.4, 0, Math.PI * 2);
    g.fill();
  }),
  // Four-pointed sparkle: celebrations and bumps on the head.
  star: canvasTexture((g, s) => {
    const c = s / 2;
    g.beginPath();
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
      const r = i % 2 ? s * 0.12 : s * 0.46;
      g.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
    }
    g.closePath();
    g.fillStyle = '#fff6c9';
    g.fill();
    ink(g, s, 0.05);
    g.stroke();
  }),
  // The cartoon sweat drop.
  sweat: canvasTexture((g, s) => {
    dropPath(g, s / 2, s * 0.1, s * 0.9, s * 0.5);
    g.fillStyle = '#9fd8ff';
    g.fill();
    ink(g, s, 0.06);
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.beginPath();
    g.ellipse(s * 0.42, s * 0.62, s * 0.05, s * 0.09, 0.3, 0, Math.PI * 2);
    g.fill();
  }),
  // "!": waiting for you, or startled.
  bang: canvasTexture((g, s) => {
    const shape = () => {
      g.beginPath();
      g.moveTo(s * 0.44, s * 0.1);
      g.lineTo(s * 0.56, s * 0.1);
      g.lineTo(s * 0.53, s * 0.62);
      g.lineTo(s * 0.47, s * 0.62);
      g.closePath();
      g.moveTo(s * 0.59, s * 0.8);
      g.arc(s * 0.5, s * 0.8, s * 0.09, 0, Math.PI * 2);
    };
    ink(g, s, 0.12);
    shape();
    g.stroke();
    g.fillStyle = '#ffd84d';
    shape();
    g.fill();
  }),
  // Sunglasses, as wide as the face.
  glasses: canvasTexture(
    (g, w, h) => {
      const lens = (x) => {
        roundRect(g, x, h * 0.22, w * 0.34, h * 0.62, h * 0.26);
      };
      g.fillStyle = '#1d1529';
      g.fillRect(w * 0.08, h * 0.24, w * 0.84, h * 0.12);
      for (const x of [w * 0.08, w * 0.58]) {
        lens(x);
        g.fillStyle = '#231a33';
        g.fill();
        g.lineWidth = h * 0.08;
        g.strokeStyle = '#1d1529';
        g.stroke();
        g.strokeStyle = 'rgba(255,255,255,0.75)';
        g.lineWidth = h * 0.07;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(x + w * 0.07, h * 0.42);
        g.lineTo(x + w * 0.13, h * 0.34);
        g.stroke();
      }
    },
    256,
    96,
  ),
  // The file you feed her: a little sheet with a folded corner.
  paper: canvasTexture((g, s) => {
    g.beginPath();
    g.moveTo(s * 0.22, s * 0.08);
    g.lineTo(s * 0.62, s * 0.08);
    g.lineTo(s * 0.8, s * 0.26);
    g.lineTo(s * 0.8, s * 0.92);
    g.lineTo(s * 0.22, s * 0.92);
    g.closePath();
    g.fillStyle = '#fbf7ff';
    g.fill();
    ink(g, s, 0.06);
    g.stroke();
    g.beginPath();
    g.moveTo(s * 0.62, s * 0.08);
    g.lineTo(s * 0.62, s * 0.26);
    g.lineTo(s * 0.8, s * 0.26);
    g.stroke();
    g.strokeStyle = '#b9b0cc';
    g.lineWidth = s * 0.05;
    for (const y of [0.42, 0.56, 0.7, 0.82]) {
      g.beginPath();
      g.moveTo(s * 0.32, s * y);
      g.lineTo(s * (y === 0.82 ? 0.55 : 0.7), s * y);
      g.stroke();
    }
  }),
};

/** A page to read, with the title in the flame's colour. */
export function pageTexture(accent) {
  return canvasTexture(
    (g, w, h) => {
      roundRect(g, w * 0.04, h * 0.03, w * 0.92, h * 0.94, w * 0.08);
      g.fillStyle = '#fbf7ff';
      g.fill();
      g.lineWidth = w * 0.035;
      g.strokeStyle = '#1d1529';
      g.stroke();
      g.fillStyle = `#${new THREE.Color(accent).getHexString()}`;
      roundRect(g, w * 0.16, h * 0.12, w * 0.5, h * 0.07, h * 0.035);
      g.fill();
      g.fillStyle = '#c4bbd6';
      for (let i = 0; i < 7; i += 1) {
        const width = i % 3 === 2 ? 0.42 : 0.68;
        roundRect(g, w * 0.16, h * (0.28 + i * 0.09), w * width, h * 0.035, h * 0.018);
        g.fill();
      }
    },
    128,
    160,
  );
}

/**
 * The little work terminal: lines of "code" that type themselves.
 * `write(dt)` adds characters; the canvas redraws only when it changes.
 */
export class TerminalScreen {
  constructor(colors) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 192;
    this.canvas.height = 128;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.colors = colors;
    this.lines = [];
    this.wait = 0;
    this._newLine();
    this._draw();
  }

  setColors(colors) {
    this.colors = colors;
    this._draw();
  }

  _newLine() {
    const indent = Math.random() < 0.5 ? Math.floor(Math.random() * 3) : 0;
    const words = [];
    let room = 15 - indent * 2;
    while (room > 2) {
      const length = 1 + Math.floor(Math.random() * Math.min(6, room - 1));
      words.push({ length, color: Math.floor(Math.random() * 4) });
      room -= length + 1;
    }
    this.lines.push({ indent, words, typed: 0, total: words.reduce((sum, word) => sum + word.length + 1, 0) });
    if (this.lines.length > 6) this.lines.shift();
  }

  write(dt) {
    this.wait -= dt;
    if (this.wait > 0) return;
    this.wait = 0.05 + Math.random() * 0.07;
    const line = this.lines[this.lines.length - 1];
    line.typed += 1 + Math.floor(Math.random() * 2);
    if (line.typed >= line.total) {
      this.wait = 0.18;
      this._newLine();
    }
    this._draw();
  }

  _draw() {
    const g = this.canvas.getContext('2d');
    const { width: w, height: h } = this.canvas;
    g.clearRect(0, 0, w, h);
    roundRect(g, 3, 3, w - 6, h - 6, 16);
    g.fillStyle = '#17121f';
    g.fill();
    g.lineWidth = 6;
    g.strokeStyle = '#1d1529';
    g.stroke();
    // A thread of her colour around the screen: it shows on a dark desktop.
    roundRect(g, 8, 8, w - 16, h - 16, 11);
    g.lineWidth = 2.5;
    g.strokeStyle = `#${new THREE.Color(this.colors.soft).getHexString()}aa`;
    g.stroke();
    // The window's three dots.
    ['#ff6b81', '#ffcf5c', '#5fd99c'].forEach((color, i) => {
      g.fillStyle = color;
      g.beginPath();
      g.arc(18 + i * 13, 17, 4, 0, Math.PI * 2);
      g.fill();
    });
    const palette = [this.colors.soft, this.colors.accent, 0x8fe3b8, 0xe9e4f5].map((c) => `#${new THREE.Color(c).getHexString()}`);
    const charW = 10;
    this.lines.forEach((line, row) => {
      let x = 14 + line.indent * charW * 1.5;
      let left = line.typed;
      const y = 32 + row * 15;
      for (const word of line.words) {
        if (left <= 0) break;
        const shown = Math.min(word.length, left);
        g.fillStyle = palette[word.color];
        roundRect(g, x, y, shown * charW - 3, 8, 4);
        g.fill();
        x += (word.length + 1) * charW;
        left -= word.length + 1;
      }
      // The cursor blinks at the end of the last line.
      if (row === this.lines.length - 1 && Math.floor(performance.now() / 400) % 2 === 0) {
        g.fillStyle = '#e9e4f5';
        g.fillRect(Math.min(x, w - 18), y - 1, 6, 10);
      }
    });
    this.texture.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ parts
export function part(parent, geometry, material, { pos, scale, outline = 0 } = {}) {
  const mesh = new THREE.Mesh(geometry, material);
  if (pos) mesh.position.copy(pos);
  if (scale !== undefined) {
    if (typeof scale === 'number') mesh.scale.setScalar(scale);
    else mesh.scale.set(...scale);
  }
  if (outline) {
    const line = new THREE.Mesh(geometry, flat(INK, { side: THREE.BackSide }));
    line.scale.setScalar(1 + outline);
    mesh.add(line);
  }
  parent.add(mesh);
  return mesh;
}

export function glowSprite(color, size, opacity) {
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: TEX.glow, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
  );
  sprite.scale.setScalar(size);
  return sprite;
}

export function textureSprite(texture, size) {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false }));
  sprite.scale.setScalar(size);
  return sprite;
}

/** The faces drawn over the eye: which texture, and whether it's mirrored, flipped or rotated. */
const OVERLAYS = {
  squint: { texture: 'squint', mirror: true },
  happy: { texture: 'happy' },
  closed: { texture: 'happy', flip: true },
  flat: { texture: 'flat' },
  spiral: { texture: 'spiral', spin: true },
  heart: { texture: 'heartEye', big: true },
};

/** Tsukumo's eyes: dark ovals with a highlight, the same in every form. */
export function makeEye(parent, position, normal, size, mirror) {
  const group = new THREE.Group();
  group.position.copy(position);
  group.quaternion.setFromUnitVectors(Z, normal.clone().normalize());
  parent.add(group);
  const inner = new THREE.Group();
  group.add(inner);
  part(inner, SPHERE, flat(INK), { scale: [size * 0.78, size, size * 0.42] });
  part(inner, SPHERE, flat(0xffffff), { pos: new THREE.Vector3(size * 0.26, size * 0.36, size * 0.34), scale: size * 0.27 });
  const overlays = {};
  for (const [key, spec] of Object.entries(OVERLAYS)) {
    const material = flat(0xffffff, { map: TEX[spec.texture], transparent: true, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(PLANE, material);
    const s = size * (spec.big ? 2.9 : 2.5);
    mesh.scale.set(mirror && spec.mirror ? -s : s, spec.flip ? -s : s, 1);
    mesh.position.z = size * 0.45;
    mesh.visible = false;
    mesh.userData.spin = spec.spin ? (mirror ? -1 : 1) : 0;
    group.add(mesh);
    overlays[key] = mesh;
  }
  return {
    /** `scale`: how big they are (1 normal; wide open, or "popping" when the expression changes). */
    update(lookX, lookY, blink, mode, scale, open, t = 0) {
      const normal = mode === 'normal';
      inner.visible = normal;
      for (const key in overlays) {
        const overlay = overlays[key];
        overlay.visible = key === mode;
        if (overlay.visible && overlay.userData.spin) overlay.rotation.z = -t * 9 * overlay.userData.spin;
      }
      inner.position.set(lookX * size * 0.16, lookY * size * 0.16, 0);
      const w = Math.max(0.05, scale);
      group.scale.set(w, normal ? Math.max(0.08, (1 - blink) * open) * w : w, 1);
    },
  };
}
