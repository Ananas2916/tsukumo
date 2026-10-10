"""Building the viseme timeline for the lip-sync.

There are two paths, in order of preference.

**A. Exact timings.** If the Kokoro model exposes the durations output,
``create_timed`` tells us exactly when each phoneme starts and ends: it's
enough to translate the IPA symbols into visemes (see ``_from_timings``).

**B. Alignment on the energy.** If those timings aren't there, we rebuild
them by hooking the phoneme sequence to the *real* energy of the waveform:

1. we compute the audio's RMS envelope (25 ms windows, 10 ms hop);
2. we find the speech segments (energy above a threshold), merging the
   micro-silences and discarding the fragments that are too short;
3. we spread the phonemes over the total "speech time" in proportion to
   their duration weights, and map them back onto the real time: so the
   pauses automatically end up in the audio's real silences;
4. each viseme's opening amplitude is modulated by the average energy of the
   matching stretch of audio.

The frontend then does one more job: it multiplies the weight by the
instantaneous RMS level read from WebAudio, so even if the timeline drifts by
a few tens of milliseconds the mouth stays in sync with the perceived volume.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from .audio import normalize_envelope, rms_envelope
from .phonemes import Phone, phone_from_symbol

# Segmentation parameters (seconds).
_MERGE_GAP = 0.09  # silences shorter than this are absorbed
_MIN_SEGMENT = 0.05  # segments shorter than this are discarded
_MIN_FRAME = 0.02  # shorter frames are merged with the previous one


@dataclass
class VisemeFrame:
    """A time interval in which the mouth takes a certain shape."""

    time: float
    duration: float
    viseme: str
    weight: float

    def as_dict(self) -> dict[str, float | str]:
        # Short keys: the timeline travels in the WebSocket's JSON.
        return {
            "t": round(self.time, 4),
            "d": round(self.duration, 4),
            "v": self.viseme,
            "w": round(self.weight, 4),
        }


def build_timeline(
    samples: np.ndarray,
    sample_rate: int,
    phones: list[Phone],
    *,
    timings: list[tuple[Any, float, float]] | None = None,
    gain: float = 1.15,
    silence_threshold: float = 0.07,
    hop_s: float = 0.01,
) -> list[dict[str, float | str]]:
    """Returns the viseme timeline ready for the frontend.

    If ``timings`` has the exact per-phoneme times (Kokoro exposes them with
    ``create_timed``) we use them directly: it's the most precise source.
    Otherwise we rebuild the timing by aligning the phonemes to the audio's
    energy, as described at the top of the module.
    """
    data = np.asarray(samples, dtype=np.float32).reshape(-1)
    total_duration = data.size / float(sample_rate) if sample_rate else 0.0
    if total_duration <= 0.0:
        return []

    envelope = normalize_envelope(rms_envelope(data, sample_rate, hop_s=hop_s))

    if timings:
        frames = _from_timings(timings, envelope, hop_s, gain, total_duration)
    elif phones:
        segments = _speech_segments(envelope, hop_s, silence_threshold, total_duration)
        frames = _distribute(phones, segments, envelope, hop_s, gain)
    else:
        return []

    frames = _fill_gaps(frames, total_duration)
    frames = _merge_short(frames)
    return [frame.as_dict() for frame in frames]


# --------------------------------------------------------------------------
# Preferred path: exact times provided by the model
# --------------------------------------------------------------------------
def _from_timings(
    timings: list[tuple[Any, float, float]],
    envelope: np.ndarray,
    hop_s: float,
    gain: float,
    total_duration: float,
) -> list[VisemeFrame]:
    """One frame per phoneme, with start and end already known."""
    frames: list[VisemeFrame] = []
    for symbol, raw_start, raw_end in sorted(timings, key=lambda item: item[1]):
        start = max(0.0, min(float(raw_start), total_duration))
        end = max(0.0, min(float(raw_end), total_duration))
        if end - start <= 1e-4:
            continue

        # Kokoro gives IPA symbols; ElevenLabs letters already translated into Phone.
        phone = symbol if isinstance(symbol, Phone) else phone_from_symbol(symbol)
        weight = 0.0
        if phone.viseme != "sil":
            # The stretch's real energy decides how wide to open the mouth.
            level = _mean_level(envelope, hop_s, start, end)
            weight = float(np.clip(phone.openness * level * gain, 0.0, 1.0))
        frames.append(VisemeFrame(start, end - start, phone.viseme, weight))

    # The timings can overlap by a few milliseconds: we cut the excess because
    # the frontend assumes disjoint, ordered intervals.
    for index in range(len(frames) - 1):
        overlap = (frames[index].time + frames[index].duration) - frames[index + 1].time
        if overlap > 0:
            frames[index].duration = max(0.001, frames[index].duration - overlap)
    return frames


# --------------------------------------------------------------------------
# Step 2: speech / silence segmentation
# --------------------------------------------------------------------------
def _speech_segments(
    envelope: np.ndarray,
    hop_s: float,
    threshold: float,
    total_duration: float,
) -> list[tuple[float, float]]:
    if envelope.size == 0:
        return [(0.0, total_duration)]

    voiced = envelope >= threshold
    if not voiced.any():
        # Very quiet but not empty audio: we consider it all speech.
        return [(0.0, total_duration)]

    segments: list[tuple[float, float]] = []
    start_index: int | None = None
    for index, is_voiced in enumerate(voiced):
        if is_voiced and start_index is None:
            start_index = index
        elif not is_voiced and start_index is not None:
            segments.append((start_index * hop_s, index * hop_s))
            start_index = None
    if start_index is not None:
        segments.append((start_index * hop_s, voiced.size * hop_s))

    merged: list[tuple[float, float]] = []
    for start, end in segments:
        if merged and start - merged[-1][1] <= _MERGE_GAP:
            merged[-1] = (merged[-1][0], end)
        else:
            merged.append((start, end))

    kept = [seg for seg in merged if seg[1] - seg[0] >= _MIN_SEGMENT]
    if not kept:
        kept = [max(merged, key=lambda seg: seg[1] - seg[0])]

    # Final clamp on the audio's real length.
    return [(max(0.0, s), min(total_duration, e)) for s, e in kept if e > s]


# --------------------------------------------------------------------------
# Step 3: spreading the phonemes over the speech segments
# --------------------------------------------------------------------------
def _distribute(
    phones: list[Phone],
    segments: list[tuple[float, float]],
    envelope: np.ndarray,
    hop_s: float,
    gain: float,
) -> list[VisemeFrame]:
    speech_time = sum(end - start for start, end in segments)
    weight_total = sum(max(p.duration, 0.01) for p in phones)
    if speech_time <= 0.0 or weight_total <= 0.0:
        return []

    frames: list[VisemeFrame] = []
    cursor = 0.0  # position in the compressed "speech time"
    for phone in phones:
        span = max(phone.duration, 0.01) / weight_total * speech_time
        for start, end in _map_span(cursor, cursor + span, segments):
            if end - start <= 1e-4:
                continue
            level = _mean_level(envelope, hop_s, start, end)
            weight = 0.0
            if phone.viseme != "sil":
                weight = float(np.clip(phone.openness * level * gain, 0.0, 1.0))
            frames.append(VisemeFrame(start, end - start, phone.viseme, weight))
        cursor += span

    return frames


def _map_span(
    speech_start: float,
    speech_end: float,
    segments: list[tuple[float, float]],
) -> list[tuple[float, float]]:
    """Converts an interval in speech time into 1..n real intervals.

    The segments are concatenated in a virtual timeline without silences; a
    phoneme crossing a silence is split into several stretches.
    """
    pieces: list[tuple[float, float]] = []
    offset = 0.0
    for seg_start, seg_end in segments:
        seg_len = seg_end - seg_start
        seg_from, seg_to = offset, offset + seg_len
        offset = seg_to
        if speech_end <= seg_from or speech_start >= seg_to:
            continue
        local_start = seg_start + (max(speech_start, seg_from) - seg_from)
        local_end = seg_start + (min(speech_end, seg_to) - seg_from)
        pieces.append((local_start, local_end))
    return pieces


def _mean_level(envelope: np.ndarray, hop_s: float, start: float, end: float) -> float:
    if envelope.size == 0:
        return 1.0
    first = int(start / hop_s)
    last = max(first + 1, int(round(end / hop_s)))
    window = envelope[min(first, envelope.size - 1) : min(last, envelope.size)]
    if window.size == 0:
        return float(envelope[min(first, envelope.size - 1)])
    # Average weighted towards the peak: short vowels stay well open.
    return float(0.55 * window.mean() + 0.45 * window.max())


# --------------------------------------------------------------------------
# Step 4: cleaning the timeline
# --------------------------------------------------------------------------
def _fill_gaps(frames: list[VisemeFrame], total_duration: float) -> list[VisemeFrame]:
    """Inserts ``sil`` frames in the gaps, at the start and at the end."""
    if not frames:
        return [VisemeFrame(0.0, total_duration, "sil", 0.0)]

    filled: list[VisemeFrame] = []
    if frames[0].time > 1e-3:
        filled.append(VisemeFrame(0.0, frames[0].time, "sil", 0.0))

    for frame in frames:
        if filled:
            previous_end = filled[-1].time + filled[-1].duration
            gap = frame.time - previous_end
            if gap > 1e-3:
                filled.append(VisemeFrame(previous_end, gap, "sil", 0.0))
        filled.append(frame)

    tail = total_duration - (filled[-1].time + filled[-1].duration)
    if tail > 1e-3:
        filled.append(VisemeFrame(total_duration - tail, tail, "sil", 0.0))
    return filled


def _merge_short(frames: list[VisemeFrame]) -> list[VisemeFrame]:
    """Merges the frames that are too short and consecutive ones with the same viseme."""
    merged: list[VisemeFrame] = []
    for frame in frames:
        if merged:
            previous = merged[-1]
            same_viseme = previous.viseme == frame.viseme
            too_short = frame.duration < _MIN_FRAME
            if same_viseme or too_short:
                total = previous.duration + frame.duration
                if total > 0:
                    # Average weight weighted on the two frames' durations.
                    previous.weight = (
                        previous.weight * previous.duration + frame.weight * frame.duration
                    ) / total
                previous.duration = total
                if not same_viseme and frame.weight > previous.weight:
                    previous.viseme = frame.viseme
                continue
        merged.append(VisemeFrame(frame.time, frame.duration, frame.viseme, frame.weight))
    return merged
