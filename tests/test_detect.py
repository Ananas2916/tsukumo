"""Riconoscimento dei cervelli installati e scelta automatica al primo avvio.

Nessun servizio vero: i servizi sono un piccolo server HTTP locale, i
programmi sono l'interprete Python stesso, e il ``.env`` non viene mai
scritto (``save_dotenv`` e' sostituito da un registratore).
"""

import asyncio
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from backend import server
from backend.llm import detect
from backend.llm.ollama import OllamaClient


# ---------------------------------------------------------------------------
# Controlli singoli
# ---------------------------------------------------------------------------
class _Handler(BaseHTTPRequestHandler):
    ROUTES = {"/health": 200, "/api/tags": 200, "/v1/models": 401}

    def do_GET(self):  # noqa: N802 - nome imposto da http.server
        self.send_response(self.ROUTES.get(self.path, 404))
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *args):
        pass


@pytest.fixture(scope="module")
def local_url():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


def _closed_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def test_programs_are_found_without_running_them():
    found = asyncio.run(detect.detect("claude_code", {"CLAUDE_CODE_COMMAND": sys.executable}))
    assert found == {"found": True, "detail": sys.executable}
    missing = asyncio.run(detect.detect("claude_code", {"CLAUDE_CODE_COMMAND": "tsukumo-non-esiste-xyz"}))
    assert missing["found"] is False
    codex = asyncio.run(detect.detect("codex", {"CODEX_COMMAND": sys.executable}))
    assert codex["found"] is True


def test_services_answer_on_their_own_paths(local_url):
    assert asyncio.run(detect.detect("ollama", {"OLLAMA_URL": local_url}))["found"] is True
    # OpenClaw si scrive spesso con ws://: la sonda passa comunque da http.
    ws_url = local_url.replace("http://", "ws://")
    assert asyncio.run(detect.detect("openclaw", {"OPENCLAW_URL": ws_url}))["found"] is True
    # LM Studio con la chiave obbligatoria risponde 401: c'e', vuole solo la chiave.
    assert asyncio.run(detect.detect("openai", {"OPENAI_BASE_URL": f"{local_url}/v1"}))["found"] is True
    # Un 404 e' un altro programma su quella porta, non il motore.
    other = asyncio.run(detect.detect("openai", {"OPENAI_BASE_URL": f"{local_url}/altro"}))
    assert other["found"] is False and "404" in other["detail"]


def test_a_service_that_is_off_costs_at_most_a_second():
    # Su Windows una porta chiusa di localhost ritenta la connessione per ~2 s.
    started = time.perf_counter()
    result = asyncio.run(detect.detect("ollama", {"OLLAMA_URL": f"http://127.0.0.1:{_closed_port()}"}))
    assert result["found"] is False
    assert time.perf_counter() - started < 1.8


def test_a_broken_or_unknown_detector_never_raises(monkeypatch):
    async def broken(options, http):
        raise OSError("disco rotto")

    monkeypatch.setitem(detect.DETECTORS, "codex", broken)
    assert asyncio.run(detect.detect("codex")) == {"found": False, "detail": "disco rotto"}
    assert asyncio.run(detect.detect("anthropic"))["found"] is False


def test_detect_all_runs_in_parallel_and_keeps_the_order(monkeypatch):
    async def slow(options, http):
        await asyncio.sleep(0.3)
        return {"found": True, "detail": "ok"}

    for provider in list(detect.DETECTORS):
        monkeypatch.setitem(detect.DETECTORS, provider, slow)
    started = time.perf_counter()
    result = asyncio.run(detect.detect_all(lambda provider: {}, detect.AUTO_ORDER))
    assert time.perf_counter() - started < 1.0
    assert list(result) == list(detect.AUTO_ORDER)
    # Senza elenco: tutti i motori riconoscibili, anche gli agenti "a comando".
    everything = asyncio.run(detect.detect_all(lambda provider: {}))
    assert set(everything) == set(detect.DETECTORS)
    assert {"antigravity", "cline", "gemini_cli"} <= set(everything)


def test_candidates_follow_the_preferred_order():
    detected = {
        "openai": {"found": True},
        "ollama": {"found": True},
        "codex": {"found": False},
        "claude_code": {"found": True},
    }
    assert detect.candidates(detected) == ["claude_code", "ollama", "openai"]
    assert detect.candidates({}) == []


