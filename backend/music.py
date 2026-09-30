"""Musica: Spotify collegato, cosa stai ascoltando e cosa ti piace.

Il companion e' il corpo, non il cervello: qui si vede la musica e si premono
i tasti. Cosa rispondere a "che genere e'?" e quali brani sono "simili" lo
decide l'agente, qualunque sia. Gli si racconta cosa suona e cosa sappiamo dei
tuoi gusti; lui chiede di mettere musica con un'etichetta ``[[music: ...]]`` in
fondo alla risposta, come per i promemoria.

* ``SpotifyClient``: OAuth con PKCE (nessun segreto: basta il Client ID di
  un'app creata dall'utente su developer.spotify.com) e le poche API che servono.
* ``TasteProfile``: i gusti imparati qui (brani ascoltati fino in fondo, saltati,
  "mi piace") piu' gli artisti che Spotify dice che ascolti di piu'.
* ``MusicService``: guarda cosa suona ogni 20 secondi (mai dentro
  ``/api/health``), scrive il contesto per il cervello, esegue le etichette e i
  comandi al volo ("metti in pausa la musica").

Dal 2024 Spotify non da' piu' raccomandazioni ne' artisti correlati alle app
nuove: i brani simili li sceglie il cervello, qui si cercano e si mettono.
Scegliere cosa suonare richiede Premium; pausa e cambio brano ripiegano sui
tasti multimediali di Windows, che vanno con qualunque account e lettore.
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

#: Ogni quanto si guarda cosa suona (per imparare cosa ascolti e cosa salti).
POLL_SECONDS = 20.0
#: Dopo una domanda sulla musica, per quanti turni il cervello resta "in tema":
#: "vorrei sentirne di simili" non nomina la musica, ma ne parla.
FOLLOW_TURNS = 2
#: Gli artisti piu' ascoltati secondo Spotify si rileggono una volta al giorno.
TOP_REFRESH_SECONDS = 24 * 3600
#: Quanti brani al massimo per un'etichetta "play" o "queue".
MAX_TRACKS = 10

OnChange = Callable[[dict[str, Any]], Awaitable[None]]


class SpotifyError(RuntimeError):
    """Spotify ha detto di no; ``reason`` e' il codice di Spotify (PREMIUM_REQUIRED...)."""

    def __init__(self, message: str, reason: str = "", status: int = 0) -> None:
        super().__init__(message)
        self.reason = reason
        self.status = status

    def explain(self) -> str:
        """Una frase da dire all'utente."""
        if self.reason == "PREMIUM_REQUIRED":
            return "Per scegliere cosa suonare Spotify vuole un account Premium: senza, posso solo mettere in pausa e cambiare brano."
        if self.reason in ("NO_ACTIVE_DEVICE", "NO_DEVICE"):
            return "Apri Spotify, qui o sul telefono: non c'è nessun lettore acceso."
        if self.reason == "NOT_CONNECTED":
            return "Spotify non è collegato: collegalo dal pannello, nella scheda Personaggio."
        if self.status == 429:
            return "Spotify mi chiede di rallentare: riprova tra poco."
        if self.reason in ("NOT_FOUND", "NOTHING", "NO_KEYS", "BAD_STATE", "NOT_CONFIGURED"):
            return str(self)  # messaggi nostri, gia' in parole semplici
        return f"Spotify non collabora: {self}"


# ---------------------------------------------------------------------------
# Brani
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
    #: Durata in secondi.
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
    #: Secondi dall'inizio del brano.
    progress: float = 0.0


# ---------------------------------------------------------------------------
# Spotify
# ---------------------------------------------------------------------------
def _save_json(path: Path | None, data: dict[str, Any]) -> None:
    """Scrive in un file temporaneo e poi lo sostituisce: mai un file a meta'."""
    if not path:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(temporary, path)
    except OSError as exc:
        logger.warning("File non salvato (%s): %s", path, exc)


def _pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)[:128]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


