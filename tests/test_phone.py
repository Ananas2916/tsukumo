"""Tsukumo on the phone: Tailscale, the QR, the text-only page (backend/phone.py)."""

from __future__ import annotations

import asyncio
import json

import pytest
from fastapi import FastAPI, WebSocket
from fastapi.responses import HTMLResponse
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend import phone
from backend.security import AccessPolicy, SecurityMiddleware

HOST = "pc.tail1234.ts.net"
#: How a request arrives from ``tailscale serve``: from 127.0.0.1, on behalf of the phone.
VIA_TAILSCALE = {"X-Forwarded-For": "100.101.102.103", "Tailscale-User-Login": "io@example.com"}


def _mini_app(policy: AccessPolicy) -> FastAPI:
    app = FastAPI()

    @app.get("/mobile.html", response_class=HTMLResponse)
    async def page() -> str:
        return "<p>guscio</p>"

    @app.get("/assets/{name}")
    async def asset(name: str) -> dict:
        return {"asset": name}

    @app.get("/panel.html", response_class=HTMLResponse)
    async def panel() -> str:
        return "<p>pannello</p>"

    @app.get("/api/memory")
    async def memory() -> dict:
        return {"ok": True}

    @app.websocket("/ws")
    async def ws(websocket: WebSocket) -> None:
        await websocket.accept()
        await websocket.send_json({"remote": websocket.scope.get("tsukumo.remote")})
        await websocket.close()

    app.add_middleware(SecurityMiddleware, policy=policy)
    return app


@pytest.fixture
def policy(tmp_path):
    return AccessPolicy(
        extra_hosts=frozenset({HOST}),
        extra_origins=frozenset({f"https://{HOST}"}),
        token_path=tmp_path / "access_token",
    )


def _phone(policy: AccessPolicy) -> TestClient:
    return TestClient(_mini_app(policy), base_url=f"https://{HOST}", client=("127.0.0.1", 50000), headers=VIA_TAILSCALE)


# ---------------------------------------------------------------------------
# The shell without a token, everything else with the token
# ---------------------------------------------------------------------------
def test_the_page_shell_loads_without_the_token(policy):
    client = _phone(policy)
    assert client.get("/mobile.html").status_code == 200
    assert client.get("/assets/mobile-abc123.js").status_code == 200


def test_everything_else_still_needs_the_token(policy):
    client = _phone(policy)
    assert client.get("/panel.html").status_code == 401
    assert client.get("/api/memory").status_code == 401
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"wss://{HOST}/ws") as ws:
            ws.receive_json()
    ok = client.get("/api/memory", headers={"Authorization": f"Bearer {policy.token}"})
    assert ok.status_code == 200


def test_the_cookie_opens_the_websocket(policy):
    client = _phone(policy)
    client.cookies.set("tsukumo_token", policy.token)
    with client.websocket_connect(f"wss://{HOST}/ws", headers={"Origin": f"https://{HOST}"}) as ws:
        assert ws.receive_json() == {"remote": True}


# ---------------------------------------------------------------------------
# Tailscale, with a fake CLI
# ---------------------------------------------------------------------------
def _fake_cli(monkeypatch, status: dict, serve: dict | None = None) -> list[tuple[str, ...]]:
    calls: list[tuple[str, ...]] = []

    async def run(cli, *args, timeout=8.0):
        calls.append(args)
        if args[:2] == ("status", "--json"):
            return 0, json.dumps(status)
        if args[:3] == ("serve", "status", "--json"):
            return 0, json.dumps(serve or {})
        return 0, ""

    monkeypatch.setattr(phone, "tailscale_cli", lambda: "tailscale")
    monkeypatch.setattr(phone, "_run", run)
    return calls


def test_tailscale_missing(monkeypatch):
    monkeypatch.setattr(phone, "tailscale_cli", lambda: None)
    info = asyncio.run(phone.tailscale_status(8770))
    assert not info.installed
    assert "installa" in phone.render_page(info, "segreto").lower()


def test_tailscale_logged_out(monkeypatch):
    _fake_cli(monkeypatch, {"BackendState": "NeedsLogin"})
    info = asyncio.run(phone.tailscale_status(8770))
    assert info.installed and not info.running
    assert "segreto" not in phone.render_page(info, "segreto")


