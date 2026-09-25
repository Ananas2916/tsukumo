"""Lingua della voce e lingua delle risposte.

Le due cose devono coincidere: una voce inglese che legge una risposta in
italiano pronuncia tutto con l'accento e le regole sbagliate, ed e'
incomprensibile. Ogni motore TTS sa dire che lingua parla una sua voce
(``TTSEngine.language_of``): le voci Kokoro lo dicono con la prima lettera
(``af_heart`` = American female, ``if_sara`` = Italian female...), quelle
Microsoft e Google col prefisso (``it-IT-...``), le voci multilingua di
ElevenLabs e OpenAI non ne hanno una sola.

Se nessuno ha scelto una voce, il companion parla la lingua del sistema
operativo: con Windows in italiano la voce predefinita e' italiana, e di
conseguenza anche le risposte, i versetti e i commenti.
"""

from __future__ import annotations

import locale
import os
import re
import sys

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


#: Voce Kokoro consigliata per lingua (la migliore del catalogo, femminile
#: come la predefinita ``af_heart``).
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

#: Nomi di lingua che ``locale`` puo' restituire su Windows ("Italian_Italy").
_ENGLISH_NAMES = {name.lower(): code for code, name in _ALIASES.items() if len(code) == 2}
_ENGLISH_NAMES.update({"chinese": "zh", "portuguese": "pt"})


def short_language(code: str | None) -> str:
    """``it-IT``, ``it_IT.UTF-8``, ``Italian_Italy``, ``cmn`` -> ``it``/``zh``; ``""`` se non si capisce."""
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
    """La lingua dell'interfaccia del sistema operativo, come codice corto (``it``).

    ``DC_SYSTEM_LANGUAGE`` la forza. Su Windows si legge la lingua di
    visualizzazione dell'utente; altrove le variabili ``LANG``/``LC_*``.
    Se non si capisce: inglese.
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
        except Exception:  # pragma: no cover - dipende dal sistema
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
