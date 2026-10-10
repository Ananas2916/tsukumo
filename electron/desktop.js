/**
 * Other programs' windows, as the mascot sees them.
 *
 * Desktop Mate makes its characters sit on the top edge of windows and
 * travel with them. Electron knows nothing about other apps' windows, so we
 * ask Windows directly (user32/dwmapi) through koffi, an FFI with prebuilt
 * binaries: nothing to compile, no external processes.
 *
 * Everything coming out of here is in logical pixels (DIP), the same units
 * as BrowserWindow.setPosition: Windows reasons in physical pixels, and with
 * the screen scaled to 125-150% the difference is far from negligible.
 *
 * On macOS and Linux the module does nothing: only the floor and the edges
 * remain.
 */

const { screen } = require('electron');

let api = null;

function load() {
  if (api !== null || process.platform !== 'win32') return api;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const dwmapi = koffi.load('dwmapi.dll');
    const kernel32 = koffi.load('kernel32.dll');

    const RECT = koffi.struct('DC_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
    const EnumProc = koffi.proto('bool __stdcall DcEnumWindowsProc(intptr_t hwnd, intptr_t lParam)');

    api = {
      koffi,
      EnumProc,
      EnumWindows: user32.func('bool __stdcall EnumWindows(DcEnumWindowsProc *proc, intptr_t lParam)'),
      IsWindow: user32.func('bool __stdcall IsWindow(intptr_t hwnd)'),
      IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(intptr_t hwnd)'),
      IsIconic: user32.func('bool __stdcall IsIconic(intptr_t hwnd)'),
      IsZoomed: user32.func('bool __stdcall IsZoomed(intptr_t hwnd)'),
      GetWindowRect: user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ DC_RECT *rect)'),
      GetWindowLongPtrW: user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hwnd, int index)'),
      GetClassNameW: user32.func('int __stdcall GetClassNameW(intptr_t hwnd, _Out_ void *buffer, int max)'),
      GetWindowTextLengthW: user32.func('int __stdcall GetWindowTextLengthW(intptr_t hwnd)'),
      GetWindowTextW: user32.func('int __stdcall GetWindowTextW(intptr_t hwnd, _Out_ void *buffer, int max)'),
      GetForegroundWindow: user32.func('intptr_t __stdcall GetForegroundWindow()'),
      GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32 *pid)'),
      OpenProcess: kernel32.func('intptr_t __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)'),
      QueryFullProcessImageNameW: kernel32.func(
        'bool __stdcall QueryFullProcessImageNameW(intptr_t process, uint32 flags, _Out_ void *buffer, _Inout_ uint32 *size)',
      ),
      CloseHandle: kernel32.func('bool __stdcall CloseHandle(intptr_t handle)'),
      SetWindowPos: user32.func(
        'bool __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32 flags)',
      ),
      DwmRect: dwmapi.func(
        'long __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32 attribute, _Out_ DC_RECT *value, uint32 size)',
      ),
      DwmInt: dwmapi.func(
        'long __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32 attribute, _Out_ int32 *value, uint32 size)',
      ),
    };
  } catch (error) {
    console.error('[desktop] windows unavailable (koffi):', error.message);
    api = false;
  }
  return api;
}

const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x80;
const WS_EX_NOACTIVATE = 0x08000000;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const DWMWA_CLOAKED = 14;
const HWND_TOPMOST = -1;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const SWP_NOOWNERZORDER = 0x0200;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

/** Classes never to be considered "windows to sit on". */
const IGNORED_CLASSES = new Set([
  'Progman', // the desktop
  'WorkerW', // the animated wallpaper / the desktop
  'Shell_TrayWnd', // the taskbar: we treat it as the "floor"
  'Shell_SecondaryTrayWnd',
  'NotifyIconOverflowWindow',
  'TaskListThumbnailWnd',
  'Windows.UI.Core.CoreWindow',
  'XamlExplorerHostIslandWindow',
  'TopLevelWindowForOverflowXamlIsland',
]);

function className(hwnd) {
  const buffer = Buffer.alloc(512);
  const length = api.GetClassNameW(hwnd, buffer, 256);
  return buffer.toString('utf16le', 0, Math.max(0, length) * 2);
}

/** Visible rectangle (without Windows 10/11's invisible resize borders). */
function physicalRect(hwnd) {
  const rect = {};
  if (api.DwmRect(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, rect, 16) !== 0) {
    if (!api.GetWindowRect(hwnd, rect)) return null;
  }
  return rect;
}

function toDip(rect) {
  const physical = { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top };
  return screen.screenToDipRect(null, physical);
}

function isCloaked(hwnd) {
  const value = [0];
  return api.DwmInt(hwnd, DWMWA_CLOAKED, value, 4) === 0 && value[0] !== 0;
}

