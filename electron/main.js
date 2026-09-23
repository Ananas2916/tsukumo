/**
 * Shell Electron del Desk Companion, in stile Desktop Mate.
 *
 * Due finestre:
 *  - il personaggio: senza cornice, trasparente, sempre davanti a tutto, che
 *    lascia passare il mouse ovunque tranne dove c'e' davvero disegnato;
 *  - il pannello: chat e impostazioni, staccato dal personaggio. Puo' stare
 *    agganciato al suo fianco e seguirla, oppure libero dove lo metti.
 *
 * E in mezzo la vita da mascotte (vedi pet-physics.js): se la molli a
 * mezz'aria cade, si siede sul bordo delle finestre e viaggia con loro, sta
 * sulla barra delle applicazioni, si aggrappa ai bordi dello schermo. La
 * rotellina la ingrandisce: cambia la finestra, non la camera.
 *
 * Il click-through e' "per pixel": il renderer legge l'alpha del pixel sotto
 * il cursore dal framebuffer WebGL e ci dice se e' sopra il personaggio; qui
 * traduciamo quel booleano in setIgnoreMouseEvents.
 */

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  shell,
} = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');

const desktop = require('./desktop');
const { PetPhysics } = require('./pet-physics');
const spotify = require('./spotify');

const PROJECT_ROOT = path.resolve(__dirname, '..');

// Avviata dal collegamento sul desktop non c'e' nessun terminale dove
// guardare, e su Windows un'app GUI non scrive nemmeno su uno stdout
// rediretto: se ci danno un file, i messaggi finiscono li'.
if (process.env.DC_LOG_FILE) {
  const stream = fs.createWriteStream(process.env.DC_LOG_FILE, { flags: 'a' });
  const write =
    (prefix) =>
    (...args) =>
      stream.write(`${new Date().toISOString()} ${prefix}${args.join(' ')}\n`);
  console.log = write('');
  console.error = write('ERRORE ');
  process.on('uncaughtException', (error) => console.error(error.stack ?? String(error)));
}
const HOST = process.env.DC_HOST || '127.0.0.1';
const PORT = Number(process.env.DC_PORT || 8770);
const BACKEND_URL = `http://${HOST}:${PORT}`;
const SPAWN_BACKEND = process.env.DC_NO_SPAWN !== '1';

/**
 * Il Python del virtualenv del progetto, se c'e': quello di sistema di solito
 * non ha FastAPI e Kokoro, e il backend morirebbe all'avvio.
 */
function pythonExecutable() {
  if (process.env.DC_PYTHON) return process.env.DC_PYTHON;
  const venv = path.join(PROJECT_ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (fs.existsSync(venv)) return venv;
  return process.platform === 'win32' ? 'python' : 'python3';
}
const PYTHON = pythonExecutable();

// Dimensioni della finestra-mascotte a scala 1: stretta e alta, come una figura in piedi.
const BASE_WIDTH = Number(process.env.DC_PET_WIDTH || 300);
const BASE_HEIGHT = Number(process.env.DC_PET_HEIGHT || 460);
const SCALE_RANGE = [0.5, 2.6];
/** Sdraiata sul fianco e' lunga quanto e' alta in piedi: la finestra diventa quadrata. */
const SIDE_ASPECT = 1;
/** Rialzandosi resta orizzontale per un attimo: la finestra si restringe dopo. */
const SIDE_EXIT_MS = 1000;
const MUSIC_POLL_MS = 1500;

const PANEL_SIZE = { width: 380, height: 560 };
const PANEL_GAP = 10;

const TICK_MS = 16; // ~60 fps: cadute e viaggi sulle finestre devono essere fluidi
const WINDOWS_REFRESH_MS = 250;
const ON_TOP_MS = 1000;

let petWindow = null;
let panelWindow = null;
let backendProcess = null;

/** Modalita' fantasma manuale: ignora tutto, anche il personaggio. */
let ghostMode = false;
/** Ultimo stato di click-through applicato, per non chiamare l'API a vuoto. */
let interactive = null;
let petHandle = null;
let panelHandle = null;
let windowsCache = [];
let windowsCacheAt = 0;
let lastPetBounds = null;
/** Finestra larga per la posa sdraiata sul fianco. */
let petWide = false;
let narrowSince = null;
/** Ultimo stato di Spotify mandato alle pagine. */
let music = { open: false, playing: false, artist: '', title: '' };

// ---------------------------------------------------------------------------
// Impostazioni che sopravvivono ai riavvii
// ---------------------------------------------------------------------------
const settingsPath = () => path.join(app.getPath('userData'), 'pet-settings.json');
const settings = {
  scale: 1,
  pinned: true,
  windows: true,
  docked: true,
  panelPinned: false,
  panelBounds: null,
};

function loadSettings() {
  try {
    Object.assign(settings, JSON.parse(fs.readFileSync(settingsPath(), 'utf8')));
  } catch {
    /* primo avvio: restano i default */
  }
  settings.scale = clamp(Number(settings.scale) || 1, ...SCALE_RANGE);
}

let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
      fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
    } catch (error) {
      console.error('[electron] impostazioni non salvate:', error.message);
    }
  }, 300);
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const alive = (win) => win && !win.isDestroyed();

