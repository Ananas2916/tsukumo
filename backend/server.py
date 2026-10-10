"""FastAPI server: WebSocket for the companion + REST API + hosting of the frontend.

WebSocket protocol (``/ws``)
----------------------------
Client -> server::

    {"type": "chat",   "text": "hi!"}        # brain + voice
    {"type": "say",    "text": "hi!", "voice": "..."}   # voice only
    {"type": "settings", "voice": "af_heart", "replyLanguage": "auto", "muted": false}
    {"type": "voice",  "audio": "<pcm16 base64>"}          # from the microphone
    {"type": "cancel"}                       # interrupts the current turn
    {"type": "reset"}                        # empties the conversation memory
    {"type": "ping"}

Server -> client::

    {"type": "hello",  "config": {...}, "voices": [...], "engines": {...},
     "transcript": [{"seq": 1759..., "role": "assistant", "text": "...", ...}]}
    {"type": "engines", "llm": {...}, "tts": {...}, "stt": {...}}   # engine state
    {"type": "voices", "voices": [...], "voice": "..."}  # voice list (changes with the engine)
    {"type": "providers", "kind": "llm", "selected": {...}, "settings": {...}}  # engines changed
    {"type": "context", "activity": {...}, "present": true, ...}  # what the user does at the PC
    {"type": "reminders", "reminders": [...]}  # pending timers and reminders
    {"type": "memory", "persona": {...}, "facts": [...]}  # personality and memories
    {"type": "working", "kind": "read", "label": "reads main.js"}  # an agent uses a tool
    {"type": "reminder", "event": "fired", "reminder": {...}}  # one just went off
    {"type": "gesture", "name": "yawn"}      # a gesture going with a spontaneous comment
    {"type": "preferences", ...}             # how much she chats and about what
    {"type": "notify", "source": "claude", "title": "Claude Code", ...}  # an external agent is done
    {"type": "usage", "agents": [...]}      # usage and limits of Claude Code, Codex, Antigravity
    {"type": "capture", "text": "..."}       # "look at the screen": take a screenshot
    {"type": "state",  "value": "thinking" | "speaking" | "idle"}
    {"type": "user",   "text": "...", "seq": 1759...}
    {"type": "token",  "text": "..."}        # the brain's streaming
    {"type": "speech", "audio": "<wav base64>", "visemes": [...], ...}
    {"type": "caption", "text": "..."}       # sentence without audio (muted or broken voice)
    {"type": "reply",  "text": "...", "seq": 1759...}   # complete reply

``seq`` numbers the chat lines; ``transcript`` in the hello holds the last
ones, for whoever reconnects after missing them (see transcript.py).
    {"type": "notice" | "error", "message": "...", "source": "llm", "hint": "..."}
    {"type": "pong"}

Vocals ("Hii!" when she greets) don't go through the WebSocket: the
character asks for them with ``POST /api/vocal`` and only it plays them,
without a broadcast.

The ``speech`` message is what drives the lip-sync: it holds the WAV in
base64 and the ``[{t, d, v, w}, ...]`` timeline (time, duration, viseme,
weight).
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
import contextlib
import dataclasses
import importlib.util
import json
import logging
import os
import subprocess
import sys
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime
from html import escape
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__
from .attachments import MAX_UPLOAD_BYTES, store_upload
from .config import Settings, save_dotenv
from .context import PCContext
from .news import NewsService
from . import notify as agent_notify
from . import phone
from .preferences import Preferences
from .proactive import Proactive
from .reminders import (
    MAX_LATE,
    ReminderStore,
    announcement,
    describe,
    parse_requests,
    task_prompt,
)
from .reminders import Reminder as ReminderItem
from .memory import MemoryStore
from .security import TOKEN_NAME, AccessPolicy, SecurityMiddleware, clean_env_value, is_loopback, within
from .music import MusicService, SpotifyError
from .llm import create_llm_client, describe_error
from .llm.detect import candidates, detect_all
from .phonemes import VISEME_BLENDSHAPES
from .pipeline import Companion
from .providers import REGISTRIES, ProviderSpec, describe_all
from .status import EngineMonitor, llm_entry
from .transcript import Transcript
from .agents_board import AgentBoard
from .tts import build_tts_engine
from .usage import UsageService
from .usage import describe as describe_usage
from .usage import wants_usage
from .vocals import EVENTS as VOCAL_EVENTS
from .weather import WeatherService

logger = logging.getLogger("tsukumo")

SETTINGS = Settings.from_env()
#: Who can talk to the backend (Host, Origin, token for whoever isn't on the PC).
POLICY = AccessPolicy.from_settings(SETTINGS)

#: Environment variable that says which engine is active, per kind.
SELECT_KEYS = {"llm": "DC_LLM_BACKEND", "tts": "DC_TTS_ENGINE", "stt": "DC_STT_ENGINE"}

#: What the user is doing at the PC, updated by the Electron shell (see context.py).
PC = PCContext()

#: How much she chats and about what, and the weather's city (state/preferences.json).
PREFERENCES = Preferences(SETTINGS.state_dir / "preferences.json")
WEATHER = WeatherService()
NEWS = NewsService()

#: Timers and reminders, saved in state/reminders.json (see reminders.py).
REMINDERS = ReminderStore(SETTINGS.state_dir / "reminders.json")
MEMORY = MemoryStore(SETTINGS.state_dir / "memory.json")

#: Usage and limits of the agents you use on your own (usage.py): local files only.
USAGE = UsageService(SETTINGS.state_dir, linked=agent_notify.statusline_installed)
#: How often to read the usage again (s): the limits move at every reply of the agent.
USAGE_INTERVAL = 60.0


async def _music_changed(status: dict[str, Any]) -> None:
    await _broadcast({"type": "music", **status})


#: Spotify and the music taste (state/spotify.json, state/music_taste.json).
#: Spotify accepts only 127.0.0.1 as a local return address, not "localhost".
MUSIC = MusicService(
    SETTINGS.state_dir,
    redirect_uri=f"http://127.0.0.1:{SETTINGS.port}/api/music/spotify/callback",
    on_change=_music_changed,
)


#: Wakes the scheduler when something changes (created in the right loop, at startup).
_reminders_wake: asyncio.Event | None = None

#: Clients that can take a screenshot (the character's window in Electron).
SCREEN_CLIENTS: set[WebSocket] = set()

#: Brains found on the PC (see ``llm/detect.py``): ``{id: {"found", "detail"}}``.
#: It fills in the background shortly after startup; before that it's empty.
DETECTED: dict[str, dict[str, Any]] = {}
#: The detection is over: the introduction waits for it before saying "I found nothing".
DETECTION_DONE = asyncio.Event()
#: Listening turned on by the introduction (installs, chooses, prepares the model): state for the panel.
LISTENING_JOB: dict[str, Any] = {"state": "idle", "detail": ""}


# ---------------------------------------------------------------------------
# WebSocket connections
# ---------------------------------------------------------------------------
class ConnectionHub:
    """Keeps track of the connected clients and broadcasts.

    The broadcast is needed because there are several open windows (the
    character, the panel, maybe a browser tab): they must all see the same
    state and the same avatar speaking.

    "Text only" clients (the phone's page, ``/ws?mode=text``) don't receive the
    audio: on the phone, maybe on 4G, it would only be weight.

    The chat lines also go through ``transcript``, which numbers them and keeps
    them for whoever reconnects (see transcript.py).
    """

    #: Fields a text-only client doesn't receive.
    HEAVY = frozenset({"audio", "visemes"})

    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._text_only: set[WebSocket] = set()
        self._lock = asyncio.Lock()
        self.transcript = Transcript()
        #: The agents at work (dashboard): Tsukumo's agent is followed from here.
        self.agents = AgentBoard(own_name=lambda: _brain_label())

    async def add(self, websocket: WebSocket, text_only: bool = False) -> None:
        async with self._lock:
            self._clients.add(websocket)
            if text_only:
                self._text_only.add(websocket)

    async def remove(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._clients.discard(websocket)
            self._text_only.discard(websocket)

    @property
    def count(self) -> int:
        return len(self._clients)

    async def broadcast(self, message: dict[str, Any]) -> None:
        message = self.transcript.observe(message)
        agents_changed = self.agents.observe(message)
        async with self._lock:
            targets = list(self._clients)
            text_only = set(self._text_only)
        light = {k: v for k, v in message.items() if k not in self.HEAVY} if text_only and self.HEAVY & message.keys() else message
        dead: list[WebSocket] = []
        for client in targets:
            try:
                await client.send_json(light if client in text_only else message)
            except Exception:
                dead.append(client)
        if dead:
            async with self._lock:
                for client in dead:
                    self._clients.discard(client)
                    self._text_only.discard(client)
        if agents_changed:
            await self.broadcast({"type": "agents", "agents": self.agents.public()})


hub = ConnectionHub()


def _brain_label() -> str:
    """The current brain's name ("Claude Code"), for the dashboard."""
    instance = getattr(app.state, "companion", None)
    return str(getattr(getattr(instance, "llm", None), "label", "") or "Tsukumo")

#: Background tasks must be referenced, otherwise the garbage collector may
#: collect them halfway through (see asyncio.create_task in the docs).
_background_tasks: set[asyncio.Task] = set()


def _current() -> Companion | None:
    return getattr(app.state, "companion", None)


monitor = EngineMonitor(_current, interval=SETTINGS.status_interval, on_change=hub.broadcast)


async def _broadcast(message: dict[str, Any]) -> None:
    # Indirect on purpose: so whoever replaces hub.broadcast (the tests) counts here too.
    await hub.broadcast(message)


#: Spontaneous comments (see proactive.py).
PROACTIVE = Proactive(
    companion=_current,
    context=PC,
    preferences=PREFERENCES,
    broadcast=_broadcast,
    weather=WEATHER,
    news=NEWS,
    usage=lambda: USAGE.latest,
)


# ---------------------------------------------------------------------------
# Application lifecycle
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    logging.basicConfig(
        level=getattr(logging, SETTINGS.log_level.upper(), logging.INFO),
        format="%(asctime)s  %(levelname)-7s %(name)s  %(message)s",
        datefmt="%H:%M:%S",
    )
    # The status checks make an HTTP request every few seconds: without this
    # they'd be two lines of httpx every time, filling the log.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logger.info("Tsukumo %s starting...", __version__)
    # Loading the models (Kokoro, Whisper) blocks: in a thread.
    app.state.companion = await asyncio.to_thread(Companion, SETTINGS)
    await monitor.start()
    _attach(app.state.companion)
    _spawn(_load_voices(app.state.companion), report=False)
    global _reminders_wake
    _reminders_wake = asyncio.Event()
    _write_running_marker()
    reminder_task = asyncio.create_task(_reminder_loop(), name="reminders")
    await MUSIC.start()
    if SETTINGS.proactive:
        await PROACTIVE.start()
    if SETTINGS.detect_engines:
        _spawn(_detect_engines(), report=False)
    else:
        DETECTION_DONE.set()
    usage_task = asyncio.create_task(_usage_loop(), name="usage")
    # The PC's name on Tailscale, for the phone (phone.py). It's a probe on the
    # PC like the engine detection, and it's turned off with it (in the tests).
    tailscale_task = asyncio.create_task(_detect_tailscale(), name="tailscale") if SETTINGS.detect_engines else None

    if not is_loopback(POLICY.bind_host):
        logger.warning(
            "Listening on %s: other devices need the access token (%s)",
            POLICY.bind_host,
            POLICY.token_path,
        )
        POLICY.token  # created now, so the file is already there
    companion = app.state.companion
    logger.info(
        "Ready: brain=%s  voice=%s  listening=%s  -> http://%s:%s",
        SETTINGS.selected("llm"),
        companion.tts.name,
        SETTINGS.selected("stt") or "none",
        SETTINGS.host,
        SETTINGS.port,
    )
    try:
        yield
    finally:
        for task in (reminder_task, usage_task, tailscale_task):
            if task is None:
                continue
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        await PROACTIVE.stop()
        await MUSIC.stop()
        _running_marker().unlink(missing_ok=True)
        await monitor.stop()
        await app.state.companion.close()
        logger.info("Tsukumo stopped")


app = FastAPI(title="Tsukumo", version=__version__, lifespan=lifespan)
# CORS is only for the origins added by hand (DC_CORS_ORIGINS): Tsukumo's
# pages are on the backend's own origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(POLICY.extra_origins),
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Content-Type", "Authorization"],
)
# Added last = the outermost: it decides before everything else.
app.add_middleware(SecurityMiddleware, policy=lambda: POLICY)


