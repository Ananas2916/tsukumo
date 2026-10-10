"""Audio utilities: WAV encoding, base64 and amplitude envelope analysis.

We use only ``numpy`` + the standard library's ``wave`` module, so the
backend doesn't depend on libsndfile to work.
"""

from __future__ import annotations

import base64
import io
import wave

import numpy as np


def to_int16(samples: np.ndarray) -> np.ndarray:
    """Converts float samples (-1..1) to 16-bit PCM with clipping protection."""
    data = np.asarray(samples, dtype=np.float32).reshape(-1)
    if data.size == 0:
        return np.zeros(0, dtype=np.int16)
    peak = float(np.max(np.abs(data)))
    if peak > 1.0:
        data = data / peak
    return np.clip(data * 32767.0, -32768.0, 32767.0).astype(np.int16)


def encode_wav(samples: np.ndarray, sample_rate: int) -> bytes:
    """Serializes the samples into a 16-bit mono WAV."""
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(int(sample_rate))
        wav_file.writeframes(to_int16(samples).tobytes())
    return buffer.getvalue()


def encode_wav_base64(samples: np.ndarray, sample_rate: int) -> str:
    """WAV ready to be put inside a JSON/WebSocket message."""
    return base64.b64encode(encode_wav(samples, sample_rate)).decode("ascii")


def decode_wav(payload: bytes) -> tuple[np.ndarray, int]:
    """Reads a WAV (mono or stereo, 8/16/32 bit) and returns mono floats."""
    with wave.open(io.BytesIO(payload), "rb") as wav_file:
        channels = wav_file.getnchannels()
        width = wav_file.getsampwidth()
        rate = wav_file.getframerate()
        frames = wav_file.readframes(wav_file.getnframes())

    dtype = {1: np.uint8, 2: np.int16, 4: np.int32}.get(width)
    if dtype is None:
        raise ValueError(f"Unsupported WAV depth: {width * 8} bit")

    data = np.frombuffer(frames, dtype=dtype).astype(np.float32)
    if width == 1:
        data = (data - 128.0) / 128.0
    else:
        data = data / float(np.iinfo(dtype).max)
    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)
    return data, rate


def rms_envelope(
    samples: np.ndarray,
    sample_rate: int,
    hop_s: float = 0.01,
    window_s: float = 0.025,
) -> np.ndarray:
    """RMS envelope computed over sliding windows.

    Returns an array of length ``ceil(len(samples) / hop)`` with non-normalized
    values (normalization happens in ``normalize_envelope``).
    """
    data = np.asarray(samples, dtype=np.float32).reshape(-1)
    hop = max(1, int(round(hop_s * sample_rate)))
    window = max(hop, int(round(window_s * sample_rate)))
    if data.size == 0:
        return np.zeros(0, dtype=np.float32)

    # Symmetric padding to centre the window on the current sample.
    pad = window // 2
    padded = np.pad(data, (pad, pad + window), mode="constant")
    # Cumulative sum of the squares -> RMS in O(n) instead of O(n*window).
    squared = np.concatenate(([0.0], np.cumsum(padded.astype(np.float64) ** 2)))
    starts = np.arange(0, data.size, hop)
    ends = starts + window
    energy = (squared[ends] - squared[starts]) / float(window)
    return np.sqrt(np.maximum(energy, 0.0)).astype(np.float32)


def normalize_envelope(envelope: np.ndarray, percentile: float = 95.0) -> np.ndarray:
    """Normalizes the envelope on a high percentile (robust to isolated peaks)."""
    if envelope.size == 0:
        return envelope
    reference = float(np.percentile(envelope, percentile))
    if reference <= 1e-6:
        reference = float(np.max(envelope)) or 1.0
    return np.clip(envelope / reference, 0.0, 1.0).astype(np.float32)


def trim_silence(
    samples: np.ndarray,
    sample_rate: int,
    threshold: float = 0.01,
    padding_s: float = 0.03,
) -> np.ndarray:
    """Removes leading/trailing silence, leaving a small margin."""
    data = np.asarray(samples, dtype=np.float32).reshape(-1)
    if data.size == 0:
        return data
    loud = np.flatnonzero(np.abs(data) > threshold)
    if loud.size == 0:
        return data
    pad = int(padding_s * sample_rate)
    start = max(0, int(loud[0]) - pad)
    end = min(data.size, int(loud[-1]) + pad)
    return data[start:end]
