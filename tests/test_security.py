"""The defences of backend/security.py, tried as an attacker would try them."""

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
# The real server, from the PC (conftest's ``client`` fixture)
# ---------------------------------------------------------------------------
def test_websocket_from_another_site_is_refused(client):
    with pytest.raises(WebSocketDisconnect) as refused:
        with client.websocket_connect("/ws", headers={"Origin": EVIL}) as ws:
            ws.receive_json()
    assert refused.value.code == 1008


def test_websocket_with_null_origin_is_refused(client):
    # sandboxed iframe, file://, data: -> "Origin: null"
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws", headers={"Origin": "null"}) as ws:
            ws.receive_json()


def test_websocket_from_the_app_itself_is_accepted(client):
    with client.websocket_connect("/ws", headers={"Origin": SAME}) as ws:
        assert ws.receive_json()["type"] == "hello"


def test_dns_rebinding_host_is_refused(client):
    # A domain resolving to 127.0.0.1 carries its name in the Host header.
    response = client.get("/api/memory", headers={"Host": "rebind.sito-malevolo.example:8770"})
    assert response.status_code == 421


def test_post_from_another_site_is_refused(client):
    response = client.post("/api/cancel", headers={"Origin": EVIL})
    assert response.status_code == 403
    assert client.post("/api/cancel", headers={"Origin": SAME}).status_code == 200
    # Claude Code's hooks, curl, the Electron shell: no Origin, from the PC.
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
    # Not "no-referrer": it would make POST forms send "Origin: null".
    assert response.headers["referrer-policy"] == "same-origin"


