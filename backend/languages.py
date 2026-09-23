"""Lingua della voce e lingua delle risposte.

Le due cose devono coincidere: una voce inglese che legge una risposta in
italiano pronuncia tutto con l'accento e le regole sbagliate, ed e'
incomprensibile. Il nome delle voci Kokoro dice gia' la lingua con la prima
lettera (``af_heart`` = American female, ``if_sara`` = Italian female...),
quindi di default la lingua delle risposte segue la voce scelta.
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
    "ja": "Japanese",
    "japanese": "Japanese",
    "giapponese": "Japanese",
    "pt": "Portuguese",
    "portuguese": "Portuguese",
    "portoghese": "Portuguese",
}


def voice_language(voice: str | None, fallback: str) -> str:
    """Codice lingua di una voce Kokoro (``if_sara`` -> ``it``), o ``fallback``."""
    if voice and len(voice) > 2 and voice[2] == "_" and voice[1] in "fm":
        entry = _VOICE_PREFIX.get(voice[0].lower())
        if entry:
            return entry[0]
    return fallback


def reply_language(setting: str | None, voice: str | None, fallback_code: str) -> str | None:
    """In che lingua deve rispondere il companion.

    ``auto`` (default) = la lingua della voce; ``same`` = la stessa lingua in
    cui scrive l'utente (restituisce ``None``); altrimenti un codice o un nome
    di lingua, anche in italiano ("inglese").
    """
    value = (setting or "auto").strip()
    lowered = value.lower()
    if lowered == "same":
        return None
    if lowered == "auto":
        code = voice_language(voice, fallback_code)
        return _NAMES.get(code) or _ALIASES.get(code.split("-")[0], "English")
    return _NAMES.get(lowered) or _ALIASES.get(lowered) or value


def speech_directive(language: str | None) -> str:
    """Vincoli per una risposta che verra' letta ad alta voce."""
    if language:
        target = f"Always reply in {language}, whatever language the user writes in"
    else:
        target = "Reply in the same language the user writes in"
    return f"{target}."
