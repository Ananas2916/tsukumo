"""Quali cervelli sono gia' installati sul PC?

Serve in due momenti. Al primo avvio, se nessuno ha scelto un cervello, il
companion prende il primo che trova invece di presentarsi con un Ollama che
magari non c'e'. E nella scheda Motori, che mostra "Trovato sul PC".

Ogni controllo e' leggero e senza effetti collaterali: per i programmi si cerca
solo l'eseguibile (nessun processo avviato, nemmeno ``--version``), per i
servizi basta una GET con timeout di un secondo. Gira in background dopo
l'avvio e mai dentro ``/api/health``: un servizio spento su Windows fa perdere
secondi a ogni tentativo di connessione (vedi ``status.py``).
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Iterable, Mapping
from typing import Any

import httpx

from ..provider_specs import CLI_AGENT_PRESETS
from .cli_agents import find_antigravity, find_codex, resolve_executable, split_command

logger = logging.getLogger(__name__)

#: Ordine di preferenza per la scelta automatica: prima gli agenti, che hanno
#: memoria e strumenti propri, poi i modelli locali. Gli agenti "a comando"
#: (Cline, Gemini CLI...) si riconoscono ma non si scelgono da soli: ripartono
#: da zero a ogni messaggio.
AUTO_ORDER = ("claude_code", "codex", "antigravity", "openclaw", "ollama", "openai")

#: Quanto aspettare un servizio locale prima di darlo per spento.
HTTP_TIMEOUT = 1.0

Result = dict[str, Any]
Detector = Callable[[Mapping[str, Any], httpx.AsyncClient], Awaitable[Result]]


def _result(found: bool, detail: str) -> Result:
    return {"found": found, "detail": detail}


# ---------------------------------------------------------------------------
# Programmi
# ---------------------------------------------------------------------------
async def _claude_code(options: Mapping[str, Any], http: httpx.AsyncClient) -> Result:
    command = str(options.get("CLAUDE_CODE_COMMAND") or "claude")
    path = await asyncio.to_thread(resolve_executable, command)
    return _result(True, path) if path else _result(False, f"{command} non e' nel PATH")


async def _codex(options: Mapping[str, Any], http: httpx.AsyncClient) -> Result:
    path = await asyncio.to_thread(find_codex, str(options.get("CODEX_COMMAND") or ""))
    return _result(True, path) if path else _result(False, "codex non e' nel PATH ne' nelle estensioni dell'editor")


async def _antigravity(options: Mapping[str, Any], http: httpx.AsyncClient) -> Result:
    path = await asyncio.to_thread(find_antigravity, str(options.get("ANTIGRAVITY_COMMAND") or ""))
    return _result(True, path) if path else _result(False, "agy non e' nel PATH ne' in ~/.gemini/bin")


def _preset(provider_id: str, default: str) -> Detector:
    """Un agente "a comando": basta trovare il programma con cui comincia il comando."""

    async def check(options: Mapping[str, Any], http: httpx.AsyncClient) -> Result:
        command = str(options.get(f"{provider_id.upper()}_COMMAND") or default)
        program = (split_command(command) or [""])[0]
        path = await asyncio.to_thread(resolve_executable, program)
        return _result(True, path) if path else _result(False, f"{program} non e' nel PATH")

    return check


# ---------------------------------------------------------------------------
# Servizi
# ---------------------------------------------------------------------------
async def _get(http: httpx.AsyncClient, url: str) -> Result:
    """Il servizio risponde? Un 401/403 conta: c'e', vuole solo una chiave."""
    try:
        response = await http.get(url)
    except httpx.HTTPError:
        return _result(False, f"{url} non risponde")
    if response.is_success or response.status_code in (401, 403):
        return _result(True, url)
    return _result(False, f"{url} risponde {response.status_code}")


async def _openclaw(options: Mapping[str, Any], http: httpx.AsyncClient) -> Result:
    base = str(options.get("OPENCLAW_URL") or "http://127.0.0.1:18789").rstrip("/")
    base = base.replace("ws://", "http://").replace("wss://", "https://")
    return await _get(http, f"{base}/health")


async def _ollama(options: Mapping[str, Any], http: httpx.AsyncClient) -> Result:
    base = str(options.get("OLLAMA_URL") or "http://127.0.0.1:11434").rstrip("/")
    return await _get(http, f"{base}/api/tags")


async def _openai(options: Mapping[str, Any], http: httpx.AsyncClient) -> Result:
    base = str(options.get("OPENAI_BASE_URL") or "http://127.0.0.1:1234/v1").rstrip("/")
    return await _get(http, f"{base}/models")


DETECTORS: dict[str, Detector] = {
    "claude_code": _claude_code,
    "codex": _codex,
    "antigravity": _antigravity,
    "openclaw": _openclaw,
    "ollama": _ollama,
    "openai": _openai,
    **{pid: _preset(pid, command) for pid, command in CLI_AGENT_PRESETS.items()},
}


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------
async def _new_client() -> httpx.AsyncClient:
    # Creare un client carica i certificati (~0,2 s): in un thread, per non
    # fermare il loop del server, e uno solo per tutti i controlli.
    return await asyncio.to_thread(httpx.AsyncClient, timeout=HTTP_TIMEOUT)


async def detect(
    provider: str,
    options: Mapping[str, Any] | None = None,
    http: httpx.AsyncClient | None = None,
) -> Result:
    """Il motore ``provider`` e' installato o acceso? Non solleva mai."""
    detector = DETECTORS.get(provider)
    if detector is None:
        return _result(False, "riconoscimento automatico non disponibile")
    if http is None:
        async with await _new_client() as own:
            return await detect(provider, options, own)
    try:
        return await detector(options or {}, http)
    except Exception as exc:  # un controllo rotto non deve fermare gli altri
        logger.debug("Riconoscimento di %s fallito: %s", provider, exc)
        return _result(False, str(exc) or type(exc).__name__)


async def detect_all(
    options_for: Callable[[str], Mapping[str, Any]],
    providers: Iterable[str] | None = None,
) -> dict[str, Result]:
    """Tutti i controlli in parallelo: in tutto circa un secondo, non cinque.

    Senza ``providers`` controlla tutti i motori riconoscibili, per i badge
    del pannello; la scelta automatica guarda poi solo ``AUTO_ORDER``.
    """
    ids = list(providers if providers is not None else DETECTORS)
    async with await _new_client() as http:
        results = await asyncio.gather(*(detect(pid, options_for(pid), http) for pid in ids))
    return dict(zip(ids, results))


def candidates(detected: Mapping[str, Result], order: Iterable[str] = AUTO_ORDER) -> list[str]:
    """I motori trovati, nell'ordine in cui conviene provarli."""
    return [pid for pid in order if (detected.get(pid) or {}).get("found")]
