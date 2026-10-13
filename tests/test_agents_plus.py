"""More agents and more of the secretary around them: hooks for Gemini CLI and
Cursor, Claude Code's permissions, the MCP server, the brains' abilities,
repeating reminders."""

from __future__ import annotations

import asyncio
import json
import sys
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

import backend.provider_specs  # noqa: F401  (registers the engines)
from backend import notify
from backend.providers import describe_all
from backend.reminders import Reminder, ReminderStore, confirmation, from_tag, next_time, parse_requests

sys.path.insert(0, str(notify.ROOT / "scripts"))
import tsukumo_mcp  # noqa: E402
import tsukumo_notify  # noqa: E402

NOW = datetime(2026, 10, 13, 12, 0)


# ---------------------------------------------------------------------------
# Reminders that repeat
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("phrase", "repeat", "due", "text", "said"),
    [
        ("ogni anno il 12 marzo ricordami del compleanno di Marco", "yearly", datetime(2027, 3, 12, 9), "del compleanno di Marco", "Va bene, ogni anno il 12 marzo ti ricordo del compleanno di Marco."),
        ("ogni lunedì alle 9 ricordami di fare la spesa", "weekly", datetime(2026, 10, 19, 9), "fare la spesa", "Va bene, ogni lunedì alle 09:00 ti ricordo di fare la spesa."),
        ("remind me every Friday at 18 to call mom", "weekly", datetime(2026, 10, 16, 18), "call mom", "Sure, every Friday at 18:00 I'll remind you to call mom."),
        ("remind me every month on the 5th at 10 to pay rent", "monthly", datetime(2026, 11, 5, 10), "pay rent", "Sure, every month on the 5th at 10:00 I'll remind you to pay rent."),
    ],
)
def test_repeating_reminders(phrase, repeat, due, text, said):
    [request] = parse_requests(phrase, NOW)
    assert (request.repeat, request.due, request.text) == (repeat, due, text)
    assert confirmation(request.to_reminder(), NOW) == said


def test_next_times_keep_the_day():
    assert next_time(datetime(2026, 1, 31, 9), "monthly") == datetime(2026, 2, 28, 9)
    assert next_time(datetime(2028, 2, 29, 9), "yearly") == datetime(2029, 2, 28, 9)
    assert next_time(datetime(2026, 10, 13, 9), "weekly") == datetime(2026, 10, 20, 9)
    store = ReminderStore(None)
    birthday = store.add(Reminder("reminder", datetime(2026, 3, 12, 9).timestamp(), "compleanno di Marco", repeat="yearly"))
    store.done(birthday, now=datetime(2026, 3, 12, 9, 0, 1).timestamp())
    assert datetime.fromtimestamp(store.get(birthday.id).due) == datetime(2027, 3, 12, 9)


def test_brain_tags_repeat_and_follow_up():
    reminder = from_tag('[[remind {"at": "2026-10-16T18:00", "text": "risposta di Marco", "repeat": "every week", "unless_reply_from": "marco@example.com"}]]', NOW)
    assert reminder.repeat == "weekly" and reminder.followup == "marco@example.com"


# ---------------------------------------------------------------------------
# Hooks: Gemini CLI, Cursor, Claude Code's permissions
# ---------------------------------------------------------------------------
def test_gemini_hooks_install_and_uninstall(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"theme": "dark", "hooks": {"AfterAgent": [{"hooks": [{"type": "command", "command": "mine.sh"}]}]}}))
    assert notify.install_gemini(path) == "connected"
    assert notify.install_gemini(path) == "already connected"
    data = json.loads(path.read_text())
    ours = data["hooks"]["AfterAgent"][1]["hooks"][0]
    assert ours["type"] == "command" and ours["command"].endswith('"gemini"') and "tsukumo_notify.py" in ours["command"]
    assert set(data["hooks"]) == {"AfterAgent", "Notification", "BeforeAgent"} and data["theme"] == "dark"
    assert notify.uninstall_gemini(path) == "disconnected"
    assert json.loads(path.read_text()) == {"theme": "dark", "hooks": {"AfterAgent": [{"hooks": [{"type": "command", "command": "mine.sh"}]}]}}


