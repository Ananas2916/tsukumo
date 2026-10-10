"""Client for the Google Gemini API.

The format differs from OpenAI's in three points that matter here:

* turns are called ``contents`` and the assistant's role is ``model``, not
  ``assistant``;
* the system prompt is a field of its own (``systemInstruction``);
* streaming is obtained with ``:streamGenerateContent?alt=sse``.

The key travels in the ``x-goog-api-key`` header instead of the query
string, so it doesn't end up in the server's logs.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import Any

import httpx

from ..attachments import gemini_parts
from .base import LLMClient, Message

logger = logging.getLogger(__name__)


class GeminiClient(LLMClient):
    """Client for Google AI Studio's Gemini models."""

    name = "gemini"

    def __init__(
        self,
        api_key: str,
        model: str = "gemini-2.0-flash",
        base_url: str = "https://generativelanguage.googleapis.com/v1beta",
        temperature: float = 0.7,
        timeout: float = 120.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.temperature = temperature
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout, connect=5.0),
            headers={"x-goog-api-key": api_key},
        )

    # ------------------------------------------------------------------
    @staticmethod
    def _split(messages: list[Message]) -> tuple[str, list[dict[str, Any]]]:
        """Separates the system prompt and translates the roles into Gemini's dialect."""
        system_parts: list[str] = []
        contents: list[dict[str, Any]] = []
        for message in messages:
            if message.role == "system":
                system_parts.append(message.content)
                continue
            role = "model" if message.role == "assistant" else "user"
            contents.append({"role": role, "parts": gemini_parts(message.content, message.images)})
        return "\n\n".join(system_parts), contents

    # ------------------------------------------------------------------
    async def stream(self, messages: list[Message]) -> AsyncIterator[str]:
        system, contents = self._split(messages)
        if not contents:
            return

        payload: dict[str, Any] = {
            "contents": contents,
            "generationConfig": {"temperature": self.temperature},
        }
        if system:
            payload["systemInstruction"] = {"parts": [{"text": system}]}

        url = f"{self.base_url}/models/{self.model}:streamGenerateContent"
        async with self._client.stream(
            "POST", url, json=payload, params={"alt": "sse"}
        ) as response:
            if response.status_code >= 400:
                body = (await response.aread()).decode("utf-8", "replace")[:500]
                raise RuntimeError(f"Gemini answered {response.status_code}: {body}")

            async for line in response.aiter_lines():
                line = line.strip()
                if not line.startswith("data:"):
                    continue
                data = line[len("data:") :].strip()
                if not data or data == "[DONE]":
                    continue
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    logger.debug("Non-JSON SSE line ignored: %r", data[:120])
                    continue

                for candidate in chunk.get("candidates") or []:
                    for part in (candidate.get("content") or {}).get("parts") or []:
                        piece = part.get("text")
                        if piece:
                            yield piece

    # ------------------------------------------------------------------
    async def health(self) -> dict[str, Any]:
        try:
            response = await self._client.get(f"{self.base_url}/models", timeout=5.0)
            response.raise_for_status()
            models = [m.get("name", "").split("/")[-1] for m in response.json().get("models", [])]
        except Exception as exc:
            return {
                "backend": self.name,
                "ok": False,
                "model": self.model,
                "error": str(exc),
                "hint": "Check the API key at aistudio.google.com/apikey.",
            }
        return {
            "backend": self.name,
            "ok": True,
            "model": self.model,
            "modelAvailable": self.model in models if models else True,
            "models": models,
            "hint": None,
        }

    # ------------------------------------------------------------------
    async def close(self) -> None:
        await self._client.aclose()
