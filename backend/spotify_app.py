"""Spotify's desktop app, without the Web API: Free accounts, or no account connected.

Choosing a track through the Web API needs Premium, but the desktop app
plays whatever its own Play buttons are pressed on, Free included. So the
search is opened with a ``spotify:search:`` link and its results are read
through UI Automation (what the app tells screen readers, never mouse
coordinates): each result is a row with its title, its artists' links and its
own Play button. The row of the track the brain named is picked here, the
Play button inside it is invoked (the player bar has a "Play" of its own,
which would resume the old track), and the window title ("Artist - Title"
while playing) confirms it.

The brain only gives an artist and a title: they reach PowerShell as data in
an environment variable, never inside the script, and the only link it can
open is a Spotify search.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import subprocess
import time
import unicodedata
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

logger = logging.getLogger(__name__)

#: The search page can take a while, more if Spotify has to start.
LIST_TIMEOUT = 20.0
PLAY_TIMEOUT = 12.0

_PAUSED_TITLE = re.compile(r"^Spotify( Premium| Free)?$", re.IGNORECASE)
_QUOTES = " 	\"'“”«»‘’"
#: The library is read again after this long (it changes when you listen to something else).
LIBRARY_SECONDS = 600.0
#: A row's Play button: "Play" on the top result, "Riproduci Hajnal2" on the others.
_PLAY_BUTTON = re.compile(r"^\s*(?:play|riproduci|reproducir|lire|abspielen|wiedergeben|tocar|reproduzir)(?:\s|$)", re.IGNORECASE)
#: Rows read from the results: the top ones are where the track is, if it's there.
MAX_ROWS = 20

#: Spotify's words for its Play and Pause buttons, in the languages it's likely set to.
_PLAY_WORDS = "play|riproduci|reproducir|lire|abspielen|wiedergeben|tocar|reproduzir"
_PAUSE_WORDS = "pause|pausa|pausar|pausieren|mettre en pause"
#: The side bar's grid: "La tua libreria", "Your Library", "Tu biblioteca"...
_LIBRARY_GRID = "(?i)librer|library|biblio"
#: Library rows read: only those on screen are in the tree anyway.
MAX_LIBRARY = 40

# Mode "list" opens the search, waits until a result row names the track (or
# time runs out) and hands back the rows: name, links (title, artists),
# buttons. Mode "play" finds the same row again, invokes the button chosen
# here inside it and waits for the window title to change. Mode "library"
# reads the side bar (each row's label and the item's own name); mode
# "playlist" opens one of its rows and presses the page's own Play, named
# after it ("Riproduci 🎐"), or finds its Pause: already playing.
_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$req = $env:DC_SPOTIFY_APP | ConvertFrom-Json
$AE = [System.Windows.Automation.AutomationElement]
$CT = [System.Windows.Automation.ControlType]
$TS = [System.Windows.Automation.TreeScope]
function Kind($type) { New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $type) }
function Window { Get-Process spotify -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1 }
# The window holds several grids (the library on the side, related videos):
# the results are "Search results" with the track in it; any other grid with
# it only when that never shows up (the library may hold the same track).
function Rows($needle, $any) {
  $w = Window
  if (-not $w) { return @() }
  $grids = @($AE::FromHandle($w.MainWindowHandle).FindAll($TS::Descendants, (Kind $CT::DataGrid)) | Where-Object { $any -or $_.Current.Name -eq 'Search results' })
  foreach ($grid in $grids) {
    $rows = @($grid.FindAll($TS::Children, (Kind $CT::DataItem)) | Select-Object -First __MAX__)
    if ($rows | Where-Object { $_.Current.Name.ToLower().Contains($needle) }) { return $rows }
  }
  @()
}
function Library {
  $w = Window
  if (-not $w) { return $null }
  @($AE::FromHandle($w.MainWindowHandle).FindAll($TS::Descendants, (Kind $CT::DataGrid)) | Where-Object { $_.Current.Name -match $req.grid })[0]
}
function WaitTitle($before) {
  $deadline = (Get-Date).AddSeconds($req.wait)
  $title = $before
  do {
    Start-Sleep -Milliseconds 400
    $w = Window
    if ($w) { $title = $w.MainWindowTitle }
  } while ($title -eq $before -and (Get-Date) -lt $deadline)
  $title
}
function Names($row, $type) { @($row.FindAll($TS::Descendants, (Kind $type)) | ForEach-Object { $_.Current.Name } | Where-Object { $_ }) }
if ($req.mode -eq 'list') {
  if ($req.uri -notmatch '^spotify:search:[^\s]+$') { throw 'not a Spotify search' }
  Start-Process $req.uri
  $deadline = (Get-Date).AddSeconds($req.wait)
  $rows = @()
  do {
    Start-Sleep -Milliseconds 500
    try { $rows = @(Rows $req.expect $false) } catch { $rows = @() }
  } while ($rows.Count -eq 0 -and (Get-Date) -lt $deadline)
  if ($rows.Count -eq 0) { $rows = @(Rows $req.expect $true) }
  $out = @(foreach ($r in $rows) {
    try { @{ name = $r.Current.Name; links = (Names $r $CT::Hyperlink); buttons = (Names $r $CT::Button) } } catch {}
  })
  ConvertTo-Json -InputObject @{ rows = $out } -Depth 4 -Compress
} elseif ($req.mode -eq 'play') {
  $w = Window
  if (-not $w) { throw 'Spotify has no window' }
  $before = $w.MainWindowTitle
  $rows = @(Rows $req.name.ToLower() $false)
  if ($rows.Count -eq 0) { $rows = @(Rows $req.name.ToLower() $true) }
  if ($rows.Count -le $req.row -or $rows[$req.row].Current.Name -ne $req.name) { throw 'the results changed' }
  $named = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, [string]$req.button)
  $both = New-Object System.Windows.Automation.AndCondition((Kind $CT::Button), $named)
  $button = $rows[$req.row].FindFirst($TS::Descendants, $both)
  if (-not $button) { throw 'the button is gone' }
  $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  ConvertTo-Json -InputObject @{ title = (WaitTitle $before) } -Compress
} elseif ($req.mode -eq 'library') {
  $grid = Library
  $out = @()
  if ($grid) {
    $out = @(foreach ($r in @($grid.FindAll($TS::Children, (Kind $CT::DataItem)) | Select-Object -First $req.max)) {
      try {
        $label = $r.Current.Name
        $group = $r.FindFirst($TS::Descendants, (Kind $CT::Group))
        if ($label -and $group) { @{ label = $label; name = $group.Current.Name } }
      } catch {}
    })
  }
  ConvertTo-Json -InputObject @{ items = $out } -Compress
} elseif ($req.mode -eq 'playlist') {
  $grid = Library
  if (-not $grid) { throw 'no library' }
  $row = @($grid.FindAll($TS::Children, (Kind $CT::DataItem)) | Where-Object { $_.Current.Name -eq $req.label })[0]
  if (-not $row) { throw 'the library changed' }
  $before = (Window).MainWindowTitle
  $row.FindFirst($TS::Descendants, (Kind $CT::Button)).GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  $play = '^(?:' + $req.play + ')\s+' + [regex]::Escape($req.name) + '$'
  $pause = '^(?:' + $req.pause + ')\s+' + [regex]::Escape($req.name) + '$'
  $deadline = (Get-Date).AddSeconds($req.wait)
  $button = $null; $playing = $false
  do {
    Start-Sleep -Milliseconds 400
    $w = Window
    if (-not $w) { continue }
    foreach ($b in $AE::FromHandle($w.MainWindowHandle).FindAll($TS::Descendants, (Kind $CT::Button))) {
      $n = $b.Current.Name
      if ($n -match $play) { $button = $b; break }
      if ($n -match $pause) { $playing = $true; break }
    }
  } while (-not $button -and -not $playing -and (Get-Date) -lt $deadline)
  if ($playing) {
    ConvertTo-Json -InputObject @{ title = $before; already = $true } -Compress
  } else {
    if (-not $button) { throw 'no Play on its page' }
    $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    ConvertTo-Json -InputObject @{ title = (WaitTitle $before) } -Compress
  }
}
""".replace("__MAX__", str(MAX_ROWS))


