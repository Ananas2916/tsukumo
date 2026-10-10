/**
 * Tsukumo's Electron shell, Desktop Mate style.
 *
 * Two windows:
 *  - the character: frameless, transparent, always in front of everything,
 *    letting the mouse through everywhere except where something is really
 *    drawn;
 *  - the panel: chat and settings, detached from the character. It can stay
 *    docked at her side and follow her, or free wherever you put it.
 *
 * And in between the mascot's life (see pet-physics.js): let go in mid-air
 * she falls, sits on window edges and travels with them, stands on the
 * taskbar, clings to the screen edges. The wheel makes her bigger: it
 * changes the window, not the camera.
 *
 * The click-through is "per pixel": the renderer reads the alpha of the
 * pixel under the cursor from the WebGL framebuffer and tells us whether
 * it's over the character; here we turn that boolean into
 * setIgnoreMouseEvents.
 */

const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  powerMonitor,
  screen,
  session,
  shell,
} = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');

const desktop = require('./desktop');
const i18n = require('./i18n');
const { PetPhysics } = require('./pet-physics');
const spotify = require('./spotify');

const { t } = i18n;

// For installer tests: settings in a separate folder.
if (process.env.DC_USER_DATA) app.setPath('userData', process.env.DC_USER_DATA);

/**
 * Installed (electron-builder) the project lives in the app's resources, with
 * its own Python (scripts/build_installer.ps1); in development it's the
 * folder above this one. The installed user's data (state, engine settings,
 * logs) lives in %APPDATA%\Tsukumo: an update replaces the resources and
 * must not delete it.
 */
const PACKAGED = app.isPackaged && !process.env.DC_PROJECT_ROOT;
const PROJECT_ROOT = process.env.DC_PROJECT_ROOT || (PACKAGED ? path.join(process.resourcesPath, 'tsukumo') : path.resolve(__dirname, '..'));
const DATA_ROOT = PACKAGED ? app.getPath('userData') : PROJECT_ROOT;
const APP_NAME = 'Tsukumo';

// The app's name (package.json) decides the settings folder,
// %APPDATA%\Tsukumo. It used to be called desk-companion-shell: we copy it
// once, so size, panel position, chat and preferences don't get lost.
// Electron creates the new folder before this code runs: to know whether the
// copy was already made we need a marker, not the folder's existence.
const LEGACY_USER_DATA = path.join(app.getPath('appData'), 'desk-companion-shell');
const MIGRATED_MARK = path.join(app.getPath('userData'), '.migrato-da-desk-companion');
if (fs.existsSync(LEGACY_USER_DATA) && !fs.existsSync(MIGRATED_MARK)) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    if (!fs.existsSync(path.join(app.getPath('userData'), 'pet-settings.json'))) {
      fs.cpSync(LEGACY_USER_DATA, app.getPath('userData'), {
        recursive: true,
        force: false,
        // The old profile's locks must not be copied: they would block this one.
        filter: (source) => !/(lockfile|Singleton\w*|LOCK)$/i.test(source),
      });
    }
    fs.writeFileSync(MIGRATED_MARK, new Date().toISOString());
  } catch (error) {
    process.stderr.write(`[electron] previous settings not copied: ${error.message}\n`);
  }
}

// Started from the desktop shortcut there's no terminal to look at, and on
// Windows a GUI app doesn't even write to a redirected stdout: everything
// also ends up in logs/companion.log, always.
const LOG_FILE = process.env.DC_LOG_FILE || path.join(DATA_ROOT, 'logs', 'companion.log');
(() => {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    // Over 5 MB the old log becomes .1: enough to understand the last start.
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) {
      fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
  } catch {
    /* a missing log must not prevent startup */
  }
  const stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  const original = { log: console.log, error: console.error, warn: console.warn };
  const write =
    (prefix, target) =>
    (...args) => {
      const line = args.map((arg) => (arg instanceof Error ? arg.stack : String(arg))).join(' ');
      stream.write(`${new Date().toISOString()} ${prefix}${line}\n`);
      try {
        target(...args);
      } catch {
        /* no console: normal when started from the shortcut */
      }
    };
  console.log = write('', original.log);
  console.warn = write('WARNING ', original.warn);
  console.error = write('ERROR ', original.error);
  process.on('uncaughtException', (error) => console.error(error.stack ?? String(error)));
})();

const HOST = process.env.DC_HOST || '127.0.0.1';
const PORT = Number(process.env.DC_PORT || 8770);
const BACKEND_URL = `http://${HOST}:${PORT}`;
const BACKEND_ORIGIN = new URL(BACKEND_URL).origin;
const SPAWN_BACKEND = process.env.DC_NO_SPAWN !== '1';

/**
 * The project's virtualenv Python, if there is one: the system one usually
 * has no FastAPI and Kokoro, and the backend would die at startup.
 */