def test_cursor_hooks_install_and_uninstall(tmp_path):
    path = tmp_path / "hooks.json"
    assert notify.install_cursor(path) == "connected"
    data = json.loads(path.read_text())
    assert data["version"] == 1 and set(data["hooks"]) == {"afterAgentResponse", "beforeSubmitPrompt"}
    assert notify.uninstall_cursor(path) == "disconnected"
    assert json.loads(path.read_text()) == {"version": 1, "hooks": {}}


def test_permission_hook_is_separate_from_the_notifications(tmp_path):
    path = tmp_path / "settings.json"
    notify.install_claude(path)
    assert notify.install_approvals(path) == "connected"
    data = json.loads(path.read_text())
    [group] = data["hooks"]["PermissionRequest"]
    assert group["matcher"] == "*" and group["hooks"][0]["args"][-1] == "claude-permission"
    assert group["hooks"][0]["timeout"] > notify.APPROVAL_TIMEOUT
    notify.uninstall_claude(path)
    assert "PermissionRequest" in json.loads(path.read_text())["hooks"]
    assert notify.uninstall_approvals(path) == "disconnected"
    assert "hooks" not in json.loads(path.read_text())


def test_hook_script_reads_gemini_and_cursor():
    gemini = tsukumo_notify.from_gemini({"hook_event_name": "AfterAgent", "prompt_response": "Fatto.", "session_id": "s1", "cwd": "C:/x/web"})
    assert gemini == {"source": "gemini", "session": "s1", "project": "web", "kind": "done", "message": "Fatto."}
    assert tsukumo_notify.from_gemini({"hook_event_name": "Notification", "message": "Permission?"})["kind"] == "waiting"
    assert tsukumo_notify.from_gemini({"hook_event_name": "AfterAgent", "stop_hook_active": True}) is None
    cursor = tsukumo_notify.from_cursor({"hook_event_name": "afterAgentResponse", "text": "Done.", "conversation_id": "c1", "workspace_roots": ["/home/me/app"]})
    assert cursor == {"source": "cursor", "session": "c1", "project": "app", "kind": "done", "message": "Done."}
    assert tsukumo_notify.from_cursor({"hook_event_name": "stop"}) is None


class _Approver(BaseHTTPRequestHandler):
    decision = "allow"
    seen: list = []

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        type(self).seen.append((self.path, body))
        payload = json.dumps({"decision": type(self).decision}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


@pytest.fixture
def approver():
    server = HTTPServer(("127.0.0.1", 0), _Approver)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    _Approver.seen = []
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


@pytest.mark.parametrize(
    ("decision", "expected"),
    [
        ("allow", {"behavior": "allow"}),
        ("always", {"behavior": "allow", "updatedPermissions": [{"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "npm test"}], "behavior": "allow", "destination": "localSettings"}]}),
        ("deny", {"behavior": "deny", "message": "Denied from Tsukumo."}),
        (None, None),
    ],
)
def test_permission_answers(approver, decision, expected):
    _Approver.decision = decision
    payload = {
        "hook_event_name": "PermissionRequest",
        "tool_name": "Bash",
        "tool_input": {"command": "npm test"},
        "cwd": "C:/x/web",
        "permission_suggestions": [{"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "npm test"}], "behavior": "allow", "destination": "localSettings"}],
    }
    answer = tsukumo_notify.permission(approver, payload)
    assert _Approver.seen[-1] == ("/api/approvals", {"source": "claude", "label": "Claude Code", "tool": "Bash", "input": {"command": "npm test"}, "project": "web"})
    if expected is None:
        assert answer is None
    else:
        assert answer == {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": expected}}


# ---------------------------------------------------------------------------
# The MCP server
# ---------------------------------------------------------------------------
def test_mcp_handshake_and_tools(monkeypatch):
    reply = tsukumo_mcp.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}})
    assert reply["result"]["protocolVersion"] == "2025-03-26" and reply["result"]["capabilities"] == {"tools": {}}
    assert tsukumo_mcp.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None
    tools = tsukumo_mcp.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})["result"]["tools"]
    assert {tool["name"] for tool in tools} == {"say", "show", "remind", "add_todo", "add_note", "agenda", "presence", "search_notes"}
    assert tsukumo_mcp.handle({"jsonrpc": "2.0", "id": 3, "method": "nope"})["error"]["code"] == -32601

    calls = []

    def fake_call(method, path, body=None):
        calls.append((method, path, body))
        return {"spoken": False} if path == "/api/agent/say" else {"reminder": {"label": "Promemoria: x", "dueIso": "2026-10-13T12:30:00"}}

    monkeypatch.setattr(tsukumo_mcp, "call", fake_call)
    said = tsukumo_mcp.handle({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "say", "arguments": {"text": "Build finita"}}})
    assert "back" in said["result"]["content"][0]["text"] and not said["result"]["isError"]
    reminded = tsukumo_mcp.handle({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "remind", "arguments": {"text": "x", "in_minutes": 30}}})
    assert calls[-1] == ("POST", "/api/reminders", {"kind": "reminder", "text": "x", "seconds": 1800.0}) and not reminded["result"]["isError"]
    bad = tsukumo_mcp.handle({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "remind", "arguments": {"text": "x"}}})
    assert bad["result"]["isError"]


