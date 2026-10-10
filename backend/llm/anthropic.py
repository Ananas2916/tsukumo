"""Client for the Anthropic API (Claude models).

Unlike the other backends, which all speak raw HTTP with ``httpx``, here we
use the official ``anthropic`` SDK: the format of messages and streaming
events is its own and changes over time, so it's better to let it handle
them. The import is lazy, so whoever doesn't use Claude needn't install it.

Two details that matter for the companion:

* the *system prompt* in this API isn't a message like the others but a
  parameter of its own, so it must be pulled out of the history;
* recent models reason before answering. ``stream.text_stream`` emits
  **only** the final text, never the thinking blocks: exactly the behaviour
  we need, because the companion speaks aloud everything it receives.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from typing import Any

from ..attachments import anthropic_content
from .base import LLMClient, Message

logger = logging.getLogger(__name__)

#: The companion answers in a few short sentences: a high effort would only
#: keep the user waiting in front of a motionless character.
_EFFORT = "low"


class AnthropicClient(LLMClient):
    """Client for Claude models through the official Anthropic API."""

    name = "anthropic"

    def __init__(
        self,
        api_key: str,
        model: str = "claude-opus-5",
        base_url: str = "https://api.anthropic.com",
        max_tokens: int = 1024,
        temperature: float = 0.7,
    ) -> None:
        try:
            from anthropic import AsyncAnthropic
        except ImportError as exc:  # pragma: no cover - depends on the environment
            raise RuntimeError(
                "The Anthropic backend needs the 'anthropic' package. "
                "Install it with: pip install anthropic"
            ) from exc

        self.model = model
        self.max_tokens = max_tokens
        self.temperature = temperature
        kwargs: dict[str, Any] = {"api_key": api_key}
        if base_url:
            kwargs["base_url"] = base_url
        self._client = AsyncAnthropic(**kwargs)

    # ------------------------------------------------------------------
    @staticmethod
    def _split(messages: list[Message]) -> tuple[str, list[dict[str, Any]]]:
        """Separates the system prompt from the rest of the conversation."""
        system_parts: list[str] = []
        turns: list[dict[str, Any]] = []
        for message in messages:
            if message.role == "system":
                system_parts.append(message.content)
            else:
                turns.append({"role": message.role, "content": anthropic_content(message.content, message.images)})
        return "\n\n".join(system_parts), turns

    # ------------------------------------------------------------------
    async def stream(self, messages: list[Message]) -> AsyncIterator[str]:
        system, turns = self._split(messages)
        if not turns:
            return

        payload: dict[str, Any] = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "messages": turns,
        }
        # Haiku 4.5 doesn't accept `effort` (it answers 400): the default is used there.
        if "haiku" not in self.model:
            payload["output_config"] = {"effort": _EFFORT}
        if system:
            payload["system"] = system

        async with self._client.messages.stream(**payload) as stream:
            async for piece in stream.text_stream:
                if piece:
                    yield piece

    # ------------------------------------------------------------------
    async def health(self) -> dict[str, Any]:
        try:
            model = await self._client.models.retrieve(self.model)
        except Exception as exc:
            return {
                "backend": self.name,
                "ok": False,
                "model": self.model,
                "error": str(exc),
                "hint": (
                    "Check the API key and the model name. "
                    "The up-to-date list is at docs.claude.com/en/docs/about-claude/models"
                ),
            }
        return {
            "backend": self.name,
            "ok": True,
            "model": getattr(model, "id", self.model),
            "modelAvailable": True,
            "hint": None,
        }

    # ------------------------------------------------------------------
    async def close(self) -> None:
        await self._client.close()