def companion() -> Companion:
    instance = _current()
    if instance is None:  # pragma: no cover - only if called too early
        raise HTTPException(status_code=503, detail="Companion not ready yet")
    return instance


async def _load_voices(instance: Companion) -> None:
    """Loads the active engine's voices and sends them to everyone."""
    voices = await instance.load_voices()
    if instance is _current():
        await hub.broadcast({"type": "voices", "voices": voices, **instance.current_settings()})


# ---------------------------------------------------------------------------
# REST request models
# ---------------------------------------------------------------------------
class ChatRequest(BaseModel):
    text: str = Field(..., min_length=1, description="Messaggio dell'utente")


class SayRequest(BaseModel):
    text: str = Field(..., min_length=1, description="Text to speak")
    voice: str | None = Field(None, description="Voice of the active engine")
    speed: float | None = Field(None, gt=0.25, le=3.0, description="Reading speed")


class NotifyRequest(BaseModel):
    message: str = Field("", max_length=20_000, description="The agent's last message, or the request")
    source: str = Field("", max_length=40, description="claude, codex, or any name")
    kind: str = Field("done", description="done, waiting (for you), working (started), tasks (task list)")
    session: str = Field("", max_length=120, description="The agent's session")
    project: str = Field("", max_length=200, description="The folder it works in")
    tool: str = Field("", max_length=40, description="tasks: the tool (TodoWrite, TaskCreate, TaskUpdate)")
    input: dict[str, Any] | None = Field(None, description="tasks: the tool's input")
    response: Any = Field(None, description="tasks: the tool's response")


class IntegrationRequest(BaseModel):
    tool: str = Field(..., description="claude, codex or claude_usage (the status line)")
    action: str = Field(..., description="install or uninstall")


class ReminderRequest(BaseModel):
    phrase: str | None = Field(None, description="Request in words: 'remind me to drink in 20 minutes'")
    kind: str = Field("reminder", description="timer, reminder, alarm, task")
    text: str = Field("", description="What to remember or do")
    at: str | None = Field(None, description="When, in local ISO: 2026-12-29T12:00")
    seconds: float | None = Field(None, gt=0, description="Or in how many seconds")
    repeat: str = Field("", description="'' or 'daily'")


class PersonaRequest(BaseModel):
    name: str | None = Field(None, max_length=40, description="What she's called")
    traits: str | None = Field(None, max_length=400, description="Her character, in a few words")


class FactRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=200, description="A memory: 'has a cat called Miso'")


class ContextRequest(BaseModel):
    idle: float = Field(0, ge=0, description="Seconds without mouse or keyboard")
    locked: bool = Field(False, description="Screen locked")
    app: dict[str, Any] | None = Field(None, description="Foreground window: title, exe, fullscreen, own")


class VocalRequest(BaseModel):
    event: str = Field(..., description="greet, morning, evening, night, welcome, pat, poke, lift, fall, pout, dizzy")


class ProviderRequest(BaseModel):
    kind: str = Field(..., description="Engine kind: llm, tts or stt")
    provider: str = Field(..., min_length=1, description="Engine id, e.g. 'ollama'")
    options: dict[str, str | None] = Field(
        default_factory=dict,
        description="Fields declared by the engine; null or empty goes back to the default",
    )


# ---------------------------------------------------------------------------
# REST API
# ---------------------------------------------------------------------------
@app.get("/api/health")
async def health() -> dict[str, Any]:
    """Is the backend alive? It always answers right away: it never uses the network.

    The Electron shell queries it at startup with a timeout of a few seconds:
    if in here we waited for an external service (as happened with the OpenClaw
    Gateway off) the companion wouldn't start at all.
    """
    instance = _current()
    return {
        "ok": instance is not None,
        "app": "tsukumo",
        "version": __version__,
        "clients": hub.count,
        "engines": monitor.status,
        "avatar": _avatar_info(),
    }


@app.get("/api/status")
async def status() -> dict[str, Any]:
    """Engine state, forcing an immediate check."""
    return await monitor.check()


@app.get("/api/config")
async def config() -> dict[str, Any]:
    return {
        **SETTINGS.public_dict(),
        "blendshapes": VISEME_BLENDSHAPES,
        "avatar": _avatar_info(),
    }