/**
 * Visible windows in depth order (the first is the one in front of all),
 * excluding ours. Only "real" windows, the ones you'd see with Alt+Tab: no
 * tool windows, no ghost windows of UWP apps.
 *
 * @param {Set<number>} own handles of the companion's windows
 * @returns {Array<{hwnd: number, x: number, y: number, width: number, height: number, maximized: boolean}>}
 */
function listWindows(own = new Set()) {
  if (!load()) return [];
  const found = [];
  const callback = api.koffi.register((hwnd) => {
    try {
      if (own.has(Number(hwnd))) return true;
      if (!api.IsWindowVisible(hwnd) || api.IsIconic(hwnd)) return true;
      const exStyle = Number(api.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
      if (exStyle & WS_EX_TOOLWINDOW || exStyle & WS_EX_NOACTIVATE) return true;
      if (isCloaked(hwnd)) return true;
      if (IGNORED_CLASSES.has(className(hwnd))) return true;
      if (api.GetWindowTextLengthW(hwnd) === 0) return true;
      const rect = physicalRect(hwnd);
      if (!rect) return true;
      const dip = toDip(rect);
      if (dip.width < 160 || dip.height < 80) return true;
      found.push({ hwnd: Number(hwnd), ...dip, maximized: api.IsZoomed(hwnd) });
    } catch {
      /* a window vanishing while we read it: we skip it */
    }
    return true;
  }, api.koffi.pointer(api.EnumProc));
  try {
    api.EnumWindows(callback, 0);
  } finally {
    api.koffi.unregister(callback);
  }
  return found;
}

/**
 * The updated rectangle of a single window, or `null` if it's gone,
 * minimized or hidden. It costs very little: it can be called every tick.
 */
function windowRect(hwnd) {
  if (!load()) return null;
  try {
    if (!api.IsWindow(hwnd) || !api.IsWindowVisible(hwnd) || api.IsIconic(hwnd) || isCloaked(hwnd)) return null;
    const rect = physicalRect(hwnd);
    return rect ? { ...toDip(rect), maximized: api.IsZoomed(hwnd) } : null;
  } catch {
    return null;
  }
}

function windowTitle(hwnd) {
  const length = api.GetWindowTextLengthW(hwnd);
  if (length <= 0) return '';
  const buffer = Buffer.alloc((length + 1) * 2);
  const read = api.GetWindowTextW(hwnd, buffer, length + 1);
  return buffer.toString('utf16le', 0, Math.max(0, read) * 2);
}

/** Executable name of a process (`Code.exe`), or '' if it can't be read. */
function processName(pid) {
  if (!pid) return '';
  const handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!handle) return '';
  try {
    const buffer = Buffer.alloc(2080);
    const size = [1040];
    if (!api.QueryFullProcessImageNameW(handle, 0, buffer, size)) return '';
    return buffer.toString('utf16le', 0, size[0] * 2).split('\\').pop();
  } finally {
    api.CloseHandle(handle);
  }
}

/**
 * The window the user is working in: title, program and whether it takes
 * the whole screen (a game, a full-screen video, a presentation). The
 * backend works out what they're doing from it (see backend/context.py).
 *
 * @param {Set<number>} own handles of the companion's windows
 * @returns {{title: string, exe: string, fullscreen: boolean, own: boolean}|null}
 */
function foregroundWindow(own = new Set()) {
  if (!load()) return null;
  try {
    const hwnd = api.GetForegroundWindow();
    if (!hwnd) return null;
    if (own.has(Number(hwnd))) return { title: '', exe: '', fullscreen: false, own: true };
    const pid = [0];
    api.GetWindowThreadProcessId(hwnd, pid);
    const klass = className(hwnd);
    const rect = physicalRect(hwnd);
    let fullscreen = false;
    if (rect && !IGNORED_CLASSES.has(klass)) {
      const dip = toDip(rect);
      const { bounds } = screen.getDisplayMatching(dip);
      fullscreen =
        dip.x <= bounds.x &&
        dip.y <= bounds.y &&
        dip.x + dip.width >= bounds.x + bounds.width &&
        dip.y + dip.height >= bounds.y + bounds.height;
    }
    return { title: windowTitle(hwnd), exe: processName(pid[0]), fullscreen, own: false };
  } catch {
    return null;
  }
}

/**
 * Brings a window back to the top of the "always on top" stack without
 * stealing focus. Windows reorders topmost windows every time one of them
 * activates (and the taskbar is one): without this periodic call the
 * character ended up behind the other windows.
 */
function keepOnTop(hwnd) {
  if (!load()) return false;
  return api.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
}

/** Native handle of a BrowserWindow, as a number comparable with listWindows'. */
function handleOf(browserWindow) {
  const buffer = browserWindow.getNativeWindowHandle();
  return buffer.length >= 8 ? Number(buffer.readBigUInt64LE(0)) : buffer.readUInt32LE(0);
}

module.exports = { available: () => Boolean(load()), listWindows, windowRect, keepOnTop, handleOf, foregroundWindow };
