/**
 * Cosa sta suonando Spotify, senza login e senza API web.
 *
 * L'app desktop di Spotify mette nel titolo della sua finestra principale
 * "Artista - Titolo" mentre suona, e "Spotify" / "Spotify Premium" /
 * "Spotify Free" quando e' in pausa. Basta quindi trovare le finestre del
 * processo Spotify.exe e leggerne il titolo (funziona anche con la finestra
 * ridotta nell'area di notifica). Le API web con BPM ed "energy" delle tracce
 * non sono piu' disponibili per le app nuove: il ritmo lo ricava il renderer
 * ascoltando l'audio di sistema (vedi frontend/src/music.js).
 *
 * Modulo separato da desktop.js: se qualcosa qui fallisce, la fisica delle
 * finestre continua a funzionare.
 */

let api = null;

function load() {
  if (api !== null || process.platform !== 'win32') return api;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const EnumProc = koffi.proto('bool __stdcall DcSpotifyEnumProc(intptr_t hwnd, intptr_t lParam)');
    api = {
      koffi,
      EnumProc,
      EnumWindows: user32.func('bool __stdcall EnumWindows(DcSpotifyEnumProc *proc, intptr_t lParam)'),
      GetWindowTextLengthW: user32.func('int __stdcall GetWindowTextLengthW(intptr_t hwnd)'),
      GetWindowTextW: user32.func('int __stdcall GetWindowTextW(intptr_t hwnd, _Out_ void *buffer, int max)'),
      GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32 *pid)'),
      OpenProcess: kernel32.func('intptr_t __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)'),
      QueryFullProcessImageNameW: kernel32.func(
        'bool __stdcall QueryFullProcessImageNameW(intptr_t process, uint32 flags, _Out_ void *buffer, _Inout_ uint32 *size)',
      ),
      CloseHandle: kernel32.func('bool __stdcall CloseHandle(intptr_t handle)'),
    };
  } catch (error) {
    console.error('[spotify] rilevamento non disponibile (koffi):', error.message);
    api = false;
  }
  return api;
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const PAUSED_TITLE = /^Spotify( Premium| Free)?$/i;

/** Nome dell'eseguibile per PID, in cache: i PID dei processi cambiano di rado. */
const processNames = new Map();
let processNamesAt = 0;

function processName(pid) {
  if (Date.now() - processNamesAt > 60_000) {
    processNames.clear();
    processNamesAt = Date.now();
  }
  if (processNames.has(pid)) return processNames.get(pid);
  let name = '';
  const handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (handle) {
    try {
      const buffer = Buffer.alloc(1040);
      const size = [520];
      if (api.QueryFullProcessImageNameW(handle, 0, buffer, size)) {
        name = buffer.toString('utf16le', 0, size[0] * 2).split('\\').pop().toLowerCase();
      }
    } finally {
      api.CloseHandle(handle);
    }
  }
  processNames.set(pid, name);
  return name;
}

function windowTitle(hwnd, length) {
  const buffer = Buffer.alloc((length + 1) * 2);
  const copied = api.GetWindowTextW(hwnd, buffer, length + 1);
  return buffer.toString('utf16le', 0, Math.max(0, copied) * 2);
}

/**
 * @returns {{open: boolean, playing: boolean, artist: string, title: string}}
 */
function status() {
  const result = { open: false, playing: false, artist: '', title: '' };
  if (!load()) return result;
  let track = null;
  const callback = api.koffi.register((hwnd) => {
    try {
      const length = api.GetWindowTextLengthW(hwnd);
      if (length === 0) return true;
      const pid = [0];
      api.GetWindowThreadProcessId(hwnd, pid);
      if (processName(pid[0]) !== 'spotify.exe') return true;
      const title = windowTitle(hwnd, length);
      result.open = true;
      if (!PAUSED_TITLE.test(title) && title.includes(' - ') && !track) track = title;
    } catch {
      /* finestra sparita mentre la leggevamo */
    }
    return true;
  }, api.koffi.pointer(api.EnumProc));
  try {
    api.EnumWindows(callback, 0);
  } finally {
    api.koffi.unregister(callback);
  }
  if (track) {
    const cut = track.indexOf(' - ');
    result.playing = true;
    result.artist = track.slice(0, cut).trim();
    result.title = track.slice(cut + 3).trim();
  }
  return result;
}

module.exports = { status };