def test_qr_page_opens_from_a_link_elsewhere(client, monkeypatch):
    from backend import phone

    async def no_tailscale(port):
        return phone.Tailscale()

    monkeypatch.setattr(phone, "tailscale_status", no_tailscale)
    # A link to the QR page clicked on GitHub or in a chat: cross-site navigation.
    navigation = {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"}
    assert client.get("/api/phone", headers=navigation).status_code == 200
    # The other APIs stay closed to other sites, and so does the "Turn on" button.
    assert client.get("/api/memory", headers=navigation).status_code == 403
    assert client.post("/api/phone/serve", headers={"Origin": "https://sito-malevolo.example"}).status_code == 403


def test_html_pages_get_a_content_security_policy(client):
    policy = client.get("/").headers.get("content-security-policy", "")
    assert "script-src 'self'" in policy
    assert "frame-ancestors 'none'" in policy
    assert "ws://127.0.0.1:8770" in policy


def test_oversized_json_is_refused(client):
    response = client.post("/api/preferences", content=b"{" + b" " * (2 * 1024 * 1024) + b"}", headers={"Content-Type": "application/json"})
    assert response.status_code == 413


def test_oversized_body_without_length_is_refused(client):
    # "chunked" transfer: no Content-Length to check in advance.
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
# From another device (local network, proxy): a miniature app
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


def test_engine_check_and_options_are_off_limits_from_another_device(lan_policy):
    # With the token, a phone could otherwise point CLAUDE_CODE_COMMAND at any
    # file and have "check" run it, or rewrite an inactive engine in .env.
    client = _lan_client(lan_policy)
    headers = {"Authorization": f"Bearer {lan_policy.token}"}
    for path in ("/api/providers/check", "/api/providers/options"):
        assert client.post(path, headers=headers, json={}).status_code == 403, path


def test_remote_websocket_with_token(lan_policy):
    client = _lan_client(lan_policy)
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("ws://192.168.1.10:8770/ws") as ws:
            ws.receive_json()
    with client.websocket_connect(f"ws://192.168.1.10:8770/ws?tsukumo_token={lan_policy.token}") as ws:
        assert ws.receive_json() == {"remote": True}


def test_a_local_proxy_is_not_the_pc(tmp_path):
    # tailscale serve / a reverse proxy: it comes from 127.0.0.1 but on behalf of others.
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
# The rules alone
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
    # "Check" runs the engine's program, "options" writes .env.
    assert local_only("POST", "/api/providers/check")
    assert local_only("POST", "/api/providers/options")
    assert not local_only("POST", "/api/attachments")
    # The island's player presses keys on the PC: only from it.
    assert local_only("POST", "/api/music/control")
    # The QR with the token and the button that launches tailscale serve: only from the PC.
    assert local_only("GET", "/api/phone")
    assert local_only("POST", "/api/phone/serve")
    assert not local_only("POST", "/api/phone/session")
    # The park shows the other programs' sessions and who wrote to whom: not to the phone.
    assert local_only("GET", "/api/park")


# The phone page's shell: the only thing that opens from afar without a token.
def test_public_shell_rules():
    assert public_shell("GET", "/mobile.html")
    assert public_shell("HEAD", "/assets/mobile-abc.css")
    assert not public_shell("POST", "/mobile.html")
    assert not public_shell("GET", "/assets/")
    assert not public_shell("GET", "/assets/../panel.html")
    assert not public_shell("GET", "/assets/sub/file.js")
    assert not public_shell("GET", "/assets\\..\\panel.html")
    assert not public_shell("GET", "/panel.html")
    assert not public_shell("GET", "/dashboard.html")


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


# ---------------------------------------------------------------------------
# The brain from the phone: the one engine change open to remote clients
# ---------------------------------------------------------------------------
@pytest.fixture
def phone_brain(client, monkeypatch):
    """The real server seen from the phone through ``tailscale serve``, with a fake switch."""
    import dataclasses

    from backend import server

    monkeypatch.setattr(server, "DETECTED", {"claude_code": {"found": True}, "ollama": {"found": True}})
    # Nothing saved: the developer's .env may hold models and keys of its own.
    monkeypatch.setattr(server, "SETTINGS", dataclasses.replace(server.SETTINGS, provider_options={}))
    switched = []

    async def fake_switch(request):
        switched.append(request)
        return {"ok": True, "kind": request.kind, "provider": request.provider}

    monkeypatch.setattr(server, "set_provider", fake_switch)
    headers = {
        "X-Forwarded-For": "100.101.102.103",
        "Authorization": f"Bearer {server.POLICY.token}",
    }
    return client, headers, switched


def test_phone_lists_only_brains_set_up_on_the_pc(phone_brain):
    client, headers, _ = phone_brain
    assert client.get("/api/brain", headers={"X-Forwarded-For": "100.101.102.103"}).status_code == 401
    data = client.get("/api/brain", headers=headers).json()
    ids = {choice["id"] for choice in data["choices"]}
    assert data["active"] == "mock"
    assert {"mock", "claude_code", "ollama"} <= ids
    # Not found on the PC, no key saved: not offered.
    assert "codex" not in ids and "anthropic" not in ids
    claude = next(c for c in data["choices"] if c["id"] == "claude_code")
    assert {"value": "sonnet", "label": "Sonnet — balanced"} in claude["models"]
    assert not claude["free_model"]


def test_phone_switches_brain_and_model(phone_brain):
    client, headers, switched = phone_brain
    response = client.post("/api/brain", headers=headers, json={"provider": "claude_code", "model": "sonnet"})
    assert response.status_code == 200 and response.json()["ok"]
    assert switched[-1].kind == "llm" and switched[-1].provider == "claude_code"
    assert switched[-1].options == {"CLAUDE_CODE_MODEL": "sonnet"}
    response = client.post("/api/brain", headers=headers, json={"provider": "ollama", "model": "llama3.1:8b"})
    assert response.status_code == 200
    assert switched[-1].options == {"OLLAMA_MODEL": "llama3.1:8b"}


def test_phone_cannot_reach_beyond_the_brain(phone_brain):
    client, headers, switched = phone_brain
    refused = [
        # Not set up on the PC.
        {"provider": "codex"},
        # Only the menu's models for a select field: a permission isn't a model.
        {"provider": "claude_code", "model": "bypassPermissions"},
        # A free model name can't smuggle anything.
        {"provider": "ollama", "model": "llama3 --dangerously-skip-permissions"},
        {"provider": "ollama", "model": "a\nDC_CLAUDE_CODE_COMMAND=calc"},
    ]
    for body in refused:
        assert client.post("/api/brain", headers=headers, json=body).status_code == 400, body
    # Keys, commands and permissions aren't fields of this request at all.
    extra = {"provider": "claude_code", "options": {"CLAUDE_CODE_PERMISSION": "bypassPermissions"}}
    assert client.post("/api/brain", headers=headers, json=extra).status_code == 422
    assert switched == []
    # The full engine change stays on the PC.
    assert client.post("/api/providers", headers=headers, json={}).status_code == 403
    assert not local_only("POST", "/api/brain")


# ---------------------------------------------------------------------------
# Permission requests from the phone: allow or deny, the exact request only
# ---------------------------------------------------------------------------
@pytest.fixture
def waiting_request(client, monkeypatch):
    """A Claude Code permission request waiting on the PC, and what was broadcast."""
    import threading

    from backend import server

    sent = []

    async def record(message, voice_to=None):
        sent.append(message)

    monkeypatch.setattr(server.hub, "broadcast", record)
    answers = {}

    def ask():
        answers["reply"] = client.post("/api/approvals", json={"tool": "Bash", "input": {"command": "npm  run deploy"}}).json()

    thread = threading.Thread(target=ask)
    thread.start()
    pending = []
    for _ in range(100):
        pending = client.get("/api/approvals").json()["approvals"]
        if pending:
            break
        threading.Event().wait(0.02)
    assert pending
    phone = {"X-Forwarded-For": "100.101.102.103", "Authorization": f"Bearer {server.POLICY.token}"}
    yield pending[0], phone, answers, sent
    # Whatever the test did, nobody stays waiting.
    server.APPROVALS.decide(pending[0]["id"], "deny")
    thread.join(5)


def test_phone_allows_the_request_it_was_shown(client, waiting_request):
    item, phone, answers, sent = waiting_request
    path = f"/api/phone/approvals/{item['id']}"
    # The phone saw it come by: the "ask" broadcast reaches every client.
    assert any(m.get("event") == "ask" and m["approval"]["id"] == item["id"] for m in sent)
    assert client.post(path, json={"decision": "allow", "summary": "npm run deploy"}, headers={"X-Forwarded-For": "100.101.102.103"}).status_code == 401
    assert client.post(path, headers=phone, json={"decision": "allow", "summary": "npm run deploy"}).status_code == 200
    for _ in range(100):
        if "reply" in answers:
            break
        threading_wait(0.02)
    assert answers["reply"] == {"decision": "allow"}
    closed = [m for m in sent if m.get("event") == "closed"]
    assert closed[-1]["by"] == "phone" and closed[-1]["decision"] == "allow"
    # Answered: a second answer finds nothing.
    assert client.post(path, headers=phone, json={"decision": "deny", "summary": "npm run deploy"}).status_code == 404


def test_phone_cannot_say_always_or_answer_another_command(client, waiting_request):
    item, phone, answers, _ = waiting_request
    path = f"/api/phone/approvals/{item['id']}"
    # "Always" outlives the request: PC only.
    assert client.post(path, headers=phone, json={"decision": "always", "summary": item["summary"]}).status_code == 422
    # An answer bound to another command (a newer request with the same id can't take it).
    assert client.post(path, headers=phone, json={"decision": "allow", "summary": "rm -rf /"}).status_code == 409
    assert client.post(path, headers=phone, json={"decision": "allow"}).status_code == 422
    # The PC's own endpoints stay closed to the phone.
    assert client.post(f"/api/approvals/{item['id']}", headers=phone, json={"decision": "allow"}).status_code == 403
    assert client.get("/api/approvals", headers=phone).status_code == 403
    assert client.post("/api/phone/approvals/nope", headers=phone, json={"decision": "allow", "summary": "x"}).status_code == 404
    assert "reply" not in answers


def test_only_the_phone_answer_path_is_open_from_afar():
    assert not local_only("POST", "/api/phone/approvals/abc")
    assert local_only("POST", "/api/approvals/abc")
    assert local_only("POST", "/api/approvals")
    assert local_only("GET", "/api/approvals")


def threading_wait(seconds: float) -> None:
    import threading

    threading.Event().wait(seconds)
