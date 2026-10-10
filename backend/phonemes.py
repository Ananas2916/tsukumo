"""From phonemes (or from raw text) to the five shapes of her mouth.

The flame opens her mouth with the voice's volume and shapes it with the
vowel being spoken: ``a``, ``i``, ``u``, ``e``, ``o`` (round on "o" and "u",
wide on "i" and "e"). Here we map the IPA phonemes produced by
espeak-ng/Kokoro onto these five visemes, plus a sixth state ``sil`` (mouth
closed).

Every phoneme carries:

* ``viseme``   - which mouth shape;
* ``duration`` - relative duration weight (rescaled on the real audio);
* ``openness`` - how much the mouth opens for that sound (0..1).
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

#: The mouth's six possible states.
VISEMES: tuple[str, ...] = ("sil", "a", "i", "u", "e", "o")


@dataclass(frozen=True)
class Phone:
    """A phoneme reduced to what the lip-sync needs."""

    viseme: str
    duration: float
    openness: float

    def scaled(self, factor: float) -> "Phone":
        return Phone(self.viseme, self.duration * factor, self.openness)


# IPA diacritics (stress marks, aspiration, ties...): they're ignored.
_IGNORED = {
    "ˈ",  # primary stress
    "ˌ",  # secondary stress
    "ˑ",  # half-long
    "‿",  # tie below
    "͡",  # tie above
    "ʰ",  # aspiration
    "ʲ",  # palatalization
    "ʷ",  # labialization
    "ˠ",  # velarization
    "ˤ",  # pharyngealization
    "̩",  # syllabic
    "̯",  # non-syllabic
    "˞",  # rhoticity
}

# Length markers: they lengthen the previous phoneme.
_LENGTH_MARKS = {"ː", ":"}

_PAUSE_SHORT = Phone("sil", 0.45, 0.0)
_PAUSE_LONG = Phone("sil", 1.10, 0.0)

# --------------------------------------------------------------------------
# IPA -> Phone table. Multi-character keys are tried first.
# --------------------------------------------------------------------------
_IPA_TABLE: dict[str, Phone] = {
    # --- open / central vowels -> "a" ---------------------------------
    "ɑ": Phone("a", 1.00, 1.00),  # ɑ
    "a": Phone("a", 1.00, 0.95),
    "ɐ": Phone("a", 0.90, 0.80),  # ɐ
    "ʌ": Phone("a", 0.90, 0.75),  # ʌ
    "æ": Phone("a", 1.00, 0.90),  # æ
    # --- rounded back vowels -> "o" ----------------------------------
    "ɒ": Phone("o", 1.00, 0.85),  # ɒ
    "ɔ": Phone("o", 1.00, 0.80),  # ɔ
    "o": Phone("o", 1.00, 0.72),
    "ɵ": Phone("o", 0.90, 0.60),  # ɵ
    # --- mid front vowels -> "e" -----------------------------------
    "e": Phone("e", 1.00, 0.60),
    "ɛ": Phone("e", 1.00, 0.68),  # ɛ
    "ə": Phone("e", 0.70, 0.35),  # ə
    "ɜ": Phone("e", 1.00, 0.52),  # ɜ
    "ɚ": Phone("e", 0.90, 0.40),  # ɚ
    "ɝ": Phone("e", 1.00, 0.50),  # ɝ
    "ɘ": Phone("e", 0.80, 0.40),  # ɘ
    # --- close front vowels -> "i" ----------------------------------
    "i": Phone("i", 1.00, 0.50),
    "ɪ": Phone("i", 0.85, 0.40),  # ɪ
    "ɨ": Phone("i", 0.80, 0.35),  # ɨ
    "y": Phone("i", 0.95, 0.42),
    "ʏ": Phone("i", 0.85, 0.38),  # ʏ
    "ᵻ": Phone("i", 0.70, 0.32),  # ᵻ (used by espeak/misaki)
    # --- close back vowels -> "u" ---------------------------------
    "u": Phone("u", 1.00, 0.55),
    "ʊ": Phone("u", 0.85, 0.45),  # ʊ
    "ʉ": Phone("u", 1.00, 0.50),  # ʉ
    "ɯ": Phone("u", 0.95, 0.48),  # ɯ
    # --- bilabial consonants: mouth closed ------------------------------
    "p": Phone("sil", 0.45, 0.02),
    "b": Phone("sil", 0.45, 0.04),
    "m": Phone("sil", 0.55, 0.06),
    # --- labiodentals ----------------------------------------------------
    "f": Phone("i", 0.65, 0.22),
    "v": Phone("i", 0.60, 0.24),
    # --- dentals ---------------------------------------------------------
    "θ": Phone("e", 0.60, 0.26),  # θ
    "ð": Phone("e", 0.55, 0.26),  # ð
    # --- alveolars -------------------------------------------------------
    "t": Phone("e", 0.42, 0.20),
    "d": Phone("e", 0.42, 0.22),
    "n": Phone("e", 0.50, 0.16),
    "l": Phone("e", 0.58, 0.32),
    "s": Phone("i", 0.70, 0.20),
    "z": Phone("i", 0.65, 0.22),
    "ɾ": Phone("e", 0.35, 0.24),  # ɾ
    "r": Phone("u", 0.60, 0.30),
    "ɹ": Phone("u", 0.60, 0.32),  # ɹ
    "ɻ": Phone("u", 0.60, 0.32),  # ɻ
    # --- post-alveolars: lips protruding ---------------------------------
    "ʃ": Phone("u", 0.72, 0.36),  # ʃ
    "ʒ": Phone("u", 0.68, 0.36),  # ʒ
    "tʃ": Phone("u", 0.70, 0.34),  # tʃ
    "dʒ": Phone("u", 0.70, 0.34),  # dʒ
    "ʧ": Phone("u", 0.70, 0.34),  # ʧ
    "ʤ": Phone("u", 0.70, 0.34),  # ʤ
    # --- palatals / velars -----------------------------------------------
    "j": Phone("i", 0.45, 0.38),
    "ʎ": Phone("i", 0.55, 0.32),  # ʎ
    "ɲ": Phone("i", 0.55, 0.28),  # ɲ
    "k": Phone("a", 0.45, 0.26),
    "g": Phone("a", 0.45, 0.28),
    "ɡ": Phone("a", 0.45, 0.28),  # ɡ (IPA, different from the ASCII "g")
    "ŋ": Phone("a", 0.50, 0.16),  # ŋ
    "x": Phone("a", 0.55, 0.24),
    "ɣ": Phone("a", 0.55, 0.24),  # ɣ
    "h": Phone("a", 0.40, 0.22),
    "ɦ": Phone("a", 0.40, 0.22),  # ɦ
    # --- labio-velar approximant ----------------------------------------
    "w": Phone("u", 0.45, 0.42),
    "ʋ": Phone("u", 0.45, 0.34),  # ʋ
    # --- glottal stop ---------------------------------------------
    "ʔ": Phone("sil", 0.28, 0.0),  # ʔ
}

_MAX_IPA_KEY = max(len(k) for k in _IPA_TABLE)

_PUNCT_PAUSES = {
    ",": _PAUSE_SHORT,
    ";": _PAUSE_SHORT,
    ":": _PAUSE_SHORT,
    ".": _PAUSE_LONG,
    "!": _PAUSE_LONG,
    "?": _PAUSE_LONG,
    "…": _PAUSE_LONG,  # ellipsis
    "—": _PAUSE_SHORT,  # em dash
    "–": _PAUSE_SHORT,  # en dash
}


def phones_from_ipa(ipa: str) -> list[Phone]:
    """Converts an IPA string (espeak-ng / Kokoro output) into ``Phone``."""
    phones: list[Phone] = []
    text = unicodedata.normalize("NFC", ipa or "")
    index = 0
    length = len(text)

    while index < length:
        char = text[index]

        if char in _LENGTH_MARKS:
            if phones:
                phones[-1] = phones[-1].scaled(1.6)
            index += 1
            continue

        if char.isspace():
            _append_pause(phones, _PAUSE_SHORT)
            index += 1
            continue

        if char in _PUNCT_PAUSES:
            _append_pause(phones, _PUNCT_PAUSES[char])
            index += 1
            continue

        if char in _IGNORED:
            index += 1
            continue

        matched = False
        for size in range(min(_MAX_IPA_KEY, length - index), 0, -1):
            phone = _IPA_TABLE.get(text[index : index + size])
            if phone is not None:
                phones.append(phone)
                index += size
                matched = True
                break

        if not matched:
            # Unknown symbol: we treat it as a neutral consonant, so the mouth keeps
            # moving instead of freezing.
            phones.append(Phone("e", 0.45, 0.22))
            index += 1

    return _cleanup(phones)


# --------------------------------------------------------------------------
# Grapheme -> phoneme fallback, used when the TTS engine doesn't expose the
# phonemes. It isn't a linguistically correct G2P: it's a heuristic that
# produces a plausible viseme sequence, then aligned to the real audio's
# energy.
# --------------------------------------------------------------------------
_VOWEL_DIGRAPHS: dict[str, tuple[Phone, ...]] = {
    "ee": (Phone("i", 1.50, 0.50),),
    "ea": (Phone("i", 1.30, 0.52),),
    "ie": (Phone("i", 1.30, 0.50),),
    "oo": (Phone("u", 1.40, 0.52),),
    "ou": (Phone("a", 0.80, 0.80), Phone("u", 0.70, 0.50)),
    "ow": (Phone("a", 0.80, 0.80), Phone("u", 0.70, 0.50)),
    "au": (Phone("a", 0.90, 0.90), Phone("u", 0.60, 0.48)),
    "aw": (Phone("a", 0.90, 0.90), Phone("u", 0.60, 0.48)),
    "ai": (Phone("e", 0.80, 0.62), Phone("i", 0.70, 0.45)),
    "ay": (Phone("e", 0.80, 0.62), Phone("i", 0.70, 0.45)),
    "ei": (Phone("e", 0.80, 0.62), Phone("i", 0.70, 0.45)),
    "oa": (Phone("o", 1.30, 0.70),),
    "oi": (Phone("o", 0.80, 0.75), Phone("i", 0.70, 0.45)),
    "oy": (Phone("o", 0.80, 0.75), Phone("i", 0.70, 0.45)),
    "ue": (Phone("u", 1.30, 0.52),),
    "ui": (Phone("u", 1.00, 0.50), Phone("i", 0.60, 0.42)),
}

_CONSONANT_DIGRAPHS: dict[str, tuple[Phone, ...]] = {
    "sh": (_IPA_TABLE["ʃ"],),
    "ch": (_IPA_TABLE["tʃ"],),
    "th": (_IPA_TABLE["θ"],),
    "ph": (_IPA_TABLE["f"],),
    "gh": (_IPA_TABLE["g"],),
    "ck": (_IPA_TABLE["k"],),
    "ng": (_IPA_TABLE["ŋ"],),
    "qu": (_IPA_TABLE["k"], _IPA_TABLE["w"]),
    "gn": (_IPA_TABLE["ɲ"],),
    "sc": (_IPA_TABLE["ʃ"],),
}

_LETTER_TABLE: dict[str, Phone] = {
    "a": _IPA_TABLE["a"],
    "e": _IPA_TABLE["ɛ"],
    "i": _IPA_TABLE["i"],
    "o": _IPA_TABLE["o"],
    "u": _IPA_TABLE["u"],
    "y": _IPA_TABLE["i"],
    "b": _IPA_TABLE["b"],
    "c": _IPA_TABLE["k"],
    "d": _IPA_TABLE["d"],
    "f": _IPA_TABLE["f"],
    "g": _IPA_TABLE["g"],
    "h": _IPA_TABLE["h"],
    "j": _IPA_TABLE["dʒ"],
    "k": _IPA_TABLE["k"],
    "l": _IPA_TABLE["l"],
    "m": _IPA_TABLE["m"],
    "n": _IPA_TABLE["n"],
    "p": _IPA_TABLE["p"],
    "q": _IPA_TABLE["k"],
    "r": _IPA_TABLE["ɹ"],
    "s": _IPA_TABLE["s"],
    "t": _IPA_TABLE["t"],
    "v": _IPA_TABLE["v"],
    "w": _IPA_TABLE["w"],
    "x": _IPA_TABLE["s"],
    "z": _IPA_TABLE["z"],
}

_WORD_SPLIT = re.compile(r"(\w+|[^\w\s]|\s+)", re.UNICODE)

# Viseme sequence used to "pronounce" a digit (n-a-i is a good average
# approximation of one/two/three, uno/due/tre, ...).
_DIGIT_PHONES = (_IPA_TABLE["n"], _IPA_TABLE["a"], _IPA_TABLE["i"])


def phones_from_text(text: str) -> list[Phone]:
    """Heuristic G2P: used only if the TTS engine doesn't expose the phonemes."""
    phones: list[Phone] = []
    decomposed = unicodedata.normalize("NFD", text or "").lower()
    # Strips combining accents, so an accented "perché" stays "perche".
    normalized = "".join(c for c in decomposed if not unicodedata.combining(c))

    for token in _WORD_SPLIT.findall(normalized):
        if token.isspace():
            _append_pause(phones, _PAUSE_SHORT)
        elif token in _PUNCT_PAUSES:
            _append_pause(phones, _PUNCT_PAUSES[token])
        elif token.isdigit():
            for _ in token:
                phones.extend(_DIGIT_PHONES)
        elif token.isalnum():
            phones.extend(_word_to_phones(token))

    return _cleanup(phones)


