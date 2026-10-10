"""Common interface of the speech-synthesis engines."""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field
from typing import Any

import numpy as np

from ..languages import KOKORO_DEFAULTS, kokoro_voice_info, short_language


@dataclass
class Speech:
    """The result of a synthesis: audio + metadata useful for the lip-sync."""

    samples: np.ndarray
    sample_rate: int
    text: str
    #: IPA transcription, if the engine can provide it (it improves the lip-sync).
    phonemes: str | None = None
    #: Exact timings ``[(symbol, start_s, end_s), ...]``, if the model exposes
    #: them: by far the best source for the lip-sync. The symbol is an IPA
    #: phoneme (Kokoro) or already a ``Phone`` (the letters with their times
    #: ElevenLabs returns, see ``phonemes.phones_for_letters``).
    timings: list[tuple[Any, float, float]] | None = None
    #: Free information for debugging (voice used, engine, ...).
    meta: dict = field(default_factory=dict)

    @property
    def duration(self) -> float:
        if self.sample_rate <= 0:
            return 0.0
        return float(len(self.samples)) / float(self.sample_rate)


@dataclass
class VoiceInfo:
    """A voice described well enough to choose it without trying them all."""

    id: str
    name: str = ""
    #: Short language code ("it", "en"...), empty if the voice is multilingual.
    language: str = ""
    #: "female", "male" or empty.
    gender: str = ""
    description: str = ""
    #: URL of a sample, if the service offers one (ElevenLabs).
    preview: str = ""
    #: Added by the user (cloned voice): the panel offers to delete it.
    removable: bool = False

    def as_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["name"] = self.name or self.id
        return data


_LOCALE = re.compile(r"^([a-z]{2,3})[-_][A-Z]{2}")


def locale_language(voice: str | None) -> str:
    """``it-IT-ElsaNeural`` -> ``it``; empty string if the name doesn't say."""
    match = _LOCALE.match(voice or "")
    return match.group(1) if match else ""


def pcm16_to_float(data: bytes) -> np.ndarray:
    """16-bit little-endian PCM (what the APIs return) to float32 -1..1."""
    usable = len(data) - (len(data) % 2)
    return np.frombuffer(data[:usable], dtype="<i2").astype(np.float32) / 32768.0


def silence(sample_rate: int, engine: str) -> Speech:
    """The result of an empty sentence."""
    return Speech(samples=np.zeros(0, dtype=np.float32), sample_rate=sample_rate, text="", meta={"engine": engine})


class TTSEngine(ABC):
    """Minimal contract every TTS backend must follow."""

    #: Short name of the engine, exposed via /api/health.
    name: str = "tts"
    #: Voice used when none is asked for (or the requested one doesn't exist).
    default_voice: str = ""
    #: It can clone a voice from an audio file (``add_voice`` / ``remove_voice``).
    can_clone: bool = False

    @abstractmethod
    def synthesize(
        self,
        text: str,
        voice: str | None = None,
        speed: float | None = None,
    ) -> Speech:
        """Synthesizes ``text`` and returns mono float32 audio in -1..1."""

    @abstractmethod
    def voices(self) -> list[str]:
        """List of the available voice ids."""

    def voice_catalog(self) -> list[VoiceInfo]:
        """The voices with name, language and gender, for the panel's picker.

        The default derives what it can from the ids: Kokoro voices say language and
        gender in the first two letters (``if_sara``), Microsoft and Google ones in
        the prefix (``it-IT-ElsaNeural``).
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
        """The language the voice can pronounce, or ``None`` if it's multilingual.

        Needed to decide which language the brain must answer in: an English voice
        reading Italian is incomprehensible, while a multilingual voice (ElevenLabs,
        OpenAI) is fine with any language.
        """
        info = kokoro_voice_info(voice or "")
        if info:
            return info["language"]
        if "multilingual" in (voice or "").lower():
            return None
        return locale_language(voice) or None

    def voice_for_language(self, language: str, catalog: list[VoiceInfo] | None = None) -> str | None:
        """A voice of this engine that speaks ``language`` (``it``), or ``None``.

        Needed to start in the system's language when nobody chose a voice. If the
        default already speaks that language, or is multilingual, it stays. Among
        the candidates the recommended voice is preferred (Kokoro), then one of the
        same gender as the default.
        """
        code = short_language(language)
        if not code:
            return None
        if self.default_voice and short_language(self.language_of(self.default_voice) or code) == code:
            return self.default_voice
        voices = catalog if catalog is not None else self.voice_catalog()
        ids = {voice.id for voice in voices}
        preferred = KOKORO_DEFAULTS.get(code)
        if preferred in ids:
            return preferred
        matches = [voice for voice in voices if short_language(voice.language) == code]
        if not matches:
            return None
        default_gender = next((voice.gender for voice in voices if voice.id == self.default_voice), "")
        matches.sort(key=lambda voice: voice.gender != default_gender)
        return matches[0].id

    def resolve_voice(self, requested: str | None) -> str:
        """The requested voice if this engine knows it, otherwise its default.

        Voices are engine-specific: ``af_heart`` is a Kokoro name and doesn't exist
        on ElevenLabs. Moving from one engine to another, the saved voice must not
        make the synthesis fail.
        """
        if requested:
            known = self.voices()
            if requested in known or not known:
                return requested
        return self.default_voice or (self.voices() or [""])[0]

    def check(self) -> dict[str, Any]:
        """Checks that the engine really works (valid key, server on...).

        Returns ``{"ok": bool, "detail": str, ...}``; pay-per-use engines add
        ``account`` with how much of the plan is left. It may use the network: the
        panel calls it when you press "Check", never the monitor.
        """
        voices = self.voices()
        return {"ok": True, "detail": f"{len(voices)} voices available"}

    def phonemize(self, text: str, lang: str | None = None) -> str | None:
        """IPA transcription of the text, if the engine exposes it."""
        return None

    def close(self) -> None:
        """Releases any resources (ONNX sessions, HTTP clients, ...)."""
