"""Client per qualunque server locale con API compatibile OpenAI.

Copre **LM Studio** (default: `http://127.0.0.1:1234/v1`), oltre a
llama.cpp `server`, vLLM, text-generation-webui e simili: usano tutti lo
stesso endpoint `POST /v1/chat/completions` in streaming SSE e lo stesso
`GET /v1/models` per l'elenco modelli.

Nota sui modelli "reasoning" (es. i minicpm, deepseek-r1, qwq, ...)
--------------------------------------------------------------------
Questi modelli mandano il ragionamento interno in un campo separato,
``delta.reasoning_content``, PRIMA del campo ``delta.content`` con la
risposta vera. Se prendessimo tutto il testo streamato, il companion
leggerebbe ad alta voce anche i suoi "pensieri" (verificato in pratica con
LM Studio + minicpm5-2b: senza questo filtro arrivano frasi tipo "We need to
respond with 'hi'..." prima della risposta reale). Qui ignoriamo sempre
``reasoning_content`` e streamiamo solo ``content``.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import Any

import httpx

from ..attachments import openai_content
from .base import LLMClient, Message, describe_error

logger = logging.getLogger(__name__)


class OpenAICompatibleClient(LLMClient):
    """Client generico per server locali stile OpenAI (LM Studio e affini)."""

    name = "openai"

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:1234/v1",
        model: str = "auto",
        temperature: float = 0.7,
        api_key: str | None = None,
        timeout: float = 120.0,
        name: str | None = None,
        hint: str | None = None,
    ) -> None:
        # Lo stesso client serve LM Studio, i servizi cloud e Hermes: il nome
        # dice al pannello quale dei tre sta rispondendo.
        if name:
            self.name = name
        self._hint = hint
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.temperature = temperature
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        # connect breve (accorgersi subito se il server e' spento),
        # read lungo (i modelli "reasoning" possono metterci un po').
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout, connect=5.0),
            headers=headers,
        )
        self._resolved_model: str | None = None if model in ("", "auto") else model

    # ------------------------------------------------------------------
    async def _resolve_model(self) -> str:
        """Se il modello e' 'auto', prende il primo che il server ha caricato."""
        if self._resolved_model:
            return self._resolved_model

        response = await self._client.get(f"{self.base_url}/models", timeout=10.0)
        response.raise_for_status()
        models = response.json().get("data", [])
        if not models:
            raise RuntimeError(
                f"Nessun modello caricato su {self.base_url}. "
                "Carica un modello in LM Studio (o nel tuo server) prima di parlare."
            )
        self._resolved_model = models[0]["id"]
        logger.info("Modello risolto automaticamente: %s", self._resolved_model)
        return self._resolved_model

    # ------------------------------------------------------------------
    async def stream(self, messages: list[Message]) -> AsyncIterator[str]:
        model = await self._resolve_model()
        payload = {
            "model": model,
            "messages": [{"role": m.role, "content": openai_content(m.content, m.images)} for m in messages],
            "stream": True,
            "temperature": self.temperature,
        }

        async with self._client.stream(
            "POST", f"{self.base_url}/chat/completions", json=payload
        ) as response:
            if response.status_code >= 400:
                body = (await response.aread()).decode("utf-8", "replace")[:500]
                raise RuntimeError(f"{self.base_url} ha risposto {response.status_code}: {body}")

            async for line in response.aiter_lines():
                line = line.strip()
                if not line or not line.startswith("data:"):
                    continue
                data = line[len("data:") :].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk: dict[str, Any] = json.loads(data)
                except json.JSONDecodeError:
                    logger.debug("Riga SSE non JSON ignorata: %r", data[:120])
                    continue

                choices = chunk.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}

                # Volutamente NON leggiamo delta.get("reasoning_content"):
                # vedi il commento in testa al modulo.
                piece = delta.get("content")
                if piece:
                    yield piece

    # ------------------------------------------------------------------
    async def health(self) -> dict[str, Any]:
        try:
            response = await self._client.get(f"{self.base_url}/models", timeout=3.0)
            response.raise_for_status()
            models = [m.get("id", "") for m in response.json().get("data", [])]
        except Exception as exc:
            return {
                "backend": self.name,
                "ok": False,
                "model": self.model,
                "error": describe_error(exc),
                "hint": self._hint
                or "Avvia il server locale (es. LM Studio: tab 'Developer' -> Start Server)",
            }

        if not models:
            return {
                "backend": self.name,
                "ok": False,
                "model": self.model,
                "error": "Nessun modello caricato",
                "hint": "Carica un modello nel server prima di parlare",
            }

        loaded = self._resolved_model in models if self._resolved_model else True
        return {
            "backend": self.name,
            "ok": True,
            "model": self._resolved_model or self.model,
            "modelAvailable": loaded,
            "models": models,
            "hint": None,
        }

    # ------------------------------------------------------------------
    async def close(self) -> None:
        await self._client.aclose()
