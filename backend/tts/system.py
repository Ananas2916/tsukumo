"""The voices already installed in the operating system, through ``pyttsx3``.

It's the sturdiest fallback engine: on Windows it uses SAPI5, on macOS
NSSpeechSynthesizer, on Linux espeak. No weights to download, no network,
it works everywhere — the quality though is that of the system voices.

``pyttsx3`` can only write to a file, so we synthesize to a temporary WAV and
read it back. It's a synchronous, non-reentrant engine: the lock keeps two
queued sentences from stepping on each other.
"""

from __future__ import annotations

import logging
import tempfile
import threading
from pathlib import Path

import numpy as np

from ..audio import decode_wav
from .base import Speech, TTSEngine

logger = logging.getLogger(__name__)

#: Words per minute the system voices consider "speed 1.0".
_BASE_RATE = 180


class SystemTTS(TTSEngine):
    """Synthesis with the operating system's native voices."""

    name = "system"

    def __init__(self, default_voice: str = "", default_speed: float = 1.0) -> None:
        try:
            import pyttsx3
        except ImportError as exc:
            raise RuntimeError(
                "The system engine needs the 'pyttsx3' package. "
                "Install it with: pip install pyttsx3"
            ) from exc

        self.default_voice = default_voice
        self.default_speed = default_speed
        self._lock = threading.Lock()
        self._engine = pyttsx3.init()
        self._voices = {
            str(v.name): str(v.id) for v in self._engine.getProperty("voices")
        }
        logger.info("System voices available: %d", len(self._voices))

    # ------------------------------------------------------------------
    def voices(self) -> list[str]:
        return sorted(self._voices) or ["default"]

    # ------------------------------------------------------------------
    def synthesize(
        self,
        text: str,
        voice: str | None = None,
        speed: float | None = None,
    ) -> Speech:
        clean = (text or "").strip()
        chosen = voice or self.default_voice
        chosen_speed = float(speed if speed is not None else self.default_speed)

        if not clean:
            return Speech(
                samples=np.zeros(0, dtype=np.float32),
                sample_rate=22050,
                text="",
                meta={"engine": self.name},
            )

        # Voices are engine-specific: a Kokoro name like "af_heart" doesn't exist
        # here. If we don't recognize it we use the first system voice, and in meta
        # we report the real one — so the panel doesn't lie.
        if chosen not in self._voices:
            chosen = next(iter(sorted(self._voices)), "default")

        with self._lock:
            if chosen in self._voices:
                self._engine.setProperty("voice", self._voices[chosen])
            self._engine.setProperty("rate", int(_BASE_RATE * chosen_speed))

            # delete=False: on Windows the file can't be reopened while it's open.
            handle = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
            handle.close()
            target = Path(handle.name)
            try:
                self._engine.save_to_file(clean, str(target))
                self._engine.runAndWait()
                samples, sample_rate = decode_wav(target.read_bytes())
            finally:
                target.unlink(missing_ok=True)

        return Speech(
            samples=samples,
            sample_rate=sample_rate,
            text=clean,
            meta={"engine": self.name, "voice": chosen, "speed": chosen_speed},
        )
