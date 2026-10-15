"""The park: Claude Code's registry, the transcripts' messages, the merge with the hooks."""

from __future__ import annotations

import json

import pytest

from backend import server
from backend.agents_board import AgentBoard
from backend.park import HELPER_TTL, LINK_TTL, Park, events_of, read_registry

PIPE_A = "\\\\.\\pipe\\LOCAL\\cc-msg-aaaa"
PIPE_B = "\\\\.\\pipe\\LOCAL\\cc-msg-bbbb"
SID_A = "0a4662f1-a917-481b-b0e0-d6018a76fc05"
SID_B = "8d48ef42-edd4-42ec-b80c-6892b41809e3"
NOW = 1_792_098_000.0
STAMP = "2026-10-15T20:30:22.299Z"  # 1792096222.299
AT = 1_792_096_222.299

# Real lines, recorded from Claude Code 2.1.300 and shortened.
SENT = {
    "parentUuid": "68e74a84",
    "isSidechain": False,
    "type": "assistant",
    "timestamp": STAMP,
    "message": {
        "role": "assistant",
        "content": [
            {
                "type": "tool_use",
                "id": "toolu_01NCGYez9Q5PL9gGQqL216z3",
                "name": "SendMessage",
                "input": {"to": "uds:" + PIPE_B, "message": "Not me: I'm not the session you want.\nSecond line", "summary": "Reply: not the Parakeet/Kokoro session"},
            }
        ],
    },
}
RECEIVED = {
    "type": "user",
    "isSidechain": False,
    "timestamp": STAMP,
    "message": {
        "role": "user",
        "content": f'Another Claude session sent a message:\n<cross-session-message from="uds:{PIPE_A}" from-name="desk-companion-16" from-mode="prompting">\nRelease 3.1.2 together?\n</cross-session-message>',
    },
}


@pytest.mark.parametrize(
    ("entry", "expected"),
    [
        (SENT, [{"kind": "message", "to": "uds:" + PIPE_B, "label": "Reply: not the Parakeet/Kokoro session", "at": AT}]),
        (RECEIVED, [{"kind": "received", "from": "uds:" + PIPE_A, "fromName": "desk-companion-16", "at": AT}]),
        # Without a summary the label is the message's first line, never the rest.
        (
            {**SENT, "message": {"content": [{"type": "tool_use", "name": "SendMessage", "input": {"to": "desk-companion-35 [803b8b]", "message": "Ciao\nsecret"}}]}},
            [{"kind": "message", "to": "desk-companion-35 [803b8b]", "label": "Ciao", "at": AT}],
        ),
        (
            {**SENT, "message": {"content": [{"type": "tool_use", "name": "Agent", "input": {"description": "Find the parser", "prompt": "..."}}]}},
            [{"kind": "helper", "label": "Find the parser", "at": AT}],
        ),
        (
            {**SENT, "message": {"content": [{"type": "tool_use", "name": "mcp__tsukumo__say", "input": {"text": "Done!"}}]}},
            [{"kind": "tsukumo", "label": "say", "at": AT}],
        ),
        # A tool result that quotes a transcript (a grep) isn't a message received.
        (
            {"type": "user", "timestamp": STAMP, "message": {"content": [{"type": "tool_result", "content": RECEIVED["message"]["content"]}]}},
            [],
        ),
        # The same text in the API's request copy, and anything inside a subagent: no.
        ({**RECEIVED, "type": "api-request-blob"}, []),
        ({**SENT, "isSidechain": True}, []),
        ({"type": "user", "message": {"content": "just the user"}}, []),
    ],
)
def test_events_of_transcript_lines(entry, expected):
    assert events_of(entry) == expected


def _session(home, pid, sid, name, pipe, status="idle", entrypoint="claude-vscode"):
    (home / "sessions").mkdir(parents=True, exist_ok=True)
    data = {
        "pid": pid,
        "sessionId": sid,
        "cwd": "c:\\Users\\me\\desk-companion",
        "startedAt": 1_792_095_051_111,
        "procStart": "134365686497991501",
        "kind": "interactive",
        "entrypoint": entrypoint,
        "messagingSocketPath": pipe,
        "name": name,
        "status": status,
        "statusUpdatedAt": 1_792_097_631_814,
    }
    (home / "sessions" / f"{pid}.json").write_text(json.dumps(data), encoding="utf-8")


