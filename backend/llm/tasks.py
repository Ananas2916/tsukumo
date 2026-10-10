"""An agent's task list: "1. read the code ✓ 2. write the tests (in progress) 3. ...".

Agents keep it with their tools, in three different shapes:

- Claude Code (old): ``TodoWrite`` with the whole list, ``{"todos": [{"content",
  "status", "activeForm"}]}``;
- Claude Code (2.1 and later): ``TaskCreate`` (``subject``, ``description``,
  ``activeForm``; it answers "Task #3 created...") and ``TaskUpdate``
  (``taskId``, ``status``, ``deleted`` too), one piece at a time;
- Codex: the ``todo_list`` item of its ``--json``, ``{"items": [{"text",
  "completed"}]}``, whole every time.

They all become ``[{"id", "text", "active", "status"}]`` with ``status`` among
``pending``, ``in_progress`` and ``completed``: the dashboard shows it.
"""

from __future__ import annotations

import re
from typing import Any

STATUSES = ("pending", "in_progress", "completed")
#: The tools that touch the list (for the hooks: only these are watched).
TASK_TOOLS = frozenset({"TodoWrite", "TaskCreate", "TaskUpdate"})
#: A very long list is a mistake or an abuse: the beginning is kept.
MAX_TASKS = 50
MAX_TEXT = 160


def _text(value: Any) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= MAX_TEXT else text[: MAX_TEXT - 1] + "…"


def _status(value: Any) -> str:
    value = str(value or "").lower()
    return value if value in STATUSES else "pending"


def task_number(response: Any) -> str | None:
    """The number Claude Code gave the task: "Task #3 created successfully" -> "3"."""
    if isinstance(response, dict):
        for key in ("taskId", "id"):
            if response.get(key) is not None:
                return str(response[key])
        task = response.get("task")
        if isinstance(task, dict) and task.get("id") is not None:
            return str(task["id"])
        response = " ".join(str(value) for value in response.values() if isinstance(value, (str, int)))
    if isinstance(response, list):
        response = " ".join(str(part.get("text", "")) if isinstance(part, dict) else str(part) for part in response)
    found = re.search(r"#\s*(\d+)", str(response or ""))
    return found.group(1) if found else None


class TaskList:
    """An agent's list, updated tool after tool."""

    def __init__(self) -> None:
        self.items: list[dict[str, str]] = []
        #: ``TaskCreate`` waiting for its number (it arrives with the tool's response).
        self._pending: dict[str, dict[str, str]] = {}

    def public(self) -> list[dict[str, str]]:
        return [dict(item) for item in self.items]

    def clear(self) -> None:
        self.items = []
        self._pending = {}

    def apply_claude(self, tool: str, data: Any, response: Any = None, call_id: str = "") -> bool:
        """A Claude Code tool. True if the list changed."""
        data = data if isinstance(data, dict) else {}
        if tool == "TodoWrite":
            todos = data.get("todos")
            if not isinstance(todos, list):
                return False
            self.items = [
                {
                    "id": str(index + 1),
                    "text": _text(todo.get("content")),
                    "active": _text(todo.get("activeForm")),
                    "status": _status(todo.get("status")),
                }
                for index, todo in enumerate(todos[:MAX_TASKS])
                if isinstance(todo, dict) and todo.get("content")
            ]
            return True
        if tool == "TaskCreate":
            subject = _text(data.get("subject") or data.get("description"))
            if not subject or len(self.items) >= MAX_TASKS:
                return False
            number = task_number(response) or self._next_id()
            self.items = [item for item in self.items if item["id"] != number]
            entry = {"id": number, "text": subject, "active": _text(data.get("activeForm")), "status": "pending"}
            self.items.append(entry)
            if call_id and response is None:
                self._pending[call_id] = entry
            return True
        if tool == "TaskUpdate":
            number = str(data.get("taskId") or data.get("id") or "")
            item = next((entry for entry in self.items if entry["id"] == number), None)
            if item is None:
                return False
            if str(data.get("status") or "").lower() == "deleted":
                self.items.remove(item)
                return True
            if data.get("status"):
                item["status"] = _status(data["status"])
            if data.get("subject"):
                item["text"] = _text(data["subject"])
            if data.get("activeForm"):
                item["active"] = _text(data["activeForm"])
            return True
        return False

    def created(self, call_id: str, response: Any) -> bool:
        """The response of an already seen ``TaskCreate``: now its number is known."""
        entry = self._pending.pop(call_id, None)
        number = task_number(response)
        if entry is None or number is None or entry["id"] == number or not any(item is entry for item in self.items):
            return False
        # A task with that number left from before (Tsukumo restarted with the session open) is this one.
        self.items = [item for item in self.items if item is entry or item["id"] != number]
        entry["id"] = number
        return True

    def apply_codex(self, item: Any) -> bool:
        """Codex's ``todo_list`` item (always the whole list)."""
        if not isinstance(item, dict) or item.get("type") != "todo_list" or not isinstance(item.get("items"), list):
            return False
        entries = [entry for entry in item["items"][:MAX_TASKS] if isinstance(entry, dict) and entry.get("text")]
        # Codex only says done/not done: the first one to do is the one in progress.
        current = next((index for index, entry in enumerate(entries) if not entry.get("completed")), None)
        self.items = [
            {
                "id": str(index + 1),
                "text": _text(entry.get("text")),
                "active": "",
                "status": "completed" if entry.get("completed") else "in_progress" if index == current else "pending",
            }
            for index, entry in enumerate(entries)
        ]
        return True

    def _next_id(self) -> str:
        numbers = [int(item["id"]) for item in self.items if item["id"].isdigit()]
        return str(max(numbers, default=0) + 1)
