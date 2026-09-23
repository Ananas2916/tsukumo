"""Factory dei motori TTS."""

from __future__ import annotations

import logging

from ..config import Settings
from ..providers import TTS_REGISTRY
from .base import Speech, TTSEngine
from .formant import FormantTTS
from .kokoro_engine import KokoroTTS
from .kokoro_http import KokoroHTTPTTS

logger = logging.getLogger(__name__)

__all__ = ["Speech", "TTSEngine", "KokoroTTS", "KokoroHTTPTTS", "FormantTTS", "create_tts_engine"]


def _build(engine: str, settings: Settings) -> TTSEngine:
    """Istanzia il motore richiesto, senza rete di protezione.

    Gli import dei motori opzionali sono qui dentro e non in testa al modulo:
    chi usa Kokoro non deve avere installato edge-tts, piper o pyttsx3.
    """
    options = settings.provider_config("tts", engine)

    if engine == "formant":
        return FormantTTS(default_speed=settings.speech_speed)

    if engine == "kokoro_http":
        return KokoroHTTPTTS(
            base_url=settings.kokoro_http_url,
            default_voice=settings.voice,
            default_speed=settings.speech_speed,
            language=settings.language,
        )

    if engine == "kokoro":
        return KokoroTTS(
            model_path=settings.kokoro_model_path,
            voices_path=settings.kokoro_voices_path,
            default_voice=settings.voice,
            default_speed=settings.speech_speed,
            language=settings.language,
        )

    if engine == "edge":
        from .edge import EdgeTTS

        return EdgeTTS(
            default_voice=str(options.get("EDGE_VOICE") or settings.voice),
            default_speed=settings.speech_speed,
        )

    if engine == "elevenlabs":
        from .elevenlabs import ElevenLabsTTS

        api_key = str(options.get("ELEVENLABS_API_KEY") or "")
        if not api_key:
            raise RuntimeError(
                "Manca la chiave API di ElevenLabs. Impostala nel pannello "
                "oppure con DC_ELEVENLABS_API_KEY."
            )
        return ElevenLabsTTS(
            api_key=api_key,
            default_voice=str(options.get("ELEVENLABS_VOICE") or "Rachel"),
            model=str(options.get("ELEVENLABS_MODEL") or "eleven_multilingual_v2"),
            default_speed=settings.speech_speed,
        )

    if engine == "piper":
        from .piper import PiperTTS

        model_path = str(options.get("PIPER_MODEL") or "")
        if not model_path:
            raise RuntimeError(
                "Indica la voce Piper da usare in DC_PIPER_MODEL "
                "(un file .onnx scaricato da huggingface.co/rhasspy/piper-voices)."
            )
        return PiperTTS(model_path=model_path, default_speed=settings.speech_speed)

    if engine == "system":
        from .system import SystemTTS

        return SystemTTS(default_voice=settings.voice, default_speed=settings.speech_speed)

    raise ValueError(f"Motore TTS sconosciuto: {engine!r}")


def create_tts_engine(settings: Settings) -> TTSEngine:
    """Istanzia il motore richiesto da ``DC_TTS_ENGINE``.

    Se Kokoro non e' utilizzabile (pesi mancanti, ONNX Runtime rotto, server
    HTTP spento) e ``DC_TTS_FALLBACK`` e' attivo, ripieghiamo sul sintetizzatore
    a formanti in modo che l'applicazione resti comunque usabile.
    """
    engine = TTS_REGISTRY.resolve(settings.tts_engine) or (settings.tts_engine or "kokoro").lower()

    if engine == "formant":
        logger.info("Motore TTS: formant (voce di servizio)")
        return FormantTTS(default_speed=settings.speech_speed)

    try:
        built = _build(engine, settings)
        logger.info("Motore TTS: %s", engine)
        return built
    except Exception as exc:
        if not settings.tts_fallback_to_formant:
            raise
        logger.error("Motore TTS '%s' non disponibile: %s", engine, exc)
        logger.warning("Passo al sintetizzatore a formanti (DC_TTS_FALLBACK=0 per disattivarlo)")
        return FormantTTS(default_speed=settings.speech_speed)
