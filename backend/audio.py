"""Utility audio: encoding WAV, base64 e analisi dell'inviluppo di ampiezza.

Usiamo solo ``numpy`` + il modulo ``wave`` della standard library, cosi' il
backend non dipende da libsndfile per funzionare.
"""

from __future__ import annotations

import base64
import io
import wave

import numpy as np


def to_int16(samples: np.ndarray) -> np.ndarray:
    """Converte campioni float (-1..1) in PCM 16 bit con protezione da clipping."""
    data = np.asarray(samples, dtype=np.float32).reshape(-1)
    if data.size == 0:
        return np.zeros(0, dtype=np.int16)
    peak = float(np.max(np.abs(data)))
    if peak > 1.0:
        data = data / peak
    return np.clip(data * 32767.0, -32768.0, 32767.0).astype(np.int16)


def encode_wav(samples: np.ndarray, sample_rate: int) -> bytes:
    """Serializza i campioni in un WAV mono 16 bit."""
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(int(sample_rate))
        wav_file.writeframes(to_int16(samples).tobytes())
    return buffer.getvalue()


def encode_wav_base64(samples: np.ndarray, sample_rate: int) -> str:
    """WAV pronto per essere infilato dentro un messaggio JSON/WebSocket."""
    return base64.b64encode(encode_wav(samples, sample_rate)).decode("ascii")


def decode_wav(payload: bytes) -> tuple[np.ndarray, int]:
    """Legge un WAV (mono o stereo, 8/16/32 bit) e restituisce float mono."""
    with wave.open(io.BytesIO(payload), "rb") as wav_file:
        channels = wav_file.getnchannels()
        width = wav_file.getsampwidth()
        rate = wav_file.getframerate()
        frames = wav_file.readframes(wav_file.getnframes())

    dtype = {1: np.uint8, 2: np.int16, 4: np.int32}.get(width)
    if dtype is None:
        raise ValueError(f"Profondita' WAV non supportata: {width * 8} bit")

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
    """Inviluppo RMS calcolato a finestre scorrevoli.

    Restituisce un array di lunghezza ``ceil(len(samples) / hop)`` con valori
    non normalizzati (la normalizzazione avviene in ``normalize_envelope``).
    """
    data = np.asarray(samples, dtype=np.float32).reshape(-1)
    hop = max(1, int(round(hop_s * sample_rate)))
    window = max(hop, int(round(window_s * sample_rate)))
    if data.size == 0:
        return np.zeros(0, dtype=np.float32)

    # Padding simmetrico per centrare la finestra sul campione corrente.
    pad = window // 2
    padded = np.pad(data, (pad, pad + window), mode="constant")
    # Somma cumulativa dei quadrati -> RMS in O(n) invece che O(n*window).
    squared = np.concatenate(([0.0], np.cumsum(padded.astype(np.float64) ** 2)))
    starts = np.arange(0, data.size, hop)
    ends = starts + window
    energy = (squared[ends] - squared[starts]) / float(window)
    return np.sqrt(np.maximum(energy, 0.0)).astype(np.float32)


def normalize_envelope(envelope: np.ndarray, percentile: float = 95.0) -> np.ndarray:
    """Normalizza l'inviluppo su un percentile alto (robusto ai picchi isolati)."""
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
    """Rimuove silenzio iniziale/finale lasciando un piccolo margine."""
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
