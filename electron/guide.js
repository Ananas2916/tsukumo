/**
 * The "umbilical cord": a block-diagram arrow from her to the spot on the
 * screen the brain wants to show (backend/guide.py).
 *
 * - `glance()` takes the screenshot the brain and the eye look at, with
 *   where it sits on the screen. Her windows are kept out of it (Windows
 *   10 2004+ leaves them out of captures instead of blacking them).
 * - The arrow lives in transparent, click-through windows, one per display
 *   it crosses, sized to the arrow: a window as big as the screen would
 *   look like a full-screen app to Windows. They're never in screenshots.
 * - While a step is shown the mouse buttons are watched (only whether
 *   they're down, and only then where the cursor is) to notice the click on
 *   the spot, and the spot's window is followed if it moves.
 *
 * The backend speaks physical pixels; everything here is converted to DIP,
 * the unit of BrowserWindow and of `screen`.
 */

const { BrowserWindow, desktopCapturer, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const desktop = require('./desktop');

const POLL_MS = 25;
const WINDOW_CHECK_MS = 250;
/** The window must stay still this long before the spot is looked for again. */
const SETTLE_MS = 600;
/** A click this close to the spot counts (DIP). */
const HIT_SLOP = 8;
/** Room around the arrow inside its window: the label and the arrowhead. */
const PAD = 48;
const LABEL_ROOM = { width: 300, height: 34 };
const VK = { LBUTTON: 0x01, RBUTTON: 0x02, TAB: 0x09, RETURN: 0x0d };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (win) => win && !win.isDestroyed();

/** A rectangle from a message: four finite numbers, or null. */
function rectOf(value) {
  if (!value || typeof value !== 'object') return null;
  const rect = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    const number = Number(value[key]);
    if (!Number.isFinite(number) || Math.abs(number) > 100000) return null;
    rect[key] = Math.round(number);
  }
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

/** Physical pixels -> DIP (per display, with Windows' scaling). */
function toDip(value) {
  const rect = rectOf(value);
  if (!rect) return null;
  return process.platform === 'win32' ? screen.screenToDipRect(null, rect) : rect;
}

function toPhysical(rect) {
  return process.platform === 'win32' ? screen.dipToScreenRect(null, rect) : { ...rect };
}

const inside = (point, rect, slop = 0) =>
  point.x >= rect.x - slop && point.x <= rect.x + rect.width + slop && point.y >= rect.y - slop && point.y <= rect.y + rect.height + slop;

// ---------------------------------------------------------------------------
// The screenshot
// ---------------------------------------------------------------------------
/**
 * The display being worked on, captured whole, plus the window in front.
 * When you write in her chat the window in front is hers: then it's the
 * first one behind.
 *
 * @param {Set<number>} own handles of her windows
 * @param {BrowserWindow[]} hide her windows to keep out of the picture
 * @param {string} folder where screenshots go (the backend accepts only that one)
 */
async function glance(own, hide, folder) {
  let window = null;
  const front = desktop.foregroundWindow(own);
  let hwnd = front && !front.own ? front.handle : null;
  if (!hwnd) hwnd = desktop.listWindows(own)[0]?.hwnd ?? null;
  const physical = hwnd ? desktop.physicalWindowRect(hwnd) : null;
  if (physical) {
    const info = desktop.windowInfo(hwnd);
    window = { hwnd, ...physical, title: info.title, exe: info.exe };
  }
  const display = physical ? screen.getDisplayMatching(toDip(physical)) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const size = {
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor),
  };
  const hidden = hide.filter((win) => alive(win) && win.isVisible());
  for (const win of hidden) win.setContentProtection(true);
  let sources;
  try {
    // A frame for the change to reach the compositor.
    if (hidden.length) await sleep(60);
    sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  } finally {
    for (const win of hidden) if (alive(win)) win.setContentProtection(false);
  }
  const source = sources.find((item) => item.display_id === String(display.id)) ?? sources[0];
  if (!source || source.thumbnail.isEmpty()) throw new Error('No screen to capture');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `glance-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
  fs.writeFileSync(file, source.thumbnail.toPNG());
  const image = source.thumbnail.getSize();
  return { file, display: toPhysical(display.bounds), image, window };
}

// ---------------------------------------------------------------------------
// Block-diagram routing
// ---------------------------------------------------------------------------
/** Within the box's span on that axis (with a little margin): a straight line can go in. */
const across = (value, start, length) => value >= start + 3 && value <= start + length - 3;

/**
 * An elbow connector from a point to a box, entering the side that faces
 * it: horizontal-vertical-horizontal when the box is more to the side,
 * vertical-horizontal-vertical when it's more above or below. Already in
 * line with the box, it's one straight segment.
 *
 * @param {{x, y}} from
 * @param {{x, y, width, height}} box
 * @param {number} leave how far from `from` the line starts (her radius)
 * @param {'horizontal' | 'vertical' | null} axis force how it leaves `from`
 */
function elbow(from, box, leave = 0, axis = null) {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dx = cx - from.x;
  const dy = cy - from.y;
  if ((axis ?? (Math.abs(dx) >= Math.abs(dy) ? 'horizontal' : 'vertical')) === 'horizontal') {
    const sx = from.x + Math.sign(dx || 1) * leave;
    const ex = dx > 0 ? box.x : box.x + box.width;
    if (across(from.y, box.y, box.height)) {
      return [
        [sx, from.y],
        [ex, from.y],
      ];
    }
    const mid = (sx + ex) / 2;
    return [
      [sx, from.y],
      [mid, from.y],
      [mid, cy],
      [ex, cy],
    ];
  }
  const sy = from.y + Math.sign(dy || 1) * leave;
  const ey = dy > 0 ? box.y : box.y + box.height;
  if (across(from.x, box.x, box.width)) {
    return [
      [from.x, sy],
      [from.x, ey],
    ];
  }
  const mid = (sy + ey) / 2;
  return [
    [from.x, sy],
    [from.x, mid],
    [cx, mid],
    [cx, ey],
  ];
}

/**
 * Box to box, for a wire. It leaves A on the other axis from the one the
 * cord came in on, so the two lines never run over each other.
 */
function boxToBox(a, b, cord) {
  const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const [[x1], [x2]] = cord.slice(-2);
  const axis = Math.abs(x2 - x1) > 0.5 ? 'vertical' : 'horizontal';
  return elbow(ac, b, axis === 'horizontal' ? a.width / 2 : a.height / 2, axis);
}

function bounds(points, boxes) {
  const xs = [];
  const ys = [];
  for (const [x, y] of points) {
    xs.push(x);
    ys.push(y);
  }
  for (const box of boxes) {
    xs.push(box.x, box.x + box.width);
    ys.push(box.y - LABEL_ROOM.height, box.y + box.height + LABEL_ROOM.height);
    // The label may sit beside the box, to the right.
    xs.push(box.x + LABEL_ROOM.width);
  }
  const left = Math.min(...xs) - PAD;
  const top = Math.min(...ys) - PAD;
  return { x: left, y: top, width: Math.max(...xs) + PAD - left, height: Math.max(...ys) + PAD - top };
}

function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

const contains = (outer, inner) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

// ---------------------------------------------------------------------------
// The overlay
// ---------------------------------------------------------------------------
class GuideOverlay {
  /**
   * @param {object} options
   * @param {string} options.url the overlay page (guide.html, from the backend)
   * @param {string} options.preload
   * @param {() => ({x: number, y: number, radius: number} | null)} options.anchor her centre, DIP
   * @param {(event: {action: string}) => void} options.onEvent `hit` or `relocate`
   * @param {(gaze: {x: number, y: number} | null) => void} options.onGaze where she should look (DIP, screen)
   * @param {() => void} options.raise puts her back above the arrow
   */
  constructor({ url, preload, anchor, onEvent, onGaze, raise }) {
    this.url = url;
    this.preload = preload;
    this.anchor = anchor;
    this.onEvent = onEvent;
    this.onGaze = onGaze;
    this.raise = raise;
    /** display id -> BrowserWindow */
    this.windows = new Map();
    /** The step being shown, in DIP: `{target, to, label, step, total, action, kind}`. */
    this.step = null;
    this.timer = null;
    this.lastAnchor = null;
    this.pressed = null;
    this.armed = false;
    this.tracked = null;
    this.changedAt = 0;
    this.lastWindowCheck = 0;
    this.hidden = false;
    this.lastRect = null;
  }

  /** Handles of the overlay windows: never part of "the window in front". */
  handles() {
    return [...this.windows.values()].filter(alive).map((win) => desktop.handleOf(win));
  }

  allWindows() {
    return [...this.windows.values()].filter(alive);
  }

  /** A message from the backend: `{state: 'show' | 'looking' | 'lost' | 'clear', ...}`. */
  handle(message) {
    if (message?.state === 'show' && message.target) this.show(message);
    else if (message?.state === 'looking' || message?.state === 'lost') this.hide(message);
    else this.clear();
  }

  show(message) {
    const target = toDip(message.target);
    if (!target) return;
    const to = message.to ? toDip(message.to) : null;
    const win = message.window ? { hwnd: Number(message.window.hwnd) || 0, rect: toDip(message.window) } : null;
    this.step = {
      target,
      to,
      label: String(message.label ?? '').slice(0, 80),
      step: Number(message.step) || 1,
      total: Number(message.total) || 1,
      action: message.action ?? 'click',
      kind: message.kind ?? 'point',
    };
    this.tracked = win?.hwnd ? { hwnd: win.hwnd, rect: win.rect, offset: { x: 0, y: 0 } } : null;
    this.pressed = null;
    this.armed = false;
    this.hidden = false;
    this.changedAt = 0;
    this.render(true);
    this.start();
  }

  /** Between one step and the next (or when the spot is lost) the arrow goes; the watch stays. */
  hide() {
    this.step = null;
    this.tracked = null;
    for (const win of this.allWindows()) win.hide();
    this.onGaze(null);
    this.start();
  }

  clear() {
    this.step = null;
    this.tracked = null;
    this.stop();
    for (const win of this.allWindows()) win.destroy();
    this.windows.clear();
    this.onGaze(null);
  }

  start() {
    if (!this.timer) this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** The spot and the wire's end, with the window's movement since they were found. */
  current() {
    if (!this.step) return null;
    const dx = this.tracked?.offset.x ?? 0;
    const dy = this.tracked?.offset.y ?? 0;
    const move = (rect) => rect && { ...rect, x: rect.x + dx, y: rect.y + dy };
    return { target: move(this.step.target), to: move(this.step.to) };
  }

  render(animate = false) {
    const spot = this.current();
    const her = this.anchor();
    if (!spot || !her || this.hidden) return;
    this.lastAnchor = her;
    const cord = elbow(her, spot.target, her.radius);
    const wire = spot.to ? boxToBox(spot.target, spot.to, cord) : null;
    const boxes = [spot.target, ...(spot.to ? [spot.to] : [])];
    const area = bounds([...cord, ...(wire ?? [])], boxes);
    const used = new Set();
    for (const display of screen.getAllDisplays()) {
      const part = intersect(area, display.bounds);
      if (!part) continue;
      // Never exactly the whole display: that's what a full-screen app looks like.
      const frame = intersect(part, {
        x: display.bounds.x + 1,
        y: display.bounds.y + 1,
        width: display.bounds.width - 2,
        height: display.bounds.height - 2,
      });
      if (!frame) continue;
      used.add(display.id);
      const win = this.windowFor(display.id, frame);
      const now = win.getBounds();
      // It grows when the arrow no longer fits; it doesn't chase every pixel.
      if (!contains(now, frame) || now.width * now.height > frame.width * frame.height * 2.5) {
        win.setBounds({ x: Math.round(frame.x), y: Math.round(frame.y), width: Math.round(frame.width), height: Math.round(frame.height) });
      }
      const origin = win.getBounds();
      const local = (points) => points.map(([x, y]) => [x - origin.x, y - origin.y]);
      const box = (rect) => rect && { ...rect, x: rect.x - origin.x, y: rect.y - origin.y };
      const payload = {
        width: origin.width,
        height: origin.height,
        cord: local(cord),
        wire: wire ? local(wire) : null,
        target: box(spot.target),
        to: box(spot.to),
        label: this.step.label,
        step: this.step.step,
        total: this.step.total,
        action: this.step.action,
        animate,
      };
      const send = () => {
        if (!alive(win)) return;
        win.webContents.send('guide:draw', payload);
        // Shown only once the page is there: a window still loading could flash.
        if (!win.isVisible() && this.step && !this.hidden) win.showInactive();
      };
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
      else send();
    }
    for (const [id, win] of this.windows) {
      if (!used.has(id) && alive(win)) win.hide();
    }
    this.raise();
    const look = spot.to && this.armed ? spot.to : spot.target;
    this.onGaze({ x: look.x + look.width / 2, y: look.y + look.height / 2 });
  }

  windowFor(id, frame) {
    let win = this.windows.get(id);
    if (alive(win)) return win;
    win = new BrowserWindow({
      x: Math.round(frame.x),
      y: Math.round(frame.y),
      width: Math.round(frame.width),
      height: Math.round(frame.height),
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: this.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        additionalArguments: ['--dc-role=guide'],
        backgroundThrottling: false,
      },
    });
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    // The eye must never see its own arrow.
    win.setContentProtection(true);
    win.loadURL(this.url);
    this.windows.set(id, win);
    return win;
  }

  /** Puts the arrow back on top (Windows reorders the topmost windows), below her. */
  keepOnTop() {
    if (!this.step || this.hidden) return;
    for (const win of this.allWindows()) {
      if (win.isVisible()) desktop.keepOnTop(desktop.handleOf(win));
    }
    this.raise();
  }

  poll() {
    if (!this.step) return;
    const now = Date.now();
    if (now - this.lastWindowCheck >= WINDOW_CHECK_MS) {
      this.lastWindowCheck = now;
      this.followWindow(now);
    }
    if (this.hidden) return;
    const her = this.anchor();
    if (her && (!this.lastAnchor || Math.abs(her.x - this.lastAnchor.x) + Math.abs(her.y - this.lastAnchor.y) > 1.5)) this.render(false);
    this.watchClicks();
  }

  /** The spot's window moved: the arrow follows. Resized or gone: the spot is looked for again. */
  followWindow(now) {
    const tracked = this.tracked;
    if (!tracked) return;
    const rect = desktop.windowRect(tracked.hwnd);
    const same = rect && Math.abs(rect.width - tracked.rect.width) <= 2 && Math.abs(rect.height - tracked.rect.height) <= 2;
    if (same) {
      const offset = { x: rect.x - tracked.rect.x, y: rect.y - tracked.rect.y };
      if (this.hidden) {
        this.hidden = false;
        this.changedAt = 0;
      }
      if (offset.x !== tracked.offset.x || offset.y !== tracked.offset.y) {
        tracked.offset = offset;
        this.render(false);
      }
      return;
    }
    // Resized, minimized or closed: hide, and once it's still ask for the spot again.
    if (!this.hidden) {
      this.hidden = true;
      for (const win of this.allWindows()) win.hide();
      this.changedAt = now;
      this.lastRect = rect;
      return;
    }
    const still = rect && this.lastRect && rect.width === this.lastRect.width && rect.height === this.lastRect.height && rect.x === this.lastRect.x && rect.y === this.lastRect.y;
    this.lastRect = rect;
    if (!still) {
      this.changedAt = now;
      return;
    }
    if (this.changedAt && now - this.changedAt >= SETTLE_MS) {
      this.changedAt = 0;
      this.tracked = null;
      this.onEvent({ action: 'relocate' });
    }
  }

  /**
   * A click on the spot finishes the step. A field is done when, after the
   * click in it, Enter or Tab is pressed; a wire when the drag (or two
   * clicks) goes from A to B.
   */
  watchClicks() {
    const spot = this.current();
    const down = desktop.keyDown(VK.LBUTTON) || desktop.keyDown(VK.RBUTTON);
    const cursor = screen.getCursorScreenPoint();
    if (down && !this.pressed) this.pressed = { ...cursor };
    if (!down && this.pressed) {
      const from = this.pressed;
      this.pressed = null;
      this.released(from, cursor, spot);
    }
    if (this.step.action === 'type' && this.armed && (desktop.keyDown(VK.RETURN) || desktop.keyDown(VK.TAB))) this.hit();
  }

  released(from, to, spot) {
    const onTarget = (point) => inside(point, spot.target, HIT_SLOP);
    if (this.step.kind === 'wire' && spot.to) {
      const onEnd = (point) => inside(point, spot.to, HIT_SLOP);
      if (onTarget(from) && onEnd(to)) return this.hit();
      if (onTarget(from) && onTarget(to)) this.armed = true;
      else if (this.armed && onEnd(to)) this.hit();
      return undefined;
    }
    if (!onTarget(from) || !onTarget(to)) return undefined;
    if (this.step.action === 'type') {
      this.armed = true;
      return undefined;
    }
    return this.hit();
  }

  hit() {
    this.step = null;
    this.tracked = null;
    for (const win of this.allWindows()) win.hide();
    this.onGaze(null);
    this.onEvent({ action: 'hit' });
  }
}

module.exports = { GuideOverlay, glance, elbow, boxToBox };
