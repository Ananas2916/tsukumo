"""Registry of the providers (LLM, TTS, STT) and their configuration schemas.

Every provider describes itself: what it's called, what it needs to work,
how much it costs and what type each field is. The frontend reads these
schemas from ``GET /api/providers`` and **draws the panel by itself**, so
adding a new engine doesn't require touching a line of interface.

It's also the only place where it says which environment variable matches
which field, so ``.env`` and panel can't diverge.

Texts (labels, help, descriptions) are English; the frontend's catalog
translates them (frontend/src/i18n/it.js).
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Literal

Kind = Literal["llm", "tts", "stt"]

#: Field types the panel can draw.
FieldType = Literal["text", "password", "url", "number", "bool", "select", "textarea"]

#: Families the panel groups the engines into.
#:  - ``agent``: a real agent, with memory and tools of its own (OpenClaw,
#:    Claude Code, Codex, Hermes...). The companion is its voice and face.
#:  - ``local``: a model or a voice running on your computer.
#:  - ``cloud``: an online service, usually with an API key.
#:  - ``test``: service engines to try the chain without installing anything.
Category = Literal["agent", "local", "cloud", "test"]

#: How much it costs to use: ``free``, ``freemium`` (free plan, then pay per
#: use), ``paid`` (pay per use), ``subscription`` (included in a subscription).
Pricing = Literal["free", "freemium", "paid", "subscription"]


@dataclass(frozen=True)
class ProviderField:
    """A single configuration parameter of a provider."""

    #: Suffix of the environment variable, without ``DC_`` (e.g. ``OLLAMA_MODEL``).
    env: str
    label: str
    type: FieldType = "text"
    default: Any = ""
    placeholder: str = ""
    help: str = ""
    #: If true, the panel masks it and the API never returns its value.
    secret: bool = False
    #: Only for ``type="select"``: ``[{"value": ..., "label": ...}, ...]``.
    options: tuple[dict[str, str], ...] = ()
    #: The options come from the engine itself after a check (e.g. ``voices``:
    #: the voices of your ElevenLabs account). The field stays writable by hand.
    source: str = ""
    #: A field for those who know what they're doing: the panel hides it under "Advanced".
    advanced: bool = False

    def as_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["options"] = list(self.options)
        return data


@dataclass(frozen=True)
class ProviderSpec:
    """Describes a selectable engine, with everything needed to configure it."""

    id: str
    label: str
    kind: Kind
    description: str = ""
    #: A single line, for the closed card in the panel.
    tagline: str = ""
    #: Runs entirely locally, with no keys or network to third parties.
    local: bool = True
    category: Category = "local"
    pricing: Pricing = "free"
    #: To offer first to whoever doesn't know what to choose.
    recommended: bool = False
    #: Alternative names accepted in ``DC_*_BACKEND`` for backward compatibility.
    aliases: tuple[str, ...] = ()
    fields: tuple[ProviderField, ...] = ()
    #: Non-obvious requirements (pip packages, weights to download, servers to start).
    requires: tuple[str, ...] = ()
    #: The engine exposes a list of selectable voices (TTS only).
    has_voices: bool = False
    #: Where the key is created or the program downloaded.
    docs: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "kind": self.kind,
            "description": self.description,
            "tagline": self.tagline or self.description,
            "local": self.local,
            "category": self.category,
            "pricing": self.pricing,
            "recommended": self.recommended,
            "requires": list(self.requires),
            "hasVoices": self.has_voices,
            "docs": self.docs,
            "fields": [f.as_dict() for f in self.fields],
        }


class Registry:
    """A collection of ``ProviderSpec`` that can be queried by id or alias."""

    def __init__(self, kind: Kind) -> None:
        self.kind = kind
        self._specs: dict[str, ProviderSpec] = {}
        self._aliases: dict[str, str] = {}

    def register(self, spec: ProviderSpec) -> ProviderSpec:
        if spec.kind != self.kind:
            raise ValueError(f"{spec.id!r} is of kind {spec.kind!r}, expected {self.kind!r}")
        self._specs[spec.id] = spec
        for alias in spec.aliases:
            self._aliases[alias] = spec.id
        return spec

    def resolve(self, name: str | None) -> str | None:
        """Normalizes an id or alias into the canonical id, or ``None`` if unknown."""
        if not name:
            return None
        key = name.strip().lower()
        if key in self._specs:
            return key
        return self._aliases.get(key)

    def get(self, name: str | None) -> ProviderSpec | None:
        resolved = self.resolve(name)
        return self._specs.get(resolved) if resolved else None

    def all(self) -> list[ProviderSpec]:
        return list(self._specs.values())

    def as_list(self) -> list[dict[str, Any]]:
        return [spec.as_dict() for spec in self._specs.values()]


LLM_REGISTRY = Registry("llm")
TTS_REGISTRY = Registry("tts")
STT_REGISTRY = Registry("stt")

REGISTRIES: dict[str, Registry] = {
    "llm": LLM_REGISTRY,
    "tts": TTS_REGISTRY,
    "stt": STT_REGISTRY,
}


def describe_all() -> dict[str, list[dict[str, Any]]]:
    """All the schemas, grouped by kind: it's the /api/providers payload."""
    return {kind: registry.as_list() for kind, registry in REGISTRIES.items()}
