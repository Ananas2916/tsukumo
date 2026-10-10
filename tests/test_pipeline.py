"""The full turn: brain -> sentences -> voice, errors and interruptions."""

import asyncio
import time

from backend.config import Settings
from backend.llm.base import LLMClient, Message, describe_error
from backend.pipeline import Companion


class Recorder:
    def __init__(self):
        self.messages = []

    async def __call__(self, message):
        self.messages.append(message)

    def of(self, kind):
        return [m for m in self.messages if m["type"] == kind]


class FailingLLM(LLMClient):
    name = "failing"

    async def stream(self, messages):
        raise TimeoutError()
        yield  # pragma: no cover

    async def health(self):
        return {"ok": False}


class SlowLLM(LLMClient):
    name = "slow"

    async def stream(self, messages):
        await asyncio.sleep(30)
        yield "troppo tardi."

    async def health(self):
        return {"ok": True}


class RecordingAgent(LLMClient):
    name = "agent"
    stateful = True

    def __init__(self):
        self.seen = []

    async def stream(self, messages):
        self.seen.append(list(messages))
        yield "Fatto."

    async def health(self):
        return {"ok": True}


class BrokenVoice:
    name = "broken"
    default_voice = "x"

    def synthesize(self, text, voice=None, speed=None):
        raise RuntimeError("invalid API key")

    def voices(self):
        return ["x"]

    def resolve_voice(self, voice):
        return "x"

    def language_of(self, voice):
        return None

    def close(self):
        pass


def _companion():
    return Companion(Settings.from_env())


def test_mock_turn_speaks_and_replies():
    emit = Recorder()
    companion = _companion()
    reply = asyncio.run(companion.chat("ciao", emit))
    assert reply
    assert emit.of("user")[0]["text"] == "ciao"
    speech = emit.of("speech")
    assert speech and speech[0]["visemes"] and speech[0]["audio"]
    assert emit.messages[-1] == {"type": "state", "value": "idle", "turn": 1}


def test_llm_failure_is_explained_not_silent():
    emit = Recorder()
    companion = _companion()
    companion.llm = FailingLLM()
    asyncio.run(companion.chat("ciao", emit))
    error = emit.of("error")[0]
    assert error["source"] == "llm" and error["action"] == "engines"
    # The old message was "LLM non raggiungibile ()": never empty again.
    assert "()" not in error["message"] and error["message"].strip().endswith("no answer")
    assert emit.of("reply")[0]["failed"] is True
    assert companion.last_errors["llm"]


def test_cancel_interrupts_a_thinking_agent_immediately():
    async def scenario():
        emit = Recorder()
        companion = _companion()
        companion.llm = SlowLLM()
        turn = asyncio.create_task(companion.chat("pensa a lungo", emit))
        await asyncio.sleep(0.2)
        started = time.perf_counter()
        companion.cancel()
        await asyncio.wait_for(turn, 3)
        return time.perf_counter() - started, emit

    elapsed, emit = asyncio.run(scenario())
    assert elapsed < 1.0
    assert emit.of("reply")[0]["cancelled"] is True


def test_broken_voice_keeps_the_text_flowing():
    emit = Recorder()
    companion = _companion()
    companion.tts = BrokenVoice()
    reply = asyncio.run(companion.chat("raccontami qualcosa di lungo per favore", emit))
    assert reply
    errors = [m for m in emit.of("error") if m["source"] == "tts"]
    assert len(errors) == 1, "l'errore della voce va detto una volta sola per turno"
    assert emit.of("caption"), "le frasi devono arrivare comunque come testo"
    assert not emit.of("speech")


def test_muted_sends_captions_without_synthesis():
    emit = Recorder()
    companion = _companion()
    companion.update_settings(muted=True)
    asyncio.run(companion.chat("ciao", emit))
    assert emit.of("caption") and not emit.of("speech")
    assert companion.current_settings()["muted"] is True


def test_silent_turns_from_the_phone_do_not_speak():
    # Written from the phone: text-only answer, the PC at home stays quiet.
    companion = _companion()
    phone, pc = Recorder(), Recorder()

    async def two_turns():
        await companion.chat("ciao", phone, silent=True)
        # The next turn, from the PC, has the voice again.
        await companion.chat("ciao di nuovo", pc)

    asyncio.run(two_turns())
    assert phone.of("caption") and not phone.of("speech")
    assert pc.of("speech")
    assert companion.current_settings()["muted"] is False


def test_agents_get_only_the_last_message():
    companion = _companion()
    agent = RecordingAgent()
    companion.llm = agent
    companion.history = [Message("user", "vecchio"), Message("assistant", "ok")]
    asyncio.run(companion.chat("nuovo", Recorder()))
    roles = [m.role for m in agent.seen[0]]
    assert roles.count("user") == 1 and agent.seen[0][-1].content == "nuovo"


def test_describe_error_is_never_empty():
    assert describe_error(TimeoutError()) == "Timed out: no answer"
    assert describe_error(asyncio.TimeoutError())
    assert "Unreachable" in describe_error(ConnectionRefusedError(1225, ""))
    assert describe_error(RuntimeError()) == "RuntimeError"
