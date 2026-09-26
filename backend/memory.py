"""Chi e' lei e cosa sa di te, uguale per ogni cervello.

Cambiando cervello (Claude Code, Codex, OpenClaw, un modello locale) il tono
e la memoria restavano quelli del cervello di turno: un giorno sapeva che ti
chiami Filippo, il giorno dopo no. Qui stanno due cose che il companion
aggiunge a ogni turno, qualunque sia il cervello:

* la **personalita'**: nome e carattere, scelti nel pannello;
* i **ricordi**: fatti brevi su di te ("lavora in Python", "ha un gatto che
  si chiama Miso"). Entrano in tre modi: dici "ricordati che...", il
  cervello ne annota uno con l'etichetta ``[[remember: ...]]`` quando gli
  racconti qualcosa di duraturo, oppure li scrivi dal pannello.

Tutto resta in un file JSON nella cartella di stato, visibile e cancellabile
dal pannello: niente parte verso servizi esterni se non dentro il messaggio
al cervello che hai scelto tu.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import unicodedata
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

DEFAULT_NAME = "Tsukumo"
DEFAULT_TRAITS = "warm, concise and a little playful"

#: Oltre questi limiti i ricordi piu' vecchi escono dal prompt (restano nel file).
MAX_FACTS_IN_PROMPT = 24
MAX_PROMPT_CHARS = 1400
MAX_FACT_CHARS = 200


@dataclass
class Fact:
    text: str
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:10])
    created: float = field(default_factory=time.time)
    #: "user" (detto o scritto da te) o "brain" (annotato dal cervello).
    source: str = "user"

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def _normal(text: str) -> str:
    """Per confrontare due ricordi: minuscolo, senza accenti ne' punteggiatura."""
    decomposed = unicodedata.normalize("NFD", text.lower())
    plain = "".join(char for char in decomposed if not unicodedata.combining(char))
    return " ".join(re.findall(r"\w+", plain))


def _clean_fact(text: str) -> str:
    fact = " ".join(str(text or "").split()).strip(" .;,")
    return fact[:MAX_FACT_CHARS]


class MemoryStore:
    """Personalita' e ricordi, salvati su disco a ogni modifica."""

    def __init__(self, path: Path | None) -> None:
        self.path = path
        self.name = DEFAULT_NAME
        self.traits = DEFAULT_TRAITS
        self._facts: list[Fact] = []
        self._lock = threading.Lock()
        self._load()

    # ------------------------------------------------------------ disco
    def _load(self) -> None:
        if not self.path or not self.path.is_file():
            return
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("Memoria non leggibile da %s: %s", self.path, exc)
            return
        persona = raw.get("persona") or {}
        self.name = str(persona.get("name") or DEFAULT_NAME)
        self.traits = str(persona.get("traits") or DEFAULT_TRAITS)
        for item in raw.get("facts") or []:
            if isinstance(item, dict) and item.get("text"):
                self._facts.append(Fact(**{k: v for k, v in item.items() if k in Fact.__dataclass_fields__}))

    def _save(self) -> None:
        if not self.path:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            payload = {"persona": {"name": self.name, "traits": self.traits}, "facts": [f.as_dict() for f in self._facts]}
            temporary = self.path.with_suffix(".tmp")
            temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
            os.replace(temporary, self.path)
        except OSError as exc:
            logger.warning("Memoria non salvata: %s", exc)

    # ------------------------------------------------------------ lettura
    def facts(self) -> list[Fact]:
        with self._lock:
            return list(self._facts)

    def as_dict(self) -> dict[str, Any]:
        return {
            "persona": {"name": self.name, "traits": self.traits},
            "defaults": {"name": DEFAULT_NAME, "traits": DEFAULT_TRAITS},
            "facts": [fact.as_dict() for fact in self.facts()],
        }

    # ------------------------------------------------------------ modifiche
    def set_persona(self, name: str | None = None, traits: str | None = None) -> None:
        with self._lock:
            if name is not None:
                self.name = " ".join(name.split())[:40] or DEFAULT_NAME
            if traits is not None:
                self.traits = " ".join(traits.split())[:400] or DEFAULT_TRAITS
            self._save()

    def add(self, text: str, source: str = "user") -> Fact | None:
        """Aggiunge un ricordo; ``None`` se e' vuoto o c'era gia'."""
        fact_text = _clean_fact(text)
        key = _normal(fact_text)
        if len(key) < 3:
            return None
        with self._lock:
            for existing in self._facts:
                old = _normal(existing.text)
                if old == key or (len(old) > 12 and old in key):
                    # Stesso ricordo, magari con un dettaglio in piu': tieni il piu' completo.
                    if len(key) > len(old):
                        existing.text = fact_text
                        self._save()
                    return None
            fact = Fact(fact_text, source=source)
            self._facts.append(fact)
            self._save()
        logger.info("Ricordo nuovo (%s): %r", source, fact_text)
        return fact

    def remove(self, fact_id: str) -> Fact | None:
        with self._lock:
            for index, fact in enumerate(self._facts):
                if fact.id == fact_id:
                    del self._facts[index]
                    self._save()
                    return fact
        return None

    def forget(self, text: str) -> Fact | None:
        """Toglie il ricordo che somiglia di piu' a ``text`` (almeno meta' delle parole)."""
        wanted = set(_normal(text).split())
        if not wanted:
            return None
        best: tuple[float, Fact] | None = None
        for fact in self.facts():
            words = set(_normal(fact.text).split())
            score = len(wanted & words) / len(wanted)
            if score >= 0.5 and (best is None or score > best[0]):
                best = (score, fact)
        return self.remove(best[1].id) if best else None

    def clear(self) -> None:
        with self._lock:
            self._facts.clear()
            self._save()

    # ------------------------------------------------------------ prompt
    def directive(self, agent: bool) -> str:
        """Personalita' e ricordi, da aggiungere ai vincoli del parlato.

        ``agent``: un agente ha gia' un suo carattere e i suoi strumenti; gli
        si chiede solo di parlare come il personaggio.
        """
        if agent:
            parts = [f"You are the voice of {self.name}; speak with this personality: {self.traits}."]
        else:
            parts = [f"Your name is {self.name}. Personality: {self.traits}."]
        facts = self.facts()[-MAX_FACTS_IN_PROMPT:]
        if facts:
            known = "; ".join(fact.text for fact in facts)
            while len(known) > MAX_PROMPT_CHARS and facts:
                facts = facts[1:]
                known = "; ".join(fact.text for fact in facts)
            parts.append(f"What you remember about the user: {known}.")
        parts.append(
            "When the user tells you a lasting fact or preference about themselves, append at the very end "
            "[[remember: the fact, in a few words]]. Never read or mention the tag."
        )
        return " ".join(parts)


