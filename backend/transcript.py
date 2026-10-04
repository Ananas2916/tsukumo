"""Gli ultimi messaggi della chat, per chi si ricollega.

Il telefono perde la connessione appena Safari mette la pagina in background:
una risposta che arriva dopo non la vede mai.
Qui teniamo in memoria le ultime battute (domande e risposte, niente audio)
e le rimandiamo nel ``hello``: chi si ricollega recupera quello che si e'
perso.

Ogni battuta ha un ``seq`` crescente, che viaggia anche nei broadcast
``user`` e ``reply``: il client ricorda l'ultimo visto e prende solo quelle
dopo, senza doppioni. E' in millisecondi dall'epoch, cosi' resta crescente
anche dopo un riavvio del backend.
"""

from __future__ import annotations

import time
from collections import deque
from typing import Any, Callable

#: Quante battute si tengono: bastano per qualche turno perso, e il hello resta leggero.
KEEP = 30


class Transcript:
    def __init__(self, keep: int = KEEP, clock: Callable[[], float] = time.time) -> None:
        self._entries: deque[dict[str, Any]] = deque(maxlen=keep)
        self._clock = clock
        self._last = 0

    def observe(self, message: dict[str, Any]) -> dict[str, Any]:
        """Annota un messaggio in uscita; se e' una battuta, lo rimanda col suo ``seq``."""
        kind = message.get("type")
        if kind == "reset":
            self._entries.clear()
            return message
        entry = self._entry(kind, message)
        if entry is None:
            return message
        now = self._clock()
        self._last = max(self._last + 1, int(now * 1000))
        self._entries.append({"seq": self._last, **entry, "at": round(now, 3)})
        return {**message, "seq": self._last}

    def recent(self) -> list[dict[str, Any]]:
        return list(self._entries)

    @staticmethod
    def _entry(kind: Any, message: dict[str, Any]) -> dict[str, Any] | None:
        text = message.get("text")
        text = text.strip() if isinstance(text, str) else ""
        if kind == "user":
            files = [str(item.get("name", "")) for item in message.get("files") or [] if isinstance(item, dict)]
            if not text and not files:
                return None
            return {"role": "user", "text": text, "files": files, "turn": message.get("turn")}
        # "said" e' il PC che ripete una frase a voce, non una risposta della chat.
        if kind == "reply" and text and not message.get("said"):
            entry = {"role": "assistant", "text": text, "turn": message.get("turn")}
            for flag in ("cancelled", "proactive"):
                if message.get(flag):
                    entry[flag] = True
            return entry
        return None
