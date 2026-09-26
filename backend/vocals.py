"""Versetti: brevi esclamazioni con la voce in uso ("Hii!", "Ehehe!", "Waah!").

Accompagnano i gesti del personaggio (saluto, carezza, spavento, caduta) e
non passano dal cervello: sono frasi fisse, nella lingua della voce scelta,
cosi' il saluto di una voce italiana e' "Ciao!" e non "Hii!" con l'accento.

Le frasi sono corte e senza simboli strani: devono suonare bene con qualunque
motore TTS, da Kokoro a ElevenLabs.
"""

from __future__ import annotations

import random

#: Evento -> lingua (codice ISO a due lettere) -> varianti.
LINES: dict[str, dict[str, tuple[str, ...]]] = {
    "greet": {
        "en": ("Hii!", "Hi there!"),
        "it": ("Ciao!", "Ciao ciao!"),
        "es": ("¡Hola!",),
        "fr": ("Coucou !", "Salut !"),
        "de": ("Hallo!", "Hi!"),
        "pt": ("Oi!", "Olá!"),
        "ja": ("やっほー!", "こんにちは!"),
        "zh": ("嗨!", "你好!"),
        "hi": ("नमस्ते!",),
    },
    "morning": {
        "en": ("Good morning!",),
        "it": ("Buongiorno!",),
        "es": ("¡Buenos días!",),
        "fr": ("Bonjour !",),
        "de": ("Guten Morgen!",),
        "pt": ("Bom dia!",),
        "ja": ("おはよう!",),
        "zh": ("早上好!",),
    },
    "evening": {
        "en": ("Good evening!",),
        "it": ("Buonasera!",),
        "es": ("¡Buenas noches!",),
        "fr": ("Bonsoir !",),
        "de": ("Guten Abend!",),
        "pt": ("Boa noite!",),
        "ja": ("こんばんは!",),
        "zh": ("晚上好!",),
    },
    "night": {
        "en": ("Still up?",),
        "it": ("Ancora in piedi?",),
        "es": ("¿Sigues por aquí?",),
        "fr": ("Tu veilles encore ?",),
        "de": ("Noch wach?",),
        "pt": ("Ainda por aqui?",),
        "ja": ("まだ起きてるの?",),
        "zh": ("还没睡吗?",),
    },
    "welcome": {
        "en": ("Welcome back!", "Oh, you're back!"),
        "it": ("Eccoti!", "Ah, eccoti qui!"),
        "es": ("¡Ya estás aquí!",),
        "fr": ("Te revoilà !",),
        "de": ("Da bist du ja!",),
        "pt": ("Você voltou!",),
        "ja": ("おかえり!",),
        "zh": ("欢迎回来!",),
    },
    "pat": {
        "en": ("Hehe!", "Ehehe!"),
        "it": ("Ihih!", "Ehehe!"),
        "es": ("¡Jiji!",),
        "fr": ("Hihi !",),
        "de": ("Hihi!",),
        "pt": ("Hihi!",),
        "ja": ("えへへ!",),
        "zh": ("嘿嘿!",),
    },
    "poke": {
        "en": ("Eep!", "Hey!"),
        "it": ("Ehi!", "Ahi!"),
        "es": ("¡Ay!", "¡Oye!"),
        "fr": ("Aïe !", "Hé !"),
        "de": ("Hey!", "Au!"),
        "pt": ("Ai!", "Ei!"),
        "ja": ("きゃっ!", "わっ!"),
        "zh": ("哎呀!",),
    },
    "lift": {
        "en": ("Whoa!", "Hey, put me down!"),
        "it": ("Ehi!", "Mettimi giù!"),
        "es": ("¡Eh!",),
        "fr": ("Hé !",),
        "de": ("Hoppla!",),
        "pt": ("Ei!",),
        "ja": ("わわっ!",),
        "zh": ("哇!",),
    },
    "pout": {
        "en": ("Hey, cut it out!", "Hmph!"),
        "it": ("Uffa, basta!", "Smettila!"),
        "es": ("¡Oye, ya basta!",),
        "fr": ("Hé, arrête !",),
        "de": ("Hey, hör auf!",),
        "pt": ("Ei, para com isso!",),
        "ja": ("もう、やめてよ!",),
        "zh": ("哼, 别闹了!",),
    },
    "dizzy": {
        "en": ("Whoa, I'm so dizzy...",),
        "it": ("Uh, mi gira la testa...",),
        "es": ("Ay, qué mareo...",),
        "fr": ("Oh là là, la tête me tourne...",),
        "de": ("Oh, mir ist schwindelig...",),
        "pt": ("Ai, que tontura...",),
        "ja": ("目が回る〜",),
        "zh": ("头好晕...",),
    },
    "fall": {
        "en": ("Waah!", "Whoa!"),
        "it": ("Aaah!", "Uaaah!"),
        "es": ("¡Aaah!",),
        "fr": ("Aaah !",),
        "de": ("Aaah!",),
        "pt": ("Aaah!",),
        "ja": ("わぁー!",),
        "zh": ("啊!",),
    },
    # Un agente lavora da un po' e non ha ancora detto niente (vedi pipeline).
    "working": {
        "en": ("One moment, I'm on it.", "Give me a second, I'm working on it."),
        "it": ("Un attimo, ci sto lavorando.", "Dammi un secondo, sto controllando."),
        "es": ("Un momento, estoy en ello.",),
        "fr": ("Un instant, je m'en occupe.",),
        "de": ("Einen Moment, ich bin dran.",),
        "pt": ("Um momento, estou nisso.",),
        "ja": ("ちょっと待ってね、今やってるよ。",),
        "zh": ("稍等, 我正在处理。",),
    },
    "working_long": {
        "en": ("Still working on it, almost there.",),
        "it": ("Ci vuole ancora un pochino, quasi fatto.",),
        "es": ("Todavía estoy en ello, ya casi.",),
        "fr": ("J'y suis encore, presque fini.",),
        "de": ("Dauert noch ein bisschen, fast fertig.",),
        "pt": ("Ainda estou nisso, quase lá.",),
        "ja": ("もう少しかかるよ、あとちょっと。",),
        "zh": ("还需要一会儿, 快好了。",),
    },
}

EVENTS = frozenset(LINES)

#: Se per una lingua manca l'evento, meglio un saluto nella lingua giusta che
#: una frase inglese letta con la fonetica di un'altra lingua.
_FALLBACK_EVENT = {"morning": "greet", "evening": "greet", "night": "greet", "welcome": "greet"}

#: Codici che i motori usano per la stessa lingua.
_LANGUAGE_ALIASES = {"cmn": "zh", "yue": "zh", "jp": "ja"}


def language_key(language: str | None) -> str:
    """``en-us``, ``it-IT``, ``cmn`` -> ``en``, ``it``, ``zh``."""
    code = (language or "en").strip().lower().replace("_", "-").split("-")[0]
    return _LANGUAGE_ALIASES.get(code, code) or "en"


def vocal_line(event: str, language: str | None, rng: random.Random | None = None) -> str:
    """Una frase per ``event`` nella lingua della voce (inglese se non c'e')."""
    if event not in LINES:
        raise KeyError(event)
    code = language_key(language)
    options = LINES[event].get(code)
    if not options and event in _FALLBACK_EVENT:
        options = LINES[_FALLBACK_EVENT[event]].get(code)
    if not options:
        options = LINES[event]["en"]
    return (rng or random).choice(options)
