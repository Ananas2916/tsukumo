"""Factory dei motori di riconoscimento vocale.

Due id non hanno un motore lato server e restituiscono ``None``:

* ``none``    — input vocale disattivato, si parla solo scrivendo;
* ``browser`` — la trascrizione la fa il browser (Web Speech API) e al backend
  arriva gia' del testo, quindi non c'e' nulla da istanziare qui.

Il chiamante deve quindi sempre gestire il caso ``None``.
"""

from __future__ import annotations

import logging

from ..config import Settings
from ..providers import STT_REGISTRY
from .base import SAMPLE_RATE, STTEngine, Transcript, from_pcm16, to_pcm16

logger = logging.getLogger(__name__)

__all__ = [
    "STTEngine",
    "Transcript",
    "SAMPLE_RATE",
    "from_pcm16",
    "to_pcm16",
    "create_stt_engine",
]

#: Id che non hanno un'implementazione lato server.
CLIENT_SIDE = {"none", "browser"}


def create_stt_engine(settings: Settings) -> STTEngine | None:
    """Istanzia il motore indicato da ``DC_STT_ENGINE``.

    Restituisce ``None`` se l'input vocale e' disattivato o se la trascrizione
    avviene nel browser. Se il motore richiesto non e' disponibile lo segnala e
    ripiega su ``None``: un riconoscimento vocale mancante non deve impedire di
    usare il companion scrivendo.
    """
    engine = STT_REGISTRY.resolve(settings.stt_engine) or "none"

    if engine in CLIENT_SIDE:
        if engine == "browser":
            logger.info("Riconoscimento vocale: delegato al browser")
        return None

    options = settings.provider_config("stt", engine)

    try:
        if engine == "faster_whisper":
            from .faster_whisper_engine import FasterWhisperSTT

            return FasterWhisperSTT(
                model=str(options.get("WHISPER_MODEL") or "base"),
                device=str(options.get("WHISPER_DEVICE") or "auto"),
                language=str(options.get("WHISPER_LANGUAGE") or "auto"),
            )

        if engine == "whisper_cpp":
            from .http_engines import WhisperCppSTT

            return WhisperCppSTT(
                base_url=str(options.get("WHISPER_CPP_URL") or "http://127.0.0.1:8080")
            )

        if engine == "openai_whisper_api":
            from .http_engines import WhisperAPISTT

            api_key = str(options.get("STT_API_KEY") or "")
            if not api_key:
                raise RuntimeError(
                    "Manca la chiave API per la trascrizione. Impostala nel "
                    "pannello oppure con DC_STT_API_KEY."
                )
            return WhisperAPISTT(
                api_key=api_key,
                base_url=str(options.get("STT_BASE_URL") or "https://api.openai.com/v1"),
                model=str(options.get("STT_MODEL") or "whisper-1"),
            )

        raise ValueError(f"Motore STT sconosciuto: {settings.stt_engine!r}")
    except Exception as exc:
        logger.error("Riconoscimento vocale '%s' non disponibile: %s", engine, exc)
        logger.warning("L'input vocale resta spento; si puo' comunque scrivere.")
        return None
