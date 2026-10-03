"""Server FastAPI: WebSocket per il companion + API REST + hosting del frontend.

Protocollo WebSocket (``/ws``)
------------------------------
Client -> server::

    {"type": "chat",   "text": "ciao!"}      # cervello + voce
    {"type": "say",    "text": "ciao!", "voice": "..."}   # solo voce
    {"type": "settings", "voice": "af_heart", "replyLanguage": "auto", "muted": false}
    {"type": "voice",  "audio": "<pcm16 base64>"}          # dal microfono
    {"type": "cancel"}                       # interrompe il turno corrente
    {"type": "reset"}                        # svuota la memoria conversazione
    {"type": "ping"}

Server -> client::

    {"type": "hello",  "config": {...}, "voices": [...], "engines": {...}}
    {"type": "engines", "llm": {...}, "tts": {...}, "stt": {...}}   # stato dei motori
    {"type": "voices", "voices": [...], "voice": "..."}  # elenco voci (cambia col motore)
    {"type": "providers", "kind": "llm", "selected": {...}, "settings": {...}}  # motori cambiati
    {"type": "context", "activity": {...}, "present": true, ...}  # cosa fa l'utente al PC
    {"type": "reminders", "reminders": [...]}  # timer e promemoria in attesa
    {"type": "memory", "persona": {...}, "facts": [...]}  # personalita' e ricordi
    {"type": "working", "kind": "read", "label": "legge main.js"}  # un agente usa un tool
    {"type": "reminder", "event": "fired", "reminder": {...}}  # uno e' appena scattato
    {"type": "gesture", "name": "yawn"}      # un gesto che accompagna un commento spontaneo
    {"type": "preferences", ...}             # quanto chiacchiera e di cosa
    {"type": "notify", "source": "claude", "title": "Claude Code", ...}  # un agente esterno ha finito
    {"type": "usage", "agents": [...]}      # consumi e limiti di Claude Code, Codex, Antigravity
    {"type": "capture", "text": "..."}       # "guarda lo schermo": fai uno screenshot
    {"type": "state",  "value": "thinking" | "speaking" | "idle"}
    {"type": "user",   "text": "..."}
    {"type": "token",  "text": "..."}        # streaming del cervello
    {"type": "speech", "audio": "<wav base64>", "visemes": [...], ...}
    {"type": "caption", "text": "..."}       # frase senza audio (muto o voce guasta)
    {"type": "reply",  "text": "..."}        # risposta completa
    {"type": "notice" | "error", "message": "...", "source": "llm", "hint": "..."}
    {"type": "pong"}

I versetti ("Hii!" quando saluta) non passano dal WebSocket: il personaggio li
chiede con ``POST /api/vocal`` e li suona solo lui, senza broadcast.

Il messaggio ``speech`` e' quello che guida il lip-sync: contiene il WAV in
base64 e la timeline ``[{t, d, v, w}, ...]`` (tempo, durata, viseme, peso).
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
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__
from .attachments import MAX_UPLOAD_BYTES, store_upload
from .config import Settings, save_dotenv
from .context import PCContext
from .news import NewsService
from . import notify as agent_notify
from .preferences import Preferences
from .proactive import Proactive
from .reminders import (
    MAX_LATE,
    ReminderStore,
    announcement,
    describe,
    parse_request,
    task_prompt,
)
from .reminders import Reminder as ReminderItem
from .memory import MemoryStore
from .security import AccessPolicy, SecurityMiddleware, clean_env_value, is_loopback, within
from .music import MusicService, SpotifyError
from .llm import create_llm_client, describe_error
from .llm.detect import candidates, detect_all
from .phonemes import VISEME_BLENDSHAPES
from .pipeline import Companion
from .providers import REGISTRIES, ProviderSpec, describe_all
from .status import EngineMonitor, llm_entry
from .tts import build_tts_engine
from .usage import UsageService
from .usage import describe as describe_usage
from .usage import wants_usage
from .vocals import EVENTS as VOCAL_EVENTS
from .weather import WeatherService

logger = logging.getLogger("tsukumo")

SETTINGS = Settings.from_env()
#: Chi puo' parlare col backend (Host, Origin, token per chi non e' sul PC).
POLICY = AccessPolicy.from_settings(SETTINGS)

#: Variabile d'ambiente che dice quale motore e' attivo, per tipo.
SELECT_KEYS = {"llm": "DC_LLM_BACKEND", "tts": "DC_TTS_ENGINE", "stt": "DC_STT_ENGINE"}

#: Cosa sta facendo l'utente al PC, aggiornato dalla shell Electron (vedi context.py).
PC = PCContext()

#: Quanto chiacchiera e di cosa, e la citta' del meteo (state/preferences.json).
PREFERENCES = Preferences(SETTINGS.state_dir / "preferences.json")
WEATHER = WeatherService()
NEWS = NewsService()

#: Timer e promemoria, salvati in state/reminders.json (vedi reminders.py).
REMINDERS = ReminderStore(SETTINGS.state_dir / "reminders.json")
MEMORY = MemoryStore(SETTINGS.state_dir / "memory.json")

#: Consumi e limiti degli agenti usati per conto tuo (usage.py): solo file locali.
USAGE = UsageService(SETTINGS.state_dir, linked=agent_notify.statusline_installed)
#: Ogni quanto rileggere i consumi (s): i limiti si muovono a ogni risposta dell'agente.
USAGE_INTERVAL = 60.0


async def _music_changed(status: dict[str, Any]) -> None:
    await _broadcast({"type": "music", **status})


#: Spotify e i gusti musicali (state/spotify.json, state/music_taste.json).
#: Spotify accetta solo 127.0.0.1 come indirizzo di ritorno locale, non "localhost".
MUSIC = MusicService(
    SETTINGS.state_dir,
    redirect_uri=f"http://127.0.0.1:{SETTINGS.port}/api/music/spotify/callback",
    on_change=_music_changed,
)
#: Sveglia il pianificatore quando cambia qualcosa (creato nel loop giusto, all'avvio).
_reminders_wake: asyncio.Event | None = None

#: Client che sanno fare uno screenshot (la finestra del personaggio in Electron).
SCREEN_CLIENTS: set[WebSocket] = set()

#: Cervelli trovati sul PC (vedi ``llm/detect.py``): ``{id: {"found", "detail"}}``.
#: Si riempie in background poco dopo l'avvio; prima e' vuoto.
DETECTED: dict[str, dict[str, Any]] = {}
#: Il riconoscimento e' finito: la presentazione lo aspetta prima di dire "non ho trovato niente".
DETECTION_DONE = asyncio.Event()
#: L'ascolto acceso dalla presentazione (installa, sceglie, prepara il modello): stato per il pannello.
LISTENING_JOB: dict[str, Any] = {"state": "idle", "detail": ""}


# ---------------------------------------------------------------------------
# Gestione delle connessioni WebSocket
# ---------------------------------------------------------------------------
class ConnectionHub:
    """Tiene traccia dei client collegati e fa da broadcaster.

    Il broadcast serve perche' ci sono piu' finestre aperte (il personaggio,
    il pannello, magari una scheda del browser): tutte devono vedere lo stesso
    stato e lo stesso avatar parlare.
    """

    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def add(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._clients.add(websocket)

    async def remove(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._clients.discard(websocket)

    @property
    def count(self) -> int:
        return len(self._clients)

    async def broadcast(self, message: dict[str, Any]) -> None:
        async with self._lock:
            targets = list(self._clients)
        dead: list[WebSocket] = []
        for client in targets:
            try:
                await client.send_json(message)
            except Exception:
                dead.append(client)
        if dead:
            async with self._lock:
                for client in dead:
                    self._clients.discard(client)


hub = ConnectionHub()

#: I task in background vanno referenziati, altrimenti il garbage collector
#: puo' raccoglierli a meta' esecuzione (vedi asyncio.create_task nei docs).
_background_tasks: set[asyncio.Task] = set()


def _current() -> Companion | None:
    return getattr(app.state, "companion", None)


monitor = EngineMonitor(_current, interval=SETTINGS.status_interval, on_change=hub.broadcast)


async def _broadcast(message: dict[str, Any]) -> None:
    # Indiretto apposta: cosi' chi sostituisce hub.broadcast (i test) vale anche qui.
    await hub.broadcast(message)


#: Commenti spontanei (vedi proactive.py).
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
# Ciclo di vita dell'applicazione
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    logging.basicConfig(
        level=getattr(logging, SETTINGS.log_level.upper(), logging.INFO),
        format="%(asctime)s  %(levelname)-7s %(name)s  %(message)s",
        datefmt="%H:%M:%S",
    )
    # I controlli di stato fanno una richiesta HTTP ogni pochi secondi: senza
    # questo sarebbero due righe di httpx ogni volta, a riempire il log.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logger.info("Tsukumo %s in avvio...", __version__)
    # Il caricamento dei modelli (Kokoro, Whisper) e' bloccante: in un thread.
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

    if not is_loopback(POLICY.bind_host):
        logger.warning(
            "In ascolto su %s: dagli altri dispositivi serve il token di accesso (%s)",
            POLICY.bind_host,
            POLICY.token_path,
        )
        POLICY.token  # creato adesso, cosi' il file c'e' gia'
    companion = app.state.companion
    logger.info(
        "Pronto: cervello=%s  voce=%s  ascolto=%s  -> http://%s:%s",
        SETTINGS.selected("llm"),
        companion.tts.name,
        SETTINGS.selected("stt") or "none",
        SETTINGS.host,
        SETTINGS.port,
    )
    try:
        yield
    finally:
        for task in (reminder_task, usage_task):
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        await PROACTIVE.stop()
        await MUSIC.stop()
        _running_marker().unlink(missing_ok=True)
        await monitor.stop()
        await app.state.companion.close()
        logger.info("Tsukumo arrestato")


app = FastAPI(title="Tsukumo", version=__version__, lifespan=lifespan)
# Il CORS serve solo per le origini aggiunte a mano (DC_CORS_ORIGINS): le
# pagine di Tsukumo stanno sulla stessa origine del backend.
app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(POLICY.extra_origins),
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Content-Type", "Authorization"],
)
# Aggiunto per ultimo = il piu' esterno: decide prima di tutto il resto.
app.add_middleware(SecurityMiddleware, policy=lambda: POLICY)


def companion() -> Companion:
    instance = _current()
    if instance is None:  # pragma: no cover - solo se si chiama troppo presto
        raise HTTPException(status_code=503, detail="Companion non ancora pronto")
    return instance


async def _load_voices(instance: Companion) -> None:
    """Carica le voci del motore attivo e le manda a tutti."""
    voices = await instance.load_voices()
    if instance is _current():
        await hub.broadcast({"type": "voices", "voices": voices, **instance.current_settings()})


# ---------------------------------------------------------------------------
# Modelli delle richieste REST
# ---------------------------------------------------------------------------
class ChatRequest(BaseModel):
    text: str = Field(..., min_length=1, description="Messaggio dell'utente")


class SayRequest(BaseModel):
    text: str = Field(..., min_length=1, description="Testo da pronunciare")
    voice: str | None = Field(None, description="Voce del motore attivo")
    speed: float | None = Field(None, gt=0.25, le=3.0, description="Velocita' di lettura")


class NotifyRequest(BaseModel):
    message: str = Field("", description="L'ultimo messaggio dell'agente")
    source: str = Field("", description="claude, codex, o un nome qualsiasi")
    kind: str = Field("done", description="done (ha finito) oppure waiting (ti aspetta)")


class IntegrationRequest(BaseModel):
    tool: str = Field(..., description="claude, codex oppure claude_usage (la barra di stato)")
    action: str = Field(..., description="install oppure uninstall")


class ReminderRequest(BaseModel):
    phrase: str | None = Field(None, description="Richiesta a parole: 'tra 20 minuti ricordami di bere'")
    kind: str = Field("reminder", description="timer, reminder, alarm, task")
    text: str = Field("", description="Cosa ricordare o fare")
    at: str | None = Field(None, description="Quando, in ISO locale: 2026-12-29T12:00")
    seconds: float | None = Field(None, gt=0, description="Oppure tra quanti secondi")
    repeat: str = Field("", description="'' oppure 'daily'")


class PersonaRequest(BaseModel):
    name: str | None = Field(None, max_length=40, description="Come si chiama")
    traits: str | None = Field(None, max_length=400, description="Il carattere, in poche parole")


class FactRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=200, description="Un ricordo: 'ha un gatto che si chiama Miso'")


class ContextRequest(BaseModel):
    idle: float = Field(0, ge=0, description="Secondi senza mouse ne' tastiera")
    locked: bool = Field(False, description="Schermo bloccato")
    app: dict[str, Any] | None = Field(None, description="Finestra in primo piano: title, exe, fullscreen, own")


class VocalRequest(BaseModel):
    event: str = Field(..., description="greet, morning, evening, night, welcome, pat, poke, lift, fall, pout, dizzy")


class ProviderRequest(BaseModel):
    kind: str = Field(..., description="Tipo di motore: llm, tts oppure stt")
    provider: str = Field(..., min_length=1, description="Id del motore, es. 'ollama'")
    options: dict[str, str | None] = Field(
        default_factory=dict,
        description="Campi dichiarati dal motore; null o vuoto torna al default",
    )


# ---------------------------------------------------------------------------
# API REST
# ---------------------------------------------------------------------------
@app.get("/api/health")
async def health() -> dict[str, Any]:
    """Il backend e' vivo? Risponde sempre subito: non fa mai rete.

    La shell Electron lo interroga all'avvio con un timeout di pochi secondi:
    se qui dentro si aspettasse un servizio esterno (come succedeva col
    Gateway OpenClaw spento) il companion non partirebbe proprio.
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
    """Stato dei motori, forzando un controllo immediato."""
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
    """Schemi di tutti i motori disponibili, piu' quello attivo per ogni tipo.

    Il pannello disegna le impostazioni leggendo questa risposta, quindi un
    motore nuovo compare da solo senza modifiche al frontend. I campi segreti
    arrivano come booleano ("impostato" / "non impostato"), mai in chiaro.
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
    """I valori salvati di *ogni* motore (non solo di quello attivo), segreti mascherati.

    Serve al pannello per mostrare la configurazione di un motore prima di
    attivarlo: "la chiave di ElevenLabs c'e' gia'", senza doverla riscrivere.
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
        raise HTTPException(status_code=400, detail=f"Motore sconosciuto: {provider!r}")
    return spec


