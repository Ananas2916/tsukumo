/**
 * Pannello olografico: il "tablet" che tiene in mano mentre un agente legge
 * o cerca, e la "tastiera" su cui batte mentre scrive o esegue comandi.
 *
 * Senza un oggetto le pose da lavoro (body.js, `_reading` e `_typing`) si
 * leggono male: mani al petto potrebbero voler dire qualunque cosa. Il
 * pannello e' disegnato su un canvas (righe che scorrono, tasti che si
 * accendono), segue le mani a ogni frame e compare/sparisce con lo stesso
 * peso della posa.
 */

import * as THREE from 'three';

/** Lilla dell'interfaccia (theme.css, --accent) e un azzurro per le righe. */
const ACCENT = [184, 160, 255];
const LINE = [214, 236, 255];

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _head = new THREE.Vector3();
const _up = new THREE.Vector3();
const _toHead = new THREE.Vector3();

function rgba([r, g, b], alpha) {
  return `rgba(${r},${g},${b},${alpha})`;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Una superficie disegnata su canvas, trasparente e senza ombre ne' tone mapping. */
class Surface {
  constructor(width, height, meters) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(meters, (meters * height) / width), this.material);
    this.mesh.visible = false;
    this.mesh.renderOrder = 10;
    this.mesh.frustumCulled = false;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

export class HoloPanel {
  /**
   * @param {THREE.Object3D} parent dove appendere i pannelli (la scena)
   */
  constructor(parent) {
    this.tablet = new Surface(256, 176, 0.19);
    this.keyboard = new Surface(320, 112, 0.24);
    parent.add(this.tablet.mesh, this.keyboard.mesh);
    this.time = 0;
    this._lines = Array.from({ length: 14 }, () => 0.3 + Math.random() * 0.65);
    this._keys = new Float32Array(3 * 10);
    this._tapping = [false, false];
    this._redrawIn = 0;
  }

  /**
   * @param {number} dt
   * @param {import('@pixiv/three-vrm').VRM | null} vrm
   * @param {{reading: number, typing: number, taps: [number, number]} | null} work pesi delle pose
   */
  update(dt, vrm, work) {
    this.time += dt;
    const reading = work?.reading ?? 0;
    const typing = work?.typing ?? 0;
    const humanoid = vrm?.humanoid;
    this.tablet.mesh.visible = reading > 0.02 && Boolean(humanoid);
    this.keyboard.mesh.visible = typing > 0.02 && Boolean(humanoid);
    if (!this.tablet.mesh.visible && !this.keyboard.mesh.visible) return;

    // Il pannello va disegnato solo a 30 fps: e' un dettaglio, non deve costare.
    this._redrawIn -= dt;
    const redraw = this._redrawIn <= 0;
    if (redraw) this._redrawIn = 1 / 30;

    if (this.tablet.mesh.visible) this._placeTablet(humanoid, reading, redraw);
    if (this.keyboard.mesh.visible) this._placeKeyboard(humanoid, typing, work.taps ?? [0, 0], dt, redraw);
  }

  _palms(humanoid) {
    const left = humanoid.getRawBoneNode('leftMiddleProximal') ?? humanoid.getRawBoneNode('leftHand');
    const right = humanoid.getRawBoneNode('rightMiddleProximal') ?? humanoid.getRawBoneNode('rightHand');
    if (!left || !right) return null;
    left.getWorldPosition(_a);
    right.getWorldPosition(_b);
    return _mid.addVectors(_a, _b).multiplyScalar(0.5);
  }

  _placeTablet(humanoid, weight, redraw) {
    const mesh = this.tablet.mesh;
    const mid = this._palms(humanoid);
    const head = humanoid.getRawBoneNode('head');
    if (!mid || !head) {
      mesh.visible = false;
      return;
    }
    head.getWorldPosition(_head);
    mesh.position.copy(mid);
    mesh.position.y += 0.035;
    // Lo schermo guarda la sua faccia: lo vedi di sbieco, come un tablet vero.
    mesh.up.copy(_up.subVectors(_b, _a).cross(_toHead.subVectors(_head, mid)).normalize().negate());
    mesh.lookAt(_head);
    mesh.scale.setScalar(0.6 + 0.4 * weight);
    this.tablet.material.opacity = weight;
    if (redraw) this._drawTablet();
  }

  _placeKeyboard(humanoid, weight, taps, dt, redraw) {
    const mesh = this.keyboard.mesh;
    const mid = this._palms(humanoid);
    const hips = humanoid.getRawBoneNode('hips');
    if (!mid || !hips) {
      mesh.visible = false;
      return;
    }
    // Sotto le dita, orientata come il bacino e inclinata verso chi guarda:
    // perfettamente in piano si vedrebbe solo di taglio.
    mesh.position.copy(mid);
    mesh.position.y -= 0.03;
    hips.getWorldQuaternion(mesh.quaternion);
    mesh.rotateX(-Math.PI / 2 + 0.6);
    mesh.scale.setScalar(0.6 + 0.4 * weight);
    this.keyboard.material.opacity = weight;
    // Un tasto si accende a ogni colpo delle dita, poi si spegne.
    for (let i = 0; i < this._keys.length; i++) this._keys[i] = Math.max(0, this._keys[i] - dt * 5);
    for (const [side, tap] of taps.entries()) {
      const down = tap > 0.8;
      // Un tasto per colpo: sul fronte di discesa, sinistra a sinistra e destra a destra.
      if (down && !this._tapping[side]) this._keys[Math.floor(Math.random() * 3) * 10 + side * 5 + Math.floor(Math.random() * 5)] = 1;
      this._tapping[side] = down;
    }
    if (redraw) this._drawKeyboard();
  }

  _drawTablet() {
    const { ctx, canvas, texture } = this.tablet;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    roundRect(ctx, 3, 3, w - 6, h - 6, 16);
    ctx.fillStyle = rgba(ACCENT, 0.22);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = rgba(ACCENT, 0.9);
    ctx.stroke();

    // Righe di testo che scorrono verso l'alto.
    const lineHeight = 16;
    const scroll = (this.time * 22) % lineHeight;
    const first = Math.floor((this.time * 22) / lineHeight);
    ctx.save();
    roundRect(ctx, 12, 14, w - 24, h - 28, 8);
    ctx.clip();
    for (let row = 0; row < 12; row++) {
      const length = this._lines[(first + row) % this._lines.length];
      const y = 22 + row * lineHeight - scroll;
      const indent = (first + row) % 5 === 0 ? 0 : 14;
      ctx.fillStyle = rgba(LINE, (first + row) % 7 === 0 ? 0.95 : 0.6);
      roundRect(ctx, 20 + indent, y, (w - 60 - indent) * length, 6, 3);
      ctx.fill();
    }
    ctx.restore();
    texture.needsUpdate = true;
  }

  _drawKeyboard() {
    const { ctx, canvas, texture } = this.keyboard;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    roundRect(ctx, 3, 3, w - 6, h - 6, 14);
    ctx.fillStyle = rgba(ACCENT, 0.18);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = rgba(ACCENT, 0.85);
    ctx.stroke();
    const cols = 10;
    const rows = 3;
    const keyW = (w - 40) / cols;
    const keyH = (h - 30) / rows;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const lit = this._keys[row * cols + col];
        ctx.fillStyle = rgba(lit > 0 ? LINE : ACCENT, 0.35 + 0.6 * lit);
        roundRect(ctx, 20 + col * keyW + 2, 15 + row * keyH + 2, keyW - 4, keyH - 4, 4);
        ctx.fill();
      }
    }
    texture.needsUpdate = true;
  }

  dispose() {
    for (const surface of [this.tablet, this.keyboard]) {
      surface.mesh.removeFromParent();
      surface.dispose();
    }
  }
}