class AppError(RuntimeError):
    """The app couldn't play it; ``reason`` is one of ours (APP_NOT_FOUND...)."""

    def __init__(self, message: str, reason: str) -> None:
        super().__init__(message)
        self.reason = reason


@dataclass(frozen=True)
class AppState:
    open: bool = False
    playing: bool = False
    artist: str = ""
    title: str = ""


# ---------------------------------------------------------------------------
# Matching: pure, so it's tested with real button names
# ---------------------------------------------------------------------------
def _words(text: str) -> list[str]:
    plain = "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c))
    return re.sub(r"[^\w]+", " ", plain.casefold()).split()


def _core(title: str) -> str:
    """ "Song (feat. X) - Remastered 2011" -> "Song": what every version of it shares."""
    return re.split(r"\s+[-–—]\s+|\s*[(\[]", title, maxsplit=1)[0]


def split_item(item: str) -> tuple[str, str]:
    """The tag's "Artist - Title" -> ``(artist, title)``; just a title -> ``("", title)``."""
    parts = re.split(r"\s+[-–—]\s+", item.strip(), maxsplit=1)
    return (parts[0].strip(), parts[1].strip()) if len(parts) == 2 else ("", item.strip())


def parse_title(title: str) -> AppState:
    """The window title: "Artist - Title" while playing, "Spotify Free" when paused."""
    if not title or _PAUSED_TITLE.match(title) or " - " not in title:
        return AppState(open=bool(title))
    artist, _, name = title.partition(" - ")
    return AppState(open=True, playing=True, artist=artist.strip(), title=name.strip())