def _word_to_phones(word: str) -> list[Phone]:
    phones: list[Phone] = []
    index = 0
    length = len(word)
    while index < length:
        pair = word[index : index + 2]
        if len(pair) == 2:
            digraph = _VOWEL_DIGRAPHS.get(pair) or _CONSONANT_DIGRAPHS.get(pair)
            if digraph is not None:
                phones.extend(digraph)
                index += 2
                continue

        letter = word[index]
        # Double consonant: lengthens the closure instead of repeating the viseme.
        if phones and index > 0 and letter == word[index - 1] and letter not in "aeiouy":
            phones[-1] = phones[-1].scaled(1.4)
            index += 1
            continue

        phone = _LETTER_TABLE.get(letter)
        if phone is not None:
            phones.append(phone)
        index += 1

    if not phones:
        phones.append(_IPA_TABLE["ə"])
    return phones


def _append_pause(phones: list[Phone], pause: Phone) -> None:
    """Avoids chains of consecutive pauses: keeps only the longest."""
    if phones and phones[-1].viseme == "sil" and phones[-1].openness == 0.0:
        if pause.duration > phones[-1].duration:
            phones[-1] = pause
        return
    phones.append(pause)


def _cleanup(phones: list[Phone]) -> list[Phone]:
    """Removes leading/trailing pauses and guarantees at least one phoneme."""
    while phones and phones[0].viseme == "sil" and phones[0].openness == 0.0:
        phones.pop(0)
    while phones and phones[-1].viseme == "sil" and phones[-1].openness == 0.0:
        phones.pop()
    if not phones:
        phones.append(_IPA_TABLE["ə"])
    return phones


