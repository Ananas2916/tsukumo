/**
 * Tutto il DOM in un posto solo.
 *
 * L'interfaccia e' volutamente quasi invisibile, in stile mascotte da
 * scrivania: normalmente si vede solo il personaggio. I controlli stanno nel
 * menu del tasto destro, la casella di testo compare su richiesta, e le spie
 * di stato si mostrano da sole solo quando cambia qualcosa.
 *
 * `main.js` non tocca mai direttamente gli elementi: chiama i metodi di questa
 * classe e registra i callback (`onSend`, `onSay`, ...).
 */

import { VISEME_KEYS } from './config.js';

const $ = (id) => document.getElementById(id);

export class UI {
  constructor() {
    this.elements = {
      stage: $('stage'),
      bubble: $('bubble'),
      statusStack: $('status-stack'),
      status: $('status'),
      openclaw: $('openclaw'),
      toast: $('toast'),
      composer: $('composer'),
      input: $('input'),
      send: $('btn-send'),
      closeComposer: $('btn-close-composer'),
      menu: $('menu'),
      voice: $('voice'),
      gain: $('gain'),
      gainValue: $('gain-value'),
      toggleTop: $('toggle-top'),
      toggleGhost: $('toggle-ghost'),
      toggleBg: $('toggle-bg'),
      toggleDebug: $('toggle-debug'),
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

    this.bars = new Map();
    document.querySelectorAll('.bar i[data-viseme]').forEach((bar) => {
      this.bars.set(bar.dataset.viseme, bar);
    });

    // Callback impostati da main.js.
    this.onSend = () => {};
    this.onSay = () => {};
    this.onStop = () => {};
    this.onReset = () => {};
    this.onModelFile = () => {};
    this.onGainChange = () => {};
    this.onVoiceChange = () => {};
    this.onBackgroundChange = () => {};
    this.onAlwaysOnTopChange = () => {};
    this.onGhostChange = () => {};
    this.onQuit = () => {};
    /**
     * In Electron menu e chat stanno nel pannello staccato: se questi due
     * sono impostati, tasto destro e doppio click (o iniziare a scrivere)
     * chiamano loro invece di aprire il menu e la casella dentro la pagina.
     */
    this.onContextMenu = null;
    this.onOpenChat = null;

    /** In modalita' "leggi" il testo va pronunciato senza passare dall'LLM. */
    this._composerMode = 'chat';
    this._bubbleTimer = null;
    this._toastTimer = null;
    this._statusTimer = null;

    this._bindEvents();
  }

  _bindEvents() {
    const { elements } = this;

    // --- casella di testo ---------------------------------------------
    elements.composer.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = elements.input.value.trim();
      if (!text) return;
      elements.input.value = '';
      if (this._composerMode === 'say') this.onSay(text);
      else this.onSend(text);
    });

    elements.closeComposer.addEventListener('click', () => this.closeComposer());