def same_track(state: AppState, artist: str, title: str) -> bool:
    """Is the app playing the track asked for? Remasters and live versions count as it."""
    if not state.playing:
        return False
    want = set(_words(_core(title)))
    if not want or not want <= set(_words(state.title)):
        return False
    return not artist or bool(set(_words(artist)) & set(_words(state.artist)))


@dataclass(frozen=True)
class Row:
    """One search result: its name, its links (the title, the artists), its buttons."""

    name: str
    links: tuple[str, ...] = ()
    buttons: tuple[str, ...] = ()

    @classmethod
    def from_json(cls, item: Any) -> Row | None:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            return None

        def names(value: Any) -> tuple[str, ...]:
            # PowerShell turns a list of one into the item itself.
            values = [value] if isinstance(value, str) else value if isinstance(value, list) else []
            return tuple(v for v in values if isinstance(v, str))

        return cls(item["name"], names(item.get("links")), names(item.get("buttons")))


def pick_row(rows: list[Row], artist: str, title: str) -> tuple[int, str] | None:
    """The row of that track and its Play button: ``(index, button name)``, or ``None``.

    The title must be the row's whole name, or all of it (a remaster); the
    artist, when given, must be among the row's links, so a playlist or a
    cover by someone else isn't taken; the top rows are the best matches.
    """
    want = _words(_core(title))
    if not want:
        return None
    artist_words = set(_words(artist))
    best: tuple[float, int, str] | None = None
    for index, row in enumerate(rows):
        button = next((name for name in row.buttons if _PLAY_BUTTON.match(name)), None)
        if button is None:
            continue
        name = _words(row.name)
        if name == _words(title):
            score = 30.0  # the very version asked for
        elif _words(_core(row.name)) == want:
            score = 20.0
        elif set(want) <= set(name):
            score = 10.0 - 0.5 * len(set(name) - set(want))
        else:
            continue
        if artist_words:
            others = set().union(*(_words(link) for link in row.links if _words(link) != name))
            if not artist_words & others:
                continue
            score += 5.0 * (artist_words <= others)
        score -= 0.01 * index
        if best is None or score > best[0]:
            best = (score, index, button)
    return (best[1], best[2]) if best else None


@dataclass(frozen=True)
class LibraryItem:
    """A row of the app's library: the item's own name ("🎐") and its label ("🎐 In evidenza Playlist • tsuki")."""

    name: str
    label: str


