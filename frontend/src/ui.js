/**
 * The DOM of the character's window, in one place.
 *
 * The interface is meant to be almost invisible, desktop-mascot style:
 * normally you only see her. Right-click opens the menu island (island.js),
 * chat and settings live in the separate panel, the indicators show up only
 * when something is wrong.
 *
 * `main.js` never touches the elements directly: it calls this class's
 * methods and registers the callbacks (`onSend`, `onContextMenu`, ...).
 */

import { VISEME_KEYS } from './config.js';
import { iconSvg } from './icons.js';

const $ = (id) => document.getElementById(id);

export class UI {
  constructor() {
    this.elements = {
      stage: $('stage'),
      bubble: $('bubble'),
      toast: $('toast'),
      composer: $('composer'),
      input: $('input'),
      send: $('btn-send'),
      overlay: $('overlay'),
      overlayText: $('overlay-text'),
      overlayHint: $('overlay-hint'),
      debug: $('debug'),
      dbgViseme: $('dbg-viseme'),
      dbgRms: $('dbg-rms'),
      dbgFps: $('dbg-fps'),
    };
    this.elements.send.innerHTML = iconSvg('send', 16);

    this.bars = new Map();
    document.querySelectorAll('.bar i[data-viseme]').forEach((bar) => {
      this.bars.set(bar.dataset.viseme, bar);
    });

    // Callbacks set by main.js.
    this.onSend = () => {};
    this.onStop = () => {};
    /** Right-click: opens/closes the menu. */
    this.onContextMenu = () => {};
    /** Double click or starting to type: opens the chat (with the first key inside). */
    this.onOpenChat = null;
    /** Esc: the first open piece of interface closes, otherwise she goes quiet. */
    this.onEscape = () => false;

    this._bubbleTimer = null;
    this._toastTimer = null;

    this._bindEvents();
  }

  _bindEvents() {
    const { elements } = this;

    elements.composer.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = elements.input.value.trim();
      if (!text) return;
      elements.input.value = '';
      this.onSend(text);
    });

    window.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.onContextMenu(event.clientX, event.clientY);
    });

    // A file dropped outside her must not open in the window (main.js feeds her the ones dropped on her).
    window.addEventListener('dragover', (event) => event.preventDefault());
    window.addEventListener('drop', (event) => event.preventDefault());

    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (this.onEscape()) return;
        if (!elements.composer.classList.contains('hidden')) this.closeComposer();
        else this.onStop();
        return;
      }
      // Just start typing to open the chat.
      const typing = document.activeElement === elements.input;
      if (!typing && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (this.onOpenChat) {
          this.onOpenChat(event.key);
          return;
        }
        this.openComposer();
        elements.input.value = event.key;
      }
    });

    elements.stage.addEventListener('dblclick', () => {
      if (this.onOpenChat) this.onOpenChat('');
      else this.openComposer();
    });
  }

  // -------------------------------------------------------------- composer
  openComposer() {
    this.elements.composer.classList.remove('hidden');
    this.elements.input.focus();
  }

  closeComposer() {
    this.elements.composer.classList.add('hidden');
    this.elements.input.value = '';
  }

  // ---------------------------------------------------------------- bubble
  showBubble(text, durationMs = 4200) {
    const { bubble } = this.elements;
    bubble.textContent = text;
    bubble.classList.remove('hidden');
    clearTimeout(this._bubbleTimer);
    this._bubbleTimer = setTimeout(() => bubble.classList.add('hidden'), durationMs);
  }

  hideBubble() {
    clearTimeout(this._bubbleTimer);
    this.elements.bubble.classList.add('hidden');
  }

  // ----------------------------------------------------------------- toast
  toast(text, isError = false, durationMs = 4000) {
    if (!text) return;
    const { toast } = this.elements;
    toast.textContent = text;
    toast.classList.toggle('error', isError);
    toast.classList.remove('hidden');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => toast.classList.add('hidden'), durationMs);
  }

  // --------------------------------------------------------------- overlay
  showOverlay(text, hint = '', isError = false) {
    this.elements.overlayText.textContent = text;
    this.elements.overlayHint.textContent = hint;
    this.elements.overlay.classList.toggle('error', isError);
    this.elements.overlay.classList.remove('hidden');
  }

  hideOverlay() {
    this.elements.overlay.classList.add('hidden');
  }

  get overlayOpen() {
    return !this.elements.overlay.classList.contains('hidden');
  }

  // ----------------------------------------------------------------- debug
  setDebugVisible(visible) {
    this.elements.debug.classList.toggle('hidden', !visible);
  }

  updateDebug({ viseme, level, fps, weights }) {
    if (this.elements.debug.classList.contains('hidden')) return;
    this.elements.dbgViseme.textContent = viseme;
    this.elements.dbgRms.textContent = level.toFixed(2);
    this.elements.dbgFps.textContent = String(fps);
    for (const key of VISEME_KEYS) {
      const bar = this.bars.get(key);
      if (bar) bar.style.height = `${Math.max(2, (weights[key] ?? 0) * 100)}%`;
    }
  }

  /**
   * Is the cursor over a "solid" element of the interface?
   * Needed by per-pixel click-through: menus, bubbles and panels must stay
   * clickable even where the character isn't.
   */
  isOverSolidUI(x, y) {
    const element = document.elementFromPoint(x, y);
    return Boolean(element?.closest('[data-solid]'));
  }
}