def test_tailscale_running_but_not_serving(monkeypatch):
    _fake_cli(monkeypatch, {"BackendState": "Running", "Self": {"DNSName": f"{HOST}."}})
    info = asyncio.run(phone.tailscale_status(8770))
    assert info.hostname == HOST and not info.serving
    page = phone.render_page(info, "segreto")
    assert 'action="/api/phone/serve"' in page
    assert "segreto" not in page


def test_tailscale_serving_shows_the_qr(monkeypatch):
    serve = {"Web": {f"{HOST}:443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:8770"}}}}}
    _fake_cli(monkeypatch, {"BackendState": "Running", "Self": {"DNSName": f"{HOST}."}}, serve)
    info = asyncio.run(phone.tailscale_status(8770))
    assert info.serving and not info.funnel
    page = phone.render_page(info, "segreto")
    assert "<svg" in page
    assert "Funnel" not in page
    # Another port isn't our backend.
    assert not asyncio.run(phone.tailscale_status(8771)).serving


def test_funnel_is_pointed_out(monkeypatch):
    serve = {
        "Web": {f"{HOST}:443": {"Handlers": {"/": {"Proxy": "http://localhost:8770"}}}},
        "AllowFunnel": {f"{HOST}:443": True},
    }
    _fake_cli(monkeypatch, {"BackendState": "Running", "Self": {"DNSName": f"{HOST}."}}, serve)
    info = asyncio.run(phone.tailscale_status(8770))
    assert info.serving and info.funnel
    assert "Funnel" in phone.render_page(info, "segreto")


def test_serve_asks_to_enable_https(monkeypatch):
    async def run(cli, *args, timeout=8.0):
        return -1, "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n  https://login.tailscale.com/f/serve?node=abc\n"

    monkeypatch.setattr(phone, "tailscale_cli", lambda: "tailscale")
    monkeypatch.setattr(phone, "_run", run)
    ok, message = asyncio.run(phone.start_serve(8770))
    assert not ok
    assert "https://login.tailscale.com/f/serve?node=abc" in message
    page = phone.render_page(phone.Tailscale(installed=True, running=True, hostname=HOST), "x", message)
    assert '<a href="https://login.tailscale.com/f/serve?node=abc"' in page


def test_messages_are_escaped():
    page = phone.render_page(phone.Tailscale(installed=True, running=True, hostname=HOST), "x", "<script>x</script>")
    assert "<script>" not in page


def test_link_keeps_the_token_after_the_hash():
    link = phone.phone_link(HOST, "abc")
    assert link == f"https://{HOST}/mobile.html#t=abc"
    assert "<svg" in phone.qr_svg(link)


# ---------------------------------------------------------------------------
# The real server
# ---------------------------------------------------------------------------
@pytest.fixture
def tailscale_serving(monkeypatch):
    info = phone.Tailscale(installed=True, running=True, hostname=HOST, serving=True)

    async def status(port):
        return info

    monkeypatch.setattr(phone, "tailscale_status", status)
    return info


@pytest.fixture
def phone_client(client, tailscale_serving, monkeypatch):
    """The phone through ``tailscale serve``, on the same backend as the ``client`` fixture."""
    from backend import server

    monkeypatch.setattr(server, "POLICY", server.POLICY)  # put back at the end
    server._trust_tailscale(tailscale_serving)
    return TestClient(server.app, base_url=f"https://{HOST}", client=("127.0.0.1", 50000), headers=VIA_TAILSCALE)


def test_the_qr_page_is_only_on_the_pc(client, phone_client, tailscale_serving):
    from backend import server

    page = client.get("/api/phone")
    assert page.status_code == 200
    assert "<svg" in page.text
    assert page.headers["cache-control"] == "no-store"
    assert "frame-ancestors 'none'" in page.headers["content-security-policy"]
    token = {"Authorization": f"Bearer {server.POLICY.token}"}
    assert phone_client.get("/api/phone", headers=token).status_code == 403
    assert phone_client.post("/api/phone/serve", headers={**token, "Origin": f"https://{HOST}"}).status_code == 403


def test_serve_button_needs_the_same_origin(client, tailscale_serving, monkeypatch):
    async def start(port):
        return True, ""

    monkeypatch.setattr(phone, "start_serve", start)
    assert client.post("/api/phone/serve", headers={"Origin": "https://sito-malevolo.example"}).status_code == 403
    done = client.post("/api/phone/serve", headers={"Origin": "http://127.0.0.1:8770"}, follow_redirects=False)
    assert done.status_code == 303 and done.headers["location"] == "/api/phone"