def pick_library(items: list[LibraryItem], wanted: str) -> LibraryItem | None:
    """The library item the brain named: its name, the start of its label, or all its words."""
    want = wanted.strip().strip(_QUOTES).casefold()
    if not want:
        return None
    for item in items:
        if item.name.strip().casefold() == want:
            return item
    for item in items:
        if item.label.casefold().startswith(want):
            return item
    words = set(_words(want))
    fits = [item for item in items if words and words <= set(_words(item.label))]
    return min(fits, key=lambda item: len(_words(item.label))) if fits else None


# ---------------------------------------------------------------------------
# Windows
# ---------------------------------------------------------------------------
def _available() -> bool:
    """Spotify's app is installed: it answers the ``spotify:`` links."""
    if os.name != "nt":
        return False
    import winreg

    try:
        winreg.CloseKey(winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, "spotify"))
    except OSError:
        return False
    return True


def _window_title() -> str:
    """The title of Spotify.exe's window with text, '' if it isn't open."""
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32")
    kernel32 = ctypes.WinDLL("kernel32")
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel32.QueryFullProcessImageNameW.argtypes = (wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD))
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    names: dict[int, str] = {}
    found: list[str] = []

    def process_name(pid: int) -> str:
        if pid not in names:
            names[pid] = ""
            handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
            if handle:
                try:
                    buffer = ctypes.create_unicode_buffer(520)
                    size = wintypes.DWORD(520)
                    if kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
                        names[pid] = buffer.value.rsplit("\\", 1)[-1].lower()
                finally:
                    kernel32.CloseHandle(handle)
        return names[pid]

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def visit(hwnd: int, _: int) -> bool:
        length = user32.GetWindowTextLengthW(hwnd)
        if length:
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if process_name(pid.value) == "spotify.exe":
                buffer = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, buffer, length + 1)
                found.append(buffer.value)
        return True

    user32.EnumWindows(visit, 0)
    # Spotify owns a few titled windows ("GDI+ Window (Spotify.exe)"...): only the main one
    # says "Artist - Title" or "Spotify Free".
    return next((title for title in found if " - " in title), next((t for t in found if _PAUSED_TITLE.match(t)), ""))


def _run(args: dict[str, Any], timeout: float) -> dict[str, Any]:
    encoded = base64.b64encode(_SCRIPT.encode("utf-16-le")).decode("ascii")
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
        capture_output=True,
        timeout=timeout,
        env={**os.environ, "DC_SPOTIFY_APP": json.dumps(args)},
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if result.returncode != 0:
        # -EncodedCommand reports errors as CLIXML: the first error line is the message.
        error = result.stderr.decode("utf-8", "replace")
        found = re.search(r'<S S="Error">(.*?)(?:_x000D_)?(?:_x000A_)?</S>', error)
        raise RuntimeError(found.group(1) if found else error.strip()[:200] or "PowerShell failed")
    data = json.loads(result.stdout.decode("utf-8", "replace") or "{}")
    return data if isinstance(data, dict) else {}


