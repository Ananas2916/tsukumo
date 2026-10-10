"""Tsukumo's centralized configuration.

Every parameter can be overridden with an environment variable prefixed
``DC_`` (e.g. ``DC_PORT=9000``) or by writing a ``.env`` file in the
project's root (see ``.env.example``).
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import __version__
from . import provider_specs  # noqa: F401  (the import fills the registries)
from .languages import system_language
from .providers import REGISTRIES
from .security import clean_env_value

# The project's root: .../desk-companion
ROOT = Path(__file__).resolve().parent.parent
#: The keys the panel can write in the .env.
_ENV_KEY = re.compile(r"DC_[A-Z0-9_]{1,64}")


def env_file() -> Path:
    """The settings file: the project's ``.env``, or ``DC_ENV_FILE``.

    The installed app keeps it among the user's data (see electron/main.js): the
    app's resources are replaced at every update.
    """
    override = os.environ.get("DC_ENV_FILE")
    return Path(override) if override else ROOT / ".env"


def load_dotenv(path: Path | None = None) -> None:
    """Loads a very simple ``.env`` file (KEY=VALUE) into the env vars.

    Variables already in the environment take precedence, so the file can
    always be overridden from the command line.
    """
    path = path or env_file()
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
    """Writes ``DC_KEY=value`` pairs in the ``.env`` file, keeping the rest.

    Existing lines are updated in place and comments stay where they are: the
    file stays the one the user wrote by hand, with the panel's changes inside.
    New keys go at the end.

    An empty value **removes** the line, so you go back to the default instead
    of forcing an empty string.
    """
    path = path or env_file()
    for key in updates:
        if not _ENV_KEY.fullmatch(key):
            raise ValueError(f"Invalid variable name: {key!r}")
    # A newline in the value would write one more line (one more variable).
    updates = {key: clean_env_value(value) for key, value in updates.items()}
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
            if value:  # empty = back to the default, so we remove the line
                output.append(f"{key}={value}")
        else:
            output.append(raw_line)

    new_keys = {key: value for key, value in remaining.items() if value}
    if new_keys:
        if output and output[-1].strip():
            output.append("")
        output.append("# --- Written by the panel ---------------------------------------")
        output.extend(f"{key}={value}" for key, value in new_keys.items())

    path.write_text("\n".join(output) + "\n", encoding="utf-8")

    # The process environment must be aligned too, or a later from_env() would
    # read the old values again (load_dotenv uses setdefault).
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
    """Reads from the environment every field declared by the registered providers.

    So a new engine doesn't need a dedicated attribute on ``Settings``: it's
    enough that it declares its fields in ``provider_specs``.
    """
    values: dict[str, str] = {}
    for registry in REGISTRIES.values():
        for spec in registry.all():
            for spec_field in spec.fields:
                raw = os.environ.get(f"DC_{spec_field.env}")
                if raw is not None:
                    values[spec_field.env] = raw
    return values


# The reply's language isn't here: the pipeline adds it at every turn (see
# languages.speech_directive), so it follows the chosen voice.
# Name and character aren't here: the user chooses them in the panel and
# they hold for every brain (see backend/memory.py).
DEFAULT_SYSTEM_PROMPT = (
    "You are a small 3D character living on the user's desktop. Reply with at "
    "most three short sentences of plain text: no markdown, no bullet points, no "
    "emoji, no code blocks, because everything you write is read aloud by a "
    "speech synthesizer."
)


@dataclass
class Settings:
    """All the application's runtime parameters."""

    # --- Server -------------------------------------------------------------
    host: str = "127.0.0.1"
    port: int = 8770
    log_level: str = "info"
    #: Extra origins (besides the backend itself) that may use the API and WebSocket.
    #: Empty by default: see backend/security.py.
    cors_origins: list[str] = field(default_factory=list)
    #: Extra names accepted in the Host header (for a proxy like ``tailscale serve``).
    allowed_hosts: list[str] = field(default_factory=list)

    # --- LLM ----------------------------------------------------------------
    # "ollama" = local LLM via Ollama
    # "openai" = any local server with an OpenAI-style API
    #            (LM Studio, llama.cpp server, vLLM, text-generation-webui, ...)
    # "mock"   = built-in offline answerer, no model needed
    llm_backend: str = "ollama"
    ollama_url: str = "http://127.0.0.1:11434"
    ollama_model: str = "llama3.2"
    ollama_timeout: float = 120.0
    # LM Studio exposes its API on 1234 by default (Developer tab -> Start Server).
    openai_base_url: str = "http://127.0.0.1:1234/v1"
    # "auto" = use the first model the server has already loaded.
    openai_model: str = "auto"
    openai_api_key: str = ""
    openai_timeout: float = 120.0
    temperature: float = 0.7
    system_prompt: str = DEFAULT_SYSTEM_PROMPT
    history_turns: int = 12
    # If the brain doesn't answer, answering with canned sentences hides the
    # problem ("Hi! What shall we do today?" instead of an error): by default
    # the error is shown, with the reason and how to fix it.
    llm_fallback_to_mock: bool = False

    # --- TTS ----------------------------------------------------------------
    # "kokoro"      = kokoro-onnx in-process (default, all local)
    # "kokoro_http" = a Kokoro-FastAPI server already started (OpenAI-compatible API)
    # "formant"     = built-in vowel synthesizer, to test without weights
    tts_engine: str = "kokoro"
    tts_fallback_to_formant: bool = True
    kokoro_model_path: Path = ROOT / "models" / "kokoro-v1.0.onnx"
    kokoro_voices_path: Path = ROOT / "models" / "voices-v1.0.bin"
    kokoro_http_url: str = "http://127.0.0.1:8880"
    voice: str = "af_heart"
    #: ``DC_VOICE`` is written in the .env or the environment: it wins over the system's language.
    voice_explicit: bool = False
    #: The operating system's interface language (``it``): if nobody chose a
    #: voice, we start with a voice in this language.
    system_language: str = "en"
    speech_speed: float = 1.0
    # The phonemizer's language if the voice doesn't already say it with its name.
    language: str = "en-us"
    # Which language she answers in: "auto" = the voice's, "same" = the one you
    # write in, or a specific language ("English", "it", ...).
    reply_language: str = "auto"
    max_sentence_chars: int = 220

    # --- STT (voice input) --------------------------------------------------
    # "none" = keyboard only. See provider_specs for the available engines.
    stt_engine: str = "none"
    # "push" = push to talk, "vad" = always listening, "wake" = wake word.
    voice_mode: str = "push"
    # Global key for push-to-talk (Electron accelerator syntax).
    push_to_talk_key: str = "Control+Space"
    # Wake word for voice_mode="wake".
    wake_word: str = "companion"
    # How much silence (seconds) ends the sentence when always listening.
    vad_silence: float = 0.8
    # Below this energy threshold the microphone counts as mute (0-1).
    vad_threshold: float = 0.02
    # Interrupt the companion's voice if the user starts talking.
    voice_interrupt: bool = True

    # --- Engine state -------------------------------------------------------
    # How many seconds between checks that brain and voice answer (the light in
    # the panel and the rings beside the character).
    status_interval: float = 10.0
    # At startup it looks for the installed brains (Claude Code, Codex,
    # OpenClaw, Ollama, LM Studio). If DC_LLM_BACKEND isn't set it uses the first.
    detect_engines: bool = True
    # Spontaneous comments (late hour, weather, battery, YouTube, news...): how
    # much and about what is chosen in the panel; this turns them off entirely.
    proactive: bool = True
    # Agent sessions (OpenClaw, Claude Code, Codex): they survive restarts, so
    # the conversation picks up where it left off.
    state_dir: Path = ROOT / "state"

    # --- Lip-sync -----------------------------------------------------------
    viseme_gain: float = 1.15
    viseme_silence_threshold: float = 0.07
    viseme_hop: float = 0.01

    # --- Frontend -----------------------------------------------------------
    frontend_dist: Path = ROOT / "frontend" / "dist"

    # --- Providers ----------------------------------------------------------
    # Raw values of the fields declared in provider_specs, read from the
    # environment. Key = the variable's suffix (``OLLAMA_MODEL``), not the full name.
    provider_options: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_env(cls) -> "Settings":
        load_dotenv()
        origins = _env("CORS_ORIGINS", "")
        hosts = _env("ALLOWED_HOSTS", "")
        return cls(
            host=_env("HOST", "127.0.0.1"),
            port=_env_int("PORT", 8770),
            log_level=_env("LOG_LEVEL", "info"),
            cors_origins=[o.strip() for o in origins.split(",") if o.strip()],
            allowed_hosts=[h.strip() for h in hosts.split(",") if h.strip()],
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
            voice_explicit=bool(os.environ.get("DC_VOICE", "").strip()),
            system_language=system_language(),
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
            proactive=_env_bool("PROACTIVE", True),
            state_dir=_env_path("STATE_DIR", ROOT / "state"),
            viseme_gain=_env_float("VISEME_GAIN", 1.15),
            viseme_silence_threshold=_env_float("VISEME_SILENCE", 0.07),
            viseme_hop=_env_float("VISEME_HOP", 0.01),
            frontend_dist=_env_path("FRONTEND_DIST", ROOT / "frontend" / "dist"),
            provider_options=_collect_provider_options(),
        )

    # --- Access to the providers' fields ------------------------------------

    #: For each kind, the attribute that says which provider is active.
    _SELECTED_ATTR = {"llm": "llm_backend", "tts": "tts_engine", "stt": "stt_engine"}

    def selected(self, kind: str) -> str:
        """Id of the active provider for ``kind`` ("llm", "tts", "stt")."""
        return getattr(self, self._SELECTED_ATTR[kind], "") or ""

    def option(self, env: str, default: Any = "") -> Any:
        """Value of a field declared in ``provider_specs``."""
        return self.provider_options.get(env, default)

    def provider_config(self, kind: str, provider_id: str | None = None) -> dict[str, Any]:
        """All the fields of the given provider, with the schema's defaults.

        The values are the real ones, secrets included: it's meant for the
        factories, not to be sent to the frontend (for that there's
        ``provider_public``).
        """
        registry = REGISTRIES[kind]
        spec = registry.get(provider_id or self.selected(kind))
        if spec is None:
            return {}
        return {f.env: self.provider_options.get(f.env, f.default) for f in spec.fields}

    def provider_public(self, kind: str) -> dict[str, Any]:
        """Like ``provider_config`` but with the secrets reduced to a boolean.

        The panel must be able to show "key set" without the key ever crossing the
        network.
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
        """Safe subset to expose to the frontend (no absolute paths)."""
        return {
            "llmBackend": self.llm_backend,
            "ollamaModel": self.ollama_model,
            "openaiModel": self.openai_model,
            "ttsEngine": self.tts_engine,
            "voice": self.voice,
            "speed": self.speech_speed,
            "language": self.language,
            "systemLanguage": self.system_language,
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
