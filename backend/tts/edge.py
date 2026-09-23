"""Voci neurali di Microsoft Edge, tramite il pacchetto ``edge-tts``.

Sono gratuite e non richiedono chiave, ma **passano da internet**: e' l'unico
motore TTS di default a non essere offline, quindi va scelto consapevolmente.

Edge restituisce MP3, e nel progetto non c'e' un decoder audio: per questo il
motore richiede anche ``soundfile`` (che porta con se' libsndfile, senza
dipendenze di sistema da installare a mano).
"""

from __future__ import annotations

import asyncio
import io
import logging

import numpy as np

from .base import Speech, TTSEngine

logger = logging.getLogger(__name__)


class EdgeTTS(TTSEngine):
    """Sintesi tramite le voci neurali di Microsoft Edge."""

    name = "edge"

    def __init__(self, default_voice: str = "it-IT-ElsaNeural", default_speed: float = 1.0) -> None:
        try:
            import edge_tts  # noqa: F401
            import soundfile  # noqa: F401
        except ImportError as exc:
            raise RuntimeError(
                "Il motore Edge TTS richiede due pacchetti: "
                "pip install edge-tts soundfile"
            ) from exc

        self.default_voice = default_voice
        self.default_speed = default_speed
        self._voices_cache: list[str] | None = None

    # ------------------------------------------------------------------
    @staticmethod
    def _rate(speed: float) -> str:
        """Traduce un moltiplicatore (1.15) nel formato di Edge ("+15%")."""
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
                logger.warning("Elenco voci Edge non disponibile: %s", exc)
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
            raise RuntimeError(f"Edge TTS non ha restituito audio per la voce {chosen_voice!r}")

        samples, sample_rate = sf.read(io.BytesIO(mp3), dtype="float32", always_2d=False)
        if samples.ndim > 1:  # se arriva stereo, il lip-sync vuole un canale solo
            samples = samples.mean(axis=1)

        return Speech(
            samples=np.ascontiguousarray(samples, dtype=np.float32),
            sample_rate=int(sample_rate),
            text=clean,
            meta={"engine": self.name, "voice": chosen_voice, "speed": chosen_speed},
        )
