"""Client per l'API Google Gemini.

Il formato e' diverso da quello OpenAI in tre punti che contano qui:

* i turni si chiamano ``contents`` e il ruolo dell'assistente e' ``model``,
  non ``assistant``;
* il system prompt e' un campo a se' (``systemInstruction``);
* lo streaming si ottiene con ``:streamGenerateContent?alt=sse``.

La chiave viaggia nell'header ``x-goog-api-key`` invece che nella query
string, cosi' non finisce nei log del server.
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
    """Client per i modelli Gemini di Google AI Studio."""

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
        """Separa il system prompt e traduce i ruoli nel dialetto di Gemini."""
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
                raise RuntimeError(f"Gemini ha risposto {response.status_code}: {body}")

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
                    logger.debug("Riga SSE non JSON ignorata: %r", data[:120])
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
                "hint": "Controlla la chiave API su aistudio.google.com/apikey.",
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
