"""Le voci gia' installate nel sistema operativo, tramite ``pyttsx3``.

E' il motore di riserva piu' robusto: su Windows usa SAPI5, su macOS
NSSpeechSynthesizer, su Linux espeak. Nessun peso da scaricare, nessuna rete,
funziona ovunque — la qualita' pero' e' quella delle voci di sistema.

``pyttsx3`` sa solo scrivere su file, quindi sintetizziamo su un WAV
temporaneo e lo rileggiamo. E' un motore sincrono e non rientrante: il lock
evita che due frasi in coda si calpestino.
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

#: Parole al minuto considerate "velocita' 1.0" dalle voci di sistema.
_BASE_RATE = 180


class SystemTTS(TTSEngine):
    """Sintesi con le voci native del sistema operativo."""

    name = "system"

    def __init__(self, default_voice: str = "", default_speed: float = 1.0) -> None:
        try:
            import pyttsx3
        except ImportError as exc:
            raise RuntimeError(
                "Il motore di sistema richiede il pacchetto 'pyttsx3'. "
                "Installalo con: pip install pyttsx3"
            ) from exc

        self.default_voice = default_voice
        self.default_speed = default_speed
        self._lock = threading.Lock()
        self._engine = pyttsx3.init()
        self._voices = {
            str(v.name): str(v.id) for v in self._engine.getProperty("voices")
        }
        logger.info("Voci di sistema disponibili: %d", len(self._voices))

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

        # Le voci sono specifiche del motore: un nome Kokoro come "af_heart" qui
        # non esiste. Se non lo riconosciamo usiamo la prima voce di sistema, e
        # in meta riportiamo quella vera — cosi' il pannello non mente.
        if chosen not in self._voices:
            chosen = next(iter(sorted(self._voices)), "default")

        with self._lock:
            if chosen in self._voices:
                self._engine.setProperty("voice", self._voices[chosen])
            self._engine.setProperty("rate", int(_BASE_RATE * chosen_speed))

            # delete=False: su Windows il file non e' riapribile finche' e' aperto.
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