function pythonExecutable() {
  if (process.env.DC_PYTHON) return process.env.DC_PYTHON;
  const bundled = path.join(process.resourcesPath ?? '', 'python', 'python.exe');
  if (PACKAGED && fs.existsSync(bundled)) return bundled;
  const venv = path.join(PROJECT_ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (fs.existsSync(venv)) return venv;
  return process.platform === 'win32' ? 'python' : 'python3';
}
const PYTHON = pythonExecutable();

// Size of the mascot window at scale 1: narrow and tall, like a standing figure.
const BASE_WIDTH = Number(process.env.DC_PET_WIDTH || 300);
const BASE_HEIGHT = Number(process.env.DC_PET_HEIGHT || 460);
const SCALE_RANGE = [0.5, 2.6];
/** Lying on her side she's as long as she's tall standing: the window becomes square. */
const SIDE_ASPECT = 1;
/** Getting up she stays horizontal for a moment: the window narrows afterwards. */
const SIDE_EXIT_MS = 1000;
/** With the menu island open the window widens up to this (at scale 1), like Coucou's. */
const ISLAND_WIDTH = 440;
const MUSIC_POLL_MS = 1500;
/** How often to tell the character how long the PC has been idle (sleep and waking up). */
const PRESENCE_POLL_MS = 5000;

const PANEL_SIZE = { width: 400, height: 620 };
const PANEL_GAP = 10;

const TICK_MS = 16; // ~60 fps: falls and rides on windows must be smooth
const WINDOWS_REFRESH_MS = 250;
const ON_TOP_MS = 1000;

let petWindow = null;
let panelWindow = null;
/** The dashboard (dashboard.html): with her docked in the corner, until you minimize it. */
let dashboardWindow = null;
/**
 * Her inside the dashboard: `{stage, scale, before}`. `stage` is the tile (in
 * page pixels) where she stands, `before` where she was on the desktop.
 * While it's set, physics is still and the window follows the dashboard.
 */
let petDock = null;
/** The last tile the dashboard reported: reopening it, she goes back without waiting for it. */
let dashboardStage = null;
let backendProcess = null;

/** Manual ghost mode: ignores everything, the character too. */
let ghostMode = false;
/** Last click-through state applied, so the API isn't called for nothing. */
let interactive = null;
let petHandle = null;
let panelHandle = null;
let windowsCache = [];
let windowsCacheAt = 0;
let lastPetBounds = null;
/** Wide window for the lying-on-her-side pose. */
let petWide = false;
let narrowSince = null;
/** The island open: `{shift}` = how far right of the wide window's centre she is (px). */
let islandWide = null;
/** Tab open in the panel (the panel itself says which). */
let panelTab = 'chat';
/** Last Spotify state sent to the pages. */
let music = { open: false, playing: false, artist: '', title: '' };

// ---------------------------------------------------------------------------
// Security: the windows show only the backend's pages
// ---------------------------------------------------------------------------
// Every renderer in a sandbox: even if a page were compromised it would have
// no Node, and the preload exposes only the commands listed in preload.js.
app.enableSandbox();

/** Is the URL a page served by our backend? */
function ownPage(url) {
  try {
    return new URL(url).origin === BACKEND_ORIGIN;
  } catch {
    return false;
  }
}

/** An external link goes to the system browser, but only if it's http(s): never file://, ms-*, smb://... */
function openOutside(url) {
  try {
    const { protocol } = new URL(url);
    if (protocol === 'https:' || protocol === 'http:') shell.openExternal(url);
  } catch {
    /* not a URL */
  }
}

/** The permissions our pages really use (microphone, clipboard, notifications). */
const ALLOWED_PERMISSIONS = new Set(['media', 'clipboard-sanitized-write', 'notifications', 'fullscreen', 'speaker-selection']);

app.on('web-contents-created', (_event, contents) => {
  // No new windows: links open in the browser.
  contents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
  // A page trying to go elsewhere (link, redirect, script) stays where it is:
  // outside the backend the preload would give our commands to any site.
  contents.on('will-navigate', (event) => {
    if (ownPage(event.url)) return;
    event.preventDefault();
    openOutside(event.url);
  });
  contents.on('will-redirect', (event) => {
    if (!ownPage(event.url)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

function guardPermissions() {
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && ownPage(details?.requestingUrl || contents.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin) => ALLOWED_PERMISSIONS.has(permission) && ownPage(origin));
}

/** Whoever sends an IPC message must be one of our pages (not an iframe, not a site). */
function trusted(event) {
  try {
    return ownPage(event.senderFrame?.url ?? '');
  } catch {
    return false; // frame already destroyed
  }
}

function handleIpc(channel, listener) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trusted(event)) throw new Error(`IPC ${channel} refused: unknown sender`);
    return listener(event, ...args);
  });
}

function onIpc(channel, listener) {
  ipcMain.on(channel, (event, ...args) => {
    if (trusted(event)) listener(event, ...args);
  });
}

/** `console-message`: since Electron 35 the data is in the event, and the level is a word. */
function consoleEntry(event) {
  const levels = { debug: 0, verbose: 0, info: 1, warning: 2, error: 3 };
  return { level: levels[event?.level] ?? 1, message: String(event?.message ?? '') };
}

// ---------------------------------------------------------------------------
// Settings that survive restarts
// ---------------------------------------------------------------------------
const settingsPath = () => path.join(app.getPath('userData'), 'pet-settings.json');
const settings = {
  scale: 1,
  pinned: true,
  windows: true,
  docked: true,
  panelPinned: false,
  panelBounds: null,
  /** At startup: 'dashboard' or 'companion' (just her on the desktop). */
  startWith: 'dashboard',
  dashboardBounds: null,
  dashboardMaximized: false,
  /** The interface's language as the pages last said it ('en', 'it'), for the tray and the waiting card. */
  language: null,
};

/** No saved settings: it's the first time, the panel opens with the introduction. */
let firstRun = false;

function loadSettings() {
  try {
    Object.assign(settings, JSON.parse(fs.readFileSync(settingsPath(), 'utf8')));
  } catch {
    /* first start: the defaults stay */
    firstRun = !fs.existsSync(settingsPath());
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
      console.error('[electron] settings not saved:', error.message);
    }
  }, 300);
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const alive = (win) => win && !win.isDestroyed();

// ---------------------------------------------------------------------------
// Python backend
// ---------------------------------------------------------------------------
/** The last lines written by the backend: if it dies at startup, they explain why. */
const backendTail = [];
/** The backend's exit code, if it's already dead (null = alive or never started). */
let backendExit = null;

/**
 * Installed, the avatar lives in the user's data: the one chosen from the
 * panel stays after a restart or an update. The first time the one included
 * in the installer is copied there.
 */
const AVATAR_DIR = path.join(DATA_ROOT, 'avatars');

function prepareAvatars() {
  if (!PACKAGED) return;
  try {
    fs.mkdirSync(AVATAR_DIR, { recursive: true });
    if (fs.readdirSync(AVATAR_DIR).some((name) => name.toLowerCase().endsWith('.vrm'))) return;
    const bundled = path.join(PROJECT_ROOT, 'frontend', 'public', 'models');
    for (const name of fs.readdirSync(bundled)) {
      if (name.toLowerCase().endsWith('.vrm')) fs.copyFileSync(path.join(bundled, name), path.join(AVATAR_DIR, name));
    }
  } catch (error) {
    console.error('[electron] avatars not prepared:', error.message);
  }
}

/** Installed: the backend's state and settings in the user's data, not among the resources. */
function packagedEnvironment() {
  if (!PACKAGED) return {};
  prepareAvatars();
  return {
    DC_STATE_DIR: process.env.DC_STATE_DIR || path.join(DATA_ROOT, 'state'),
    DC_ENV_FILE: process.env.DC_ENV_FILE || path.join(DATA_ROOT, 'tsukumo.env'),
    DC_AVATAR_DIR: process.env.DC_AVATAR_DIR || AVATAR_DIR,
    // The bundled Python must not read packages installed elsewhere on the PC.
    PYTHONNOUSERSITE: '1',
  };
}