def test_the_phone_swaps_the_token_for_a_cookie(phone_client):
    from backend import server

    origin = {"Origin": f"https://{HOST}"}
    assert phone_client.post("/api/phone/session", headers=origin).status_code == 401
    bad = {**origin, "Authorization": "Bearer sbagliato"}
    assert phone_client.post("/api/phone/session", headers=bad).status_code == 401
    ok = phone_client.post("/api/phone/session", headers={**origin, "Authorization": f"Bearer {server.POLICY.token}"})
    assert ok.status_code == 200
    cookie = ok.headers["set-cookie"].lower()
    assert "httponly" in cookie and "secure" in cookie and "samesite=strict" in cookie
    # With the cookie the WebSocket opens, in text-only mode.
    with phone_client.websocket_connect(f"wss://{HOST}/ws?mode=text", headers=origin) as ws:
        assert ws.receive_json()["type"] == "hello"


def test_missed_replies_only_reach_a_phone_with_the_token(phone_client):
    from backend import server

    server.hub.transcript.observe({"type": "reply", "text": "Il codice e' 4417.", "turn": 1})
    with pytest.raises(WebSocketDisconnect):
        with phone_client.websocket_connect(f"wss://{HOST}/ws?mode=text") as ws:
            ws.receive_json()
    # A client without a browser: token in the header, no Origin.
    bearer = {"Authorization": f"Bearer {server.POLICY.token}"}
    with phone_client.websocket_connect(f"wss://{HOST}/ws?mode=text", headers=bearer) as ws:
        hello = ws.receive_json()
    assert hello["transcript"][-1]["text"] == "Il codice e' 4417."


def test_the_phone_page_shell_is_served(phone_client):
    # The frontend build exists only if it was made: without it, it's enough that it needs no token.
    response = phone_client.get("/mobile.html")
    assert response.status_code in (200, 404)
    assert phone_client.get("/panel.html").status_code == 401


def test_text_only_clients_get_no_audio():
    from backend.server import ConnectionHub

    class Fake:
        def __init__(self):
            self.sent = []

        async def send_json(self, message):
            self.sent.append(message)

    async def scenario():
        hub = ConnectionHub()
        pc, phone_ws = Fake(), Fake()
        await hub.add(pc)
        await hub.add(phone_ws, text_only=True)
        await hub.broadcast({"type": "speech", "text": "ciao", "audio": "UklGR...", "visemes": [1, 2]})
        await hub.broadcast({"type": "token", "text": "ci"})
        return pc.sent, phone_ws.sent

    pc_sent, phone_sent = asyncio.run(scenario())
    assert pc_sent[0]["audio"] and pc_sent[0]["visemes"]
    assert phone_sent[0] == {"type": "speech", "text": "ciao"}
    assert phone_sent[1] == pc_sent[1]


def test_the_pc_name_is_trusted_once_tailscale_connects_after_startup(monkeypatch):
    """At boot Tsukumo starts before Tailscale: it retries until the name arrives."""
    from backend import server

    answers = [
        phone.Tailscale(installed=True, detail="Tailscale e' spento o non hai fatto l'accesso."),
        phone.Tailscale(installed=True, running=True),
        phone.Tailscale(installed=True, running=True, hostname=HOST, serving=True),
    ]
    asked = []

    async def status(port):
        asked.append(port)
        return answers[min(len(asked), len(answers)) - 1]

    monkeypatch.setattr(phone, "tailscale_status", status)
    monkeypatch.setattr(server, "POLICY", server.POLICY)  # put back at the end
    assert not server.POLICY.host_allowed(HOST)
    asyncio.run(server._detect_tailscale(first_delay=0.01, max_delay=0.02))
    assert len(asked) == 3
    assert server.POLICY.host_allowed(HOST)


def test_without_tailscale_the_probe_gives_up(monkeypatch):
    from backend import server

    asked = []

    async def status(port):
        asked.append(port)
        return phone.Tailscale(detail="Tailscale non e' installato su questo PC.")

    monkeypatch.setattr(phone, "tailscale_status", status)
    asyncio.run(server._detect_tailscale(first_delay=0.01))
    assert len(asked) == 1
