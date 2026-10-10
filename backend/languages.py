"""The voice's language and the replies' language.

The two must match: an English voice reading an Italian reply pronounces
everything with the wrong accent and rules, and is incomprehensible. Every
TTS engine can tell which language one of its voices speaks
(``TTSEngine.language_of``): Kokoro voices say it with the first letter
(``af_heart`` = American female, ``if_sara`` = Italian female...), Microsoft
and Google ones with the prefix (``it-IT-...``), the multilingual voices of
ElevenLabs and OpenAI don't have a single one.

If nobody chose a voice, the companion speaks the operating system's
language: with Windows in Italian the default voice is Italian, and so are
the replies, the vocals and the comments.
"""

from __future__ import annotations

import locale
import os
import re
import sys

# First letter of the Kokoro voice -> (code for the phonemizer, name in English).
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

# How a language can be written in DC_REPLY_LANGUAGE or in the panel.
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
    """``af_heart``, ``if_sara``...: language prefix + gender + underscore."""
    return bool(
        voice and len(voice) > 3 and voice[2] == "_" and voice[1] in "fm" and voice[0].lower() in _VOICE_PREFIX
    )


def voice_language(voice: str | None, fallback: str) -> str:
    """Language code of a Kokoro voice (``if_sara`` -> ``it``), or ``fallback``."""
    if is_kokoro_voice(voice):
        return _VOICE_PREFIX[voice[0].lower()][0]  # type: ignore[index]
    return fallback


def kokoro_voice_info(voice: str) -> dict[str, str] | None:
    """Readable name, short language and gender of a Kokoro voice."""
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
    """``it`` / ``it-IT`` / ``italiano`` -> ``Italian``; ``None`` if unknown."""
    if not code:
        return None
    lowered = code.strip().lower()
    return _NAMES.get(lowered) or _ALIASES.get(lowered) or _ALIASES.get(lowered.split("-")[0])


#: Recommended Kokoro voice per language (the best of the catalogue, female
#: like the default ``af_heart``).
KOKORO_DEFAULTS = {
    "en": "af_heart",
    "it": "if_sara",
    "es": "ef_dora",
    "fr": "ff_siwis",
    "ja": "jf_alpha",
    "zh": "zf_xiaobei",
    "pt": "pf_dora",
    "hi": "hf_alpha",
}

#: Language names ``locale`` may return on Windows ("Italian_Italy").
_ENGLISH_NAMES = {name.lower(): code for code, name in _ALIASES.items() if len(code) == 2}
_ENGLISH_NAMES.update({"chinese": "zh", "portuguese": "pt"})


def short_language(code: str | None) -> str:
    """``it-IT``, ``it_IT.UTF-8``, ``Italian_Italy``, ``cmn`` -> ``it``/``zh``; ``""`` if it can't tell."""
    if not code:
        return ""
    head = re.split(r"[-_.@ ]", code.strip().lower(), maxsplit=1)[0]
    if head in ("cmn", "yue"):
        return "zh"
    if head in ("c", "posix"):
        return ""
    if len(head) == 2 and head.isalpha():
        return head
    return _ENGLISH_NAMES.get(head, "")


def system_language() -> str:
    """The operating system's interface language, as a short code (``it``).

    ``DC_SYSTEM_LANGUAGE`` forces it. On Windows the user's display language is
    read; elsewhere the ``LANG``/``LC_*`` variables. If it can't tell: English.
    """
    forced = short_language(os.environ.get("DC_SYSTEM_LANGUAGE"))
    if forced:
        return forced
    if sys.platform == "win32":
        try:
            import ctypes

            kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
            buffer = ctypes.create_unicode_buffer(85)
            if kernel32.LCIDToLocaleName(kernel32.GetUserDefaultUILanguage(), buffer, 85, 0):
                found = short_language(buffer.value)
                if found:
                    return found
        except Exception:  # pragma: no cover - depends on the system
            pass
    for variable in ("LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"):
        found = short_language(os.environ.get(variable))
        if found:
            return found
    try:
        found = short_language(locale.getlocale()[0])
    except ValueError:  # pragma: no cover
        found = ""
    return found or "en"


def reply_language(setting: str | None, voice_code: str | None) -> str | None:
    """Which language the companion must answer in.

    ``auto`` (default) = the voice's language, if the voice has a single one;
    ``same`` = the same language the user writes in (returns ``None``, like
    ``auto`` with a multilingual voice); otherwise a language code or name, in
    Italian too ("inglese").
    """
    value = (setting or "auto").strip()
    lowered = value.lower()
    if lowered == "same":
        return None
    if lowered == "auto":
        return language_name(voice_code)
    return language_name(lowered) or value


def speech_directive(language: str | None) -> str:
    """Constraints for a reply that will be read aloud."""
    if language:
        target = f"Always reply in {language}, whatever language the user writes in"
    else:
        target = "Reply in the same language the user writes in"
    return f"{target}."
