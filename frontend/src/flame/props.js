/**
 * The flame's props.
 *
 * While the agent works she holds what it's doing, like Blobby with its
 * little terminal: writing or running commands -> a terminal filling up
 * with lines; reading or planning -> a page; searching -> a magnifying glass
 * going back and forth; delegating to a sub-agent -> a small flame circling
 * her. And then the reactions' accessories: the sleep bubble, the
 * sunglasses, the "!" and the sheet she eats.
 *
 * All in drop units (UNIT tall, bulb of radius R, lifted by HOVER), child of
 * `root`: it follows size and position, not the gaze.
 */

import * as THREE from 'three';

import { flat, INK, pageTexture, part, PLANE, SPHERE, TerminalScreen, TEX, textureSprite, toon } from './look.js';

const damp = (current, target, rate, dt) => current + (target - current) * (1 - Math.exp(-rate * dt));
const pop = (k) => {
  const x = Math.min(1, Math.max(0, k)) - 1;
  return 1 + 2.7 * x * x * x + 1.7 * x * x;
};

/** Which object for which agent job (see backend/llm/base.py, ActivityKind). */
const PROP_FOR = { write: 'terminal', run: 'terminal', tool: 'terminal', read: 'page', plan: 'page', search: 'lens', web: 'lens', agent: 'buddy' };