class SpotifyApp:
    """Spotify's desktop app, seen and pressed from outside."""

    def __init__(self) -> None:
        self._available: bool | None = None
        self._library: tuple[float, list[LibraryItem]] = (0.0, [])

    @property
    def available(self) -> bool:
        if self._available is None:
            self._available = _available()
        return self._available

    async def state(self) -> AppState:
        if os.name != "nt":
            return AppState()
        return parse_title(await asyncio.to_thread(_window_title))

    async def play(self, item: str) -> AppState:
        """Plays "Artist - Title" in the app; what the app shows afterwards.

        Raises ``AppError`` if the track isn't there or something else starts.
        A title that isn't "Artist - Title" (an ad, still loading) isn't a
        refusal: Free plays ads, and the track follows them.
        """
        if not self.available:
            raise AppError("Spotify's app isn't installed here.", "NO_APP")
        artist, title = split_item(item)
        before = await self.state()
        if same_track(before, artist, title):
            return before  # pressing its button now would pause it
        query = f"{title} {artist}".strip()
        try:
            listed = await asyncio.to_thread(
                _run,
                {"mode": "list", "uri": "spotify:search:" + quote(query, safe=""), "expect": _core(title).lower(), "wait": 12},
                LIST_TIMEOUT,
            )
        except (OSError, RuntimeError, subprocess.TimeoutExpired, ValueError) as exc:
            logger.info("Spotify app: search failed (%s)", exc)
            raise AppError("Spotify's app isn't answering.", "APP_DOWN") from exc
        raw = listed.get("rows") or []
        rows = [row for row in map(Row.from_json, raw if isinstance(raw, list) else [raw]) if row]
        picked = pick_row(rows, artist, title)
        if picked is None:
            logger.info("Spotify app: %r not among %d results", item, len(rows))
            raise AppError("I didn't find that song in Spotify's app.", "APP_NOT_FOUND")
        index, button = picked
        try:
            pressed = await asyncio.to_thread(
                _run, {"mode": "play", "row": index, "name": rows[index].name, "button": button, "wait": 8}, PLAY_TIMEOUT
            )
        except (OSError, RuntimeError, subprocess.TimeoutExpired, ValueError) as exc:
            logger.info("Spotify app: %r not pressed (%s)", rows[index].name, exc)
            raise AppError("Spotify's app isn't answering.", "APP_DOWN") from exc
        after = parse_title(str(pressed.get("title") or ""))
        if after.playing and not same_track(after, artist, title):
            raise AppError("I pressed Play, but Spotify is playing something else.", "APP_OTHER")
        logger.info("Spotify app: %s, %s (%s)", rows[index].name, button, "confirmed" if after.playing else "not shown yet")
        return after

    async def library(self, max_age: float = LIBRARY_SECONDS) -> list[LibraryItem]:
        """The playlists, albums and artists in the app's side bar, top first; [] if it's closed."""
        at, items = self._library
        if items and time.monotonic() - at < max_age:
            return items
        if not self.available or not (await self.state()).open:
            return []
        try:
            data = await asyncio.to_thread(_run, {"mode": "library", "grid": _LIBRARY_GRID, "max": MAX_LIBRARY}, LIST_TIMEOUT)
        except (OSError, RuntimeError, subprocess.TimeoutExpired, ValueError) as exc:
            logger.info("Spotify app: library unreadable (%s)", exc)
            return items
        raw = data.get("items") or []
        items = [
            LibraryItem(str(entry["name"]), str(entry["label"]))
            for entry in (raw if isinstance(raw, list) else [raw])
            if isinstance(entry, dict) and entry.get("name") and entry.get("label")
        ]
        self._library = (time.monotonic(), items)
        return items

    async def play_playlist(self, wanted: str) -> AppState:
        """Opens a playlist (or album, or artist) of the library and presses its Play."""
        if not self.available:
            raise AppError("Spotify's app isn't installed here.", "NO_APP")
        if not (await self.state()).open:
            raise AppError("Spotify's app isn't open: open it and ask me again.", "APP_CLOSED")
        item = pick_library(await self.library(), wanted)
        if item is None:
            item = pick_library(await self.library(max_age=0), wanted)
        if item is None:
            raise AppError("I didn't find that playlist in your Spotify library.", "NO_PLAYLIST")
        args = {"mode": "playlist", "grid": _LIBRARY_GRID, "label": item.label, "name": item.name}
        try:
            result = await asyncio.to_thread(
                _run, {**args, "play": _PLAY_WORDS, "pause": _PAUSE_WORDS, "wait": 8}, LIST_TIMEOUT
            )
        except (OSError, RuntimeError, subprocess.TimeoutExpired, ValueError) as exc:
            logger.info("Spotify app: %r not played (%s)", item.label, exc)
            raise AppError("Spotify's app isn't answering.", "APP_DOWN") from exc
        logger.info("Spotify app: playlist %s (%s)", item.label, "already playing" if result.get("already") else "pressed")
        return parse_title(str(result.get("title") or ""))
