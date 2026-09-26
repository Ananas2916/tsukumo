"""Sintesi locale con Chatterbox (Resemble AI), su GPU.

Qualita' nettamente superiore a Kokoro e cloning vocale da pochi secondi di
audio di riferimento. Usa il modello multilingua, che copre anche l'italiano.

Le voci sono file audio in ``voices_dir``: quella predefinita e' inclusa nel
modello, le altre si aggiungono clonandole dal pannello (o copiando un .wav
nella cartella). ``voices.json`` accanto ai file ne ricorda nome e lingua: la
stessa voce clonata puo' parlare qualunque lingua, ma la lingua scelta decide
l'accento e in che lingua risponde il cervello.
"""

from __future__ import annotations

import json
import logging
import re
import threading
from pathlib import Path

import numpy as np

from .base import Speech, TTSEngine, VoiceInfo

logger = logging.getLogger(__name__)

DEFAULT_VOICE = "default"
AUDIO_SUFFIXES = (".wav", ".mp3", ".flac", ".ogg")
SAMPLE_RATE = 24000
#: Il modello usa solo i primi 10 s del riferimento; ne teniamo un po' di piu'.
MAX_REFERENCE_S = 20.0
MIN_REFERENCE_S = 3.0


class ChatterboxTTS(TTSEngine):
    """Wrapper thread-safe attorno a ``ChatterboxMultilingualTTS``."""

    name = "chatterbox"
    can_clone = True

    def __init__(
        self,
        voices_dir: Path,
        device: str = "auto",
        language: str = "it",
        exaggeration: float = 0.5,
        cfg_weight: float = 0.5,
    ) -> None:
        try:
            import torch
            from chatterbox.mtl_tts import SUPPORTED_LANGUAGES, ChatterboxMultilingualTTS
        except ImportError as exc:
            raise RuntimeError(
                "Il motore Chatterbox richiede il pacchetto 'chatterbox-tts' "
                "(che porta con se' PyTorch). Installalo con: "
                "pip install chatterbox-tts"
            ) from exc

        self._torch = torch
        self.supported_languages = set(SUPPORTED_LANGUAGES)
        chosen_device = device if device in ("cuda", "cpu") else ("cuda" if torch.cuda.is_available() else "cpu")
        if chosen_device == "cpu":
            logger.warning("Chatterbox su CPU: la sintesi sara' molto lenta")

        logger.info("Carico Chatterbox su %s", chosen_device)
        self._model = ChatterboxMultilingualTTS.from_local(_checkpoint_dir(), device=chosen_device)
        # In fp32 il modello sfiora i 3.3 GB e su Windows, con la VRAM condivisa
        # con altri programmi, finisce in RAM di sistema: 5-7 volte piu' lento.
        # In bf16 sta in 2.2 GB e genera piu' in fretta del tempo reale.
        self._dtype = torch.bfloat16 if chosen_device == "cuda" and torch.cuda.is_bf16_supported() else None
        if self._dtype is not None:
            self._model.t3.to(dtype=self._dtype)

        self._lock = threading.Lock()  # un solo modello torch, niente generazioni in parallelo
        self.exaggeration = exaggeration
        self.cfg_weight = cfg_weight
        self._conds: dict[str, object] = {DEFAULT_VOICE: self._cast(self._model.conds)}
        self.voices_dir = Path(voices_dir)
        self.voices_dir.mkdir(parents=True, exist_ok=True)
        self.language = self._check_language(language)
        self.default_voice = DEFAULT_VOICE

        # La prima generazione compila i kernel CUDA: meglio adesso che alla
        # prima risposta.
        self.synthesize("Ciao.")

    # ------------------------------------------------------------------ voci
    def voices(self) -> list[str]:
        return [DEFAULT_VOICE, *self._clones()]

    def voice_catalog(self) -> list[VoiceInfo]:
        index = self._index()
        catalog = [
            VoiceInfo(
                id=DEFAULT_VOICE,
                name="Predefinita",
                language=self.language,
                gender="female",
                description="inclusa nel modello",
            )
        ]
        for voice_id in self._clones():
            meta = index.get(voice_id, {})
            catalog.append(
                VoiceInfo(
                    id=voice_id,
                    name=meta.get("name") or voice_id,
                    language=meta.get("language") or self.language,
                    description="clonata",
                    removable=True,
                )
            )
        return catalog

    def language_of(self, voice: str | None) -> str | None:
        if voice and voice != DEFAULT_VOICE:
            return self._index().get(voice, {}).get("language") or self.language
        return self.language

    def add_voice(self, name: str, data: bytes, language: str) -> str:
        """Clona una voce da un file audio e restituisce il suo id."""
        import io

        import librosa
        import soundfile as sf

        language = self._check_language(language)
        try:
            audio, _ = librosa.load(io.BytesIO(data), sr=SAMPLE_RATE, mono=True, duration=MAX_REFERENCE_S)
        except Exception as exc:
            raise ValueError("Non riesco a leggere il file: usa un .wav, .mp3, .flac o .ogg.") from exc
        audio, _ = librosa.effects.trim(audio, top_db=35)
        if len(audio) < MIN_REFERENCE_S * SAMPLE_RATE:
            raise ValueError(f"Serve almeno {MIN_REFERENCE_S:.0f} secondi di voce parlata.")
        peak = float(np.max(np.abs(audio))) or 1.0
        audio = audio / peak * 0.95

        voice_id = self._unique_id(name)
        sf.write(self.voices_dir / f"{voice_id}.wav", audio, SAMPLE_RATE)
        index = self._index()
        index[voice_id] = {"name": name.strip() or voice_id, "language": language}
        self._write_index(index)
        logger.info("Voce clonata: %s (%s)", voice_id, language)
        return voice_id

    def remove_voice(self, voice_id: str) -> None:
        if voice_id == DEFAULT_VOICE or voice_id not in self._clones():
            raise ValueError(f"Voce sconosciuta: {voice_id}")
        path = self._reference(voice_id)
        if path is not None:
            path.unlink()
        index = self._index()
        index.pop(voice_id, None)
        self._write_index(index)
        with self._lock:
            self._conds.pop(voice_id, None)

    # ---------------------------------------------------------------- sintesi
    def synthesize(
        self,
        text: str,
        voice: str | None = None,
        speed: float | None = None,
    ) -> Speech:
        clean = (text or "").strip()
        if not clean:
            return Speech(
                samples=np.zeros(0, dtype=np.float32),
                sample_rate=SAMPLE_RATE,
                text="",
                meta={"engine": self.name},
            )

        chosen = voice if voice in self.voices() else DEFAULT_VOICE
        language = self.language_of(chosen) or self.language

        # Il modello non ha un parametro di velocita'.
        with self._lock:
            self._model.conds = self._conditionals(chosen)
            wav = self._model.generate(
                clean,
                language_id=language,
                # Il valore gia' convertito in bf16: se differisse da quello
                # delle condizioni, generate() le ricostruirebbe in fp32.
                exaggeration=float(self._model.conds.t3.emotion_adv[0, 0, 0]),
                cfg_weight=self.cfg_weight,
            )

        samples = np.ascontiguousarray(wav.squeeze(0).detach().cpu().float().numpy())
        return Speech(
            samples=samples,
            sample_rate=int(self._model.sr),
            text=clean,
            meta={"engine": self.name, "voice": chosen, "language": language},
        )

    def close(self) -> None:
        self._model = None  # type: ignore[assignment]
        self._conds.clear()
        if self._torch.cuda.is_available():
            self._torch.cuda.empty_cache()

    # ------------------------------------------------------------- interni
    def _conditionals(self, voice_id: str):
        """Le condizioni (impronta della voce) di ``voice_id``, calcolate una volta sola."""
        cached = self._conds.get(voice_id)
        if cached is not None:
            return cached
        reference = self._reference(voice_id)
        if reference is None:
            return self._conds[DEFAULT_VOICE]
        self._model.prepare_conditionals(str(reference), exaggeration=self.exaggeration)
        conds = self._cast(self._model.conds)
        self._conds[voice_id] = conds
        return conds

    def _cast(self, conds):
        emotion = conds.t3.emotion_adv
        conds.t3.emotion_adv = self._torch.full_like(emotion, float(self.exaggeration))
        if self._dtype is not None:
            for key, value in vars(conds.t3).items():
                if self._torch.is_tensor(value) and value.is_floating_point():
                    setattr(conds.t3, key, value.to(self._dtype))
        return conds

    def _clones(self) -> list[str]:
        return sorted({p.stem for p in self.voices_dir.iterdir() if p.suffix.lower() in AUDIO_SUFFIXES} - {DEFAULT_VOICE})

    def _reference(self, voice_id: str) -> Path | None:
        for suffix in AUDIO_SUFFIXES:
            path = self.voices_dir / f"{voice_id}{suffix}"
            if path.is_file():
                return path
        return None

    def _index(self) -> dict[str, dict[str, str]]:
        try:
            return json.loads((self.voices_dir / "voices.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _write_index(self, index: dict[str, dict[str, str]]) -> None:
        (self.voices_dir / "voices.json").write_text(json.dumps(index, indent=2, ensure_ascii=False), encoding="utf-8")

    def _unique_id(self, name: str) -> str:
        base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or "voce"
        if base == DEFAULT_VOICE:
            base = "voce"
        voice_id, n = base, 2
        while self._reference(voice_id) is not None:
            voice_id, n = f"{base}-{n}", n + 1
        return voice_id

    def _check_language(self, language: str) -> str:
        code = (language or "it").strip().lower()[:2]
        if code not in self.supported_languages:
            raise ValueError(f"Chatterbox non parla {language!r}. Lingue: {', '.join(sorted(self.supported_languages))}")
        return code


def _checkpoint_dir() -> Path:
    """I pesi dalla cache locale; scaricati da Hugging Face solo la prima volta."""
    from chatterbox.mtl_tts import REPO_ID
    from huggingface_hub import snapshot_download

    files = ["ve.pt", "t3_mtl23ls_v2.safetensors", "s3gen.pt", "grapheme_mtl_merged_expanded_v1.json", "conds.pt", "Cangjie5_TC.json"]
    try:
        return Path(snapshot_download(repo_id=REPO_ID, allow_patterns=files, local_files_only=True))
    except Exception:
        logger.info("Scarico i pesi di Chatterbox (circa 3 GB, solo la prima volta)")
        return Path(snapshot_download(repo_id=REPO_ID, allow_patterns=files))
