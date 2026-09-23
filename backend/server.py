"""Server FastAPI: WebSocket per il companion + API REST + hosting del frontend.

Protocollo WebSocket (``/ws``)
------------------------------
Client -> server::

    {"type": "chat",   "text": "ciao!"}      # LLM + voce
    {"type": "say",    "text": "ciao!"}      # solo voce
    {"type": "settings", "voice": "af_heart", "replyLanguage": "auto"}
    {"type": "cancel"}                       # interrompe il turno corrente
    {"type": "reset"}                        # svuota la memoria conversazione
    {"type": "ping"}

Server -> client::

    {"type": "hello",  "config": {...}, "voices": [...]}
    {"type": "state",  "value": "thinking" | "speaking" | "idle"}
    {"type": "user",   "text": "..."}
    {"type": "token",  "text": "..."}        # streaming dell'LLM
    {"type": "speech", "audio": "<wav base64>", "visemes": [...], ...}
    {"type": "reply",  "text": "..."}        # risposta completa
    {"type": "notice" | "error", "message": "..."}
    {"type": "pong"}

Il messaggio ``speech`` e' quello che guida il lip-sync: contiene il WAV in
base64 e la timeline ``[{t, d, v, w}, ...]`` (tempo, durata, viseme, peso).
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
import contextlib
import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__
from .config import Settings, save_dotenv
from .openclaw import OpenClawMonitor
from .phonemes import VISEME_BLENDSHAPES
from .pipeline import Companion
from .providers import REGISTRIES, describe_all

logger = logging.getLogger("desk-companion")

SETTINGS = Settings.from_env()


# ---------------------------------------------------------------------------
# Gestione delle connessioni WebSocket
# ---------------------------------------------------------------------------
class ConnectionHub:
    """Tiene traccia dei client collegati e fa da broadcaster.

    Il broadcast serve perche' possono esserci piu' finestre aperte (per
    esempio la finestra Electron e una scheda del browser): tutte devono
    vedere lo stesso avatar parlare.
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
    # Il monitor di OpenClaw sonda il Gateway ogni pochi secondi: senza questo
    # sarebbero due righe di httpx ogni volta, e basta da sole a riempire il log.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logger.info("Desk Companion %s in avvio...", __version__)
    # Il caricamento del modello ONNX e' bloccante: lo spostiamo in un thread.
    app.state.companion = await asyncio.to_thread(Companion, SETTINGS)

    # Spia OpenClaw: un task in background che avvisa solo quando cambia stato.
    app.state.openclaw = None
    if SETTINGS.openclaw_enabled:
        monitor = OpenClawMonitor(
            base_url=SETTINGS.openclaw_url,
            interval=SETTINGS.openclaw_interval,
            on_change=hub.broadcast,
        )
        app.state.openclaw = monitor
        await monitor.start()

    logger.info(
        "Pronto: TTS=%s  LLM=%s  -> http://%s:%s",
        app.state.companion.tts.name,
        app.state.companion.llm.name,
        SETTINGS.host,
        SETTINGS.port,
    )
    try:
        yield
    finally:
        if app.state.openclaw is not None:
            await app.state.openclaw.stop()
        await app.state.companion.close()
        logger.info("Desk Companion arrestato")


