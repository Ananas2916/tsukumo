"""The last lines of the chat, sent again to whoever reconnects (the suspended phone)."""

import pytest

from backend.transcript import Transcript


class Clock:
    def __init__(self, now: float = 1_759_500_000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


@pytest.mark.parametrize(
    "message, entry",
    [
        ({"type": "user", "text": "ciao", "turn": 3, "files": []}, {"role": "user", "text": "ciao", "files": [], "turn": 3}),
        (
            {"type": "user", "text": "", "turn": 4, "files": [{"name": "foto.png", "kind": "image"}]},
            {"role": "user", "text": "", "files": ["foto.png"], "turn": 4},
        ),
        ({"type": "reply", "text": " Eccomi! ", "turn": 3}, {"role": "assistant", "text": "Eccomi!", "turn": 3}),
        (
            {"type": "reply", "text": "Sono le cinque.", "turn": 9, "proactive": True, "cancelled": False},
            {"role": "assistant", "text": "Sono le cinque.", "turn": 9, "proactive": True},
        ),
        (
            {"type": "reply", "text": "Allora, il fi", "turn": 5, "cancelled": True},
            {"role": "assistant", "text": "Allora, il fi", "turn": 5, "cancelled": True},
        ),
        # Nothing to recover: empty turns, the voice repeating, streaming.
        ({"type": "reply", "text": "", "turn": 6, "failed": True}, None),
        ({"type": "reply", "text": "Ciao a tutti", "turn": 7, "said": True}, None),
        ({"type": "user", "text": "  ", "turn": 8}, None),
        ({"type": "token", "text": "Ecco"}, None),
        ({"type": "speech", "text": "Ecco.", "audio": "UklGR..."}, None),
    ],
)
def test_what_counts_as_a_chat_line(message, entry):
    transcript = Transcript(clock=Clock())
    sent = transcript.observe(message)
    if entry is None:
        assert sent is message and transcript.recent() == []
        return
    [kept] = transcript.recent()
    assert {k: v for k, v in kept.items() if k not in ("seq", "at")} == entry
    assert sent == {**message, "seq": kept["seq"]} and kept["at"] == 1_759_500_000.0


def test_seq_always_grows_and_old_lines_drop_off():
    clock = Clock()
    transcript = Transcript(keep=3, clock=clock)
    seqs = [transcript.observe({"type": "reply", "text": f"r{i}", "turn": i})["seq"] for i in range(5)]
    # Within the same millisecond it doesn't repeat; after a restart it starts again from the clock, further on.
    assert seqs == sorted(set(seqs)) and seqs[0] == 1_759_500_000_000
    assert [entry["text"] for entry in transcript.recent()] == ["r2", "r3", "r4"]
    clock.now += 60
    restarted = Transcript(clock=clock)
    assert restarted.observe({"type": "user", "text": "ci sei?"})["seq"] > seqs[-1]


def test_reset_empties_it():
    transcript = Transcript(clock=Clock())
    transcript.observe({"type": "user", "text": "ciao"})
    reset = {"type": "reset"}
    assert transcript.observe(reset) is reset
    assert transcript.recent() == []


def test_a_client_that_reconnects_finds_the_reply(client):
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": "chat", "text": "ricordati di me"})
        lines = {}
        for _ in range(200):
            message = ws.receive_json()
            if message["type"] in ("user", "reply"):
                lines[message["type"]] = message
            if message["type"] == "state" and message["value"] == "idle":
                break
    assert lines["user"]["seq"] < lines["reply"]["seq"]

    # The phone was suspended: reopening the app, the hello brings it the answer.
    with client.websocket_connect("/ws?mode=text") as ws:
        hello = ws.receive_json()
    recent = {entry["seq"]: entry for entry in hello["transcript"]}
    assert recent[lines["user"]["seq"]]["text"] == "ricordati di me"
    assert recent[lines["reply"]["seq"]] == {
        "seq": lines["reply"]["seq"],
        "role": "assistant",
        "text": lines["reply"]["text"],
        "turn": lines["reply"]["turn"],
        "at": recent[lines["reply"]["seq"]]["at"],
    }
    assert all("audio" not in entry for entry in hello["transcript"])