def _request_options(spec: ProviderSpec, options: dict[str, str | None]) -> dict[str, str]:
    """Solo i campi che il motore dichiara: il pannello non puo' scrivere variabili arbitrarie.

    Un segreto lasciato vuoto significa "non l'ho toccato", non "cancellalo".
    """
    allowed = {f.env: f for f in spec.fields}
    unknown = set(options) - set(allowed)
    if unknown:
        raise HTTPException(status_code=400, detail=f"Campi non previsti da {spec.id!r}: {sorted(unknown)}")
    cleaned: dict[str, str] = {}
    for env_name, value in options.items():
        text = "" if value is None else str(value)
        if allowed[env_name].secret and not text.strip():
            continue
        if len(text) > 4096:
            raise HTTPException(status_code=400, detail=f"Valore troppo lungo per {env_name}")
        spec_field = allowed[env_name]
        if spec_field.type == "select" and env_name.endswith(("_PERMISSION", "_SANDBOX")) and text:
            # I permessi di un agente solo fra quelli del menu: niente "bypassPermissions" di straforo.
            if text not in {option["value"] for option in spec_field.options}:
                raise HTTPException(status_code=400, detail=f"{env_name}: valore non previsto {text!r}")
        try:
            cleaned[env_name] = clean_env_value(text)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"{env_name}: {exc}") from exc
    return cleaned


