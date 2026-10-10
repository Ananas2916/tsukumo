"""Text -> speakable sentences: the part that breaks silently."""

from backend.pipeline import clean_for_speech, detect_mood, split_sentences, strip_emoji


def test_split_sentences_keeps_order_and_limits():
    text = "Ciao! Come stai? Oggi e' una bella giornata. " * 3
    sentences = split_sentences(text, max_chars=60)
    assert sentences
    assert all(len(s) <= 60 for s in sentences)
    assert " ".join(sentences).replace("  ", " ").startswith("Ciao! Come stai?")


def test_split_sentences_merges_tiny_fragments():
    assert split_sentences("Ok. Allora andiamo al mare domani mattina.") == [
        "Ok. Allora andiamo al mare domani mattina."
    ]


def test_long_sentence_is_cut_on_commas_then_spaces():
    long = "uno, due, tre, quattro, cinque, sei, sette, otto, nove, dieci, " * 6
    pieces = split_sentences(long, max_chars=50)
    assert all(len(p) <= 50 for p in pieces)
    assert "".join(pieces).replace(" ", "").replace(",", "") == long.replace(" ", "").replace(",", "")


def test_markdown_never_reaches_the_voice():
    assert clean_for_speech("**frieren** = `ice cream`") == "frieren = ice cream"


def test_emoji_and_emoticons_are_removed_but_times_survive():
    assert strip_emoji("Che bello! 😊 :) ci vediamo alle 10:30") == "Che bello! ci vediamo alle 10:30"


def test_mood_comes_from_emoji():
    assert detect_mood("Evviva 🎉🎉") == "happy"
    assert detect_mood("Peccato :(") == "sad"
    assert detect_mood("Nessuna emoji qui") is None
