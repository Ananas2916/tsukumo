"""Preferenze del companion che non sono motori: quanto chiacchiera e di cosa.

Stanno in ``state/preferences.json`` (non nel ``.env``: si cambiano dal
pannello a ogni momento). Un file rotto o assente vale come i default.
"""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

#: Quanto spesso parla di sua iniziativa (commenti su video, notizie, curiosita').
CHATTER_LEVELS = ("off", "rare", "normal", "chatty")

#: Argomenti dei commenti spontanei, accendibili uno per uno.
TOPICS = ("night", "breaks", "weather", "battery", "usage", "youtube", "news", "facts", "films")

DEFAULTS: dict[str, Any] = {
    "chatter": "normal",
    "topics": {topic: True for topic in TOPICS},
    #: Citta' per il meteo; vuota = posizione approssimativa dall'indirizzo IP.
    "city": "",
    #: Chi scrive le chiacchiere: un motore LLM cloud o locale (``openrouter``,
    #: ``ollama``...), vuoto = il cervello principale. Cosi' un agente a consumo
    #: non spende un turno per ogni notizia commentata.
    "brain": "",
    #: I modelli di quel motore, in fila separata da virgole: se il primo non
    #: risponde (i gratuiti a volte sono saturi) si prova il successivo.
    "brainModels": "",
}

_ENGINE_ID = re.compile(r"^[a-z0-9_]{0,40}$")


class Preferences:
    def __init__(self, path: Path | None) -> None:
        self.path = path
        self.data: dict[str, Any] = json.loads(json.dumps(DEFAULTS))
        if path and path.is_file():
            try:
                self.update(json.loads(path.read_text(encoding="utf-8")), save=False)
            except (OSError, ValueError) as exc:
                logger.warning("Preferenze non leggibili da %s: %s", path, exc)

    @property
    def chatter(self) -> str:
        return self.data["chatter"]

    @property
    def city(self) -> str:
        return self.data["city"]

    @property
    def brain(self) -> str:
        return self.data["brain"]

    @property
    def brain_models(self) -> str:
        return self.data["brainModels"]

    def topic(self, name: str) -> bool:
        return bool(self.data["topics"].get(name, True))

    def update(self, changes: dict[str, Any], save: bool = True) -> dict[str, Any]:
        """Applica solo i campi noti e validi; il resto si ignora."""
        if changes.get("chatter") in CHATTER_LEVELS:
            self.data["chatter"] = changes["chatter"]
        if isinstance(changes.get("city"), str):
            self.data["city"] = changes["city"].strip()[:80]
        if isinstance(changes.get("brain"), str) and _ENGINE_ID.match(changes["brain"].strip()):
            self.data["brain"] = changes["brain"].strip()
        if isinstance(changes.get("brainModels"), str):
            names = [name.strip() for name in changes["brainModels"].split(",") if name.strip()]
            self.data["brainModels"] = ", ".join(names)[:400]
        topics = changes.get("topics")
        if isinstance(topics, dict):
            for name, value in topics.items():
                if name in TOPICS:
                    self.data["topics"][name] = bool(value)
        if save:
            self._save()
        return self.as_dict()

    def as_dict(self) -> dict[str, Any]:
        return json.loads(json.dumps(self.data))

    def _save(self) -> None:
        if not self.path:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_suffix(".tmp")
            temporary.write_text(json.dumps(self.data, ensure_ascii=False, indent=1), encoding="utf-8")
            os.replace(temporary, self.path)
        except OSError as exc:
            logger.warning("Preferenze non salvate: %s", exc)