// ---------------------------------------------------------------------------
// Backend Python
// ---------------------------------------------------------------------------
function startBackend() {
  if (!SPAWN_BACKEND) {
    console.log('[electron] DC_NO_SPAWN=1: uso un backend gia in esecuzione');
    return;
  }

  console.log(`[electron] avvio backend: ${PYTHON} -m backend`);
  backendProcess = spawn(PYTHON, ['-m', 'backend', '--host', HOST, '--port', String(PORT)], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Avviata dal collegamento sul desktop non c'e' un terminale: senza
    // questo Windows aprirebbe una console nera per python.exe.
    windowsHide: true,
  });

  backendProcess.stdout.on('data', (chunk) => console.log(`[py] ${String(chunk).trimEnd()}`));
  backendProcess.stderr.on('data', (chunk) => console.log(`[py] ${String(chunk).trimEnd()}`));

  backendProcess.on('error', (error) => {
    console.error(`[electron] impossibile avviare "${PYTHON}":`, error.message);
  });

  backendProcess.on('exit', (code) => {
    backendProcess = null;
    if (code !== 0 && code !== null) {
      console.error(`[electron] il backend e uscito con codice ${code}`);
    }
  });
}

function stopBackend() {
  if (!backendProcess) return;
  const pid = backendProcess.pid;
  console.log(`[electron] arresto backend (pid ${pid})`);

  if (process.platform === 'win32' && pid) {
    // Su Windows child.kill() lascia spesso vivo il processo Python: resta
    // appeso con Kokoro in memoria e tiene occupata la porta, cosi' al
    // riavvio successivo il nuovo backend non riesce piu' ad ascoltare.
    // taskkill /T /F chiude l'intero albero di processi.
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch (error) {
      console.error('[electron] taskkill fallito:', error.message);
      backendProcess.kill();
    }
  } else {
    backendProcess.kill();
  }

  backendProcess = null;
}

/** Interroga /api/health finche' non risponde (o finche' scade il tempo). */
function waitForBackend(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve) => {
    const attempt = () => {
      const request = http.get(`${BACKEND_URL}/api/health`, (response) => {
        response.resume();
        if (response.statusCode === 200) return resolve(true);
        retry();
      });
      request.setTimeout(2000, () => {
        request.destroy();
        retry();
      });
      request.on('error', retry);
    };

    const retry = () => {
      if (Date.now() > deadline) return resolve(false);
      setTimeout(attempt, 500);
    };

    attempt();
  });
}

// ---------------------------------------------------------------------------
// Finestra del personaggio
// ---------------------------------------------------------------------------
const petSize = () => {
  const height = Math.round(BASE_HEIGHT * settings.scale);
  const width = petWide ? Math.round(height * SIDE_ASPECT) : Math.round(BASE_WIDTH * settings.scale);
  return { width, height };
};