def _draft_settings(kind: str, spec: ProviderSpec, options: dict[str, str]) -> Settings:
    """Le impostazioni che si avrebbero applicando ``options``, senza salvarle."""
    base = Settings.from_env()
    merged = {**base.provider_options, **options}
    attr = Settings._SELECTED_ATTR[kind]
    return dataclasses.replace(base, provider_options=merged, **{attr: spec.id})


@app.post("/api/providers/check")
async def check_provider(request: ProviderRequest) -> dict[str, Any]:
    """Prova un motore con i valori del pannello *senza* attivarlo.

    E' il tasto "Verifica": dice se la chiave e' valida, quante voci ci sono,
    quanto resta del piano, se l'agente e' installato — prima di scoprirlo alla
    prima frase.
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
        return {"ok": True, "detail": f"Pronto (modello {options.get('WHISPER_MODEL') or 'base'})"}
    if spec.id == "whisper_cpp":
        url = str(options.get("WHISPER_CPP_URL") or "")
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                await client.get(url)
        except httpx.HTTPError as exc:
            return {"ok": False, "detail": f"Server non raggiungibile: {describe_error(exc)}"}
        return {"ok": True, "detail": "Server raggiungibile"}
    if spec.id == "openai_whisper_api" and not options.get("STT_API_KEY"):
        return {"ok": False, "detail": "Manca la chiave API"}
    return {"ok": True, "detail": "Nessuna verifica necessaria"}


@app.post("/api/providers")
async def set_provider(request: ProviderRequest) -> dict[str, Any]:
    """Cambia il motore attivo per un tipo, salvando la scelta in ``.env``.

    Solo quel motore viene ricostruito: la conversazione e gli altri motori
    restano come sono. Prima scriviamo, poi ricostruiamo: se la ricostruzione
    fallisce (chiave sbagliata, pacchetto mancante, programma non installato)
    ripristiniamo i valori precedenti e rispondiamo con il motivo, invece di
    lasciare il companion in uno stato a meta'.
    """
    kind = request.kind
    spec = _spec_or_400(kind, request.provider)
    options = _request_options(spec, request.options)

    updates = {SELECT_KEYS[kind]: spec.id}
    updates.update({f"DC_{name}": value for name, value in options.items()})
    previous = {key: os.environ.get(key, "") for key in updates}
    save_dotenv(updates)

    instance = companion()
    if kind != "stt":  # l'ascolto non c'entra coi turni: la risposta in corso resta
        instance.cancel()  # un turno a meta' userebbe il motore che stiamo per chiudere
    try:
        new_settings = Settings.from_env()
        async with instance._turn_lock:
            old = await asyncio.to_thread(instance.replace_engine, kind, new_settings)
    except Exception as exc:
        save_dotenv(previous)  # rimettiamo tutto com'era
        logger.warning("Cambio di %s a %r fallito: %s", kind, spec.id, exc)
        return {"ok": False, "error": describe_error(exc), "kind": kind, "provider": spec.id}

    await _engine_changed(kind, instance, new_settings, old)
    logger.info("Motore %s cambiato in %r", kind, spec.id)
    return {
        "ok": True,
        "kind": kind,
        "provider": spec.id,
        "options": SETTINGS.provider_public(kind),
    }


@app.post("/api/providers/options")
async def save_provider_options(request: ProviderRequest) -> dict[str, Any]:
    """Salva i campi di un motore (una chiave, un modello) *senza* attivarlo.

    Serve a chi usa un motore di passaggio, come il cervello delle chiacchiere:
    la chiave di OpenRouter si salva senza che OpenRouter diventi il cervello
    principale. Il motore attivo non si tocca: per quello c'e' ``/api/providers``.
    """
    global SETTINGS

    spec = _spec_or_400(request.kind, request.provider)
    options = _request_options(spec, request.options)
    if spec.id == SETTINGS.selected(request.kind):
        raise HTTPException(status_code=400, detail=f"{spec.label} e' il motore attivo: si cambia da Motori.")
    if options:
        save_dotenv({f"DC_{name}": value for name, value in options.items()})
        SETTINGS = dataclasses.replace(SETTINGS, provider_options=Settings.from_env().provider_options)
        instance = companion()
        instance.settings = dataclasses.replace(instance.settings, provider_options=SETTINGS.provider_options)
        await _announce_providers(request.kind, instance)
    return {"ok": True, "kind": request.kind, "provider": spec.id, "saved": _saved_options(request.kind)[spec.id]}


async def _engine_changed(kind: str, instance: Companion, new_settings: Settings, old: object | None) -> None:
    """Dopo un cambio di motore riuscito: nuove impostazioni, vecchio chiuso, client avvisati."""
    global SETTINGS

    SETTINGS = new_settings
    await _close_engine(old)
    monitor.poke()
    if kind == "tts":
        _spawn(_load_voices(instance), report=False)
    await _announce_providers(kind, instance)


async def _announce_providers(kind: str, instance: Companion | None) -> None:
    """Il pannello rilegge ``/api/providers`` quando riceve questo messaggio."""
    await hub.broadcast(
        {
            "type": "providers",
            "kind": kind,
            "selected": {k: SETTINGS.selected(k) for k in REGISTRIES},
            "settings": instance.current_settings() if instance is not None else {},
        }
    )


# ---------------------------------------------------------------------------
# Riconoscimento dei cervelli installati
# ---------------------------------------------------------------------------
def _llm_chosen() -> bool:
    """Qualcuno ha scelto il cervello: nel .env, nell'ambiente o dal pannello."""
    return bool(os.environ.get(SELECT_KEYS["llm"], "").strip())


