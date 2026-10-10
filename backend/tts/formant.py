"""Formant vowel synthesizer: a service voice, zero dependencies.

It doesn't replace Kokoro (it isn't intelligible like a real neural voice),
but it produces audio with correct formants for A/E/I/O/U and approximate
consonants. It serves two very concrete purposes:

* trying the whole chain (WebSocket -> audio -> visemes -> blendshapes)
  before downloading Kokoro's ~350 MB of weights;
* having a working fallback if ONNX Runtime doesn't start on the machine.

It's turned on with ``DC_TTS_ENGINE=formant`` or automatically when Kokoro
isn't available and ``DC_TTS_FALLBACK=1``.
"""

from __future__ import annotations

import numpy as np

from ..phonemes import phones_from_text
from .base import Speech, TTSEngine

SAMPLE_RATE = 24000

#: Frequencies of the first three formants (Hz) for each vowel viseme.
_FORMANTS: dict[str, tuple[float, float, float]] = {
    "a": (730.0, 1090.0, 2440.0),
    "e": (530.0, 1840.0, 2480.0),
    "i": (270.0, 2290.0, 3010.0),
    "o": (570.0, 840.0, 2410.0),
    "u": (300.0, 870.0, 2240.0),
}

#: Relative amplitudes of the three formants.
_FORMANT_GAINS = (1.0, 0.55, 0.25)
#: Bandwidth of each formant (Hz).
_FORMANT_BANDWIDTHS = (110.0, 160.0, 220.0)

#: "Reference" length of a phoneme with duration == 1.0.
_UNIT_DURATION = 0.115

#: Available voice profiles: (mean f0 in Hz, vibrato in semitones).
_VOICE_PROFILES: dict[str, tuple[float, float]] = {
    "formant_female": (196.0, 0.22),
    "formant_male": (112.0, 0.18),
    "formant_child": (248.0, 0.30),
}


class FormantTTS(TTSEngine):
    """Generates a "robotic" synthetic voice but with perfectly aligned visemes."""

    name = "formant"

    def __init__(
        self,
        default_voice: str = "formant_female",
        default_speed: float = 1.0,
        sample_rate: int = SAMPLE_RATE,
    ) -> None:
        self.default_voice = (
            default_voice if default_voice in _VOICE_PROFILES else "formant_female"
        )
        self.default_speed = default_speed
        self.sample_rate = sample_rate
        self._rng = np.random.default_rng(1234)

    # ------------------------------------------------------------------
    def voices(self) -> list[str]:
        return sorted(_VOICE_PROFILES)

    # ------------------------------------------------------------------
    def synthesize(
        self,
        text: str,
        voice: str | None = None,
        speed: float | None = None,
    ) -> Speech:
        clean = (text or "").strip()
        if not clean:
            return Speech(
                samples=np.zeros(0, dtype=np.float32),
                sample_rate=self.sample_rate,
                text="",
                meta={"engine": self.name},
            )

        profile = _VOICE_PROFILES.get(voice or self.default_voice)
        if profile is None:
            profile = _VOICE_PROFILES[self.default_voice]
        base_f0, vibrato_depth = profile
        rate = max(0.4, float(speed if speed is not None else self.default_speed))

        phones = phones_from_text(clean)
        chunks: list[np.ndarray] = []
        phase = 0.0  # phase continuity between phonemes: avoids "clicks"

        for index, phone in enumerate(phones):
            duration = phone.duration * _UNIT_DURATION / rate
            length = max(1, int(duration * self.sample_rate))

            if phone.viseme == "sil" and phone.openness < 0.1:
                chunks.append(np.zeros(length, dtype=np.float32))
                continue

            # Slight falling intonation over the sentence + vibrato.
            progress = index / max(1, len(phones) - 1)
            f0 = base_f0 * (1.0 - 0.18 * progress)
            chunk, phase = self._render_phone(phone, length, f0, vibrato_depth, phase)
            chunks.append(chunk)

        audio = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
        peak = float(np.max(np.abs(audio))) if audio.size else 0.0
        if peak > 0.0:
            audio = (audio / peak * 0.85).astype(np.float32)

        return Speech(
            samples=audio,
            sample_rate=self.sample_rate,
            text=clean,
            phonemes=None,
            meta={"engine": self.name, "voice": voice or self.default_voice, "speed": rate},
        )

    # ------------------------------------------------------------------
    def _render_phone(
        self,
        phone,
        length: int,
        f0: float,
        vibrato_depth: float,
        phase: float,
    ) -> tuple[np.ndarray, float]:
        """Additive synthesis: harmonics weighted by the formants' envelope."""
        t = np.arange(length, dtype=np.float32) / self.sample_rate
        formants = _FORMANTS.get(phone.viseme, _FORMANTS["e"])

        # Instantaneous frequency with vibrato, integrated to get the phase.
        vibrato = 1.0 + vibrato_depth * 0.06 * np.sin(2.0 * np.pi * 5.2 * t)
        instantaneous = f0 * vibrato
        phases = phase + 2.0 * np.pi * np.cumsum(instantaneous) / self.sample_rate

        harmonics = int(min(48, (self.sample_rate / 2.0) / max(f0, 1.0)))
        wave = np.zeros(length, dtype=np.float32)
        for k in range(1, harmonics + 1):
            frequency = k * f0
            amplitude = 0.0
            for formant, gain, bandwidth in zip(formants, _FORMANT_GAINS, _FORMANT_BANDWIDTHS):
                amplitude += gain * float(np.exp(-(((frequency - formant) / bandwidth) ** 2)))
            amplitude /= k**0.7  # natural rolloff of the glottal source
            if amplitude > 1e-3:
                wave += amplitude * np.sin(k * phases).astype(np.float32)

        # Consonants (low openness) get a noise component.
        if phone.openness < 0.45:
            noise = self._rng.standard_normal(length).astype(np.float32)
            noise_mix = float(np.clip(0.9 - phone.openness * 1.6, 0.05, 0.9))
            wave = (1.0 - noise_mix) * wave + noise_mix * noise * 0.35

        envelope = _adsr(length)
        level = 0.35 + 0.65 * phone.openness
        out = (wave * envelope * level).astype(np.float32)
        return out, float(phases[-1] if length else phase)


def _adsr(length: int) -> np.ndarray:
    """Attack/decay/sustain/release envelope proportional to the length."""
    if length <= 1:
        return np.ones(length, dtype=np.float32)
    attack = max(1, int(length * 0.15))
    release = max(1, int(length * 0.25))
    sustain = max(0, length - attack - release)
    return np.concatenate(
        [
            np.linspace(0.0, 1.0, attack, dtype=np.float32),
            np.full(sustain, 0.92, dtype=np.float32),
            np.linspace(0.92, 0.0, release, dtype=np.float32),
        ]
    )[:length]
