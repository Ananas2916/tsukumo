"""Microsoft Edge's neural voices, through the ``edge-tts`` package.

They're free and need no key, but **they go through the internet**: it's the
only default TTS engine that isn't offline, so it must be chosen knowingly.

Edge returns MP3, and the project has no audio decoder: that's why the
engine also needs ``soundfile`` (which brings libsndfile along, with no
system dependencies to install by hand).
"""

from __future__ import annotations

import asyncio
import io
import logging

import numpy as np

from .base import Speech, TTSEngine

logger = logging.getLogger(__name__)


class EdgeTTS(TTSEngine):
    """Synthesis through Microsoft Edge's neural voices."""

    name = "edge"

    def __init__(self, default_voice: str = "it-IT-ElsaNeural", default_speed: float = 1.0) -> None:
        try:
            import edge_tts  # noqa: F401
            import soundfile  # noqa: F401
        except ImportError as exc:
            raise RuntimeError(
                "The Edge TTS engine needs two packages: "
                "pip install edge-tts soundfile"
            ) from exc

        self.default_voice = default_voice
        self.default_speed = default_speed
        self._voices_cache: list[str] | None = None

    # ------------------------------------------------------------------
    @staticmethod
    def _rate(speed: float) -> str:
        """Turns a multiplier (1.15) into Edge's format ("+15%")."""
        percent = int(round((speed - 1.0) * 100))
        return f"{percent:+d}%"

    # ------------------------------------------------------------------
    def voices(self) -> list[str]:
        if self._voices_cache is None:
            import edge_tts

            try:
                found = asyncio.run(edge_tts.list_voices())
                self._voices_cache = sorted(v["ShortName"] for v in found)
            except Exception as exc:
                logger.warning("Edge voice list unavailable: %s", exc)
                self._voices_cache = [self.default_voice]
        return list(self._voices_cache)

    # ------------------------------------------------------------------
    def synthesize(
        self,
        text: str,
        voice: str | None = None,
        speed: float | None = None,
    ) -> Speech:
        clean = (text or "").strip()
        chosen_voice = voice or self.default_voice
        chosen_speed = float(speed if speed is not None else self.default_speed)

        if not clean:
            return Speech(
                samples=np.zeros(0, dtype=np.float32),
                sample_rate=24000,
                text="",
                meta={"engine": self.name},
            )

        import edge_tts
        import soundfile as sf

        async def _collect() -> bytes:
            communicate = edge_tts.Communicate(clean, chosen_voice, rate=self._rate(chosen_speed))
            chunks: list[bytes] = []
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    chunks.append(chunk["data"])
            return b"".join(chunks)

        mp3 = asyncio.run(_collect())
        if not mp3:
            raise RuntimeError(f"Edge TTS returned no audio for the voice {chosen_voice!r}")

        samples, sample_rate = sf.read(io.BytesIO(mp3), dtype="float32", always_2d=False)
        if samples.ndim > 1:  # if it arrives in stereo, the lip-sync wants a single channel
            samples = samples.mean(axis=1)

        return Speech(
            samples=np.ascontiguousarray(samples, dtype=np.float32),
            sample_rate=int(sample_rate),
            text=clean,
            meta={"engine": self.name, "voice": chosen_voice, "speed": chosen_speed},
        )
