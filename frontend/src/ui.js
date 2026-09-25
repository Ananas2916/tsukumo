/**
 * Il DOM della finestra del personaggio, in un posto solo.
 *
 * L'interfaccia e' volutamente quasi invisibile, in stile mascotte da
 * scrivania: normalmente si vede solo lei. Il tasto destro apre i dock ai
 * suoi lati (hud.js), la chat e le impostazioni stanno nel pannello a parte,
 * le spie si fanno vedere solo quando qualcosa non va.
 *
 * `main.js` non tocca mai direttamente gli elementi: chiama i metodi di questa
 * classe e registra i callback (`onSend`, `onContextMenu`, ...).
 */

import { VISEME_KEYS } from './config.js';
import { iconSvg } from './icons.js';

const $ = (id) => document.getElementById(id);

export class UI {
  constructor() {
    this.elements = {
      stage: $('stage'),
      hud: $('hud'),
      bubble: $('bubble'),
      toast: $('toast'),
      composer: $('composer'),
      input: $('input'),
      send: $('btn-send'),
      fileInput: $('file-vrm'),
      overlay: $('overlay'),
      overlayText: $('overlay-text'),
      overlayHint: $('overlay-hint'),
      debug: $('debug'),
      dbgViseme: $('dbg-viseme'),
      dbgRms: $('dbg-rms'),
      dbgFps: $('dbg-fps'),
      dbgDriver: $('dbg-driver'),
    };
    this.elements.send.innerHTML = iconSvg('send', 16);

    this.bars = new Map();
    document.querySelectorAll('.bar i[data-viseme]').forEach((bar) => {
      this.bars.set(bar.dataset.viseme, bar);
    });

    // Callback impostati da main.js.
    this.onSend = () => {};
    this.onStop = () => {};
    this.onModelFile = () => {};
    /** Tasto destro: apre/chiude i dock. */
    this.onContextMenu = () => {};
    /** Doppio click o iniziare a scrivere: apre la chat (col primo tasto dentro). */
    this.onOpenChat = null;
    /** Esc: il primo pezzo di interfaccia aperto si chiude, altrimenti zitta. */
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

    elements.fileInput.addEventListener('change', (event) => {
      const file = event.target.files?.[0];
      if (file) this.onModelFile(file);
      event.target.value = '';
    });

    // Trascina un .vrm sulla finestra per caricarlo al volo.
    window.addEventListener('dragover', (event) => event.preventDefault());
    window.addEventListener('drop', (event) => {
      event.preventDefault();
      const file = [...(event.dataTransfer?.files ?? [])].find((f) => f.name.toLowerCase().endsWith('.vrm'));
      if (file) this.onModelFile(file);
    });

    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (this.onEscape()) return;
        if (!elements.composer.classList.contains('hidden')) this.closeComposer();
        else this.onStop();
        return;
      }
      // Basta iniziare a scrivere per aprire la chat.
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

  pickModel() {
    this.elements.fileInput.click();
  }

  // ----------------------------------------------------------------- bolla
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

  updateDebug({ viseme, level, fps, weights, driver }) {
    if (this.elements.debug.classList.contains('hidden')) return;
    this.elements.dbgViseme.textContent = viseme;
    this.elements.dbgRms.textContent = level.toFixed(2);
    this.elements.dbgFps.textContent = String(fps);
    if (driver) this.elements.dbgDriver.textContent = driver;
    for (const key of VISEME_KEYS) {
      const bar = this.bars.get(key);
      if (bar) bar.style.height = `${Math.max(2, (weights[key] ?? 0) * 100)}%`;
    }
  }

  /**
   * Il cursore e' sopra un elemento "solido" dell'interfaccia?
   * Serve al click-through per pixel: dock, bolle e pannelli devono restare
   * cliccabili anche dove il personaggio non c'e'.
   */
  isOverSolidUI(x, y) {
    const element = document.elementFromPoint(x, y);
    return Boolean(element?.closest('[data-solid]'));
  }
}
