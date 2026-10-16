/**
 * The dashboard's tiles can be moved and widened. Drag one by its title bar
 * and the others make room; the button on its bar makes it take the whole
 * row or half of it. The grip moves it with the arrow keys too.
 *
 * The arrangement is a preference of this PC (localStorage), not data: tiles
 * added by an update find their default place, and "Reset layout" brings the
 * original one back.
 */

import { el, iconButton, readSetting, writeSetting } from '../dom.js';
import { t } from '../i18n.js';

const LAYOUT_SETTING = 'dc:dashboard-layout';
/** A press becomes a drag after this many pixels: a click on the title stays a click. */
const DRAG_FROM = 6;
/** How close to the grid's top or bottom edge a drag scrolls it. */
const SCROLL_EDGE = 48;
const MOVE_MS = 200;
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

export class TileLayout {
  /**
   * @param {HTMLElement} grid
   * @param {Record<string, HTMLElement>} tiles name → card, in the default order
   * @param {{wide?: string[], onChange?: (custom: boolean) => void}} options
   */
  constructor(grid, tiles, { wide = [], onChange = () => {} } = {}) {
    this.grid = grid;
    this.tiles = tiles;
    this.defaults = { order: Object.keys(tiles), wide: [...wide] };
    this.onChange = onChange;
    this.layout = this.sanitize(readSetting(LAYOUT_SETTING, null));
    this.drag = null;
    for (const [name, node] of Object.entries(tiles)) this.decorate(name, node);
    this.apply();
  }

  /** What was saved, minus the tiles that no longer exist, plus the new ones in their default place. */
  sanitize(saved) {
    const names = this.defaults.order;
    const order = [...new Set(Array.isArray(saved?.order) ? saved.order : [])].filter((name) => names.includes(name));
    for (const name of names) if (!order.includes(name)) order.splice(Math.min(order.length, names.indexOf(name)), 0, name);
    const wide = Array.isArray(saved?.wide) ? saved.wide.filter((name) => names.includes(name)) : [...this.defaults.wide];
    return { order, wide };
  }

  get custom() {
    const { order, wide } = this.layout;
    return order.join() !== this.defaults.order.join() || [...wide].sort().join() !== [...this.defaults.wide].sort().join();
  }

  apply() {
    this.grid.append(...this.layout.order.map((name) => this.tiles[name]));
    for (const [name, node] of Object.entries(this.tiles)) {
      const wide = this.layout.wide.includes(name);
      node.classList.toggle('wide', wide);
      node.querySelector('.tile-wide')?.setAttribute('aria-pressed', String(wide));
    }
    this.onChange(this.custom);
  }

  save() {
    writeSetting(LAYOUT_SETTING, this.layout);
    this.onChange(this.custom);
  }

  reset() {
    this.animate(() => {
      this.layout = { order: [...this.defaults.order], wide: [...this.defaults.wide] };
      this.apply();
    });
    this.save();
  }

  toggleWide(name) {
    this.animate(() => {
      const wide = new Set(this.layout.wide);
      if (wide.has(name)) wide.delete(name);
      else wide.add(name);
      this.layout.wide = [...wide];
      this.apply();
    });
    this.save();
  }

  // ----------------------------------------------------------- the title bar
  decorate(name, node) {
    node.dataset.tile = name;
    const head = node.querySelector('.card-head');
    if (!head) return;
    const grip = iconButton('dots', { title: t('Drag to move it, or use the arrow keys'), className: 'icon-btn tile-grip', size: 15 });
    const wide = iconButton('resize', { title: t('Whole row or half'), className: 'icon-btn tile-wide', size: 14, onClick: () => this.toggleWide(name) });
    head.append(el('span', { class: 'tile-tools' }, wide, grip));
    head.classList.add('tile-handle');
    head.addEventListener('pointerdown', (event) => this.press(event, name));
    grip.addEventListener('keydown', (event) => this.nudge(event, name));
  }

  /** The arrows move the tile one place; the focus stays on its grip. */
  nudge(event, name) {
    const step = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const order = this.layout.order;
    const from = order.indexOf(name);
    const to = from + step;
    if (to < 0 || to >= order.length) return;
    this.animate(() => {
      order.splice(from, 1);
      order.splice(to, 0, name);
      this.apply();
    });
    this.save();
    this.tiles[name].querySelector('.tile-grip')?.focus();
  }

