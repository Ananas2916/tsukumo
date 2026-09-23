"""Registro dei provider (LLM, TTS, STT) e dei loro schemi di configurazione.

Ogni provider si descrive da solo: come si chiama, cosa gli serve per
funzionare e che tipo e' ogni campo. Il frontend legge questi schemi da
``GET /api/providers`` e **disegna il pannello da solo**, quindi aggiungere un
motore nuovo non richiede di toccare una riga di interfaccia.

E' anche l'unico posto dove sta scritto quale variabile d'ambiente corrisponde
a quale campo, cosi' ``.env`` e pannello non possono divergere.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

Kind = Literal["llm", "tts", "stt"]

#: Tipi di campo che il pannello sa disegnare.
FieldType = Literal["text", "password", "url", "number", "bool", "select"]


@dataclass(frozen=True)
class ProviderField:
    """Un singolo parametro di configurazione di un provider."""

    #: Suffisso della variabile d'ambiente, senza ``DC_`` (es. ``OLLAMA_MODEL``).
    env: str
    label: str
    type: FieldType = "text"
    default: Any = ""
    placeholder: str = ""
    help: str = ""
    #: Se vero, il pannello lo maschera e l'API non ne restituisce mai il valore.
    secret: bool = False
    #: Solo per ``type="select"``: ``[{"value": ..., "label": ...}, ...]``.
    options: tuple[dict[str, str], ...] = ()

    def as_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["options"] = list(self.options)
        return data


@dataclass(frozen=True)
class ProviderSpec:
    """Descrive un motore selezionabile, con tutto cio' che serve a configurarlo."""

    id: str
    label: str
    kind: Kind
    description: str = ""
    #: Gira interamente in locale, senza chiavi ne' rete verso terzi.
    local: bool = True
    #: Nomi alternativi accettati in ``DC_*_BACKEND`` per retrocompatibilita'.
    aliases: tuple[str, ...] = ()
    fields: tuple[ProviderField, ...] = ()
    #: Requisiti non ovvi (pacchetti pip, pesi da scaricare, server da avviare).
    requires: tuple[str, ...] = ()
    #: L'engine espone un elenco di voci selezionabili (solo TTS).
    has_voices: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "kind": self.kind,
            "description": self.description,
            "local": self.local,
            "requires": list(self.requires),
            "hasVoices": self.has_voices,
            "fields": [f.as_dict() for f in self.fields],
        }


class Registry:
    """Raccolta di ``ProviderSpec`` interrogabile per id o alias."""

    def __init__(self, kind: Kind) -> None:
        self.kind = kind
        self._specs: dict[str, ProviderSpec] = {}
        self._aliases: dict[str, str] = {}

    def register(self, spec: ProviderSpec) -> ProviderSpec:
        if spec.kind != self.kind:
            raise ValueError(f"{spec.id!r} e' di tipo {spec.kind!r}, atteso {self.kind!r}")
        self._specs[spec.id] = spec
        for alias in spec.aliases:
            self._aliases[alias] = spec.id
        return spec

    def resolve(self, name: str | None) -> str | None:
        """Normalizza un id o alias nell'id canonico, o ``None`` se sconosciuto."""
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
    """Tutti gli schemi, raggruppati per tipo: e' il payload di /api/providers."""
    return {kind: registry.as_list() for kind, registry in REGISTRIES.items()}
