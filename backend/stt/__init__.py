"""Factory of the speech-recognition engines.

Two ids have no server-side engine and return ``None``:

* ``none``    — voice input off, you only talk by typing;
* ``browser`` — the browser does the transcription (Web Speech API) and text
  arrives at the backend already, so there's nothing to instantiate here.

So the caller must always handle the ``None`` case.
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

#: Ids that have no server-side implementation.
CLIENT_SIDE = {"none", "browser"}


def create_stt_engine(settings: Settings) -> STTEngine | None:
    """Instantiates the engine named by ``DC_STT_ENGINE``.

    Returns ``None`` if voice input is off or if the transcription happens in the
    browser. If the requested engine isn't available it reports it and falls back
    to ``None``: missing speech recognition must not prevent using the companion
    by typing.
    """
    engine = STT_REGISTRY.resolve(settings.stt_engine) or "none"

    if engine in CLIENT_SIDE:
        if engine == "browser":
            logger.info("Speech recognition: delegated to the browser")
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
                    "The API key for transcription is missing. Set it in the "
                    "panel or with DC_STT_API_KEY."
                )
            return WhisperAPISTT(
                api_key=api_key,
                base_url=str(options.get("STT_BASE_URL") or "https://api.openai.com/v1"),
                model=str(options.get("STT_MODEL") or "whisper-1"),
            )

        raise ValueError(f"Unknown STT engine: {settings.stt_engine!r}")
    except Exception as exc:
        logger.error("Speech recognition '%s' unavailable: %s", engine, exc)
        logger.warning("Voice input stays off; you can still type.")
        return None
