"""A more natural conversation: the voice starts earlier, echo recognized, measured timings."""

import asyncio

from backend.config import Settings
from backend.pipeline import Companion, first_clause

from helpers import Scripted


class Recorder:
    def __init__(self):
        self.messages = []

    async def __call__(self, message):
        self.messages.append(message)

    def of(self, kind):
        return [m for m in self.messages if m["type"] == kind]


def test_first_clause_needs_a_real_clause():
    assert first_clause("Allora, vediamo") is None  # too short to start
    head, rest = first_clause("Ho guardato le previsioni per domani, e sembra che")
    assert head == "Ho guardato le previsioni per domani," and rest == "e sembra che"
    assert first_clause("una frase senza virgole che continua ancora") is None


def test_first_clause_starts_the_voice_before_the_full_stop():
    emit = Recorder()
    companion = Companion(Settings.from_env())
    companion.llm = Scripted(["Ho guardato le previsioni per domani, e sembra", " che piovera' tutto il giorno."])
    asyncio.run(companion.chat("che tempo fa domani?", emit))
    spoken = [m["text"] for m in emit.of("speech")]
    assert spoken[0].startswith("Ho guardato le previsioni per domani")
    assert len(spoken) == 2 and "piovera" in spoken[1]


def test_reply_reports_timings():
    emit = Recorder()
    companion = Companion(Settings.from_env())
    asyncio.run(companion.chat("ciao", emit))
    timings = emit.of("reply")[0]["timings"]
    assert timings["firstText"] is not None and timings["firstVoice"] is not None
    assert timings["firstText"] <= timings["firstVoice"] <= timings["total"]


def test_her_own_voice_is_recognised_as_echo():
    emit = Recorder()
    companion = Companion(Settings.from_env())
    companion.llm = Scripted(["Domani a Milano piove quasi tutto il giorno."])
    asyncio.run(companion.chat("meteo?", emit))
    assert companion.is_echo("domani a milano piove quasi tutto il giorno")
    assert companion.is_echo("a Milano piove quasi tutto")
    assert not companion.is_echo("e a Roma invece com'è la situazione?")
    assert not companion.is_echo("piove")  # a single word isn't enough to tell