@app.get("/api/providers")
async def providers() -> dict[str, Any]:
    """Schemas of all the available engines, plus the active one per kind.

    The panel draws the settings by reading this answer, so a new engine shows
    up by itself without changes to the frontend. Secret fields arrive as a
    boolean ("set" / "not set"), never in the clear.
    """
    return {
        "providers": describe_all(),
        "selected": {kind: SETTINGS.selected(kind) for kind in REGISTRIES},
        "options": {kind: SETTINGS.provider_public(kind) for kind in REGISTRIES},
        "saved": {kind: _saved_options(kind) for kind in REGISTRIES},
        "status": monitor.status,
        "detected": {"llm": DETECTED},
    }


def _saved_options(kind: str) -> dict[str, dict[str, Any]]:
    """The saved values of *every* engine (not only the active one), secrets masked.

    The panel needs it to show an engine's configuration before activating it:
    "the ElevenLabs key is already there", without writing it again.
    """
    result: dict[str, dict[str, Any]] = {}
    for spec in REGISTRIES[kind].all():
        values: dict[str, Any] = {}
        for spec_field in spec.fields:
            raw = SETTINGS.provider_options.get(spec_field.env)
            if raw is None:
                continue
            values[spec_field.env] = bool(raw) if spec_field.secret else raw
        result[spec.id] = values
    return result


def _spec_or_400(kind: str, provider: str) -> ProviderSpec:
    if kind not in REGISTRIES:
        raise HTTPException(status_code=400, detail=f"Tipo sconosciuto: {kind!r}")
    spec = REGISTRIES[kind].get(provider)
    if spec is None:
        raise HTTPException(status_code=400, detail=f"Unknown engine: {provider!r}")
    return spec


def _request_options(spec: ProviderSpec, options: dict[str, str | None]) -> dict[str, str]:
    """Only the fields the engine declares: the panel can't write arbitrary variables.

    A secret left empty means "I didn't touch it", not "delete it".
    """
    allowed = {f.env: f for f in spec.fields}
    unknown = set(options) - set(allowed)
    if unknown:
        raise HTTPException(status_code=400, detail=f"Fields not expected by {spec.id!r}: {sorted(unknown)}")
    cleaned: dict[str, str] = {}
    for env_name, value in options.items():
        text = "" if value is None else str(value)
        if allowed[env_name].secret and not text.strip():
            continue
        if len(text) > 4096:
            raise HTTPException(status_code=400, detail=f"Value too long for {env_name}")
        spec_field = allowed[env_name]
        if spec_field.type == "select" and env_name.endswith(("_PERMISSION", "_SANDBOX")) and text:
            # An agent's permissions only among the menu's: no "bypassPermissions" on the sly.
            if text not in {option["value"] for option in spec_field.options}:
                raise HTTPException(status_code=400, detail=f"{env_name}: unexpected value {text!r}")
        try:
            cleaned[env_name] = clean_env_value(text)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"{env_name}: {exc}") from exc
    return cleaned


def _draft_settings(kind: str, spec: ProviderSpec, options: dict[str, str]) -> Settings:
    """The settings you'd have applying ``options``, without saving them."""
    base = Settings.from_env()
    merged = {**base.provider_options, **options}
    attr = Settings._SELECTED_ATTR[kind]
    return dataclasses.replace(base, provider_options=merged, **{attr: spec.id})


@app.post("/api/providers/check")
async def check_provider(request: ProviderRequest) -> dict[str, Any]:
    """Tries an engine with the panel's values *without* activating it.

    It's the "Check" button: it says whether the key is valid, how many voices
    there are, how much of the plan is left, whether the agent is installed —
    before finding out at the first sentence.
    """
    spec = _spec_or_400(request.kind, request.provider)
    options = _request_options(spec, request.options)
    draft = _draft_settings(request.kind, spec, options)
    instance = companion()
    active = SETTINGS.selected(request.kind) == spec.id and not options

    try:
        if request.kind == "llm":
            return await _check_llm(spec, draft, instance if active else None)
        if request.kind == "tts":
            return await asyncio.wait_for(_check_tts(spec, draft, instance if active else None), 40)
        return await _check_stt(spec, draft)
    except Exception as exc:
        return {"ok": False, "detail": describe_error(exc)}


async def _check_llm(spec: ProviderSpec, draft: Settings, instance: Companion | None) -> dict[str, Any]:
    client = instance.llm if instance else await asyncio.to_thread(create_llm_client, draft)
    try:
        probe = await client.probe()
    finally:
        if instance is None:
            await client.close()
    entry = llm_entry(spec.id, probe)
    detail = entry["detail"]
    if not detail and entry["state"] == "online":
        detail = f"Risponde{' — ' + str(entry['model']) if entry.get('model') else ''}"
    return {
        "ok": entry["state"] in ("online", "degraded"),
        "state": entry["state"],
        "detail": detail,
        "hint": entry["hint"],
        "models": entry.get("models") or [],
    }


async def _check_tts(spec: ProviderSpec, draft: Settings, instance: Companion | None) -> dict[str, Any]:
    if instance is not None:
        result = await asyncio.to_thread(instance.tts.check)
    else:

        def run() -> dict[str, Any]:
            engine = build_tts_engine(spec.id, draft)
            try:
                return engine.check()
            finally:
                engine.close()

        result = await asyncio.to_thread(run)
    if result.get("ok") and "voices" not in result:
        engine_voices = instance.voice_list if instance else None
        if engine_voices:
            result["voices"] = engine_voices
    return result


async def _check_stt(spec: ProviderSpec, draft: Settings) -> dict[str, Any]:
    options = draft.provider_config("stt", spec.id)
    if spec.id == "faster_whisper":
        if importlib.util.find_spec("faster_whisper") is None:
            return {"ok": False, "detail": "Pacchetto mancante: pip install faster-whisper"}
        return {"ok": True, "detail": f"Ready (model {options.get('WHISPER_MODEL') or 'base'})"}
    if spec.id == "whisper_cpp":
        url = str(options.get("WHISPER_CPP_URL") or "")
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                await client.get(url)
        except httpx.HTTPError as exc:
            return {"ok": False, "detail": f"Server unreachable: {describe_error(exc)}"}
        return {"ok": True, "detail": "Server reachable"}
    if spec.id == "openai_whisper_api" and not options.get("STT_API_KEY"):
        return {"ok": False, "detail": "The API key is missing"}
    return {"ok": True, "detail": "No check needed"}


@app.post("/api/providers")
async def set_provider(request: ProviderRequest) -> dict[str, Any]:
    """Changes the active engine for a kind, saving the choice in ``.env``.

    Only that engine is rebuilt: the conversation and the other engines stay as
    they are. First we write, then we rebuild: if the rebuild fails (wrong key,
    missing package, program not installed) we restore the previous values and
    answer with the reason, instead of leaving the companion in a half-way
    state.
    """
    kind = request.kind
    spec = _spec_or_400(kind, request.provider)
    options = _request_options(spec, request.options)

    updates = {SELECT_KEYS[kind]: spec.id}
    updates.update({f"DC_{name}": value for name, value in options.items()})
    previous = {key: os.environ.get(key, "") for key in updates}
    save_dotenv(updates)

    instance = companion()
    if kind != "stt":  # listening has nothing to do with the turns: the reply in progress stays
        instance.cancel()  # a turn halfway would use the engine we're about to close
    try:
        new_settings = Settings.from_env()
        async with instance._turn_lock:
            old = await asyncio.to_thread(instance.replace_engine, kind, new_settings)
    except Exception as exc:
        save_dotenv(previous)  # we put everything back as it was
        logger.warning("Changing %s to %r failed: %s", kind, spec.id, exc)
        return {"ok": False, "error": describe_error(exc), "kind": kind, "provider": spec.id}

    await _engine_changed(kind, instance, new_settings, old)
    logger.info("Engine %s changed to %r", kind, spec.id)
    return {
        "ok": True,
        "kind": kind,
        "provider": spec.id,
        "options": SETTINGS.provider_public(kind),
    }


