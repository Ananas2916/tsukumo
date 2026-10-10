"""What the user is doing at the PC.

Every 5 seconds the Electron shell sends (``POST /api/context``) how long
nobody has touched mouse and keyboard, whether the screen is locked and the
foreground window: title, program, full screen. Here it becomes an
*activity* ("coding in VS Code", "watching a video on YouTube", "in a
meeting") which is used to:

* comment at the right moment (and on what: the video, the late hour...),
* not disturb during games, full-screen videos and meetings,
* not fall asleep while the user watches a video without touching anything.

No data leaves the PC: titles and programs stay in the backend.
"""

from __future__ import annotations

import re
import time
from dataclasses import asdict, dataclass, field
from typing import Any

#: Recognized programs, by executable name (lowercase).
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
    "windowsterminal.exe": "the terminal",
    "wt.exe": "the terminal",
    "powershell.exe": "PowerShell",
    "pwsh.exe": "PowerShell",
    "cmd.exe": "the command prompt",
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

#: The browser adds its name at the end of the page's title.
_BROWSER_SUFFIX = re.compile(
    r"\s[-–—]\s(?:(?:Personal|Personale|Work|Lavoro)\s[-–—]\s)?"
    r"(?:Google Chrome|Microsoft​? Edge|Mozilla Firefox|Brave|Opera|Vivaldi|Arc|Zen Browser|LibreWolf)$"
)
#: Edge: "Title and 3 more pages" / "Titolo e altre 3 pagine".
_EDGE_TABS = re.compile(r"\s(?:and \d+ more pages?|e altre? \d+ pagin[ae])$")
#: "(12) Video title - YouTube": the number is the notifications.
_YOUTUBE = re.compile(r"^(?:\(\d+\)\s*)?(?P<title>.+?)\s[-–—]\sYouTube(?P<music>\sMusic)?$")
_STREAMING = re.compile(r"(?P<site>Netflix|Prime Video|Disney\+|Twitch|RaiPlay|Crunchyroll)", re.IGNORECASE)
_MEET_TITLE = re.compile(r"^(?:Meet|Google Meet)\b|\bZoom Meeting\b|\bMicrosoft Teams\b.*(?:call|chiamata|riunione)", re.IGNORECASE)
_CODE_SITES = re.compile(r"\b(?:GitHub|GitLab|Stack Overflow|localhost:\d+|127\.0\.0\.1)\b", re.IGNORECASE)


@dataclass
class Activity:
    """What the user is doing, in one word, plus the useful details."""

    #: coding, youtube, video, music, game, meeting, chat, office, browsing,
    #: tsukumo (using the companion), desktop, other, away, locked, unknown
    kind: str = "unknown"
    #: Name of the program or site ("VS Code", "YouTube").
    label: str = ""
    #: The title of the video, page or document, when needed.
    detail: str = ""
    #: Full screen: a game, a film, a presentation.
    fullscreen: bool = False

    @property
    def dnd(self) -> bool:
        """Do not disturb: no comments or chatter."""
        return self.fullscreen or self.kind in {"meeting", "game", "locked"}

    @property
    def watching(self) -> bool:
        """Watching something without touching mouse and keyboard: not away."""
        return self.kind in {"youtube", "video", "meeting", "game"}

    def as_dict(self) -> dict[str, Any]:
        return {**asdict(self), "dnd": self.dnd, "watching": self.watching}


def page_title(title: str) -> str:
    """The page's title, without the browser's name and the tab count."""
    stripped = _BROWSER_SUFFIX.sub("", title.strip())
    return _EDGE_TABS.sub("", stripped).strip()


def classify(app: dict[str, Any] | None) -> Activity:
    """Foreground window -> activity."""
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
            # Teams open doesn't mean in a meeting: the title says so.
            if kind == "meeting" and not re.search(r"meeting|riunione|call|chiamata", title, re.IGNORECASE):
                return Activity("chat", table[exe], title, fullscreen)
            return Activity(kind, table[exe], title, fullscreen)
    if exe == "explorer.exe" and not title:
        return Activity("desktop", "the desktop")
    if fullscreen:
        # An unknown program in full screen is almost always a game.
        return Activity("game", exe.removesuffix(".exe"), title, True)
    return Activity("other", exe.removesuffix(".exe"), title, fullscreen)


@dataclass
class PCContext:
    """The last context received from the shell, plus some bookkeeping over time."""

    idle: float = 0.0
    locked: bool = False
    activity: Activity = field(default_factory=Activity)
    #: When the last update arrived (``time.time()``), 0 = never.
    updated_at: float = 0.0
    #: Since when the user has been at the PC without long breaks (for "take a break").
    session_start: float | None = None
    #: Since when the same activity has been in the foreground (same video, same program).
    activity_since: float = 0.0

    #: A break at least this long closes the work session.
    BREAK_SECONDS = 10 * 60
    #: Beyond this the user isn't at the PC (unless they're watching something).
    AWAY_SECONDS = 5 * 60
    #: Without updates for this long the shell is closed: the context doesn't count.
    STALE_SECONDS = 30

    def update(self, idle: float, locked: bool, app: dict[str, Any] | None, now: float | None = None) -> bool:
        """Records an update; true if the activity changed."""
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
        """The user is in front of the PC (or watching something)."""
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
