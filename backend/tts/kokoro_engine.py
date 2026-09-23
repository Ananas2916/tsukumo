"""Motore Kokoro TTS in-process, basato su ``kokoro-onnx``.

Gira interamente in locale: carica il modello ONNX (``kokoro-v1.0.onnx``) e il
pacchetto di voci (``voices-v1.0.bin``) scaricati da ``scripts/download_models.py``.
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
    "Pesi Kokoro non trovati. Eseguili una volta con:\n"
    "    python scripts/download_models.py\n"
    "oppure imposta DC_KOKORO_MODEL / DC_KOKORO_VOICES sui percorsi corretti."
)


class KokoroTTS(TTSEngine):
    """Wrapper thread-safe attorno a ``kokoro_onnx.Kokoro``."""

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
            from kokoro_onnx import Kokoro  # import pigro: pesa ~1 s
        except ImportError as exc:  # pragma: no cover - dipende dall'ambiente
            raise RuntimeError(
                "Il pacchetto 'kokoro-onnx' non e' installato. "
                "Esegui: pip install -r requirements.txt"
            ) from exc

        logger.info("Carico Kokoro da %s", model_path)
        self._kokoro = Kokoro(str(model_path), str(voices_path))
        self._lock = threading.Lock()  # onnxruntime + una sola sessione
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
                except Exception:  # pragma: no cover - API opzionale
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
        # La pronuncia segue la voce: if_sara legge in italiano anche se
        # DC_LANGUAGE e' rimasto su en-us.
        lang = voice_language(chosen_voice, self.language)

        with self._lock:
            samples, sample_rate, timings = self._create(clean, chosen_voice, chosen_speed, lang)

        audio = np.asarray(samples, dtype=np.float32).reshape(-1)
        # La trascrizione IPA serve solo se mancano i timing esatti: evitiamo
        # di chiamare espeak per niente.
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
        """Sintetizza chiedendo i tempi per fonema, con fallback su ``create``.

        ``create_timed`` restituisce i timing solo se il modello ONNX espone
        l'output delle durate; in caso contrario (o su versioni piu' vecchie
        della libreria) ripieghiamo sulla sintesi normale e il tempismo viene
        ricostruito dall'energia dell'audio.
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
                # Nessun timing disponibile: inutile richiederli ogni volta.
                self._timed_broken = True
                logger.info("Il modello non espone le durate: uso l'allineamento sull'audio")
                return samples, sample_rate, None
            except (AttributeError, TypeError) as exc:
                logger.info("create_timed non disponibile (%s): uso create()", exc)
                self._timed_broken = True

        samples, sample_rate = self._kokoro.create(text, voice=voice, speed=speed, lang=lang)
        return samples, sample_rate, None

    # ------------------------------------------------------------------
    def phonemize(self, text: str, lang: str | None = None) -> str | None:
        """Prova a ottenere l'IPA dal tokenizer interno di kokoro-onnx.

        L'API e' cambiata tra le versioni della libreria, quindi tentiamo le
        firme note in ordine e memorizziamo l'eventuale fallimento per non
        ripetere il tentativo a ogni frase.
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
            except Exception as exc:  # pragma: no cover - espeak assente, ecc.
                logger.warning("Phonemizer non disponibile (%s), uso il G2P interno", exc)
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
