"""Interfaccia comune ai client LLM e agli agenti."""

from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Literal

Role = Literal["system", "user", "assistant"]

#: Un controllo di stato non deve mai tenere fermo nessuno: oltre questo
#: tempo il motore e' considerato "non risponde".
PROBE_TIMEOUT = 4.0


@dataclass
class Message:
    role: Role
    content: str

    def as_dict(self) -> dict[str, str]:
        return {"role": self.role, "content": self.content}


class LLMClient(ABC):
    """Un LLM (o un agente) che produce testo in streaming, frammento per frammento."""

    name: str = "llm"

    #: Il motore tiene da se' la memoria della conversazione (gli agenti:
    #: OpenClaw, Claude Code, Codex...). A lui basta l'ultimo messaggio: il
    #: companion non gli rimanda tutta la cronologia a ogni turno.
    stateful: bool = False

    @abstractmethod
    def stream(self, messages: list[Message]) -> AsyncIterator[str]:
        """Genera i frammenti di testo della risposta, in ordine.

        Implementato come *async generator*: va usato con ``async for``.
        """

    @abstractmethod
    async def health(self) -> dict[str, Any]:
        """Stato del backend (raggiungibilita', modello caricato, ...).

        Deve essere rapido e non avere effetti collaterali: niente sessioni
        aperte, niente processi lanciati. Lo chiama il monitor ogni pochi
        secondi.
        """

    async def probe(self) -> dict[str, Any]:
        """``health()`` con un tetto di tempo: e' quello che usa il monitor."""
        try:
            return await asyncio.wait_for(self.health(), PROBE_TIMEOUT)
        except asyncio.TimeoutError:
            return {
                "backend": self.name,
                "ok": False,
                "error": f"Non risponde entro {PROBE_TIMEOUT:.0f} secondi",
            }
        except Exception as exc:  # pragma: no cover - health() non dovrebbe sollevare
            return {"backend": self.name, "ok": False, "error": describe_error(exc)}

    async def reset(self) -> None:
        """Dimentica la conversazione tenuta dal backend, se ne tiene una.

        I backend stateless (Ollama, LM Studio) non hanno niente da dimenticare:
        la cronologia la manda il companion a ogni richiesta. Gli agenti invece
        tengono la memoria dalla loro parte, in una sessione.
        """

    async def close(self) -> None:
        """Chiude eventuali connessioni aperte (e ferma i processi figli)."""


# ---------------------------------------------------------------------------
# Aiuti per gli agenti
# ---------------------------------------------------------------------------
def last_user_text(messages: list[Message]) -> str:
    """L'ultimo messaggio dell'utente: e' tutto quello che serve a un agente."""
    return next((m.content for m in reversed(messages) if m.role == "user"), "")


def speech_directive(messages: list[Message]) -> str:
    """I vincoli del parlato (lingua, testo semplice): l'ultimo messaggio di sistema.

    Il pipeline lo mette sempre in coda ai messaggi di sistema proprio perche'
    gli agenti, che hanno una personalita' propria, ricevano solo lui.
    """
    return next((m.content for m in reversed(messages) if m.role == "system"), "")


def with_directive(messages: list[Message]) -> str:
    """Il messaggio dell'utente preceduto dai vincoli del parlato, fra parentesi.

    Senza, un agente risponde nella lingua in cui scrivi anche se la voce e'
    inglese, e usa markdown ed elenchi che letti ad alta voce non hanno senso.
    """
    text = last_user_text(messages)
    directive = speech_directive(messages)
    return f"[{directive}]\n\n{text}" if directive else text


def describe_error(exc: BaseException) -> str:
    """Un messaggio d'errore leggibile, mai vuoto.

    ``str()`` di un ``TimeoutError`` o di un ``CancelledError`` e' la stringa
    vuota: e' cosi' che nella chat compariva "LLM non raggiungibile ()".
    """
    text = str(exc).strip()
    name = type(exc).__name__
    lowered = text.lower()

    if isinstance(exc, (asyncio.TimeoutError, TimeoutError)) or "timeout" in name.lower():
        return "Tempo scaduto: nessuna risposta"
    if isinstance(exc, FileNotFoundError):
        return f"Programma non trovato{': ' + exc.filename if getattr(exc, 'filename', None) else ''}"
    if isinstance(exc, ConnectionRefusedError) or "connecterror" in name.lower() or (
        "1225" in text or "connection refused" in lowered or "all connection attempts failed" in lowered
    ):
        return "Non raggiungibile: il servizio è spento o l'indirizzo è sbagliato"
    if not text:
        return name
    return text if len(text) <= 400 else text[:400] + "…"