export class WorkProps {
  /**
   * @param {THREE.Object3D} root
   * @param {{HOVER: number, R: number, UNIT: number}} size
   * @param {THREE.BufferGeometry} dropGeometry the drop, for the small flame
   * @param {object} colors the palette (look.js)
   */
  constructor(root, { HOVER, R }, dropGeometry, colors) {
    this.weights = { terminal: 0, page: 0, lens: 0, buddy: 0 };
    this.t = 0;
    const group = new THREE.Group();
    root.add(group);

    // Terminal: on the right, turned towards her.
    this.screen = new TerminalScreen(colors);
    this.terminal = new THREE.Group();
    this.terminal.position.set(0.8, HOVER + R, 0.3);
    this.terminal.rotation.y = -0.4;
    const screen = new THREE.Mesh(PLANE, flat(0xffffff, { map: this.screen.texture, transparent: true, side: THREE.DoubleSide }));
    screen.scale.set(0.86, 0.575, 1);
    this.terminal.add(screen);

    // Page: on the left, a little crooked.
    this.pageMaterial = flat(0xffffff, { map: pageTexture(colors.accent), transparent: true, side: THREE.DoubleSide });
    this.page = new THREE.Mesh(PLANE, this.pageMaterial);
    this.page.scale.set(0.56, 0.7, 1);
    this.page.position.set(-0.78, HOVER + R, 0.28);
    this.page.rotation.set(0, 0.5, 0.08);

    // Magnifying glass.
    this.lens = new THREE.Group();
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.03, 10, 40), toon(0x3a2f52));
    const glass = new THREE.Mesh(new THREE.CircleGeometry(0.15, 32), flat(0xffffff, { transparent: true, opacity: 0.28, depthWrite: false }));
    const shine = part(this.lens, SPHERE, flat(0xffffff), { pos: new THREE.Vector3(-0.06, 0.06, 0.01), scale: [0.03, 0.018, 0.005] });
    shine.rotation.z = 0.7;
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.03, 0.24, 12), toon(0x6b4a3a));
    handle.position.set(0.17, -0.17, 0);
    handle.rotation.z = Math.PI / 4;
    this.lens.add(rim, glass, handle);

    // The small flame: the same drop (same colours), with two little eyes.
    this.buddy = new THREE.Group();
    const mini = new THREE.Mesh(dropGeometry, toon(0xffffff, { vertexColors: true, emissive: new THREE.Color(colors.emissive), emissiveIntensity: 0.25 }));
    this.buddyMaterial = mini.material;
    const outline = new THREE.Mesh(dropGeometry, flat(INK, { side: THREE.BackSide }));
    outline.scale.setScalar(1.06);
    mini.add(outline);
    for (const s of [-1, 1]) part(mini, SPHERE, flat(INK), { pos: new THREE.Vector3(s * 0.15, 0.04, 0.39), scale: [0.05, 0.065, 0.03] });
    mini.scale.setScalar(0.3);
    this.buddy.add(mini);
    this.bulbY = HOVER + R;

    group.add(this.terminal, this.page, this.lens, this.buddy);
    this.items = { terminal: this.terminal, page: this.page, lens: this.lens, buddy: this.buddy };
    for (const node of Object.values(this.items)) node.visible = false;
    this.base = { terminal: this.terminal.scale.clone(), page: this.page.scale.clone(), lens: new THREE.Vector3(1.45, 1.45, 1.45), buddy: new THREE.Vector3(1.2, 1.2, 1.2) };
  }

  setColors(colors) {
    this.screen.setColors(colors);
    this.pageMaterial.map.dispose();
    this.pageMaterial.map = pageTexture(colors.accent);
    this.buddyMaterial.emissive.set(colors.emissive);
  }

  get active() {
    return Object.values(this.weights).some((w) => w > 0.01);
  }

  /**
   * @param {string|null} kind the agent's job (`read`, `write`...)
   * @returns {{look: {x:number, y:number}|null, typing: number}} where she looks and how much she types
   */
  update(dt, kind) {
    this.t += dt;
    const t = this.t;
    const wanted = PROP_FOR[kind] ?? null;
    for (const name of Object.keys(this.weights)) {
      this.weights[name] = damp(this.weights[name], name === wanted ? 1 : 0, name === wanted ? 7 : 10, dt);
      const node = this.items[name];
      const w = this.weights[name];
      node.visible = w > 0.01;
      if (node.visible) node.scale.copy(this.base[name]).multiplyScalar(Math.max(0.001, pop(w)));
    }

    let look = null;
    let typing = 0;
    if (this.terminal.visible) {
      if (wanted === 'terminal') this.screen.write(dt);
      this.terminal.position.y = this.bulbY - 0.02 + Math.sin(t * 2.2) * 0.02;
      look = { x: 0.8, y: -0.25 };
      typing = this.weights.terminal;
    }
    if (this.page.visible) {
      this.page.position.y = this.bulbY + 0.02 + Math.sin(t * 1.7) * 0.025;
      this.page.rotation.z = 0.08 + Math.sin(t * 1.3) * 0.04;
      // Reads line by line: moves right, back to the start of the line.
      const line = (t * 0.55) % 1;
      look = { x: -0.95 + line * 0.45, y: -0.1 - Math.floor((t * 0.55) % 6) * 0.06 };
    }
    if (this.lens.visible) {
      this.lens.position.set(0.66 + Math.sin(t * 1.1) * 0.2, this.bulbY + 0.12 + Math.sin(t * 1.9) * 0.18, 0.5);
      this.lens.rotation.z = Math.sin(t * 1.1) * 0.25;
      look = { x: 0.35 + Math.sin(t * 1.1) * 0.3, y: Math.sin(t * 1.9) * 0.45 };
    }
    if (this.buddy.visible) {
      const a = t * 1.7;
      this.buddy.position.set(Math.cos(a) * 0.85, this.bulbY + 0.42 + Math.sin(t * 3.1) * 0.06, Math.sin(a) * 0.55);
      this.buddy.rotation.z = -Math.cos(a) * 0.25;
      this.buddy.children[0].rotation.y = Math.sin(a) * 0.4;
      // Follows it with her eyes when it passes in front of her.
      if (Math.sin(a) > -0.2) look = { x: Math.cos(a) * 0.9, y: 0.35 };
    }
    return { look, typing };
  }
}

/**
 * The reactions' accessories, each with its own 0..1:
 *  - `bubble`: the anime sleep bubble, swelling with her breath;
 *  - `glasses`: sunglasses dropping onto her eyes ("cool");
 *  - `bang`: the "!" above the tip (waiting for you, startled);
 *  - `sweat`: the sweat drop (speechless);
 *  - `snack`: the file flying into her mouth when you give it to her.
 */
