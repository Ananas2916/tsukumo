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
    {"type": "reminder", "event": "fired", "reminder": {...}}  # uno e' appena scattato
    {"type": "gesture", "name": "yawn"}      # un gesto che accompagna un commento spontaneo
    {"type": "preferences", ...}             # quanto chiacchiera e di cosa
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
import logging
import os
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__
from .config import Settings, save_dotenv
from .context import PCContext
from .news import NewsService
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
from .llm import create_llm_client, describe_error
from .llm.detect import candidates, detect_all
from .phonemes import VISEME_BLENDSHAPES
from .pipeline import Companion
from .providers import REGISTRIES, ProviderSpec, describe_all
from .status import EngineMonitor, llm_entry
from .tts import build_tts_engine
from .vocals import EVENTS as VOCAL_EVENTS
from .weather import WeatherService

logger = logging.getLogger("tsukumo")

SETTINGS = Settings.from_env()

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
#: Sveglia il pianificatore quando cambia qualcosa (creato nel loop giusto, all'avvio).
_reminders_wake: asyncio.Event | None = None

#: Cervelli trovati sul PC (vedi ``llm/detect.py``): ``{id: {"found", "detail"}}``.
#: Si riempie in background poco dopo l'avvio; prima e' vuoto.
DETECTED: dict[str, dict[str, Any]] = {}


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
    reminder_task = asyncio.create_task(_reminder_loop(), name="reminders")
    if SETTINGS.proactive:
        await PROACTIVE.start()
    if SETTINGS.detect_engines:
        _spawn(_detect_engines(), report=False)

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
        reminder_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await reminder_task
        await PROACTIVE.stop()
        await monitor.stop()
        await app.state.companion.close()
        logger.info("Tsukumo arrestato")


app = FastAPI(title="Tsukumo", version=__version__, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=SETTINGS.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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


class ReminderRequest(BaseModel):
    phrase: str | None = Field(None, description="Richiesta a parole: 'tra 20 minuti ricordami di bere'")
    kind: str = Field("reminder", description="timer, reminder, alarm, task")
    text: str = Field("", description="Cosa ricordare o fare")
    at: str | None = Field(None, description="Quando, in ISO locale: 2026-12-29T12:00")
    seconds: float | None = Field(None, gt=0, description="Oppure tra quanti secondi")
    repeat: str = Field("", description="'' oppure 'daily'")


class ContextRequest(BaseModel):
    idle: float = Field(0, ge=0, description="Secondi senza mouse ne' tastiera")
    locked: bool = Field(False, description="Schermo bloccato")
    app: dict[str, Any] | None = Field(None, description="Finestra in primo piano: title, exe, fullscreen, own")


class VocalRequest(BaseModel):
    event: str = Field(..., description="greet, morning, evening, night, welcome, pat, poke, lift, fall")


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
        cleaned[env_name] = text
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
    """Cerca i cervelli sul PC; se nessuno ne ha scelto uno, usa il primo trovato."""
    global DETECTED

    DETECTED = await detect_all(lambda provider: SETTINGS.provider_config("llm", provider))
    found = candidates(DETECTED)
    logger.info("Cervelli trovati sul PC: %s", ", ".join(found) or "nessuno")
    if await _auto_select_llm(found) is None:
        # Nessun cambio: il pannello deve comunque vedere i badge.
        await _announce_providers("llm", _current())


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
    """Collega al companion i promemoria (e l'avviso quando cambiano)."""
    instance.reminders = REMINDERS
    instance.on_reminders_changed = _reminders_changed


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
# Preferenze e meteo
# ---------------------------------------------------------------------------
@app.get("/api/preferences")
async def get_preferences() -> dict[str, Any]:
    return PREFERENCES.as_dict()


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
            }
        )

        while True:
            message = await websocket.receive_json()
            kind = str(message.get("type", "")).lower()
            # Il motore puo' essere cambiato dal pannello nel frattempo.
            instance = companion()

            if kind == "ping":
                await websocket.send_json({"type": "pong"})
            elif kind == "chat":
                # Task separato: il loop resta libero di ricevere "cancel".
                _spawn(instance.chat(message.get("text", ""), hub.broadcast))
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

    await hub.broadcast(
        {
            "type": "transcript",
            "text": transcript.text,
            "language": transcript.language,
            "confidence": transcript.confidence,
            "duration": transcript.duration,
        }
    )

    if transcript.is_empty:
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

    import uvicorn

    with contextlib.suppress(KeyboardInterrupt):
        uvicorn.run(
            "backend.server:app" if args.reload else app,
            host=args.host,
            port=args.port,
            log_level=args.log_level,
            reload=args.reload,
        )


if __name__ == "__main__":
    main()
