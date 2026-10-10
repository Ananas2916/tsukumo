"""Common interface of the LLM clients and the agents."""

from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from typing import Any, Literal

Role = Literal["system", "user", "assistant"]

#: What kind of work an agent is doing: it decides the character's pose.
ActivityKind = Literal["read", "search", "web", "write", "run", "agent", "plan", "tool"]


@dataclass(frozen=True)
class Activity:
    """One work step of an agent (a tool), said in words.

    ``label`` is already readable ("reads main.js"), ``detail`` is the raw data
    (the path, the command) for whoever wants to show it in full.
    """

    kind: ActivityKind
    label: str
    detail: str = ""
    tool: str = ""
    #: The agent's task list after this step, if it just changed it (see ``tasks.py``).
    tasks: tuple[dict[str, str], ...] | None = field(default=None, compare=False, hash=False)

    def as_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {"kind": self.kind, "label": self.label, "detail": self.detail, "tool": self.tool}
        if self.tasks is not None:
            data["tasks"] = [dict(item) for item in self.tasks]
        return data

#: A status check must never hold anyone up: beyond this time the engine is
#: considered "not answering".
PROBE_TIMEOUT = 4.0


@dataclass
class Message:
    role: Role
    content: str
    #: Attached images (paths): the models that see get them in the message.
    images: tuple[str, ...] = ()
    #: Folders of the attached files: an agent must be able to read them (``--add-dir``).
    folders: tuple[str, ...] = ()

    def as_dict(self) -> dict[str, str]:
        return {"role": self.role, "content": self.content}


class LLMClient(ABC):
    """An LLM (or an agent) producing text in streaming, chunk by chunk."""

    name: str = "llm"

    #: The engine keeps the conversation's memory by itself (the agents:
    #: OpenClaw, Claude Code, Codex...). The last message is enough for it: the
    #: companion doesn't send it the whole history at every turn.
    stateful: bool = False

    #: Whoever wants to know what the agent does while it works (the companion
    #: sets it for the length of a turn). Simple models never call it.
    on_activity: Callable[[Activity], None] | None = None

    def report(self, activity: Activity) -> None:
        """Reports a work step, if someone is listening."""
        if self.on_activity is not None:
            self.on_activity(activity)

    @abstractmethod
    def stream(self, messages: list[Message]) -> AsyncIterator[str]:
        """Yields the reply's text chunks, in order.

        Implemented as an *async generator*: use it with ``async for``.
        """

    @abstractmethod
    async def health(self) -> dict[str, Any]:
        """State of the backend (reachability, model loaded, ...).

        It must be quick and have no side effects: no sessions opened, no processes
        started. The monitor calls it every few seconds.
        """

    async def probe(self) -> dict[str, Any]:
        """``health()`` with a time cap: it's what the monitor uses."""
        try:
            return await asyncio.wait_for(self.health(), PROBE_TIMEOUT)
        except asyncio.TimeoutError:
            return {
                "backend": self.name,
                "ok": False,
                "error": f"No answer within {PROBE_TIMEOUT:.0f} seconds",
            }
        except Exception as exc:  # pragma: no cover - health() shouldn't raise
            return {"backend": self.name, "ok": False, "error": describe_error(exc)}

    async def reset(self) -> None:
        """Forgets the conversation kept by the backend, if it keeps one.

        Stateless backends (Ollama, LM Studio) have nothing to forget: the companion
        sends the history at every request. Agents instead keep the memory on their
        side, in a session.
        """

    async def close(self) -> None:
        """Closes any open connections (and stops the child processes)."""


# ---------------------------------------------------------------------------
# Helpers for the agents
# ---------------------------------------------------------------------------
def last_user_text(messages: list[Message]) -> str:
    """The user's last message: it's all an agent needs."""
    return next((m.content for m in reversed(messages) if m.role == "user"), "")


def last_user_message(messages: list[Message]) -> Message | None:
    return next((m for m in reversed(messages) if m.role == "user"), None)


def speech_directive(messages: list[Message]) -> str:
    """The speech constraints (language, plain text): the last system message.

    The pipeline always puts it at the end of the system messages precisely so
    that the agents, which have a personality of their own, receive only it.
    """
    return next((m.content for m in reversed(messages) if m.role == "system"), "")


def with_directive(messages: list[Message]) -> str:
    """The user's message preceded by the speech constraints, in brackets.

    Without it, an agent answers in the language you write in even if the voice
    is English, and uses markdown and lists that make no sense read aloud.
    """
    text = last_user_text(messages)
    directive = speech_directive(messages)
    return f"[{directive}]\n\n{text}" if directive else text


def describe_error(exc: BaseException) -> str:
    """A readable error message, never empty.

    ``str()`` of a ``TimeoutError`` or a ``CancelledError`` is the empty string:
    that's how "LLM unreachable ()" showed up in the chat.
    """
    text = str(exc).strip()
    name = type(exc).__name__
    lowered = text.lower()

    if isinstance(exc, (asyncio.TimeoutError, TimeoutError)) or "timeout" in name.lower():
        return "Timed out: no answer"
    if isinstance(exc, FileNotFoundError):
        return f"Program not found{': ' + exc.filename if getattr(exc, 'filename', None) else ''}"
    if isinstance(exc, ConnectionRefusedError) or "connecterror" in name.lower() or (
        "1225" in text or "connection refused" in lowered or "all connection attempts failed" in lowered
    ):
        return "Unreachable: the service is off or the address is wrong"
    if not text:
        return name
    return text if len(text) <= 400 else text[:400] + "…"
