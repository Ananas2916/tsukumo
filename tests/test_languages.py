"""The voice's language and the replies' language."""

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
    # An Italian Edge voice used to end up answering in English, because
    # only Kokoro names were recognized.
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


# ---------------------------------------------------------------------------
# System language -> default voice
# ---------------------------------------------------------------------------
from backend.languages import short_language, system_language  # noqa: E402
from backend.tts.base import VoiceInfo  # noqa: E402
from backend.tts.formant import FormantTTS  # noqa: E402


def test_short_language_understands_every_spelling():
    assert short_language("it-IT") == "it"
    assert short_language("it_IT.UTF-8") == "it"
    assert short_language("Italian_Italy") == "it"
    assert short_language("cmn") == "zh"
    assert short_language("C") == ""
    assert short_language(None) == ""


def test_system_language_can_be_forced(monkeypatch):
    monkeypatch.setenv("DC_SYSTEM_LANGUAGE", "fr-FR")
    assert system_language() == "fr"
    monkeypatch.delenv("DC_SYSTEM_LANGUAGE")
    assert len(system_language()) == 2


class _Catalog(FormantTTS):
    def __init__(self, default, voices):
        super().__init__()
        self.default_voice = default
        self._catalog = voices

    def voices(self):
        return [voice.id for voice in self._catalog]

    def voice_catalog(self):
        return list(self._catalog)


def test_voice_for_language_prefers_the_recommended_kokoro_voice():
    tts = _Catalog("af_heart", [
        VoiceInfo(id="af_heart", language="en", gender="female"),
        VoiceInfo(id="im_nicola", language="it", gender="male"),
        VoiceInfo(id="if_sara", language="it", gender="female"),
    ])
    assert tts.voice_for_language("it") == "if_sara"
    assert tts.voice_for_language("en") == "af_heart"  # the default one already speaks English
    assert tts.voice_for_language("ko") is None
    assert tts.voice_for_language("") is None


def test_voice_for_language_keeps_the_gender_of_the_default():
    tts = _Catalog("en-US-GuyNeural", [
        VoiceInfo(id="en-US-GuyNeural", language="en", gender="male"),
        VoiceInfo(id="it-IT-ElsaNeural", language="it", gender="female"),
        VoiceInfo(id="it-IT-DiegoNeural", language="it", gender="male"),
    ])
    assert tts.voice_for_language("it") == "it-IT-DiegoNeural"


def test_a_multilingual_default_voice_is_kept():
    tts = _Catalog("Rachel", [VoiceInfo(id="Rachel"), VoiceInfo(id="it-IT-ElsaNeural", language="it")])
    tts.language_of = lambda voice: None
    assert tts.voice_for_language("it") == "Rachel"
