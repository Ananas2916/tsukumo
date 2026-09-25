"""Interfaccia comune ai motori di sintesi vocale."""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field
from typing import Any

import numpy as np

from ..languages import kokoro_voice_info


@dataclass
class Speech:
    """Il risultato di una sintesi: audio + metadati utili al lip-sync."""

    samples: np.ndarray
    sample_rate: int
    text: str
    #: Trascrizione IPA, se il motore riesce a fornirla (migliora il lip-sync).
    phonemes: str | None = None
    #: Timing esatti ``[(simbolo, inizio_s, fine_s), ...]``, se il modello li
    #: espone: e' la sorgente migliore in assoluto per il lip-sync. Il simbolo
    #: e' un fonema IPA (Kokoro) oppure gia' un ``Phone`` (le lettere con i
    #: loro tempi che restituisce ElevenLabs, vedi ``phonemes.phones_for_letters``).
    timings: list[tuple[Any, float, float]] | None = None
    #: Informazioni libere per il debug (voce usata, engine, ...).
    meta: dict = field(default_factory=dict)

    @property
    def duration(self) -> float:
        if self.sample_rate <= 0:
            return 0.0
        return float(len(self.samples)) / float(self.sample_rate)


@dataclass
class VoiceInfo:
    """Una voce descritta abbastanza da poterla scegliere senza provarle tutte."""

    id: str
    name: str = ""
    #: Codice lingua corto ("it", "en"...), vuoto se la voce e' multilingua.
    language: str = ""
    #: "female", "male" oppure vuoto.
    gender: str = ""
    description: str = ""
    #: URL di un audio d'esempio, se il servizio lo offre (ElevenLabs).
    preview: str = ""

    def as_dict(self) -> dict[str, str]:
        data = asdict(self)
        data["name"] = self.name or self.id
        return data


_LOCALE = re.compile(r"^([a-z]{2,3})[-_][A-Z]{2}")


def locale_language(voice: str | None) -> str:
    """``it-IT-ElsaNeural`` -> ``it``; stringa vuota se il nome non lo dice."""
    match = _LOCALE.match(voice or "")
    return match.group(1) if match else ""


def pcm16_to_float(data: bytes) -> np.ndarray:
    """PCM 16 bit little endian (quello che restituiscono le API) in float32 -1..1."""
    usable = len(data) - (len(data) % 2)
    return np.frombuffer(data[:usable], dtype="<i2").astype(np.float32) / 32768.0


def silence(sample_rate: int, engine: str) -> Speech:
    """Il risultato di una frase vuota."""
    return Speech(samples=np.zeros(0, dtype=np.float32), sample_rate=sample_rate, text="", meta={"engine": engine})


class TTSEngine(ABC):
    """Contratto minimo che ogni backend TTS deve rispettare."""

    #: Nome breve dell'engine, esposto via /api/health.
    name: str = "tts"
    #: Voce usata quando non ne viene chiesta una (o quella chiesta non esiste).
    default_voice: str = ""

    @abstractmethod
    def synthesize(
        self,
        text: str,
        voice: str | None = None,
        speed: float | None = None,
    ) -> Speech:
        """Sintetizza ``text`` e restituisce audio mono float32 in -1..1."""

    @abstractmethod
    def voices(self) -> list[str]:
        """Elenco degli id delle voci disponibili."""

    def voice_catalog(self) -> list[VoiceInfo]:
        """Le voci con nome, lingua e genere, per il selettore del pannello.

        Il default ricava cio' che puo' dagli id: le voci Kokoro dicono lingua e
        genere nelle prime due lettere (``if_sara``), quelle Microsoft e Google
        nel prefisso (``it-IT-ElsaNeural``).
        """
        catalog = []
        for voice in self.voices():
            info = kokoro_voice_info(voice)
            if info:
                catalog.append(VoiceInfo(id=voice, name=info["name"], language=info["language"], gender=info["gender"]))
            else:
                catalog.append(VoiceInfo(id=voice, language=locale_language(voice)))
        return catalog

    def language_of(self, voice: str | None) -> str | None:
        """Lingua che la voce sa pronunciare, o ``None`` se e' multilingua.

        Serve a decidere in che lingua deve rispondere il cervello: una voce
        inglese che legge l'italiano e' incomprensibile, mentre una voce
        multilingua (ElevenLabs, OpenAI) sta bene con qualunque lingua.
        """
        info = kokoro_voice_info(voice or "")
        if info:
            return info["language"]
        if "multilingual" in (voice or "").lower():
            return None
        return locale_language(voice) or None

    def resolve_voice(self, requested: str | None) -> str:
        """La voce richiesta se questo motore la conosce, altrimenti la sua predefinita.

        Le voci sono specifiche del motore: ``af_heart`` e' un nome Kokoro e non
        esiste su ElevenLabs. Passando da un motore all'altro la voce salvata
        non deve far fallire la sintesi.
        """
        if requested:
            known = self.voices()
            if requested in known or not known:
                return requested
        return self.default_voice or (self.voices() or [""])[0]

    def check(self) -> dict[str, Any]:
        """Verifica che il motore funzioni davvero (chiave valida, server acceso...).

        Restituisce ``{"ok": bool, "detail": str, ...}``; i motori a consumo ci
        aggiungono ``account`` con quanto resta del piano. Puo' fare rete: la
        chiama il pannello quando premi "Verifica", mai il monitor.
        """
        voices = self.voices()
        return {"ok": True, "detail": f"{len(voices)} voci disponibili"}

    def phonemize(self, text: str, lang: str | None = None) -> str | None:
        """Trascrizione IPA del testo, se il motore la espone."""
        return None

    def close(self) -> None:
        """Rilascia eventuali risorse (sessioni ONNX, client HTTP, ...)."""