@app.post("/api/providers/options")
async def save_provider_options(request: ProviderRequest) -> dict[str, Any]:
    """Saves an engine's fields (a key, a model) *without* activating it.

    It's for whoever uses a temporary engine, like the chatter brain: the
    OpenRouter key is saved without OpenRouter becoming the main brain. The
    active engine isn't touched: for that there's ``/api/providers``.
    """
    global SETTINGS

    spec = _spec_or_400(request.kind, request.provider)
    options = _request_options(spec, request.options)
    if spec.id == SETTINGS.selected(request.kind):
        raise HTTPException(status_code=400, detail=f"{spec.label} is the active engine: it's changed from Engines.")
    if options:
        save_dotenv({f"DC_{name}": value for name, value in options.items()})
        SETTINGS = dataclasses.replace(SETTINGS, provider_options=Settings.from_env().provider_options)
        instance = companion()
        instance.settings = dataclasses.replace(instance.settings, provider_options=SETTINGS.provider_options)
        await _announce_providers(request.kind, instance)
    return {"ok": True, "kind": request.kind, "provider": spec.id, "saved": _saved_options(request.kind)[spec.id]}


async def _engine_changed(kind: str, instance: Companion, new_settings: Settings, old: object | None) -> None:
    """After a successful engine change: new settings, old one closed, clients notified."""
    global SETTINGS

    SETTINGS = new_settings
    await _close_engine(old)
    monitor.poke()
    if kind == "tts":
        _spawn(_load_voices(instance), report=False)
    await _announce_providers(kind, instance)


async def _announce_providers(kind: str, instance: Companion | None) -> None:
    """The panel reads ``/api/providers`` again when it receives this message."""
    await hub.broadcast(
        {
            "type": "providers",
            "kind": kind,
            "selected": {k: SETTINGS.selected(k) for k in REGISTRIES},
            "settings": instance.current_settings() if instance is not None else {},
        }
    )


# ---------------------------------------------------------------------------
# Detection of the installed brains
# ---------------------------------------------------------------------------
def _llm_chosen() -> bool:
    """Someone chose the brain: in the .env, in the environment or from the panel."""
    return bool(os.environ.get(SELECT_KEYS["llm"], "").strip())


async def _detect_engines() -> None:
    """Looks for brains on the PC; if nobody chose one, it uses the first found.

    The same for listening: if Faster-Whisper is installed and nobody chose, it
    turns on by itself (the model loads at the first sentence).
    """
    global DETECTED

    try:
        DETECTED = await detect_all(lambda provider: SETTINGS.provider_config("llm", provider))
        found = candidates(DETECTED)
        logger.info("Brains found on the PC: %s", ", ".join(found) or "none")
        if await _auto_select_llm(found) is None:
            # No change: the panel must see the badges anyway.
            await _announce_providers("llm", _current())
        await _auto_select_stt()
    finally:
        DETECTION_DONE.set()


def _stt_chosen() -> bool:
    return bool(os.environ.get(SELECT_KEYS["stt"], "").strip())


def _whisper_installed() -> bool:
    return importlib.util.find_spec("faster_whisper") is not None


async def _auto_select_stt() -> str | None:
    """Turns on Faster-Whisper if it's there and nobody chose the listening (not even "off")."""
    instance = _current()
    if instance is None or _stt_chosen() or SETTINGS.selected("stt") != "none":
        return None
    if not await asyncio.to_thread(_whisper_installed):
        return None
    result = await set_provider(ProviderRequest(kind="stt", provider="faster_whisper", options={}))
    if result.get("ok"):
        logger.info("Listening turned on automatically: faster_whisper (saved in the .env)")
        return "faster_whisper"
    return None


async def _auto_select_llm(found: list[str]) -> str | None:
    """Puts the first brain found in use and saves it in the .env.

    It never touches an explicit choice. If an engine found doesn't start (for
    example OpenClaw on but without a token) it tries the next. The turn in
    progress isn't interrupted: it waits for it to end.
    """
    instance = _current()
    if instance is None:
        return None
    for provider in found:
        if _llm_chosen():
            return None
        new_settings = dataclasses.replace(SETTINGS, llm_backend=provider)
        async with instance._turn_lock:
            if _llm_chosen():  # chosen from the panel while we were waiting
                return None
            try:
                old = await asyncio.to_thread(instance.replace_engine, "llm", new_settings)
            except Exception as exc:
                logger.info("%s is there but doesn't start: %s", provider, describe_error(exc))
                continue
            save_dotenv({SELECT_KEYS["llm"]: provider})
        await _engine_changed("llm", instance, new_settings, old)
        logger.info("Brain chosen automatically: %s (saved in the .env)", provider)
        return provider
    return None


async def _close_engine(engine: object | None) -> None:
    """Closes a replaced engine, whatever its kind."""
    if engine is None:
        return
    close = getattr(engine, "close", None)
    if close is None:
        return
    try:
        result = close()
        if asyncio.iscoroutine(result):
            await result
    except Exception as exc:  # pragma: no cover - best-effort close
        logger.debug("Closing the previous engine: %s", exc)


@app.get("/api/voices")
async def voices() -> dict[str, Any]:
    """Voices of the active TTS engine: the list changes with the chosen engine."""
    instance = companion()
    catalog = instance.voice_list if instance.voice_list is not None else await instance.load_voices()
    return {"voices": catalog, "engine": instance.tts.name, **instance.current_settings()}


@app.post("/api/voices/clone")
async def clone_voice(request: Request, name: str = "Voice", language: str = "it") -> dict[str, Any]:
    """Clones a voice from an audio file (the body is the file, as for attachments) and picks it."""
    instance = companion()
    if not instance.tts.can_clone:
        raise HTTPException(status_code=400, detail=f"{instance.tts.name} can't clone voices: switch to Chatterbox")
    if int(request.headers.get("content-length") or 0) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File troppo grande")
    data = await request.body()
    try:
        voice_id = await asyncio.to_thread(instance.tts.add_voice, name, data, language)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await instance.load_voices()
    settings = await asyncio.to_thread(instance.update_settings, voice=voice_id)
    await hub.broadcast({"type": "voices", "voices": instance.voice_list, **settings})
    return {"ok": True, "voice": voice_id}


