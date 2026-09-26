"""Client per un LLM locale servito da Ollama (https://ollama.com).

Usa l'endpoint ``/api/chat`` in modalita' streaming (NDJSON): ogni riga e' un
oggetto JSON con un frammento di testo, cosi' il companion puo' iniziare a
parlare prima che la risposta sia completa.
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
        # connect breve (per accorgersi subito che Ollama e' spento),
        # read lungo (la generazione puo' richiedere decine di secondi).
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout, connect=5.0),
        )
        # Su Windows un connect verso una porta chiusa costa ~2 s: teniamo in
        # cache l'esito negativo per non rallentare chi interroga /api/health
        # in polling (lo fa la shell Electron all'avvio).
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
                raise RuntimeError(f"Ollama ha risposto {response.status_code}: {body}")

            async for line in response.aiter_lines():
                line = line.strip()
                if not line:
                    continue
                try:
                    chunk: dict[str, Any] = json.loads(line)
                except json.JSONDecodeError:
                    logger.debug("Riga non JSON ignorata: %r", line[:120])
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
                "hint": "Avvia Ollama con 'ollama serve' oppure usa DC_LLM_BACKEND=mock",
            }
            self._health_cache = (time.monotonic(), result)
            return result

        # Ollama elenca i modelli come "nome:tag": accettiamo anche il solo nome.
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
            "hint": None if loaded else f"Scarica il modello con: ollama pull {self.model}",
        }
        self._health_cache = (time.monotonic(), result)
        return result

    # ------------------------------------------------------------------
    async def close(self) -> None:
        await self._client.aclose()
