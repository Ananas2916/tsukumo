"""Music: Spotify connected, what you're listening to and what you like.

The companion is the body, not the brain: here the music is seen and the
buttons are pressed. What to answer to "what genre is this?" and which
tracks are "similar" is decided by the agent, whichever it is. It's told
what's playing and what we know of your taste; it asks for music with a
``[[music: ...]]`` tag at the end of the reply, as for reminders.

* ``SpotifyClient``: OAuth with PKCE (no secret: the Client ID of an app
  created by the user on developer.spotify.com is enough) and the few APIs
  needed.
* ``TasteProfile``: the taste learned here (tracks listened to the end,
  skipped, "I like it") plus the artists Spotify says you listen to most.
* ``MusicService``: looks at what's playing every 20 seconds (never inside
  ``/api/health``), writes the context for the brain, runs the tags and the
  quick commands ("pause the music").

Since 2024 Spotify no longer gives recommendations or related artists to new
apps: the similar tracks are chosen by the brain, here they're searched and
played. Choosing what to play needs Premium; pause and skip fall back on
Windows' media keys, which work with any account and player.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import json
import logging
import os
import re
import secrets
import time
from collections import Counter
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import httpx

logger = logging.getLogger(__name__)

AUTH_URL = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"
API_URL = "https://api.spotify.com/v1"
SCOPES = (
    "user-read-currently-playing user-read-playback-state user-modify-playback-state "
    "user-top-read user-library-modify"
)

#: How often we look at what's playing (to learn what you listen to and what you skip).
POLL_SECONDS = 20.0
#: After a question about music, for how many turns the brain stays "on topic":
#: "I'd like to hear similar ones" doesn't name music, but it's about it.
FOLLOW_TURNS = 2
#: The most-listened artists according to Spotify are read again once a day.
TOP_REFRESH_SECONDS = 24 * 3600
#: At most how many tracks for a "play" or "queue" tag.
MAX_TRACKS = 10

OnChange = Callable[[dict[str, Any]], Awaitable[None]]


class SpotifyError(RuntimeError):
    """Spotify said no; ``reason`` is Spotify's code (PREMIUM_REQUIRED...)."""

    def __init__(self, message: str, reason: str = "", status: int = 0) -> None:
        super().__init__(message)
        self.reason = reason
        self.status = status

    def explain(self, language: str = "en") -> str:
        """A sentence to say to the user, in ``language`` ("it" or anything else for English)."""
        it = language.startswith("it")
        if self.reason == "PREMIUM_REQUIRED":
            if it:
                return "Per scegliere cosa suonare Spotify vuole un account Premium: senza, posso solo mettere in pausa e cambiare brano."
            return "To choose what to play Spotify wants a Premium account: without it, I can only pause and skip."
        if self.reason in ("NO_ACTIVE_DEVICE", "NO_DEVICE"):
            return "Apri Spotify, qui o sul telefono: non c'è nessun lettore acceso." if it else "Open Spotify, here or on the phone: no player is on."
        if self.reason == "NOT_CONNECTED":
            if it:
                return "Spotify non è collegato: collegalo dal pannello, nella scheda Personaggio."
            return "Spotify is not connected: connect it from the panel, in the Character tab."
        if self.status == 429:
            return "Spotify mi chiede di rallentare: riprova tra poco." if it else "Spotify is asking me to slow down: try again in a bit."
        if self.reason in ("NOT_FOUND", "NOTHING", "NO_KEYS", "BAD_STATE", "NOT_CONFIGURED"):
            # our own messages, already in plain words
            return _ITALIAN.get(str(self), str(self)) if it else str(self)
        return f"Spotify non collabora: {self}" if it else f"Spotify isn't cooperating: {self}"


