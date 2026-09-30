"""Piu' modelli in fila: se uno non risponde prova il successivo.

Serve soprattutto ai modelli gratuiti (OpenRouter ``:free`` e simili): li
condividono tutti, e a volte il fornitore risponde 429 "rate-limited
upstream" per qualche minuto. Con due o tre modelli in fila il commento
arriva lo stesso.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from typing import Any

from .base import LLMClient, Message, describe_error

logger = logging.getLogger(__name__)


class FallbackLLM(LLMClient):
    """Prova i client in ordine, passando al successivo solo prima del primo frammento.

    A risposta iniziata un errore resta un errore: ricominciare con un altro
    modello farebbe sentire due frasi attaccate a meta'.
    """

    def __init__(self, clients: list[LLMClient], name: str) -> None:
        if not clients:
            raise ValueError("Serve almeno un modello")
        self.clients = clients
        self.name = name

    async def stream(self, messages: list[Message]) -> AsyncIterator[str]:
        errors: list[str] = []
        for client in self.clients:
            produced = False
            try:
                async for piece in client.stream(messages):
                    produced = True
                    yield piece
                return
            except Exception as exc:
                if produced:
                    raise
                model = getattr(client, "model", "") or client.name
                logger.info("%s non ha risposto (%s): provo il prossimo", model, describe_error(exc))
                errors.append(f"{model}: {describe_error(exc)}")
        raise RuntimeError("Nessun modello ha risposto. " + " | ".join(errors))

    async def health(self) -> dict[str, Any]:
        return await self.clients[0].health()

    async def close(self) -> None:
        for client in self.clients:
            await client.close()
