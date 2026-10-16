"""Permission requests from the agents you use on your own, answered from Tsukumo.

Claude Code asks before running a command or editing a file. With the
``PermissionRequest`` hook connected (notify.py, from the panel) the request
also comes here: the island shows it with Allow / Always / Deny, like
Coucou's notch, and the hook gets the answer. If nobody answers in time, or
Tsukumo is off, the hook says nothing and Claude Code asks in its own window
as always (fail-open: a missed click never blocks or approves anything).

The PC answers everything: the endpoints are ``LOCAL_ONLY`` (security.py).
The phone gets one narrow way in (``decide_remote``): allow or deny, never
"always", only for the request still waiting and only if it names the exact
command it was shown. Face ID happens on the phone; the PC still only trusts
the token, so "always" (which outlives the request) stays on the PC.
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
#: What the phone may answer: one request at a time, nothing that lasts.
REMOTE_DECISIONS = ("allow", "deny")
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
        #: Requests the phone answered (the others were the PC).
        self._by: dict[str, str] = {}

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
        decision: str | None = None
        try:
            decision = await asyncio.wait_for(future, wait)
            return decision
        except asyncio.TimeoutError:
            return None
        finally:
            self.pending.pop(approval_id, None)
            self._futures.pop(approval_id, None)
            # Who answered and how: the phone shows "allowed from the PC" and drops its notification.
            by = self._by.pop(approval_id, "pc")
            await self.broadcast({"type": "approval", "event": "closed", "id": approval_id, "decision": decision, "by": by if decision else None})

    def decide(self, approval_id: str, decision: str) -> bool:
        future = self._futures.get(approval_id)
        if future is None or future.done() or decision not in DECISIONS:
            return False
        future.set_result(decision)
        return True

    def decide_remote(self, approval_id: str, decision: str, shown: str) -> str:
        """The phone's answer: "ok", "gone" (expired or answered) or "mismatch".

        ``shown`` is the command the phone displayed: a decision only counts
        for the request it was meant for, never for one that came after.
        """
        item = self.pending.get(approval_id)
        future = self._futures.get(approval_id)
        if decision not in REMOTE_DECISIONS:
            return "mismatch"
        if item is None or future is None or future.done():
            return "gone"
        if " ".join(str(shown or "").split()) != " ".join(item["summary"].split()):
            return "mismatch"
        self._by[approval_id] = "phone"
        future.set_result(decision)
        return "ok"
