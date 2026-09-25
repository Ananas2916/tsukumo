"""Lingua della voce e lingua delle risposte.

Le due cose devono coincidere: una voce inglese che legge una risposta in
italiano pronuncia tutto con l'accento e le regole sbagliate, ed e'
incomprensibile. Ogni motore TTS sa dire che lingua parla una sua voce
(``TTSEngine.language_of``): le voci Kokoro lo dicono con la prima lettera
(``af_heart`` = American female, ``if_sara`` = Italian female...), quelle
Microsoft e Google col prefisso (``it-IT-...``), le voci multilingua di
ElevenLabs e OpenAI non ne hanno una sola.
"""

from __future__ import annotations

# Prima lettera della voce Kokoro -> (codice per il phonemizer, nome in inglese).
_VOICE_PREFIX = {
    "a": ("en-us", "English"),
    "b": ("en-gb", "English"),
    "e": ("es", "Spanish"),
    "f": ("fr-fr", "French"),
    "h": ("hi", "Hindi"),
    "i": ("it", "Italian"),
    "j": ("ja", "Japanese"),
    "p": ("pt-br", "Portuguese"),
    "z": ("cmn", "Mandarin Chinese"),
}

_NAMES = {code: name for code, name in _VOICE_PREFIX.values()}

# Come si puo' scrivere una lingua in DC_REPLY_LANGUAGE o nel pannello.
_ALIASES = {
    "en": "English",
    "english": "English",
    "inglese": "English",
    "it": "Italian",
    "italian": "Italian",
    "italiano": "Italian",
    "es": "Spanish",
    "spanish": "Spanish",
    "spagnolo": "Spanish",
    "fr": "French",
    "french": "French",
    "francese": "French",
    "de": "German",
    "german": "German",
    "tedesco": "German",
    "ja": "Japanese",
    "japanese": "Japanese",
    "giapponese": "Japanese",
    "pt": "Portuguese",
    "portuguese": "Portuguese",
    "portoghese": "Portuguese",
    "hi": "Hindi",
    "zh": "Mandarin Chinese",
    "cmn": "Mandarin Chinese",
}


def is_kokoro_voice(voice: str | None) -> bool:
    """``af_heart``, ``if_sara``...: prefisso lingua + genere + trattino basso."""
    return bool(
        voice and len(voice) > 3 and voice[2] == "_" and voice[1] in "fm" and voice[0].lower() in _VOICE_PREFIX
    )


def voice_language(voice: str | None, fallback: str) -> str:
    """Codice lingua di una voce Kokoro (``if_sara`` -> ``it``), o ``fallback``."""
    if is_kokoro_voice(voice):
        return _VOICE_PREFIX[voice[0].lower()][0]  # type: ignore[index]
    return fallback


def kokoro_voice_info(voice: str) -> dict[str, str] | None:
    """Nome leggibile, lingua corta e genere di una voce Kokoro."""
    if not is_kokoro_voice(voice):
        return None
    code = _VOICE_PREFIX[voice[0].lower()][0]
    base = voice[3:].replace("_", " ").strip()
    return {
        "name": base[:1].upper() + base[1:],
        "language": code.split("-")[0],
        "gender": "female" if voice[1] == "f" else "male",
    }


def language_name(code: str | None) -> str | None:
    """``it`` / ``it-IT`` / ``italiano`` -> ``Italian``; ``None`` se sconosciuta."""
    if not code:
        return None
    lowered = code.strip().lower()
    return _NAMES.get(lowered) or _ALIASES.get(lowered) or _ALIASES.get(lowered.split("-")[0])


def reply_language(setting: str | None, voice_code: str | None) -> str | None:
    """In che lingua deve rispondere il companion.

    ``auto`` (default) = la lingua della voce, se la voce ne ha una sola;
    ``same`` = la stessa lingua in cui scrive l'utente (restituisce ``None``,
    come ``auto`` con una voce multilingua); altrimenti un codice o un nome di
    lingua, anche in italiano ("inglese").
    """
    value = (setting or "auto").strip()
    lowered = value.lower()
    if lowered == "same":
        return None
    if lowered == "auto":
        return language_name(voice_code)
    return language_name(lowered) or value


def speech_directive(language: str | None) -> str:
    """Vincoli per una risposta che verra' letta ad alta voce."""
    if language:
        target = f"Always reply in {language}, whatever language the user writes in"
    else:
        target = "Reply in the same language the user writes in"
    return f"{target}."