async def _detect_engines() -> None:
    """Cerca i cervelli sul PC; se nessuno ne ha scelto uno, usa il primo trovato.

    Lo stesso per l'ascolto: se Faster-Whisper e' installato e nessuno ha
    scelto, si accende da solo (il modello si carica alla prima frase).
    """
    global DETECTED

    try:
        DETECTED = await detect_all(lambda provider: SETTINGS.provider_config("llm", provider))
        found = candidates(DETECTED)
        logger.info("Cervelli trovati sul PC: %s", ", ".join(found) or "nessuno")
        if await _auto_select_llm(found) is None:
            # Nessun cambio: il pannello deve comunque vedere i badge.
            await _announce_providers("llm", _current())
        await _auto_select_stt()
    finally:
        DETECTION_DONE.set()


def _stt_chosen() -> bool:
    return bool(os.environ.get(SELECT_KEYS["stt"], "").strip())


def _whisper_installed() -> bool:
    return importlib.util.find_spec("faster_whisper") is not None


async def _auto_select_stt() -> str | None:
    """Accende Faster-Whisper se c'e' e nessuno ha scelto l'ascolto (nemmeno "spento")."""
    instance = _current()
    if instance is None or _stt_chosen() or SETTINGS.selected("stt") != "none":
        return None
    if not await asyncio.to_thread(_whisper_installed):
        return None
    result = await set_provider(ProviderRequest(kind="stt", provider="faster_whisper", options={}))
    if result.get("ok"):
        logger.info("Ascolto acceso in automatico: faster_whisper (salvato nel .env)")
        return "faster_whisper"
    return None


async def _auto_select_llm(found: list[str]) -> str | None:
    """Mette in uso il primo cervello trovato e lo salva nel .env.

    Non tocca mai una scelta esplicita. Se un motore trovato non parte (per
    esempio OpenClaw acceso ma senza token) prova il successivo. Il turno in
    corso non viene interrotto: si aspetta che finisca.
    """
    instance = _current()
    if instance is None:
        return None
    for provider in found:
        if _llm_chosen():
            return None
        new_settings = dataclasses.replace(SETTINGS, llm_backend=provider)
        async with instance._turn_lock:
            if _llm_chosen():  # scelto dal pannello mentre aspettavamo
                return None
            try:
                old = await asyncio.to_thread(instance.replace_engine, "llm", new_settings)
            except Exception as exc:
                logger.info("%s c'e' ma non parte: %s", provider, describe_error(exc))
                continue
            save_dotenv({SELECT_KEYS["llm"]: provider})
        await _engine_changed("llm", instance, new_settings, old)
        logger.info("Cervello scelto in automatico: %s (salvato nel .env)", provider)
        return provider
    return None


async def _close_engine(engine: object | None) -> None:
    """Chiude un motore sostituito, qualunque sia il suo tipo."""
    if engine is None:
        return
    close = getattr(engine, "close", None)
    if close is None:
        return
    try:
        result = close()
        if asyncio.iscoroutine(result):
            await result
    except Exception as exc:  # pragma: no cover - chiusura best effort
        logger.debug("Chiusura del motore precedente: %s", exc)


