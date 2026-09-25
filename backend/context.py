"""Cosa sta facendo l'utente al PC.

La shell Electron manda ogni 5 secondi (``POST /api/context``) da quanto nessuno
tocca mouse e tastiera, se lo schermo e' bloccato e la finestra in primo piano:
titolo, programma, schermo intero. Qui diventa un'*attivita'* ("sta
programmando in VS Code", "guarda un video su YouTube", "e' in riunione") che
serve a:

* commentare al momento giusto (e di cosa: il video, l'ora tarda...),
* non disturbare durante giochi, video a schermo intero e riunioni,
* non addormentarsi mentre l'utente guarda un video senza toccare niente.

Nessun dato esce dal PC: titoli e programmi restano nel backend.
"""

from __future__ import annotations

import re
import time
from dataclasses import asdict, dataclass, field
from typing import Any

#: Programmi riconosciuti, per nome dell'eseguibile (minuscolo).
CODING = {
    "code.exe": "VS Code",
    "code - insiders.exe": "VS Code",
    "cursor.exe": "Cursor",
    "windsurf.exe": "Windsurf",
    "zed.exe": "Zed",
    "devenv.exe": "Visual Studio",
    "idea64.exe": "IntelliJ IDEA",
    "pycharm64.exe": "PyCharm",
    "webstorm64.exe": "WebStorm",
    "rider64.exe": "Rider",
    "clion64.exe": "CLion",
    "goland64.exe": "GoLand",
    "studio64.exe": "Android Studio",
    "sublime_text.exe": "Sublime Text",
    "notepad++.exe": "Notepad++",
    "windowsterminal.exe": "il terminale",
    "wt.exe": "il terminale",
    "powershell.exe": "PowerShell",
    "pwsh.exe": "PowerShell",
    "cmd.exe": "il prompt dei comandi",
    "unity.exe": "Unity",
    "blender.exe": "Blender",
}
BROWSERS = {
    "chrome.exe": "Chrome",
    "msedge.exe": "Edge",
    "firefox.exe": "Firefox",
    "brave.exe": "Brave",
    "opera.exe": "Opera",
    "vivaldi.exe": "Vivaldi",
    "arc.exe": "Arc",
    "zen.exe": "Zen",
    "librewolf.exe": "LibreWolf",
}
VIDEO_PLAYERS = {"vlc.exe": "VLC", "mpc-hc64.exe": "MPC-HC", "potplayermini64.exe": "PotPlayer", "stremio.exe": "Stremio"}
MUSIC = {"spotify.exe": "Spotify"}
MEETINGS = {"teams.exe": "Teams", "ms-teams.exe": "Teams", "zoom.exe": "Zoom", "webexmta.exe": "Webex"}
CHAT = {"discord.exe": "Discord", "telegram.exe": "Telegram", "whatsapp.exe": "WhatsApp", "slack.exe": "Slack"}
OFFICE = {
    "winword.exe": "Word",
    "excel.exe": "Excel",
    "powerpnt.exe": "PowerPoint",
    "obsidian.exe": "Obsidian",
    "notion.exe": "Notion",
    "onenote.exe": "OneNote",
}
GAME_LAUNCHERS = {"steam.exe": "Steam", "epicgameslauncher.exe": "Epic Games", "battle.net.exe": "Battle.net"}

#: Il browser aggiunge il suo nome in coda al titolo della pagina.
_BROWSER_SUFFIX = re.compile(
    r"\s[-–—]\s(?:(?:Personal|Personale|Work|Lavoro)\s[-–—]\s)?"
    r"(?:Google Chrome|Microsoft​? Edge|Mozilla Firefox|Brave|Opera|Vivaldi|Arc|Zen Browser|LibreWolf)$"
)
#: Edge: "Titolo e altre 3 pagine" / "Title and 3 more pages".
_EDGE_TABS = re.compile(r"\s(?:and \d+ more pages?|e altre? \d+ pagin[ae])$")
#: "(12) Titolo del video - YouTube": il numero sono le notifiche.
_YOUTUBE = re.compile(r"^(?:\(\d+\)\s*)?(?P<title>.+?)\s[-–—]\sYouTube(?P<music>\sMusic)?$")
_STREAMING = re.compile(r"(?P<site>Netflix|Prime Video|Disney\+|Twitch|RaiPlay|Crunchyroll)", re.IGNORECASE)
_MEET_TITLE = re.compile(r"^(?:Meet|Google Meet)\b|\bZoom Meeting\b|\bMicrosoft Teams\b.*(?:call|chiamata|riunione)", re.IGNORECASE)
_CODE_SITES = re.compile(r"\b(?:GitHub|GitLab|Stack Overflow|localhost:\d+|127\.0\.0\.1)\b", re.IGNORECASE)


@dataclass
class Activity:
    """Cosa sta facendo l'utente, in una parola, piu' i dettagli utili."""

    #: coding, youtube, video, music, game, meeting, chat, office, browsing,
    #: tsukumo (sta usando il companion), desktop, other, away, locked, unknown
    kind: str = "unknown"
    #: Nome del programma o del sito ("VS Code", "YouTube").
    label: str = ""
    #: Il titolo del video, della pagina o del documento, quando serve.
    detail: str = ""
    #: Schermo intero: un gioco, un film, una presentazione.
    fullscreen: bool = False

    @property
    def dnd(self) -> bool:
        """Non disturbare: niente commenti ne' chiacchiere."""
        return self.fullscreen or self.kind in {"meeting", "game", "locked"}

    @property
    def watching(self) -> bool:
        """Sta guardando qualcosa senza toccare mouse e tastiera: non e' via."""
        return self.kind in {"youtube", "video", "meeting", "game"}

    def as_dict(self) -> dict[str, Any]:
        return {**asdict(self), "dnd": self.dnd, "watching": self.watching}