def _transcript(home, sid, *entries, project="c--Users-me-desk-companion"):
    folder = home / "projects" / project
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{sid}.jsonl"
    with path.open("a", encoding="utf-8") as handle:
        for entry in entries:
            handle.write(json.dumps(entry) + "\n")
    return path


@pytest.fixture
def home(tmp_path):
    home = tmp_path / ".claude"
    _session(home, 100, SID_A, "desk-companion-16", PIPE_A, status="busy")
    _session(home, 200, SID_B, "desk-companion-35", PIPE_B)
    return home


def _park(home, board=None, dead=(), **kwargs):
    return Park(board or AgentBoard(clock=lambda: NOW), home=home, clock=lambda: NOW, alive=lambda pid, started: pid not in dead, **kwargs)


def test_the_registry_never_opens_the_key_files(home):
    (home / "sessions" / "100.0c97af07.key").write_text("not json, and secret", encoding="utf-8")
    (home / "sessions" / "300.json").write_text("{broken", encoding="utf-8")
    assert sorted(entry["pid"] for entry in read_registry(home)) == [100, 200]
    assert read_registry(home.parent / "nowhere") is None


def test_one_message_seen_from_both_ends_is_one_link(home):
    sent = {**SENT, "message": {"content": [{"type": "tool_use", "name": "SendMessage", "input": {"to": "uds:" + PIPE_B, "summary": "Tree free"}}]}}
    _transcript(home, SID_A, sent)
    _transcript(home, SID_B, RECEIVED)
    park = _park(home)
    park.scan()
    data = park.public()
    assert [agent["name"] for agent in data["agents"]] == ["Tsukumo", "desk-companion-16", "desk-companion-35"]
    assert [(agent["state"], agent["where"], agent["project"]) for agent in data["agents"][1:]] == [
        ("working", "vscode", "desk-companion"),
        ("idle", "vscode", "desk-companion"),
    ]
    assert data["links"] == [{"from": f"claude:{SID_A}", "to": f"claude:{SID_B}", "kind": "message", "label": "Tree free", "at": AT}]


def test_names_with_a_ref_resolve_and_unknown_ones_are_dropped(home):
    to_name = {**SENT, "message": {"content": [{"type": "tool_use", "name": "SendMessage", "input": {"to": "desk-companion-16 [90acfc]", "summary": "Hi"}}]}}
    to_stranger = {**SENT, "message": {"content": [{"type": "tool_use", "name": "SendMessage", "input": {"to": "researcher", "summary": "Hi"}}]}}
    _transcript(home, SID_B, to_name, to_stranger)
    park = _park(home)
    park.scan()
    assert [(link["from"], link["to"]) for link in park.public()["links"]] == [(f"claude:{SID_B}", f"claude:{SID_A}")]


def test_reads_only_what_is_new_and_whole_lines(home):
    path = _transcript(home, SID_A)
    park = _park(home)
    park.scan()
    assert park.public()["links"] == []
    line = json.dumps({**SENT, "message": {"content": [{"type": "tool_use", "name": "mcp__tsukumo__say", "input": {}}]}})
    # Half a line, still being written: nothing yet.
    with path.open("a", encoding="utf-8") as handle:
        handle.write(line[:40])
    park.scan()
    assert park.public()["links"] == []
    with path.open("a", encoding="utf-8") as handle:
        handle.write(line[40:] + "\n")
    park.scan()
    park.scan()
    assert [(link["to"], link["label"]) for link in park.public()["links"]] == [("tsukumo", "say")]