@app.get("/api/voices")
async def voices() -> dict[str, Any]:
    """Voci del motore TTS attivo: l'elenco cambia con il motore scelto."""
    instance = companion()
    catalog = instance.voice_list if instance.voice_list is not None else await instance.load_voices()
    return {"voices": catalog, "engine": instance.tts.name, **instance.current_settings()}


@app.post("/api/voices/clone")
async def clone_voice(request: Request, name: str = "Voce", language: str = "it") -> dict[str, Any]:
    """Clona una voce da un file audio (il corpo e' il file, come per gli allegati) e la sceglie."""
    instance = companion()
    if not instance.tts.can_clone:
        raise HTTPException(status_code=400, detail=f"{instance.tts.name} non sa clonare le voci: passa a Chatterbox")
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
        raise HTTPException(status_code=400, detail="Il motore attivo non ha voci clonate")
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
    """Trascrive PCM 16 bit 16 kHz mono senza avviare un turno: e' la prova del microfono."""
    if int(request.headers.get("content-length") or 0) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Audio troppo lungo")
    try:
        transcript = await companion().transcribe(await request.body())
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Il riconoscimento vocale non funziona: {describe_error(exc)}") from exc
    if transcript is None:
        raise HTTPException(status_code=400, detail="Il riconoscimento vocale non è attivo: sceglilo in Motori, sezione Ascolto.")
    return {"text": transcript.text, "language": transcript.language}


@app.post("/api/say")
async def api_say(request: SayRequest) -> dict[str, Any]:
    """Sintetizza senza cervello e restituisce audio + visemi (comodo con curl)."""
    payloads = await companion().synthesize_payload(request.text, request.voice, request.speed)
    for payload in payloads:
        await hub.broadcast(payload)
    return {"chunks": [_without_audio(p) for p in payloads], "count": len(payloads)}


@app.post("/api/chat")
async def api_chat(request: ChatRequest) -> dict[str, Any]:
    """Turno completo; l'audio viene inviato ai client WebSocket collegati."""
    reply = await companion().chat(request.text, hub.broadcast)
    return {"reply": reply, "clients": hub.count}


# ---------------------------------------------------------------------------
# Timer e promemoria
# ---------------------------------------------------------------------------
def _attach(instance: Companion) -> None:
    """Collega al companion i promemoria, lo screenshot e gli avvisi."""
    instance.reminders = REMINDERS
    instance.on_reminders_changed = _reminders_changed
    instance.memory = MEMORY
    instance.on_memory_changed = _memory_changed
    instance.screen_capture = _request_screen
    instance.music = MUSIC
    instance.usage_reply = _usage_reply


async def _usage_reply(prompt: str, lang: str) -> str | None:
    """ "Quanto mi resta di Claude?": si risponde dai file, senza cervello."""
    only = wants_usage(prompt)
    if only is None:
        return None
    snapshot = await asyncio.to_thread(USAGE.snapshot, True)
    return describe_usage(snapshot, lang, only)


async def _usage_loop() -> None:
    """Rilegge i consumi degli agenti ogni minuto; se sono cambiati li manda a tutti."""
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
        except Exception:  # pragma: no cover - non deve mai morire
            logger.exception("Consumi degli agenti")
        await asyncio.sleep(USAGE_INTERVAL)


async def _request_screen(text: str) -> bool:
    """Chiede uno screenshot a chi sa farlo; il messaggio tornera' col file allegato."""
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
    """Dorme fino al prossimo promemoria (o a un cambio), poi lo fa scattare."""
    assert _reminders_wake is not None
    while True:
        try:
            await _fire_due_reminders()
        except asyncio.CancelledError:
            raise
        except Exception:  # pragma: no cover - il pianificatore non deve morire
            logger.exception("Pianificatore dei promemoria")
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
            logger.info("Promemoria troppo vecchio, lo salto: %s", describe(reminder))
            continue
        fired.append(reminder)
        logger.info("Scatta: %s", describe(reminder))
        await hub.broadcast({"type": "reminder", "event": "fired", "reminder": reminder.as_dict(), "late": round(late)})
        instance = _current()
        if instance is None:
            continue
        if reminder.kind == "task":
            _spawn(instance.chat(task_prompt(reminder), hub.broadcast, hidden=True))
        else:
            _spawn(instance.announce(announcement(reminder, late), hub.broadcast, event=f"Promemoria scattato: {describe(reminder)}"))
    if fired:
        await hub.broadcast({"type": "reminders", "reminders": [item.as_dict() for item in REMINDERS.all()]})
    return fired


@app.post("/api/attachments")
async def upload_attachment(request: Request, name: str = "file") -> dict[str, Any]:
    """Un file dal browser (che non conosce i percorsi): lo salva e ne restituisce il percorso.

    Il corpo e' il file cosi' com'e' (niente multipart): ``POST /api/attachments?name=foto.png``.
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
# Personalita' e ricordi (backend/memory.py)
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
        raise HTTPException(status_code=400, detail="Ricordo vuoto o già presente")
    await _memory_changed()
    return {"ok": True, "fact": fact.as_dict()}


@app.delete("/api/memory/facts/{fact_id}")
async def delete_fact(fact_id: str) -> dict[str, Any]:
    if MEMORY.remove(fact_id) is None:
        raise HTTPException(status_code=404, detail="Ricordo non trovato")
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
    """Un promemoria dal pannello: a parole (``phrase``) o con i campi."""
    if request.phrase:
        parsed = parse_request(request.phrase)
        if parsed is None:
            raise HTTPException(status_code=400, detail="Non ho capito quando: prova con 'tra 20 minuti' o 'domani alle 9'.")
        reminder = parsed.to_reminder()
    else:
        if request.kind not in ("timer", "reminder", "alarm", "task"):
            raise HTTPException(status_code=400, detail=f"Tipo sconosciuto: {request.kind!r}")
        if request.seconds:
            due = time.time() + request.seconds
        elif request.at:
            try:
                due = datetime.fromisoformat(request.at).timestamp()
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=f"Data non valida: {request.at!r}") from exc
        else:
            raise HTTPException(status_code=400, detail="Serve 'at' o 'seconds'.")
        if due <= time.time():
            raise HTTPException(status_code=400, detail="Quell'ora è già passata.")
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
        raise HTTPException(status_code=404, detail="Promemoria non trovato")
    await _reminders_changed()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Avvisi dagli agenti esterni (Claude Code, Codex)
# ---------------------------------------------------------------------------
def _running_marker() -> Path:
    return SETTINGS.state_dir / "running.json"


def _write_running_marker() -> None:
    """Dice agli hook (scripts/tsukumo_notify.py) che il backend e' acceso e dove."""
    try:
        SETTINGS.state_dir.mkdir(parents=True, exist_ok=True)
        _running_marker().write_text(
            json.dumps({"host": SETTINGS.host, "port": SETTINGS.port, "pid": os.getpid()}), encoding="utf-8"
        )
    except OSError as exc:  # pragma: no cover
        logger.warning("Segnale per gli hook non scritto: %s", exc)