@app.delete("/api/voices/{voice_id}")
async def delete_voice(voice_id: str) -> dict[str, Any]:
    instance = companion()
    if not instance.tts.can_clone:
        raise HTTPException(status_code=400, detail="The active engine has no cloned voices")
    try:
        await asyncio.to_thread(instance.tts.remove_voice, voice_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if instance.voice == voice_id:
        instance.update_settings(voice=instance.tts.default_voice)
    await _load_voices(instance)
    return {"ok": True}


@app.post("/api/transcribe")
async def api_transcribe(request: Request) -> dict[str, Any]:
    """Transcribes 16-bit 16 kHz mono PCM without starting a turn: it's the microphone test."""
    if int(request.headers.get("content-length") or 0) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Audio troppo lungo")
    try:
        transcript = await companion().transcribe(await request.body())
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Speech recognition isn't working: {describe_error(exc)}") from exc
    if transcript is None:
        raise HTTPException(status_code=400, detail="Speech recognition isn't active: choose it in Engines, Listening section.")
    return {"text": transcript.text, "language": transcript.language}


@app.post("/api/say")
async def api_say(request: SayRequest) -> dict[str, Any]:
    """Synthesizes without the brain and returns audio + visemes (handy with curl)."""
    payloads = await companion().synthesize_payload(request.text, request.voice, request.speed)
    for payload in payloads:
        await hub.broadcast(payload)
    return {"chunks": [_without_audio(p) for p in payloads], "count": len(payloads)}


@app.post("/api/chat")
async def api_chat(request: ChatRequest) -> dict[str, Any]:
    """A full turn; the audio is sent to the connected WebSocket clients."""
    reply = await companion().chat(request.text, hub.broadcast)
    return {"reply": reply, "clients": hub.count}


# ---------------------------------------------------------------------------
# Timers and reminders
# ---------------------------------------------------------------------------
def _attach(instance: Companion) -> None:
    """Connects the reminders, the screenshot and the notices to the companion."""
    instance.reminders = REMINDERS
    instance.on_reminders_changed = _reminders_changed
    instance.memory = MEMORY
    instance.on_memory_changed = _memory_changed
    instance.screen_capture = _request_screen
    instance.music = MUSIC
    instance.usage_reply = _usage_reply


async def _usage_reply(prompt: str, lang: str) -> str | None:
    """ "How much Claude do I have left?": answered from the files, without the brain."""
    only = wants_usage(prompt)
    if only is None:
        return None
    snapshot = await asyncio.to_thread(USAGE.snapshot, True)
    return describe_usage(snapshot, lang, only)


async def _usage_loop() -> None:
    """Reads the agents' usage again every minute; if it changed it sends it to everyone."""
    last = None
    while True:
        try:
            snapshot = await asyncio.to_thread(USAGE.snapshot, True)
            key = json.dumps(snapshot["agents"], sort_keys=True, default=str)
            if key != last:
                last = key
                await hub.broadcast({"type": "usage", **snapshot})
        except asyncio.CancelledError:
            raise
        except Exception:  # pragma: no cover - it must never die
            logger.exception("Agent usage")
        await asyncio.sleep(USAGE_INTERVAL)


async def _request_screen(text: str) -> bool:
    """Asks whoever can for a screenshot; the message will come back with the file attached."""
    targets = list(SCREEN_CLIENTS)
    if not targets:
        return False
    try:
        await targets[0].send_json({"type": "capture", "text": text})
    except Exception:
        SCREEN_CLIENTS.discard(targets[0])
        return False
    return True


async def _reminders_changed() -> None:
    if _reminders_wake is not None:
        _reminders_wake.set()
    await hub.broadcast({"type": "reminders", "reminders": [item.as_dict() for item in REMINDERS.all()]})


async def _reminder_loop() -> None:
    """Sleeps until the next reminder (or a change), then fires it."""
    assert _reminders_wake is not None
    while True:
        try:
            await _fire_due_reminders()
        except asyncio.CancelledError:
            raise
        except Exception:  # pragma: no cover - the scheduler must not die
            logger.exception("Reminder scheduler")
        upcoming = REMINDERS.next_due()
        delay = 30.0 if upcoming is None else min(30.0, max(0.05, upcoming - time.time()))
        _reminders_wake.clear()
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(_reminders_wake.wait(), delay)


async def _fire_due_reminders(now: float | None = None) -> list[ReminderItem]:
    now = time.time() if now is None else now
    fired: list[ReminderItem] = []
    for reminder in REMINDERS.due(now):
        late = now - reminder.due
        REMINDERS.done(reminder, now)
        if late > MAX_LATE:
            logger.info("Reminder too old, skipping it: %s", describe(reminder))
            continue
        fired.append(reminder)
        logger.info("Due: %s", describe(reminder))
        await hub.broadcast({"type": "reminder", "event": "fired", "reminder": reminder.as_dict(), "late": round(late)})
        instance = _current()
        if instance is None:
            continue
        if reminder.kind == "task":
            _spawn(instance.chat(task_prompt(reminder), hub.broadcast, hidden=True))
        else:
            _spawn(instance.announce(announcement(reminder, late), hub.broadcast, event=f"Reminder due: {describe(reminder)}"))
    if fired:
        await hub.broadcast({"type": "reminders", "reminders": [item.as_dict() for item in REMINDERS.all()]})
    return fired


@app.post("/api/attachments")
async def upload_attachment(request: Request, name: str = "file") -> dict[str, Any]:
    """A file from the browser (which doesn't know the paths): it saves it and returns its path.

    The body is the file as it is (no multipart): ``POST /api/attachments?name=photo.png``.
    """
    length = int(request.headers.get("content-length") or 0)
    if length > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File troppo grande")
    data = await request.body()
    try:
        path = await asyncio.to_thread(store_upload, SETTINGS.state_dir / "uploads", name, data)
    except ValueError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    return {"ok": True, "path": str(path), "name": path.name}


# ---------------------------------------------------------------------------
# Personality and memories (backend/memory.py)
# ---------------------------------------------------------------------------
async def _memory_changed() -> None:
    await hub.broadcast({"type": "memory", **MEMORY.as_dict()})


@app.get("/api/memory")
async def get_memory() -> dict[str, Any]:
    return MEMORY.as_dict()


@app.put("/api/memory/persona")
async def set_persona(request: PersonaRequest) -> dict[str, Any]:
    MEMORY.set_persona(name=request.name, traits=request.traits)
    await _memory_changed()
    return MEMORY.as_dict()


@app.post("/api/memory/facts")
async def add_fact(request: FactRequest) -> dict[str, Any]:
    fact = MEMORY.add(request.text)
    if fact is None:
        raise HTTPException(status_code=400, detail="Empty memory or already there")
    await _memory_changed()
    return {"ok": True, "fact": fact.as_dict()}


@app.delete("/api/memory/facts/{fact_id}")
async def delete_fact(fact_id: str) -> dict[str, Any]:
    if MEMORY.remove(fact_id) is None:
        raise HTTPException(status_code=404, detail="Memory not found")
    await _memory_changed()
    return {"ok": True}


@app.delete("/api/memory/facts")
async def clear_facts() -> dict[str, Any]:
    MEMORY.clear()
    await _memory_changed()
    return {"ok": True}


@app.get("/api/reminders")
async def list_reminders() -> dict[str, Any]:
    return {"reminders": [item.as_dict() for item in REMINDERS.all()]}


@app.post("/api/reminders")
async def add_reminder(request: ReminderRequest) -> dict[str, Any]:
    """A reminder from the panel: in words (``phrase``) or with the fields."""
    if request.phrase:
        # The Agenda's field is already a request: "giovedì e venerdì compito" is enough.
        parsed = parse_requests(request.phrase, explicit=True)
        if not parsed:
            raise HTTPException(status_code=400, detail="I didn't get when: try 'in 20 minutes' or 'tomorrow at 9'.")
        added = [REMINDERS.add(item.to_reminder()) for item in parsed]
        await _reminders_changed()
        # "reminder" is the first one, for the clients that expect a single one.
        return {"ok": True, "reminder": added[0].as_dict(), "reminders": [item.as_dict() for item in added]}
    if request.kind not in ("timer", "reminder", "alarm", "task"):
        raise HTTPException(status_code=400, detail=f"Tipo sconosciuto: {request.kind!r}")
    if request.seconds:
        due = time.time() + request.seconds
    elif request.at:
        try:
            due = datetime.fromisoformat(request.at).timestamp()
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"Invalid date: {request.at!r}") from exc
    else:
        raise HTTPException(status_code=400, detail="'at' or 'seconds' is needed.")
    if due <= time.time():
        raise HTTPException(status_code=400, detail="That time has already passed.")
    instance = _current()
    reminder = ReminderItem(
        kind=request.kind,
        due=due,
        text=request.text.strip(),
        repeat="daily" if request.repeat == "daily" else "",
        duration=(request.seconds or 0.0) if request.kind == "timer" else 0.0,
        language="it" if (instance.voice_language if instance else "it") == "it" else "en",
    )
    REMINDERS.add(reminder)
    await _reminders_changed()
    return {"ok": True, "reminder": reminder.as_dict()}


@app.delete("/api/reminders/{reminder_id}")
async def delete_reminder(reminder_id: str) -> dict[str, Any]:
    removed = REMINDERS.remove(reminder_id)
    if removed is None:
        raise HTTPException(status_code=404, detail="Reminder not found")
    await _reminders_changed()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Notifications from external agents (Claude Code, Codex)
# ---------------------------------------------------------------------------
def _running_marker() -> Path:
    return SETTINGS.state_dir / "running.json"


def _write_running_marker() -> None:
    """Tells the hooks (scripts/tsukumo_notify.py) that the backend is on and where."""
    try:
        SETTINGS.state_dir.mkdir(parents=True, exist_ok=True)
        _running_marker().write_text(
            json.dumps({"host": SETTINGS.host, "port": SETTINGS.port, "pid": os.getpid()}), encoding="utf-8"
        )
    except OSError as exc:  # pragma: no cover
        logger.warning("Signal for the hooks not written: %s", exc)


#: When she last spoke about an external agent (so as not to repeat herself).
_last_notice = {"at": 0.0}


@app.post("/api/notify")
async def api_notify(request: NotifyRequest) -> dict[str, Any]:
    """An external agent is done (or waiting for you): she calls you.

    If you're already looking at the editor or the terminal a bubble is enough;
    if you're elsewhere she chimes, knocks and says it; in full screen or in a
    meeting only Windows' notification.
    """
    instance = companion()
    source = request.source.strip().lower()
    # For the dashboard: who works and on what. "working" and "tasks" aren't announced.
    if hub.agents.external(
        source, request.kind, request.session, request.project, request.message, request.tool, request.input, request.response
    ):
        await hub.broadcast({"type": "agents", "agents": hub.agents.public()})
    if request.kind in ("working", "tasks"):
        return {"ok": True, "spoken": False}
    kind = "waiting" if request.kind == "waiting" else "done"
    name = agent_notify.NAMES.get(source, request.source.strip() or "Agent")
    summary = agent_notify.summary_of(request.message)
    looking = PC.fresh and PC.idle < 30 and PC.activity.kind == "coding"
    silent = PC.fresh and PC.activity.dnd
    now = time.time()
    quiet = looking or silent or now - _last_notice["at"] < 15
    await hub.broadcast(
        {"type": "notify", "source": source, "kind": kind, "title": name, "message": summary, "quiet": quiet, "silent": silent}
    )
    if quiet:
        return {"ok": True, "spoken": False}
    _last_notice["at"] = now
    text = agent_notify.announcement(source, kind, summary, instance.voice_language, brief=False)
    _spawn(instance.announce(text, hub.broadcast, event=f"Notification from {name}: {summary or kind}"), report=False)
    return {"ok": True, "spoken": True}