# ---------------------------------------------------------------------------
# Scelta automatica nel server
# ---------------------------------------------------------------------------
FAKE_DETECTED = {
    "claude_code": {"found": False, "detail": "claude non e' nel PATH"},
    "codex": {"found": False, "detail": "codex non trovato"},
    "antigravity": {"found": False, "detail": "agy non trovato"},
    "openclaw": {"found": True, "detail": "http://127.0.0.1:18789/health"},
    "ollama": {"found": True, "detail": "http://127.0.0.1:11434/api/tags"},
    "openai": {"found": False, "detail": "non risponde"},
}


@pytest.fixture
def fake_pc(client, monkeypatch):
    """Rilevamento finto e .env finto; alla fine il cervello torna ``mock``."""
    saved: list[dict[str, str]] = []

    def fake_save_dotenv(updates, path=None):
        saved.append(dict(updates))
        for key, value in updates.items():
            if value:
                monkeypatch.setenv(key, value)
            else:
                monkeypatch.delenv(key, raising=False)

    async def fake_detect_all(options_for, providers=detect.AUTO_ORDER):
        return {provider: dict(FAKE_DETECTED[provider]) for provider in providers}

    monkeypatch.setattr(server, "save_dotenv", fake_save_dotenv)
    monkeypatch.setattr(server, "detect_all", fake_detect_all)
    instance = server.app.state.companion
    original_settings, original_llm = server.SETTINGS, instance.llm
    yield saved
    replaced = instance.llm
    instance.llm, instance.settings = original_llm, original_settings
    server.SETTINGS = original_settings
    server.DETECTED = {}
    if replaced is not original_llm:
        client.portal.call(server._close_engine, replaced)


def test_first_start_picks_the_first_engine_that_works(client, fake_pc, monkeypatch):
    monkeypatch.delenv("DC_LLM_BACKEND", raising=False)
    instance = server.app.state.companion
    original_replace = instance.replace_engine

    def replace_engine(kind, settings):
        if settings.llm_backend == "openclaw":  # acceso ma senza token
            raise RuntimeError("Token OpenClaw non trovato")
        return original_replace(kind, settings)

    monkeypatch.setattr(instance, "replace_engine", replace_engine)
    client.portal.call(server._detect_engines)

    assert fake_pc == [{"DC_LLM_BACKEND": "ollama"}]
    assert isinstance(instance.llm, OllamaClient)
    assert server.SETTINGS.llm_backend == "ollama"
    data = client.get("/api/providers").json()
    assert data["selected"]["llm"] == "ollama"
    assert data["detected"]["llm"]["openclaw"]["found"] is True
    assert data["detected"]["llm"]["claude_code"]["found"] is False


def test_an_explicit_choice_is_never_overridden(client, fake_pc):
    # conftest imposta DC_LLM_BACKEND=mock: come un .env scritto a mano.
    instance = server.app.state.companion
    llm = instance.llm
    client.portal.call(server._detect_engines)

    assert fake_pc == []
    assert instance.llm is llm
    data = client.get("/api/providers").json()
    assert data["selected"]["llm"] == "mock"
    assert data["detected"]["llm"]["ollama"]["found"] is True


def test_nothing_found_keeps_the_default_and_writes_nothing(client, fake_pc, monkeypatch):
    monkeypatch.delenv("DC_LLM_BACKEND", raising=False)

    async def nothing(options_for, providers=detect.AUTO_ORDER):
        return {provider: {"found": False, "detail": "no"} for provider in providers}

    monkeypatch.setattr(server, "detect_all", nothing)
    llm = server.app.state.companion.llm
    client.portal.call(server._detect_engines)
    assert fake_pc == []
    assert server.app.state.companion.llm is llm


def test_health_answers_while_detection_is_still_running(client, monkeypatch):
    async def stuck(*args, **kwargs):
        await asyncio.sleep(30)

    monkeypatch.setattr(server, "detect_all", stuck)
    pending = client.portal.start_task_soon(server._detect_engines)
    try:
        started = time.perf_counter()
        assert client.get("/api/health").json()["ok"] is True
        assert time.perf_counter() - started < 1.0
    finally:
        pending.cancel()