#: Our own error messages in Italian, for ``explain`` (the panel translates them by itself).
_ITALIAN = {
    "Your Spotify app's Client ID is missing.": "Manca il Client ID della tua app Spotify.",
    "Request expired: press \"Connect Spotify\" again.": "Richiesta scaduta: premi di nuovo «Collega Spotify».",
    "Spotify must be connected again from the panel.": "Spotify va ricollegato dal pannello.",
    "Spotify is not connected.": "Spotify non è collegato.",
    "I didn't find any of the chosen tracks on Spotify.": "Non ho trovato su Spotify nessuno dei brani scelti.",
    "Nothing is playing.": "Non sta suonando niente.",
    "No player is on.": "Nessun lettore acceso.",
    "I can't press the media keys here.": "Qui non posso premere i tasti multimediali.",
}


# ---------------------------------------------------------------------------
# Tracks
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Track:
    id: str
    uri: str
    title: str
    artists: tuple[str, ...]
    artist_ids: tuple[str, ...] = ()
    album: str = ""
    year: str = ""
    #: Length in seconds.
    duration: float = 0.0

    @property
    def artist(self) -> str:
        return ", ".join(self.artists)

    @property
    def label(self) -> str:
        return f"{self.artist} - {self.title}"

    @classmethod
    def from_api(cls, item: Any) -> Track | None:
        if not isinstance(item, dict) or item.get("type", "track") != "track" or not item.get("id"):
            return None
        artists = [a for a in item.get("artists") or [] if isinstance(a, dict)]
        album = item.get("album") or {}
        return cls(
            id=str(item["id"]),
            uri=str(item.get("uri") or f"spotify:track:{item['id']}"),
            title=str(item.get("name") or ""),
            artists=tuple(str(a.get("name") or "") for a in artists),
            artist_ids=tuple(str(a.get("id") or "") for a in artists),
            album=str(album.get("name") or ""),
            year=str(album.get("release_date") or "")[:4],
            duration=float(item.get("duration_ms") or 0) / 1000,
        )

    def as_dict(self) -> dict[str, Any]:
        return {"id": self.id, "title": self.title, "artist": self.artist, "album": self.album, "year": self.year}


@dataclass(frozen=True)
class NowPlaying:
    track: Track | None
    playing: bool
    #: Seconds from the start of the track.
    progress: float = 0.0


# ---------------------------------------------------------------------------
# Spotify
# ---------------------------------------------------------------------------
def _save_json(path: Path | None, data: dict[str, Any]) -> None:
    """Writes to a temporary file and then replaces: never a half-written file."""
    if not path:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(temporary, path)
    except OSError as exc:
        logger.warning("File not saved (%s): %s", path, exc)


def _pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)[:128]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


