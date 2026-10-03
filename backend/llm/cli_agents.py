"""Agenti che si usano da riga di comando: Claude Code, Codex, Antigravity e un comando qualsiasi.

Tutti funzionano allo stesso modo: a ogni messaggio il companion lancia
il programma in modalita' non interattiva, gli passa il testo sullo standard
input e legge quello che stampa, riga per riga, mentre lo stampa. Cosi' il
personaggio comincia a parlare prima che l'agente abbia finito.

Formati verificati dal vivo (settembre 2026):

* ``claude -p --output-format stream-json --verbose --include-partial-messages``
  stampa un oggetto JSON per riga. Il testo arriva a pezzi in
  ``stream_event`` -> ``content_block_delta`` -> ``text_delta``; il messaggio
  completo arriva *anche* dopo, come evento ``assistant`` (da ignorare se lo
  abbiamo gia' letto a pezzi). I ``thinking_delta`` sono il ragionamento: mai
  letti ad alta voce. L'ultimo evento e' ``result``, con ``session_id`` per
  riprendere la conversazione con ``--resume``.
* ``codex exec --json`` stampa ``thread.started`` (con ``thread_id``), poi un
  ``item.completed`` di tipo ``agent_message`` per ogni messaggio e infine
  ``turn.completed`` (o ``turn.failed``). Si riprende con
  ``codex exec resume <thread_id> -``.
* ``agy --output-format stream-json --print=<testo>`` (Antigravity 1.2) stampa
  ``init`` (con ``conversation_id``), poi ``step_update`` per ogni passo: il
  testo arriva in ``text_delta`` dei passi ``agent_response``, i tool sono passi
  ``tool``. L'ultimo e' ``result``, con ``denied_actions`` se un tool chiedeva
  un permesso che senza finestra non si puo' dare. Si riprende con
  ``--conversation <id>``. Il prompt va attaccato al flag: ``-p testo`` si
  prenderebbe il flag successivo come prompt.

I processi girano in thread normali e non con ``asyncio.create_subprocess_*``:
su Windows quello funziona solo con il ProactorEventLoop, e uvicorn con
``--reload`` usa il Selector. Un thread per stdout e' portabile ovunque.
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
from pathlib import Path
from typing import Any

from .activity import describe_antigravity_tool, describe_claude_tool, describe_codex_item
from .base import Activity, LLMClient, Message, describe_error, last_user_message, last_user_text, speech_directive

logger = logging.getLogger(__name__)

#: Come deve rispondere un agente la cui risposta verra' letta ad alta voce.
#: Va aggiunto ai vincoli di lingua, non li sostituisce.
SPOKEN_STYLE = (
    "Your reply is read aloud by a small 3D character that lives on the user's "
    "desktop. Answer in at most three short sentences of plain spoken text: no "
    "markdown, no lists, no code blocks, no tables, no emoji. If you use tools, "
    "say only what you found."
)

_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
_EOF = object()


class AgentError(RuntimeError):
    """L'agente ha risposto con un errore o e' uscito male."""


# ---------------------------------------------------------------------------
# Processi
# ---------------------------------------------------------------------------
def resolve_executable(command: str) -> str | None:
    """Percorso completo di un programma, cercando anche le estensioni di Windows."""
    command = (command or "").strip().strip('"')
    if not command:
        return None
    candidate = Path(command).expanduser()
    if candidate.is_file():
        return str(candidate)
    return shutil.which(command)


#: Lo script JavaScript lanciato da un .cmd di npm (o pnpm): "%dp0%\node_modules\...\cli.js".
_NPM_SHIM = re.compile(r'"%~?dp0%?\\([^"]+?\.[cm]?js)"', re.IGNORECASE)


def unwrap_npm_shim(path: str) -> list[str] | None:
    """``gemini.cmd`` installato da npm -> ``[node, .../cli.js]``, senza cmd.exe in mezzo.

    Cosi' il messaggio puo' stare negli argomenti senza che cmd.exe ne esegua i
    caratteri speciali. ``None`` se il file non e' un involucro di npm.
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
    """Chiude il processo e i suoi figli (gli agenti ne lanciano parecchi)."""
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
    """Lancia ``argv`` e produce le righe di stdout man mano che arrivano.

    Se il processo esce con un codice diverso da zero solleva ``AgentError``
    con le ultime righe di stderr. Se il chiamante smette di leggere (turno
    interrotto) il processo viene chiuso insieme ai suoi figli.
    """
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[Any] = asyncio.Queue()
    stderr_tail: deque[str] = deque(maxlen=30)

    if argv and argv[0].lower().endswith((".cmd", ".bat")):
        # Un .cmd passa dall'interprete di comandi: i caratteri speciali del
        # messaggio (& | > ...) verrebbero eseguiti. Il testo quindi va solo
        # sullo standard input, mai negli argomenti.
        argv = ["cmd.exe", "/d", "/c", *argv]

    process = subprocess.Popen(
        argv,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=cwd or None,
        # TSUKUMO_INTERNAL: gli hook di Claude Code e Codex (scripts/tsukumo_notify.py)
        # non devono avvisare di una risposta che il companion sta gia' dicendo.
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
            pass  # il programma non legge lo stdin: non e' un errore

    for target in (pump_stdout, pump_stderr, feed_stdin):
        threading.Thread(target=target, daemon=True).start()

    deadline = loop.time() + max(5.0, timeout)
    try:
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise AgentError(f"Nessuna risposta completa in {timeout:.0f} secondi")
            item = await asyncio.wait_for(queue.get(), remaining)
            if item is _EOF:
                break
            yield item

        code = await asyncio.to_thread(process.wait)
        if code != 0:
            detail = " | ".join(list(stderr_tail)[-4:]) or f"codice di uscita {code}"
            raise AgentError(detail)
    except asyncio.TimeoutError as exc:
        raise AgentError(f"Nessuna risposta completa in {timeout:.0f} secondi") from exc
    finally:
        if process.poll() is None:
            await asyncio.to_thread(_kill_tree, process)


def _run_quick(argv: list[str], timeout: float = 8.0) -> str:
    """Esegue un comando brevissimo (``--version``) e ne restituisce l'output."""
    try:
        result = subprocess.run(
            argv,
            capture_output=True,
            timeout=timeout,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return f"errore: {describe_error(exc)}"
    output = (result.stdout or result.stderr).decode("utf-8", "replace").strip()
    return output.splitlines()[0] if output else ""


# ---------------------------------------------------------------------------
# Sessione persistente su disco
# ---------------------------------------------------------------------------
class _SessionFile:
    """Ricorda l'id della conversazione dell'agente tra un riavvio e l'altro."""

    def __init__(self, path: Path | None, scope: str) -> None:
        self.path = path
        #: Cambiando cartella di lavoro o modello la conversazione ricomincia.
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
            logger.warning("Sessione dell'agente non salvata: %s", exc)

    def clear(self) -> None:
        if self.path and self.path.is_file():
            try:
                self.path.unlink()
            except OSError as exc:
                logger.warning("Sessione dell'agente non cancellata: %s", exc)


class _CLIAgent(LLMClient):
    """Parti comuni: eseguibile, cartella, sessione, stato."""

    stateful = True
    #: Nome leggibile, per i messaggi d'errore.
    label = "agente"

    def __init__(self, executable: str | None, cwd: str, timeout: float, session_path: Path | None, scope: str) -> None:
        self.executable = executable
        self.cwd = str(Path(cwd).expanduser()) if cwd else str(Path.home())
        self.timeout = timeout
        self.session = _SessionFile(session_path, scope)
        self.session_id: str | None = self.session.load()
        self._version: str | None = None

    def _require_executable(self) -> str:
        if not self.executable:
            raise AgentError(f"{self.label}: programma non trovato. Installalo o indica il percorso nel pannello.")
        return self.executable

    async def reset(self) -> None:
        self.session_id = None
        self.session.clear()
        logger.info("%s: conversazione azzerata", self.label)

    async def health(self) -> dict[str, Any]:
        if not self.executable:
            return {
                "backend": self.name,
                "ok": False,
                "error": f"{self.label} non trovato",
                "hint": "Installalo, oppure scrivi il percorso completo nel campo Programma.",
            }
        if not Path(self.cwd).is_dir():
            return {"backend": self.name, "ok": False, "error": f"Cartella di lavoro inesistente: {self.cwd}"}
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
    """Trasforma gli eventi ``stream-json`` di Claude Code in frammenti di testo.

    Separato dal client per poterlo provare con righe registrate dal vivo.
    """

    def __init__(self) -> None:
        self.session_id: str | None = None
        self.finished = False
        self.error: str | None = None
        self._current: str | None = None
        self._last: str | None = None
        self._streamed: set[str] = set()
        self._produced = False
        #: Tool usati dall'agente, da raccontare mentre lavora (vedi ``take_activities``).
        self.activities: list[Activity] = []
        self._tools: set[str] = set()

    def take_activities(self) -> list[Activity]:
        """I passi di lavoro arrivati dall'ultima chiamata, e svuota la lista."""
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
        # Gli eventi dei sotto-agenti (parent_tool_use_id valorizzato) sono
        # lavoro interno: si legge solo quello che l'agente dice a te.
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
                    self.activities.append(describe_claude_tool(str(block.get("name") or ""), block.get("input")))
            if message.get("id") in self._streamed:
                return []  # gia' letto a pezzi: questo e' il riepilogo
            text = "".join(
                block.get("text", "") for block in message.get("content") or [] if block.get("type") == "text"
            )
            return self._emit(text, message.get("id"), streamed=False) if text else []

        if kind == "result":
            self.finished = True
            if event.get("is_error") or event.get("subtype") not in (None, "success"):
                errors = event.get("errors") or []
                self.error = str(event.get("result") or "; ".join(map(str, errors)) or event.get("subtype") or "errore")
                return []
            if not self._produced and event.get("result"):
                return self._emit(str(event["result"]), None, streamed=False)
        return []

    def _emit(self, text: str, message_id: str | None, streamed: bool) -> list[str]:
        # Un messaggio nuovo (per esempio dopo aver usato un tool) e' una
        # frase nuova: l'a capo la fa pronunciare separata dalla precedente.
        pieces = ["\n"] if self._produced and message_id != self._last else []
        if streamed and message_id:
            self._streamed.add(message_id)
        self._last = message_id
        pieces.append(text)
        self._produced = True
        return pieces


class ClaudeCodeClient(_CLIAgent):
    """Claude Code in modalita' ``--print``, con sessione ripresa a ogni turno."""

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
            # I file che gli hai passato possono stare fuori dalla sua cartella.
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
            parser = ClaudeStreamParser()
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
                    # La sessione salvata non esiste piu' (cancellata, o di un
                    # altro account): si riparte con una conversazione nuova.
                    logger.warning("Sessione di Claude Code non ripresa (%s): ne apro una nuova", exc)
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
    """``codex`` nel PATH, oppure quello incluso nell'estensione per VS Code/Cursor."""
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
    """Trasforma gli eventi JSONL di ``codex exec --json`` in frammenti di testo."""

    def __init__(self) -> None:
        self.thread_id: str | None = None
        self.finished = False
        self.error: str | None = None
        self._produced = False
        #: Comandi, modifiche e ricerche dell'agente (vedi ``take_activities``).
        self.activities: list[Activity] = []
        self._items: set[str] = set()

    def take_activities(self) -> list[Activity]:
        """I passi di lavoro arrivati dall'ultima chiamata, e svuota la lista."""
        taken, self.activities = self.activities, []
        return taken

    def _track(self, item: dict[str, Any]) -> None:
        # Un comando arriva due volte (iniziato, finito): si racconta una volta.
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
        elif kind == "item.started":
            self._track(event.get("item") or {})
        elif kind == "item.completed":
            item = event.get("item") or {}
            self._track(item)
            # "reasoning" e' il ragionamento interno: mai letto ad alta voce.
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
            self.error = message or event.get("message") or "turno fallito"
        return []


class CodexClient(_CLIAgent):
    """Codex in modalita' ``exec``, con il thread ripreso a ogni turno."""

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
            # -i accetta piu' valori: dopo deve sempre venire un'altra opzione (-C).
            argv += ["-i", image]
        if self.model:
            argv += ["-m", self.model]
        argv += ["-C", self.cwd]
        if self.session_id:
            argv += ["resume", self.session_id]
        argv.append("-")  # il messaggio arriva dallo standard input
        return argv

    def _login_problem(self) -> str | None:
        home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
        if not (home / "auth.json").is_file():
            return "Login non fatto: esegui `codex login` (o accedi dall'estensione)"
        return None

    async def stream(self, messages: list[Message]) -> AsyncIterator[str]:
        text = last_user_text(messages)
        if not text:
            return
        directive = speech_directive(messages)
        prompt = f"[{SPOKEN_STYLE} {directive}]\n\n{text}"
        last = last_user_message(messages)
        parser = CodexStreamParser()
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
#: Ogni 15 minuti ``agy`` lancia un aggiornatore staccato da ogni console
#: (``agy --bg-updater``) che esegue ``agy --version``: senza una console da
#: ereditare, Windows gliene apre una nuova e un terminale lampeggia a ogni
#: messaggio. Spento solo per i turni del companion: da VS Code o dal
#: terminale Antigravity continua ad aggiornarsi. Vale "true", non "1".
ANTIGRAVITY_ENV = {"AGY_CLI_DISABLE_AUTO_UPDATE": "true"}


def find_antigravity(explicit: str = "") -> str | None:
    """``agy`` nel PATH, oppure quello che l'app e l'estensione mettono in ``~/.gemini/bin``."""
    found = resolve_executable(explicit) if explicit else shutil.which("agy")
    if found:
        return found
    candidate = Path.home() / ".gemini" / "bin" / ("agy.exe" if os.name == "nt" else "agy")
    return str(candidate) if candidate.is_file() else None


class AntigravityStreamParser:
    """Trasforma gli eventi ``stream-json`` di ``agy`` in frammenti di testo."""

    def __init__(self) -> None:
        self.conversation_id: str | None = None
        self.finished = False
        self.error: str | None = None
        #: Errore che il riepilogo si porta dietro da un turno precedente, a risposta gia' completa.
        self.stale_error: str | None = None
        #: Tool rifiutati perche' chiedevano un permesso (senza finestra non si puo' dare).
        self.denied: list[str] = []
        self.activities: list[Activity] = []
        self._produced = False
        self._answered = False
        self._last_step: Any = None
        self._tools: set[Any] = set()

    def take_activities(self) -> list[Activity]:
        """I passi di lavoro arrivati dall'ultima chiamata, e svuota la lista."""
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
                # Un tool arriva due volte (iniziato, finito): si racconta una volta.
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
                # Il risultato riassume tutta la conversazione: un turno interrotto
                # una volta la lascia in ERROR per sempre, anche quando la risposta
                # di adesso e' arrivata fino in fondo. Quella vale, l'errore no.
                if self._answered:
                    self.stale_error = error
                    return []
                self.error = error
                return []
            if not self._produced and result.get("response"):
                return self._emit(str(result["response"]), None)
        elif kind == "error":
            error = event.get("error")
            self.error = str((error.get("message") if isinstance(error, dict) else error) or event.get("message") or "errore")
        return []

    def _emit(self, text: str, step: Any) -> list[str]:
        # Un passo nuovo (per esempio dopo un tool) e' una frase nuova.
        pieces = ["\n"] if self._produced and step != self._last_step else []
        self._last_step = step
        pieces.append(text)
        self._produced = True
        return pieces


class AntigravityClient(_CLIAgent):
    """Antigravity in modalita' ``--print``, con la conversazione ripresa a ogni turno."""

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
            raise AgentError("Antigravity: indica agy.exe, non uno script .cmd (il messaggio passa negli argomenti).")
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
                    # La conversazione salvata non esiste piu': se ne apre una nuova.
                    logger.warning("Conversazione di Antigravity non ripresa (%s): ne apro una nuova", exc)
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
            logger.info("Antigravity ha risposto, ma la conversazione riporta ancora: %s", parser.stale_error)
        if parser.denied and not produced:
            raise AgentError(
                f"Antigravity voleva usare {', '.join(parser.denied)}, ma senza la sua finestra non può "
                "chiederti il permesso. Consentilo nelle sue impostazioni (permissions.allow) oppure "
                "cambia i Permessi nella scheda Motori."
            )


# ---------------------------------------------------------------------------
# Un comando qualsiasi
# ---------------------------------------------------------------------------
def split_command(command: str) -> list[str]:
    """Divide una riga di comando come farebbe il terminale, virgolette comprese."""
    if os.name == "nt":
        parts = shlex.split(command, posix=False)
        return [part[1:-1] if len(part) >= 2 and part[0] == part[-1] == '"' else part for part in parts]
    return shlex.split(command)


#: Quanti scambi recenti si ricordano a un comando, che a ogni lancio riparte da zero.
COMMAND_MEMORY = 3


class CommandAgentClient(_CLIAgent):
    """Lancia un comando a scelta e legge quello che stampa come risposta.

    Serve sia per "Altro agente" sia per gli agenti con un comando gia' pronto
    (Gemini CLI, Cline, Cursor...): ``name`` e ``label`` dicono quale.
    """

    name = "command"
    label = "Il comando"

    def __init__(
        self, command: str, cwd: str = "", timeout: float = 300.0, name: str = "command", label: str = "Il comando"
    ) -> None:
        self.name = name
        self.label = label
        self.template = split_command(command) if command.strip() else []
        executable = resolve_executable(self.template[0]) if self.template else None
        super().__init__(executable, cwd, timeout, None, scope="")
        #: Gli ultimi scambi (domanda, risposta), rimandati a ogni lancio.
        self._recent: deque[tuple[str, str]] = deque(maxlen=COMMAND_MEMORY)

    def build(self, text: str) -> tuple[list[str], str | None]:
        """argv e testo per lo stdin: ``{prompt}`` negli argomenti, altrimenti stdin."""
        executable = self._require_executable()
        rest = self.template[1:]
        if any("{prompt}" in part for part in rest):
            head = [executable]
            if executable.lower().endswith((".cmd", ".bat")):
                # Un .cmd di npm si puo' saltare lanciando direttamente node.
                head = unwrap_npm_shim(executable) or []
                if not head:
                    raise AgentError(
                        "Questo programma è uno script .cmd: per sicurezza il messaggio "
                        "non può stare negli argomenti. Togli {prompt} e verrà passato "
                        "sullo standard input."
                    )
            return [*head, *(part.replace("{prompt}", text) for part in rest)], None
        return [executable, *rest], text

    def compose(self, text: str, directive: str) -> str:
        """Il messaggio da mandare: vincoli del parlato, scambi recenti e domanda."""
        parts = [f"[{SPOKEN_STYLE} {directive}]"]
        if self._recent:
            said = "\n".join(f"User: {asked}\nYou: {answered}" for asked, answered in self._recent)
            parts.append(f"[Conversation so far, since you don't keep memory between runs:\n{said}]")
        parts.append(text)
        return "\n\n".join(parts)

    async def health(self) -> dict[str, Any]:
        if not self.template:
            return {"backend": self.name, "ok": False, "error": "Nessun comando impostato"}
        return await super().health()

    async def reset(self) -> None:
        """Il comando non tiene una sessione: si dimenticano solo gli scambi recenti."""
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
        logger.info("%s: risposta in %.1fs", self.label, time.monotonic() - started)
