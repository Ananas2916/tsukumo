"""Permission requests from the agents you use on your own, answered from Tsukumo.

Claude Code asks before running a command or editing a file. With the
``PermissionRequest`` hook connected (notify.py, from the panel) the request
also comes here: the island shows it with Allow / Always / Deny, like
Coucou's notch, and the hook gets the answer. If nobody answers in time, or
Tsukumo is off, the hook says nothing and Claude Code asks in its own window
as always (fail-open: a missed click never blocks or approves anything).

Only the PC answers: the endpoints are ``LOCAL_ONLY`` (security.py), the
phone can't approve a command.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

Broadcast = Callable[[dict[str, Any]], Awaitable[None]]

DECISIONS = ("allow", "always", "deny")
#: How long the island waits for a click (the hook's own timeout is a little longer).
WAIT = 110.0


def summary(tool: str, data: Any) -> str:
    """What the agent wants to do, in one line: the command, the file, the address."""
    if not isinstance(data, dict):
        return str(data or "")[:300]
    for key in ("command", "file_path", "path", "url", "pattern", "query", "description"):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return " ".join(value.split())[:300]
    return json.dumps(data, ensure_ascii=False)[:300]


class Approvals:
    def __init__(self, broadcast: Broadcast) -> None:
        self.broadcast = broadcast
        self.pending: dict[str, dict[str, Any]] = {}
        self._futures: dict[str, asyncio.Future[str]] = {}

    def public(self) -> list[dict[str, Any]]:
        return list(self.pending.values())

    async def ask(self, source: str, label: str, tool: str, data: Any, project: str = "", wait: float = WAIT) -> str | None:
        """Shows the request and waits for the click: "allow", "always", "deny" or None (no answer)."""
        approval_id = uuid.uuid4().hex[:12]
        item = {
            "id": approval_id,
            "source": source,
            "label": label,
            "tool": str(tool or "")[:60],
            "summary": summary(tool, data),
            "project": str(project or "")[:80],
            "created": time.time(),
            "expires": time.time() + wait,
        }
        future: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        self.pending[approval_id] = item
        self._futures[approval_id] = future
        await self.broadcast({"type": "approval", "event": "ask", "approval": item})
        try:
            return await asyncio.wait_for(future, wait)
        except asyncio.TimeoutError:
            return None
        finally:
            self.pending.pop(approval_id, None)
            self._futures.pop(approval_id, None)
            await self.broadcast({"type": "approval", "event": "closed", "id": approval_id})

    def decide(self, approval_id: str, decision: str) -> bool:
        future = self._futures.get(approval_id)
        if future is None or future.done() or decision not in DECISIONS:
            return False
        future.set_result(decision)
        return True
