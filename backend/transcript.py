"""The last chat messages, for whoever reconnects.

The phone loses the connection as soon as Safari puts the page in the
background: a reply arriving later is never seen.
Here we keep the last lines in memory (questions and replies, no audio) and
send them again in the ``hello``: whoever reconnects gets back what they
missed.

Every line has a growing ``seq``, which also travels in the ``user`` and
``reply`` broadcasts: the client remembers the last one seen and takes only
the later ones, without duplicates. It's in milliseconds since the epoch, so
it keeps growing across backend restarts too.
"""

from __future__ import annotations

import time
from collections import deque
from typing import Any, Callable

#: How many lines are kept: enough for a few lost turns, and the hello stays light.
KEEP = 30


class Transcript:
    def __init__(self, keep: int = KEEP, clock: Callable[[], float] = time.time) -> None:
        self._entries: deque[dict[str, Any]] = deque(maxlen=keep)
        self._clock = clock
        self._last = 0

    def observe(self, message: dict[str, Any]) -> dict[str, Any]:
        """Notes an outgoing message; if it's a chat line, sends it back with its ``seq``."""
        kind = message.get("type")
        if kind == "reset":
            self._entries.clear()
            return message
        entry = self._entry(kind, message)
        if entry is None:
            return message
        now = self._clock()
        self._last = max(self._last + 1, int(now * 1000))
        self._entries.append({"seq": self._last, **entry, "at": round(now, 3)})
        return {**message, "seq": self._last}

    def recent(self) -> list[dict[str, Any]]:
        return list(self._entries)

    @staticmethod
    def _entry(kind: Any, message: dict[str, Any]) -> dict[str, Any] | None:
        text = message.get("text")
        text = text.strip() if isinstance(text, str) else ""
        if kind == "user":
            files = [str(item.get("name", "")) for item in message.get("files") or [] if isinstance(item, dict)]
            if not text and not files:
                return None
            return {"role": "user", "text": text, "files": files, "turn": message.get("turn")}
        # "said" is the PC repeating a sentence aloud, not a chat reply.
        if kind == "reply" and text and not message.get("said"):
            entry = {"role": "assistant", "text": text, "turn": message.get("turn")}
            for flag in ("cancelled", "proactive"):
                if message.get(flag):
                    entry[flag] = True
            return entry
        return None