function createPetWindow() {
  // Partenza: in basso a destra dell'area utile, in piedi sulla barra.
  const area = screen.getPrimaryDisplay().workArea;
  const { width, height } = petSize();

  petWindow = new BrowserWindow({
    width,
    height,
    x: area.x + area.width - width - 40,
    y: area.y + area.height - height,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: settings.pinned,
    skipTaskbar: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    title: 'Desk Companion',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: ['--dc-role=pet'],
      // La finestra e' quasi sempre in click-through, quindi spesso non
      // riceve il "gesto dell'utente" che Chromium pretende per sbloccare
      // l'audio: senza questo la voce resterebbe muta.
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
    },
  });

  if (settings.pinned) petWindow.setAlwaysOnTop(true, 'screen-saver');
  petHandle = desktop.handleOf(petWindow);
  const pageUrl = process.env.DC_PET_DEBUG === '1' ? `${BACKEND_URL}/?petdebug` : BACKEND_URL;
  petWindow.loadURL(pageUrl);

  // I link esterni vanno nel browser di sistema, non dentro la finestra.
  petWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // I console.log della pagina finiscono nel terminale: senza questo, in una
  // finestra senza DevTools aperti il renderer e' una scatola nera.
  petWindow.webContents.on('console-message', (_event, level, message) => {
    if (message.startsWith('[pet]') || level >= 2) console.log(`[renderer] ${message}`);
  });

  petWindow.on('closed', () => {
    petWindow = null;
    app.quit();
  });

  if (process.env.DC_DEVTOOLS === '1') {
    petWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

/** Applica il click-through solo quando lo stato cambia davvero. */
function applyInteractive(next) {
  if (!alive(petWindow)) return;
  const wanted = ghostMode ? false : next;
  if (wanted === interactive) return;
  interactive = wanted;
  if (process.env.DC_PET_DEBUG === '1') {
    console.log(`[pet-main] finestra ora ${wanted ? 'SOLIDA (intercetta i click)' : 'trasparente ai click'}`);
  }
  // forward: true continua a consegnare il movimento del mouse alla pagina
  // anche mentre i click passano attraverso: serve per accorgersi di quando
  // il cursore torna sopra il personaggio (e per lo sguardo che lo segue).
  petWindow.setIgnoreMouseEvents(!wanted, { forward: true });
}

function sendToPet(channel, payload) {
  if (alive(petWindow)) petWindow.webContents.send(channel, payload);
}

function sendToPanel(channel, payload) {
  if (alive(panelWindow)) panelWindow.webContents.send(channel, payload);
}

// ---------------------------------------------------------------------------
// Fisica: pavimento, finestre, bordi
// ---------------------------------------------------------------------------
function ownHandles() {
  return new Set([petHandle, panelHandle].filter(Boolean));
}

const physics = new PetPhysics({
  bounds: () => petWindow.getBounds(),
  move: (x, y) => {
    if (alive(petWindow)) petWindow.setPosition(Math.round(x), Math.round(y));
  },
  workArea: (bounds) =>
    screen.getDisplayNearestPoint({
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + bounds.height / 2),
    }).workArea,
  windows: () => {
    // L'elenco costa ~1 ms: basta rinfrescarlo quattro volte al secondo.
    if (Date.now() - windowsCacheAt > WINDOWS_REFRESH_MS) {
      windowsCache = desktop.listWindows(ownHandles());
      windowsCacheAt = Date.now();
    }
    return windowsCache;
  },
  windowRect: (hwnd) => desktop.windowRect(hwnd),
  emit: (message) => sendToPet('pet:motion', message),
});

/**
 * Manda al renderer la posizione del cursore relativa alla finestra.
 *
 * Non si puo' delegare a `forward: true`: mentre la finestra e' in
 * click-through gli eventi mouse non arrivano alla pagina, e si crea un
 * circolo vizioso - la finestra resterebbe trasparente ai click per sempre,
 * perche' non potrebbe mai accorgersi che il cursore e' tornato sopra il
 * personaggio. Il processo main invece la posizione del cursore la puo'
 * leggere sempre, qualunque sia lo stato della finestra.
 */
