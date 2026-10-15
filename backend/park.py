"""The park: every agent online on this PC, and who talks to whom.

A playful tile for the dashboard. Who's on the lawn:

- the Claude Code sessions running now, from Claude Code's own registry
  ``~/.claude/sessions/<pid>.json`` (name, busy/idle, folder, editor or
  terminal, the pipe the other sessions write to). The ``<pid>.<hash>.key``
  files next to them are secrets: only ``*.json`` is ever opened;
- the other agents the hooks see (Codex & co., ``agents_board``), which also
  tell a Claude session's "waiting for you" and its task list;
- Tsukumo herself, OpenClaw (its gateway answers) and LM Studio (the kiosk,
  with the model it has loaded), probed by the server's loop.

What they do together comes from the live sessions' transcripts
(``~/.claude/projects/*/<sessionId>.jsonl``), read from where the last scan
stopped: messages sent to another session (SendMessage) or received from one,
helpers launched (subagents), Tsukumo's MCP tools used. Only who, to whom,
when and a one-line label are kept: never the body of a message.

``scan`` reads files: it runs in a thread, ``public`` on the event loop, and a
lock keeps them apart.
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from .agents_board import AgentBoard

#: What happened between them stays on the lawn this long.
LINK_TTL = 30 * 60
#: A helper (subagent) trots after its parent this long.
HELPER_TTL = 3 * 60
MAX_LINKS = 40
MAX_HELPERS = 4
#: The first read of a transcript starts this far from its end: the last half
#: hour fits in it, the day's history doesn't matter.
FIRST_READ = 512 * 1024
#: Never more than this in one scan (a session that wrote megabytes in 3 s).
MAX_READ = 2 * 1024 * 1024
#: The same message seen from both ends (sent here, received there) is one.
SAME_MESSAGE = 120
#: A session the hooks saw finish celebrates this long.
DONE_FOR = 10 * 60
#: A transcript not found yet is looked for again after this long.
LOOK_AGAIN = 30
LABEL = 70
WHERE = {"cli": "terminal", "claude-vscode": "vscode", "claude-desktop": "desktop", "claude-jetbrains": "jetbrains"}

#: The lines worth decoding: everything else is skipped without json.loads.
_INTERESTING = (b'"SendMessage"', b"cross-session-message", b'"Agent"', b'"Task"', b'"mcp__tsukumo__')
_RECEIVED = re.compile(r'<cross-session-message\s+from="([^"]*)"(?:\s+from-name="([^"]*)")?')
_REF = re.compile(r"\s*\[[^\]]*\]$")


def claude_home() -> Path:
    """Where Claude Code keeps its data (``CLAUDE_CONFIG_DIR`` moves it)."""
    custom = os.environ.get("CLAUDE_CONFIG_DIR", "").strip()
    return Path(custom).expanduser() if custom else Path.home() / ".claude"


def _label(value: Any) -> str:
    """The first line, short: a label, never the message."""
    text = str(value or "").strip().splitlines()[0] if str(value or "").strip() else ""
    text = " ".join(text.split())
    return text if len(text) <= LABEL else text[: LABEL - 1].rstrip() + "…"


def _time(value: Any) -> float:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return 0.0


def _texts(content: Any) -> Iterator[str]:
    """What the user (or a peer) wrote: plain text, never tool results, which
    can quote a transcript (this module's own tests, a grep) without it being
    a message."""
    if isinstance(content, str):
        yield content
    elif isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str):
                yield block["text"]


def events_of(entry: dict[str, Any]) -> list[dict[str, Any]]:
    """What one transcript line says about the others.

    ``message`` (sent to ``to``), ``received`` (from an address and a name),
    ``helper`` (a subagent launched), ``tsukumo`` (one of her MCP tools).
    """
    if not isinstance(entry, dict) or entry.get("isSidechain"):
        return []
    at = _time(entry.get("timestamp"))
    message = entry.get("message") if isinstance(entry.get("message"), dict) else {}
    content = message.get("content")
    found: list[dict[str, Any]] = []
    if entry.get("type") == "assistant" and isinstance(content, list):
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            name = str(block.get("name") or "")
            data = block.get("input") if isinstance(block.get("input"), dict) else {}
            if name == "SendMessage":
                to = str(data.get("to") or "").strip()
                if to:
                    found.append({"kind": "message", "to": to, "label": _label(data.get("summary") or data.get("message")), "at": at})
            elif name in ("Agent", "Task"):
                found.append({"kind": "helper", "label": _label(data.get("description") or data.get("subagent_type")), "at": at})
            elif name.startswith("mcp__tsukumo__"):
                found.append({"kind": "tsukumo", "label": name.removeprefix("mcp__tsukumo__"), "at": at})
    elif entry.get("type") == "user":
        for text in _texts(content):
            for match in _RECEIVED.finditer(text):
                found.append({"kind": "received", "from": match.group(1), "fromName": match.group(2) or "", "at": at})
    return found


# ---------------------------------------------------------------- processes
def alive(pid: int, started: Any = None) -> bool:
    """Is the session's process still there (and is it still that process)?"""
    if pid <= 0:
        return False
    if sys.platform == "win32":
        return _alive_windows(pid, started)
    try:
        os.kill(pid, 0)
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _alive_windows(pid: int, started: Any) -> bool:
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
    kernel32.GetProcessTimes.argtypes = (wintypes.HANDLE, *(ctypes.POINTER(wintypes.FILETIME),) * 4)
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return False
    try:
        code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value != 259:  # STILL_ACTIVE
            return False
        try:
            expected = int(started)
        except (TypeError, ValueError):
            return True
        times = [wintypes.FILETIME() for _ in range(4)]
        if not kernel32.GetProcessTimes(handle, *(ctypes.byref(item) for item in times)):
            return True
        created = (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime
        # A session that crashed left its file, and another program got its pid:
        # that one started at another moment (FILETIME, 100 ns steps).
        return abs(created - expected) < 10_000_000
    finally:
        kernel32.CloseHandle(handle)


def read_registry(home: Path) -> list[dict[str, Any]] | None:
    """Claude Code's running sessions as it writes them; None without a registry."""
    folder = home / "sessions"
    if not folder.is_dir():
        return None
    entries = []
    for path in folder.glob("*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(data, dict) and isinstance(data.get("pid"), int) and isinstance(data.get("sessionId"), str):
            entries.append(data)
    return entries


def find_transcript(home: Path, session_id: str) -> Path | None:
    if not re.fullmatch(r"[0-9A-Za-z-]{8,80}", session_id):
        return None
    return next((home / "projects").glob(f"*/{session_id}.jsonl"), None)


# --------------------------------------------------------------------- park
@dataclass
class _Tail:
    path: Path | None = None
    #: Where the next read starts; -1: never read.
    offset: int = -1
    looked: float = 0.0


class Park:
    def __init__(
        self,
        board: AgentBoard,
        home: Path | None = None,
        brain: Callable[[], str] = lambda: "",
        brain_session: Callable[[], str | None] = lambda: None,
        clock: Callable[[], float] = time.time,
        alive: Callable[[int, Any], bool] = alive,
    ) -> None:
        self.board = board
        self.home = home or claude_home()
        #: The active brain's id ("openclaw", "openai"...): who she asks while she works.
        self.brain = brain
        #: Her own Claude Code session, if that's her brain: she's drawn already.
        self.brain_session = brain_session
        self.clock = clock
        self.alive = alive
        self.registry = True
        self.sessions: dict[str, dict[str, Any]] = {}
        #: Pipe -> session and name -> session, kept for those who left too.
        self.addresses: dict[str, str] = {}
        self.names: dict[str, str] = {}
        self.tails: dict[str, _Tail] = {}
        self.links: list[dict[str, Any]] = []
        self.helpers: dict[str, list[dict[str, Any]]] = {}
        self.openclaw = False
        self.lmstudio: dict[str, Any] | None = None
        self._lock = threading.Lock()

    # ------------------------------------------------------------- scanning
    def scan(self) -> None:
        """Who's there and what they said since last time (files: in a thread)."""
        now = self.clock()
        entries = read_registry(self.home)
        live: dict[str, dict[str, Any]] = {}
        for entry in entries or []:
            if entry.get("sessionId") == self.brain_session() or not self.alive(entry["pid"], entry.get("procStart")):
                continue
            live[f"claude:{entry['sessionId']}"] = entry
        with self._lock:
            self.registry = entries is not None
            self.sessions = live
            if len(self.addresses) > 200:
                self.addresses.clear()
                self.names.clear()
            for ident, entry in live.items():
                if entry.get("messagingSocketPath"):
                    self.addresses[str(entry["messagingSocketPath"]).lower()] = ident
                if entry.get("name"):
                    self.names[str(entry["name"]).lower()] = ident
            for ident in [key for key in self.tails if key not in live]:
                del self.tails[ident]
        for ident, entry in live.items():
            events = self._read(ident, str(entry["sessionId"]), now)
            if events:
                with self._lock:
                    for event in events:
                        self._apply(ident, event, now)
        with self._lock:
            self.links = [link for link in self.links if now - link["at"] < LINK_TTL]
            for ident in list(self.helpers):
                kept = [item for item in self.helpers[ident] if now - item["at"] < HELPER_TTL and ident in live]
                if kept:
                    self.helpers[ident] = kept
                else:
                    del self.helpers[ident]

    def _read(self, ident: str, session_id: str, now: float) -> list[dict[str, Any]]:
        """The new whole lines of a session's transcript, as events."""
        tail = self.tails.setdefault(ident, _Tail())
        if tail.path is None:
            if tail.looked and now - tail.looked < LOOK_AGAIN:
                return []
            tail.looked = now
            tail.path = find_transcript(self.home, session_id)
            if tail.path is None:
                return []
        try:
            size = tail.path.stat().st_size
        except OSError:
            tail.path, tail.offset = None, -1
            return []
        # First time, or the file was rewritten: from near the end.
        start = max(0, size - FIRST_READ) if tail.offset < 0 or size < tail.offset else tail.offset
        start = max(start, size - MAX_READ)
        midline = start > 0 and start != tail.offset
        if start >= size:
            tail.offset = size
            return []
        try:
            with tail.path.open("rb") as handle:
                handle.seek(start)
                data = handle.read(size - start)
        except OSError:
            return []
        end = data.rfind(b"\n")
        if end < 0:  # half a line: it'll be whole next time
            tail.offset = start if not midline else size
            return []
        tail.offset = start + end + 1
        lines = data[: end + 1].split(b"\n")
        if midline:
            lines = lines[1:]
        events: list[dict[str, Any]] = []
        for raw in lines:
            if not any(key in raw for key in _INTERESTING):
                continue
            try:
                events.extend(events_of(json.loads(raw)))
            except ValueError:
                continue
        return events

    def _resolve(self, value: str) -> str | None:
        value = value.strip()
        if value.lower().startswith("uds:"):
            return self.addresses.get(value[4:].lower())
        value = _REF.sub("", value).lower()
        return self.names.get(value) or self.addresses.get(value)

    def _apply(self, ident: str, event: dict[str, Any], now: float) -> None:
        at = event.get("at") or now
        if now - at > LINK_TTL:
            return
        kind = event["kind"]
        if kind == "message":
            target = self._resolve(event["to"])
            if target and target != ident:
                self._link(ident, target, "message", event["label"], at)
        elif kind == "received":
            source = self._resolve(event["from"]) or self._resolve(event["fromName"])
            if source and source != ident:
                self._link(source, ident, "message", "", at)
        elif kind == "tsukumo":
            self._link(ident, "tsukumo", "tsukumo", event["label"], at)
        elif kind == "helper" and now - at < HELPER_TTL:
            helpers = self.helpers.setdefault(ident, [])
            if not any(item["at"] == at and item["label"] == event["label"] for item in helpers):
                helpers.append({"label": event["label"], "at": at})
                del helpers[:-MAX_HELPERS]

    def _link(self, source: str, target: str, kind: str, label: str, at: float) -> None:
        for link in self.links:
            if link["from"] != source or link["to"] != target or link["kind"] != kind or abs(link["at"] - at) > SAME_MESSAGE:
                continue
            # The two ends of the same message: the sender's side has the label.
            if not label or not link["label"] or link["label"] == label:
                if label and not link["label"]:
                    link["label"], link["at"] = label, at
                return
        self.links.append({"from": source, "to": target, "kind": kind, "label": label, "at": at})
        self.links.sort(key=lambda link: link["at"])
        del self.links[:-MAX_LINKS]

    def set_services(self, openclaw: bool, lmstudio: dict[str, Any] | None) -> None:
        with self._lock:
            self.openclaw, self.lmstudio = openclaw, lmstudio

    # ---------------------------------------------------------------- output
    def public(self) -> dict[str, Any]:
        now = self.clock()
        board = {item["key"]: item for item in self.board.public()}
        own = board.get("tsukumo") or {}
        agents: list[dict[str, Any]] = [
            {
                "id": "tsukumo",
                "kind": "tsukumo",
                "name": "Tsukumo",
                "brain": own.get("name") or "",
                "state": "working" if own.get("state") == "working" else "idle",
                "since": own.get("since") or 0,
            }
        ]
        with self._lock:
            for ident, entry in sorted(self.sessions.items(), key=lambda item: item[1].get("startedAt") or 0):
                agents.append(self._claude(ident, entry, board.get(ident), now))
            for key, item in board.items():
                if key == "tsukumo" or key in self.sessions:
                    continue
                # With the registry a Claude session it doesn't list has ended.
                if item["source"] == "claude" and self.registry:
                    continue
                if item["state"] not in ("working", "waiting") and now - item["updated"] > 2 * 3600:
                    continue
                agents.append(
                    {
                        "id": key,
                        "kind": item["source"],
                        "name": item["name"],
                        "project": item["project"],
                        "where": "",
                        "state": item["state"],
                        "since": item["since"],
                        "tasks": _count(item["tasks"]),
                        "helpers": [],
                    }
                )
            if self.openclaw:
                busy = self.brain() == "openclaw" and own.get("state") == "working"
                agents.append({"id": "openclaw", "kind": "openclaw", "name": "OpenClaw", "state": "working" if busy else "idle", "since": 0})
            links = [dict(link) for link in self.links]
            lmstudio = dict(self.lmstudio) if self.lmstudio else None
        # While she works she's asking her brain, if it lives in the park.
        if own.get("state") == "working":
            target = {"openclaw": "openclaw" if self.openclaw else "", "openai": "lmstudio" if lmstudio else ""}.get(self.brain(), "")
            if target:
                links.append({"from": "tsukumo", "to": target, "kind": "brain", "label": "", "at": own.get("since") or now})
        return {"agents": agents, "links": links, "lmstudio": lmstudio}

    def _claude(self, ident: str, entry: dict[str, Any], hook: dict[str, Any] | None, now: float) -> dict[str, Any]:
        busy = entry.get("status") == "busy"
        state = "working" if busy else "idle"
        since = (entry.get("statusUpdatedAt") or entry.get("startedAt") or 0) / 1000
        if hook:
            if hook["state"] == "waiting" and now - hook["updated"] < 3600:
                state, since = "waiting", hook["since"]
            elif hook["state"] == "done" and not busy and now - hook["since"] < DONE_FOR:
                state, since = "done", hook["since"]
        cwd = str(entry.get("cwd") or "")
        return {
            "id": ident,
            "kind": "claude",
            "name": str(entry.get("name") or "Claude Code"),
            "project": Path(cwd).name if cwd else "",
            "where": WHERE.get(str(entry.get("entrypoint") or ""), ""),
            "state": state,
            "since": since,
            "tasks": _count(hook["tasks"] if hook else []),
            "helpers": [dict(item) for item in self.helpers.get(ident, [])],
        }


def _count(tasks: list[dict[str, Any]]) -> dict[str, int]:
    return {"done": sum(1 for task in tasks if task.get("status") == "completed"), "total": len(tasks)}
