"""In-process Kokoro TTS engine, based on ``kokoro-onnx``.

It runs entirely locally: it loads the ONNX model (``kokoro-v1.0.onnx``) and
the voice pack (``voices-v1.0.bin``) downloaded by ``scripts/download_models.py``.
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path

import numpy as np

from ..languages import voice_language
from .base import Speech, TTSEngine

logger = logging.getLogger(__name__)

DOWNLOAD_HINT = (
    "Kokoro weights not found. Run once:\n"
    "    python scripts/download_models.py\n"
    "or set DC_KOKORO_MODEL / DC_KOKORO_VOICES to the right paths."
)


class KokoroTTS(TTSEngine):
    """Thread-safe wrapper around ``kokoro_onnx.Kokoro``."""

    name = "kokoro"

    def __init__(
        self,
        model_path: Path,
        voices_path: Path,
        default_voice: str = "af_heart",
        default_speed: float = 1.0,
        language: str = "en-us",
    ) -> None:
        missing = [p for p in (model_path, voices_path) if not Path(p).is_file()]
        if missing:
            names = ", ".join(str(p) for p in missing)
            raise FileNotFoundError(f"{DOWNLOAD_HINT}\nMancano: {names}")

        try:
            from kokoro_onnx import Kokoro  # lazy import: it weighs ~1 s
        except ImportError as exc:  # pragma: no cover - depends on the environment
            raise RuntimeError(
                "The 'kokoro-onnx' package is not installed. "
                "Esegui: pip install -r requirements.txt"
            ) from exc

        logger.info("Loading Kokoro from %s", model_path)
        self._kokoro = Kokoro(str(model_path), str(voices_path))
        self._lock = threading.Lock()  # onnxruntime + a single session
        self.default_voice = default_voice
        self.default_speed = default_speed
        self.language = language
        self._voices_cache: list[str] | None = None
        self._phonemizer_broken = False
        self._timed_broken = False

    # ------------------------------------------------------------------
    def voices(self) -> list[str]:
        if self._voices_cache is None:
            names: list[str] = []
            getter = getattr(self._kokoro, "get_voices", None)
            if callable(getter):
                try:
                    names = sorted(str(v) for v in getter())
                except Exception:  # pragma: no cover - optional API
                    names = []
            if not names:
                raw = getattr(self._kokoro, "voices", None)
                if isinstance(raw, dict):
                    names = sorted(str(v) for v in raw)
            self._voices_cache = names or [self.default_voice]
        return list(self._voices_cache)

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
                sample_rate=24000,
                text="",
                meta={"engine": self.name},
            )

        chosen_voice = voice or self.default_voice
        chosen_speed = float(speed if speed is not None else self.default_speed)
        # The pronunciation follows the voice: if_sara reads in Italian even if
        # DC_LANGUAGE stayed on en-us.
        lang = voice_language(chosen_voice, self.language)

        with self._lock:
            samples, sample_rate, timings = self._create(clean, chosen_voice, chosen_speed, lang)

        audio = np.asarray(samples, dtype=np.float32).reshape(-1)
        # The IPA transcription is needed only if the exact timings are missing: we
        # avoid calling espeak for nothing.
        phonemes = None if timings else self.phonemize(clean, lang)

        return Speech(
            samples=audio,
            sample_rate=int(sample_rate),
            text=clean,
            phonemes=phonemes,
            timings=timings,
            meta={
                "engine": self.name,
                "voice": chosen_voice,
                "speed": chosen_speed,
                "timedLipSync": bool(timings),
            },
        )

    def _create(self, text: str, voice: str, speed: float, lang: str):
        """Synthesizes asking for the per-phoneme timings, falling back on ``create``.

        ``create_timed`` returns the timings only if the ONNX model exposes the
        durations output; otherwise (or on older versions of the library) we fall
        back to the normal synthesis and the timing is rebuilt from the audio's
        energy.
        """
        if not self._timed_broken:
            try:
                samples, sample_rate, timings = self._kokoro.create_timed(
                    text, voice=voice, speed=speed, lang=lang
                )
                converted = [
                    (str(item.phoneme), float(item.start), float(item.end))
                    for item in timings
                    if float(item.end) > float(item.start)
                ]
                if converted:
                    return samples, sample_rate, converted
                # No timing available: no point asking for it every time.
                self._timed_broken = True
                logger.info("The model doesn't expose the durations: using the alignment on the audio")
                return samples, sample_rate, None
            except (AttributeError, TypeError) as exc:
                logger.info("create_timed unavailable (%s): using create()", exc)
                self._timed_broken = True

        samples, sample_rate = self._kokoro.create(text, voice=voice, speed=speed, lang=lang)
        return samples, sample_rate, None

    # ------------------------------------------------------------------
    def phonemize(self, text: str, lang: str | None = None) -> str | None:
        """Tries to get the IPA from kokoro-onnx's internal tokenizer.

        The API changed between the library's versions, so we try the known
        signatures in order and remember a failure so as not to retry at every
        sentence.
        """
        if self._phonemizer_broken:
            return None

        lang = lang or self.language
        tokenizer = getattr(self._kokoro, "tokenizer", None)
        phonemize = getattr(tokenizer, "phonemize", None) if tokenizer else None
        if phonemize is None:
            self._phonemizer_broken = True
            return None

        attempts = (
            lambda: phonemize(text, lang=lang),
            lambda: phonemize(text, lang),
            lambda: phonemize(text),
        )
        for attempt in attempts:
            try:
                result = attempt()
            except TypeError:
                continue
            except Exception as exc:  # pragma: no cover - espeak missing, etc.
                logger.warning("Phonemizer unavailable (%s), using the internal G2P", exc)
                self._phonemizer_broken = True
                return None
            if isinstance(result, (list, tuple)):
                result = " ".join(str(part) for part in result)
            if isinstance(result, str) and result.strip():
                return result

        self._phonemizer_broken = True
        return None

    # ------------------------------------------------------------------
    def close(self) -> None:
        self._kokoro = None  # type: ignore[assignment]