function startBackend() {
  if (!SPAWN_BACKEND) {
    console.log('[electron] DC_NO_SPAWN=1: using a backend that is already running');
    return;
  }

  console.log(`[electron] starting the backend: ${PYTHON} -m backend`);
  backendExit = null;
  backendTail.length = 0;
  const child = spawn(PYTHON, ['-m', 'backend', '--host', HOST, '--port', String(PORT)], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...packagedEnvironment(), PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Started from the desktop shortcut there's no terminal: without this
    // Windows would open a black console for python.exe.
    windowsHide: true,
  });
  backendProcess = child;

  const collect = (chunk) => {
    const text = String(chunk).trimEnd();
    console.log(`[py] ${text}`);
    backendTail.push(...text.split(/\r?\n/));
    backendTail.splice(0, Math.max(0, backendTail.length - 12));
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  child.on('error', (error) => {
    console.error(`[electron] cannot start "${PYTHON}":`, error.message);
    backendTail.push(`Cannot start ${PYTHON}: ${error.message}`);
    backendExit = -1;
  });

  child.on('exit', (code) => {
    if (backendProcess === child) backendProcess = null;
    backendExit = code ?? -1;
    if (code !== 0 && code !== null) {
      console.error(`[electron] the backend exited with code ${code}`);
    }
  });
}

/**
 * Whoever holds the backend's port, if it's one of our backends left hanging
 * (a previous start closed badly): we close it, otherwise the new one
 * couldn't listen. Another program on the same port isn't touched.
 */
function reclaimPort() {
  if (process.platform !== 'win32') return false;
  try {
    const netstat = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const line = (netstat.stdout || '')
      .split(/\r?\n/)
      .find((row) => /LISTENING|IN ASCOLTO/i.test(row) && new RegExp(`[:.]${PORT}\\s`).test(row));
    const pid = line?.trim().split(/\s+/).pop();
    if (!pid || !/^\d+$/.test(pid)) return false;
    const query = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 },
    );
    const commandLine = query.stdout || '';
    if (!/-m\s+backend/.test(commandLine)) {
      console.error(`[electron] port ${PORT} is taken by another program (pid ${pid}): leaving it alone`);
      return false;
    }
    console.log(`[electron] closing a backend left hanging (pid ${pid})`);
    spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { windowsHide: true, timeout: 5000 });
    return true;
  } catch (error) {
    console.error('[electron] port check failed:', error.message);
    return false;
  }
}

function stopBackend() {
  if (!backendProcess) return;
  const pid = backendProcess.pid;
  console.log(`[electron] stopping the backend (pid ${pid})`);

  if (process.platform === 'win32' && pid) {
    // On Windows child.kill() often leaves the Python process alive: it hangs
    // with Kokoro in memory and keeps the port busy, so at the next restart the
    // new backend can't listen any more. taskkill /T /F closes the whole
    // process tree.
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch (error) {
      console.error('[electron] taskkill failed:', error.message);
      backendProcess.kill();
    }
  } else {
    backendProcess.kill();
  }

  backendProcess = null;
}

/**
 * A single look at /api/health: the JSON if a Tsukumo backend answers,
 * otherwise null. The backend always answers right away (it never waits for
 * agents or external services), so a short timeout is enough.
 */