class SpotifyClient:
    """Il collegamento a Spotify: token in ``state/spotify.json``, mai nel ``.env``."""

    def __init__(self, path: Path | None) -> None:
        self.path = path
        self.data: dict[str, str] = {"clientId": "", "refreshToken": "", "user": ""}
        if path and path.is_file():
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
                self.data.update({k: str(v) for k, v in loaded.items() if k in self.data and v})
            except (OSError, ValueError) as exc:
                logger.warning("Collegamento a Spotify non leggibile da %s: %s", path, exc)
        self._access = ""
        self._expires = 0.0
        #: state -> code_verifier dell'autorizzazione in corso (una sola alla volta).
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
            raise ValueError("Il Client ID di Spotify è fatto di 32 caratteri tra cifre e lettere a-f.")
        if client_id != self.data["clientId"]:
            self.data.update(clientId=client_id, refreshToken="", user="")
            self._access = ""
            self._save()

    def authorize_url(self, redirect_uri: str) -> str:
        """Dove mandare il browser per dare il permesso (Authorization Code con PKCE)."""
        if not self.configured:
            raise SpotifyError("Manca il Client ID della tua app Spotify.", "NOT_CONFIGURED")
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
        """Il browser e' tornato col codice: lo si scambia coi token. Restituisce il nome dell'account."""
        verifier = self._pending.pop(state, None)
        if not verifier:
            raise SpotifyError("Richiesta scaduta: premi di nuovo «Collega Spotify».", "BAD_STATE")
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
            # Creare un client carica i certificati (~0,2 s): in un thread.
            self._http = await asyncio.to_thread(httpx.AsyncClient, timeout=10.0)
        return self._http

    async def _post_token(self, form: dict[str, str]) -> None:
        http = await self._client()
        response = await http.post(TOKEN_URL, data=form)
        if response.status_code == 400 and form.get("grant_type") == "refresh_token":
            # Permesso revocato dall'account, o app cambiata: va ricollegato.
            self.disconnect()
            raise SpotifyError("Spotify va ricollegato dal pannello.", "NOT_CONNECTED", 400)
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
                raise SpotifyError("Spotify non è collegato.", "NOT_CONNECTED")
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
                return None  # i comandi del lettore a volte rispondono con testo
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
# Tasti multimediali: vanno con qualunque lettore, Premium o no
# ---------------------------------------------------------------------------
_MEDIA_KEYS = {"next": 0xB0, "previous": 0xB1, "toggle": 0xB3}


def press_media_key(key: str) -> bool:
    """Preme un tasto multimediale (solo Windows). Falso se non si puo'."""
    if os.name != "nt" or key not in _MEDIA_KEYS:
        return False
    import ctypes

    code = _MEDIA_KEYS[key]
    user32 = ctypes.windll.user32  # type: ignore[attr-defined]
    user32.keybd_event(code, 0, 1, 0)  # KEYEVENTF_EXTENDEDKEY
    user32.keybd_event(code, 0, 3, 0)  # ... | KEYEVENTF_KEYUP
    return True


# ---------------------------------------------------------------------------
# Gusti
# ---------------------------------------------------------------------------
class TasteProfile:
    """Cosa ti piace, imparato ascoltando con te. Sta in ``state/music_taste.json``."""

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
                logger.warning("Gusti musicali non leggibili da %s: %s", path, exc)

    @staticmethod
    def _empty() -> dict[str, Any]:
        return {"artists": {}, "liked": [], "disliked": [], "top": [], "genres": [], "topUpdated": 0}

    def _artist(self, name: str) -> dict[str, int]:
        entry = self.data["artists"].setdefault(name, {})
        for key in ("plays", "skips", "likes", "dislikes"):
            entry.setdefault(key, 0)
        return entry

    def observe(self, track: Track, heard: bool, skipped: bool) -> None:
        """Un brano e' finito: ascoltato fino in fondo (o quasi), oppure saltato."""
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
        """Gli artisti che Spotify dice che ascolti di piu', coi loro generi."""
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
        """I gusti in una riga, per il cervello (in inglese, come le altre istruzioni)."""
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
# Etichette del cervello e comandi al volo
# ---------------------------------------------------------------------------
_ACTIONS = {
    "play": "play", "queue": "queue", "pause": "pause", "stop": "pause", "resume": "resume",
    "next": "next", "skip": "next", "previous": "previous", "back": "previous",
    "like": "like", "love": "like", "dislike": "dislike",
}
_TAG = re.compile(r"^\[\[\s*music\s*:?\s*(?P<action>[a-z]+)\b\s*(?P<rest>.*?)\s*\]\]$", re.IGNORECASE | re.DOTALL)
_QUOTES = " \t\"'“”«»‘’"


def music_tag(tag: str) -> tuple[str, list[str]] | None:
    """``[[music: play A - B; C - D]]`` -> ``("play", ["A - B", "C - D"])``; ``None`` se non e' musica."""
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
    """ "Artista - Titolo" -> la ricerca precisa, poi quella libera."""
    parts = re.split(r"\s+[-–—]\s+", item, maxsplit=1)
    if len(parts) == 2:
        artist, title = parts
        return [f"track:{title} artist:{artist}", f"{artist} {title}"]
    return [item]


#: Parole che rendono un messaggio "sulla musica": allora il cervello riceve
#: cosa suona e le istruzioni per le etichette.
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

#: Come si chiede la musica, spiegato al cervello (una volta per turno "in tema").
TAG_HELP = (
    "To control their music, append at the very end [[music: play Artist - Title; Artist - Title]] to play "
    "songs now (when they want something similar, a mood or an artist, pick 5-8 real, existing songs that fit "
    "their taste), [[music: queue Artist - Title; ...]] to add songs after the current one, [[music: pause]], "
    "[[music: resume]], [[music: next]], [[music: previous]], or [[music: like]] / [[music: dislike]] when they "
    "say they love or hate the current song. Never read or mention the tag, and name at most one or two of the "
    "songs you picked."
)


