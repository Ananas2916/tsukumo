"""Factory dei motori TTS."""

from __future__ import annotations

import logging

from ..config import Settings
from ..providers import TTS_REGISTRY
from .base import Speech, TTSEngine, VoiceInfo
from .formant import FormantTTS
from .kokoro_engine import KokoroTTS
from .kokoro_http import KokoroHTTPTTS

logger = logging.getLogger(__name__)

__all__ = [
    "Speech",
    "TTSEngine",
    "VoiceInfo",
    "KokoroTTS",
    "KokoroHTTPTTS",
    "FormantTTS",
    "build_tts_engine",
    "create_tts_engine",
]


def _key(options: dict, env: str, service: str) -> str:
    key = str(options.get(env) or "").strip()
    if not key:
        raise RuntimeError(f"Manca la chiave API di {service}. Impostala nel pannello oppure con DC_{env}.")
    return key


def _number(value: object, default: float) -> float:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def build_tts_engine(engine: str, settings: Settings) -> TTSEngine:
    """Istanzia il motore richiesto, senza rete di protezione.

    Gli import dei motori opzionali sono qui dentro e non in testa al modulo:
    chi usa Kokoro non deve avere installato edge-tts, piper o pyttsx3.
    """
    engine = TTS_REGISTRY.resolve(engine) or engine
    options = settings.provider_config("tts", engine)
    speed = settings.speech_speed

    if engine == "formant":
        return FormantTTS(default_speed=speed)

    if engine == "kokoro_http":
        return KokoroHTTPTTS(
            base_url=str(options.get("KOKORO_HTTP_URL") or settings.kokoro_http_url).rstrip("/"),
            default_voice=settings.voice,
            default_speed=speed,
            language=settings.language,
        )

    if engine == "kokoro":
        return KokoroTTS(
            model_path=settings.kokoro_model_path,
            voices_path=settings.kokoro_voices_path,
            default_voice=settings.voice,
            default_speed=speed,
            language=settings.language,
        )

    if engine == "edge":
        from .edge import EdgeTTS

        return EdgeTTS(default_voice=str(options.get("EDGE_VOICE") or "it-IT-ElsaNeural"), default_speed=speed)

    if engine == "elevenlabs":
        from .elevenlabs import ElevenLabsTTS

        return ElevenLabsTTS(
            api_key=_key(options, "ELEVENLABS_API_KEY", "ElevenLabs"),
            default_voice=str(options.get("ELEVENLABS_VOICE") or "Rachel"),
            model=str(options.get("ELEVENLABS_MODEL") or "eleven_flash_v2_5"),
            default_speed=speed,
            stability=_number(options.get("ELEVENLABS_STABILITY"), 0.5),
            similarity=_number(options.get("ELEVENLABS_SIMILARITY"), 0.75),
            style=_number(options.get("ELEVENLABS_STYLE"), 0.0),
            language=str(options.get("ELEVENLABS_LANGUAGE") or ""),
        )

    if engine == "openai_tts":
        from .cloud import OpenAITTS

        base_url = str(options.get("OPENAI_TTS_BASE_URL") or "https://api.openai.com/v1")
        official = "api.openai.com" in base_url
        return OpenAITTS(
            # Un server locale compatibile di solito non vuole chiavi.
            api_key=_key(options, "OPENAI_TTS_API_KEY", "OpenAI") if official else str(options.get("OPENAI_TTS_API_KEY") or ""),
            voice=str(options.get("OPENAI_TTS_VOICE") or "coral"),
            model=str(options.get("OPENAI_TTS_MODEL") or "gpt-4o-mini-tts"),
            instructions=str(options.get("OPENAI_TTS_INSTRUCTIONS") or ""),
            base_url=base_url,
            default_speed=speed,
        )

    if engine == "azure":
        from .cloud import AzureTTS

        return AzureTTS(
            api_key=_key(options, "AZURE_SPEECH_KEY", "Azure Speech"),
            region=str(options.get("AZURE_SPEECH_REGION") or "westeurope"),
            voice=str(options.get("AZURE_SPEECH_VOICE") or "it-IT-IsabellaMultilingualNeural"),
            default_speed=speed,
        )

    if engine == "google_tts":
        from .cloud import GoogleTTS

        return GoogleTTS(
            api_key=_key(options, "GOOGLE_TTS_API_KEY", "Google Cloud"),
            voice=str(options.get("GOOGLE_TTS_VOICE") or "it-IT-Chirp3-HD-Aoede"),
            default_speed=speed,
        )

    if engine == "cartesia":
        from .cloud import CartesiaTTS

        return CartesiaTTS(
            api_key=_key(options, "CARTESIA_API_KEY", "Cartesia"),
            voice=str(options.get("CARTESIA_VOICE") or ""),
            model=str(options.get("CARTESIA_MODEL") or "sonic-2"),
            language=str(options.get("CARTESIA_LANGUAGE") or "it"),
        )

    if engine == "chatterbox":
        from .chatterbox_engine import ChatterboxTTS

        return ChatterboxTTS(
            voices_dir=settings.state_dir / "voices" / "chatterbox",
            device=str(options.get("CHATTERBOX_DEVICE") or "auto"),
            language=str(options.get("CHATTERBOX_LANGUAGE") or "it"),
            exaggeration=_number(options.get("CHATTERBOX_EXAGGERATION"), 0.5),
            cfg_weight=_number(options.get("CHATTERBOX_CFG_WEIGHT"), 0.5),
        )

    if engine == "piper":
        from .piper import PiperTTS

        model_path = str(options.get("PIPER_MODEL") or "")
        if not model_path:
            raise RuntimeError(
                "Indica la voce Piper da usare (un file .onnx scaricato da "
                "huggingface.co/rhasspy/piper-voices)."
            )
        return PiperTTS(model_path=model_path, default_speed=speed)

    if engine == "system":
        from .system import SystemTTS

        return SystemTTS(default_voice="", default_speed=speed)

    raise ValueError(f"Motore TTS sconosciuto: {engine!r}")


def create_tts_engine(settings: Settings) -> TTSEngine:
    """Istanzia il motore richiesto da ``DC_TTS_ENGINE``.

    Se il motore non e' utilizzabile (pesi mancanti, chiave assente, server
    spento) e ``DC_TTS_FALLBACK`` e' attivo, ripieghiamo sul sintetizzatore a
    formanti in modo che l'applicazione resti comunque usabile. Il motivo
    finisce in ``fallback_reason``: il pannello lo mostra invece di tacerlo.
    """
    engine = TTS_REGISTRY.resolve(settings.tts_engine) or (settings.tts_engine or "kokoro").lower()

    try:
        built = build_tts_engine(engine, settings)
        logger.info("Motore TTS: %s", engine)
        return built
    except Exception as exc:
        if not settings.tts_fallback_to_formant:
            raise
        logger.error("Motore TTS '%s' non disponibile: %s", engine, exc)
        logger.warning("Passo al sintetizzatore a formanti (DC_TTS_FALLBACK=0 per disattivarlo)")
        fallback = FormantTTS(default_speed=settings.speech_speed)
        fallback.fallback_reason = f"{engine}: {exc}"  # type: ignore[attr-defined]
        return fallback