# ---------------------------------------------------------------------------
# Comandi a voce: "ricordati che...", "dimentica che...", "cosa ricordi di me?"
# ---------------------------------------------------------------------------
_REMEMBER = re.compile(
    r"^\s*(?:(?:hey|ehi|ok)\s+\w+[,\s]+)?(?:ricordati|ricorda|tieni a mente|remember)\s+(?:che|that)\s+(?P<fact>.+?)\s*[.!]?\s*$",
    re.IGNORECASE,
)
_FORGET = re.compile(
    r"^\s*(?:dimentica|scordati|forget)\s+(?:che|that|di|about)\s+(?P<fact>.+?)\s*[.!]?\s*$",
    re.IGNORECASE,
)
#: "Ricordati che domani alle 9 ho il dentista" e' un promemoria, non un ricordo:
#: con un riferimento di tempo la frase passa al cervello, che sa programmarlo.
_TIMELY = re.compile(
    r"\b(?:oggi|domani|dopodomani|stasera|stanotte|stamattina|tra\s+\d+|fra\s+\d+|alle\s+\d|all'\d|"
    r"luned[iì]|marted[iì]|mercoled[iì]|gioved[iì]|venerd[iì]|sabato|domenica|"
    r"today|tomorrow|tonight|in\s+\d+\s+\w+|at\s+\d|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b",
    re.IGNORECASE,
)
_RECALL = re.compile(
    r"^\s*(?:cosa|che cosa|che)\s+(?:ricordi|sai)\s+di\s+me\b|^\s*what\s+do\s+you\s+(?:remember|know)\s+about\s+me\b",
    re.IGNORECASE,
)

#: Frasi di risposta ai comandi: italiano e inglese, il resto ripiega sull'inglese.
_REPLIES = {
    "it": {
        "saved": "Va bene, me lo ricordo.",
        "known": "Lo so già, me lo avevi detto.",
        "forgot": "Fatto, l'ho dimenticato.",
        "unknown": "Non trovo niente del genere fra i miei ricordi.",
        "empty": "Per ora non ricordo niente di te. Dimmi pure qualcosa, con: ricordati che...",
        "list": "Ecco cosa ricordo: {facts}.",
    },
    "en": {
        "saved": "Okay, I'll remember that.",
        "known": "I already know, you told me.",
        "forgot": "Done, I forgot it.",
        "unknown": "I can't find anything like that in my memories.",
        "empty": "I don't remember anything about you yet. Tell me something with: remember that...",
        "list": "Here's what I remember: {facts}.",
    },
}


def _reply(language: str, key: str, **values: str) -> str:
    table = _REPLIES.get(language, _REPLIES["en"])
    return table[key].format(**values)


def memory_command(text: str, store: MemoryStore, language: str) -> str | None:
    """Risposta a un comando sulla memoria, o ``None`` se non e' un comando."""
    code = "it" if language.startswith("it") else "en"
    match = _REMEMBER.match(text)
    if match and not _TIMELY.search(match.group("fact")):
        fact = store.add(match.group("fact"))
        return _reply(code, "saved" if fact else "known")
    match = _FORGET.match(text)
    if match:
        return _reply(code, "forgot" if store.forget(match.group("fact")) else "unknown")
    if _RECALL.match(text):
        facts = store.facts()[-5:]
        if not facts:
            return _reply(code, "empty")
        return _reply(code, "list", facts="; ".join(fact.text for fact in facts))
    return None


def fact_from_tag(tag: str) -> str | None:
    """``[[remember: ...]]`` -> il fatto, oppure ``None`` se l'etichetta non e' un ricordo."""
    match = re.match(r"^\[\[\s*remember\s*:?\s*(?P<fact>.+?)\s*\]\]$", tag, re.IGNORECASE | re.DOTALL)
    if not match:
        return None
    fact = _clean_fact(match.group("fact"))
    return fact or None
