"""Several models in a row: if one doesn't answer, try the next.

Mostly for free models (OpenRouter ``:free`` and the like): everyone shares
them, and sometimes the provider answers 429 "rate-limited upstream" for a
few minutes. With two or three models in a row the comment arrives anyway.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from typing import Any

from .base import LLMClient, Message, describe_error

logger = logging.getLogger(__name__)


class FallbackLLM(LLMClient):
    """Tries the clients in order, moving to the next only before the first chunk.

    Once the reply has started an error stays an error: starting again with
    another model would make two sentences sound glued halfway.
    """

    def __init__(self, clients: list[LLMClient], name: str) -> None:
        if not clients:
            raise ValueError("At least one model is needed")
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
                logger.info("%s didn't answer (%s): trying the next one", model, describe_error(exc))
                errors.append(f"{model}: {describe_error(exc)}")
        raise RuntimeError("No model answered. " + " | ".join(errors))

    async def health(self) -> dict[str, Any]:
        return await self.clients[0].health()

    async def close(self) -> None:
        for client in self.clients:
            await client.close()