  // -------------------------------------------------------------- dragging
  press(event, name) {
    // The buttons on the bar stay buttons (the grip is the exception: it's made to be dragged).
    if (event.button !== 0 || (event.target.closest('button, a, input, select, textarea') && !event.target.closest('.tile-grip'))) return;
    const node = this.tiles[name];
    const rect = node.getBoundingClientRect();
    this.drag = { name, node, pointer: event.pointerId, startX: event.clientX, startY: event.clientY, grabX: event.clientX - rect.left, grabY: event.clientY - rect.top, moving: false };
    // On the window, not with a pointer capture on the bar: moving the tile in
    // the grid takes it out of the page for an instant, and that drops the capture.
    const move = (moveEvent) => moveEvent.pointerId === this.drag?.pointer && this.move(moveEvent);
    const end = (endEvent) => {
      if (endEvent.pointerId !== this.drag?.pointer) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      this.drop();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  move(event) {
    const drag = this.drag;
    if (!drag) return;
    if (!drag.moving) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_FROM) return;
      drag.moving = true;
      drag.node.classList.add('dragging');
      this.grid.classList.add('arranging');
    }
    const box = this.grid.getBoundingClientRect();
    if (event.clientY < box.top + SCROLL_EDGE) this.grid.scrollTop -= 14;
    else if (event.clientY > box.bottom - SCROLL_EDGE) this.grid.scrollTop += 14;

    const target = this.layout.order
      .map((name) => this.tiles[name])
      .find((node) => {
        if (node === drag.node) return false;
        const rect = node.getBoundingClientRect();
        return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      });
    if (target) {
      const rect = target.getBoundingClientRect();
      // Side by side tiles swap left and right; a whole-row tile, above and below.
      const sideways = rect.width < this.grid.clientWidth * 0.7;
      const before = sideways ? event.clientX < rect.left + rect.width / 2 : event.clientY < rect.top + rect.height / 2;
      const order = this.layout.order.filter((name) => name !== drag.name);
      order.splice(order.indexOf(target.dataset.tile) + (before ? 0 : 1), 0, drag.name);
      if (order.join() !== this.layout.order.join()) {
        this.animate(() => {
          this.layout.order = order;
          // Only the dragged tile changes place in the page.
          const next = order[order.indexOf(drag.name) + 1];
          this.grid.insertBefore(drag.node, next ? this.tiles[next] : null);
        }, drag.node);
      }
    }
    this.follow(event);
  }

  /** The dragged tile stays under the pointer, wherever the grid has put its slot. */
  follow(event) {
    const { node, grabX, grabY } = this.drag;
    const box = this.grid.getBoundingClientRect();
    const slotX = box.left + this.grid.clientLeft + node.offsetLeft - this.grid.scrollLeft;
    const slotY = box.top + this.grid.clientTop + node.offsetTop - this.grid.scrollTop;
    node.style.transform = `translate(${event.clientX - grabX - slotX}px, ${event.clientY - grabY - slotY}px)`;
  }

  drop() {
    const drag = this.drag;
    this.drag = null;
    if (!drag?.moving) return;
    const { node } = drag;
    const from = node.style.transform;
    node.style.transform = '';
    node.classList.remove('dragging');
    this.grid.classList.remove('arranging');
    node.animate([{ transform: from }, { transform: 'none' }], { duration: MOVE_MS, easing: EASE });
    this.save();
  }

  /**
   * Changes the layout and slides every tile from where it was to where it
   * lands (FLIP), instead of letting them jump. `skip`: the dragged tile, which
   * follows the pointer.
   */
  animate(change, skip = null) {
    const nodes = Object.values(this.tiles).filter((node) => node !== skip);
    const before = new Map(nodes.map((node) => [node, node.getBoundingClientRect()]));
    change();
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    for (const node of nodes) {
      const was = before.get(node);
      const now = node.getBoundingClientRect();
      const dx = was.left - now.left;
      const dy = was.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(was.width - now.width) < 1) continue;
      node.animate(
        [{ transform: `translate(${dx}px, ${dy}px) scale(${was.width / now.width}, ${was.height / now.height})`, transformOrigin: 'top left' }, { transform: 'none', transformOrigin: 'top left' }],
        { duration: MOVE_MS, easing: EASE },
      );
    }
  }
}