function pushCursorPosition(bounds) {
  const cursor = screen.getCursorScreenPoint();
  const x = cursor.x - bounds.x;
  const y = cursor.y - bounds.y;
  const inside = x >= 0 && y >= 0 && x < bounds.width && y < bounds.height;
  // Le coordinate servono anche da fuori: lo sguardo segue il cursore su
  // tutto lo schermo, il test dei pixel invece vale solo dentro (`inside`).
  sendToPet('pet:cursor', { x, y, inside });
}

let lastTick = Date.now();
function tick() {
  if (!alive(petWindow)) return;
  const now = Date.now();
  const dt = Math.min(0.05, (now - lastTick) / 1000);
  lastTick = now;

  pushCursorPosition(petWindow.getBounds());
  physics.step(dt);
  updatePetShape();

  // Il pannello agganciato segue il personaggio ovunque vada.
  const bounds = petWindow.getBounds();
  if (!lastPetBounds || bounds.x !== lastPetBounds.x || bounds.y !== lastPetBounds.y || bounds.width !== lastPetBounds.width) {
    lastPetBounds = bounds;
    dockPanel();
  }
}

/**
 * Windows riordina le finestre "sempre in primo piano" ogni volta che una di
 * loro si attiva (barra delle applicazioni compresa): la rimettiamo in cima
 * ogni secondo, senza rubare il focus a nessuno.
 */
function keepOnTop() {
  if (!settings.pinned || !alive(petWindow) || !petWindow.isVisible()) return;
  if (!petWindow.isAlwaysOnTop()) petWindow.setAlwaysOnTop(true, 'screen-saver');
  if (petHandle) desktop.keepOnTop(petHandle);
  else petWindow.moveTop();
}

/** Nuova scala: la finestra cresce tenendo fermi i piedi (o la seduta) e l'asse del corpo. */
function setScale(scale) {
  settings.scale = clamp(scale, ...SCALE_RANGE);
  saveSettings();
  if (!alive(petWindow)) return settings.scale;
  applyPetSize();
  broadcastState();
  return settings.scale;
}

function applyPetSize() {
  if (!alive(petWindow)) return;
  const { width, height } = petSize();
  const next = physics.resized(petWindow.getBounds(), width, height);
  // Con resizable:false alcune versioni di Windows ignorano setBounds.
  petWindow.setResizable(true);
  petWindow.setBounds(next);
  petWindow.setResizable(false);
}

/**
 * Sdraiata sul fianco il corpo e' orizzontale: la finestra si allarga subito
 * (stessa altezza, stesso asse del corpo, quindi lei non si sposta) e torna
 * stretta solo quando si e' gia' rialzata, altrimenti verrebbe tagliata.
 */
function updatePetShape() {
  if (physics.posture === 'side') {
    narrowSince = null;
    if (!petWide) {
      petWide = true;
      applyPetSize();
    }
    return;
  }
  if (!petWide) return;
  narrowSince ??= Date.now();
  if (Date.now() - narrowSince >= SIDE_EXIT_MS) {
    petWide = false;
    narrowSince = null;
    applyPetSize();
  }
}

/** Spotify: cosa suona (lo legge dal titolo della sua finestra), solo quando cambia. */
function pollMusic() {
  let next;
  try {
    next = spotify.status();
  } catch (error) {
    console.error('[spotify]', error.message);
    return;
  }
  if (next.open === music.open && next.playing === music.playing && next.artist === music.artist && next.title === music.title) {
    return;
  }
  music = next;
  sendToPet('pet:music', music);
  sendToPanel('pet:music', music);
}

