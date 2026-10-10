"""Agents at work: the task lists (Claude Code, Codex), the board, the hooks."""

from __future__ import annotations

import json
import sys

from backend import notify, server
from backend.agents_board import AgentBoard
from backend.llm.cli_agents import ClaudeStreamParser, CodexStreamParser
from backend.llm.tasks import TaskList, task_number

sys.path.insert(0, str(notify.ROOT / "scripts"))
import tsukumo_notify  # noqa: E402


def test_todowrite_replaces_the_whole_list():
    tasks = TaskList()
    todos = [
        {"content": "Leggere il parser", "status": "completed", "activeForm": "Leggo il parser"},
        {"content": "Scrivere i test", "status": "in_progress", "activeForm": "Scrivo i test"},
        {"content": "Aggiornare il README", "status": "pending", "activeForm": "Aggiorno il README"},
    ]
    assert tasks.apply_claude("TodoWrite", {"todos": todos})
    assert [(item["text"], item["status"]) for item in tasks.public()] == [
        ("Leggere il parser", "completed"), ("Scrivere i test", "in_progress"), ("Aggiornare il README", "pending")
    ]
    assert tasks.public()[1]["active"] == "Scrivo i test"
    assert not tasks.apply_claude("TodoWrite", {"todos": "rotto"})


def test_task_tools_build_the_list_a_piece_at_a_time():
    tasks = TaskList()
    assert tasks.apply_claude("TaskCreate", {"subject": "Trovare il bug", "activeForm": "Cerco il bug"}, call_id="toolu_1")
    assert tasks.apply_claude("TaskCreate", {"subject": "Correggerlo"}, call_id="toolu_2")
    # Tsukumo restarted with a session open: Claude Code was already at task 7.
    assert tasks.created("toolu_1", [{"type": "text", "text": "Task #7 created successfully: Trovare il bug"}])
    assert tasks.created("toolu_2", "Task #8 created successfully: Correggerlo")
    assert [item["id"] for item in tasks.public()] == ["7", "8"]
    assert tasks.apply_claude("TaskUpdate", {"taskId": "7", "status": "in_progress"})
    assert tasks.apply_claude("TaskUpdate", {"taskId": "8", "status": "deleted"})
    assert tasks.public() == [{"id": "7", "text": "Trovare il bug", "active": "Cerco il bug", "status": "in_progress"}]
    assert not tasks.apply_claude("TaskUpdate", {"taskId": "99", "status": "completed"})
    # From the hooks the answer arrives together with the input.
    assert tasks.apply_claude("TaskCreate", {"subject": "Rilasciare"}, response={"task": {"id": "9"}})
    assert tasks.public()[-1]["id"] == "9"
    assert task_number({"taskId": 4}) == "4" and task_number("nessun numero") is None


def test_codex_todo_list_marks_the_first_open_item_as_current():
    tasks = TaskList()
    item = {"id": "item_2", "type": "todo_list", "items": [
        {"text": "Esplorare il repo", "completed": True},
        {"text": "Modificare server.py", "completed": False},
        {"text": "Lanciare i test", "completed": False},
    ]}
    assert tasks.apply_codex(item)
    assert [item["status"] for item in tasks.public()] == ["completed", "in_progress", "pending"]
    assert not tasks.apply_codex({"type": "agent_message"})


def test_the_claude_stream_carries_the_list_to_the_dashboard():
    tasks = TaskList()
    parser = ClaudeStreamParser(tasks)
    create = {"type": "assistant", "message": {"id": "msg_1", "content": [
        {"type": "tool_use", "id": "toolu_a", "name": "TaskCreate", "input": {"subject": "Leggere il codice"}}]}}
    result = {"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": "toolu_a", "content": "Task #1 created successfully: Leggere il codice"}]}}
    update = {"type": "assistant", "message": {"id": "msg_2", "content": [
        {"type": "tool_use", "id": "toolu_b", "name": "TaskUpdate", "input": {"taskId": "1", "status": "completed"}}]}}
    for event in (create, result, update):
        parser.feed(json.dumps(event))
    steps = parser.take_activities()
    assert steps[0].label == "plans the work" and steps[0].tasks[0]["text"] == "Leggere il codice"
    assert steps[-1].as_dict()["tasks"] == [{"id": "1", "text": "Leggere il codice", "active": "", "status": "completed"}]
    # The list stays with the client: the next turn continues from there.
    assert tasks.public()[0]["status"] == "completed"


def test_the_codex_stream_follows_list_updates():
    parser = CodexStreamParser()
    started = {"type": "item.started", "item": {"id": "item_1", "type": "todo_list", "items": [{"text": "A", "completed": False}]}}
    updated = {"type": "item.updated", "item": {"id": "item_1", "type": "todo_list", "items": [{"text": "A", "completed": True}]}}
    parser.feed(json.dumps(started))
    parser.feed(json.dumps(updated))
    steps = parser.take_activities()
    assert [step.tasks[0]["status"] for step in steps] == ["in_progress", "completed"]