function probeBackend(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const request = http.get(`${BACKEND_URL}/api/health`, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => {
        try {
          resolve(response.statusCode === 200 ? JSON.parse(body) : null);
        } catch {
          resolve(null);
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for the backend to be ready; gives up right away if the process dies. */
async function waitForBackend(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await probeBackend();
    if (health?.ok) return { ok: true, health };
    if (SPAWN_BACKEND && backendExit !== null && !backendProcess) return { ok: false, reason: 'exited' };
    await sleep(400);
  }
  return { ok: false, reason: 'timeout' };
}

/** Starts (or reuses) the backend and waits for it to answer. */
async function ensureBackend() {
  const existing = await probeBackend(1200);
  if (existing?.app === 'tsukumo' && existing.ok) {
    console.log(`[electron] backend already running on ${BACKEND_URL} (v${existing.version}): reusing it`);
    return { ok: true, health: existing };
  }
  if (SPAWN_BACKEND) {
    reclaimPort();
    startBackend();
  }
  return waitForBackend();
}

// ---------------------------------------------------------------------------
// The character's window
// ---------------------------------------------------------------------------
const petSize = () => {
  // In the dashboard she has the size of her tile, not the one chosen for the desktop.
  const scale = petDock ? petDock.scale : settings.scale;
  const height = Math.round(BASE_HEIGHT * scale);
  let width = petWide ? Math.round(height * SIDE_ASPECT) : Math.round(BASE_WIDTH * scale);
  if (islandWide && !petDock) width = Math.max(width, Math.round(ISLAND_WIDTH * scale));
  // In the dashboard she takes her whole tile: she stays in the middle, but
  // the speech bubble and the island have room (narrow, the bubble became a column).
  if (petDock?.stage?.width > width) width = Math.round(petDock.stage.width);
  return { width, height };
};

/**
 * The menu island opens (or closes): the window widens around her and goes
 * narrow again afterwards. Near the screen edge it widens only inwards: the
 * page shifts the framing by `shift` pixels so the flame stays exactly where
 * she was (VrmStage.setFrameShift).
 */
function setIslandWide(open) {
  if (!open) return narrowIsland();
  if (!alive(petWindow)) return { wide: false, shift: 0 };
  if (islandWide) return { wide: true, shift: islandWide.shift };
  // Docked in the dashboard, lying down, sprinting or held: she stays as she is.
  if (petDock || petWide || physics.state === 'sprint' || physics.state === 'held') return { wide: false, shift: 0 };
  const bounds = petWindow.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const width = Math.round(ISLAND_WIDTH * settings.scale);
  if (width <= bounds.width) return { wide: false, shift: 0 };
  const center = bounds.x + bounds.width / 2;
  const x = Math.round(clamp(center - width / 2, area.x, Math.max(area.x, area.x + area.width - width)));
  islandWide = { shift: Math.round(center - (x + width / 2)) };
  reframePet({ x, y: bounds.y, width, height: bounds.height }, islandWide.shift);
  return { wide: true, shift: islandWide.shift };
}

/**
 * Back to her normal width around where she is now. Besides the island
 * closing, it runs when a drag starts, when the dashboard docks her and when
 * her page reloads: a window left wide would otherwise drift away from her.
 */
function narrowIsland() {
  if (!islandWide) return { wide: false, shift: 0 };
  const { shift } = islandWide;
  islandWide = null;
  if (!alive(petWindow)) return { wide: false, shift: 0 };
  if (petDock) {
    sendToPet('pet:frame-shift', { shift: 0 });
    dockPet();
    return { wide: false, shift: 0 };
  }
  const bounds = petWindow.getBounds();
  const center = bounds.x + bounds.width / 2 + shift;
  const { width } = petSize();
  reframePet({ x: Math.round(center - width / 2), y: bounds.y, width, height: bounds.height }, 0);
  return { wide: false, shift: 0 };
}

/** New window bounds with her `shift` px right of the window centre; physics learns her axis right away. */
function reframePet(next, shift) {
  sendToPet('pet:frame-shift', { shift });
  petWindow.setResizable(true);
  petWindow.setBounds(next);
  petWindow.setResizable(false);
  // Sitting on a window, physics places her by this fraction: waiting for the
  // page to measure it again would move her for a few frames.
  physics.setAnchors({ center: (next.width / 2 + shift) / next.width });
}

function createPetWindow() {
  // Start: bottom right of the work area, standing on the taskbar.
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
    title: APP_NAME,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: ['--dc-role=pet'],
      // The window is almost always click-through, so it often doesn't receive
      // the "user gesture" Chromium wants before unlocking audio: without this
      // the voice would stay mute.
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
    },
  });

  if (settings.pinned) petWindow.setAlwaysOnTop(true, 'screen-saver');
  petHandle = desktop.handleOf(petWindow);
  keepLoaded(petWindow, 'character');
  // A fresh page starts with her centred: a window still wide for the island would leave her off to one side.
  petWindow.webContents.on('did-finish-load', () => narrowIsland());
  // Until the backend answers a waiting card is shown: before, the window
  // stayed transparent and empty, and it looked like nothing had started.
  showSplash(petWindow, { title: t('{name} is waking up…', { name: APP_NAME }), detail: t('Starting the brain and the voice.') });

  // External links go to the system browser: see 'web-contents-created'.

  // The page's console.logs end up in the terminal: without this, in a window
  // without DevTools open the renderer is a black box.
  petWindow.webContents.on('console-message', (event) => {
    const { level, message } = consoleEntry(event);
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

const petUrl = () => (process.env.DC_PET_DEBUG === '1' ? `${BACKEND_URL}/?petdebug` : `${BACKEND_URL}/`);

/** Loads the real page from the backend (and keeps it loaded from then on). */
function loadApp(win, url) {
  if (!alive(win)) return;
  win.__appUrl = url;
  win.__loadAttempts = 0;
  win.loadURL(url);
}

/**
 * A page that doesn't load must not leave an empty window forever: that was
 * exactly the "I see the chat but not the character". It retries by itself,
 * with growing waits, and reloads even if the renderer crashes.
 */
function keepLoaded(win, name) {
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    // -3 = navigation replaced by another: not an error.
    if (!isMainFrame || code === -3 || !win.__appUrl) return;
    win.__loadAttempts = (win.__loadAttempts ?? 0) + 1;
    const delay = Math.min(8000, 400 * 2 ** Math.min(win.__loadAttempts, 5));
    console.error(`[electron] ${name}: ${url} not loaded (${description}), retrying in ${delay} ms`);
    setTimeout(() => alive(win) && win.__appUrl && win.loadURL(win.__appUrl), delay);
  });
  win.webContents.on('did-finish-load', () => {
    if (win.webContents.getURL().startsWith(BACKEND_URL)) win.__loadAttempts = 0;
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[electron] ${name}: renderer gone (${details.reason}), reloading`);
    if (details.reason !== 'clean-exit') setTimeout(() => alive(win) && win.reload(), 1000);
  });
}

/** A waiting (or error) card drawn without the backend, inside the window. */
function showSplash(win, { title, detail = '', error = false, lines = [] }) {
  if (!alive(win)) return;
  const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const html = `<!doctype html><html lang="it"><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:transparent;font:13px/1.45 'Segoe UI',system-ui,sans-serif;color:#ececf1;overflow:hidden}
    .card{position:fixed;left:10px;right:10px;bottom:12px;padding:14px;border-radius:16px;background:rgba(20,20,25,.95);
      border:1px solid rgba(255,255,255,.14);box-shadow:0 18px 40px rgba(0,0,0,.45);text-align:center}
    .spin{width:22px;height:22px;margin:0 auto 8px;border-radius:50%;border:2.5px solid rgba(255,255,255,.12);
      border-top-color:#a58bff;animation:s .9s linear infinite}
    .err .spin{animation:none;border-color:#ff6b81}
    b{display:block;font-weight:600}p{margin:6px 0 0;color:#b4b4c0;font-size:12px}
    pre{margin:8px 0 0;max-height:120px;overflow:auto;text-align:left;white-space:pre-wrap;color:#85858f;font:10.5px/1.35 Consolas,monospace}
    @keyframes s{to{transform:rotate(360deg)}}</style></head>
    <body><div class="card${error ? ' err' : ''}"><div class="spin"></div><b>${escape(title)}</b>
    ${detail ? `<p>${escape(detail)}</p>` : ''}${lines.length ? `<pre>${escape(lines.join('\n'))}</pre>` : ''}</div></body></html>`;
  win.__appUrl = null;
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

/** The backend didn't start: we say so in the window, with the reason. */
function showBackendError(result) {
  const exited = result.reason === 'exited';
  const lines = backendTail.filter((line) => line.trim()).slice(-8);
  const portBusy = lines.some((line) => /10048|address already in use|only one usage/i.test(line));
  const detail = portBusy
    ? t('Port {port} is taken by another program. Close it, then use "Restart" from the icon in the notification area.', { port: PORT })
    : exited
      ? t('The backend closed by itself. The reason is below and in the log (notification area icon -> Open the log).')
      : t("The backend isn't answering. Check the log from the notification area icon.");
  console.error(`[electron] backend unavailable (${result.reason})`);
  showSplash(petWindow, { title: t("I can't start Tsukumo"), detail, error: true, lines });
}

/** Restarts the backend (if it's ours) and reloads the windows. */
async function restartBackend() {
  if (alive(petWindow)) showSplash(petWindow, { title: t('Restarting…'), detail: t('One moment.') });
  if (backendProcess) {
    stopBackend();
    await sleep(900);
  }
  const result = await ensureBackend();
  if (!result.ok) {
    showBackendError(result);
    return;
  }
  loadApp(petWindow, petUrl());
  if (alive(panelWindow)) loadApp(panelWindow, `${BACKEND_URL}/panel.html`);
}

/** Applies the click-through only when the state really changes. */
function applyInteractive(next) {
  if (!alive(petWindow)) return;
  const wanted = ghostMode ? false : next;
  if (wanted === interactive) return;
  interactive = wanted;
  if (process.env.DC_PET_DEBUG === '1') {
    console.log(`[pet-main] window now ${wanted ? 'SOLID (catches clicks)' : 'transparent to clicks'}`);
  }
  // forward: true keeps delivering mouse movement to the page even while
  // clicks go through: needed to notice when the cursor comes back over the
  // character (and for the gaze following it).
  petWindow.setIgnoreMouseEvents(!wanted, { forward: true });
}

function sendToPet(channel, payload) {
  if (alive(petWindow)) petWindow.webContents.send(channel, payload);
}

function sendToPanel(channel, payload) {
  if (alive(panelWindow)) panelWindow.webContents.send(channel, payload);
}

// ---------------------------------------------------------------------------
// Presence: how long nobody has touched mouse and keyboard, screen locked
// ---------------------------------------------------------------------------
let screenLocked = false;
/** The backend answers: from then on we also send it the context. */
let backendUp = false;

/**
 * Every few seconds: how long the PC has been idle (to the character, for
 * sleep) and what the user is doing (to the backend, for comments and "do
 * not disturb").
 */
function pollPresence() {
  const idle = powerMonitor.getSystemIdleTime();
  sendToPet('pet:presence', { idle });
  if (backendUp) pushContext(idle);
}

async function pushContext(idle) {
  const payload = {
    idle,
    locked: screenLocked,
    app: desktop.foregroundWindow(ownHandles()),
  };
  try {
    await fetch(`${BACKEND_URL}/api/context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    /* backend restarted or busy: we retry at the next round */
  }
}

function watchPresence() {
  // Screen unlock and resume from suspend: she wakes up and greets.
  for (const event of ['lock-screen', 'unlock-screen', 'suspend', 'resume']) {
    powerMonitor.on(event, () => {
      if (event === 'lock-screen') screenLocked = true;
      if (event === 'unlock-screen') screenLocked = false;
      sendToPet('pet:presence', { event });
    });
  }
  setInterval(pollPresence, PRESENCE_POLL_MS);
}

// ---------------------------------------------------------------------------
// Physics: floor, windows, edges
// ---------------------------------------------------------------------------
function ownHandles() {
  return new Set([petHandle, panelHandle].filter(Boolean));
}

const physics = new PetPhysics({
  bounds: () => petWindow.getBounds(),
  move: (x, y) => {
    // A NaN here makes Electron throw an exception at every tick (60 a second).
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (alive(petWindow)) petWindow.setPosition(Math.round(x), Math.round(y));
  },
  workArea: (bounds) =>
    screen.getDisplayNearestPoint({
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + bounds.height / 2),
    }).workArea,
  windows: () => {
    // The list costs ~1 ms: refreshing it four times a second is enough.
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
 * Sends the renderer the cursor position relative to the window.
 *
 * It can't be left to `forward: true`: while the window is click-through
 * mouse events don't reach the page, and it becomes a vicious circle - the
 * window would stay transparent to clicks forever, since it could never
 * notice the cursor is back over the character. The main process instead
 * can always read the cursor position, whatever the window's state.
 */
function pushCursorPosition(bounds) {
  const cursor = screen.getCursorScreenPoint();
  const x = cursor.x - bounds.x;
  const y = cursor.y - bounds.y;
  const inside = x >= 0 && y >= 0 && x < bounds.width && y < bounds.height;
  // The coordinates are needed outside too: the gaze follows the cursor over
  // the whole screen, the pixel test instead applies only inside (`inside`).
  sendToPet('pet:cursor', { x, y, inside });
}

let lastTick = Date.now();
function tick() {
  if (!alive(petWindow)) return;
  const now = Date.now();
  const dt = Math.min(0.05, (now - lastTick) / 1000);
  lastTick = now;

  pushCursorPosition(petWindow.getBounds());
  // Docked in the dashboard she doesn't fall or run: she follows the window (dockPet).
  if (!petDock) {
    physics.step(dt);
    updatePetShape();
  }

  // The docked panel follows the character wherever she goes.
  const bounds = petWindow.getBounds();
  if (!lastPetBounds || bounds.x !== lastPetBounds.x || bounds.y !== lastPetBounds.y || bounds.width !== lastPetBounds.width) {
    lastPetBounds = bounds;
    dockPanel();
  }
}

/**
 * Windows reorders the "always on top" windows every time one of them
 * activates (taskbar included): we put her back on top every second,
 * without stealing focus from anyone.
 */
function keepOnTop() {
  if (!settings.pinned || petDock || !alive(petWindow) || !petWindow.isVisible()) return;
  if (!petWindow.isAlwaysOnTop()) petWindow.setAlwaysOnTop(true, 'screen-saver');
  if (petHandle) desktop.keepOnTop(petHandle);
  else petWindow.moveTop();
}

/** New scale: the window grows keeping the feet (or the seat) and the body axis still. */
function setScale(scale) {
  if (!Number.isFinite(scale)) return settings.scale;
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
  // With resizable:false some Windows versions ignore setBounds.
  petWindow.setResizable(true);
  petWindow.setBounds(next);
  petWindow.setResizable(false);
}

/**
 * Lying on her side the body is horizontal: the window widens right away
 * (same height, same body axis, so she doesn't move) and goes narrow again
 * only once she's already up, otherwise she would be cut. It also widens
 * during the flame's sprint, for the trail.
 */
function updatePetShape() {
  if (physics.posture === 'side' || physics.state === 'sprint') {
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

/** Spotify: what's playing (read from its window's title), only when it changes. */
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
// Panel: chat + settings, detached from the character
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
    title: t('{name} - panel', { name: APP_NAME }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: ['--dc-role=panel'],
    },
  });
  panelHandle = desktop.handleOf(panelWindow);
  keepLoaded(panelWindow, 'panel');
  loadApp(panelWindow, `${BACKEND_URL}/panel.html`);
  // The character's docks highlight the open tab: they must know it.
  panelWindow.on('show', broadcastState);
  panelWindow.on('hide', broadcastState);

  panelWindow.webContents.on('console-message', (event) => {
    const { level, message } = consoleEntry(event);
    if (level >= 2) console.log(`[panel] ${message}`);
  });

  // Moving it by hand detaches it from the character (will-move fires only
  // for the user's moves, not for our setBounds).
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

  // Closing it only hides it: the chat stays as it was.
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

/** Docked panel: beside the character, on the side where there's room. */
function dockPanel() {
  if (!settings.docked || petDock || !alive(panelWindow) || !alive(petWindow) || !panelWindow.isVisible()) return;
  const pet = petWindow.getBounds();
  const panel = panelWindow.getBounds();
  const area = screen.getDisplayMatching(pet).workArea;
  // The character takes about the middle half of her window.
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
    // From the dashboard (settings): in the middle of the dashboard, above it.
    if (petDock && alive(dashboardWindow)) {
      const area = dashboardWindow.getBounds();
      const panel = panelWindow.getBounds();
      panelWindow.setPosition(Math.round(area.x + (area.width - panel.width) / 2), Math.round(area.y + (area.height - panel.height) / 2));
    }
    panelWindow.show();
    panelWindow.focus();
    dockPanel();
    if (focus) sendToPanel('panel:focus', focus);
  };
  if (panelWindow.webContents.isLoading()) panelWindow.webContents.once('did-finish-load', reveal);
  else reveal();
}

function togglePanel(focus) {
  // The same tab already in front: the button closes it. Another one: it switches.
  const sameTab = !focus?.tab || focus.tab === panelTab;
  if (alive(panelWindow) && panelWindow.isVisible() && sameTab) {
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
    panelVisible: alive(panelWindow) && panelWindow.isVisible(),
    panelTab,
    dashboard: Boolean(petDock),
    startWith: settings.startWith,
    voice: voiceState,
    music,
  };
}

function broadcastState() {
  const state = panelState();
  sendToPanel('panel:state', state);
  sendToPet('pet:state', state);
  if (alive(dashboardWindow)) dashboardWindow.webContents.send('panel:state', state);
  updateTrayMenu();
}

// ---------------------------------------------------------------------------
// Dashboard: calendar, weather, chat, agents... and her in the corner
// ---------------------------------------------------------------------------
const DASHBOARD_SIZE = { width: 1320, height: 840 };

function createDashboardWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(DASHBOARD_SIZE.width, area.width - 40);
  const height = Math.min(DASHBOARD_SIZE.height, area.height - 40);
  const saved = settings.dashboardBounds;
  // A position saved on a screen that's no longer there is discarded.
  const visible = saved && screen.getAllDisplays().some(({ workArea: w }) => saved.x < w.x + w.width && saved.x + saved.width > w.x && saved.y < w.y + w.height && saved.y + 40 > w.y);
  const bounds = visible ? saved : { width, height, x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2) };
  dashboardWindow = new BrowserWindow({
    ...bounds,
    minWidth: 960,
    minHeight: 620,
    frame: false,
    show: false,
    resizable: true,
    hasShadow: true,
    backgroundColor: '#101015',
    title: APP_NAME,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: ['--dc-role=dashboard'],
    },
  });
  keepLoaded(dashboardWindow, 'dashboard');
  loadApp(dashboardWindow, `${BACKEND_URL}/dashboard.html`);
  dashboardWindow.webContents.on('console-message', (event) => {
    const { level, message } = consoleEntry(event);
    if (level >= 2) console.log(`[dashboard] ${message}`);
  });

  const follow = () => dockPet();
  const remember = () => {
    if (!alive(dashboardWindow)) return;
    settings.dashboardMaximized = dashboardWindow.isMaximized();
    if (!settings.dashboardMaximized) settings.dashboardBounds = dashboardWindow.getBounds();
    saveSettings();
  };
  dashboardWindow.on('move', follow);
  dashboardWindow.on('resize', follow);
  dashboardWindow.on('moved', remember);
  dashboardWindow.on('resized', remember);
  dashboardWindow.on('maximize', () => {
    remember();
    follow();
  });
  dashboardWindow.on('unmaximize', () => {
    remember();
    follow();
  });
  // Minimizing (from the taskbar too) or closing it turns it back into the companion.
  dashboardWindow.on('minimize', (event) => {
    event.preventDefault();
    toCompanion();
  });
  dashboardWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      toCompanion();
    }
  });
  dashboardWindow.on('closed', () => {
    dashboardWindow = null;
    undockPet();
  });
}

function showDashboard() {
  if (!backendUp) return;
  if (!alive(dashboardWindow)) createDashboardWindow();
  const reveal = () => {
    if (!alive(dashboardWindow)) return;
    if (dashboardWindow.isMinimized()) dashboardWindow.restore();
    if (settings.dashboardMaximized && !dashboardWindow.isMaximized()) dashboardWindow.maximize();
    dashboardWindow.show();
    dashboardWindow.focus();
    // The panel stays for the settings: the chat is here now.
    if (alive(panelWindow) && panelWindow.isVisible()) panelWindow.hide();
    if (dashboardStage) setPetStage(dashboardStage);
    broadcastState();
  };
  if (dashboardWindow.webContents.isLoading()) dashboardWindow.webContents.once('did-finish-load', reveal);
  else reveal();
}

/** "−": the dashboard closes and she goes back to the desktop, where she was. */
function toCompanion() {
  undockPet();
  if (alive(dashboardWindow)) dashboardWindow.hide();
  broadcastState();
}

/**
 * The dashboard says where her tile is (page pixels) and how tall it is: the
 * character's window sits on it, feet on the bottom, as a child of the
 * dashboard (in front of it, not of the other apps).
 */
function setPetStage(stage) {
  if (stage && Number.isFinite(stage.height)) dashboardStage = stage;
  if (!alive(dashboardWindow) || !dashboardWindow.isVisible() || !alive(petWindow)) return;
  if (!stage || !Number.isFinite(stage.x) || !Number.isFinite(stage.height) || stage.height < 80) return;
  dashboardStage = stage;
  const first = !petDock;
  if (first) {
    // Opened from the island: back to her normal width first, so "−" returns her exactly here.
    narrowIsland();
    petDock = { before: petWindow.getBounds(), stage, scale: settings.scale };
    physics.state = 'docked';
    petWindow.setAlwaysOnTop(false);
    petWindow.setParentWindow(dashboardWindow);
    if (!petWindow.isVisible()) petWindow.showInactive();
  }
  petDock.stage = stage;
  petDock.scale = clamp(stage.height / BASE_HEIGHT, 0.4, 1.3);
  petWide = false;
  dockPet();
  if (first) broadcastState();
}

function dockPet() {
  if (!petDock || !alive(petWindow) || !alive(dashboardWindow)) return;
  const content = dashboardWindow.getContentBounds();
  const { stage } = petDock;
  const { width, height } = petSize();
  const x = Math.round(content.x + stage.x + (stage.width - width) / 2);
  const y = Math.round(content.y + stage.y + stage.height - height);
  const now = petWindow.getBounds();
  if (now.x !== x || now.y !== y || now.width !== width || now.height !== height) {
    petWindow.setResizable(true);
    petWindow.setBounds({ x, y, width, height });
    petWindow.setResizable(false);
  }
}

/** Out of the dashboard: back where she was, at her size, and physics restarts (she lands by herself). */
function undockPet() {
  if (!petDock) return;
  const { before } = petDock;
  petDock = null;
  if (!alive(petWindow)) return;
  petWindow.setParentWindow(null);
  const { width, height } = petSize();
  petWindow.setResizable(true);
  petWindow.setBounds({ x: before.x, y: before.y + before.height - height, width, height });
  petWindow.setResizable(false);
  if (settings.pinned) petWindow.setAlwaysOnTop(true, 'screen-saver');
  physics.state = 'falling';
  physics.snap();
  petWindow.showInactive();
}

handleIpc('dashboard:open', () => showDashboard());
handleIpc('dashboard:minimize', () => toCompanion());
handleIpc('dashboard:toggle-maximize', () => {
  if (!alive(dashboardWindow)) return false;
  if (dashboardWindow.isMaximized()) dashboardWindow.unmaximize();
  else dashboardWindow.maximize();
  return dashboardWindow.isMaximized();
});
handleIpc('dashboard:start-with', (_event, value) => {
  settings.startWith = value === 'companion' ? 'companion' : 'dashboard';
  saveSettings();
  broadcastState();
  return settings.startWith;
});
onIpc('dashboard:stage', (event, stage) => {
  // Only the dashboard knows where her corner is.
  if (alive(dashboardWindow) && event.sender === dashboardWindow.webContents) setPetStage(stage);
});

// ---------------------------------------------------------------------------
// Notification area icon: always reachable, in ghost mode too (when clicks
// go through the character and a right-click on her no longer arrives).
// ---------------------------------------------------------------------------
let tray = null;

/** A minimal PNG generated on the fly: a circle in the accent colour, no file to ship. */
function trayImage(size = 32) {
  const pixels = Buffer.alloc(size * (size * 4 + 1));
  const center = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    pixels[row] = 0; // PNG filter "none" for the row
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
  header[8] = 8; // bits per channel
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
  tray.setToolTip(APP_NAME);
  tray.on('click', () => showDashboard());
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Dashboard', click: () => showDashboard() },
      { label: t('Open the chat'), click: () => showPanel({ tab: 'chat' }) },
      { label: t('Character'), click: () => showPanel({ tab: 'character' }) },
      { label: t('Engines'), click: () => showPanel({ tab: 'engines' }) },
      { label: t('Show the commands beside her'), click: () => sendToPet('pet:command', { type: 'hud' }) },
      { label: t('Look at the screen'), click: () => sendToPet('pet:command', { type: 'look-screen' }) },
      { type: 'separator' },
      {
        label: t('Ghost mode'),
        type: 'checkbox',
        checked: ghostMode,
        click: toggleGhost,
      },
      {
        label: t('Always in front of windows'),
        type: 'checkbox',
        checked: settings.pinned,
        click: togglePinned,
      },
      { type: 'separator' },
      { label: t('Restart'), click: () => restartBackend() },
      { label: t('Open the log'), click: () => shell.openPath(LOG_FILE) },
      { type: 'separator' },
      { label: t('Quit'), click: () => app.quit() },
    ]),
  );
}