// ---------------------------------------------------------------------------
// Pannello: chat + impostazioni, staccato dal personaggio
// ---------------------------------------------------------------------------
function createPanelWindow() {
  const bounds = settings.panelBounds ?? { ...PANEL_SIZE, x: 100, y: 100 };
  panelWindow = new BrowserWindow({
    ...bounds,
    minWidth: 320,
    minHeight: 420,
    frame: false,
    transparent: true,
    resizable: true,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: settings.panelPinned,
    hasShadow: true,
    backgroundColor: '#00000000',
    title: 'Desk Companion - pannello',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: ['--dc-role=panel'],
    },
  });
  panelHandle = desktop.handleOf(panelWindow);
  panelWindow.loadURL(`${BACKEND_URL}/panel.html`);

  panelWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  panelWindow.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.log(`[panel] ${message}`);
  });

  // Spostarlo a mano lo stacca dal personaggio (will-move scatta solo per
  // gli spostamenti dell'utente, non per i nostri setBounds).
  panelWindow.on('will-move', () => {
    if (settings.docked) {
      settings.docked = false;
      broadcastState();
    }
  });
  const remember = () => {
    if (!alive(panelWindow) || settings.docked) return;
    settings.panelBounds = panelWindow.getBounds();
    saveSettings();
  };
  panelWindow.on('moved', remember);
  panelWindow.on('resized', () => {
    remember();
    dockPanel();
  });

  // Chiuderlo lo nasconde soltanto: la chat resta com'era.
  panelWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      panelWindow.hide();
    }
  });
  panelWindow.on('closed', () => {
    panelWindow = null;
    panelHandle = null;
  });
}

/** Pannello agganciato: di fianco al personaggio, dal lato dove c'e' spazio. */
function dockPanel() {
  if (!settings.docked || !alive(panelWindow) || !alive(petWindow) || !panelWindow.isVisible()) return;
  const pet = petWindow.getBounds();
  const panel = panelWindow.getBounds();
  const area = screen.getDisplayMatching(pet).workArea;
  // Il personaggio occupa circa la meta' centrale della sua finestra.
  const bodyLeft = pet.x + pet.width * 0.25;
  const bodyRight = pet.x + pet.width * 0.75;
  let x = bodyLeft - panel.width - PANEL_GAP;
  if (x < area.x) x = bodyRight + PANEL_GAP;
  x = clamp(x, area.x, area.x + area.width - panel.width);
  const y = clamp(pet.y + pet.height - panel.height, area.y, area.y + area.height - panel.height);
  if (Math.round(x) !== panel.x || Math.round(y) !== panel.y) {
    panelWindow.setPosition(Math.round(x), Math.round(y));
  }
}

function showPanel(focus) {
  if (!alive(panelWindow)) createPanelWindow();
  const reveal = () => {
    dockPanel();
    panelWindow.show();
    panelWindow.focus();
    dockPanel();
    if (focus) sendToPanel('panel:focus', focus);
  };
  if (panelWindow.webContents.isLoading()) panelWindow.webContents.once('did-finish-load', reveal);
  else reveal();
}

function togglePanel(focus) {
  if (alive(panelWindow) && panelWindow.isVisible() && panelWindow.isFocused()) {
    panelWindow.hide();
    return;
  }
  showPanel(focus);
}

function panelState() {
  return {
    pinned: settings.pinned,
    ghost: ghostMode,
    scale: settings.scale,
    windows: settings.windows,
    docked: settings.docked,
    panelPinned: settings.panelPinned,
    windowsAvailable: desktop.available(),
    music,
  };
}

function broadcastState() {
  const state = panelState();
  sendToPanel('panel:state', state);
  sendToPet('pet:state', state);
  updateTrayMenu();
}

// ---------------------------------------------------------------------------
// Icona nell'area di notifica: sempre raggiungibile, anche in modalita'
// fantasma (quando i click attraversano il personaggio e il tasto destro su
// di lei non arriva piu').
// ---------------------------------------------------------------------------
let tray = null;

