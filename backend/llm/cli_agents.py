"""Agents used from the command line: Claude Code, Codex, Antigravity and any command.

They all work the same way: at every message the companion runs the program
in non-interactive mode, passes it the text on standard input and reads what
it prints, line by line, as it prints it. So the character starts speaking
before the agent has finished.

Formats verified live (September 2026):

* ``claude -p --output-format stream-json --verbose --include-partial-messages``
  prints one JSON object per line. The text arrives in pieces in
  ``stream_event`` -> ``content_block_delta`` -> ``text_delta``; the complete
  message arrives *also* afterwards, as an ``assistant`` event (to be ignored
  if we already read it in pieces). The ``thinking_delta``s are the
  reasoning: never read aloud. The last event is ``result``, with
  ``session_id`` to resume the conversation with ``--resume``.
* ``codex exec --json`` prints ``thread.started`` (with ``thread_id``), then
  an ``item.completed`` of type ``agent_message`` for every message and
  finally ``turn.completed`` (or ``turn.failed``). It resumes with
  ``codex exec resume <thread_id> -``.
* ``agy --output-format stream-json --print=<text>`` (Antigravity 1.2) prints
  ``init`` (with ``conversation_id``), then ``step_update`` for every step:
  the text arrives in ``text_delta`` of the ``agent_response`` steps, tools
  are ``tool`` steps. The last is ``result``, with ``denied_actions`` if a
  tool asked for a permission that can't be given without a window. It
  resumes with ``--conversation <id>``. The prompt must be attached to the
  flag: ``-p text`` would take the next flag as the prompt.

The processes run in normal threads and not with
``asyncio.create_subprocess_*``: on Windows that only works with the
ProactorEventLoop, and uvicorn with ``--reload`` uses the Selector. A thread
per stdout is portable everywhere.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shlex
import shutil
import subprocess
import threading
import time
from collections import deque
from collections.abc import AsyncIterator
from dataclasses import replace
from pathlib import Path
from typing import Any

from .activity import describe_antigravity_tool, describe_claude_tool, describe_codex_item
from .tasks import TASK_TOOLS, TaskList
from .base import Activity, LLMClient, Message, describe_error, last_user_message, last_user_text, speech_directive

logger = logging.getLogger(__name__)

#: How an agent whose reply will be read aloud must answer.
#: It's added to the language constraints, it doesn't replace them.
SPOKEN_STYLE = (
    "Your reply is read aloud by a small 3D character that lives on the user's "
    "desktop. Answer in at most three short sentences of plain spoken text: no "
    "markdown, no lists, no code blocks, no tables, no emoji. If you use tools, "
    "say only what you found."
)

_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
_EOF = object()


class AgentError(RuntimeError):
    """The agent answered with an error or exited badly."""


# ---------------------------------------------------------------------------
# Processes
# ---------------------------------------------------------------------------
def resolve_executable(command: str) -> str | None:
    """Full path of a program, looking for Windows' extensions too."""
    command = (command or "").strip().strip('"')
    if not command:
        return None
    candidate = Path(command).expanduser()
    if candidate.is_file():
        return str(candidate)
    return shutil.which(command)


#: The JavaScript script run by an npm (or pnpm) .cmd: "%dp0%\node_modules\...\cli.js".
_NPM_SHIM = re.compile(r'"%~?dp0%?\\([^"]+?\.[cm]?js)"', re.IGNORECASE)


def unwrap_npm_shim(path: str) -> list[str] | None:
    """``gemini.cmd`` installed by npm -> ``[node, .../cli.js]``, without cmd.exe in between.

    So the message can stay in the arguments without cmd.exe executing its
    special characters. ``None`` if the file isn't an npm wrapper.
    """
    try:
        text = Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    match = _NPM_SHIM.search(text)
    if not match:
        return None
    folder = Path(path).parent
    script = folder / match.group(1)
    if not script.is_file():
        return None
    local_node = folder / "node.exe"
    node = str(local_node) if local_node.is_file() else shutil.which("node")
    return [node, str(script)] if node else None