@app.get("/api/agents")
async def get_agents() -> dict[str, Any]:
    """The agents at work: Tsukumo's and the external sessions seen by the hooks."""
    return {"agents": hub.agents.public()}


@app.get("/api/integrations")
async def get_integrations() -> dict[str, Any]:
    return await asyncio.to_thread(agent_notify.status)


@app.post("/api/integrations")
async def set_integration(request: IntegrationRequest) -> dict[str, Any]:
    """Connects or disconnects Claude Code / Codex hooks (files outside the project: only on request)."""
    try:
        result = await asyncio.to_thread(agent_notify.change, request.tool, request.action)
    except KeyError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid request: {exc}") from exc
    except (OSError, ValueError) as exc:
        return {"ok": False, "error": str(exc), "status": await asyncio.to_thread(agent_notify.status)}
    logger.info("Integration %s: %s", request.tool, result)
    if request.tool == "claude_usage":
        # The Work tab shows right away "connected, waiting for the next reply".
        await hub.broadcast({"type": "usage", **await asyncio.to_thread(USAGE.snapshot, True)})
    return {"ok": True, "result": result, "status": await asyncio.to_thread(agent_notify.status)}


# ---------------------------------------------------------------------------
# Agent usage
# ---------------------------------------------------------------------------
@app.get("/api/usage")
async def get_usage() -> dict[str, Any]:
    """Plan limits and today's tokens of Claude Code, Codex and Antigravity (see usage.py)."""
    return await asyncio.to_thread(USAGE.snapshot, True)


# ---------------------------------------------------------------------------
# First start: "I'll set everything up"
# ---------------------------------------------------------------------------
@app.get("/api/setup")
async def setup_status(wait: float = 0) -> dict[str, Any]:
    """What's ready and what's missing, for the introduction.

    With ``wait`` it waits (at most that many seconds) for the brain detection
    to finish: right after installing, the introduction arrives before the
    backend has looked at what's on the PC.
    """
    if wait > 0 and not DETECTION_DONE.is_set():
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(DETECTION_DONE.wait(), timeout=min(wait, 20.0))
    stt = SETTINGS.selected("stt")
    return {
        "detecting": not DETECTION_DONE.is_set(),
        "brain": {
            "selected": SETTINGS.selected("llm"),
            "found": [pid for pid, result in DETECTED.items() if (result or {}).get("found")],
        },
        "listening": {
            "selected": stt,
            "on": stt != "none",
            "local": await asyncio.to_thread(_whisper_installed),
            "job": dict(LISTENING_JOB),
        },
        "integrations": await asyncio.to_thread(agent_notify.status),
        "engines": monitor.status,
    }


@app.post("/api/setup/listening")
async def setup_listening() -> dict[str, Any]:
    """Turns on listening on the PC: installs Faster-Whisper if missing, chooses it and prepares the model.

    It downloads a few hundred MB (package and model), so only when you ask.
    How it goes is followed from ``GET /api/setup`` (``listening.job``).
    """
    if LISTENING_JOB["state"] not in ("installing", "selecting", "loading"):
        LISTENING_JOB.update(state="selecting", detail="One moment…")
        _spawn(_enable_listening(), report=False)
    return {"ok": True, "job": dict(LISTENING_JOB)}


