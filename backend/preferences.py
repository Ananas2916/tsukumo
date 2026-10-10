"""The companion's preferences that aren't engines: how much she chats and about what.

They live in ``state/preferences.json`` (not in ``.env``: they're changed from
the panel at any time). A broken or missing file counts as the defaults.
"""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

#: How often she speaks on her own (comments on videos, news, fun facts).
CHATTER_LEVELS = ("off", "rare", "normal", "chatty")

#: Topics of the spontaneous comments, each one can be turned on or off.
TOPICS = ("night", "breaks", "weather", "battery", "usage", "youtube", "news", "facts", "films")

DEFAULTS: dict[str, Any] = {
    "chatter": "normal",
    "topics": {topic: True for topic in TOPICS},
    #: City for the weather; empty = approximate position from the IP address.
    "city": "",
    #: Who writes the chatter: a cloud or local LLM engine (``openrouter``,
    #: ``ollama``...), empty = the main brain. So a pay-per-use agent doesn't
    #: spend a turn on every news item it comments on.
    "brain": "",
    #: That engine's models, in a comma-separated row: if the first doesn't
    #: answer (the free ones are sometimes saturated) the next is tried.
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
                logger.warning("Preferences unreadable from %s: %s", path, exc)

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
        """Applies only the known, valid fields; the rest is ignored."""
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
            logger.warning("Preferences not saved: %s", exc)
