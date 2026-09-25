"""Registro dei provider (LLM, TTS, STT) e dei loro schemi di configurazione.

Ogni provider si descrive da solo: come si chiama, cosa gli serve per
funzionare, quanto costa e che tipo e' ogni campo. Il frontend legge questi
schemi da ``GET /api/providers`` e **disegna il pannello da solo**, quindi
aggiungere un motore nuovo non richiede di toccare una riga di interfaccia.

E' anche l'unico posto dove sta scritto quale variabile d'ambiente corrisponde
a quale campo, cosi' ``.env`` e pannello non possono divergere.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Literal

Kind = Literal["llm", "tts", "stt"]

#: Tipi di campo che il pannello sa disegnare.
FieldType = Literal["text", "password", "url", "number", "bool", "select", "textarea"]

#: Famiglie in cui il pannello raggruppa i motori.
#:  - ``agent``: un agente vero, con memoria e strumenti suoi (OpenClaw,
#:    Claude Code, Codex, Hermes...). Il companion ne e' la voce e la faccia.
#:  - ``local``: un modello o una voce che gira sul tuo computer.
#:  - ``cloud``: un servizio in rete, di solito con una chiave API.
#:  - ``test``: motori di servizio per provare la catena senza installare nulla.
Category = Literal["agent", "local", "cloud", "test"]

#: Quanto costa usarlo: ``free`` (gratis), ``freemium`` (piano gratuito, poi a
#: consumo), ``paid`` (a consumo), ``subscription`` (incluso in un abbonamento).
Pricing = Literal["free", "freemium", "paid", "subscription"]


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
    #: Le opzioni arrivano dal motore stesso dopo una verifica (es. ``voices``:
    #: le voci del tuo account ElevenLabs). Il campo resta scrivibile a mano.
    source: str = ""
    #: Campo per chi sa cosa sta facendo: il pannello lo nasconde sotto "Avanzate".
    advanced: bool = False

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
    #: Una riga sola, per la scheda chiusa nel pannello.
    tagline: str = ""
    #: Gira interamente in locale, senza chiavi ne' rete verso terzi.
    local: bool = True
    category: Category = "local"
    pricing: Pricing = "free"
    #: Da proporre per primo a chi non sa cosa scegliere.
    recommended: bool = False
    #: Nomi alternativi accettati in ``DC_*_BACKEND`` per retrocompatibilita'.
    aliases: tuple[str, ...] = ()
    fields: tuple[ProviderField, ...] = ()
    #: Requisiti non ovvi (pacchetti pip, pesi da scaricare, server da avviare).
    requires: tuple[str, ...] = ()
    #: L'engine espone un elenco di voci selezionabili (solo TTS).
    has_voices: bool = False
    #: Dove si crea la chiave o si scarica il programma.
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