def _kill_tree(process: subprocess.Popen) -> None:
    """Closes the process and its children (agents start quite a few)."""
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW,
            check=False,
        )
    else:
        process.kill()


async def stream_process(
    argv: list[str],
    *,
    stdin_text: str | None = None,
    cwd: str | None = None,
    timeout: float = 300.0,
    env: dict[str, str] | None = None,
) -> AsyncIterator[str]:
    """Runs ``argv`` and yields the stdout lines as they arrive.

    If the process exits with a non-zero code it raises ``AgentError`` with the
    last lines of stderr. If the caller stops reading (interrupted turn) the
    process is closed together with its children.
    """
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[Any] = asyncio.Queue()
    stderr_tail: deque[str] = deque(maxlen=30)

    if argv and argv[0].lower().endswith((".cmd", ".bat")):
        # A .cmd goes through the command interpreter: the message's special
        # characters (& | > ...) would be executed. So the text goes only on
        # standard input, never in the arguments.
        argv = ["cmd.exe", "/d", "/c", *argv]

    process = subprocess.Popen(
        argv,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=cwd or None,
        # TSUKUMO_INTERNAL: Claude Code's and Codex's hooks (scripts/tsukumo_notify.py)
        # must not notify about a reply the companion is already saying.
        env={**os.environ, "TSUKUMO_INTERNAL": "1", **(env or {})},
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )

    def pump_stdout() -> None:
        assert process.stdout is not None
        for raw in iter(process.stdout.readline, b""):
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            loop.call_soon_threadsafe(queue.put_nowait, line)
        loop.call_soon_threadsafe(queue.put_nowait, _EOF)

    def pump_stderr() -> None:
        assert process.stderr is not None
        for raw in iter(process.stderr.readline, b""):
            text = _ANSI.sub("", raw.decode("utf-8", "replace")).strip()
            if text:
                stderr_tail.append(text)

    def feed_stdin() -> None:
        assert process.stdin is not None
        try:
            if stdin_text:
                process.stdin.write(stdin_text.encode("utf-8"))
            process.stdin.close()
        except OSError:
            pass  # the program doesn't read stdin: not an error

    for target in (pump_stdout, pump_stderr, feed_stdin):
        threading.Thread(target=target, daemon=True).start()

    deadline = loop.time() + max(5.0, timeout)
    try:
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise AgentError(f"No complete answer within {timeout:.0f} seconds")
            item = await asyncio.wait_for(queue.get(), remaining)
            if item is _EOF:
                break
            yield item

        code = await asyncio.to_thread(process.wait)
        if code != 0:
            detail = " | ".join(list(stderr_tail)[-4:]) or f"exit code {code}"
            raise AgentError(detail)
    except asyncio.TimeoutError as exc:
        raise AgentError(f"No complete answer within {timeout:.0f} seconds") from exc
    finally:
        if process.poll() is None:
            await asyncio.to_thread(_kill_tree, process)


