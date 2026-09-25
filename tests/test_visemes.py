"""Lip-sync: la timeline dei visemi dev'essere ordinata, disgiunta e a tempo."""

import numpy as np

from backend.phonemes import Phone, phones_for, phones_for_letters
from backend.tts.formant import FormantTTS
from backend.visemes import build_timeline


def _frames(timeline):
    return [(f["t"], f["d"], f["v"], f["w"]) for f in timeline]


def test_timeline_from_real_audio_is_ordered_and_disjoint():
    speech = FormantTTS().synthesize("Ciao, come stai oggi?")
    phones = phones_for(speech.text, speech.phonemes)
    timeline = build_timeline(speech.samples, speech.sample_rate, phones)
    frames = _frames(timeline)
    assert frames, "nessun viseme per una frase vera"
    for (t0, d0, _, w0), (t1, _, _, _) in zip(frames, frames[1:]):
        assert t0 + d0 <= t1 + 1e-3
        assert 0.0 <= w0 <= 1.0
    assert frames[-1][0] + frames[-1][1] <= speech.duration + 0.05


def test_letter_timings_become_phones():
    chars = list("ciao!")
    starts = [0.0, 0.08, 0.16, 0.24, 0.32]
    ends = [0.08, 0.16, 0.24, 0.32, 0.40]
    timings = phones_for_letters(chars, starts, ends)
    assert all(isinstance(phone, Phone) for phone, _, _ in timings)
    assert [start for _, start, _ in timings] == sorted(start for _, start, _ in timings)
    # "a" apre la bocca piu' di "c"
    by_char = dict(zip(chars, (phone for phone, _, _ in timings)))
    assert by_char["a"].openness > by_char["c"].openness


def test_timeline_accepts_letter_timings():
    rate = 24000
    samples = (0.3 * np.sin(np.linspace(0, 440 * 2 * np.pi, rate // 2))).astype(np.float32)
    timings = phones_for_letters(list("ao"), [0.0, 0.25], [0.25, 0.5])
    timeline = build_timeline(samples, rate, [], timings=timings)
    assert [f["v"] for f in timeline if f["v"] != "sil"][:2] == ["a", "o"]