def parse_command(text: str) -> str | None:
    """ "Metti in pausa la musica" -> ``"pause"``; ``None`` se non e' un comando del lettore."""
    for action, pattern in _COMMAND_RES.items():
        if pattern.match(text):
            return action
    return None


# ---------------------------------------------------------------------------
# Il servizio
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

    # -- ciclo --------------------------------------------------------------
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
                    logger.debug("Spotify non raggiungibile: %s", exc)
            await asyncio.sleep(POLL_SECONDS)

    async def refresh(self) -> NowPlaying | None:
        """Chiede a Spotify cosa suona; se e' cambiato impara e avvisa il pannello."""
        current = await self.spotify.now_playing()
        before = self.now
        self._observe(current)
        self.now = current
        if _key(before) != _key(current):
            await self._changed()
        return current

    def _observe(self, current: NowPlaying | None) -> None:
        """Il brano di prima e' finito: ascoltato (meta' o 4 minuti) o saltato (meno di 30 s)."""
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

    # -- cervello -----------------------------------------------------------
    async def directive(self, prompt: str) -> str:
        """Il contesto musicale per questo turno, vuoto se non si parla di musica."""
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
        """I generi dell'artista secondo Spotify (una volta per artista; a volte vuoti)."""
        if not track.artist_ids or not track.artist_ids[0]:
            return []
        artist = track.artist_ids[0]
        if artist not in self._genres:
            try:
                self._genres[artist] = await asyncio.wait_for(self.spotify.artist_genres(artist), 3.0)
            except (SpotifyError, httpx.HTTPError, asyncio.TimeoutError):
                return []
        return self._genres[artist]

    async def run_tags(self, tags: list[str]) -> str | None:
        """Esegue le etichette ``[[music: ...]]`` del cervello; un problema da dire, o ``None``."""
        for tag in tags:
            parsed = music_tag(tag)
            if parsed is None:
                continue
            action, items = parsed
            try:
                await self._do(action, items)
            except SpotifyError as exc:
                logger.info("Spotify: %s non riuscito (%s)", action, exc)
                return exc.explain()
            except httpx.HTTPError as exc:
                return f"Non riesco a raggiungere Spotify: {exc}"
        return None

    async def _do(self, action: str, items: list[str]) -> None:
        if action in ("play", "queue"):
            tracks = [track for track in await asyncio.gather(*(self._find(item) for item in items)) if track]
            uris = list(dict.fromkeys(track.uri for track in tracks))
            if not uris:
                raise SpotifyError("Non ho trovato su Spotify nessuno dei brani scelti.", "NOT_FOUND")
            logger.info("Spotify: %s %s", action, "; ".join(track.label for track in tracks))
            if action == "play":
                await self._play(uris)
            else:
                for uri in uris:
                    await self.spotify.queue(uri)
        elif action in ("like", "dislike"):
            now = self.now or await self.spotify.now_playing()
            if now is None or now.track is None:
                raise SpotifyError("Non sta suonando niente.", "NOTHING")
            if action == "like":
                self.taste.like(now.track)
                try:
                    await self.spotify.save(now.track)
                except SpotifyError as exc:
                    logger.info("Brano non aggiunto ai preferiti di Spotify: %s", exc)
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
            # Spotify e' aperto ma nessun lettore e' "attivo": si sceglie il PC.
            devices = await self.spotify.devices()
            devices.sort(key=lambda d: (not d.get("is_active"), d.get("type") != "Computer"))
            if not devices:
                raise SpotifyError("Nessun lettore acceso.", "NO_DEVICE") from exc
            await self.spotify.play(uris, str(devices[0].get("id") or ""))

    async def control(self, action: str) -> None:
        """Pausa, ripresa, avanti, indietro: con l'API, o coi tasti multimediali senza Premium."""
        if self.spotify.connected:
            try:
                await self.spotify.control(action)
                return
            except SpotifyError as exc:
                if exc.reason not in ("PREMIUM_REQUIRED", "NO_ACTIVE_DEVICE") and exc.status != 403:
                    raise
        key = {"next": "next", "previous": "previous"}.get(action, "toggle")
        if key == "toggle" and self.now is not None and self.now.playing == (action == "resume"):
            return  # gia' com'era richiesto: il tasto la farebbe ripartire
        if not press_media_key(key):
            raise SpotifyError("Qui non posso premere i tasti multimediali.", "NO_KEYS")

    async def command(self, text: str, language: str) -> str | None:
        """ "Metti in pausa la musica", "prossima canzone": subito, senza cervello."""
        action = parse_command(text)
        if action is None:
            return None
        code = "it" if language.startswith("it") else "en"
        try:
            await self.control(action)
        except SpotifyError as exc:
            return exc.explain()
        except httpx.HTTPError:
            return "Spotify non risponde." if code == "it" else "Spotify isn't answering."
        return _DONE[code][action]


def _key(now: NowPlaying | None) -> tuple[str, bool]:
    return (now.track.id if now and now.track else "", bool(now and now.playing))