def test_mcp_when_tsukumo_is_off(monkeypatch):
    monkeypatch.setattr(tsukumo_mcp, "backend_url", lambda: None)
    reply = tsukumo_mcp.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "presence", "arguments": {}}})
    assert reply["result"]["isError"] and "isn't running" in reply["result"]["content"][0]["text"]


def test_mcp_install_for_codex_gemini_cursor(tmp_path, monkeypatch):
    codex = tmp_path / "config.toml"
    codex.write_text('model = "o4"\n\n[profiles.x]\nmodel = "y"\n')
    assert notify.install_mcp_codex(codex) == "connected"
    text = codex.read_text()
    assert text.index("[mcp_servers.tsukumo]") > text.index("[profiles.x]") and "tsukumo_mcp.py" in text
    assert notify.install_mcp_codex(codex) == "already connected"
    assert notify.uninstall_mcp_codex(codex) == "disconnected"
    assert codex.read_text() == 'model = "o4"\n\n[profiles.x]\nmodel = "y"\n'

    gemini = tmp_path / "settings.json"
    gemini.write_text(json.dumps({"mcpServers": {"other": {"command": "x"}}}))
    assert notify._mcp_json_install(gemini) == "connected"
    data = json.loads(gemini.read_text())
    assert set(data["mcpServers"]) == {"other", "tsukumo"} and data["mcpServers"]["tsukumo"]["args"][0].endswith("tsukumo_mcp.py")
    assert notify._mcp_json_uninstall(gemini) == "disconnected"
    assert json.loads(gemini.read_text()) == {"mcpServers": {"other": {"command": "x"}}}
    gemini.write_text(json.dumps({"mcpServers": {"tsukumo": {"command": "someone-else"}}}))
    with pytest.raises(ValueError):
        notify._mcp_json_install(gemini)


def test_claude_mcp_goes_through_its_own_command(monkeypatch, tmp_path):
    runs = []
    monkeypatch.setattr(notify, "_claude_cli", lambda: "claude")
    monkeypatch.setattr(notify, "_run", lambda command: runs.append(command) or "")
    monkeypatch.setattr(notify, "claude_user_config_path", lambda: tmp_path / ".claude.json")
    assert notify.install_mcp_claude() == "connected"
    assert runs[-1][:6] == ["claude", "mcp", "add", "--scope", "user", "tsukumo"] and runs[-1][-1].endswith("tsukumo_mcp.py")
    (tmp_path / ".claude.json").write_text(json.dumps({"mcpServers": {"tsukumo": {}}}))
    assert notify.install_mcp_claude() == "already connected"
    assert notify.uninstall_mcp_claude() == "disconnected"
    assert runs[-1] == ["claude", "mcp", "remove", "--scope", "user", "tsukumo"]


def test_integrations_status_lists_everything():
    status = notify.status()
    assert {"claude", "codex", "gemini", "cursor", "claude_approvals", "mcp_claude", "mcp_codex", "mcp_gemini", "mcp_cursor"} <= set(status)


# ---------------------------------------------------------------------------
# What each brain can do
# ---------------------------------------------------------------------------
def test_brains_declare_their_abilities():
    brains = {item["id"]: item["capabilities"] for item in describe_all()["llm"]}
    assert brains["claude_code"] == ["files", "shell", "web", "mcp", "memory"]
    assert brains["opencode"] == ["files", "shell"]
    assert brains["ollama"] == [] and brains["command"] == []
    assert all(item["capabilities"] == [] for item in describe_all()["tts"])
