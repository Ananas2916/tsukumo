"""API e WebSocket del backend, con cervello finto e voce a formanti."""

import asyncio
import time

from backend import server
from backend.config import save_dotenv
from backend.llm.openclaw import OpenClawClient
from backend.providers import REGISTRIES


def test_health_is_instant_even_if_the_brain_hangs(client):
    # Prima /api/health chiedeva lo stato all'agente: con OpenClaw spento
    # restava appeso e la shell Electron dava il backend per morto.
    instance = server.app.state.companion

    async def stuck():
        await asyncio.sleep(30)

    original = instance.llm.health
    instance.llm.health = stuck
    try:
        started = time.perf_counter()
        response = client.get("/api/health")
        assert time.perf_counter() - started < 1.0
    finally:
        instance.llm.health = original
    body = response.json()
    assert body["ok"] is True and body["app"] == "tsukumo"
    assert body["engines"]["llm"]["id"] == "mock"


def test_providers_are_described_with_categories(client):
    data = client.get("/api/providers").json()
    llm_ids = {p["id"] for p in data["providers"]["llm"]}
    assert {"openclaw", "claude_code", "codex", "hermes", "command"} <= llm_ids
    tts_ids = {p["id"] for p in data["providers"]["tts"]}
    assert {"elevenlabs", "openai_tts", "azure", "google_tts", "cartesia"} <= tts_ids
    categories = {p["category"] for kind in data["providers"].values() for p in kind}
    assert categories <= {"agent", "local", "cloud", "test"}
    assert data["selected"]["llm"] == "mock"


def test_every_spec_is_consistent():
    for registry in REGISTRIES.values():
        for spec in registry.all():
            envs = [f.env for f in spec.fields]
            assert len(envs) == len(set(envs)), spec.id
            for field in spec.fields:
                if field.type == "select":
                    assert field.options, f"{spec.id}.{field.env} senza opzioni"


def test_check_reports_without_applying(client):
    ok = client.post("/api/providers/check", json={"kind": "llm", "provider": "mock", "options": {}}).json()
    assert ok["ok"] is True
    missing_key = client.post(
        "/api/providers/check", json={"kind": "tts", "provider": "elevenlabs", "options": {}}
    ).json()
    assert missing_key["ok"] is False and "chiave" in missing_key["detail"].lower()
    assert client.get("/api/providers").json()["selected"]["tts"] == "formant"


def test_unknown_fields_are_rejected(client):
    response = client.post(
        "/api/providers/check", json={"kind": "llm", "provider": "mock", "options": {"PATH": "x"}}
    )
    assert response.status_code == 400


def test_websocket_chat_round_trip(client):
    with client.websocket_connect("/ws") as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello" and hello["engines"]["tts"]["id"] == "formant"
        ws.send_json({"type": "chat", "text": "ciao"})
        seen = []
        for _ in range(200):
            message = ws.receive_json()
            seen.append(message["type"])
            if message["type"] == "state" and message["value"] == "idle":
                break
        assert "speech" in seen and "reply" in seen


def test_openclaw_health_does_not_hang_when_the_gateway_is_off():
    client = OpenClawClient("http://127.0.0.1:9", token="x")
    started = time.perf_counter()
    result = asyncio.run(client.health())
    assert time.perf_counter() - started < 5.0
    assert result["ok"] is False and result["error"]


def test_save_dotenv_preserves_comments(tmp_path):
    path = tmp_path / ".env"
    path.write_text("# commento\nDC_A=1\nDC_B=2\n", encoding="utf-8")
    save_dotenv({"DC_A": "", "DC_B": "3", "DC_C": "4"}, path)
    text = path.read_text(encoding="utf-8")
    assert "# commento" in text and "DC_A" not in text
    assert "DC_B=3" in text and "DC_C=4" in text
