"""Client for a local LLM served by Ollama (https://ollama.com).

It uses the ``/api/chat`` endpoint in streaming mode (NDJSON): every line is
a JSON object with a piece of text, so the companion can start speaking
before the reply is complete.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import AsyncIterator
from typing import Any

import httpx

from ..attachments import ollama_images
from .base import LLMClient, Message

logger = logging.getLogger(__name__)


class OllamaClient(LLMClient):
    name = "ollama"

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:11434",
        model: str = "llama3.2",
        temperature: float = 0.7,
        timeout: float = 120.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.temperature = temperature
        # short connect (to notice right away that Ollama is off),
        # long read (generation can take tens of seconds).
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout, connect=5.0),
        )
        # On Windows a connect to a closed port costs ~2 s: we cache the negative
        # result so as not to slow down whoever polls /api/health (the Electron
        # shell does at startup).
        self._health_cache: tuple[float, dict[str, Any]] | None = None
        self._health_ttl = 5.0

    # ------------------------------------------------------------------
    async def stream(self, messages: list[Message]) -> AsyncIterator[str]:
        payload = {
            "model": self.model,
            "messages": [
                {**m.as_dict(), "images": ollama_images(m.images)} if m.images else m.as_dict() for m in messages
            ],
            "stream": True,
            "options": {"temperature": self.temperature},
        }

        async with self._client.stream(
            "POST", f"{self.base_url}/api/chat", json=payload
        ) as response:
            if response.status_code >= 400:
                body = (await response.aread()).decode("utf-8", "replace")[:500]
                raise RuntimeError(f"Ollama answered {response.status_code}: {body}")

            async for line in response.aiter_lines():
                line = line.strip()
                if not line:
                    continue
                try:
                    chunk: dict[str, Any] = json.loads(line)
                except json.JSONDecodeError:
                    logger.debug("Non-JSON line ignored: %r", line[:120])
                    continue

                if chunk.get("error"):
                    raise RuntimeError(f"Ollama: {chunk['error']}")

                piece = (chunk.get("message") or {}).get("content", "")
                if piece:
                    yield piece
                if chunk.get("done"):
                    break

    # ------------------------------------------------------------------
    async def health(self) -> dict[str, Any]:
        cached = self._health_cache
        if cached and time.monotonic() - cached[0] < self._health_ttl:
            return cached[1]

        try:
            response = await self._client.get(f"{self.base_url}/api/tags", timeout=3.0)
            response.raise_for_status()
            available = [m.get("name", "") for m in response.json().get("models", [])]
        except Exception as exc:
            result = {
                "backend": self.name,
                "ok": False,
                "model": self.model,
                "error": str(exc),
                "hint": "Start Ollama with 'ollama serve' or use DC_LLM_BACKEND=mock",
            }
            self._health_cache = (time.monotonic(), result)
            return result

        # Ollama lists models as "name:tag": we accept the bare name too.
        loaded = any(
            name == self.model or name.split(":", 1)[0] == self.model.split(":", 1)[0]
            for name in available
        )
        result = {
            "backend": self.name,
            "ok": True,
            "model": self.model,
            "modelAvailable": loaded,
            "models": available,
            "hint": None if loaded else f"Download the model with: ollama pull {self.model}",
        }
        self._health_cache = (time.monotonic(), result)
        return result

    # ------------------------------------------------------------------
    async def close(self) -> None:
        await self._client.aclose()