#: Quando ha parlato l'ultima volta di un agente esterno (per non ripetersi).
_last_notice = {"at": 0.0}


@app.post("/api/notify")
async def api_notify(request: NotifyRequest) -> dict[str, Any]:
    """Un agente esterno ha finito (o ti aspetta): lei ti chiama.

    Se stai gia' guardando l'editor o il terminale basta una bolla; se sei
    altrove suona, bussa e lo dice; a schermo intero o in riunione solo la
    notifica di Windows.
    """
    instance = companion()
    source = request.source.strip().lower()
    kind = "waiting" if request.kind == "waiting" else "done"
    name = agent_notify.NAMES.get(source, request.source.strip() or "Agente")
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
    _spawn(instance.announce(text, hub.broadcast, event=f"Avviso da {name}: {summary or kind}"), report=False)
    return {"ok": True, "spoken": True}


@app.get("/api/integrations")
async def get_integrations() -> dict[str, Any]:
    return await asyncio.to_thread(agent_notify.status)


@app.post("/api/integrations")
async def set_integration(request: IntegrationRequest) -> dict[str, Any]:
    """Collega o scollega gli hook di Claude Code / Codex (file fuori dal progetto: solo su richiesta)."""
    try:
        result = await asyncio.to_thread(agent_notify.change, request.tool, request.action)
    except KeyError as exc:
        raise HTTPException(status_code=400, detail=f"Richiesta non valida: {exc}") from exc
    except (OSError, ValueError) as exc:
        return {"ok": False, "error": str(exc), "status": await asyncio.to_thread(agent_notify.status)}
    logger.info("Collegamento %s: %s", request.tool, result)
    if request.tool == "claude_usage":
        # La scheda Lavoro mostra subito "collegata, aspetto la prossima risposta".
        await hub.broadcast({"type": "usage", **await asyncio.to_thread(USAGE.snapshot, True)})
    return {"ok": True, "result": result, "status": await asyncio.to_thread(agent_notify.status)}


# ---------------------------------------------------------------------------
# Consumi degli agenti
# ---------------------------------------------------------------------------
@app.get("/api/usage")
async def get_usage() -> dict[str, Any]:
    """Limiti del piano e token di oggi di Claude Code, Codex e Antigravity (vedi usage.py)."""
    return await asyncio.to_thread(USAGE.snapshot, True)


# ---------------------------------------------------------------------------
# Primo avvio: "ti preparo tutto"
# ---------------------------------------------------------------------------
@app.get("/api/setup")
async def setup_status(wait: float = 0) -> dict[str, Any]:
    """Cosa e' pronto e cosa manca, per la presentazione.

    Con ``wait`` aspetta (al massimo tanti secondi) che finisca il
    riconoscimento dei cervelli: appena installata, la presentazione
    arriva prima che il backend abbia guardato cosa c'e' sul PC.
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
    """Accende l'ascolto sul PC: installa Faster-Whisper se manca, lo sceglie e prepara il modello.

    Scarica qualche centinaio di MB (pacchetto e modello), quindi solo quando
    lo chiedi. Come va si segue da ``GET /api/setup`` (``listening.job``).
    """
    if LISTENING_JOB["state"] not in ("installing", "selecting", "loading"):
        LISTENING_JOB.update(state="selecting", detail="Un attimo…")
        _spawn(_enable_listening(), report=False)
    return {"ok": True, "job": dict(LISTENING_JOB)}


def _pip_install(package: str) -> tuple[int, str]:
    """``pip install`` nell'interprete del backend (il venv, o il Python dell'app installata)."""
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
            LISTENING_JOB.update(state="installing", detail="Installo Faster-Whisper (una volta sola, qualche minuto)…")
            code, output = await asyncio.to_thread(_pip_install, "faster-whisper")
            importlib.invalidate_caches()
            if code != 0 or not _whisper_installed():
                lines = [line for line in output.splitlines() if line.strip()]
                raise RuntimeError(lines[-1] if lines else "pip non è riuscito a installarlo")
        if SETTINGS.selected("stt") != "faster_whisper":
            LISTENING_JOB.update(state="selecting", detail="La accendo…")
            result = await set_provider(ProviderRequest(kind="stt", provider="faster_whisper", options={}))
            if not result.get("ok"):
                raise RuntimeError(result.get("error") or "non parte")
        engine = companion().stt
        if engine is not None:
            LISTENING_JOB.update(state="loading", detail="Preparo il modello (la prima volta lo scarico)…")
            await asyncio.to_thread(engine.prepare)
        LISTENING_JOB.update(state="done", detail="Ti sento: premi Ctrl+Spazio e parlami.")
        logger.info("Ascolto acceso dalla presentazione")
    except Exception as exc:
        LISTENING_JOB.update(state="error", detail=describe_error(exc))
        logger.warning("Ascolto non acceso: %s", LISTENING_JOB["detail"])


# ---------------------------------------------------------------------------
# Preferenze e meteo
# ---------------------------------------------------------------------------
@app.get("/api/preferences")
async def get_preferences() -> dict[str, Any]:
    # brainError: perche' il cervello delle chiacchiere tace (chiave, modelli saturi).
    return {**PREFERENCES.as_dict(), "brainError": PROACTIVE.status()["brainError"]}


@app.post("/api/preferences")
async def set_preferences(changes: dict[str, Any]) -> dict[str, Any]:
    """Quanto chiacchiera, di cosa, e la citta' del meteo. I campi sconosciuti si ignorano."""
    current = PREFERENCES.update(changes)
    await hub.broadcast({"type": "preferences", **current})
    return current