def page_title(title: str) -> str:
    """Il titolo della pagina, senza il nome del browser e il conteggio delle schede."""
    stripped = _BROWSER_SUFFIX.sub("", title.strip())
    return _EDGE_TABS.sub("", stripped).strip()


def classify(app: dict[str, Any] | None) -> Activity:
    """Finestra in primo piano -> attivita'."""
    if not app:
        return Activity()
    if app.get("own"):
        return Activity("tsukumo", "Tsukumo")
    exe = str(app.get("exe") or "").strip().lower()
    title = str(app.get("title") or "").strip()
    fullscreen = bool(app.get("fullscreen"))

    if exe in BROWSERS:
        page = page_title(title)
        youtube = _YOUTUBE.match(page)
        if youtube:
            label = "YouTube Music" if youtube.group("music") else "YouTube"
            kind = "music" if youtube.group("music") else "youtube"
            return Activity(kind, label, youtube.group("title").strip(), fullscreen)
        if page in ("YouTube", ""):
            return Activity("browsing", BROWSERS[exe], page, fullscreen)
        streaming = _STREAMING.search(page)
        if streaming:
            return Activity("video", streaming.group("site"), page, fullscreen)
        if _MEET_TITLE.search(page):
            return Activity("meeting", "Google Meet", page, fullscreen)
        if _CODE_SITES.search(page):
            return Activity("coding", BROWSERS[exe], page, fullscreen)
        return Activity("browsing", BROWSERS[exe], page, fullscreen)
    for table, kind in (
        (CODING, "coding"),
        (MEETINGS, "meeting"),
        (VIDEO_PLAYERS, "video"),
        (MUSIC, "music"),
        (CHAT, "chat"),
        (OFFICE, "office"),
        (GAME_LAUNCHERS, "game"),
    ):
        if exe in table:
            # Teams aperto non vuol dire in riunione: lo dice il titolo.
            if kind == "meeting" and not re.search(r"meeting|riunione|call|chiamata", title, re.IGNORECASE):
                return Activity("chat", table[exe], title, fullscreen)
            return Activity(kind, table[exe], title, fullscreen)
    if exe == "explorer.exe" and not title:
        return Activity("desktop", "il desktop")
    if fullscreen:
        # Un programma sconosciuto a tutto schermo e' quasi sempre un gioco.
        return Activity("game", exe.removesuffix(".exe"), title, True)
    return Activity("other", exe.removesuffix(".exe"), title, fullscreen)


@dataclass
class PCContext:
    """L'ultimo contesto ricevuto dalla shell, piu' qualche conto nel tempo."""

    idle: float = 0.0
    locked: bool = False
    activity: Activity = field(default_factory=Activity)
    #: Quando e' arrivato l'ultimo aggiornamento (``time.time()``), 0 = mai.
    updated_at: float = 0.0
    #: Da quando l'utente e' al PC senza pause lunghe (per "fai una pausa").
    session_start: float | None = None
    #: Da quando e' in primo piano la stessa attivita' (stesso video, stesso programma).
    activity_since: float = 0.0

    #: Una pausa di almeno tanto chiude la sessione di lavoro.
    BREAK_SECONDS = 10 * 60
    #: Oltre questo l'utente non e' al PC (a meno che stia guardando qualcosa).
    AWAY_SECONDS = 5 * 60
    #: Senza aggiornamenti da tanto la shell e' chiusa: il contesto non vale.
    STALE_SECONDS = 30

    def update(self, idle: float, locked: bool, app: dict[str, Any] | None, now: float | None = None) -> bool:
        """Registra un aggiornamento; vero se l'attivita' e' cambiata."""
        now = time.time() if now is None else now
        previous = self.activity
        activity = Activity("locked", "") if locked else classify(app)
        self.idle = max(0.0, float(idle or 0))
        self.locked = bool(locked)
        self.updated_at = now

        present = self.present_at(activity)
        if present:
            if self.session_start is None:
                self.session_start = now
        elif self.idle >= self.BREAK_SECONDS or locked:
            self.session_start = None

        changed = (activity.kind, activity.detail, activity.fullscreen) != (previous.kind, previous.detail, previous.fullscreen)
        if changed:
            self.activity_since = now
        self.activity = activity
        return changed

    def present_at(self, activity: Activity | None = None) -> bool:
        activity = activity or self.activity
        if self.locked or activity.kind == "locked":
            return False
        return self.idle < self.AWAY_SECONDS or activity.watching

    @property
    def present(self) -> bool:
        """L'utente e' davanti al PC (o sta guardando qualcosa)."""
        return self.fresh and self.present_at()

    @property
    def fresh(self) -> bool:
        return self.updated_at > 0 and time.time() - self.updated_at < self.STALE_SECONDS

    def session_minutes(self, now: float | None = None) -> float:
        if self.session_start is None:
            return 0.0
        return ((time.time() if now is None else now) - self.session_start) / 60

    def activity_seconds(self, now: float | None = None) -> float:
        return (time.time() if now is None else now) - self.activity_since

    def as_dict(self) -> dict[str, Any]:
        return {
            "type": "context",
            "idle": round(self.idle),
            "locked": self.locked,
            "present": self.present,
            "activity": self.activity.as_dict(),
            "sessionMinutes": round(self.session_minutes()),
        }