/** Un PNG minimo generato al volo: un cerchio col colore d'accento, niente file da distribuire. */
function trayImage(size = 32) {
  const pixels = Buffer.alloc(size * (size * 4 + 1));
  const center = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    pixels[row] = 0; // filtro PNG "nessuno" per la riga
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - center, y - center);
      const alpha = Math.max(0, Math.min(1, size * 0.45 - distance));
      const inner = distance < size * 0.18;
      const offset = row + 1 + x * 4;
      pixels[offset] = inner ? 255 : 122;
      pixels[offset + 1] = inner ? 255 : 162;
      pixels[offset + 2] = 255;
      pixels[offset + 3] = Math.round(alpha * 255);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit per canale
  header[9] = 6; // RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return nativeImage.createFromBuffer(png);
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('Desk Companion');
  tray.on('click', () => togglePanel({ tab: 'chat' }));
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Apri la chat', click: () => showPanel({ tab: 'chat' }) },
      { label: 'Impostazioni', click: () => showPanel({ tab: 'menu' }) },
      { type: 'separator' },
      {
        label: 'Modalita fantasma',
        type: 'checkbox',
        checked: ghostMode,
        click: toggleGhost,
      },
      {
        label: 'Sempre davanti alle finestre',
        type: 'checkbox',
        checked: settings.pinned,
        click: togglePinned,
      },
      { type: 'separator' },
      { label: 'Esci', click: () => app.quit() },
    ]),
  );
}

// ---------------------------------------------------------------------------
// IPC (le controparti sono in preload.js)
// ---------------------------------------------------------------------------
/** Il renderer dice se il cursore e' sopra un pixel opaco del personaggio. */
ipcMain.on('pet:set-interactive', (_event, value) => applyInteractive(Boolean(value)));

ipcMain.handle('pet:drag-start', () => {
  physics.grab();
  const [x, y] = petWindow.getPosition();
  return { x, y };
});

ipcMain.on('pet:drag-move', (_event, { x, y }) => {
  if (physics.state !== 'held' || !alive(petWindow)) return;
  petWindow.setPosition(Math.round(x), Math.round(y));
});

ipcMain.handle('pet:drag-end', () => {
  if (physics.state === 'held') physics.release();
  return true;
});

/** Dove stanno piedi, seduta e asse del corpo nella finestra (frazioni). */
ipcMain.on('pet:anchors', (_event, anchors) => physics.setAnchors(anchors));

ipcMain.handle('pet:posture', (_event, posture) => physics.requestPosture(posture));

ipcMain.handle('pet:scale-by', (_event, factor) => setScale(settings.scale * factor));
ipcMain.handle('pet:set-scale', (_event, value) => setScale(Number(value)));

function togglePinned() {
  settings.pinned = !settings.pinned;
  saveSettings();
  if (alive(petWindow)) {
    petWindow.setAlwaysOnTop(settings.pinned, 'screen-saver');
    if (settings.pinned) keepOnTop();
  }
  broadcastState();
  return settings.pinned;
}

function toggleGhost() {
  ghostMode = !ghostMode;
  interactive = null; // forza la riapplicazione
  applyInteractive(false);
  broadcastState();
  return ghostMode;
}

ipcMain.handle('pet:toggle-always-on-top', togglePinned);
ipcMain.handle('pet:toggle-ghost', toggleGhost);

ipcMain.handle('pet:set-windows', (_event, value) => {
  settings.windows = Boolean(value);
  physics.windowsEnabled = settings.windows;
  saveSettings();
  broadcastState();
  return settings.windows;
});