class SpotifyClient:
    """The connection to Spotify: tokens in ``state/spotify.json``, never in the ``.env``."""

    def __init__(self, path: Path | None) -> None:
        self.path = path
        self.data: dict[str, str] = {"clientId": "", "refreshToken": "", "user": ""}
        if path and path.is_file():
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
                self.data.update({k: str(v) for k, v in loaded.items() if k in self.data and v})
            except (OSError, ValueError) as exc:
                logger.warning("Spotify connection unreadable from %s: %s", path, exc)
        self._access = ""
        self._expires = 0.0
        #: state -> code_verifier of the authorization in progress (one at a time).
        self._pending: dict[str, str] = {}
        self._lock = asyncio.Lock()
        self._http: httpx.AsyncClient | None = None

    @property
    def configured(self) -> bool:
        return bool(self.data["clientId"])

    @property
    def connected(self) -> bool:
        return bool(self.data["clientId"] and self.data["refreshToken"])

    @property
    def user(self) -> str:
        return self.data["user"]

    def set_client_id(self, client_id: str) -> None:
        client_id = client_id.strip()
        if not re.fullmatch(r"[0-9a-fA-F]{32}", client_id):
            raise ValueError("Spotify's Client ID is made of 32 characters among digits and letters a-f.")
        if client_id != self.data["clientId"]:
            self.data.update(clientId=client_id, refreshToken="", user="")
            self._access = ""
            self._save()

    def authorize_url(self, redirect_uri: str) -> str:
        """Where to send the browser to give the permission (Authorization Code with PKCE)."""
        if not self.configured:
            raise SpotifyError("Your Spotify app's Client ID is missing.", "NOT_CONFIGURED")
        verifier, challenge = _pkce_pair()
        state = secrets.token_urlsafe(16)
        self._pending = {state: verifier}
        return AUTH_URL + "?" + urlencode(
            {
                "client_id": self.data["clientId"],
                "response_type": "code",
                "redirect_uri": redirect_uri,
                "code_challenge_method": "S256",
                "code_challenge": challenge,
                "scope": SCOPES,
                "state": state,
            }
        )

    async def finish(self, code: str, state: str, redirect_uri: str) -> str:
        """The browser came back with the code: it's traded for the tokens. Returns the account's name."""
        verifier = self._pending.pop(state, None)
        if not verifier:
            raise SpotifyError("Request expired: press \"Connect Spotify\" again.", "BAD_STATE")
        await self._post_token(
            {
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "client_id": self.data["clientId"],
                "code_verifier": verifier,
            }
        )
        me = await self.request("GET", "/me") or {}
        self.data["user"] = str(me.get("display_name") or me.get("id") or "")
        self._save()
        return self.data["user"]

    def disconnect(self) -> None:
        self.data.update(refreshToken="", user="")
        self._access = ""
        self._save()

    async def close(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    def _save(self) -> None:
        _save_json(self.path, self.data)

    # -- HTTP ---------------------------------------------------------------
    async def _client(self) -> httpx.AsyncClient:
        if self._http is None:
            # Creating a client loads the certificates (~0.2 s): in a thread.
            self._http = await asyncio.to_thread(httpx.AsyncClient, timeout=10.0)
        return self._http

    async def _post_token(self, form: dict[str, str]) -> None:
        http = await self._client()
        response = await http.post(TOKEN_URL, data=form)
        if response.status_code == 400 and form.get("grant_type") == "refresh_token":
            # Permission revoked by the account, or app changed: it must be connected again.
            self.disconnect()
            raise SpotifyError("Spotify must be connected again from the panel.", "NOT_CONNECTED", 400)
        if not response.is_success:
            detail = response.text[:200]
            with contextlib.suppress(ValueError):
                body = response.json()
                detail = str(body.get("error_description") or body.get("error") or detail)
            raise SpotifyError(f"Token rifiutato: {detail}", "TOKEN", response.status_code)
        tokens = response.json()
        self._access = str(tokens.get("access_token") or "")
        self._expires = time.time() + float(tokens.get("expires_in") or 3600)
        if tokens.get("refresh_token"):
            self.data["refreshToken"] = str(tokens["refresh_token"])
            self._save()

    async def _token(self, force: bool = False) -> str:
        async with self._lock:
            if self._access and not force and time.time() < self._expires - 60:
                return self._access
            if not self.connected:
                raise SpotifyError("Spotify is not connected.", "NOT_CONNECTED")
            await self._post_token(
                {
                    "grant_type": "refresh_token",
                    "refresh_token": self.data["refreshToken"],
                    "client_id": self.data["clientId"],
                }
            )
            return self._access

    async def request(
        self, method: str, path: str, params: dict[str, Any] | None = None, body: Any = None
    ) -> Any:
        http = await self._client()
        response: httpx.Response | None = None
        for attempt in (1, 2):
            token = await self._token(force=attempt == 2)
            response = await http.request(
                method, API_URL + path, params=params, json=body, headers={"Authorization": f"Bearer {token}"}
            )
            if response.status_code != 401:
                break
        assert response is not None
        if response.is_success:
            if response.status_code == 204 or not response.content:
                return None
            try:
                return response.json()
            except ValueError:
                return None  # the player's commands sometimes answer with text
        reason, message = "", response.text[:200]
        with contextlib.suppress(ValueError, AttributeError):
            error = response.json().get("error") or {}
            reason, message = str(error.get("reason") or ""), str(error.get("message") or message)
        if response.status_code == 403 and "premium" in message.lower():
            reason = reason or "PREMIUM_REQUIRED"
        raise SpotifyError(message or f"HTTP {response.status_code}", reason, response.status_code)

    # -- API ----------------------------------------------------------------
    async def now_playing(self) -> NowPlaying | None:
        data = await self.request("GET", "/me/player/currently-playing")
        if not data:
            return None
        return NowPlaying(
            track=Track.from_api(data.get("item")),
            playing=bool(data.get("is_playing")),
            progress=float(data.get("progress_ms") or 0) / 1000,
        )

    async def search(self, query: str) -> Track | None:
        data = await self.request("GET", "/search", {"q": query, "type": "track", "limit": 1}) or {}
        items = (data.get("tracks") or {}).get("items") or []
        return Track.from_api(items[0]) if items else None

    async def play(self, uris: list[str], device_id: str = "") -> None:
        await self.request("PUT", "/me/player/play", {"device_id": device_id} if device_id else None, {"uris": uris})

    async def queue(self, uri: str) -> None:
        await self.request("POST", "/me/player/queue", {"uri": uri})

    async def control(self, action: str) -> None:
        method, path = {
            "pause": ("PUT", "/me/player/pause"),
            "resume": ("PUT", "/me/player/play"),
            "next": ("POST", "/me/player/next"),
            "previous": ("POST", "/me/player/previous"),
        }[action]
        await self.request(method, path)

    async def devices(self) -> list[dict[str, Any]]:
        data = await self.request("GET", "/me/player/devices") or {}
        return [d for d in data.get("devices") or [] if isinstance(d, dict) and not d.get("is_restricted")]

    async def save(self, track: Track) -> None:
        await self.request("PUT", "/me/tracks", {"ids": track.id})

    async def artist_genres(self, artist_id: str) -> list[str]:
        data = await self.request("GET", f"/artists/{artist_id}") or {}
        return [str(g) for g in data.get("genres") or []]

    async def top_artists(self) -> list[tuple[str, list[str]]]:
        data = await self.request("GET", "/me/top/artists", {"limit": 20, "time_range": "medium_term"}) or {}
        return [
            (str(a.get("name") or ""), [str(g) for g in a.get("genres") or []])
            for a in data.get("items") or []
            if isinstance(a, dict) and a.get("name")
        ]


# ---------------------------------------------------------------------------
# Media keys: they work with any player, Premium or not
# ---------------------------------------------------------------------------
_MEDIA_KEYS = {"next": 0xB0, "previous": 0xB1, "toggle": 0xB3}


def press_media_key(key: str) -> bool:
    """Presses a media key (Windows only). False if it can't."""
    if os.name != "nt" or key not in _MEDIA_KEYS:
        return False
    import ctypes

    code = _MEDIA_KEYS[key]
    user32 = ctypes.windll.user32  # type: ignore[attr-defined]
    user32.keybd_event(code, 0, 1, 0)  # KEYEVENTF_EXTENDEDKEY
    user32.keybd_event(code, 0, 3, 0)  # ... | KEYEVENTF_KEYUP
    return True


# ---------------------------------------------------------------------------
# Taste
# ---------------------------------------------------------------------------
class TasteProfile:
    """What you like, learned listening with you. It lives in ``state/music_taste.json``."""

    MAX_TRACKS = 30

    def __init__(self, path: Path | None) -> None:
        self.path = path
        self.data: dict[str, Any] = self._empty()
        if path and path.is_file():
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    self.data.update({k: v for k, v in loaded.items() if k in self.data})
            except (OSError, ValueError) as exc:
                logger.warning("Music taste unreadable from %s: %s", path, exc)

    @staticmethod
    def _empty() -> dict[str, Any]:
        return {"artists": {}, "liked": [], "disliked": [], "top": [], "genres": [], "topUpdated": 0}

    def _artist(self, name: str) -> dict[str, int]:
        entry = self.data["artists"].setdefault(name, {})
        for key in ("plays", "skips", "likes", "dislikes"):
            entry.setdefault(key, 0)
        return entry

    def observe(self, track: Track, heard: bool, skipped: bool) -> None:
        """A track ended: listened to the end (or almost), or skipped."""
        if not track.artists or not (heard or skipped):
            return
        self._artist(track.artists[0])["plays" if heard else "skips"] += 1
        self._save()

    def like(self, track: Track) -> None:
        self._mark(track, "liked", "disliked", "likes")

    def dislike(self, track: Track) -> None:
        self._mark(track, "disliked", "liked", "dislikes")

    def _mark(self, track: Track, into: str, out_of: str, counter: str) -> None:
        label = track.label
        self.data[out_of] = [item for item in self.data[out_of] if item != label]
        self.data[into] = [item for item in self.data[into] if item != label][-(self.MAX_TRACKS - 1) :] + [label]
        if track.artists:
            self._artist(track.artists[0])[counter] += 1
        self._save()

    def set_top(self, artists: list[tuple[str, list[str]]]) -> None:
        """The artists Spotify says you listen to most, with their genres."""
        self.data["top"] = [name for name, _ in artists][:20]
        genres = Counter(genre for _, names in artists for genre in names)
        self.data["genres"] = [genre for genre, _ in genres.most_common(8)]
        self.data["topUpdated"] = time.time()
        self._save()

    def top_is_old(self) -> bool:
        return time.time() - float(self.data.get("topUpdated") or 0) > TOP_REFRESH_SECONDS

    def score(self, name: str) -> float:
        entry = self.data["artists"].get(name) or {}
        value = entry.get("plays", 0) + 4 * entry.get("likes", 0) - 1.5 * entry.get("skips", 0) - 6 * entry.get("dislikes", 0)
        top = self.data["top"]
        if name in top:
            value += (len(top) - top.index(name)) / 4
        return value

    def favourites(self, limit: int = 8) -> list[str]:
        names = set(self.data["artists"]) | set(self.data["top"])
        ranked = sorted((name for name in names if self.score(name) > 0), key=self.score, reverse=True)
        return ranked[:limit]

    def avoided(self, limit: int = 5) -> list[str]:
        names = [name for name in self.data["artists"] if self.score(name) <= -3]
        return sorted(names, key=self.score)[:limit]

    def summary(self) -> str:
        """The taste in one line, for the brain (in English, like the other instructions)."""
        parts = []
        if favourites := self.favourites():
            parts.append("favourite artists: " + ", ".join(favourites))
        if self.data["genres"]:
            parts.append("favourite genres: " + ", ".join(self.data["genres"][:6]))
        if self.data["liked"]:
            parts.append("songs they said they love: " + "; ".join(self.data["liked"][-5:]))
        avoid = self.avoided() + self.data["disliked"][-3:]
        if avoid:
            parts.append("they don't like: " + "; ".join(avoid))
        return "; ".join(parts)

    def as_dict(self) -> dict[str, Any]:
        return {
            "favourites": self.favourites(),
            "genres": self.data["genres"][:6],
            "liked": self.data["liked"][-5:],
            "disliked": self.data["disliked"][-5:],
        }

    def forget(self) -> None:
        self.data = self._empty()
        self._save()

    def _save(self) -> None:
        _save_json(self.path, self.data)


# ---------------------------------------------------------------------------
# The brain's tags and quick commands
# ---------------------------------------------------------------------------
_ACTIONS = {
    "play": "play", "queue": "queue", "pause": "pause", "stop": "pause", "resume": "resume",
    "next": "next", "skip": "next", "previous": "previous", "back": "previous",
    "like": "like", "love": "like", "dislike": "dislike",
}
_TAG = re.compile(r"^\[\[\s*music\s*:?\s*(?P<action>[a-z]+)\b\s*(?P<rest>.*?)\s*\]\]$", re.IGNORECASE | re.DOTALL)
_QUOTES = " \t\"'“”«»‘’"


def music_tag(tag: str) -> tuple[str, list[str]] | None:
    """``[[music: play A - B; C - D]]`` -> ``("play", ["A - B", "C - D"])``; ``None`` if it isn't music."""
    match = _TAG.match(tag.strip())
    if not match:
        return None
    action = _ACTIONS.get(match.group("action").lower())
    if action is None:
        return None
    rest = match.group("rest").lstrip(":").strip()
    items = [item.strip(_QUOTES) for item in re.split(r"[;\n]|\s\|\s", rest)]
    return action, [item for item in items if item][:MAX_TRACKS]


def is_music_tag(tag: str) -> bool:
    return music_tag(tag) is not None


def _search_query(item: str) -> list[str]:
    """ "Artist - Title" -> the precise search, then the free one."""
    parts = re.split(r"\s+[-–—]\s+", item, maxsplit=1)
    if len(parts) == 2:
        artist, title = parts
        return [f"track:{title} artist:{artist}", f"{artist} {title}"]
    return [item]


#: Words that make a message "about music": then the brain gets what's
#: playing and the instructions for the tags.
MUSIC_WORDS = re.compile(
    r"\b(?:music\w*|canzon\w*|bran[oi]|pezz[oi]|tracc\w*|album|artist\w*|cantant\w*|band|playlist|spotify|"
    r"ascolt\w*|genere|sentir(?:ne|la|le|lo)|suon\w*|song\w*|tracks?|listen\w*|genre|singer|playing)\b",
    re.IGNORECASE,
)

_LEAD = r"^\s*(?:(?:hey|ehi|ok)\s+\w+[,\s]+)?(?:puoi\s+|potresti\s+|can\s+you\s+)?"
_TAIL = r"(?:\s+(?:per\s+favore|please|grazie))?\s*[.!?]*\s*$"
_IT = r"(?:la\s+)?(?:musica|canzone|spotify)"
_EN = r"(?:the\s+)?(?:music|song|spotify)"
_COMMANDS = {
    "pause": rf"(?:metti\s+in\s+pausa|pausa|ferma|stoppa|spegni|interrompi)\s+{_IT}|(?:pause|stop)\s+{_EN}",
    "resume": rf"(?:riprendi|fai\s+ripartire|rimetti|riaccendi)\s+{_IT}|(?:resume|unpause)\s+{_EN}",
    "next": (
        r"(?:metti\s+)?(?:la\s+)?prossima\s+canzone|(?:la\s+)?canzone\s+successiva|"
        r"(?:salta|cambia)\s+(?:questa\s+)?(?:canzone|brano|pezzo)|next\s+song|skip\s+(?:this\s+)?(?:song|track)"
    ),
    "previous": r"(?:la\s+)?canzone\s+precedente|torna\s+alla\s+canzone\s+(?:di\s+)?prima|previous\s+(?:song|track)",
}
_COMMAND_RES = {action: re.compile(_LEAD + f"(?:{body})" + _TAIL, re.IGNORECASE) for action, body in _COMMANDS.items()}
_DONE = {
    "it": {"pause": "Musica in pausa.", "resume": "Si riparte!", "next": "Ecco la prossima.", "previous": "Torno a quella di prima."},
    "en": {"pause": "Music paused.", "resume": "Here we go again!", "next": "Here's the next one.", "previous": "Going back to the last one."},
}

#: How to ask for music, explained to the brain (once per "on topic" turn).
TAG_HELP = (
    "To control their music, append at the very end [[music: play Artist - Title; Artist - Title]] to play "
    "songs now (when they want something similar, a mood or an artist, pick 5-8 real, existing songs that fit "
    "their taste), [[music: queue Artist - Title; ...]] to add songs after the current one, [[music: pause]], "
    "[[music: resume]], [[music: next]], [[music: previous]], or [[music: like]] / [[music: dislike]] when they "
    "say they love or hate the current song. Never read or mention the tag, and name at most one or two of the "
    "songs you picked."
)


def parse_command(text: str) -> str | None:
    """ "Pause the music" -> ``"pause"``; ``None`` if it isn't a player command."""
    for action, pattern in _COMMAND_RES.items():
        if pattern.match(text):
            return action
    return None


# ---------------------------------------------------------------------------
# The service
# ---------------------------------------------------------------------------
class MusicService:
    def __init__(self, state_dir: Path | None, redirect_uri: str, on_change: OnChange | None = None) -> None:
        self.spotify = SpotifyClient(state_dir / "spotify.json" if state_dir else None)
        self.taste = TasteProfile(state_dir / "music_taste.json" if state_dir else None)
        self.redirect_uri = redirect_uri
        self.on_change = on_change
        self.now: NowPlaying | None = None
        self.error = ""
        self._follow = 0
        self._genres: dict[str, list[str]] = {}
        self._task: asyncio.Task | None = None

    # -- loop ---------------------------------------------------------------
    async def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._loop(), name="music")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        await self.spotify.close()

    async def _loop(self) -> None:
        while True:
            if self.spotify.connected:
                try:
                    await self.refresh()
                    if self.taste.top_is_old():
                        self.taste.set_top(await self.spotify.top_artists())
                    self.error = ""
                except SpotifyError as exc:
                    if exc.reason == "NOT_CONNECTED":
                        await self._changed()
                    self.error = exc.explain()
                    logger.debug("Spotify: %s", exc)
                except httpx.HTTPError as exc:
                    logger.debug("Spotify unreachable: %s", exc)
            await asyncio.sleep(POLL_SECONDS)

    async def refresh(self) -> NowPlaying | None:
        """Asks Spotify what's playing; if it changed it learns and tells the panel."""
        current = await self.spotify.now_playing()
        before = self.now
        self._observe(current)
        self.now = current
        if _key(before) != _key(current):
            await self._changed()
        return current

    def _observe(self, current: NowPlaying | None) -> None:
        """The previous track ended: listened (half or 4 minutes) or skipped (less than 30 s)."""
        before = self.now
        if before is None or before.track is None:
            return
        if current is not None and current.track is not None and current.track.id == before.track.id:
            return
        duration = before.track.duration
        heard = bool(duration) and before.progress >= min(duration * 0.5, 240)
        skipped = not heard and before.progress < 30 and current is not None and current.track is not None
        self.taste.observe(before.track, heard, skipped)

    async def _changed(self) -> None:
        if self.on_change is not None:
            await self.on_change(self.status())

    def status(self) -> dict[str, Any]:
        track = self.now.track if self.now else None
        return {
            "configured": self.spotify.configured,
            "connected": self.spotify.connected,
            "user": self.spotify.user,
            "redirectUri": self.redirect_uri,
            "nowPlaying": {**track.as_dict(), "playing": self.now.playing} if track and self.now else None,
            "taste": self.taste.as_dict(),
            "error": self.error,
        }

    # -- brain --------------------------------------------------------------
    async def directive(self, prompt: str) -> str:
        """The music context for this turn, empty if music isn't the topic."""
        if not self.spotify.connected:
            return ""
        if MUSIC_WORDS.search(prompt):
            self._follow = FOLLOW_TURNS
            with contextlib.suppress(SpotifyError, httpx.HTTPError, asyncio.TimeoutError):
                await asyncio.wait_for(self.refresh(), 3.0)
        elif self._follow > 0:
            self._follow -= 1
        else:
            return ""
        parts = ["Spotify is connected to the user's account."]
        track = self.now.track if self.now else None
        if track and self.now:
            line = f'{"Now playing" if self.now.playing else "Paused"} on Spotify: "{track.title}" by {track.artist}'
            details = ", ".join(value for value in (track.album, track.year) if value)
            if details:
                line += f" ({details})"
            genres = await self._genres_of(track)
            if genres:
                line += f"; Spotify files the artist under {', '.join(genres[:4])}"
            parts.append(line + ".")
        else:
            parts.append("Nothing is playing right now.")
        if taste := self.taste.summary():
            parts.append(f"What you learned of their music taste: {taste}.")
        parts.append(TAG_HELP)
        return " ".join(parts)

    async def _genres_of(self, track: Track) -> list[str]:
        """The artist's genres according to Spotify (once per artist; sometimes empty)."""
        if not track.artist_ids or not track.artist_ids[0]:
            return []
        artist = track.artist_ids[0]
        if artist not in self._genres:
            try:
                self._genres[artist] = await asyncio.wait_for(self.spotify.artist_genres(artist), 3.0)
            except (SpotifyError, httpx.HTTPError, asyncio.TimeoutError):
                return []
        return self._genres[artist]

    async def run_tags(self, tags: list[str], language: str = "en") -> str | None:
        """Runs the brain's ``[[music: ...]]`` tags; a problem to say, or ``None``."""
        for tag in tags:
            parsed = music_tag(tag)
            if parsed is None:
                continue
            action, items = parsed
            try:
                await self._do(action, items)
            except SpotifyError as exc:
                logger.info("Spotify: %s failed (%s)", action, exc)
                return exc.explain(language)
            except httpx.HTTPError as exc:
                return f"Non riesco a raggiungere Spotify: {exc}" if language.startswith("it") else f"I can't reach Spotify: {exc}"
        return None

    async def _do(self, action: str, items: list[str]) -> None:
        if action in ("play", "queue"):
            tracks = [track for track in await asyncio.gather(*(self._find(item) for item in items)) if track]
            uris = list(dict.fromkeys(track.uri for track in tracks))
            if not uris:
                raise SpotifyError("I didn't find any of the chosen tracks on Spotify.", "NOT_FOUND")
            logger.info("Spotify: %s %s", action, "; ".join(track.label for track in tracks))
            if action == "play":
                await self._play(uris)
            else:
                for uri in uris:
                    await self.spotify.queue(uri)
        elif action in ("like", "dislike"):
            now = self.now or await self.spotify.now_playing()
            if now is None or now.track is None:
                raise SpotifyError("Nothing is playing.", "NOTHING")
            if action == "like":
                self.taste.like(now.track)
                try:
                    await self.spotify.save(now.track)
                except SpotifyError as exc:
                    logger.info("Track not added to Spotify's favourites: %s", exc)
            else:
                self.taste.dislike(now.track)
            await self._changed()
            return
        else:
            await self.control(action)
        with contextlib.suppress(SpotifyError, httpx.HTTPError):
            await asyncio.sleep(0.8)
            await self.refresh()

    async def _find(self, item: str) -> Track | None:
        for query in _search_query(item):
            with contextlib.suppress(SpotifyError, httpx.HTTPError):
                track = await self.spotify.search(query)
                if track is not None:
                    return track
        return None

    async def _play(self, uris: list[str]) -> None:
        try:
            await self.spotify.play(uris)
        except SpotifyError as exc:
            if exc.reason != "NO_ACTIVE_DEVICE":
                raise
            # Spotify is open but no player is "active": the PC is chosen.
            devices = await self.spotify.devices()
            devices.sort(key=lambda d: (not d.get("is_active"), d.get("type") != "Computer"))
            if not devices:
                raise SpotifyError("No player is on.", "NO_DEVICE") from exc
            await self.spotify.play(uris, str(devices[0].get("id") or ""))

    async def control(self, action: str) -> None:
        """Pause, resume, next, previous: with the API, or with the media keys without Premium."""
        if self.spotify.connected:
            try:
                await self.spotify.control(action)
                return
            except SpotifyError as exc:
                if exc.reason not in ("PREMIUM_REQUIRED", "NO_ACTIVE_DEVICE") and exc.status != 403:
                    raise
        key = {"next": "next", "previous": "previous"}.get(action, "toggle")
        if key == "toggle" and self.now is not None and self.now.playing == (action == "resume"):
            return  # already as requested: the key would start it again
        if not press_media_key(key):
            raise SpotifyError("I can't press the media keys here.", "NO_KEYS")

    async def command(self, text: str, language: str) -> str | None:
        """ "Pause the music", "next song": right away, without the brain."""
        action = parse_command(text)
        if action is None:
            return None
        code = "it" if language.startswith("it") else "en"
        try:
            await self.control(action)
        except SpotifyError as exc:
            return exc.explain(code)
        except httpx.HTTPError:
            return "Spotify non risponde." if code == "it" else "Spotify isn't answering."
        return _DONE[code][action]


def _key(now: NowPlaying | None) -> tuple[str, bool]:
    return (now.track.id if now and now.track else "", bool(now and now.playing))
