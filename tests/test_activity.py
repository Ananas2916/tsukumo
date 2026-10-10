"""What an agent does while it works: tools -> sentences, "working" events, "just a moment"."""

import asyncio
import json

from backend import pipeline
from backend.config import Settings
from backend.llm.activity import _command_words, describe_claude_tool, describe_codex_item, describe_openclaw_tool
from backend.llm.base import Activity, LLMClient
from backend.llm.cli_agents import ClaudeStreamParser, CodexStreamParser
from backend.pipeline import Companion


def _line(**event):
    return json.dumps(event)


class Recorder:
    def __init__(self):
        self.messages = []

    async def __call__(self, message):
        self.messages.append(message)

    def of(self, kind):
        return [m for m in self.messages if m["type"] == kind]


class WorkingAgent(LLMClient):
    """An agent that uses a few tools, waits, then answers."""

    name = "worker"
    stateful = True

    def __init__(self, wait=0.0):
        self.wait = wait

    async def stream(self, messages):
        self.report(Activity("read", "reads main.js", "src/main.js", "Read"))
        self.report(Activity("read", "reads main.js", "src/main.js", "Read"))
        self.report(Activity("run", "runs git status", "git status", "Bash"))
        await asyncio.sleep(self.wait)
        yield "Ho controllato, e' tutto a posto."

    async def health(self):
        return {"ok": True}


# ---------------------------------------------------------------------------
# Labels
# ---------------------------------------------------------------------------
def test_command_words_see_through_shell_wrappers():
    assert _command_words("bash -lc 'git status --short'") == "git status"
    assert _command_words('powershell.exe -NoProfile -Command "npm test"') == "npm test"
    assert _command_words(["C:\\Tools\\rg.exe", "-n", "TODO"]) == "rg"
    assert _command_words("") == ""


def test_claude_tools_become_short_sentences():
    assert describe_claude_tool("Read", {"file_path": "C:\\repo\\frontend\\src\\main.js"}).label == "reads main.js"
    assert describe_claude_tool("Edit", {"file_path": "/repo/a.py"}).kind == "write"
    assert describe_claude_tool("WebFetch", {"url": "https://www.example.com/x"}).label == "opens example.com"
    assert describe_claude_tool("mcp__github__create_issue", {}).label == "uses create issue (github)"
    long = describe_claude_tool("Grep", {"pattern": "x" * 200}).label
    assert len(long) < 50 and long.endswith("…”")


def test_codex_items_and_openclaw_tools():
    change = describe_codex_item({"type": "file_change", "changes": [{"path": "src/app.py", "kind": "add"}]})
    assert change.label == "creates app.py" and change.kind == "write"
    assert describe_codex_item({"type": "reasoning", "text": "..."}) is None
    assert describe_openclaw_tool("web_search", {"query": "meteo Milano"}).label == "searches the web for “meteo Milano”"
    assert describe_openclaw_tool("heartbeat_respond", {}) is None


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------
def test_claude_parser_reports_tools_but_not_subagent_ones():
    parser = ClaudeStreamParser()
    tool = {"type": "tool_use", "id": "t1", "name": "Read", "input": {"file_path": "/x/README.md"}}
    lines = [
        _line(type="assistant", message={"id": "m1", "content": [tool]}, parent_tool_use_id=None),
        # The same message repeated isn't a second step.
        _line(type="assistant", message={"id": "m1", "content": [tool]}, parent_tool_use_id=None),
        _line(
            type="assistant",
            message={"id": "m2", "content": [{"type": "tool_use", "id": "t2", "name": "Bash", "input": {"command": "ls"}}]},
            parent_tool_use_id="t0",
        ),
    ]
    for line in lines:
        assert parser.feed(line) == []
    assert [a.label for a in parser.take_activities()] == ["reads README.md"]
    assert parser.take_activities() == []


def test_codex_parser_reports_a_command_once():
    parser = CodexStreamParser()
    item = {"id": "item_1", "type": "command_execution", "command": "bash -lc 'pytest -q'"}
    parser.feed(_line(type="item.started", item=item))
    parser.feed(_line(type="item.completed", item={**item, "exit_code": 0}))
    text = parser.feed(_line(type="item.completed", item={"id": "item_2", "type": "agent_message", "text": "Fatto"}))
    assert text == ["Fatto"]
    assert [a.label for a in parser.take_activities()] == ["runs pytest"]


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------
def test_turn_emits_working_steps_and_keeps_them_in_the_reply():
    emit = Recorder()
    companion = Companion(Settings.from_env())
    companion.llm = WorkingAgent()
    asyncio.run(companion.chat("controlla il repo", emit))
    working = emit.of("working")
    assert [w["label"] for w in working] == ["reads main.js", "runs git status"]
    assert working[0]["kind"] == "read" and working[0]["turn"] == 1
    assert [s["label"] for s in emit.of("reply")[0]["steps"]] == ["reads main.js", "runs git status"]
    assert companion.llm.on_activity is None


def test_silent_agent_says_one_moment(monkeypatch):
    monkeypatch.setattr(pipeline, "WORKING_CUES", ((0.05, "working"), (5.0, "working_long")))
    emit = Recorder()
    companion = Companion(Settings.from_env())
    companion.llm = WorkingAgent(wait=0.6)
    asyncio.run(companion.chat("controlla il repo", emit))
    speech = emit.of("speech")
    assert speech[0]["vocal"] == "working" and speech[0]["index"] == -1
    assert [s.get("vocal") for s in speech].count("working") == 1
    assert not any(s.get("vocal") == "working_long" for s in speech)
    assert speech[1]["index"] == 0


def test_quick_agent_does_not_say_one_moment(monkeypatch):
    monkeypatch.setattr(pipeline, "WORKING_CUES", ((0.3, "working"),))
    emit = Recorder()
    companion = Companion(Settings.from_env())
    companion.llm = WorkingAgent(wait=0.0)
    asyncio.run(companion.chat("ciao", emit))
    assert not [s for s in emit.of("speech") if s.get("vocal")]
