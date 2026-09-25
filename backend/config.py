"""Configurazione centralizzata di Tsukumo.

Ogni parametro puo' essere sovrascritto tramite variabile d'ambiente con
prefisso ``DC_`` (es. ``DC_PORT=9000``) oppure scrivendo un file ``.env``
nella root del progetto (vedi ``.env.example``).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import __version__
from . import provider_specs  # noqa: F401  (l'import popola i registri)
from .providers import REGISTRIES

# Root del progetto: .../desk-companion
ROOT = Path(__file__).resolve().parent.parent


def load_dotenv(path: Path | None = None) -> None:
    """Carica un file ``.env`` molto semplice (KEY=VALUE) nelle env vars.

    Le variabili gia' presenti nell'ambiente hanno la precedenza, cosi' e'
    sempre possibile sovrascrivere il file da riga di comando.
    """
    path = path or (ROOT / ".env")
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def save_dotenv(updates: dict[str, str], path: Path | None = None) -> Path:
    """Scrive coppie ``DC_CHIAVE=valore`` nel file ``.env``, preservando il resto.

    Le righe esistenti vengono aggiornate al loro posto e i commenti restano
    dove sono: il file resta quello che l'utente ha scritto a mano, con dentro
    le modifiche fatte dal pannello. Le chiavi nuove finiscono in fondo.

    Un valore vuoto **rimuove** la riga, cosi' si torna al default invece di
    imporre una stringa vuota.
    """
    path = path or (ROOT / ".env")
    lines = path.read_text(encoding="utf-8").splitlines() if path.is_file() else []
    remaining = dict(updates)
    output: list[str] = []

    for raw_line in lines:
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            output.append(raw_line)
            continue
        key = stripped.partition("=")[0].strip()
        if key in remaining:
            value = remaining.pop(key)
            if value:  # vuoto = torna al default, quindi togliamo la riga
                output.append(f"{key}={value}")
        else:
            output.append(raw_line)

    new_keys = {key: value for key, value in remaining.items() if value}
    if new_keys:
        if output and output[-1].strip():
            output.append("")
        output.append("# --- Scritto dal pannello -------------------------------------")
        output.extend(f"{key}={value}" for key, value in new_keys.items())

    path.write_text("\n".join(output) + "\n", encoding="utf-8")

    # L'ambiente del processo va allineato, o un successivo from_env()
    # rileggerebbe i valori vecchi (load_dotenv usa setdefault).
    for key, value in updates.items():
        if value:
            os.environ[key] = value
        else:
            os.environ.pop(key, None)
    return path


def _env(key: str, default: str) -> str:
    return os.environ.get(f"DC_{key}", default)


def _env_int(key: str, default: int) -> int:
    try:
        return int(_env(key, str(default)))
    except ValueError:
        return default


def _env_float(key: str, default: float) -> float:
    try:
        return float(_env(key, str(default)))
    except ValueError:
        return default


def _env_bool(key: str, default: bool) -> bool:
    value = _env(key, "1" if default else "0").strip().lower()
    return value in {"1", "true", "yes", "on"}


def _env_path(key: str, default: Path) -> Path:
    raw = os.environ.get(f"DC_{key}")
    if not raw:
        return default
    candidate = Path(raw).expanduser()
    return candidate if candidate.is_absolute() else (ROOT / candidate)


def _collect_provider_options() -> dict[str, str]:
    """Legge dall'ambiente ogni campo dichiarato dai provider registrati.

    Cosi' un motore nuovo non richiede un attributo dedicato su ``Settings``:
    basta che dichiari i suoi campi in ``provider_specs``.
    """
    values: dict[str, str] = {}
    for registry in REGISTRIES.values():
        for spec in registry.all():
            for spec_field in spec.fields:
                raw = os.environ.get(f"DC_{spec_field.env}")
                if raw is not None:
                    values[spec_field.env] = raw
    return values


# La lingua della risposta non sta qui: la aggiunge il pipeline a ogni turno
# (vedi languages.speech_directive), cosi' segue la voce scelta.
DEFAULT_SYSTEM_PROMPT = (
    "You are Tsukumo, a small 3D character living on the user's desktop. "
    "You are warm, concise and a little playful. Reply with at most three short "
    "sentences of plain text: no markdown, no bullet points, no emoji, no code "
    "blocks, because everything you write is read aloud by a speech synthesizer."
)


@dataclass
class Settings:
    """Tutti i parametri runtime dell'applicazione."""

    # --- Server -----------------------------------------------------------
    host: str = "127.0.0.1"
    port: int = 8770
    log_level: str = "info"
    cors_origins: list[str] = field(default_factory=lambda: ["*"])

    # --- LLM --------------------------------------------------------------
    # "ollama" = LLM locale via Ollama
    # "openai" = qualunque server locale con API stile OpenAI
    #            (LM Studio, llama.cpp server, vLLM, text-generation-webui, ...)
    # "mock"   = risponditore offline integrato, nessun modello richiesto
    llm_backend: str = "ollama"
    ollama_url: str = "http://127.0.0.1:11434"
    ollama_model: str = "llama3.2"
    ollama_timeout: float = 120.0
    # LM Studio espone la sua API sulla 1234 di default (tab Developer -> Start Server).
    openai_base_url: str = "http://127.0.0.1:1234/v1"
    # "auto" = usa il primo modello che il server ha gia' caricato.
    openai_model: str = "auto"
    openai_api_key: str = ""
    openai_timeout: float = 120.0
    temperature: float = 0.7
    system_prompt: str = DEFAULT_SYSTEM_PROMPT
    history_turns: int = 12
    # Se il cervello non risponde, rispondere con frasi preconfezionate
    # nasconde il problema ("Ciao! Che si fa oggi?" al posto di un errore):
    # di default si mostra l'errore, con il motivo e come rimediare.
    llm_fallback_to_mock: bool = False

    # --- TTS --------------------------------------------------------------
    # "kokoro"      = kokoro-onnx in-process (default, tutto locale)
    # "kokoro_http" = server Kokoro-FastAPI gia' avviato (API OpenAI-compatible)
    # "formant"     = sintetizzatore di vocali integrato, per testare senza pesi
    tts_engine: str = "kokoro"
    tts_fallback_to_formant: bool = True
    kokoro_model_path: Path = ROOT / "models" / "kokoro-v1.0.onnx"
    kokoro_voices_path: Path = ROOT / "models" / "voices-v1.0.bin"
    kokoro_http_url: str = "http://127.0.0.1:8880"
    voice: str = "af_heart"
    speech_speed: float = 1.0
    # Lingua del phonemizer se la voce non la dice gia' col suo nome.
    language: str = "en-us"
    # In che lingua risponde: "auto" = quella della voce, "same" = quella in
    # cui scrivi, oppure una lingua precisa ("English", "it", ...).
    reply_language: str = "auto"
    max_sentence_chars: int = 220

    # --- STT (input vocale) -------------------------------------------------
    # "none" = solo tastiera. Vedi provider_specs per i motori disponibili.
    stt_engine: str = "none"
    # "push" = premi e parla, "vad" = sempre in ascolto, "wake" = a chiamata.
    voice_mode: str = "push"
    # Tasto globale per il push-to-talk (sintassi acceleratori di Electron).
    push_to_talk_key: str = "Control+Space"
    # Parola di attivazione per voice_mode="wake".
    wake_word: str = "companion"
    # Quanto silenzio (secondi) chiude la frase quando si e' sempre in ascolto.
    vad_silence: float = 0.8
    # Sotto questa soglia di energia il microfono e' considerato muto (0-1).
    vad_threshold: float = 0.02
    # Interrompi la voce del companion se l'utente inizia a parlare.
    voice_interrupt: bool = True

    # --- Stato dei motori ---------------------------------------------------
    # Ogni quanti secondi controllare che cervello e voce rispondano (la spia
    # nel pannello e gli anelli accanto al personaggio).
    status_interval: float = 10.0
    # All'avvio cerca i cervelli installati (Claude Code, Codex, OpenClaw,
    # Ollama, LM Studio). Se DC_LLM_BACKEND non e' impostato usa il primo.
    detect_engines: bool = True
    # Sessioni degli agenti (OpenClaw, Claude Code, Codex): sopravvivono ai
    # riavvii, cosi' la conversazione riprende da dove era rimasta.
    state_dir: Path = ROOT / "state"

    # --- Lip-sync ---------------------------------------------------------
    viseme_gain: float = 1.15
    viseme_silence_threshold: float = 0.07
    viseme_hop: float = 0.01

    # --- Frontend ---------------------------------------------------------
    frontend_dist: Path = ROOT / "frontend" / "dist"
    avatar_dir: Path = ROOT / "frontend" / "public" / "models"

    # --- Provider -----------------------------------------------------------
    # Valori grezzi dei campi dichiarati in provider_specs, letti dall'ambiente.
    # Chiave = suffisso della variabile (``OLLAMA_MODEL``), non il nome completo.
    provider_options: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_env(cls) -> "Settings":
        load_dotenv()
        origins = _env("CORS_ORIGINS", "*")
        return cls(
            host=_env("HOST", "127.0.0.1"),
            port=_env_int("PORT", 8770),
            log_level=_env("LOG_LEVEL", "info"),
            cors_origins=[o.strip() for o in origins.split(",") if o.strip()],
            llm_backend=_env("LLM_BACKEND", "ollama").lower(),
            ollama_url=_env("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/"),
            ollama_model=_env("OLLAMA_MODEL", "llama3.2"),
            ollama_timeout=_env_float("OLLAMA_TIMEOUT", 120.0),
            openai_base_url=_env("OPENAI_BASE_URL", "http://127.0.0.1:1234/v1").rstrip("/"),
            openai_model=_env("OPENAI_MODEL", "auto"),
            openai_api_key=_env("OPENAI_API_KEY", ""),
            openai_timeout=_env_float("OPENAI_TIMEOUT", 120.0),
            temperature=_env_float("TEMPERATURE", 0.7),
            system_prompt=_env("SYSTEM_PROMPT", DEFAULT_SYSTEM_PROMPT),
            history_turns=_env_int("HISTORY_TURNS", 12),
            llm_fallback_to_mock=_env_bool("LLM_FALLBACK", False),
            tts_engine=_env("TTS_ENGINE", "kokoro").lower(),
            tts_fallback_to_formant=_env_bool("TTS_FALLBACK", True),
            kokoro_model_path=_env_path("KOKORO_MODEL", ROOT / "models" / "kokoro-v1.0.onnx"),
            kokoro_voices_path=_env_path("KOKORO_VOICES", ROOT / "models" / "voices-v1.0.bin"),
            kokoro_http_url=_env("KOKORO_HTTP_URL", "http://127.0.0.1:8880").rstrip("/"),
            voice=_env("VOICE", "af_heart"),
            speech_speed=_env_float("SPEED", 1.0),
            language=_env("LANGUAGE", "en-us"),
            reply_language=_env("REPLY_LANGUAGE", "auto"),
            max_sentence_chars=_env_int("MAX_SENTENCE_CHARS", 220),
            stt_engine=_env("STT_ENGINE", "none").lower(),
            voice_mode=_env("VOICE_MODE", "push").lower(),
            push_to_talk_key=_env("PUSH_TO_TALK_KEY", "Control+Space"),
            wake_word=_env("WAKE_WORD", "companion"),
            vad_silence=_env_float("VAD_SILENCE", 0.8),
            vad_threshold=_env_float("VAD_THRESHOLD", 0.02),
            voice_interrupt=_env_bool("VOICE_INTERRUPT", True),
            status_interval=_env_float("STATUS_INTERVAL", 10.0),
            detect_engines=_env_bool("DETECT_ENGINES", True),
            state_dir=_env_path("STATE_DIR", ROOT / "state"),
            viseme_gain=_env_float("VISEME_GAIN", 1.15),
            viseme_silence_threshold=_env_float("VISEME_SILENCE", 0.07),
            viseme_hop=_env_float("VISEME_HOP", 0.01),
            frontend_dist=_env_path("FRONTEND_DIST", ROOT / "frontend" / "dist"),
            avatar_dir=_env_path("AVATAR_DIR", ROOT / "frontend" / "public" / "models"),
            provider_options=_collect_provider_options(),
        )

    # --- Accesso ai campi dei provider ------------------------------------

    #: Per ogni tipo, l'attributo che dice quale provider e' attivo.
    _SELECTED_ATTR = {"llm": "llm_backend", "tts": "tts_engine", "stt": "stt_engine"}

    def selected(self, kind: str) -> str:
        """Id del provider attivo per ``kind`` ("llm", "tts", "stt")."""
        return getattr(self, self._SELECTED_ATTR[kind], "") or ""

    def option(self, env: str, default: Any = "") -> Any:
        """Valore di un campo dichiarato in ``provider_specs``."""
        return self.provider_options.get(env, default)

    def provider_config(self, kind: str, provider_id: str | None = None) -> dict[str, Any]:
        """Tutti i campi del provider indicato, con i default dello schema.

        I valori sono quelli veri, segreti compresi: e' pensato per i factory,
        non per essere mandato al frontend (per quello c'e' ``provider_public``).
        """
        registry = REGISTRIES[kind]
        spec = registry.get(provider_id or self.selected(kind))
        if spec is None:
            return {}
        return {f.env: self.provider_options.get(f.env, f.default) for f in spec.fields}

    def provider_public(self, kind: str) -> dict[str, Any]:
        """Come ``provider_config`` ma con i segreti ridotti a un booleano.

        Il pannello deve poter mostrare "chiave impostata" senza che la chiave
        attraversi mai la rete.
        """
        registry = REGISTRIES[kind]
        spec = registry.get(self.selected(kind))
        if spec is None:
            return {}
        values: dict[str, Any] = {}
        for f in spec.fields:
            raw = self.provider_options.get(f.env, f.default)
            values[f.env] = bool(raw) if f.secret else raw
        return values

    def public_dict(self) -> dict[str, Any]:
        """Sottoinsieme sicuro da esporre al frontend (niente path assoluti)."""
        return {
            "llmBackend": self.llm_backend,
            "ollamaModel": self.ollama_model,
            "openaiModel": self.openai_model,
            "ttsEngine": self.tts_engine,
            "voice": self.voice,
            "speed": self.speech_speed,
            "language": self.language,
            "replyLanguage": self.reply_language,
            "visemeGain": self.viseme_gain,
            "sttEngine": self.stt_engine,
            "voiceMode": self.voice_mode,
            "pushToTalkKey": self.push_to_talk_key,
            "wakeWord": self.wake_word,
            "vadSilence": self.vad_silence,
            "vadThreshold": self.vad_threshold,
            "voiceInterrupt": self.voice_interrupt,
            "options": {
                "llm": self.provider_public("llm"),
                "tts": self.provider_public("tts"),
                "stt": self.provider_public("stt"),
            },
            "version": __version__,
            "app": "tsukumo",
        }
