/**
 * Ponte sicuro fra le pagine e il processo main.
 *
 * Con contextIsolation attivo le pagine non vedono ne' Node ne' Electron:
 * esponiamo solo i comandi che servono. Lo stesso preload serve le due
 * finestre; `role` dice quale delle due sta girando ('pet' o 'panel').
 */

const { contextBridge, ipcRenderer } = require('electron');

const role = process.argv.find((arg) => arg.startsWith('--dc-role='))?.split('=')[1] ?? 'pet';

/** Iscrizione a un canale del main; restituisce la funzione per disiscriversi. */
function listen(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('companion', {
  isElectron: true,
  role,

  // --- personaggio ------------------------------------------------------
  /**
   * Comunica se il cursore e' sopra un pixel opaco del personaggio: il
   * processo main lo traduce in click-through per pixel. Va chiamata solo
   * quando il valore cambia (ci pensa il renderer).
   */
  setInteractive: (value) => ipcRenderer.send('pet:set-interactive', value),

  /** @returns {Promise<{x: number, y: number}>} posizione della finestra */
  dragStart: () => ipcRenderer.invoke('pet:drag-start'),
  dragMove: (x, y) => ipcRenderer.send('pet:drag-move', { x, y }),
  dragEnd: () => ipcRenderer.invoke('pet:drag-end'),

  /** Dove stanno piedi, seduta e asse del corpo, in frazioni della finestra. */
  setAnchors: (anchors) => ipcRenderer.send('pet:anchors', anchors),
  /** Sedersi, alzarsi o sdraiarsi sulla barra: `'sit' | 'stand' | 'lie' | 'side'`. */
  requestPosture: (posture) => ipcRenderer.invoke('pet:posture', posture),
  /** Rotellina: moltiplica la scala del personaggio. */
  scaleBy: (factor) => ipcRenderer.invoke('pet:scale-by', factor),

  /** Cadute, atterraggi, finestre su cui e' seduta, bordi a cui e' aggrappata. */
  onMotion: (callback) => listen('pet:motion', callback),
  /**
   * Posizione del cursore relativa alla finestra, misurata dal processo main.
   * Serve perche' in click-through la pagina non riceve eventi mouse: senza
   * questo canale non potrebbe accorgersi di quando il cursore torna sopra
   * il personaggio.
   */
  onCursor: (callback) => listen('pet:cursor', callback),
  /** Comandi mandati dal pannello (bocca, azioni, debug...). */
  onCommand: (callback) => listen('pet:command', callback),
  /** Un modello .vrm scelto dal pannello: `{name, data}`. */
  onModel: (callback) => listen('pet:model', callback),
  /** Spotify: `{open, playing, artist, title}`, solo quando cambia. */
  onMusic: (callback) => listen('pet:music', callback),
  /**
   * Presenza: `{idle}` (secondi senza mouse ne' tastiera) ogni 5 s, oppure
   * `{event}` per lock-screen, unlock-screen, suspend, resume.
   */
  onPresence: (callback) => listen('pet:presence', callback),
  /** Notifica di sistema (promemoria scattato, un agente che ha finito). */
  notify: (title, body) => ipcRenderer.send('pet:notify', { title, body }),

  // --- voce -------------------------------------------------------------
  /**
   * Push-to-talk con scorciatoia **globale**: arriva anche quando il
   * companion non ha il fuoco, che e' tutto il punto di un tasto "parla".
   * Il payload e' `{action: 'toggle'}`.
   */
  onPushToTalk: (callback) => listen('voice:push-to-talk', callback),
  /** Cambia il tasto del push-to-talk. @returns {Promise<{ok, key, error}>} */
  setPushToTalkKey: (key) => ipcRenderer.invoke('voice:set-key', key),
  /** Stato del microfono, per l'icona nel tray e per il pannello. */
  setVoiceState: (state) => ipcRenderer.send('voice:state', state),
  onVoiceCommand: (callback) => listen('voice:command', callback),

  // --- pannello ---------------------------------------------------------
  togglePanel: (focus) => ipcRenderer.invoke('panel:toggle', focus),
  openPanel: (focus) => ipcRenderer.invoke('panel:open', focus),
  hidePanel: () => ipcRenderer.invoke('panel:hide'),
  /** Il pannello dice quale scheda mostra: i dock evidenziano quella. */
  setPanelTab: (tab) => ipcRenderer.send('panel:tab', tab),
  /** @returns {Promise<object>} scala, primo piano, fantasma, aggancio... */
  getState: () => ipcRenderer.invoke('panel:state'),
  onState: (callback) => listen('panel:state', callback),
  onPetState: (callback) => listen('pet:state', callback),
  /** Il main chiede al pannello di mostrare una scheda (e magari del testo). */
  onFocus: (callback) => listen('panel:focus', callback),

  sendToPet: (command) => ipcRenderer.send('pet:command', command),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('pet:toggle-always-on-top'),
  toggleGhost: () => ipcRenderer.invoke('pet:toggle-ghost'),
  setScale: (value) => ipcRenderer.invoke('pet:set-scale', value),
  setWindows: (value) => ipcRenderer.invoke('pet:set-windows', value),
  setDocked: (value) => ipcRenderer.invoke('panel:set-docked', value),
  setPanelPinned: (value) => ipcRenderer.invoke('panel:set-pinned', value),
  pickModel: () => ipcRenderer.invoke('pet:pick-model'),
  quit: () => ipcRenderer.invoke('app:quit'),
});