// ---------------------------------------------------------------------------
// IPC (the counterparts are in preload.js)
// ---------------------------------------------------------------------------
/** The renderer says whether the cursor is over an opaque pixel of the character. */
onIpc('pet:set-interactive', (_event, value) => applyInteractive(Boolean(value)));
/**
 * "Look at the screen": a screenshot of the screen with the cursor, saved in
 * the temporary files. Only on explicit request (chat, voice, menu), never
 * by itself.
 */
async function captureScreen() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const size = {
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor),
  };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  const source = sources.find((item) => item.display_id === String(display.id)) ?? sources[0];
  if (!source || source.thumbnail.isEmpty()) throw new Error(t('No screen to capture'));
  const folder = path.join(app.getPath('temp'), 'tsukumo');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `screen-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
  fs.writeFileSync(file, source.thumbnail.toPNG());
  return file;
}

handleIpc('pet:capture-screen', () => captureScreen());

// Reminders and notifications: even with the character covered or in full screen.
onIpc('pet:notify', (_event, { title, body } = {}) => {
  if (!Notification.isSupported()) return;
  new Notification({
    title: String(title || APP_NAME),
    body: String(body || ''),
    icon: path.join(__dirname, 'icon.ico'),
    silent: true,
  }).show();
});

handleIpc('pet:drag-start', () => {
  // In the dashboard she stays still in her corner: the page needs the position anyway.
  if (petDock) {
    const [x, y] = petWindow.getPosition();
    return { x, y };
  }
  // The island closes as she is lifted: narrow the window now, or the drag
  // would carry on from the wide window's corner and she would jump aside.
  narrowIsland();
  physics.grab();
  const [x, y] = petWindow.getPosition();
  return { x, y };
});

onIpc('pet:drag-move', (_event, { x, y } = {}) => {
  if (physics.state !== 'held' || !alive(petWindow)) return;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  petWindow.setPosition(Math.round(x), Math.round(y));
});

handleIpc('pet:drag-end', (_event, velocity) => {
  // Physics checks the speed (finite numbers, capped): here it just passes through.
  if (physics.state === 'held') physics.release(velocity);
  return true;
});

handleIpc('pet:island', (_event, open) => setIslandWide(Boolean(open)));

/** Where feet, seat and body axis are in the window (fractions). */
onIpc('pet:anchors', (_event, anchors) => physics.setAnchors(anchors));

/** The interface's language (frontend/src/i18n.js): the tray menu follows it. */
onIpc('app:language', (_event, value) => {
  const language = i18n.setLanguage(value);
  if (language === settings.language) return;
  settings.language = language;
  saveSettings();
  updateTrayMenu();
});

handleIpc('pet:posture', (_event, posture) => (petDock ? false : physics.requestPosture(posture)));
// The flame's sprint: the renderer decides when, physics does the run.
handleIpc('pet:sprint', (_event, kind) => (petDock ? false : physics.sprint(kind)));

handleIpc('pet:scale-by', (_event, factor) => (petDock ? settings.scale : setScale(settings.scale * factor)));
handleIpc('pet:set-scale', (_event, value) => setScale(Number(value)));

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
  interactive = null; // forces it to be applied again
  applyInteractive(false);
  broadcastState();
  return ghostMode;
}

handleIpc('pet:toggle-always-on-top', togglePinned);
handleIpc('pet:toggle-ghost', toggleGhost);

handleIpc('pet:set-windows', (_event, value) => {
  settings.windows = Boolean(value);
  physics.windowsEnabled = settings.windows;
  saveSettings();
  broadcastState();
  return settings.windows;
});

/** Chooses another .vrm model and passes it to the character as binary data. */
handleIpc('pet:pick-model', async () => {
  const result = await dialog.showOpenDialog(alive(panelWindow) ? panelWindow : petWindow, {
    title: t('Choose a VRM model'),
    filters: [{ name: t('VRM models'), extensions: ['vrm'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return false;
  const file = result.filePaths[0];
  const data = await fs.promises.readFile(file);
  sendToPet('pet:model', { name: path.basename(file), data });
  // Installed: it becomes the avatar of all the next starts (the backend prefers avatar.vrm).
  if (PACKAGED) {
    fs.promises.writeFile(path.join(AVATAR_DIR, 'avatar.vrm'), data).catch((error) => console.error('[electron] avatar not saved:', error.message));
  }
  return true;
});

/** Commands from the panel to the character (mouth gain, actions, debug...). */
onIpc('pet:command', (_event, command) => sendToPet('pet:command', command));

onIpc('panel:tab', (_event, tab) => {
  panelTab = String(tab || 'chat');
  sendToPet('pet:state', panelState());
});

handleIpc('panel:toggle', (_event, focus) => togglePanel(focus));
handleIpc('panel:open', (_event, focus) => showPanel(focus));
handleIpc('panel:hide', () => panelWindow?.hide());
handleIpc('panel:state', () => panelState());

handleIpc('panel:set-docked', (_event, value) => {
  settings.docked = Boolean(value);
  saveSettings();
  dockPanel();
  broadcastState();
  return settings.docked;
});

handleIpc('panel:set-pinned', (_event, value) => {
  settings.panelPinned = Boolean(value);
  saveSettings();
  panelWindow?.setAlwaysOnTop(settings.panelPinned);
  broadcastState();
  return settings.panelPinned;
});

// ---------------------------------------------------------------------------
// Voice: global shortcut for push-to-talk
// ---------------------------------------------------------------------------
// Electron reports only the *press* of a global shortcut, never the
// release: a system-wide "press and hold" can't be done without a native
// keyboard hook (one more compiled dependency, which antivirus software
// tends to flag as a keylogger, too).
//
// So: outside the window the key works as a toggle (press = talk, press =
// I'm done), inside the window the renderer uses real keydown/keyup and
// press-and-hold works as expected.
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
      // Registration refused: almost always the key is already taken by another
      // application.
      return { ok: false, key, error: t('The shortcut {key} is already in use.', { key }) };
    }
    pushToTalkKey = key;
    return { ok: true, key };
  } catch (error) {
    return { ok: false, key, error: String(error.message ?? error) };
  }
}

handleIpc('voice:set-key', (_event, key) => registerPushToTalk(key));

onIpc('voice:state', (_event, state) => {
  voiceState = state ?? {};
  sendToPanel('voice:command', { type: 'state', ...voiceState });
});

handleIpc('app:quit', () => app.quit());

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
// One mascot at a time: a second start shows the one already there.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (alive(petWindow)) petWindow.show();
    showDashboard();
  });

  app.whenReady().then(async () => {
    console.log(`[electron] ${APP_NAME} ${app.getVersion()} starting`);
    guardPermissions();
    loadSettings();
    // The pages say the language at every start; until then, the last one or the system's.
    i18n.setLanguage(settings.language ?? ((app.getPreferredSystemLanguages?.()[0] ?? app.getLocale()).toLowerCase().startsWith('it') ? 'it' : 'en'));
    physics.windowsEnabled = settings.windows;

    // Windows first, then the backend: she appears right away with the waiting
    // card instead of making you think the double click didn't work.
    createPetWindow();
    createTray();
    setInterval(tick, TICK_MS);
    setInterval(keepOnTop, ON_TOP_MS);
    setInterval(pollMusic, MUSIC_POLL_MS);
    watchPresence();

    const key = process.env.DC_PUSH_TO_TALK_KEY || settings.pushToTalkKey || 'Control+Space';
    const shortcut = registerPushToTalk(key);
    if (!shortcut.ok) console.warn(`[electron] push-to-talk: ${shortcut.error}`);

    const backend = await ensureBackend();
    if (!backend.ok) {
      showBackendError(backend);
      return;
    }
    backendUp = true;
    loadApp(petWindow, petUrl());
    createPanelWindow();
    // First time: the panel opens by itself with the introduction (panel/welcome.js).
    if (firstRun) {
      // From here on it's no longer the first time, even if no setting changes.
      saveSettings();
      setTimeout(() => showPanel({ tab: 'chat', welcome: true }), 2500);
    } else if (settings.startWith === 'dashboard' && process.env.DC_NO_DASHBOARD !== '1') {
      showDashboard();
    }
  });
}

app.on('before-quit', () => {
  app.isQuitting = true;
  stopBackend();
});

// Without this the shortcut stays registered and other applications can't
// use that combination any more until the system restarts.
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  stopBackend();
  app.quit();
});

process.on('exit', stopBackend);