/** Sceglie un altro modello .vrm e lo passa al personaggio come dati binari. */
ipcMain.handle('pet:pick-model', async () => {
  const result = await dialog.showOpenDialog(alive(panelWindow) ? panelWindow : petWindow, {
    title: 'Scegli un modello VRM',
    filters: [{ name: 'Modelli VRM', extensions: ['vrm'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return false;
  const file = result.filePaths[0];
  const data = await fs.promises.readFile(file);
  sendToPet('pet:model', { name: path.basename(file), data });
  return true;
});

/** Comandi dal pannello al personaggio (guadagno della bocca, azioni, debug...). */
ipcMain.on('pet:command', (_event, command) => sendToPet('pet:command', command));

ipcMain.handle('panel:toggle', (_event, focus) => togglePanel(focus));
ipcMain.handle('panel:open', (_event, focus) => showPanel(focus));
ipcMain.handle('panel:hide', () => panelWindow?.hide());
ipcMain.handle('panel:state', () => panelState());

ipcMain.handle('panel:set-docked', (_event, value) => {
  settings.docked = Boolean(value);
  saveSettings();
  dockPanel();
  broadcastState();
  return settings.docked;
});

ipcMain.handle('panel:set-pinned', (_event, value) => {
  settings.panelPinned = Boolean(value);
  saveSettings();
  panelWindow?.setAlwaysOnTop(settings.panelPinned);
  broadcastState();
  return settings.panelPinned;
});

// ---------------------------------------------------------------------------
// Voce: scorciatoia globale per il push-to-talk
// ---------------------------------------------------------------------------
// Electron notifica solo la *pressione* di una scorciatoia globale, mai il
// rilascio: un "tieni premuto" valido su tutto il sistema non e' ottenibile
// senza un hook nativo della tastiera (una dipendenza compilata in piu', che
// per giunta l'antivirus tende a segnalare come keylogger).
//
// Quindi: fuori dalla finestra il tasto fa da interruttore (premi = parla,
// premi = ho finito), dentro la finestra il renderer usa keydown/keyup veri e
// il tieni-premuto funziona come ci si aspetta.
let pushToTalkKey = null;
let voiceState = {};

function registerPushToTalk(key) {
  if (pushToTalkKey) {
    globalShortcut.unregister(pushToTalkKey);
    pushToTalkKey = null;
  }
  if (!key) return { ok: true, key: null };

  try {
    const ok = globalShortcut.register(key, () => {
      sendToPet('voice:push-to-talk', { action: 'toggle' });
    });
    if (!ok) {
      // Registrazione rifiutata: quasi sempre il tasto e' gia' preso da
      // un'altra applicazione.
      return { ok: false, key, error: `La scorciatoia ${key} e' gia' in uso.` };
    }
    pushToTalkKey = key;
    return { ok: true, key };
  } catch (error) {
    return { ok: false, key, error: String(error.message ?? error) };
  }
}

ipcMain.handle('voice:set-key', (_event, key) => registerPushToTalk(key));

ipcMain.on('voice:state', (_event, state) => {
  voiceState = state ?? {};
  sendToPanel('voice:command', { type: 'state', ...voiceState });
});

ipcMain.handle('app:quit', () => app.quit());

// ---------------------------------------------------------------------------
// Ciclo di vita
// ---------------------------------------------------------------------------
// Una sola mascotte alla volta: un secondo avvio mostra quella che c'e' gia'.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (alive(petWindow)) petWindow.show();
    showPanel({ tab: 'chat' });
  });

  app.whenReady().then(async () => {
    loadSettings();
    physics.windowsEnabled = settings.windows;
    startBackend();

    const ready = await waitForBackend();
    if (!ready) {
      console.error(
        `[electron] backend non raggiungibile su ${BACKEND_URL}. ` +
          'Controlla di aver installato le dipendenze Python (pip install -r requirements.txt).',
      );
    }

    createPetWindow();
    createPanelWindow();
    createTray();

    const key = process.env.DC_PUSH_TO_TALK_KEY || settings.pushToTalkKey || 'Control+Space';
    const result = registerPushToTalk(key);
    if (!result.ok) console.warn(`[electron] push-to-talk: ${result.error}`);

    setInterval(tick, TICK_MS);
    setInterval(keepOnTop, ON_TOP_MS);
    setInterval(pollMusic, MUSIC_POLL_MS);
  });
}

app.on('before-quit', () => {
  app.isQuitting = true;
  stopBackend();
});

// Senza questo la scorciatoia resta registrata e le altre applicazioni non
// possono piu' usare quella combinazione finche' non si riavvia il sistema.
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  stopBackend();
  app.quit();
});

process.on('exit', stopBackend);