def test_old_links_and_helpers_leave(home):
    old = {**SENT, "timestamp": "2026-10-15T18:00:00Z"}  # ~3 hours before NOW
    helper = {**SENT, "message": {"content": [{"type": "tool_use", "name": "Agent", "input": {"description": "Explore"}}]}}
    _transcript(home, SID_A, old, helper)
    clock = {"now": AT + 10}
    park = Park(AgentBoard(), home=home, clock=lambda: clock["now"], alive=lambda pid, started: True)
    park.scan()
    data = park.public()
    assert data["links"] == []
    assert data["agents"][1]["helpers"] == [{"label": "Explore", "at": AT}]
    clock["now"] = AT + HELPER_TTL + 1
    park.scan()
    assert park.public()["agents"][1]["helpers"] == []
    assert LINK_TTL > HELPER_TTL


def test_dead_sessions_and_her_own_brain_are_not_on_the_lawn(home):
    park = _park(home, dead={200}, brain_session=lambda: SID_A)
    park.scan()
    assert [agent["id"] for agent in park.public()["agents"]] == ["tsukumo"]


def test_the_hooks_add_waiting_tasks_and_other_agents(home):
    board = AgentBoard(clock=lambda: NOW)
    board.external("claude", "waiting", SID_B, "desk-companion", "Can I run the tests?")
    board.external("claude", "tasks", SID_B, tool="TodoWrite", data={"todos": [{"content": "a", "status": "completed"}, {"content": "b", "status": "pending"}]})
    board.external("codex", "working", "thread-1", "tsk-pub", "Fix the build")
    # A Claude session the registry doesn't list anymore has ended.
    board.external("claude", "working", "gone-session", "old")
    park = _park(home, board=board)
    park.scan()
    agents = {agent["id"]: agent for agent in park.public()["agents"]}
    assert agents[f"claude:{SID_B}"]["state"] == "waiting"
    assert agents[f"claude:{SID_B}"]["tasks"] == {"done": 1, "total": 2}
    assert agents["codex:thread-1"]["kind"] == "codex" and agents["codex:thread-1"]["state"] == "working"
    assert "claude:gone-session" not in agents


def test_without_a_registry_the_hooks_claude_sessions_stay(tmp_path):
    board = AgentBoard(clock=lambda: NOW)
    board.external("claude", "working", "s1", "proj")
    park = _park(tmp_path / ".claude", board=board)
    park.scan()
    assert [agent["id"] for agent in park.public()["agents"]] == ["tsukumo", "claude:s1"]


def test_services_and_her_brain_link(home):
    board = AgentBoard(clock=lambda: NOW)
    board.observe({"type": "state", "value": "thinking"})
    park = _park(home, board=board, brain=lambda: "openclaw")
    park.set_services(True, {"model": "prism-ml/bonsai-27b"})
    data = park.public()
    assert data["lmstudio"] == {"model": "prism-ml/bonsai-27b"}
    assert {"id": "openclaw", "kind": "openclaw", "name": "OpenClaw", "state": "working", "since": 0} in data["agents"]
    assert [(link["from"], link["to"], link["kind"]) for link in data["links"]] == [("tsukumo", "openclaw", "brain")]
    park.set_services(False, None)
    assert park.public()["links"] == []


def test_the_park_never_reaches_a_remote_client():
    import asyncio

    class Socket:
        def __init__(self):
            self.sent = []

        async def send_json(self, message):
            self.sent.append(message)

    async def run():
        hub = server.ConnectionHub()
        pc, phone = Socket(), Socket()
        await hub.add(pc)
        await hub.add(phone, text_only=True, remote=True)
        await hub.broadcast_local({"type": "park", "agents": []})
        return pc.sent, phone.sent

    pc, phone = asyncio.run(run())
    assert pc == [{"type": "park", "agents": []}] and phone == []


def test_api_and_hello_carry_the_park(client):
    # DC_PARK=0 in the tests: no loop, but the endpoint answers with her alone.
    data = client.get("/api/park").json()
    assert [agent["id"] for agent in data["agents"]][0] == "tsukumo"
    with client.websocket_connect("/ws") as websocket:
        hello = websocket.receive_json()
    assert hello["park"]["agents"][0]["kind"] == "tsukumo"
    assert server.PARK.public()["links"] == data["links"]
