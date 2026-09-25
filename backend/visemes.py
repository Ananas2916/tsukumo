"""Costruzione della timeline dei visemi per il lip-sync.

Ci sono due percorsi, in ordine di preferenza.

**A. Timing esatti.** Se il modello Kokoro espone l'output delle durate,
``create_timed`` ci dice esattamente quando inizia e finisce ogni fonema:
basta tradurre i simboli IPA in visemi (vedi ``_from_timings``).

**B. Allineamento sull'energia.** Se quei tempi non ci sono, li ricostruiamo
agganciando la sequenza di fonemi all'energia *reale* della forma d'onda:

1. calcoliamo l'inviluppo RMS dell'audio (finestre da 25 ms, hop da 10 ms);
2. individuiamo i segmenti di parlato (energia sopra soglia), unendo i micro
   silenzi e scartando i frammenti troppo brevi;
3. distribuiamo i fonemi sul "tempo di parlato" totale proporzionalmente ai
   loro pesi di durata, e li rimappiamo sul tempo reale: cosi' le pause
   finiscono automaticamente nei silenzi veri dell'audio;
4. l'ampiezza di apertura di ogni viseme viene modulata dall'energia media
   del tratto di audio corrispondente.

Il frontend fa poi un ulteriore lavoro: moltiplica il peso per il livello RMS
istantaneo letto da WebAudio, cosi' anche se la timeline sbanda di qualche
decina di millisecondi la bocca resta sincronizzata con il volume percepito.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from .audio import normalize_envelope, rms_envelope
from .phonemes import Phone, phone_from_symbol

# Parametri di segmentazione (secondi).
_MERGE_GAP = 0.09  # silenzi piu' corti di cosi' vengono assorbiti
_MIN_SEGMENT = 0.05  # segmenti piu' corti di cosi' vengono scartati
_MIN_FRAME = 0.02  # frame piu' corti vengono fusi con il precedente


@dataclass
class VisemeFrame:
    """Un intervallo di tempo in cui la bocca assume una certa forma."""

    time: float
    duration: float
    viseme: str
    weight: float

    def as_dict(self) -> dict[str, float | str]:
        # Chiavi corte: la timeline viaggia nel JSON del WebSocket.
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
    """Restituisce la timeline dei visemi pronta per il frontend.

    Se ``timings`` contiene i tempi esatti per fonema (Kokoro li espone con
    ``create_timed``) li usiamo direttamente: e' la sorgente piu' precisa.
    Altrimenti ricostruiamo il tempismo allineando i fonemi all'energia
    dell'audio, come descritto in testa al modulo.
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
# Percorso preferito: tempi esatti forniti dal modello
# --------------------------------------------------------------------------
def _from_timings(
    timings: list[tuple[Any, float, float]],
    envelope: np.ndarray,
    hop_s: float,
    gain: float,
    total_duration: float,
) -> list[VisemeFrame]:
    """Un frame per fonema, con inizio e fine gia' noti."""
    frames: list[VisemeFrame] = []
    for symbol, raw_start, raw_end in sorted(timings, key=lambda item: item[1]):
        start = max(0.0, min(float(raw_start), total_duration))
        end = max(0.0, min(float(raw_end), total_duration))
        if end - start <= 1e-4:
            continue

        # Kokoro da' simboli IPA; ElevenLabs lettere gia' tradotte in Phone.
        phone = symbol if isinstance(symbol, Phone) else phone_from_symbol(symbol)
        weight = 0.0
        if phone.viseme != "sil":
            # L'energia reale del tratto decide quanto aprire la bocca.
            level = _mean_level(envelope, hop_s, start, end)
            weight = float(np.clip(phone.openness * level * gain, 0.0, 1.0))
        frames.append(VisemeFrame(start, end - start, phone.viseme, weight))

    # I timing possono sovrapporsi di qualche millisecondo: tagliamo l'eccesso
    # perche' il frontend assume intervalli disgiunti e ordinati.
    for index in range(len(frames) - 1):
        overlap = (frames[index].time + frames[index].duration) - frames[index + 1].time
        if overlap > 0:
            frames[index].duration = max(0.001, frames[index].duration - overlap)
    return frames


# --------------------------------------------------------------------------
# Passo 2: segmentazione parlato / silenzio
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
        # Audio molto basso ma non vuoto: consideriamo tutto come parlato.
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

    # Clamp finale sulla durata reale dell'audio.
    return [(max(0.0, s), min(total_duration, e)) for s, e in kept if e > s]


# --------------------------------------------------------------------------
# Passo 3: distribuzione dei fonemi sui segmenti di parlato
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
    cursor = 0.0  # posizione nel "tempo di parlato" compresso
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
    """Converte un intervallo in tempo-di-parlato in 1..n intervalli reali.

    I segmenti sono concatenati in una linea temporale virtuale senza silenzi;
    un fonema che attraversa un silenzio viene spezzato in piu' tratti.
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
    # Media pesata verso il picco: le vocali brevi restano ben aperte.
    return float(0.55 * window.mean() + 0.45 * window.max())


# --------------------------------------------------------------------------
# Passo 4: pulizia della timeline
# --------------------------------------------------------------------------
def _fill_gaps(frames: list[VisemeFrame], total_duration: float) -> list[VisemeFrame]:
    """Inserisce frame ``sil`` nei buchi, all'inizio e alla fine."""
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
    """Fonde i frame troppo corti e quelli consecutivi con lo stesso viseme."""
    merged: list[VisemeFrame] = []
    for frame in frames:
        if merged:
            previous = merged[-1]
            same_viseme = previous.viseme == frame.viseme
            too_short = frame.duration < _MIN_FRAME
            if same_viseme or too_short:
                total = previous.duration + frame.duration
                if total > 0:
                    # Peso medio pesato sulla durata dei due frame.
                    previous.weight = (
                        previous.weight * previous.duration + frame.weight * frame.duration
                    ) / total
                previous.duration = total
                if not same_viseme and frame.weight > previous.weight:
                    previous.viseme = frame.viseme
                continue
        merged.append(VisemeFrame(frame.time, frame.duration, frame.viseme, frame.weight))
    return merged
