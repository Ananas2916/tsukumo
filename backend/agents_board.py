"""The agents at work, for the dashboard: who's working, on what, with which list.

Two sources:

- Tsukumo's agent (the brain chosen in the panel): we watch the chat
  messages go by (``observe``): "state" thinking -> at work, "working" -> the
  step in progress (and the list, if it changed it), "reply"/idle -> done;
- the Claude Code and Codex sessions you use on your own, in a terminal or in
  VS Code: they come from the hooks (``scripts/tsukumo_notify.py`` ->
  ``POST /api/notify``) with the session, the project folder and, for Claude
  Code, the task-list tools (``external``).

In memory only: after a restart it starts empty, and a session quiet for half
a day disappears.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .llm.tasks import TaskList

#: An external session still for this long is no longer "at work".
FORGET_AFTER = 12 * 3600
#: How many external sessions to keep.
MAX_SESSIONS = 12
NAMES = {"claude": "Claude Code", "codex": "Codex"}
STATES = ("working", "waiting", "done", "idle")


@dataclass
class AgentSession:
    key: str
    source: str
    name: str
    project: str = ""
    #: working, waiting (for you), done, idle.
    state: str = "idle"
    #: The step in progress ("reads main.js"), for Tsukumo's agent.
    step: str = ""
    #: The request or the last reply, in short.
    summary: str = ""
    since: float = 0.0
    updated: float = 0.0
    internal: bool = False
    tasks: TaskList = field(default_factory=TaskList)

    def public(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "source": self.source,
            "name": self.name,
            "project": self.project,
            "state": self.state,
            "step": self.step,
            "summary": self.summary,
            "since": self.since,
            "updated": self.updated,
            "internal": self.internal,
            "tasks": self.tasks.public(),
        }


def _short(text: Any, limit: int = 160) -> str:
    value = " ".join(str(text or "").split())
    return value if len(value) <= limit else value[: limit - 1].rstrip() + "…"


class AgentBoard:
    def __init__(self, own_name: Callable[[], str] = lambda: "Tsukumo", clock: Callable[[], float] = time.time) -> None:
        self.own_name = own_name
        self.clock = clock
        self.own = AgentSession(key="tsukumo", source="tsukumo", name="Tsukumo", internal=True)
        self.sessions: dict[str, AgentSession] = {}

    def public(self) -> list[dict[str, Any]]:
        now = self.clock()
        self.sessions = {key: item for key, item in self.sessions.items() if now - item.updated < FORGET_AFTER}
        order = {state: index for index, state in enumerate(STATES)}
        external = sorted(self.sessions.values(), key=lambda item: (order.get(item.state, 9), -item.updated))
        try:
            self.own.name = self.own_name() or "Tsukumo"
        except Exception:  # the brain is changing: the previous name stays
            pass
        return [self.own.public(), *(item.public() for item in external)]

    # ------------------------------------------------------------------ Tsukumo
    def observe(self, message: dict[str, Any]) -> bool:
        """A chat message: true if the state of Tsukumo's agent changed."""
        kind = message.get("type")
        own, now = self.own, self.clock()
        if kind == "state":
            value = message.get("value")
            if value == "thinking" and own.state != "working":
                own.state, own.step, own.since = "working", "", now
            elif value == "idle" and own.state == "working":
                own.state, own.step, own.since = "done", "", now
            else:
                return False
        elif kind == "user" and message.get("text"):
            own.summary = _short(message["text"])
            return False  # it arrives together with "thinking": a single message
        elif kind == "working":
            own.state = "working"
            own.step = _short(message.get("label"), 80)
            if isinstance(message.get("tasks"), list):
                own.tasks.items = [dict(item) for item in message["tasks"] if isinstance(item, dict)]
        elif kind == "tasks" and isinstance(message.get("tasks"), list):
            own.tasks.items = [dict(item) for item in message["tasks"] if isinstance(item, dict)]
        elif kind == "reply" and own.state == "working" and not message.get("proactive"):
            own.state, own.step, own.since = "done", "", now
        else:
            return False
        own.updated = now
        return True

    # ------------------------------------------------------------------ external
    def external(
        self,
        source: str,
        kind: str,
        session: str = "",
        project: str = "",
        message: str = "",
        tool: str = "",
        data: Any = None,
        response: Any = None,
    ) -> bool:
        """An event from a hook: true if it must be shown."""
        source = (source or "agent").strip().lower()[:24]
        key = f"{source}:{(session or 'default').strip()[:80]}"
        now = self.clock()
        item = self.sessions.get(key)
        if item is None:
            if len(self.sessions) >= MAX_SESSIONS:
                oldest = min(self.sessions.values(), key=lambda entry: entry.updated)
                self.sessions.pop(oldest.key, None)
            item = AgentSession(key=key, source=source, name=NAMES.get(source, source.title()), since=now)
            self.sessions[key] = item
        if project:
            item.project = _short(project, 60)
        if kind == "tasks":
            if not item.tasks.apply_claude(tool, data, response):
                return False
            if item.state not in ("working", "waiting"):
                item.state, item.since = "working", now
        elif kind in ("working", "waiting", "done"):
            if kind != item.state:
                item.since = now
            item.state = kind
            if message:
                item.summary = _short(message)
        else:
            return False
        item.updated = now
        return True