export class Accessories {
  constructor(root, pivot, { HOVER, R, UNIT }, colors) {
    this.HOVER = HOVER;
    this.R = R;
    this.UNIT = UNIT;
    this.t = 0;

    this.bubble = new THREE.Group();
    this.bubbleSkin = part(this.bubble, SPHERE, flat(colors.soft, { transparent: true, opacity: 0.5, depthWrite: false }));
    part(this.bubble, SPHERE, flat(0xffffff, { transparent: true, opacity: 0.9, depthWrite: false }), { pos: new THREE.Vector3(-0.35, 0.4, 0.75), scale: [0.22, 0.14, 0.05] });
    this.bubble.position.set(0.2, -0.16, R + 0.06);
    this.bubble.visible = false;
    pivot.add(this.bubble);

    this.glasses = new THREE.Mesh(PLANE, flat(0xffffff, { map: TEX.glasses, transparent: true, depthWrite: false }));
    this.glasses.scale.set(0.6, 0.6 * (96 / 256), 1);
    this.glassesRest = new THREE.Vector3(0, 0.04, R + 0.05);
    this.glasses.visible = false;
    pivot.add(this.glasses);

    this.bang = textureSprite(TEX.bang, 0.001);
    this.bang.position.set(0.32, HOVER + UNIT + 0.24, 0.1);
    this.bang.visible = false;
    root.add(this.bang);

    this.sweat = textureSprite(TEX.sweat, 0.16);
    this.sweat.visible = false;
    pivot.add(this.sweat);

    this.snack = textureSprite(TEX.paper, 0.42);
    this.snack.visible = false;
    root.add(this.snack);
    this.mouth = new THREE.Vector3(0, HOVER + R - 0.13, R);
  }

  setColors(colors) {
    this.bubbleSkin.material.color.set(colors.soft);
  }

  /** Where the bubble is in the world, for the pop. */
  bubbleWorld(target = new THREE.Vector3()) {
    return this.bubble.getWorldPosition(target);
  }

  /**
   * @param {object} s how much of each there is: `{bubble, glasses, bang, sweat, snack}` (0..1);
   * `snack` is the progress of the flight towards the mouth.
   */
  update(dt, s) {
    this.t += dt;
    const t = this.t;

    // The bubble swells and shrinks with the slow breath of sleep.
    this.bubble.visible = s.bubble > 0.01;
    if (this.bubble.visible) {
      const breath = 0.5 + 0.5 * Math.sin(t * 1.25);
      this.bubble.scale.setScalar(Math.max(0.001, s.bubble * (0.07 + breath * 0.17)));
    }

    // The glasses come down from above and stop on the eyes.
    this.glasses.visible = s.glasses > 0.01;
    if (this.glasses.visible) {
      this.glasses.position.copy(this.glassesRest);
      this.glasses.position.y += (1 - s.glasses) * 0.55;
      this.glasses.material.opacity = Math.min(1, s.glasses * 3);
    }

    this.bang.visible = s.bang > 0.01;
    if (this.bang.visible) {
      this.bang.scale.setScalar(Math.max(0.001, 0.34 * pop(s.bang)));
      this.bang.material.rotation = Math.sin(t * 14) * 0.12;
    }

    // The sweat slides down the temple.
    this.sweat.visible = s.sweat > 0.01;
    if (this.sweat.visible) {
      this.sweat.position.set(this.R * 0.82, this.R * 0.55 - (1 - s.sweat) * 0.05 - ((t * 0.08) % 0.12), this.R * 0.45);
      this.sweat.material.opacity = Math.min(1, s.sweat * 2);
    }

    // The sheet comes from the top right, turns and shrinks into her mouth.
    this.snack.visible = s.snack > 0 && s.snack < 1;
    if (this.snack.visible) {
      const k = s.snack;
      const from = new THREE.Vector3(1.0, this.HOVER + this.UNIT + 0.35, 0.3);
      this.snack.position.lerpVectors(from, this.mouth, k * k);
      this.snack.position.y += Math.sin(k * Math.PI) * 0.25;
      this.snack.scale.setScalar(0.44 * (1 - k * 0.8));
      this.snack.material.rotation = k * 5;
    }
  }
}
