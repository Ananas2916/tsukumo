"""Le difese di backend/security.py, provate come le proverebbe un attaccante."""

from __future__ import annotations

import pytest
from fastapi import FastAPI, Request, WebSocket
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend.config import save_dotenv
from backend.security import (
    AccessPolicy,
    SecurityMiddleware,
    clean_env_value,
    is_loopback,
    local_only,
    public_shell,
    within,
)

EVIL = "https://sito-malevolo.example"
SAME = "http://127.0.0.1:8770"


# ---------------------------------------------------------------------------
# Il server vero, dal PC (fixture ``client`` di conftest)
# ---------------------------------------------------------------------------
def test_websocket_from_another_site_is_refused(client):
    with pytest.raises(WebSocketDisconnect) as refused:
        with client.websocket_connect("/ws", headers={"Origin": EVIL}) as ws:
            ws.receive_json()
    assert refused.value.code == 1008


def test_websocket_with_null_origin_is_refused(client):
    # iframe in sandbox, file://, data: -> "Origin: null"
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws", headers={"Origin": "null"}) as ws:
            ws.receive_json()


def test_websocket_from_the_app_itself_is_accepted(client):
    with client.websocket_connect("/ws", headers={"Origin": SAME}) as ws:
        assert ws.receive_json()["type"] == "hello"


def test_dns_rebinding_host_is_refused(client):
    # Un dominio che si risolve in 127.0.0.1 porta il suo nome nell'header Host.
    response = client.get("/api/memory", headers={"Host": "rebind.sito-malevolo.example:8770"})
    assert response.status_code == 421


def test_post_from_another_site_is_refused(client):
    response = client.post("/api/cancel", headers={"Origin": EVIL})
    assert response.status_code == 403
    assert client.post("/api/cancel", headers={"Origin": SAME}).status_code == 200
    # Gli hook di Claude Code, curl, la shell Electron: niente Origin, dal PC.
    assert client.post("/api/cancel").status_code == 200


def test_cross_site_reads_are_refused(client):
    response = client.get("/api/memory", headers={"Sec-Fetch-Site": "cross-site"})
    assert response.status_code == 403


def test_spotify_callback_may_come_from_spotify(client):
    response = client.get(
        "/api/music/spotify/callback?error=access_denied",
        headers={"Sec-Fetch-Site": "cross-site"},
    )
    assert response.status_code == 200
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]


def test_security_headers(client):
    response = client.get("/api/health")
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["referrer-policy"] == "no-referrer"


def test_html_pages_get_a_content_security_policy(client):
    policy = client.get("/").headers.get("content-security-policy", "")
    assert "script-src 'self'" in policy
    assert "frame-ancestors 'none'" in policy
    assert "ws://127.0.0.1:8770" in policy


def test_oversized_json_is_refused(client):
    response = client.post("/api/preferences", content=b"{" + b" " * (2 * 1024 * 1024) + b"}", headers={"Content-Type": "application/json"})
    assert response.status_code == 413


def test_oversized_body_without_length_is_refused(client):
    # Trasferimento "chunked": nessun Content-Length da controllare in anticipo.
    def chunks():
        for _ in range(40):
            yield b"x" * (1024 * 1024)

    response = client.post("/api/attachments?name=grande.bin", content=chunks())
    assert response.status_code == 413


def test_env_newline_injection_is_refused(client):
    response = client.post(
        "/api/providers/options",
        json={"kind": "llm", "provider": "openrouter", "options": {"OPENROUTER_MODEL": "x\nDC_CLAUDE_CODE_PERMISSION=bypassPermissions"}},
    )
    assert response.status_code == 400


def test_save_dotenv_refuses_newlines_and_odd_keys(tmp_path):
    path = tmp_path / ".env"
    with pytest.raises(ValueError):
        save_dotenv({"DC_A": "uno\nDC_B=due"}, path)
    with pytest.raises(ValueError):
        save_dotenv({"PATH": "C:/evil"}, path)
    assert not path.exists()


# ---------------------------------------------------------------------------
# Da un altro dispositivo (rete locale, proxy): app in miniatura
# ---------------------------------------------------------------------------
def _mini_app(policy: AccessPolicy) -> FastAPI:
    app = FastAPI()

    @app.get("/api/memory")
    async def memory() -> dict:
        return {"ok": True}

    @app.post("/api/providers")
    async def providers() -> dict:
        return {"ok": True}

    @app.post("/api/attachments")
    async def attachments(request: Request) -> dict:
        return {"size": len(await request.body())}

    @app.websocket("/ws")
    async def ws(websocket: WebSocket) -> None:
        await websocket.accept()
        await websocket.send_json({"remote": websocket.scope.get("tsukumo.remote")})
        await websocket.close()

    app.add_middleware(SecurityMiddleware, policy=policy)
    return app


@pytest.fixture
def lan_policy(tmp_path):
    return AccessPolicy(bind_host="0.0.0.0", token_path=tmp_path / "access_token")


def _lan_client(policy: AccessPolicy) -> TestClient:
    return TestClient(_mini_app(policy), base_url="http://192.168.1.10:8770", client=("192.168.1.20", 50000))


