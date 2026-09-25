"""Agenti da riga di comando: parser degli eventi e gestione dei processi.

Le righe JSON qui sotto sono ridotte da quelle stampate davvero da
``claude -p --output-format stream-json`` e ``codex exec --json`` (settembre 2026).
"""

import asyncio
import json
import sys

import pytest

from backend.llm.cli_agents import (
    AgentError,
    ClaudeStreamParser,
    CodexStreamParser,
    CommandAgentClient,
    split_command,
    stream_process,
)

SID = "650949ca-3279-41a5-ad64-422c17298f32"


def _line(**event):
    return json.dumps(event)


def _feed(parser, lines):
    out = []
    for line in lines:
        out.extend(parser.feed(line))
    return "".join(out)


def test_claude_partial_messages_are_read_once():
    lines = [
        _line(type="system", subtype="init", session_id=SID),
        _line(type="stream_event", event={"type": "message_start", "message": {"id": "m1"}}, parent_tool_use_id=None),
        _line(
            type="stream_event",
            event={"type": "content_block_delta", "delta": {"type": "thinking_delta", "thinking": "hmm"}},
            parent_tool_use_id=None,
        ),
        _line(
            type="stream_event",
            event={"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Ci"}},
            parent_tool_use_id=None,
        ),
        _line(
            type="stream_event",
            event={"type": "content_block_delta", "delta": {"type": "text_delta", "text": "ao"}},
            parent_tool_use_id=None,
        ),
        # Il riepilogo arriva di nuovo intero: non va letto due volte.
        _line(type="assistant", message={"id": "m1", "content": [{"type": "text", "text": "Ciao"}]}, parent_tool_use_id=None),
        _line(type="result", subtype="success", is_error=False, result="Ciao", session_id=SID),
    ]
    parser = ClaudeStreamParser()
    assert _feed(parser, lines) == "Ciao"
    assert parser.session_id == SID
    assert parser.finished and parser.error is None


def test_claude_without_partials_and_after_a_tool_starts_a_new_sentence():
    lines = [
        _line(type="assistant", message={"id": "m1", "content": [{"type": "text", "text": "Controllo il meteo."}]}),
        _line(type="assistant", message={"id": "m1", "content": [{"type": "tool_use", "name": "WebSearch"}]}),
        # I sotto-agenti non parlano con te.
        _line(type="assistant", message={"id": "x", "content": [{"type": "text", "text": "segreto"}]}, parent_tool_use_id="t1"),
        _line(type="assistant", message={"id": "m2", "content": [{"type": "text", "text": "Domani piove."}]}),
        _line(type="result", subtype="success", is_error=False, result="Domani piove.", session_id=SID),
    ]
    assert _feed(ClaudeStreamParser(), lines) == "Controllo il meteo.\nDomani piove."


def test_claude_error_result():
    parser = ClaudeStreamParser()
    _feed(parser, [_line(type="result", subtype="error_during_execution", is_error=True, result="Credit balance is too low")])
    assert parser.error == "Credit balance is too low"


def test_claude_result_is_used_when_nothing_else_arrived():
    parser = ClaudeStreamParser()
    assert _feed(parser, [_line(type="result", subtype="success", is_error=False, result="Ok")]) == "Ok"


def test_codex_events():
    lines = [
        '{"type":"thread.started","thread_id":"01a0da72-d228-7992-830e-7959eb08a1df"}',
        '{"type":"turn.started"}',
        '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"penso..."}}',
        '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"ciao"}}',
        '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"come va?"}}',
        '{"type":"turn.completed","usage":{"input_tokens":13054}}',
    ]
    parser = CodexStreamParser()
    assert _feed(parser, lines) == "ciao\ncome va?"
    assert parser.thread_id == "01a0da72-d228-7992-830e-7959eb08a1df"
    assert parser.finished and parser.error is None


def test_codex_failure():
    parser = CodexStreamParser()
    _feed(parser, ['{"type":"turn.failed","error":{"message":"usage limit reached"}}'])
    assert parser.error == "usage limit reached"


def test_split_command_keeps_quoted_paths():
    parts = split_command('"C:/Program Files/agent/agent.exe" chat -q {prompt}')
    assert parts[0] == "C:/Program Files/agent/agent.exe"
    assert parts[-1] == "{prompt}"


def test_command_agent_puts_prompt_in_argv_or_stdin():
    with_placeholder = CommandAgentClient(f'"{sys.executable}" -c pass {{prompt}}')
    argv, stdin_text = with_placeholder.build("ciao & rm -rf /")
    assert argv[-1] == "ciao & rm -rf /" and stdin_text is None

    without = CommandAgentClient(f'"{sys.executable}" -c pass')
    argv, stdin_text = without.build("ciao")
    assert stdin_text == "ciao" and argv[-1] == "pass"


def test_stream_process_streams_lines_and_reports_failures():
    async def collect(argv, **kwargs):
        return [line async for line in stream_process(argv, **kwargs)]

    script = "import sys; print('uno'); print(sys.stdin.read().strip()); sys.stdout.flush()"
    assert asyncio.run(collect([sys.executable, "-c", script], stdin_text="due")) == ["uno", "due"]

    with pytest.raises(AgentError, match="rotto"):
        asyncio.run(collect([sys.executable, "-c", "import sys; sys.stderr.write('rotto'); sys.exit(3)"]))

    with pytest.raises(AgentError, match="secondi"):
        asyncio.run(collect([sys.executable, "-c", "import time; time.sleep(30)"], timeout=1))


def test_missing_program_is_reported_clearly():
    client = CommandAgentClient("programma-che-non-esiste-davvero --x")
    health = asyncio.run(client.health())
    assert health["ok"] is False and "non trovato" in health["error"]