    // --- menu del tasto destro ----------------------------------------
    window.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      if (this.onContextMenu) this.onContextMenu();
      else this.openMenu(event.clientX, event.clientY);
    });

    elements.menu.addEventListener('click', (event) => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (!action) return;
      this.closeMenu();
      this._runAction(action);
    });

    // Un click fuori chiude menu e casella di testo.
    window.addEventListener('pointerdown', (event) => {
      if (!elements.menu.classList.contains('hidden') && !elements.menu.contains(event.target)) {
        this.closeMenu();
      }
    });

    // --- interruttori --------------------------------------------------
    elements.gain.addEventListener('input', () => {
      const value = Number(elements.gain.value);
      elements.gainValue.textContent = value.toFixed(2);
      this.onGainChange(value);
    });

    elements.voice.addEventListener('change', () => this.onVoiceChange(elements.voice.value));

    elements.toggleBg.addEventListener('change', () => {
      document.body.classList.toggle('opaque-bg', elements.toggleBg.checked);
      this.onBackgroundChange(elements.toggleBg.checked);
    });

    elements.toggleDebug.addEventListener('change', () => {
      elements.debug.classList.toggle('hidden', !elements.toggleDebug.checked);
    });

    elements.toggleTop.addEventListener('change', () =>
      this.onAlwaysOnTopChange(elements.toggleTop.checked),
    );
    elements.toggleGhost.addEventListener('change', () =>
      this.onGhostChange(elements.toggleGhost.checked),
    );

    elements.fileInput.addEventListener('change', (event) => {
      const file = event.target.files?.[0];
      if (file) this.onModelFile(file);
      event.target.value = '';
    });

    // Trascina un .vrm sulla finestra per caricarlo al volo.
    window.addEventListener('dragover', (event) => event.preventDefault());
    window.addEventListener('drop', (event) => {
      event.preventDefault();
      const file = [...(event.dataTransfer?.files ?? [])].find((f) =>
        f.name.toLowerCase().endsWith('.vrm'),
      );
      if (file) this.onModelFile(file);
    });

    // --- scorciatoie ----------------------------------------------------
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (!elements.menu.classList.contains('hidden')) this.closeMenu();
        else if (!elements.composer.classList.contains('hidden')) this.closeComposer();
        else this.onStop();
        return;
      }
      // Basta iniziare a scrivere per aprire la casella di testo.
      const typing = document.activeElement === elements.input;
      if (!typing && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (this.onOpenChat) {
          this.onOpenChat(event.key);
          return;
        }
        this.openComposer('chat');
        elements.input.value = event.key;
      }
    });

    // Doppio click sul personaggio: apre la casella di testo.
    elements.stage.addEventListener('dblclick', () => {
      if (this.onOpenChat) this.onOpenChat('');
      else this.openComposer('chat');
    });
  }

  _runAction(action) {
    switch (action) {
      case 'talk':
        this.openComposer('chat');
        break;
      case 'say':
        this.openComposer('say');
        break;
      case 'stop':
        this.onStop();
        break;
      case 'model':
        this.elements.fileInput.click();
        break;
      case 'reset':
        this.onReset();
        break;
      case 'quit':
        this.onQuit();
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------------ menu
  openMenu(x, y) {
    const { menu } = this.elements;
    menu.classList.remove('hidden');
    // Prima lo mostriamo, poi lo riposizioniamo: senza dimensioni reali non
    // sapremmo se esce dai bordi della finestra.
    const rect = menu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 6);
    const top = Math.min(y, window.innerHeight - rect.height - 6);
    menu.style.left = `${Math.max(6, left)}px`;
    menu.style.top = `${Math.max(6, top)}px`;
  }

  closeMenu() {
    this.elements.menu.classList.add('hidden');
  }

  get menuOpen() {
    return !this.elements.menu.classList.contains('hidden');
  }

  // -------------------------------------------------------------- composer
  /** @param {'chat'|'say'} mode */
  openComposer(mode = 'chat') {
    this._composerMode = mode;
    const { composer, input } = this.elements;
    composer.classList.remove('hidden');
    input.placeholder = mode === 'say' ? 'Testo da pronunciare...' : 'Scrivi qualcosa...';
    input.focus();
  }

  closeComposer() {
    this.elements.composer.classList.add('hidden');
    this.elements.input.value = '';
  }

  get composerOpen() {
    return !this.elements.composer.classList.contains('hidden');
  }

  setBusy(busy) {
    this.elements.send.disabled = busy;
  }

  // ------------------------------------------------------------------ stato
  /** @param {'offline'|'online'|'thinking'|'speaking'|'error'} state */
  setStatus(state, text) {
    this.elements.status.dataset.state = state;
    this.elements.status.title = text;
    // Le spie si fanno vedere solo quando succede qualcosa, poi svaniscono.
    this._flashStatus(state === 'offline' || state === 'error');
  }

  /**
   * Spia del Gateway OpenClaw: verde se risponde, rosso se e' spento,
   * giallo se risponde ma non si dichiara pronto.
   */
  setOpenClaw(status) {
    const { openclaw } = this.elements;
    if (!status || status.state === 'disabled') {
      openclaw.classList.add('hidden');
      return;
    }

    const state = status.state ?? 'unknown';
    const previous = openclaw.dataset.state;
    openclaw.classList.remove('hidden');
    openclaw.dataset.state = state;

    const labels = {
      online: 'OpenClaw connesso',
      degraded: 'OpenClaw non pronto',
      offline: 'OpenClaw disconnesso',
      unknown: 'OpenClaw: stato sconosciuto',
    };
    const detail = [status.url, status.version ? `v${status.version}` : null, status.error]
      .filter(Boolean)
      .join(' - ');
    openclaw.title = `${labels[state] ?? labels.unknown}\n${detail}`;

    if (previous !== state) this._flashStatus(state === 'offline');
  }

  /** Mostra le spie per qualche secondo (o le lascia fisse se c'e' un problema). */
  _flashStatus(persistent = false) {
    const { statusStack } = this.elements;
    statusStack.classList.add('visible');
    clearTimeout(this._statusTimer);
    if (persistent) return;
    this._statusTimer = setTimeout(() => statusStack.classList.remove('visible'), 2600);
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
    this.elements.overlayHint.innerHTML = hint;
    this.elements.overlay.classList.toggle('error', isError);
    this.elements.overlay.classList.remove('hidden');
  }

  hideOverlay() {
    this.elements.overlay.classList.add('hidden');
  }

  get overlayOpen() {
    return !this.elements.overlay.classList.contains('hidden');
  }

  // ------------------------------------------------------------------ voci
  setVoices(voices, current) {
    const select = this.elements.voice;
    select.replaceChildren();
    for (const voice of voices) {
      const option = document.createElement('option');
      option.value = voice;
      option.textContent = voice;
      select.appendChild(option);
    }
    if (current && voices.includes(current)) select.value = current;
  }

  get voice() {
    return this.elements.voice.value || null;
  }

  setGain(value) {
    this.elements.gain.value = String(value);
    this.elements.gainValue.textContent = Number(value).toFixed(2);
  }

  // ----------------------------------------------------------------- debug
  setDebugVisible(visible) {
    this.elements.toggleDebug.checked = visible;
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
   * Serve al click-through per pixel: menu, casella di testo e pannelli
   * devono restare cliccabili anche dove il personaggio non c'e'.
   */
  isOverSolidUI(x, y) {
    const element = document.elementFromPoint(x, y);
    return Boolean(element?.closest('[data-solid]'));
  }
}
