"""What you've done together: the agents' logs read incrementally, her own counters."""

import asyncio
import json

from backend.notebook import Notebook
from backend.stats import Stats, claude_lines, codex_lines, count_lines, patch_lines


def test_count_lines():
    assert [count_lines(text) for text in ("", "a", "a\n", "a\nb", "a\nb\n", None, 3)] == [0, 1, 1, 2, 2, 0, 0]


def claude_record(*tools):
    return {"type": "assistant", "message": {"content": [{"type": "text", "text": "x"}, *[{"type": "tool_use", "name": n, "input": i} for n, i in tools]]}}


def test_claude_lines_from_its_file_tools():
    record = claude_record(
        ("Write", {"file_path": "a.py", "content": "one\ntwo\nthree\n"}),
        ("Edit", {"old_string": "x\ny", "new_string": "a\nb"}),
        ("MultiEdit", {"edits": [{"new_string": "1"}, {"new_string": "2\n3"}, "junk"]}),
        ("NotebookEdit", {"new_source": "print(1)"}),
        ("Read", {"file_path": "a.py"}),
        ("Bash", {"command": "echo hi\necho ho"}),
    )
    assert claude_lines(record) == 3 + 2 + 3 + 1
    assert claude_lines({"message": {"content": "text only"}}) == 0 and claude_lines({}) == 0


PATCH = "*** Begin Patch\n*** Update File: a.py\n@@\n-old\n+new one\n+new two\n context\n*** End Patch"


def test_codex_lines_from_its_patches():
    assert patch_lines(PATCH) == 2
    # Inside a string of code, the newlines are "\n" escapes.
    escaped = 'const patch = "' + PATCH.replace("\n", "\\n") + '"; apply(patch);'
    assert codex_lines({"type": "response_item", "payload": {"type": "custom_tool_call", "name": "exec", "input": escaped}}) == 2
    assert codex_lines({"payload": {"type": "function_call", "name": "apply_patch", "arguments": json.dumps({"input": PATCH})}}) == 2
    # Its echo in the output, or any other record, doesn't count twice.
    assert codex_lines({"payload": {"type": "custom_tool_call_output", "output": PATCH}}) == 0
    assert patch_lines("+++ b/file\n+x") == 0


def write_jsonl(path, records, tail=""):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record) + "\n")
        handle.write(tail)


def fake_home(tmp_path):
    home = tmp_path / "home"
    write_jsonl(home / ".claude/projects/proj/one.jsonl", [claude_record(("Write", {"content": "a\nb\n"})), {"type": "user"}])
    write_jsonl(home / ".claude/projects/proj/two.jsonl", [{"type": "user"}])
    # A subagent's transcript is part of its session, not a session of its own.
    write_jsonl(home / ".claude/projects/proj/one/subagents/agent-1.jsonl", [claude_record(("Write", {"content": "x"}))])
    write_jsonl(home / ".codex/sessions/2026/10/25/rollout-1.jsonl", [{"payload": {"type": "custom_tool_call", "input": PATCH}}])
    (home / ".gemini/antigravity/conversations").mkdir(parents=True)
    (home / ".gemini/antigravity/conversations/abc.db").write_bytes(b"\0")
    return home


def test_sessions_and_lines_from_the_logs(tmp_path, monkeypatch):
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    monkeypatch.delenv("CODEX_HOME", raising=False)
    home = fake_home(tmp_path)
    stats = Stats(tmp_path / "state", home)
    snapshot = asyncio.run(stats.snapshot())
    assert snapshot["sessionsBy"] == {"claude_code": 2, "codex": 1, "antigravity": 1} and snapshot["sessions"] == 4
    assert snapshot["linesBy"] == {"claude_code": 2, "codex": 2} and snapshot["lines"] == 4


def test_logs_are_read_from_where_they_stopped(tmp_path, monkeypatch):
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    monkeypatch.delenv("CODEX_HOME", raising=False)
    home = fake_home(tmp_path)
    log = home / ".claude/projects/proj/one.jsonl"
    asyncio.run(Stats(tmp_path / "state", home).snapshot())
    # A line still being written isn't counted until it ends.
    write_jsonl(log, [claude_record(("Edit", {"new_string": "1\n2\n3"}))], tail=json.dumps(claude_record(("Write", {"content": "q"})))[:40])
    again = Stats(tmp_path / "state", home)  # a new start: the cache comes from disk
    assert asyncio.run(again.snapshot())["linesBy"]["claude_code"] == 5
    cache = json.loads((tmp_path / "state/stats_cache.json").read_text())
    assert cache[str(log)]["offset"] < log.stat().st_size
    # Rewritten shorter: counted again from the start.
    log.write_text(json.dumps(claude_record(("Write", {"content": "z"}))) + "\n", encoding="utf-8")
    assert asyncio.run(again.snapshot())["linesBy"]["claude_code"] == 1
    # A deleted log leaves with its lines.
    log.unlink()
    assert "claude_code" not in asyncio.run(again.snapshot())["linesBy"]


def test_her_counters_survive_a_restart(tmp_path):
    stats = Stats(tmp_path, tmp_path / "nobody", clock=lambda: 1000.0)
    stats.dictated("Ciao Tsukumo, dove trovo l'AND?")
    stats.add("messages")
    stats.add("reminders", 2)
    stats.add("nonsense")
    stats.add("todos", -3)
    again = Stats(tmp_path, tmp_path / "nobody", clock=lambda: 5000.0)
    assert {name: again.counts[name] for name in ("since", "words", "messages", "reminders", "todos")} == {
        "since": 1000.0, "words": 6, "messages": 1, "reminders": 2, "todos": 0,
    }


def test_a_ticked_todo_is_counted_once(tmp_path):
    notebook = Notebook(tmp_path / "notebook.json")
    ticked = []
    notebook.on_done = lambda: ticked.append(1)
    item = notebook.add_todo("chiamare il dentista")
    notebook.complete(item.id)
    notebook.complete(item.id)  # already done
    notebook.complete(item.id, done=False)
    notebook.complete(item.id)
    assert len(ticked) == 2


def test_the_server_counts_messages(client, monkeypatch, tmp_path):
    from backend import server

    monkeypatch.setattr(server.STATS.logs, "home", tmp_path)  # not the real agents' logs

    async def no_turn(*args, **kwargs):  # counting is the point, not the replies
        return ""

    monkeypatch.setattr(server.app.state.companion, "chat", no_turn)
    before = server.STATS.counts["messages"]
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": "chat", "text": "ciao"})
        ws.send_json({"type": "chat", "text": "   "})
        ws.send_json({"type": "chat", "text": "ciao", "again": True})
        ws.send_json({"type": "ping"})
        while ws.receive_json()["type"] != "pong":
            pass
    assert server.STATS.counts["messages"] == before + 1
    data = client.get("/api/stats").json()
    assert {"sessions", "sessionsBy", "lines", "linesBy", "words", "messages", "reminders", "todos", "since"} <= data.keys()