@app.get("/api/weather")
async def get_weather() -> dict[str, Any]:
    """Il meteo che vede il companion (passa dalla rete: per il pannello, non per i controlli)."""
    instance = _current()
    language = instance.voice_language if instance else SETTINGS.system_language
    weather = await WEATHER.get(PREFERENCES.city, language)
    return {"ok": weather is not None, "weather": weather.as_dict() if weather else None}


# ---------------------------------------------------------------------------
# Musica (Spotify)
# ---------------------------------------------------------------------------
class SpotifySetupRequest(BaseModel):
    clientId: str = Field(max_length=64)


@app.get("/api/music")
async def get_music() -> dict[str, Any]:
    """Spotify collegato o no, cosa suona (dall'ultimo controllo) e i gusti imparati."""
    return MUSIC.status()


@app.post("/api/music/spotify/setup")
async def spotify_setup(request: SpotifySetupRequest) -> dict[str, Any]:
    """Salva il Client ID e restituisce la pagina di Spotify dove dare il permesso."""
    try:
        MUSIC.spotify.set_client_id(request.clientId)
        return {"authorizeUrl": MUSIC.spotify.authorize_url(MUSIC.redirect_uri)}
    except (ValueError, SpotifyError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/music/spotify/callback", response_class=HTMLResponse)
async def spotify_callback(code: str = "", state: str = "", error: str = "") -> HTMLResponse:
    """Spotify rimanda qui il browser dopo il permesso: si prendono i token e si avvisa il pannello."""
    if error:
        message = "Hai negato il permesso: Spotify non è collegato." if error == "access_denied" else f"Spotify ha risposto: {error}"
        return HTMLResponse(_music_page(False, message))
    try:
        user = await MUSIC.spotify.finish(code, state, MUSIC.redirect_uri)
    except (SpotifyError, httpx.HTTPError) as exc:
        return HTMLResponse(_music_page(False, f"Collegamento non riuscito: {exc}"))
    _spawn(MUSIC.refresh(), report=False)
    await _music_changed(MUSIC.status())
    return HTMLResponse(_music_page(True, f"Spotify è collegato{f' come {user}' if user else ''}. Puoi chiudere questa scheda."))


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


def _music_page(ok: bool, message: str) -> str:
    """La pagina che resta nel browser dopo il collegamento."""
    color = "#1db954" if ok else "#e5534b"
    return (
        "<!doctype html><html lang='it'><head><meta charset='utf-8'><title>Tsukumo e Spotify</title>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'></head>"
        "<body style='margin:0;min-height:100vh;display:grid;place-items:center;background:#121418;"
        "color:#e8e8ea;font:16px system-ui,sans-serif'><main style='max-width:420px;padding:24px;text-align:center'>"
        f"<div style='width:14px;height:14px;border-radius:50%;background:{color};margin:0 auto 16px'></div>"
        f"<p>{escape(message)}</p></main></body></html>"
    )


# ---------------------------------------------------------------------------
# Contesto del PC
# ---------------------------------------------------------------------------
@app.post("/api/context")
async def set_context(request: ContextRequest) -> dict[str, Any]:
    """La shell dice cosa sta facendo l'utente; i client lo sanno solo se cambia."""
    if PC.update(request.idle, request.locked, request.app):
        activity = PC.activity
        logger.info(
            "Attivita': %s%s%s",
            activity.kind,
            f" ({activity.label})" if activity.label else "",
            " a schermo intero" if activity.fullscreen else "",
        )
        await hub.broadcast(PC.as_dict())
    return {"ok": True, "activity": PC.activity.as_dict()}


@app.get("/api/context")
async def get_context() -> dict[str, Any]:
    return PC.as_dict()


@app.post("/api/vocal")
async def api_vocal(request: VocalRequest) -> dict[str, Any]:
    """Un versetto con la voce in uso, restituito solo a chi lo chiede.

    ``ok: false`` quando e' meglio tacere (muto, sta pensando o parlando) o
    quando la voce non funziona: un versetto mancato non e' un errore.
    """
    if request.event not in VOCAL_EVENTS:
        raise HTTPException(status_code=400, detail=f"Versetto sconosciuto: {request.event!r}")
    try:
        payload = await companion().vocal(request.event)
    except Exception as exc:
        logger.debug("Versetto %s non sintetizzato: %s", request.event, exc)
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
    """Copia del payload senza il blob base64: risposte REST leggibili."""
    return {k: v for k, v in payload.items() if k != "audio"}


def _animations_info() -> list[dict[str, str]]:
    """Le clip .vrma della cartella delle animazioni, con l'URL da cui caricarle."""
    directory: Path = SETTINGS.animations_dir
    files = sorted(p.name for p in directory.glob("*.vrma")) if directory.is_dir() else []
    return [{"name": name, "url": f"/animations/{name}"} for name in files]


@app.get("/api/animations")
async def animations() -> dict[str, Any]:
    return {"directory": str(SETTINGS.animations_dir), "animations": _animations_info()}


def _avatar_info() -> dict[str, Any]:
    """Cerca un modello .vrm nella cartella degli avatar."""
    directory: Path = SETTINGS.avatar_dir
    files = sorted(p.name for p in directory.glob("*.vrm")) if directory.is_dir() else []
    default = "avatar.vrm" if "avatar.vrm" in files else (files[0] if files else None)
    return {
        "directory": str(directory),
        "files": files,
        "default": f"/models/{default}" if default else None,
    }


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    await hub.add(websocket)
    logger.info("Client connesso (%d totali)", hub.count)

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
            }
        )

        remote = bool(websocket.scope.get("tsukumo.remote"))
        while True:
            message = await websocket.receive_json()
            if not isinstance(message, dict):
                continue
            kind = str(message.get("type", "")).lower()
            # Il motore puo' essere cambiato dal pannello nel frattempo.
            instance = companion()

            if kind == "ping":
                await websocket.send_json({"type": "pong"})
            elif kind == "chat":
                # Task separato: il loop resta libero di ricevere "cancel".
                files = [str(item) for item in (message.get("files") or []) if isinstance(item, str)]
                if remote:
                    # Da fuori solo i file caricati (POST /api/attachments), mai un percorso del PC.
                    files = [item for item in files if within(Path(item), [SETTINGS.state_dir / "uploads"])]
                _spawn(instance.chat(message.get("text", ""), hub.broadcast, files=files, screen=bool(message.get("screen"))))
            elif kind == "capabilities":
                # La finestra del personaggio in Electron sa fare gli screenshot.
                if message.get("screen") and not remote:
                    SCREEN_CLIENTS.add(websocket)
            elif kind == "say":
                _spawn(instance.say(message.get("text", ""), hub.broadcast, message.get("voice")))
            elif kind == "voice":
                # Audio dal microfono: PCM 16 bit a 16 kHz in base64. Lo
                # trascriviamo e, salvo richiesta contraria, lo trattiamo
                # esattamente come se fosse stato scritto nella chat.
                _spawn(_handle_voice(instance, message))
            elif kind == "settings":
                # Voce, lingua e muto scelti dal pannello: li rimandiamo a
                # tutti, cosi' ogni finestra resta allineata. La voce si
                # controlla in un thread: puo' servire l'elenco dal servizio.
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
                    {"type": "error", "message": f"Tipo di messaggio sconosciuto: {kind!r}"}
                )

    except WebSocketDisconnect:
        pass
    except Exception as exc:  # pragma: no cover - errori di trasporto
        logger.warning("WebSocket chiuso con errore: %s", describe_error(exc))
    finally:
        SCREEN_CLIENTS.discard(websocket)
        await hub.remove(websocket)
        logger.info("Client disconnesso (%d rimasti)", hub.count)


