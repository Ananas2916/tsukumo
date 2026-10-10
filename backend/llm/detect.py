"""Which brains are already installed on the PC?

It's needed at two moments. At the first start, if nobody chose a brain, the
companion takes the first one it finds instead of showing up with an Ollama
that may not be there. And in the Engines tab, which shows "Found on the PC".

Every check is light and has no side effects: for programs we only look for
the executable (no process started, not even ``--version``), for services a
GET with a one-second timeout is enough. It runs in the background after
startup and never inside ``/api/health``: a service that's off on Windows
loses seconds at every connection attempt (see ``status.py``).
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

#: Order of preference for the automatic choice: first the agents, which have
#: memory and tools of their own, then the local models. The "command" agents
#: (Cline, Gemini CLI...) are recognized but never chosen by themselves: they
#: start from scratch at every message.
AUTO_ORDER = ("claude_code", "codex", "antigravity", "openclaw", "ollama", "openai")

#: How long to wait for a local service before taking it as off.
HTTP_TIMEOUT = 1.0

Result = dict[str, Any]
Detector = Callable[[Mapping[str, Any], httpx.AsyncClient], Awaitable[Result]]


def _result(found: bool, detail: str) -> Result:
    return {"found": found, "detail": detail}


# ---------------------------------------------------------------------------
# Programs
# ---------------------------------------------------------------------------
async def _claude_code(options: Mapping[str, Any], http: httpx.AsyncClient) -> Result:
    command = str(options.get("CLAUDE_CODE_COMMAND") or "claude")
    path = await asyncio.to_thread(resolve_executable, command)
    return _result(True, path) if path else _result(False, f"{command} is not in the PATH")


async def _codex(options: Mapping[str, Any], http: httpx.AsyncClient) -> Result:
    path = await asyncio.to_thread(find_codex, str(options.get("CODEX_COMMAND") or ""))
    return _result(True, path) if path else _result(False, "codex is not in the PATH nor in the editor's extensions")


async def _antigravity(options: Mapping[str, Any], http: httpx.AsyncClient) -> Result:
    path = await asyncio.to_thread(find_antigravity, str(options.get("ANTIGRAVITY_COMMAND") or ""))
    return _result(True, path) if path else _result(False, "agy is not in the PATH nor in ~/.gemini/bin")


def _preset(provider_id: str, default: str) -> Detector:
    """A "command" agent: finding the program the command starts with is enough."""

    async def check(options: Mapping[str, Any], http: httpx.AsyncClient) -> Result:
        command = str(options.get(f"{provider_id.upper()}_COMMAND") or default)
        program = (split_command(command) or [""])[0]
        path = await asyncio.to_thread(resolve_executable, program)
        return _result(True, path) if path else _result(False, f"{program} is not in the PATH")

    return check


# ---------------------------------------------------------------------------
# Services
# ---------------------------------------------------------------------------
async def _get(http: httpx.AsyncClient, url: str) -> Result:
    """Does the service answer? A 401/403 counts: it's there, it just wants a key."""
    try:
        response = await http.get(url)
    except httpx.HTTPError:
        return _result(False, f"{url} is not answering")
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


async def _g4f(options: Mapping[str, Any], http: httpx.AsyncClient) -> Result:
    base = str(options.get("G4F_BASE_URL") or "http://127.0.0.1:1337/v1").rstrip("/")
    return await _get(http, f"{base}/models")


DETECTORS: dict[str, Detector] = {
    "claude_code": _claude_code,
    "codex": _codex,
    "antigravity": _antigravity,
    "openclaw": _openclaw,
    "ollama": _ollama,
    "openai": _openai,
    # Recognized but never chosen by itself: it isn't in AUTO_ORDER because the
    # sites behind it change often and the messages leave the PC.
    "g4f": _g4f,
    **{pid: _preset(pid, command) for pid, command in CLI_AGENT_PRESETS.items()},
}


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------
async def _new_client() -> httpx.AsyncClient:
    # Creating a client loads the certificates (~0.2 s): in a thread, so as not
    # to stop the server's loop, and one only for all the checks.
    return await asyncio.to_thread(httpx.AsyncClient, timeout=HTTP_TIMEOUT)


async def detect(
    provider: str,
    options: Mapping[str, Any] | None = None,
    http: httpx.AsyncClient | None = None,
) -> Result:
    """Is the ``provider`` engine installed or running? Never raises."""
    detector = DETECTORS.get(provider)
    if detector is None:
        return _result(False, "automatic detection unavailable")
    if http is None:
        async with await _new_client() as own:
            return await detect(provider, options, own)
    try:
        return await detector(options or {}, http)
    except Exception as exc:  # a broken check must not stop the others
        logger.debug("Detecting %s failed: %s", provider, exc)
        return _result(False, str(exc) or type(exc).__name__)


async def detect_all(
    options_for: Callable[[str], Mapping[str, Any]],
    providers: Iterable[str] | None = None,
) -> dict[str, Result]:
    """All the checks in parallel: about a second in all, not five.

    Without ``providers`` it checks every detectable engine, for the panel's
    badges; the automatic choice then looks only at ``AUTO_ORDER``.
    """
    ids = list(providers if providers is not None else DETECTORS)
    async with await _new_client() as http:
        results = await asyncio.gather(*(detect(pid, options_for(pid), http) for pid in ids))
    return dict(zip(ids, results))


def candidates(detected: Mapping[str, Result], order: Iterable[str] = AUTO_ORDER) -> list[str]:
    """The engines found, in the order in which it's best to try them."""
    return [pid for pid in order if (detected.get(pid) or {}).get("found")]
