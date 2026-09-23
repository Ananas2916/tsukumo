"""Risponditore offline: nessun modello, nessuna rete.

Serve a due scopi: sviluppare il frontend senza tenere acceso Ollama e fare da
rete di sicurezza quando l'LLM configurato non risponde. Le risposte sono
brevi e adatte alla lettura ad alta voce, in italiano o inglese a seconda di
come scrive l'utente.
"""

from __future__ import annotations

import asyncio
import random
import re
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any

from .base import LLMClient, Message

# Parole spia per riconoscere l'italiano senza librerie esterne.
_ITALIAN_HINTS = {
    "ciao", "come", "stai", "grazie", "per", "favore", "che", "cosa", "sei",
    "sono", "puoi", "vorrei", "quando", "perche", "dove", "buongiorno",
    "buonasera", "aiuto", "adesso", "oggi", "domani", "ora", "gia", "anche",
}

_GREETING = re.compile(r"\b(ciao|salve|hey|hi|hello|buongiorno|buonasera|yo)\b", re.I)
_TIME = re.compile(r"\b(che ore|ora sono|what time|il tempo che|orario)\b", re.I)
_DATE = re.compile(r"\b(che giorno|data di oggi|what day|today.s date|oggi e)\b", re.I)
_THANKS = re.compile(r"\b(grazie|thanks|thank you|thx)\b", re.I)
_HOWAREYOU = re.compile(r"\b(come stai|come va|how are you|tutto bene)\b", re.I)
_JOKE = re.compile(r"\b(barzelletta|scherzo|joke|fammi ridere|funny)\b", re.I)
_WHOAREYOU = re.compile(r"\b(chi sei|come ti chiami|who are you|your name)\b", re.I)
_BYE = re.compile(r"\b(ciao ciao|addio|a dopo|bye|goodbye|see you|arrivederci)\b", re.I)

_JOKES_IT = [
    "Un byte entra in un bar e ordina un bit. Il barista risponde: mezzo giro e sei servito.",
    "Ho provato a spiegare le variabili al mio gatto. Ora si chiama undefined.",
    "Perche i programmatori odiano la natura? Troppi bug e nessun debugger.",
]
_JOKES_EN = [
    "A byte walked into a bar and asked for a bit. The bartender said: half a nibble, coming up.",
    "I told my cat about variables. Now it answers only to undefined.",
    "Why do developers dislike nature? Too many bugs and no debugger.",
]

_SMALLTALK_IT = [
    "Sono qui sulla scrivania, pronto quando ti serve.",
    "Tutto tranquillo da questa parte dello schermo.",
    "Direi bene: nessun errore di rendering finora.",
]
_SMALLTALK_EN = [
    "Still here on your desk, ready whenever you need me.",
    "All quiet on this side of the screen.",
    "Pretty good, no rendering errors so far.",
]


class MockLLM(LLMClient):
    """Genera risposte deterministiche ma variate, in streaming simulato."""

    name = "mock"

    def __init__(self, chunk_delay: float = 0.02) -> None:
        self.chunk_delay = chunk_delay
        self._random = random.Random()

    # ------------------------------------------------------------------
    async def stream(self, messages: list[Message]) -> AsyncIterator[str]:
        prompt = next(
            (m.content for m in reversed(messages) if m.role == "user"),
            "",
        )
        reply = self._compose(prompt)
        # Emettiamo parola per parola per esercitare davvero il percorso di
        # streaming del frontend (token -> frase -> sintesi -> lip-sync).
        for index, word in enumerate(reply.split(" ")):
            await asyncio.sleep(self.chunk_delay)
            yield word if index == 0 else f" {word}"

    # ------------------------------------------------------------------
    def _compose(self, prompt: str) -> str:
        text = prompt.strip()
        italian = self._is_italian(text)
        # Seed derivato dal testo: stessa domanda, stessa risposta.
        self._random.seed(hash(text.lower()) & 0xFFFFFFFF)
        now = datetime.now()

        if not text:
            return "Dimmi pure." if italian else "Go ahead, I am listening."

        if _BYE.search(text):
            return "A presto, resto qui sulla scrivania." if italian else "See you soon, I will be right here."

        if _GREETING.search(text) and len(text) < 40:
            return "Ciao! Che si fa oggi?" if italian else "Hey there! What are we working on?"

        if _HOWAREYOU.search(text):
            pool = _SMALLTALK_IT if italian else _SMALLTALK_EN
            return self._random.choice(pool)

        if _WHOAREYOU.search(text):
            return (
                "Sono il tuo Desk Companion: un piccolo avatar tridimensionale che parla con Kokoro."
                if italian
                else "I am your Desk Companion, a small 3D avatar that speaks through Kokoro."
            )

        if _TIME.search(text):
            clock = now.strftime("%H:%M")
            return f"Sono le {clock}." if italian else f"It is {clock}."

        if _DATE.search(text):
            day = now.strftime("%d/%m/%Y")
            return f"Oggi e il {day}." if italian else f"Today is {now.strftime('%B %d, %Y')}."

        if _THANKS.search(text):
            return "Figurati, quando vuoi." if italian else "Any time, happy to help."

        if _JOKE.search(text):
            return self._random.choice(_JOKES_IT if italian else _JOKES_EN)

        if text.endswith("?"):
            topic = self._topic(text)
            return (
                f"Bella domanda su {topic}. Senza un modello collegato posso solo ragionarci sopra: "
                "collega Ollama e ti do una risposta vera."
                if italian
                else f"Good question about {topic}. Without a model attached I can only guess, "
                "so hook up Ollama and I will answer properly."
            )

        topic = self._topic(text)
        return (
            f"Ho preso nota su {topic}. Sto girando in modalita offline, quindi tengo le risposte corte."
            if italian
            else f"Noted about {topic}. I am running in offline mode, so I am keeping it short."
        )

    # ------------------------------------------------------------------
    @staticmethod
    def _is_italian(text: str) -> bool:
        words = set(re.findall(r"[a-zA-Zàèéìòù]+", text.lower()))
        return bool(words & _ITALIAN_HINTS)

    @staticmethod
    def _topic(text: str) -> str:
        """Estrae la parola piu' lunga come 'argomento' della frase."""
        words = [w for w in re.findall(r"[\w'-]{4,}", text) if not w.isdigit()]
        if not words:
            return "questo" if MockLLM._is_italian(text) else "that"
        return max(words, key=len).lower()

    # ------------------------------------------------------------------
    async def health(self) -> dict[str, Any]:
        return {"backend": self.name, "ok": True, "model": "offline-rules", "hint": None}
