"""Session-keeping agents get the directive once, then only what changed.

Repeating the whole bracket at every turn piled ~2k tokens per exchange into
OpenClaw's session (seen in its web UI, October 2026).
"""

import asyncio
from datetime import datetime

from backend.llm import base
from backend.llm.base import ContextLedger, Message
from backend.llm.cli_agents import AgentError, CodexClient
from backend.reminders import action_directive, local_time

RULES = "Speak like Tsukumo."
TAGS = "Append [[remind {...}]] to add to the agenda."


def _turn(*parts, text="ciao"):
    return [Message("system", "the system prompt"), Message("system", " ".join(parts), parts=parts), Message("user", text)]


def test_the_first_turn_gets_everything_then_only_the_news():
    ledger = ContextLedger()
    first = ledger.bracket(_turn(RULES, TAGS, "Local time: 10:00."), "s1", "Plain spoken text.")
    assert first == "[Plain spoken text. Speak like Tsukumo. Append [[remind {...}]] to add to the agenda. Local time: 10:00.]"

    second = ledger.bracket(_turn(RULES, TAGS, "Local time: 10:05."), "s1", "Plain spoken text.")
    assert "Local time: 10:05." in second
    assert RULES not in second and TAGS not in second and "Plain spoken" not in second
    assert second.startswith("[Your earlier instructions still hold.")

    # Nothing new at all: the message goes alone.
    assert ledger.bracket(_turn(RULES, TAGS), "s1") == ""


def test_a_changed_piece_is_sent_again():
    ledger = ContextLedger()
    ledger.bracket(_turn(RULES, "What you remember: likes tea."), "s1")
    again = ledger.bracket(_turn(RULES, "What you remember: likes tea; studies maths."), "s1")
    assert "studies maths" in again and RULES not in again


def test_a_new_session_a_reset_or_a_long_session_get_everything_again(monkeypatch):
    ledger = ContextLedger()
    ledger.bracket(_turn(RULES), "s1")
    assert ledger.bracket(_turn(RULES), "s2") == f"[{RULES}]"

    ledger.forget()
    assert ledger.bracket(_turn(RULES), "s2") == f"[{RULES}]"

    # No session yet: whatever opens next is new.
    assert ledger.bracket(_turn(RULES), None) == f"[{RULES}]"
    assert ledger.bracket(_turn(RULES), None) == f"[{RULES}]"

    monkeypatch.setattr(base, "FULL_CONTEXT_EVERY", 3)
    ledger.forget()
    seen = [ledger.bracket(_turn(RULES), "s3") for _ in range(4)]
    assert seen == [f"[{RULES}]", "", "", f"[{RULES}]"]


def test_a_directive_without_pieces_counts_as_one():
    ledger = ContextLedger()
    messages = [Message("system", "Reply in Italian."), Message("user", "ciao")]
    assert ledger.bracket(messages, "s1") == "[Reply in Italian.]"
    assert ledger.bracket(messages, "s1") == ""


def test_the_clock_is_a_piece_of_its_own():
    now = datetime(2026, 10, 15, 9, 30)
    assert local_time(now) == "Local time: Thursday 2026-10-15 09:30."
    assert action_directive(now).startswith(local_time(now))
    rules = action_directive(now, clock=False)
    assert "Local time" not in rules and "[[remind" in rules
    # Only the date of the example moves, once a day, not at every minute.
    assert rules == action_directive(datetime(2026, 10, 15, 22, 0), clock=False)


def _codex(tmp_path, monkeypatch, fail_on=()):
    sent = []

    async def fake_stream(argv, stdin_text=None, **kwargs):
        sent.append(stdin_text)
        if len(sent) in fail_on:
            raise AgentError("exited with code 1")
        yield '{"type":"thread.started","thread_id":"t-1"}'
        yield '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"ok"}}'
        yield '{"type":"turn.completed"}'

    monkeypatch.setattr("backend.llm.cli_agents.stream_process", fake_stream)
    exe = tmp_path / "codex.exe"
    exe.write_bytes(b"")
    client = CodexClient(command=str(exe), cwd=str(tmp_path), session_path=tmp_path / "s.json")
    return client, sent


def _run(client, messages):
    async def turn():
        return [piece async for piece in client.stream(messages)]

    return asyncio.run(turn())


def test_codex_hears_the_rules_once_per_thread(tmp_path, monkeypatch):
    client, sent = _codex(tmp_path, monkeypatch)
    _run(client, _turn(RULES, TAGS, "Local time: 10:00.", text="ciao"))
    _run(client, _turn(RULES, TAGS, "Local time: 10:05.", text="e domani?"))
    assert RULES in sent[0] and TAGS in sent[0] and sent[0].endswith("ciao")
    # The thread opened by the first turn already holds them.
    assert RULES not in sent[1] and "Local time: 10:05." in sent[1] and sent[1].endswith("e domani?")

    asyncio.run(client.reset())
    _run(client, _turn(RULES, TAGS, "Local time: 10:06."))
    assert RULES in sent[2]


def test_openclaw_session_keeps_one_copy_of_the_rules():
    from backend.llm.openclaw import OpenClawClient

    client = OpenClawClient("ws://127.0.0.1:1", "token")
    sent = []

    async def nothing():
        return None

    async def session():
        client._session_key = client._session_key or "agent:main:tsukumo"
        return client._session_key

    async def request(method, params):
        sent.append(params["message"])
        client._chat_events.put_nowait({"runId": "r", "state": "final", "message": {"content": [{"type": "text", "text": "ok"}]}})
        return {"payload": {"runId": "r"}}

    client._ensure_connected, client._ensure_session, client._request = nothing, session, request

    async def turns():
        for stamp in ("10:00", "10:05"):
            assert [p async for p in client.stream(_turn(RULES, f"Local time: {stamp}."))] == ["ok"]
        await client.reset()
        [p async for p in client.stream(_turn(RULES, "Local time: 10:06."))]

    asyncio.run(turns())
    assert sent[0] == f"[{RULES} Local time: 10:00.]\n\nciao"
    assert sent[1] == "[Your earlier instructions still hold. New or updated: Local time: 10:05.]\n\nciao"
    assert sent[2].startswith(f"[{RULES}")


def test_a_failed_turn_sends_everything_again(tmp_path, monkeypatch):
    client, sent = _codex(tmp_path, monkeypatch, fail_on=(2,))
    _run(client, _turn(RULES, TAGS))
    try:
        _run(client, _turn(RULES, TAGS, text="poi"))
    except AgentError:
        pass
    _run(client, _turn(RULES, TAGS, text="riprovo"))
    assert RULES in sent[2]
