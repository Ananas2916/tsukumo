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

from .cli_agents import find_codex, resolve_executable

logger = logging.getLogger(__name__)

#: Ordine di preferenza per la scelta automatica: prima gli agenti, che hanno
#: memoria e strumenti propri, poi i modelli locali.
AUTO_ORDER = ("claude_code", "codex", "openclaw", "ollama", "openai")

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
    "openclaw": _openclaw,
    "ollama": _ollama,
    "openai": _openai,
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
    providers: Iterable[str] = AUTO_ORDER,
) -> dict[str, Result]:
    """Tutti i controlli in parallelo: in tutto circa un secondo, non cinque."""
    ids = list(providers)
    async with await _new_client() as http:
        results = await asyncio.gather(*(detect(pid, options_for(pid), http) for pid in ids))
    return dict(zip(ids, results))


def candidates(detected: Mapping[str, Result], order: Iterable[str] = AUTO_ORDER) -> list[str]:
    """I motori trovati, nell'ordine in cui conviene provarli."""
    return [pid for pid in order if (detected.get(pid) or {}).get("found")]