app = FastAPI(title="Desk Companion", version=__version__, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=SETTINGS.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def companion() -> Companion:
    instance = getattr(app.state, "companion", None)
    if instance is None:  # pragma: no cover - solo se si chiama troppo presto
        raise HTTPException(status_code=503, detail="Companion non ancora pronto")
    return instance


def openclaw_status() -> dict[str, Any]:
    """Stato corrente della spia OpenClaw (senza mai interrogare la rete)."""
    monitor: OpenClawMonitor | None = getattr(app.state, "openclaw", None)
    if monitor is None:
        return {"type": "openclaw", "state": "disabled", "connected": False, "error": None}
    return monitor.status


# ---------------------------------------------------------------------------
# Modelli delle richieste REST
# ---------------------------------------------------------------------------
class ChatRequest(BaseModel):
    text: str = Field(..., min_length=1, description="Messaggio dell'utente")


class SayRequest(BaseModel):
    text: str = Field(..., min_length=1, description="Testo da pronunciare")
    voice: str | None = Field(None, description="Voce Kokoro, es. af_heart")
    speed: float | None = Field(None, gt=0.25, le=3.0, description="Velocita' di lettura")


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
    instance = companion()
    return {
        "ok": True,
        "version": __version__,
        "clients": hub.count,
        "tts": {"engine": instance.tts.name, "voices": instance.tts.voices()[:64]},
        "llm": await instance.llm.health(),
        "avatar": _avatar_info(),
        "openclaw": openclaw_status(),
    }


@app.get("/api/openclaw")
async def openclaw() -> dict[str, Any]:
    """Stato del Gateway OpenClaw, forzando un controllo immediato."""
    monitor: OpenClawMonitor | None = getattr(app.state, "openclaw", None)
    if monitor is None:
        return openclaw_status()
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
        "selected": {
            "llm": SETTINGS.selected("llm"),
            "tts": SETTINGS.selected("tts"),
            "stt": SETTINGS.selected("stt"),
        },
        "options": {
            "llm": SETTINGS.provider_public("llm"),
            "tts": SETTINGS.provider_public("tts"),
            "stt": SETTINGS.provider_public("stt"),
        },
    }


@app.post("/api/providers")
async def set_provider(request: ProviderRequest) -> dict[str, Any]:
    """Cambia il motore attivo per un tipo, salvando la scelta in ``.env``.

    Prima scriviamo, poi ricostruiamo: se la ricostruzione fallisce (chiave
    sbagliata, pacchetto mancante, server spento) ripristiniamo i valori
    precedenti e rispondiamo con il motivo, invece di lasciare il companion in
    uno stato a meta'.
    """
    global SETTINGS

    kind = request.kind
    if kind not in REGISTRIES:
        raise HTTPException(status_code=400, detail=f"Tipo sconosciuto: {kind!r}")

    registry = REGISTRIES[kind]
    spec = registry.get(request.provider)
    if spec is None:
        raise HTTPException(status_code=400, detail=f"Motore sconosciuto: {request.provider!r}")

    # Solo i campi che il motore dichiara: cosi' il pannello non puo' scrivere
    # variabili arbitrarie nel .env dell'utente.
    allowed = {field.env for field in spec.fields}
    unknown = set(request.options) - allowed
    if unknown:
        raise HTTPException(
            status_code=400, detail=f"Campi non previsti da {spec.id!r}: {sorted(unknown)}"
        )

    select_key = {"llm": "DC_LLM_BACKEND", "tts": "DC_TTS_ENGINE", "stt": "DC_STT_ENGINE"}[kind]
    updates = {select_key: spec.id}
    for env_name, value in request.options.items():
        updates[f"DC_{env_name}"] = "" if value is None else str(value)

    previous = {key: os.environ.get(key, "") for key in updates}
    save_dotenv(updates)

    try:
        rebuilt = await asyncio.to_thread(Companion, Settings.from_env())
    except Exception as exc:
        save_dotenv(previous)  # rimettiamo tutto com'era
        logger.warning("Cambio di %s a %r fallito: %s", kind, spec.id, exc)
        return {"ok": False, "error": str(exc), "kind": kind, "provider": spec.id}

    old = getattr(app.state, "companion", None)
    app.state.companion = rebuilt
    SETTINGS = rebuilt.settings
    if old is not None:
        await old.close()

    logger.info("Motore %s cambiato in %r", kind, spec.id)
    await hub.broadcast(
        {
            "type": "providers",
            "selected": {k: SETTINGS.selected(k) for k in REGISTRIES},
            "voices": rebuilt.tts.voices(),
        }
    )
    return {
        "ok": True,
        "kind": kind,
        "provider": spec.id,
        "options": SETTINGS.provider_public(kind),
        "voices": rebuilt.tts.voices() if kind == "tts" else None,
    }