def _pip_install(package: str) -> tuple[int, str]:
    """``pip install`` in the backend's interpreter (the venv, or the installed app's Python)."""
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    result = subprocess.run(
        [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-warn-script-location", package],
        capture_output=True,
        text=True,
        timeout=1800,
        creationflags=flags,
    )
    return result.returncode, (result.stdout + result.stderr)[-2000:]


async def _enable_listening() -> None:
    try:
        if not await asyncio.to_thread(_whisper_installed):
            LISTENING_JOB.update(state="installing", detail="Installing Faster-Whisper (only once, a few minutes)…")
            code, output = await asyncio.to_thread(_pip_install, "faster-whisper")
            importlib.invalidate_caches()
            if code != 0 or not _whisper_installed():
                lines = [line for line in output.splitlines() if line.strip()]
                raise RuntimeError(lines[-1] if lines else "pip couldn't install it")
        if SETTINGS.selected("stt") != "faster_whisper":
            LISTENING_JOB.update(state="selecting", detail="Turning it on…")
            result = await set_provider(ProviderRequest(kind="stt", provider="faster_whisper", options={}))
            if not result.get("ok"):
                raise RuntimeError(result.get("error") or "doesn't start")
        engine = companion().stt
        if engine is not None:
            LISTENING_JOB.update(state="loading", detail="Preparing the model (the first time I download it)…")
            await asyncio.to_thread(engine.prepare)
        LISTENING_JOB.update(state="done", detail="I can hear you: press Ctrl+Space and talk to me.")
        logger.info("Listening turned on by the introduction")
    except Exception as exc:
        LISTENING_JOB.update(state="error", detail=describe_error(exc))
        logger.warning("Listening not turned on: %s", LISTENING_JOB["detail"])


# ---------------------------------------------------------------------------
# Preferences and weather
# ---------------------------------------------------------------------------
@app.get("/api/preferences")
async def get_preferences() -> dict[str, Any]:
    # brainError: why the chatter brain is quiet (key, saturated models).
    return {**PREFERENCES.as_dict(), "brainError": PROACTIVE.status()["brainError"]}


@app.post("/api/preferences")
async def set_preferences(changes: dict[str, Any]) -> dict[str, Any]:
    """How much she chats, about what, and the weather's city. Unknown fields are ignored."""
    current = PREFERENCES.update(changes)
    await hub.broadcast({"type": "preferences", **current})
    return current


@app.get("/api/weather")
async def get_weather() -> dict[str, Any]:
    """The weather the companion sees (it goes through the network: for the panel, not for the checks)."""
    instance = _current()
    language = instance.voice_language if instance else SETTINGS.system_language
    weather = await WEATHER.get(PREFERENCES.city, language)
    return {"ok": weather is not None, "weather": weather.as_dict() if weather else None}


# ---------------------------------------------------------------------------
# Music (Spotify)
# ---------------------------------------------------------------------------
class SpotifySetupRequest(BaseModel):
    clientId: str = Field(max_length=64)


@app.get("/api/music")
async def get_music() -> dict[str, Any]:
    """Spotify connected or not, what's playing (from the last check) and the taste learned."""
    return MUSIC.status()


@app.post("/api/music/spotify/setup")
async def spotify_setup(request: SpotifySetupRequest) -> dict[str, Any]:
    """Saves the Client ID and returns the Spotify page where to give the permission."""
    try:
        MUSIC.spotify.set_client_id(request.clientId)
        return {"authorizeUrl": MUSIC.spotify.authorize_url(MUSIC.redirect_uri)}
    except (ValueError, SpotifyError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/music/spotify/callback", response_class=HTMLResponse)
async def spotify_callback(code: str = "", state: str = "", error: str = "") -> HTMLResponse:
    """Spotify sends the browser back here after the permission: the tokens are taken and the panel told."""
    if error:
        message = _spotify_words("denied") if error == "access_denied" else _spotify_words("answered", error=error)
        return HTMLResponse(_music_page(False, message))
    try:
        user = await MUSIC.spotify.finish(code, state, MUSIC.redirect_uri)
    except (SpotifyError, httpx.HTTPError) as exc:
        return HTMLResponse(_music_page(False, _spotify_words("failed", error=exc)))
    _spawn(MUSIC.refresh(), report=False)
    await _music_changed(MUSIC.status())
    return HTMLResponse(_music_page(True, _spotify_words("connected_as", user=user) if user else _spotify_words("connected")))


@app.post("/api/music/spotify/disconnect")
async def spotify_disconnect() -> dict[str, Any]:
    MUSIC.spotify.disconnect()
    MUSIC.now = None
    await _music_changed(MUSIC.status())
    return MUSIC.status()


@app.post("/api/music/taste/forget")
async def forget_taste() -> dict[str, Any]:
    MUSIC.taste.forget()
    await _music_changed(MUSIC.status())
    return MUSIC.status()


#: Spotify's return page, in the PC's language (it opens in the system browser).
_SPOTIFY_WORDS = {
    "en": {
        "title": "Tsukumo and Spotify",
        "denied": "You denied the permission: Spotify is not connected.",
        "answered": "Spotify answered: {error}",
        "failed": "Connection failed: {error}",
        "connected": "Spotify is connected. You can close this tab.",
        "connected_as": "Spotify is connected as {user}. You can close this tab.",
    },
    "it": {
        "title": "Tsukumo e Spotify",
        "denied": "Hai negato il permesso: Spotify non è collegato.",
        "answered": "Spotify ha risposto: {error}",
        "failed": "Collegamento non riuscito: {error}",
        "connected": "Spotify è collegato. Puoi chiudere questa scheda.",
        "connected_as": "Spotify è collegato come {user}. Puoi chiudere questa scheda.",
    },
}


def _spotify_language() -> str:
    return "it" if SETTINGS.system_language == "it" else "en"


def _spotify_words(key: str, **values: object) -> str:
    return _SPOTIFY_WORDS[_spotify_language()][key].format(**values)


def _music_page(ok: bool, message: str) -> str:
    """The page that stays in the browser after connecting."""
    color = "#1db954" if ok else "#e5534b"
    language = _spotify_language()
    return (
        f"<!doctype html><html lang='{language}'><head><meta charset='utf-8'><title>{escape(_spotify_words('title'))}</title>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'></head>"
        "<body style='margin:0;min-height:100vh;display:grid;place-items:center;background:#121418;"
        "color:#e8e8ea;font:16px system-ui,sans-serif'><main style='max-width:420px;padding:24px;text-align:center'>"
        f"<div style='width:14px;height:14px;border-radius:50%;background:{color};margin:0 auto 16px'></div>"
        f"<p>{escape(message)}</p></main></body></html>"
    )


# ---------------------------------------------------------------------------
# The PC's context
# ---------------------------------------------------------------------------
@app.post("/api/context")
async def set_context(request: ContextRequest) -> dict[str, Any]:
    """The shell says what the user is doing; the clients know it only if it changes."""
    if PC.update(request.idle, request.locked, request.app):
        activity = PC.activity
        logger.info(
            "Activity: %s%s%s",
            activity.kind,
            f" ({activity.label})" if activity.label else "",
            " in full screen" if activity.fullscreen else "",
        )
        await hub.broadcast(PC.as_dict())
    return {"ok": True, "activity": PC.activity.as_dict()}


@app.get("/api/context")
async def get_context() -> dict[str, Any]:
    return PC.as_dict()


@app.post("/api/vocal")
async def api_vocal(request: VocalRequest) -> dict[str, Any]:
    """A vocal in the voice in use, returned only to whoever asks for it.

    ``ok: false`` when it's better to keep quiet (muted, thinking or speaking)
    or when the voice isn't working: a missed vocal isn't an error.
    """
    if request.event not in VOCAL_EVENTS:
        raise HTTPException(status_code=400, detail=f"Versetto sconosciuto: {request.event!r}")
    try:
        payload = await companion().vocal(request.event)
    except Exception as exc:
        logger.debug("Vocal %s not synthesized: %s", request.event, exc)
        return {"ok": False, "reason": describe_error(exc)}
    if payload is None:
        return {"ok": False, "reason": "busy"}
    return {"ok": True, "speech": payload}


@app.post("/api/cancel")
async def api_cancel() -> dict[str, Any]:
    companion().cancel()
    await hub.broadcast({"type": "cancel"})
    return {"ok": True}


@app.post("/api/reset")
async def api_reset() -> dict[str, Any]:
    await companion().reset()
    await hub.broadcast({"type": "reset"})
    return {"ok": True}


def _without_audio(payload: dict[str, Any]) -> dict[str, Any]:
    """A copy of the payload without the base64 blob: readable REST answers."""
    return {k: v for k, v in payload.items() if k != "audio"}


def _animations_info() -> list[dict[str, str]]:
    """The .vrma clips of the animations folder, with the URL to load them from."""
    directory: Path = SETTINGS.animations_dir
    files = sorted(p.name for p in directory.glob("*.vrma")) if directory.is_dir() else []
    return [{"name": name, "url": f"/animations/{name}"} for name in files]


@app.get("/api/animations")
async def animations() -> dict[str, Any]:
    return {"directory": str(SETTINGS.animations_dir), "animations": _animations_info()}


def _avatar_info() -> dict[str, Any]:
    """Looks for a .vrm model in the avatars folder."""
    directory: Path = SETTINGS.avatar_dir
    files = sorted(p.name for p in directory.glob("*.vrm")) if directory.is_dir() else []
    default = "avatar.vrm" if "avatar.vrm" in files else (files[0] if files else None)
    return {
        "directory": str(directory),
        "files": files,
        "default": f"/models/{default}" if default else None,
    }


# ---------------------------------------------------------------------------
# The phone (backend/phone.py)
# ---------------------------------------------------------------------------
def _trust_tailscale(info: phone.Tailscale) -> None:
    """The PC's name on Tailscale becomes an accepted Host and origin.

    It doesn't open anything by itself: whoever comes from there goes through
    ``tailscale serve``, so it isn't "from the PC" and must have the token
    anyway. A .ts.net name never resolves to 127.0.0.1, so it's no use to DNS
    rebinding.
    """
    global POLICY
    if not info.hostname or info.hostname in POLICY.extra_hosts:
        return
    POLICY = dataclasses.replace(
        POLICY,
        extra_hosts=POLICY.extra_hosts | {info.hostname},
        extra_origins=POLICY.extra_origins | {f"https://{info.hostname}"},
    )
    logger.info("Tailscale: accepting %s (the phone still needs the token)", info.hostname)


async def _detect_tailscale(first_delay: float = 5.0, max_delay: float = 120.0) -> None:
    """Retries until Tailscale gives the PC a name.

    When the PC turns on Tsukumo often starts before Tailscale is connected:
    with a single attempt the .ts.net name stayed unknown and the phone was
    refused ("host not allowed") until a restart.
    """
    delay = first_delay
    while True:
        try:
            info = await phone.tailscale_status(SETTINGS.port)
        except Exception as exc:  # a hiccup here must not stop the attempts nor the shutdown
            logger.warning("Tailscale: state unreadable (%s), retrying", exc)
            info = phone.Tailscale(installed=True)
        if info.hostname:
            _trust_tailscale(info)
            return
        if not info.installed:
            return
        await asyncio.sleep(delay)
        delay = min(delay * 2, max_delay)


@app.get("/api/phone", response_class=HTMLResponse, include_in_schema=False)
async def phone_page() -> HTMLResponse:
    """From the PC only: Tailscale's state and the QR code with the link for the phone."""
    info = await phone.tailscale_status(SETTINGS.port)
    _trust_tailscale(info)
    return HTMLResponse(phone.render_page(info, POLICY.token))


@app.post("/api/phone/serve", include_in_schema=False, response_model=None)
async def phone_serve() -> HTMLResponse | RedirectResponse:
    """From the PC only: the "Turn on" button of the page above."""
    ok, problem = await phone.start_serve(SETTINGS.port)
    if ok:
        return RedirectResponse("/api/phone", status_code=303)
    info = await phone.tailscale_status(SETTINGS.port)
    return HTMLResponse(phone.render_page(info, POLICY.token, problem))


@app.post("/api/phone/session")
async def phone_session(request: Request) -> JSONResponse:
    """The phone trades the link's token for a cookie, which goes along with the WebSocket.

    Arrived here, the middleware has already checked the token and the origin.
    """
    response = JSONResponse({"ok": True})
    if request.scope.get("tsukumo.remote"):
        https = request.headers.get("origin", "").startswith("https://") or request.headers.get("x-forwarded-proto") == "https"
        response.set_cookie(
            TOKEN_NAME,
            POLICY.token,
            max_age=180 * 24 * 3600,
            path="/",
            secure=https,
            httponly=True,
            samesite="strict",
        )
    return response


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    # The phone's page: no audio, and what it writes isn't read aloud.
    text_only = websocket.query_params.get("mode") == "text"
    await websocket.accept()
    await hub.add(websocket, text_only=text_only)
    logger.info("Client connected (%d in all)", hub.count)

    try:
        instance = companion()
        await websocket.send_json(
            {
                "type": "hello",
                "version": __version__,
                "config": {**SETTINGS.public_dict(), **instance.current_settings()},
                "blendshapes": VISEME_BLENDSHAPES,
                "voices": instance.voice_list or [],
                "engines": monitor.status,
                "avatar": _avatar_info(),
                "context": PC.as_dict(),
                "reminders": [item.as_dict() for item in REMINDERS.all()],
                "memory": MEMORY.as_dict(),
                "animations": _animations_info(),
                "usage": USAGE.latest,
                "agents": hub.agents.public(),
                # The suspended phone missed the replies: it gets them back from here.
                "transcript": hub.transcript.recent(),
            }
        )

        remote = bool(websocket.scope.get("tsukumo.remote"))
        while True:
            message = await websocket.receive_json()
            if not isinstance(message, dict):
                continue
            kind = str(message.get("type", "")).lower()
            # The engine may have been changed from the panel in the meantime.
            instance = companion()

            if kind == "ping":
                await websocket.send_json({"type": "pong"})
            elif kind == "chat":
                # A separate task: the loop stays free to receive "cancel".
                files = [str(item) for item in (message.get("files") or []) if isinstance(item, str)]
                if remote:
                    # From outside only the uploaded files (POST /api/attachments), never a path on the PC.
                    files = [item for item in files if within(Path(item), [SETTINGS.state_dir / "uploads"])]
                _spawn(
                    instance.chat(
                        message.get("text", ""),
                        hub.broadcast,
                        files=files,
                        screen=bool(message.get("screen")),
                        silent=text_only,
                    )
                )
            elif kind == "capabilities":
                # The character's window in Electron can take screenshots.
                if message.get("screen") and not remote:
                    SCREEN_CLIENTS.add(websocket)
            elif kind == "say":
                _spawn(instance.say(message.get("text", ""), hub.broadcast, message.get("voice")))
            elif kind == "voice":
                # Audio from the microphone: 16-bit PCM at 16 kHz in base64. We
                # transcribe it and, unless asked otherwise, treat it exactly as if it had
                # been written in the chat.
                _spawn(_handle_voice(instance, message))
            elif kind == "settings":
                # Voice, language and mute chosen in the panel: we send them back to
                # everyone, so every window stays aligned. The voice is checked in a
                # thread: it may need the list from the service.
                current = await asyncio.to_thread(
                    instance.update_settings,
                    message.get("voice"),
                    message.get("replyLanguage"),
                    message.get("muted"),
                )
                await hub.broadcast({"type": "settings", **current})
                monitor.poke()
            elif kind == "cancel":
                instance.cancel()
                await hub.broadcast({"type": "cancel"})
            elif kind == "reset":
                await instance.reset()
                await hub.broadcast({"type": "reset"})
            else:
                await websocket.send_json(
                    {"type": "error", "message": f"Unknown message type: {kind!r}"}
                )

    except WebSocketDisconnect:
        pass
    except Exception as exc:  # pragma: no cover - transport errors
        logger.warning("WebSocket closed with an error: %s", describe_error(exc))
    finally:
        SCREEN_CLIENTS.discard(websocket)
        await hub.remove(websocket)
        logger.info("Client disconnected (%d left)", hub.count)


async def _handle_voice(instance: Companion, message: dict[str, Any]) -> None:
    """Transcribes the received audio and, if there's text, starts the turn.

    The transcription is always sent back to every client before speaking: so
    you see right away what the companion understood, even when it understood
    wrongly, instead of having to guess from the reply.
    """
    raw = message.get("audio") or ""
    try:
        pcm16 = base64.b64decode(raw, validate=True)
    except (ValueError, binascii.Error):
        await hub.broadcast({"type": "error", "source": "stt", "message": "Invalid audio"})
        return

    started = time.perf_counter()
    transcript = await instance.transcribe(pcm16)
    if transcript is None:
        await hub.broadcast(
            {
                "type": "error",
                "source": "stt",
                "message": "Speech recognition isn't active",
                "hint": "Choose it in the Engines tab, Listening section.",
                "action": "engines",
            }
        )
        return

    # Microphone open while she speaks: what it hears may be her.
    echo = not transcript.is_empty and instance.is_echo(transcript.text)
    await hub.broadcast(
        {
            "type": "transcript",
            "text": transcript.text,
            "language": transcript.language,
            "confidence": transcript.confidence,
            "duration": transcript.duration,
            "ms": int((time.perf_counter() - started) * 1000),
            "echo": echo,
        }
    )

    if transcript.is_empty:
        return
    if echo:
        logger.info("Transcription ignored, it's her own voice: %r", transcript.text[:80])
        return
    if message.get("autoSend", True):
        await instance.chat(transcript.text, hub.broadcast)


def _spawn(coro, report: bool = True) -> None:
    """Starts a background job keeping a strong reference to it."""
    task = asyncio.create_task(_run_turn(coro, report))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


async def _run_turn(coro, report: bool = True) -> None:
    """Runs a job reporting any errors to every client."""
    try:
        await coro
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.exception("Background job failed")
        if report:
            await hub.broadcast({"type": "error", "message": describe_error(exc)})


# ---------------------------------------------------------------------------
# Static frontend
# ---------------------------------------------------------------------------
_PLACEHOLDER = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Tsukumo</title>
<style>body{font-family:system-ui,sans-serif;background:#111114;color:#ececf1;
display:grid;place-items:center;height:100vh;margin:0}
main{max-width:34rem;line-height:1.6}code{background:#23232a;padding:.15rem .4rem;
border-radius:.3rem}</style></head>
<body><main>
<h1>Tsukumo</h1>
<p>The backend is running, but the frontend hasn't been built yet.</p>
<p>Run:</p>
<pre><code>cd frontend
npm install
npm run build</code></pre>
<p>Or start the dev server with <code>npm run dev</code> and open
<a style="color:#9db4ff" href="http://localhost:5173">http://localhost:5173</a>.</p>
<p>API running: <code>GET /api/health</code></p>
</main></body></html>"""


class BuildAwareStatics(StaticFiles):
    """Static files with the right cache headers.

    Vite generates the bundles with the content hash in the name
    (``index-a1b2c3.js``): those can be cached forever. ``index.html`` instead
    *references* them, so if the browser keeps it in cache it keeps loading the
    old bundle after every ``npm run build`` - and it's exactly the kind of bug
    that drives you mad ("I rebuilt it but nothing changes").
    """

    def file_response(self, full_path, stat_result, scope, status_code: int = 200):
        response = super().file_response(full_path, stat_result, scope, status_code)
        path = str(full_path).replace("\\", "/")
        if "/assets/" in path:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
        return response


def mount_frontend() -> None:
    """Mounts the static files. The order matters: /models before the catch-all /."""
    if SETTINGS.avatar_dir.is_dir():
        # The avatar can be replaced on the fly: no aggressive caching.
        app.mount("/models", BuildAwareStatics(directory=SETTINGS.avatar_dir), name="models")
    SETTINGS.animations_dir.mkdir(parents=True, exist_ok=True)
    app.mount("/animations", BuildAwareStatics(directory=SETTINGS.animations_dir), name="animations")

    if SETTINGS.frontend_dist.is_dir() and (SETTINGS.frontend_dist / "index.html").is_file():
        app.mount("/", BuildAwareStatics(directory=SETTINGS.frontend_dist, html=True), name="frontend")
        logger.info("Frontend served from %s", SETTINGS.frontend_dist)
    else:

        @app.get("/", response_class=HTMLResponse, include_in_schema=False)
        async def placeholder() -> HTMLResponse:
            return HTMLResponse(_PLACEHOLDER)


mount_frontend()


@app.exception_handler(HTTPException)
async def http_exception_handler(request, exc: HTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(description="Tsukumo - backend")
    parser.add_argument("--host", default=SETTINGS.host)
    parser.add_argument("--port", type=int, default=SETTINGS.port)
    parser.add_argument("--log-level", default=SETTINGS.log_level)
    parser.add_argument("--reload", action="store_true", help="Auto-reload for development")
    args = parser.parse_args()
    global POLICY
    POLICY = dataclasses.replace(POLICY, bind_host=args.host)

    import uvicorn

    with contextlib.suppress(KeyboardInterrupt):
        uvicorn.run(
            "backend.server:app" if args.reload else app,
            host=args.host,
            port=args.port,
            log_level=args.log_level,
            reload=args.reload,
            server_header=False,
        )


if __name__ == "__main__":
    main()
