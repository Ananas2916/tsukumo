"""Agenti da riga di comando: parser degli eventi e gestione dei processi.

Le righe JSON qui sotto sono ridotte da quelle stampate davvero da
``claude -p --output-format stream-json`` e ``codex exec --json`` (settembre 2026).
"""

import asyncio
import json
import sys

import pytest

from backend.llm.base import Message
from backend.llm.cli_agents import (
    AgentError,
    AntigravityClient,
    AntigravityStreamParser,
    ClaudeStreamParser,
    CodexStreamParser,
    CommandAgentClient,
    split_command,
    stream_process,
    unwrap_npm_shim,
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


# ---------------------------------------------------------------------------
# Antigravity: righe ridotte da quelle di `agy --output-format stream-json` 1.2.13
# ---------------------------------------------------------------------------
CONV = "e4d9734f-b475-41c1-8c14-b59c45d621b5"


def _agy(step_index, step_type, state="DONE", **extra):
    return _line(
        event="step_update",
        step_update={"conversation_id": CONV, "step_index": step_index, "state": state, "step_type": step_type, **extra},
    )


def test_antigravity_text_tools_and_conversation():
    lines = [
        _line(event="init", conversation_id=CONV, init={"cwd": "C:\\x", "permission_mode": "request-review"}),
        _agy(0, "user_input"),
        _agy(1, "agent_response", "ACTIVE", text_delta="Guardo la cartella."),
        _agy(
            2,
            "tool",
            "ACTIVE",
            tool_name="run_command",
            tool_info={"name": "run_command", "parameters": {"CommandLine": 'Get-ChildItem -Path "backend/llm"'}},
        ),
        _agy(2, "tool", "DONE", tool_name="run_command", tool_info={"name": "run_command", "parameters": {}}),
        _agy(3, "tool", "ACTIVE", tool_name="wait", tool_info={"name": "wait"}),
        _agy(4, "agent_response", "ACTIVE", text_delta="Sono dieci file."),
        _agy(4, "agent_response", "DONE", text_delta="\n"),
        _line(event="result", result={"conversation_id": CONV, "status": "SUCCESS", "response": "Sono dieci file.\n"}),
    ]
    parser = AntigravityStreamParser()
    assert _feed(parser, lines) == "Guardo la cartella.\nSono dieci file.\n"
    assert parser.conversation_id == CONV and parser.finished and parser.error is None
    # Il comando si racconta una volta sola; "wait" e' di servizio.
    assert [activity.label for activity in parser.take_activities()] == ["esegue Get-ChildItem"]


def test_antigravity_denied_tools_and_failures():
    parser = AntigravityStreamParser()
    _feed(
        parser,
        [
            _line(
                event="result",
                result={"conversation_id": CONV, "status": "SUCCESS", "response": "", "denied_actions": [{"action": "command", "display_name": "RunCommand"}]},
            )
        ],
    )
    assert parser.denied == ["RunCommand"] and parser.error is None

    failed = AntigravityStreamParser()
    _feed(failed, [_line(event="result", result={"status": "ERROR", "error": "quota esaurita"})])
    assert failed.error == "quota esaurita"


def test_antigravity_argv_attaches_the_prompt(tmp_path):
    agy = tmp_path / "agy.exe"
    agy.write_bytes(b"")
    client = AntigravityClient(command=str(agy), model="gemini-3.1-pro-high", permission="skip", session_path=tmp_path / "s.json")
    client.session_id = CONV
    argv = client.build_argv("-ciao & dir", ("C:/allegati",))
    assert argv[0] == str(agy)
    assert argv[argv.index("--model") + 1] == "gemini-3.1-pro-high"
    assert argv[argv.index("--conversation") + 1] == CONV
    assert "--dangerously-skip-permissions" in argv
    assert argv[argv.index("--add-dir") + 1] == "C:/allegati"
    # Attaccato al flag: un messaggio che comincia con "-" non diventa un'opzione.
    assert argv[-1] == "--print=-ciao & dir"


def test_antigravity_runs_without_its_self_updater(tmp_path, monkeypatch):
    # L'aggiornatore di agy apre una console visibile: nei turni del companion e' spento.
    seen = {}

    async def fake_stream(argv, **kwargs):
        seen.update(kwargs.get("env") or {})
        yield _line(event="result", result={"conversation_id": CONV, "status": "SUCCESS", "response": "ok"})

    monkeypatch.setattr("backend.llm.cli_agents.stream_process", fake_stream)
    agy = tmp_path / "agy.exe"
    agy.write_bytes(b"")
    client = AntigravityClient(command=str(agy), session_path=tmp_path / "s.json")

    async def turn():
        return [piece async for piece in client.stream([Message("user", "ciao")])]

    asyncio.run(turn())
    assert seen["AGY_CLI_DISABLE_AUTO_UPDATE"] == "true"


def test_npm_shim_is_unwrapped(tmp_path):
    script = tmp_path / "node_modules" / "@google" / "gemini-cli" / "dist" / "index.js"
    script.parent.mkdir(parents=True)
    script.write_text("")
    (tmp_path / "node.exe").write_bytes(b"")
    shim = tmp_path / "gemini.cmd"
    shim.write_text(
        '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n)\r\n'
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@google\\gemini-cli\\dist\\index.js" %*\r\n'
    )
    assert unwrap_npm_shim(str(shim)) == [str(tmp_path / "node.exe"), str(script)]

    # Col .cmd sbucciato il messaggio puo' stare negli argomenti, senza cmd.exe.
    client = CommandAgentClient(f'"{shim}" -p {{prompt}}', name="gemini_cli", label="Gemini CLI")
    argv, stdin_text = client.build("ciao & dir")
    assert argv == [str(tmp_path / "node.exe"), str(script), "-p", "ciao & dir"] and stdin_text is None

    other = tmp_path / "tool.cmd"
    other.write_text("@echo off\r\necho ciao\r\n")
    assert unwrap_npm_shim(str(other)) is None
    with pytest.raises(AgentError, match="cmd"):
        CommandAgentClient(f'"{other}" {{prompt}}').build("ciao")


def test_command_agent_remembers_the_last_exchanges():
    # Il "programma" risponde con l'ultima riga di quello che riceve.
    script = "import sys; print(sys.stdin.read().strip().splitlines()[-1].upper())"
    client = CommandAgentClient(f'"{sys.executable}" -c "{script}"', name="cline", label="Cline")

    async def turn(text):
        return "".join([piece async for piece in client.stream([Message("user", text)])])

    assert asyncio.run(turn("ciao")) == "CIAO\n"
    prompt = client.compose("e poi?", "")
    assert "User: ciao\nYou: CIAO" in prompt and prompt.endswith("e poi?")
    asyncio.run(client.reset())
    assert "Conversation so far" not in client.compose("e poi?", "")
