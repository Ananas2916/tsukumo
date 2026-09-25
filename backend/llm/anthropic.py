"""Client per l'API Anthropic (modelli Claude).

A differenza degli altri backend, che parlano tutti HTTP grezzo con ``httpx``,
qui usiamo l'SDK ufficiale ``anthropic``: il formato dei messaggi e degli
eventi di streaming e' suo e cambia nel tempo, quindi conviene lasciarglielo
gestire. L'import e' pigro, cosi' chi non usa Claude non deve installarlo.

Due dettagli che valgono per il companion:

* il *system prompt* in questa API non e' un messaggio come gli altri ma un
  parametro a se', quindi va estratto dalla cronologia;
* i modelli recenti ragionano prima di rispondere. ``stream.text_stream``
  emette **solo** il testo finale, mai i blocchi di pensiero: e' esattamente
  il comportamento che ci serve, perche' il companion pronuncia ad alta voce
  tutto quello che riceve.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from typing import Any

from .base import LLMClient, Message

logger = logging.getLogger(__name__)

#: Il companion risponde in poche frasi brevi: uno sforzo alto farebbe solo
#: aspettare l'utente davanti a un personaggio immobile.
_EFFORT = "low"


class AnthropicClient(LLMClient):
    """Client per i modelli Claude tramite l'API ufficiale Anthropic."""

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
        except ImportError as exc:  # pragma: no cover - dipende dall'ambiente
            raise RuntimeError(
                "Il backend Anthropic richiede il pacchetto 'anthropic'. "
                "Installalo con: pip install anthropic"
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
    def _split(messages: list[Message]) -> tuple[str, list[dict[str, str]]]:
        """Separa il system prompt dal resto della conversazione."""
        system_parts: list[str] = []
        turns: list[dict[str, str]] = []
        for message in messages:
            if message.role == "system":
                system_parts.append(message.content)
            else:
                turns.append({"role": message.role, "content": message.content})
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
        # Haiku 4.5 non accetta `effort` (risponde 400): li' si usa il default.
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
                    "Controlla la chiave API e il nome del modello. "
                    "L'elenco aggiornato e' su docs.claude.com/en/docs/about-claude/models"
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
