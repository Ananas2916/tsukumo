"""Notifications from Claude Code and Codex: hooks, connection, what she says."""

import json
import subprocess
import sys
import time

import pytest

from backend import notify, server
from backend.context import PCContext

sys.path.insert(0, str(notify.ROOT / "scripts"))
import tsukumo_notify  # noqa: E402


def test_summary_and_announcement():
    message = "Ho sistemato il bug in `server.py`. Poi ho aggiunto i test.\n```py\nx = 1\n```"
    assert notify.summary_of(message) == "Ho sistemato il bug in server.py."
    assert notify.announcement("claude", "done", "Fatto.", "it", brief=False) == "Claude Code ha finito: Fatto."
    assert notify.announcement("codex", "done", "", "en", brief=False) == "Codex is done!"
    assert notify.announcement("claude", "waiting", "Serve un permesso", "it", brief=False).startswith("Claude Code ti sta aspettando")


def test_claude_hooks_install_and_uninstall_keep_other_settings(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"model": "opus", "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "echo mio"}]}]}}))
    assert notify.install_claude(path) == "connected"
    assert notify.install_claude(path) == "already connected"
    data = json.loads(path.read_text())
    assert data["model"] == "opus" and len(data["hooks"]["Stop"]) == 2 and "Notification" in data["hooks"]
    ours = data["hooks"]["Stop"][1]["hooks"][0]
    assert ours["command"].endswith("python.exe") or "python" in ours["command"]
    assert ours["args"][-1] == "claude" and ours["args"][0].endswith("tsukumo_notify.py")
    assert (tmp_path / "settings.json.tsukumo-bak").is_file()
    assert notify.uninstall_claude(path) == "disconnected"
    data = json.loads(path.read_text())
    assert data["hooks"] == {"Stop": [{"hooks": [{"type": "command", "command": "echo mio"}]}]}


def test_codex_notify_install_refuses_to_overwrite(tmp_path):
    path = tmp_path / "config.toml"
    path.write_text('model = "o4"\n\n[profiles.x]\nmodel = "y"\n')
    assert notify.install_codex(path) == "connected"
    text = path.read_text()
    assert text.index("notify =") < text.index("[profiles.x]") and "tsukumo_notify.py" in text
    assert notify.install_codex(path) == "already connected"
    assert notify.uninstall_codex(path) == "disconnected"
    assert path.read_text() == 'model = "o4"\n\n[profiles.x]\nmodel = "y"\n'
    path.write_text('notify = ["mio-programma"]\n')
    with pytest.raises(ValueError):
        notify.install_codex(path)


def test_hook_reads_the_last_claude_message(tmp_path):
    transcript = tmp_path / "t.jsonl"
    transcript.write_text(
        "\n".join(
            json.dumps(entry)
            for entry in [
                {"type": "user", "message": {"content": "ciao"}},
                {"type": "assistant", "message": {"content": [{"type": "text", "text": "Prima risposta."}]}},
                {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash"}]}},
                {"type": "assistant", "message": {"content": [{"type": "text", "text": "Ho finito il refactoring."}]}},
            ]
        ),
        encoding="utf-8",
    )
    body = tsukumo_notify.from_claude({"hook_event_name": "Stop", "transcript_path": str(transcript)})
    assert body == {"source": "claude", "session": "", "project": "", "kind": "done", "message": "Ho finito il refactoring."}
    assert tsukumo_notify.from_claude({"hook_event_name": "Stop", "stop_hook_active": True}) is None
    waiting = tsukumo_notify.from_claude(
        {"hook_event_name": "Notification", "notification_type": "permission_prompt", "message": "Claude needs your permission"}
    )
    assert waiting["kind"] == "waiting"
    assert tsukumo_notify.from_claude({"hook_event_name": "Notification", "notification_type": "idle_prompt"}) is None
    direct = tsukumo_notify.from_claude({"hook_event_name": "Stop", "last_assistant_message": "Tutto fatto."})
    assert direct["message"] == "Tutto fatto."
    codex = tsukumo_notify.from_codex({"type": "agent-turn-complete", "last-assistant-message": "Done!"})
    assert codex == {"source": "codex", "session": "", "project": "", "kind": "done", "message": "Done!"}


def test_hook_exits_at_once_when_tsukumo_is_off_or_it_is_our_own_agent(tmp_path):
    script = str(notify.SCRIPT)
    env = {"DC_STATE_DIR": str(tmp_path), "PATH": ""}
    started = time.perf_counter()
    done = subprocess.run([sys.executable, script, "claude"], input='{"hook_event_name": "Stop"}', env=env, capture_output=True, text=True, timeout=10)
    assert done.returncode == 0 and time.perf_counter() - started < 3
    internal = subprocess.run([sys.executable, script, "codex", "{}"], env={**env, "TSUKUMO_INTERNAL": "1"}, timeout=10)
    assert internal.returncode == 0


@pytest.fixture
def notices(client, monkeypatch):
    sent = []

    async def record(message):
        sent.append(message)

    monkeypatch.setattr(server.hub, "broadcast", record)
    monkeypatch.setattr(server, "PC", PCContext())
    monkeypatch.setattr(server, "_last_notice", {"at": 0.0})
    monkeypatch.setattr(server.app.state.companion, "history", [])
    return sent


def _wait(sent, kind, timeout=3.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        found = [m for m in sent if m["type"] == kind]
        if found:
            return found
        time.sleep(0.02)
    return []


def test_she_speaks_when_you_are_elsewhere(client, notices):
    server.PC.update(40, False, {"title": "Video - YouTube - Google Chrome", "exe": "chrome.exe"})
    reply = client.post("/api/notify", json={"source": "claude", "message": "Ho aggiunto i test. Tutti verdi."}).json()
    assert reply == {"ok": True, "spoken": True}
    [notice] = [m for m in notices if m["type"] == "notify"]
    assert notice["title"] == "Claude Code" and notice["message"] == "Ho aggiunto i test." and not notice["quiet"]
    [spoken] = _wait(notices, "reply")
    assert "Claude Code" in spoken["text"] and "Ho aggiunto i test." in spoken["text"]


def test_only_a_bubble_while_you_are_watching_the_editor(client, notices):
    server.PC.update(3, False, {"title": "x - Visual Studio Code", "exe": "Code.exe"})
    assert client.post("/api/notify", json={"source": "codex", "message": "Fatto"}).json()["spoken"] is False
    assert [m["quiet"] for m in notices if m["type"] == "notify"] == [True]


def test_integrations_endpoint_uses_the_real_files_only_on_request(client, monkeypatch, tmp_path):
    monkeypatch.setattr(notify, "claude_settings_path", lambda: tmp_path / ".claude" / "settings.json")
    monkeypatch.setattr(notify, "codex_config_path", lambda: tmp_path / ".codex" / "config.toml")
    status = client.get("/api/integrations").json()
    assert status["claude"]["installed"] is False and status["codex"]["installed"] is False
    done = client.post("/api/integrations", json={"tool": "claude", "action": "install"}).json()
    assert done["ok"] and done["status"]["claude"]["installed"] is True
    assert client.post("/api/integrations", json={"tool": "x", "action": "install"}).status_code == 400