def phones_for(text: str, ipa: str | None) -> list[Phone]:
    """Picks the best available source: real IPA, otherwise the heuristic."""
    if ipa and ipa.strip():
        phones = phones_from_ipa(ipa)
        # If the IPA string was degenerate (only punctuation) we fall back on the G2P.
        if any(p.openness > 0.1 for p in phones):
            return phones
    return phones_from_text(text)


def phone_from_symbol(symbol: str) -> Phone:
    """Converts a single IPA symbol into ``Phone``.

    Needed for the exact timings returned by ``Kokoro.create_timed``, where each
    phoneme arrives already isolated with its time interval.
    """
    text = unicodedata.normalize("NFC", symbol or "").strip()
    if not text:
        return _PAUSE_SHORT
    if text in _PUNCT_PAUSES:
        return _PUNCT_PAUSES[text]

    lengthened = any(char in _LENGTH_MARKS for char in text)
    core = "".join(c for c in text if c not in _IGNORED and c not in _LENGTH_MARKS)
    if not core:
        return _PAUSE_SHORT

    for size in range(min(_MAX_IPA_KEY, len(core)), 0, -1):
        phone = _IPA_TABLE.get(core[:size])
        if phone is not None:
            return phone.scaled(1.6) if lengthened else phone
    return Phone("e", 0.45, 0.22)


def phones_for_letters(
    characters: list[str], starts: list[float], ends: list[float]
) -> list[tuple[Phone, float, float]]:
    """Per-letter timings (ElevenLabs ``with-timestamps``) -> per-phoneme timings.

    A letter isn't a phoneme, but with its exact interval the heuristic G2P's
    table is enough to get a mouth as well timed as Kokoro's: the heuristic's
    flaw is guessing the durations, not the sounds.
    """
    result: list[tuple[Phone, float, float]] = []
    for char, start, end in zip(characters, starts, ends):
        decomposed = unicodedata.normalize("NFD", char or "").lower()
        letter = "".join(c for c in decomposed if not unicodedata.combining(c))
        if not letter or letter.isspace():
            phone = _PAUSE_SHORT
        elif letter in _PUNCT_PAUSES:
            phone = _PUNCT_PAUSES[letter]
        elif letter.isdigit():
            phone = _IPA_TABLE["a"]
        else:
            phone = _LETTER_TABLE.get(letter)
            if phone is None:
                continue
        result.append((phone, float(start), float(end)))
    return result