def _run_quick(argv: list[str], timeout: float = 8.0) -> str:
    """Runs a very short command (``--version``) and returns its output."""
    try:
        result = subprocess.run(
            argv,
            capture_output=True,
            timeout=timeout,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return f"error: {describe_error(exc)}"
    output = (result.stdout or result.stderr).decode("utf-8", "replace").strip()
    return output.splitlines()[0] if output else ""


# ---------------------------------------------------------------------------
# Persistent session on disk
# ---------------------------------------------------------------------------
class _SessionFile:
    """Remembers the agent's conversation id from one restart to the next."""

    def __init__(self, path: Path | None, scope: str) -> None:
        self.path = path
        #: Changing working folder or model, the conversation starts over.
        self.scope = scope

    def load(self) -> str | None:
        if not self.path or not self.path.is_file():
            return None
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if data.get("scope") != self.scope:
            return None
        return data.get("sessionId") or None

    def save(self, session_id: str) -> None:
        if not self.path:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(
                json.dumps({"scope": self.scope, "sessionId": session_id}), encoding="utf-8"
            )
        except OSError as exc:
            logger.warning("Agent session not saved: %s", exc)

    def clear(self) -> None:
        if self.path and self.path.is_file():
            try:
                self.path.unlink()
            except OSError as exc:
                logger.warning("Agent session not deleted: %s", exc)


class _CLIAgent(LLMClient):
    """Shared parts: executable, folder, session, state."""

    stateful = True
    #: Readable name, for the error messages.
    label = "agent"

    def __init__(self, executable: str | None, cwd: str, timeout: float, session_path: Path | None, scope: str) -> None:
        self.executable = executable
        self.cwd = str(Path(cwd).expanduser()) if cwd else str(Path.home())
        self.timeout = timeout
        self.session = _SessionFile(session_path, scope)
        self.session_id: str | None = self.session.load()
        self._version: str | None = None
        #: The agent's task list: it lives as long as the session, from one turn to the next.
        self.tasks = TaskList()

    def _require_executable(self) -> str:
        if not self.executable:
            raise AgentError(f"{self.label}: program not found. Install it or set its path in the panel.")
        return self.executable

    async def reset(self) -> None:
        self.session_id = None
        self.session.clear()
        self.tasks.clear()
        logger.info("%s: conversation reset", self.label)

    async def health(self) -> dict[str, Any]:
        if not self.executable:
            return {
                "backend": self.name,
                "ok": False,
                "error": f"{self.label} not found",
                "hint": "Install it, or write the full path in the Program field.",
            }
        if not Path(self.cwd).is_dir():
            return {"backend": self.name, "ok": False, "error": f"Working folder doesn't exist: {self.cwd}"}
        if self._version is None:
            self._version = await asyncio.to_thread(_run_quick, [self.executable, "--version"])
        problem = self._login_problem()
        return {
            "backend": self.name,
            "ok": problem is None,
            "degraded": problem is not None,
            "error": problem,
            "model": self._version,
            "session": self.session_id,
        }

    def _login_problem(self) -> str | None:
        return None


# ---------------------------------------------------------------------------
# Claude Code
# ---------------------------------------------------------------------------
class ClaudeStreamParser:
    """Turns Claude Code's ``stream-json`` events into text chunks.

    Separate from the client so it can be tested with lines recorded live.
    """

    def __init__(self, tasks: TaskList | None = None) -> None:
        self.session_id: str | None = None
        self.finished = False
        self.error: str | None = None
        self.tasks = tasks if tasks is not None else TaskList()
        self._current: str | None = None
        self._last: str | None = None
        self._streamed: set[str] = set()
        self._produced = False
        #: Tools used by the agent, to tell while it works (see ``take_activities``).
        self.activities: list[Activity] = []
        self._tools: set[str] = set()

    def take_activities(self) -> list[Activity]:
        """The work steps arrived since the last call, emptying the list."""
        taken, self.activities = self.activities, []
        return taken

    def feed(self, line: str) -> list[str]:
        line = line.strip()
        if not line.startswith("{"):
            return []
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            return []

        kind = event.get("type")
        if event.get("session_id"):
            self.session_id = event["session_id"]
        # The sub-agents' events (parent_tool_use_id set) are internal work: only
        # what the agent says to you is read.
        if event.get("parent_tool_use_id"):
            return []

        if kind == "stream_event":
            inner = event.get("event") or {}
            inner_type = inner.get("type")
            if inner_type == "message_start":
                self._current = (inner.get("message") or {}).get("id")
                return []
            if inner_type == "content_block_delta":
                delta = inner.get("delta") or {}
                if delta.get("type") == "text_delta" and delta.get("text"):
                    return self._emit(delta["text"], self._current, streamed=True)
            return []

        if kind == "assistant":
            message = event.get("message") or {}
            for block in message.get("content") or []:
                if block.get("type") == "tool_use" and block.get("id") not in self._tools:
                    self._tools.add(block.get("id"))
                    name = str(block.get("name") or "")
                    activity = describe_claude_tool(name, block.get("input"))
                    if name in TASK_TOOLS and self.tasks.apply_claude(name, block.get("input"), call_id=str(block.get("id") or "")):
                        activity = replace(activity, tasks=tuple(self.tasks.public()))
                    self.activities.append(activity)
            if message.get("id") in self._streamed:
                return []  # already read in pieces: this is the summary
            text = "".join(
                block.get("text", "") for block in message.get("content") or [] if block.get("type") == "text"
            )
            return self._emit(text, message.get("id"), streamed=False) if text else []

        if kind == "user":
            # A TaskCreate's response carries the task's number ("Task #3 created").
            for block in (event.get("message") or {}).get("content") or []:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    if self.tasks.created(str(block.get("tool_use_id") or ""), block.get("content")):
                        self.activities.append(Activity("plan", "plans the work", "", "TaskCreate", tasks=tuple(self.tasks.public())))
            return []

        if kind == "result":
            self.finished = True
            if event.get("is_error") or event.get("subtype") not in (None, "success"):
                errors = event.get("errors") or []
                self.error = str(event.get("result") or "; ".join(map(str, errors)) or event.get("subtype") or "error")
                return []
            if not self._produced and event.get("result"):
                return self._emit(str(event["result"]), None, streamed=False)
        return []

    def _emit(self, text: str, message_id: str | None, streamed: bool) -> list[str]:
        # A new message (for example after using a tool) is a new sentence: the
        # newline makes it spoken separately from the previous one.
        pieces = ["\n"] if self._produced and message_id != self._last else []
        if streamed and message_id:
            self._streamed.add(message_id)
        self._last = message_id
        pieces.append(text)
        self._produced = True
        return pieces


class ClaudeCodeClient(_CLIAgent):
    """Claude Code in ``--print`` mode, with the session resumed at every turn."""

    name = "claude_code"
    label = "Claude Code"

    def __init__(
        self,
        command: str = "claude",
        model: str = "",
        cwd: str = "",
        allowed_tools: str = "",
        permission_mode: str = "default",
        timeout: float = 300.0,
        session_path: Path | None = None,
    ) -> None:
        self.model = model.strip()
        self.allowed_tools = allowed_tools.strip()
        self.permission_mode = permission_mode.strip() or "default"
        super().__init__(
            resolve_executable(command or "claude"),
            cwd,
            timeout,
            session_path,
            scope=f"{cwd}|{self.model}",
        )

    def build_argv(self, directive: str, folders: tuple[str, ...] = ()) -> list[str]:
        argv = [
            self._require_executable(),
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--append-system-prompt",
            f"{SPOKEN_STYLE} {directive}".strip(),
        ]
        if self.model:
            argv += ["--model", self.model]
        if self.session_id:
            argv += ["--resume", self.session_id]
        if self.allowed_tools:
            argv += ["--allowedTools", self.allowed_tools]
        if self.permission_mode != "default":
            argv += ["--permission-mode", self.permission_mode]
        if folders:
            # The files you passed it may be outside its folder.
            argv += ["--add-dir", *folders]
        return argv

    async def stream(self, messages: list[Message]) -> AsyncIterator[str]:
        text = last_user_text(messages)
        if not text:
            return
        directive = speech_directive(messages)
        last = last_user_message(messages)
        folders = last.folders if last else ()
        for attempt in (1, 2):
            parser = ClaudeStreamParser(self.tasks)
            produced = False
            try:
                async for line in stream_process(
                    self.build_argv(directive, folders), stdin_text=text, cwd=self.cwd, timeout=self.timeout
                ):
                    for piece in parser.feed(line):
                        produced = True
                        yield piece
                    for activity in parser.take_activities():
                        self.report(activity)
            except AgentError as exc:
                if parser.error:
                    raise AgentError(f"Claude Code: {parser.error}") from None
                if attempt == 1 and self.session_id and not produced and not parser.session_id:
                    # The saved session no longer exists (deleted, or of another account): we
                    # start again with a new conversation.
                    logger.warning("Claude Code session not resumed (%s): opening a new one", exc)
                    await self.reset()
                    continue
                raise
            break
        if parser.session_id and parser.session_id != self.session_id:
            self.session_id = parser.session_id
            self.session.save(parser.session_id)
        if parser.error:
            raise AgentError(f"Claude Code: {parser.error}")


# ---------------------------------------------------------------------------
# Codex
# ---------------------------------------------------------------------------
def find_codex(explicit: str = "") -> str | None:
    """``codex`` in the PATH, or the one bundled with the VS Code/Cursor extension."""
    found = resolve_executable(explicit) if explicit else shutil.which("codex")
    if found:
        return found
    name = "codex.exe" if os.name == "nt" else "codex"
    candidates: list[Path] = []
    for editor in (".vscode", ".vscode-insiders", ".cursor", ".windsurf"):
        root = Path.home() / editor / "extensions"
        if root.is_dir():
            candidates.extend(root.glob(f"openai.chatgpt-*/bin/*/{name}"))
    if not candidates:
        return None
    return str(max(candidates, key=lambda path: path.stat().st_mtime))


class CodexStreamParser:
    """Turns the JSONL events of ``codex exec --json`` into text chunks."""

    def __init__(self, tasks: TaskList | None = None) -> None:
        self.thread_id: str | None = None
        self.finished = False
        self.error: str | None = None
        self.tasks = tasks if tasks is not None else TaskList()
        self._produced = False
        #: The agent's commands, changes and searches (see ``take_activities``).
        self.activities: list[Activity] = []
        self._items: set[str] = set()

    def take_activities(self) -> list[Activity]:
        """The work steps arrived since the last call, emptying the list."""
        taken, self.activities = self.activities, []
        return taken

    def _track(self, item: dict[str, Any]) -> None:
        # The task list changes several times (started, updated, finished): every time counts.
        if item.get("type") == "todo_list":
            if self.tasks.apply_codex(item):
                self.activities.append(Activity("plan", "plans the work", "", "todo_list", tasks=tuple(self.tasks.public())))
            return
        # A command arrives twice (started, finished): it's told once.
        item_id = str(item.get("id") or "")
        if item_id and item_id in self._items:
            return
        activity = describe_codex_item(item)
        if activity is not None:
            if item_id:
                self._items.add(item_id)
            self.activities.append(activity)

    def feed(self, line: str) -> list[str]:
        line = line.strip()
        if not line.startswith("{"):
            return []
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            return []

        kind = event.get("type")
        if kind == "thread.started":
            self.thread_id = event.get("thread_id") or self.thread_id
        elif kind in ("item.started", "item.updated"):
            self._track(event.get("item") or {})
        elif kind == "item.completed":
            item = event.get("item") or {}
            self._track(item)
            # "reasoning" is the internal reasoning: never read aloud.
            if item.get("type") == "agent_message" and item.get("text"):
                pieces = ["\n"] if self._produced else []
                pieces.append(item["text"])
                self._produced = True
                return pieces
        elif kind == "turn.completed":
            self.finished = True
        elif kind in ("turn.failed", "error"):
            self.finished = kind == "turn.failed"
            error = event.get("error") or {}
            message = error.get("message") if isinstance(error, dict) else str(error)
            self.error = message or event.get("message") or "turn failed"
        return []


class CodexClient(_CLIAgent):
    """Codex in ``exec`` mode, with the thread resumed at every turn."""

    name = "codex"
    label = "Codex"

    def __init__(
        self,
        command: str = "",
        model: str = "",
        cwd: str = "",
        sandbox: str = "read-only",
        timeout: float = 300.0,
        session_path: Path | None = None,
    ) -> None:
        self.model = model.strip()
        self.sandbox = sandbox.strip() or "read-only"
        super().__init__(find_codex(command), cwd, timeout, session_path, scope=f"{cwd}|{self.model}")

    def build_argv(self, images: tuple[str, ...] = ()) -> list[str]:
        argv = [self._require_executable(), "exec", "--json", "--skip-git-repo-check", "-s", self.sandbox]
        for image in images:
            # -i accepts several values: another option (-C) must always come after it.
            argv += ["-i", image]
        if self.model:
            argv += ["-m", self.model]
        argv += ["-C", self.cwd]
        if self.session_id:
            argv += ["resume", self.session_id]
        argv.append("-")  # the message arrives on standard input
        return argv

    def _login_problem(self) -> str | None:
        home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
        if not (home / "auth.json").is_file():
            return "Not signed in: run `codex login` (or sign in from the extension)"
        return None

    async def stream(self, messages: list[Message]) -> AsyncIterator[str]:
        text = last_user_text(messages)
        if not text:
            return
        directive = speech_directive(messages)
        prompt = f"[{SPOKEN_STYLE} {directive}]\n\n{text}"
        last = last_user_message(messages)
        parser = CodexStreamParser(self.tasks)
        try:
            argv = self.build_argv(last.images if last else ())
            async for line in stream_process(argv, stdin_text=prompt, cwd=self.cwd, timeout=self.timeout):
                for piece in parser.feed(line):
                    yield piece
                for activity in parser.take_activities():
                    self.report(activity)
        except AgentError:
            if parser.error:
                raise AgentError(f"Codex: {parser.error}") from None
            raise
        if parser.thread_id and parser.thread_id != self.session_id:
            self.session_id = parser.thread_id
            self.session.save(parser.thread_id)
        if parser.error:
            raise AgentError(f"Codex: {parser.error}")


# ---------------------------------------------------------------------------
# Antigravity
# ---------------------------------------------------------------------------
#: Every 15 minutes ``agy`` starts an updater detached from any console
#: (``agy --bg-updater``) that runs ``agy --version``: with no console to
#: inherit, Windows opens a new one and a terminal flashes at every message.
#: Turned off only for the companion's turns: from VS Code or the terminal
#: Antigravity keeps updating. The value is "true", not "1".
ANTIGRAVITY_ENV = {"AGY_CLI_DISABLE_AUTO_UPDATE": "true"}


def find_antigravity(explicit: str = "") -> str | None:
    """``agy`` in the PATH, or the one the app and the extension put in ``~/.gemini/bin``."""
    found = resolve_executable(explicit) if explicit else shutil.which("agy")
    if found:
        return found
    candidate = Path.home() / ".gemini" / "bin" / ("agy.exe" if os.name == "nt" else "agy")
    return str(candidate) if candidate.is_file() else None


class AntigravityStreamParser:
    """Turns ``agy``'s ``stream-json`` events into text chunks."""

    def __init__(self) -> None:
        self.conversation_id: str | None = None
        self.finished = False
        self.error: str | None = None
        #: An error the summary carries over from a previous turn, with the reply already complete.
        self.stale_error: str | None = None
        #: Tools refused because they asked for a permission (it can't be given without a window).
        self.denied: list[str] = []
        self.activities: list[Activity] = []
        self._produced = False
        self._answered = False
        self._last_step: Any = None
        self._tools: set[Any] = set()

    def take_activities(self) -> list[Activity]:
        """The work steps arrived since the last call, emptying the list."""
        taken, self.activities = self.activities, []
        return taken

    def feed(self, line: str) -> list[str]:
        line = line.strip()
        if not line.startswith("{"):
            return []
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            return []

        kind = event.get("event")
        if kind == "init":
            self.conversation_id = event.get("conversation_id") or self.conversation_id
        elif kind == "step_update":
            step = event.get("step_update") or {}
            self.conversation_id = step.get("conversation_id") or self.conversation_id
            index = step.get("step_index")
            if step.get("step_type") == "agent_response":
                if step.get("state") == "DONE":
                    self._answered = True
                if step.get("text_delta"):
                    return self._emit(str(step["text_delta"]), index)
            if step.get("step_type") == "tool" and index not in self._tools:
                # A tool arrives twice (started, finished): it's told once.
                self._tools.add(index)
                info = step.get("tool_info") or {}
                activity = describe_antigravity_tool(str(step.get("tool_name") or info.get("name") or ""), info.get("parameters"))
                if activity is not None:
                    self.activities.append(activity)
        elif kind == "result":
            result = event.get("result") or {}
            self.finished = True
            self.conversation_id = result.get("conversation_id") or self.conversation_id
            self.denied = [
                str(action.get("display_name") or action.get("action") or "")
                for action in result.get("denied_actions") or []
                if isinstance(action, dict)
            ]
            status = str(result.get("status") or "SUCCESS")
            if status != "SUCCESS":
                error = str(result.get("error") or result.get("response") or status)
                # The result sums up the whole conversation: a turn interrupted once
                # leaves it in ERROR forever, even when the current reply arrived in full.
                # That reply counts, the error doesn't.
                if self._answered:
                    self.stale_error = error
                    return []
                self.error = error
                return []
            if not self._produced and result.get("response"):
                return self._emit(str(result["response"]), None)
        elif kind == "error":
            error = event.get("error")
            self.error = str((error.get("message") if isinstance(error, dict) else error) or event.get("message") or "error")
        return []

    def _emit(self, text: str, step: Any) -> list[str]:
        # A new step (for example after a tool) is a new sentence.
        pieces = ["\n"] if self._produced and step != self._last_step else []
        self._last_step = step
        pieces.append(text)
        self._produced = True
        return pieces


class AntigravityClient(_CLIAgent):
    """Antigravity in ``--print`` mode, with the conversation resumed at every turn."""

    name = "antigravity"
    label = "Antigravity"

    def __init__(
        self,
        command: str = "",
        model: str = "",
        cwd: str = "",
        permission: str = "default",
        timeout: float = 300.0,
        session_path: Path | None = None,
    ) -> None:
        self.model = model.strip()
        self.permission = permission.strip() or "default"
        super().__init__(find_antigravity(command), cwd, timeout, session_path, scope=f"{cwd}|{self.model}")

    def build_argv(self, prompt: str, folders: tuple[str, ...] = ()) -> list[str]:
        executable = self._require_executable()
        if executable.lower().endswith((".cmd", ".bat")):
            raise AgentError("Antigravity: point it to agy.exe, not a .cmd script (the message goes in the arguments).")
        argv = [executable, "--output-format", "stream-json"]
        if self.model:
            argv += ["--model", self.model]
        if self.session_id:
            argv += ["--conversation", self.session_id]
        if self.permission == "skip":
            argv.append("--dangerously-skip-permissions")
        elif self.permission in ("plan", "accept-edits"):
            argv += ["--mode", self.permission]
        for folder in folders:
            argv += ["--add-dir", folder]
        argv.append(f"--print={prompt}")
        return argv

    async def stream(self, messages: list[Message]) -> AsyncIterator[str]:
        text = last_user_text(messages)
        if not text:
            return
        prompt = f"[{SPOKEN_STYLE} {speech_directive(messages)}]\n\n{text}"
        last = last_user_message(messages)
        folders = last.folders if last else ()
        produced = False
        for attempt in (1, 2):
            parser = AntigravityStreamParser()
            try:
                argv = self.build_argv(prompt, folders)
                async for line in stream_process(argv, cwd=self.cwd, timeout=self.timeout, env=ANTIGRAVITY_ENV):
                    for piece in parser.feed(line):
                        produced = True
                        yield piece
                    for activity in parser.take_activities():
                        self.report(activity)
            except AgentError as exc:
                if parser.error:
                    raise AgentError(f"Antigravity: {parser.error}") from None
                if attempt == 1 and self.session_id and not produced and not parser.conversation_id:
                    # The saved conversation no longer exists: a new one is opened.
                    logger.warning("Antigravity conversation not resumed (%s): opening a new one", exc)
                    await self.reset()
                    continue
                raise
            break
        if parser.conversation_id and parser.conversation_id != self.session_id:
            self.session_id = parser.conversation_id
            self.session.save(parser.conversation_id)
        if parser.error:
            raise AgentError(f"Antigravity: {parser.error}")
        if parser.stale_error:
            logger.info("Antigravity answered, but the conversation still reports: %s", parser.stale_error)
        if parser.denied and not produced:
            raise AgentError(
                f"Antigravity wanted to use {', '.join(parser.denied)}, but without its window it can't "
                "ask you for permission. Allow it in its settings (permissions.allow) or "
                "change the Permissions in the Engines tab."
            )


# ---------------------------------------------------------------------------
# Any command
# ---------------------------------------------------------------------------
def split_command(command: str) -> list[str]:
    """Splits a command line as the terminal would, quotes included."""
    if os.name == "nt":
        parts = shlex.split(command, posix=False)
        return [part[1:-1] if len(part) >= 2 and part[0] == part[-1] == '"' else part for part in parts]
    return shlex.split(command)


#: How many recent exchanges a command remembers, since it starts from scratch at every run.
COMMAND_MEMORY = 3


class CommandAgentClient(_CLIAgent):
    """Runs a command of your choice and reads what it prints as the reply.

    It serves both "Another agent" and the agents with a ready-made command
    (Gemini CLI, Cline, Cursor...): ``name`` and ``label`` say which.
    """

    name = "command"
    label = "The command"

    def __init__(
        self, command: str, cwd: str = "", timeout: float = 300.0, name: str = "command", label: str = "The command"
    ) -> None:
        self.name = name
        self.label = label
        self.template = split_command(command) if command.strip() else []
        executable = resolve_executable(self.template[0]) if self.template else None
        super().__init__(executable, cwd, timeout, None, scope="")
        #: The last exchanges (question, answer), sent again at every run.
        self._recent: deque[tuple[str, str]] = deque(maxlen=COMMAND_MEMORY)

    def build(self, text: str) -> tuple[list[str], str | None]:
        """argv and the text for stdin: ``{prompt}`` in the arguments, otherwise stdin."""
        executable = self._require_executable()
        rest = self.template[1:]
        if any("{prompt}" in part for part in rest):
            head = [executable]
            if executable.lower().endswith((".cmd", ".bat")):
                # An npm .cmd can be skipped by running node directly.
                head = unwrap_npm_shim(executable) or []
                if not head:
                    raise AgentError(
                        "This program is a .cmd script: for safety the message "
                        "can't go in the arguments. Remove {prompt} and it will be passed "
                        "sullo standard input."
                    )
            return [*head, *(part.replace("{prompt}", text) for part in rest)], None
        return [executable, *rest], text

    def compose(self, text: str, directive: str) -> str:
        """The message to send: speech constraints, recent exchanges and question."""
        parts = [f"[{SPOKEN_STYLE} {directive}]"]
        if self._recent:
            said = "\n".join(f"User: {asked}\nYou: {answered}" for asked, answered in self._recent)
            parts.append(f"[Conversation so far, since you don't keep memory between runs:\n{said}]")
        parts.append(text)
        return "\n\n".join(parts)

    async def health(self) -> dict[str, Any]:
        if not self.template:
            return {"backend": self.name, "ok": False, "error": "No command set"}
        return await super().health()

    async def reset(self) -> None:
        """The command doesn't keep a session: only the recent exchanges are forgotten."""
        self._recent.clear()

    async def stream(self, messages: list[Message]) -> AsyncIterator[str]:
        text = last_user_text(messages)
        if not text:
            return
        argv, stdin_text = self.build(self.compose(text, speech_directive(messages)))
        started = time.monotonic()
        reply: list[str] = []
        async for line in stream_process(argv, stdin_text=stdin_text, cwd=self.cwd, timeout=self.timeout):
            clean = _ANSI.sub("", line).rstrip()
            if clean:
                reply.append(clean)
                yield clean + "\n"
        if reply:
            self._recent.append((text, " ".join(reply)[:600]))
        logger.info("%s: answered in %.1fs", self.label, time.monotonic() - started)