def test_the_board_follows_tsukumo_and_the_external_sessions():
    now = [1000.0]
    board = AgentBoard(own_name=lambda: "Claude Code", clock=lambda: now[0])
    assert board.observe({"type": "user", "text": "sistemami il bug"}) is False
    assert board.observe({"type": "state", "value": "thinking"})
    assert board.observe({"type": "working", "label": "reads main.js", "tasks": [{"id": "1", "text": "Trovare il bug", "status": "in_progress"}]})
    own = board.public()[0]
    assert (own["name"], own["state"], own["step"], own["summary"]) == ("Claude Code", "working", "reads main.js", "sistemami il bug")
    assert own["tasks"][0]["text"] == "Trovare il bug" and own["internal"]
    assert board.observe({"type": "state", "value": "idle"}) and board.public()[0]["state"] == "done"
    assert board.observe({"type": "agents"}) is False

    assert board.external("claude", "working", "s1", "desk-companion", "aggiungi la dashboard")
    assert board.external("claude", "tasks", "s1", tool="TaskCreate", data={"subject": "Fare la griglia"}, response="Task #1 created")
    assert board.external("codex", "done", "t9", "altro-progetto", "Fatto!")
    agents = board.public()
    assert [(a["name"], a["state"], a["project"]) for a in agents[1:]] == [
        ("Claude Code", "working", "desk-companion"), ("Codex", "done", "altro-progetto")
    ]
    assert agents[1]["tasks"][0]["text"] == "Fare la griglia"
    assert not board.external("claude", "boh", "s1")
    now[0] += 13 * 3600  # half a day later, the external sessions disappear
    assert len(board.public()) == 1


def test_hooks_send_start_and_task_tools():
    working = tsukumo_notify.from_claude(
        {"hook_event_name": "UserPromptSubmit", "session_id": "abc", "cwd": "C:/progetti/desk-companion", "prompt": "fai la dashboard"}
    )
    assert working == {"source": "claude", "session": "abc", "project": "desk-companion", "kind": "working", "message": "fai la dashboard"}
    tasks = tsukumo_notify.from_claude({
        "hook_event_name": "PostToolUse", "session_id": "abc", "cwd": "/x/y", "tool_name": "TaskCreate",
        "tool_input": {"subject": "Griglia"}, "tool_response": {"task": {"id": "3"}},
    })
    assert tasks["kind"] == "tasks" and tasks["tool"] == "TaskCreate" and tasks["response"] == {"task": {"id": "3"}}
    assert tsukumo_notify.from_claude({"hook_event_name": "PostToolUse", "tool_name": "Bash"}) is None


def test_old_hooks_are_upgraded_with_the_dashboard_events(tmp_path):
    path = tmp_path / "settings.json"
    old = {"hooks": {event: [{"hooks": [notify.claude_hook()]}] for event in ("Stop", "Notification")}}
    path.write_text(json.dumps(old))
    assert notify.install_claude(path) == "updated"
    data = json.loads(path.read_text())
    assert data["hooks"]["PostToolUse"][0]["matcher"] == "TodoWrite|TaskCreate|TaskUpdate"
    assert len(data["hooks"]["Stop"]) == 1 and "UserPromptSubmit" in data["hooks"]
    assert notify.install_claude(path) == "already connected"
    assert notify.uninstall_claude(path) == "disconnected"
    assert "hooks" not in json.loads(path.read_text())


def test_notify_endpoint_updates_the_board_without_speaking(client, monkeypatch):
    sent = []

    async def record(message):
        sent.append(message)

    monkeypatch.setattr(server, "hub", server.hub)
    monkeypatch.setattr(server.hub, "agents", AgentBoard())
    monkeypatch.setattr(server.hub, "broadcast", record)
    reply = client.post("/api/notify", json={"source": "claude", "kind": "working", "session": "s1", "project": "tsukumo", "message": "vai"})
    assert reply.json() == {"ok": True, "spoken": False}
    reply = client.post("/api/notify", json={
        "source": "claude", "kind": "tasks", "session": "s1", "tool": "TodoWrite",
        "input": {"todos": [{"content": "Uno", "status": "in_progress"}]},
    })
    assert reply.json()["spoken"] is False
    boards = [m for m in sent if m["type"] == "agents"]
    assert boards[-1]["agents"][1]["tasks"][0]["text"] == "Uno"
    assert not [m for m in sent if m["type"] in ("notify", "reply")]
    assert client.get("/api/agents").json()["agents"][1]["project"] == "tsukumo"