async def _handle_voice(instance: Companion, message: dict[str, Any]) -> None:
    """Trascrive l'audio ricevuto e, se c'e' del testo, avvia il turno.

    La trascrizione viene sempre rimandata a tutti i client prima di parlare:
    cosi' si vede subito cosa il companion ha capito, anche quando ha capito
    male, invece di dover indovinare dalla risposta.
    """
    raw = message.get("audio") or ""
    try:
        pcm16 = base64.b64decode(raw, validate=True)
    except (ValueError, binascii.Error):
        await hub.broadcast({"type": "error", "source": "stt", "message": "Audio non valido"})
        return

    started = time.perf_counter()
    transcript = await instance.transcribe(pcm16)
    if transcript is None:
        await hub.broadcast(
            {
                "type": "error",
                "source": "stt",
                "message": "Il riconoscimento vocale non è attivo",
                "hint": "Sceglilo nella scheda Motori, sezione Ascolto.",
                "action": "engines",
            }
        )
        return

    # Microfono aperto mentre lei parla: quello che sente puo' essere lei.
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
        logger.info("Trascrizione ignorata, e' la sua voce: %r", transcript.text[:80])
        return
    if message.get("autoSend", True):
        await instance.chat(transcript.text, hub.broadcast)


def _spawn(coro, report: bool = True) -> None:
    """Avvia un lavoro in background tenendone un riferimento forte."""
    task = asyncio.create_task(_run_turn(coro, report))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


async def _run_turn(coro, report: bool = True) -> None:
    """Esegue un lavoro segnalando gli eventuali errori a tutti i client."""
    try:
        await coro
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.exception("Lavoro in background fallito")
        if report:
            await hub.broadcast({"type": "error", "message": describe_error(exc)})


# ---------------------------------------------------------------------------
# Frontend statico
# ---------------------------------------------------------------------------
_PLACEHOLDER = """<!doctype html>
<html lang="it"><head><meta charset="utf-8"><title>Tsukumo</title>
<style>body{font-family:system-ui,sans-serif;background:#111114;color:#ececf1;
display:grid;place-items:center;height:100vh;margin:0}
main{max-width:34rem;line-height:1.6}code{background:#23232a;padding:.15rem .4rem;
border-radius:.3rem}</style></head>
<body><main>
<h1>Tsukumo</h1>
<p>Il backend e' attivo, ma il frontend non e' ancora stato compilato.</p>
<p>Esegui:</p>
<pre><code>cd frontend
npm install
npm run build</code></pre>
<p>Oppure avvia il dev server con <code>npm run dev</code> e apri
<a style="color:#9db4ff" href="http://localhost:5173">http://localhost:5173</a>.</p>
<p>API attiva: <code>GET /api/health</code></p>
</main></body></html>"""


class BuildAwareStatics(StaticFiles):
    """File statici con gli header di cache giusti.

    Vite genera i bundle con l'hash del contenuto nel nome (``index-a1b2c3.js``):
    quelli si possono cachare per sempre. ``index.html`` invece li *referenzia*,
    quindi se il browser lo tiene in cache continua a caricare il bundle vecchio
    dopo ogni ``npm run build`` - ed e' esattamente il tipo di bug che fa
    impazzire ("ho ricompilato ma non cambia niente").
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
    """Monta i file statici. L'ordine conta: /models prima del catch-all /."""
    if SETTINGS.avatar_dir.is_dir():
        # L'avatar puo' essere sostituito a caldo: niente cache aggressiva.
        app.mount("/models", BuildAwareStatics(directory=SETTINGS.avatar_dir), name="models")
    SETTINGS.animations_dir.mkdir(parents=True, exist_ok=True)
    app.mount("/animations", BuildAwareStatics(directory=SETTINGS.animations_dir), name="animations")

    if SETTINGS.frontend_dist.is_dir() and (SETTINGS.frontend_dist / "index.html").is_file():
        app.mount("/", BuildAwareStatics(directory=SETTINGS.frontend_dist, html=True), name="frontend")
        logger.info("Frontend servito da %s", SETTINGS.frontend_dist)
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
    parser.add_argument("--reload", action="store_true", help="Auto-reload per lo sviluppo")
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
