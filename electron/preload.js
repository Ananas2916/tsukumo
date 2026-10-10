/**
 * Safe bridge between the pages and the main process.
 *
 * With contextIsolation on the pages see neither Node nor Electron: we
 * expose only the commands they need. The same preload serves every window;
 * `role` says which one is running ('pet', 'panel' or 'dashboard').
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const role = process.argv.find((arg) => arg.startsWith('--dc-role='))?.split('=')[1] ?? 'pet';

/** Subscribes to a main channel; returns the function that unsubscribes. */
function listen(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('companion', {
  isElectron: true,
  role,

  // --- files and screen -------------------------------------------------------
  /** Real path of a dropped file (Electron 32 removed `File.path`). */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
  /** Screenshot of the screen the cursor is on: returns the PNG's path. */
  captureScreen: () => ipcRenderer.invoke('pet:capture-screen'),

  // --- Tsukumo ---------------------------------------------------------------
  /**
   * Says whether the cursor is over an opaque pixel of her: the
   * main process turns it into per-pixel click-through. Call it only when the
   * value changes (the renderer takes care of it).
   */
  setInteractive: (value) => ipcRenderer.send('pet:set-interactive', value),

  /** @returns {Promise<{x: number, y: number}>} position of the window */
  dragStart: () => ipcRenderer.invoke('pet:drag-start'),
  dragMove: (x, y) => ipcRenderer.send('pet:drag-move', { x, y }),
  /** `velocity` `{vx, vy}` in px/s if you threw her, otherwise null. */
  dragEnd: (velocity = null) => ipcRenderer.invoke('pet:drag-end', velocity),
  /**
   * Moving the open island (by its black): the window goes with the cursor
   * through dragMove and, let go, stays there while the island is open.
   * @returns {Promise<{x: number, y: number} | null>} position of the window
   */
  islandDragStart: () => ipcRenderer.invoke('pet:island-drag-start'),
  islandDragEnd: () => ipcRenderer.invoke('pet:island-drag-end'),

  /** Where she rests and her axis, as fractions of the window. */
  setAnchors: (anchors) => ipcRenderer.send('pet:anchors', anchors),
  /** Her sprint along the taskbar: `'dash' | 'lap'` or nothing (random). False if she can't. */
  sprint: (kind) => ipcRenderer.invoke('pet:sprint', kind),
  /** The menu island open or closed: the window widens around her. `{wide, shift}`. */
  setIslandWide: (open) => ipcRenderer.invoke('pet:island', Boolean(open)),
  /** How many pixels right of the window's centre she is (the island widened it on one side). */
  onFrameShift: (callback) => listen('pet:frame-shift', callback),
  /** The interface's language ('en' or 'it'): the tray menu and the dialogs follow it. */
  setLanguage: (language) => ipcRenderer.send('app:language', String(language)),
  /** Wheel: multiplies her scale. */
  scaleBy: (factor) => ipcRenderer.invoke('pet:scale-by', factor),

  /** Falls, landings, throws, windows she sits on, sprints. */
  onMotion: (callback) => listen('pet:motion', callback),
  /**
   * Cursor position relative to the window, measured by the main process.
   * Needed because in click-through the page receives no mouse events:
   * without this channel it couldn't notice when the cursor comes back over
   * her.
   */
  onCursor: (callback) => listen('pet:cursor', callback),
  /** Commands sent by the panel (mouth, actions, debug...). */
  onCommand: (callback) => listen('pet:command', callback),
  /** Spotify: `{open, playing, artist, title}`, only when it changes. */
  onMusic: (callback) => listen('pet:music', callback),
  /**
   * Presence: `{idle}` (seconds without mouse or keyboard) every 5 s, or
   * `{event}` for lock-screen, unlock-screen, suspend, resume.
   */
  onPresence: (callback) => listen('pet:presence', callback),
  /** System notification (a reminder went off, an agent is done). */
  notify: (title, body) => ipcRenderer.send('pet:notify', { title, body }),

  // --- voice -------------------------------------------------------------
  /**
   * Push-to-talk with a **global** shortcut: it arrives even when the
   * companion doesn't have focus, which is the whole point of a "talk" key.
   * The payload is `{action: 'toggle'}`.
   */
  onPushToTalk: (callback) => listen('voice:push-to-talk', callback),
  /** Changes the push-to-talk key. @returns {Promise<{ok, key, error}>} */
  setPushToTalkKey: (key) => ipcRenderer.invoke('voice:set-key', key),
  /** Microphone state, for the tray icon and the panel. */
  setVoiceState: (state) => ipcRenderer.send('voice:state', state),
  onVoiceCommand: (callback) => listen('voice:command', callback),

  // --- panel ---------------------------------------------------------------
  togglePanel: (focus) => ipcRenderer.invoke('panel:toggle', focus),
  openPanel: (focus) => ipcRenderer.invoke('panel:open', focus),
  hidePanel: () => ipcRenderer.invoke('panel:hide'),
  /** The panel says which tab it shows: the island highlights that one. */
  setPanelTab: (tab) => ipcRenderer.send('panel:tab', tab),
  /** @returns {Promise<object>} scale, always on top, ghost, docking... */
  getState: () => ipcRenderer.invoke('panel:state'),
  onState: (callback) => listen('panel:state', callback),
  onPetState: (callback) => listen('pet:state', callback),
  /** The main process asks the panel to show a tab (and maybe some text). */
  onFocus: (callback) => listen('panel:focus', callback),

  sendToPet: (command) => ipcRenderer.send('pet:command', command),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('pet:toggle-always-on-top'),
  toggleGhost: () => ipcRenderer.invoke('pet:toggle-ghost'),
  setScale: (value) => ipcRenderer.invoke('pet:set-scale', value),
  setWindows: (value) => ipcRenderer.invoke('pet:set-windows', value),
  setDocked: (value) => ipcRenderer.invoke('panel:set-docked', value),
  setPanelPinned: (value) => ipcRenderer.invoke('panel:set-pinned', value),

  // --- dashboard -------------------------------------------------------------
  openDashboard: () => ipcRenderer.invoke('dashboard:open'),
  /** "−": the dashboard closes and she goes back to the desktop. */
  minimizeDashboard: () => ipcRenderer.invoke('dashboard:minimize'),
  toggleMaximizeDashboard: () => ipcRenderer.invoke('dashboard:toggle-maximize'),
  /** At startup: 'dashboard' or 'companion'. */
  setStartWith: (value) => ipcRenderer.invoke('dashboard:start-with', value),
  /** Where she is in the dashboard: `{x, y, width, height}` in page pixels. */
  setDashboardStage: (rect) => ipcRenderer.send('dashboard:stage', rect),
  quit: () => ipcRenderer.invoke('app:quit'),
});