def test_another_device_needs_the_token(lan_policy):
    client = _lan_client(lan_policy)
    assert client.get("/api/memory").status_code == 401
    assert client.get("/api/memory", headers={"Authorization": "Bearer sbagliato"}).status_code == 401
    ok = client.get("/api/memory", headers={"Authorization": f"Bearer {lan_policy.token}"})
    assert ok.status_code == 200


def test_settings_are_off_limits_from_another_device(lan_policy):
    client = _lan_client(lan_policy)
    response = client.post("/api/providers", headers={"Authorization": f"Bearer {lan_policy.token}"})
    assert response.status_code == 403


def test_remote_websocket_with_token(lan_policy):
    client = _lan_client(lan_policy)
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("ws://192.168.1.10:8770/ws") as ws:
            ws.receive_json()
    with client.websocket_connect(f"ws://192.168.1.10:8770/ws?tsukumo_token={lan_policy.token}") as ws:
        assert ws.receive_json() == {"remote": True}


def test_a_local_proxy_is_not_the_pc(tmp_path):
    # tailscale serve / un reverse proxy: arriva da 127.0.0.1 ma per conto d'altri.
    policy = AccessPolicy(token_path=tmp_path / "access_token")
    client = TestClient(_mini_app(policy), base_url="http://127.0.0.1:8770", client=("127.0.0.1", 50000))
    assert client.get("/api/memory").status_code == 200
    assert client.get("/api/memory", headers={"X-Forwarded-For": "100.64.0.7"}).status_code == 401
    assert client.get("/api/memory", headers={"Tailscale-User-Login": "chi@example.com"}).status_code == 401


def test_lan_names_are_refused_when_bound_to_loopback(tmp_path):
    policy = AccessPolicy(token_path=tmp_path / "access_token")
    client = TestClient(_mini_app(policy), base_url="http://192.168.1.10:8770", client=("192.168.1.20", 50000))
    response = client.get("/api/memory", headers={"Authorization": f"Bearer {policy.token}"})
    assert response.status_code == 421


# ---------------------------------------------------------------------------
# Le regole da sole
# ---------------------------------------------------------------------------
def test_token_is_long_random_and_persistent(tmp_path):
    path = tmp_path / "access_token"
    first = AccessPolicy(token_path=path).token
    assert len(first) >= 40
    assert AccessPolicy(token_path=path).token == first
    path.write_text("corto", encoding="utf-8")
    assert AccessPolicy(token_path=path).token != "corto"


def test_origin_rules():
    policy = AccessPolicy(extra_origins=frozenset({"http://localhost:5173"}))
    assert policy.origin_allowed("http://127.0.0.1:8770", "127.0.0.1:8770")
    assert policy.origin_allowed("http://localhost:5173", "127.0.0.1:8770")
    assert not policy.origin_allowed("http://127.0.0.1:3000", "127.0.0.1:8770")
    assert not policy.origin_allowed("null", "127.0.0.1:8770")
    assert not policy.origin_allowed("file://", "127.0.0.1:8770")


def test_loopback_names():
    assert is_loopback("127.0.0.1:8770")
    assert is_loopback("[::1]:8770")
    assert is_loopback("LOCALHOST")
    assert not is_loopback("localhost.sito-malevolo.example")
    assert not is_loopback("192.168.1.10:8770")


def test_local_only_paths():
    assert local_only("POST", "/api/providers")
    assert local_only("POST", "/api/setup/listening")
    assert local_only("DELETE", "/api/voices/abc")
    assert not local_only("GET", "/api/providers")
    assert not local_only("POST", "/api/attachments")
    # Il QR col token e il pulsante che lancia tailscale serve: solo dal PC.
    assert local_only("GET", "/api/phone")
    assert local_only("POST", "/api/phone/serve")
    assert not local_only("POST", "/api/phone/session")


# Il guscio della pagina del telefono: l'unica cosa che da fuori si apre senza token.
def test_public_shell_rules():
    assert public_shell("GET", "/mobile.html")
    assert public_shell("HEAD", "/assets/mobile-abc.css")
    assert not public_shell("POST", "/mobile.html")
    assert not public_shell("GET", "/assets/")
    assert not public_shell("GET", "/assets/../panel.html")
    assert not public_shell("GET", "/assets/sub/file.js")
    assert not public_shell("GET", "/assets\\..\\panel.html")
    assert not public_shell("GET", "/panel.html")
    assert not public_shell("GET", "/models/avatar.vrm")


def test_clean_env_value():
    assert clean_env_value("  modello  ") == "modello"
    for bad in ("a\nb", "a\rb", "a\x00b", "a\x1bb"):
        with pytest.raises(ValueError):
            clean_env_value(bad)


def test_within(tmp_path):
    uploads = tmp_path / "uploads"
    (uploads / "abc").mkdir(parents=True)
    inside = uploads / "abc" / "foto.png"
    inside.write_bytes(b"x")
    assert within(inside, [uploads])
    assert not within(uploads / ".." / "segreti.txt", [uploads])
    assert not within(tmp_path / "altro.txt", [uploads])


def test_agent_permissions_only_from_the_menu(client):
    response = client.post(
        "/api/providers/options",
        json={"kind": "llm", "provider": "claude_code", "options": {"CLAUDE_CODE_PERMISSION": "bypassPermissions"}},
    )
    assert response.status_code == 400
