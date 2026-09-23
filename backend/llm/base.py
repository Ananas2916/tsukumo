"""Interfaccia comune ai client LLM."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Literal

Role = Literal["system", "user", "assistant"]


@dataclass
class Message:
    role: Role
    content: str

    def as_dict(self) -> dict[str, str]:
        return {"role": self.role, "content": self.content}


class LLMClient(ABC):
    """Un LLM che produce testo in streaming, token per token."""

    name: str = "llm"

    @abstractmethod
    def stream(self, messages: list[Message]) -> AsyncIterator[str]:
        """Genera i frammenti di testo della risposta, in ordine.

        Implementato come *async generator*: va usato con ``async for``.
        """

    @abstractmethod
    async def health(self) -> dict[str, Any]:
        """Stato del backend (raggiungibilita', modello caricato, ...)."""

    async def reset(self) -> None:
        """Dimentica la conversazione tenuta dal backend, se ne tiene una.

        I backend stateless (Ollama, LM Studio) non hanno niente da dimenticare:
        la cronologia la manda il companion a ogni richiesta. OpenClaw invece
        tiene la memoria sul server, nella sua sessione.
        """

    async def close(self) -> None:
        """Chiude eventuali connessioni aperte."""