@app.get("/api/voices")
async def voices() -> dict[str, Any]:
    """Voci del motore TTS attivo: l'elenco cambia con il motore scelto."""
    instance = companion()
    return {
        "voices": instance.tts.voices(),
        "current": SETTINGS.voice,
        "engine": instance.tts.name,
    }


@app.post("/api/say")
async def api_say(request: SayRequest) -> dict[str, Any]:
    """Sintetizza senza LLM e restituisce audio + visemi (comodo con curl)."""
    payloads = await companion().synthesize_payload(request.text, request.voice, request.speed)
    for payload in payloads:
        await hub.broadcast(payload)
    return {"chunks": [_without_audio(p) for p in payloads], "count": len(payloads)}


@app.post("/api/chat")
async def api_chat(request: ChatRequest) -> dict[str, Any]:
    """Turno completo; l'audio viene inviato ai client WebSocket collegati."""
    reply = await companion().chat(request.text, hub.broadcast)
    return {"reply": reply, "clients": hub.count}


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
    instance = companion()
    logger.info("Client connesso (%d totali)", hub.count)

    try:
        await websocket.send_json(
            {
                "type": "hello",
                "version": __version__,
                "config": {**SETTINGS.public_dict(), **instance.current_settings()},
                "blendshapes": VISEME_BLENDSHAPES,
                "voices": instance.tts.voices(),
                "avatar": _avatar_info(),
                "openclaw": openclaw_status(),
            }
        )

        while True:
            message = await websocket.receive_json()
            kind = str(message.get("type", "")).lower()

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
                # Voce e lingua delle risposte scelte dal pannello: le
                # rimandiamo a tutti, cosi' ogni finestra resta allineata.
                current = instance.update_settings(message.get("voice"), message.get("replyLanguage"))
                await hub.broadcast({"type": "settings", **current})
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
        logger.warning("WebSocket chiuso con errore: %s", exc)
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
        await hub.broadcast({"type": "error", "message": "Audio non valido"})
        return

    transcript = await instance.transcribe(pcm16)
    if transcript is None:
        await hub.broadcast(
            {"type": "error", "message": "Il riconoscimento vocale non e' attivo"}
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


def _spawn(coro) -> None:
    """Avvia un turno in background tenendone un riferimento forte."""
    task = asyncio.create_task(_run_turn(coro))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


async def _run_turn(coro) -> None:
    """Esegue un turno segnalando gli eventuali errori a tutti i client."""
    try:
        await coro
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.exception("Turno fallito")
        await hub.broadcast({"type": "error", "message": str(exc)})


# ---------------------------------------------------------------------------
# Frontend statico
# ---------------------------------------------------------------------------
_PLACEHOLDER = """<!doctype html>
<html lang="it"><head><meta charset="utf-8"><title>Desk Companion</title>
<style>body{font-family:system-ui,sans-serif;background:#12141c;color:#e8eaf2;
display:grid;place-items:center;height:100vh;margin:0}
main{max-width:34rem;line-height:1.6}code{background:#222636;padding:.15rem .4rem;
border-radius:.3rem}</style></head>
<body><main>
<h1>Desk Companion</h1>
<p>Il backend e' attivo, ma il frontend non e' ancora stato compilato.</p>
<p>Esegui:</p>
<pre><code>cd frontend
npm install
npm run build</code></pre>
<p>Oppure avvia il dev server con <code>npm run dev</code> e apri
<a style="color:#8ab4ff" href="http://localhost:5173">http://localhost:5173</a>.</p>
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
    parser = argparse.ArgumentParser(description="Desk Companion backend")
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
