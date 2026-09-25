"""Lingua della voce e lingua delle risposte."""

from backend.languages import kokoro_voice_info, language_name, reply_language, speech_directive
from backend.tts.base import locale_language
from backend.tts.formant import FormantTTS


def test_kokoro_voice_names_say_language_and_gender():
    assert kokoro_voice_info("if_sara") == {"name": "Sara", "language": "it", "gender": "female"}
    assert kokoro_voice_info("am_michael")["gender"] == "male"
    assert kokoro_voice_info("Rachel") is None


def test_locale_prefix():
    assert locale_language("it-IT-ElsaNeural") == "it"
    assert locale_language("it_IT-riccardo-x_low") == "it"
    assert locale_language("coral") == ""


def test_reply_language_follows_a_single_language_voice():
    assert reply_language("auto", "it") == "Italian"
    assert reply_language("auto", "en") == "English"


def test_multilingual_voice_answers_in_the_users_language():
    # Prima una voce Edge italiana finiva col rispondere in inglese, perche'
    # solo i nomi Kokoro venivano riconosciuti.
    assert reply_language("auto", None) is None
    assert "same language" in speech_directive(None)


def test_explicit_choice_wins():
    assert reply_language("inglese", "it") == "English"
    assert reply_language("same", "it") is None
    assert language_name("it-IT") == "Italian"


def test_engine_language_of_handles_multilingual_names():
    engine = FormantTTS()
    assert engine.language_of("en-US-AvaMultilingualNeural") is None
    assert engine.language_of("it-IT-ElsaNeural") == "it"
    assert engine.language_of("if_sara") == "it"
