"""Factory dei client LLM e degli agenti."""

from __future__ import annotations

import json
import logging
from pathlib import Path

from ..config import Settings
from ..providers import LLM_REGISTRY
from .base import LLMClient, Message, describe_error
from .cli_agents import ClaudeCodeClient, CodexClient, CommandAgentClient
from .mock import MockLLM
from .ollama import OllamaClient
from .openai_compatible import OpenAICompatibleClient
from .openclaw import OpenClawClient

logger = logging.getLogger(__name__)

__all__ = [
    "LLMClient",
    "Message",
    "MockLLM",
    "OllamaClient",
    "OpenAICompatibleClient",
    "OpenClawClient",
    "ClaudeCodeClient",
    "CodexClient",
    "CommandAgentClient",
    "create_llm_client",
    "describe_error",
]

#: Percorso di default del file di configurazione di OpenClaw sull'account
#: dell'utente: e' li' che vive il token del Gateway, se non lo passi a mano.
_DEFAULT_OPENCLAW_CONFIG = Path.home() / ".openclaw" / "openclaw.json"


def _read_openclaw_token() -> str:
    """Legge ``gateway.auth.token`` dal config di OpenClaw dell'utente.

    E' una comodita': se non imposti ``DC_OPENCLAW_TOKEN`` a mano, il backend
    prova a leggerlo da dove OpenClaw lo tiene gia'. Non solleva mai: se il
    file manca o e' malformato, il chiamante ricevera' un token vuoto e un
    errore chiaro al primo tentativo di connessione.
    """
    try:
        config = json.loads(_DEFAULT_OPENCLAW_CONFIG.read_text(encoding="utf-8"))
        return config["gateway"]["auth"]["token"]
    except (OSError, KeyError, json.JSONDecodeError) as exc:
        logger.warning("Token OpenClaw non leggibile da %s (%s)", _DEFAULT_OPENCLAW_CONFIG, exc)
        return ""


#: Servizi cloud che parlano l'API OpenAI: cambia solo l'indirizzo, quindi
#: riusano lo stesso client. I nomi dei campi seguono lo schema dichiarato in
#: ``provider_specs`` (``<ID>_API_KEY``, ``<ID>_MODEL``, ``<ID>_BASE_URL``).
_OPENAI_COMPATIBLE_CLOUD = {"groq", "openrouter", "deepseek", "mistral", "together"}


def _number(value: object, default: float) -> float:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def create_llm_client(settings: Settings, backend: str | None = None) -> LLMClient:
    """Istanzia il motore indicato da ``DC_LLM_BACKEND`` (o da ``backend``).

    Il nome viene normalizzato dal registro dei provider, quindi gli alias
    storici (``lmstudio``, ``claude``, ``offline``, ...) continuano a valere.
    """
    requested = backend or settings.llm_backend
    backend = LLM_REGISTRY.resolve(requested) or (requested or "ollama").lower()
    options = settings.provider_config("llm", backend)
    state = settings.state_dir

    if backend == "mock":
        logger.info("Backend LLM: mock (offline)")
        return MockLLM()

    if backend in _OPENAI_COMPATIBLE_CLOUD:
        prefix = backend.upper()
        api_key = str(options.get(f"{prefix}_API_KEY", "") or "")
        if not api_key:
            raise RuntimeError(
                f"Manca la chiave API di {backend}. Impostala nel pannello "
                f"oppure con DC_{prefix}_API_KEY."
            )
        base_url = str(options.get(f"{prefix}_BASE_URL", "")).rstrip("/")
        model = str(options.get(f"{prefix}_MODEL", ""))
        logger.info("Backend LLM: %s (%s @ %s)", backend, model, base_url)
        return OpenAICompatibleClient(
            base_url=base_url,
            model=model,
            temperature=_number(options.get("TEMPERATURE"), settings.temperature),
            api_key=api_key,
            timeout=settings.openai_timeout,
            name=backend,
        )

    if backend == "anthropic":
        from .anthropic import AnthropicClient

        api_key = str(options.get("ANTHROPIC_API_KEY", "") or "")
        if not api_key:
            raise RuntimeError(
                "Manca la chiave API di Anthropic. Impostala nel pannello "
                "oppure con DC_ANTHROPIC_API_KEY."
            )
        logger.info("Backend LLM: anthropic (%s)", options.get("ANTHROPIC_MODEL"))
        return AnthropicClient(
            api_key=api_key,
            model=str(options.get("ANTHROPIC_MODEL") or "claude-opus-5"),
            base_url=str(options.get("ANTHROPIC_BASE_URL", "")).rstrip("/"),
            max_tokens=int(_number(options.get("ANTHROPIC_MAX_TOKENS"), 1024)),
        )

    if backend == "gemini":
        from .gemini import GeminiClient

        api_key = str(options.get("GEMINI_API_KEY", "") or "")
        if not api_key:
            raise RuntimeError(
                "Manca la chiave API di Gemini. Impostala nel pannello "
                "oppure con DC_GEMINI_API_KEY."
            )
        logger.info("Backend LLM: gemini (%s)", options.get("GEMINI_MODEL"))
        return GeminiClient(
            api_key=api_key,
            model=str(options.get("GEMINI_MODEL", "")),
            base_url=str(options.get("GEMINI_BASE_URL", "")).rstrip("/"),
            temperature=_number(options.get("TEMPERATURE"), settings.temperature),
        )

    if backend == "ollama":
        url = str(options.get("OLLAMA_URL") or settings.ollama_url).rstrip("/")
        model = str(options.get("OLLAMA_MODEL") or settings.ollama_model)
        logger.info("Backend LLM: ollama (%s @ %s)", model, url)
        return OllamaClient(
            base_url=url,
            model=model,
            temperature=_number(options.get("TEMPERATURE"), settings.temperature),
            timeout=_number(options.get("OLLAMA_TIMEOUT"), settings.ollama_timeout),
        )

    if backend == "openai":
        # LM Studio, llama.cpp server, vLLM: gli alias li ha gia' normalizzati
        # il registro, e parlano tutti la stessa API.
        url = str(options.get("OPENAI_BASE_URL") or settings.openai_base_url).rstrip("/")
        model = str(options.get("OPENAI_MODEL") or settings.openai_model)
        logger.info("Backend LLM: openai-compatible (%s @ %s)", model, url)
        return OpenAICompatibleClient(
            base_url=url,
            model=model,
            temperature=_number(options.get("TEMPERATURE"), settings.temperature),
            api_key=str(options.get("OPENAI_API_KEY") or "") or None,
            timeout=_number(options.get("OPENAI_TIMEOUT"), settings.openai_timeout),
        )

    if backend == "hermes":
        # Hermes Agent con l'API server attivo parla /v1/chat/completions: per
        # il companion e' un server OpenAI come gli altri.
        base_url = str(options.get("HERMES_BASE_URL") or "http://127.0.0.1:8642/v1").rstrip("/")
        logger.info("Backend LLM: Hermes Agent @ %s", base_url)
        return OpenAICompatibleClient(
            base_url=base_url,
            model=str(options.get("HERMES_MODEL") or "hermes-agent"),
            temperature=settings.temperature,
            api_key=str(options.get("HERMES_API_KEY") or "") or None,
            timeout=_number(options.get("HERMES_TIMEOUT"), 300.0),
            name="hermes",
            hint="Avvia Hermes con l'API server attivo: API_SERVER_ENABLED=true, poi `hermes gateway`.",
        )

    if backend == "openclaw":
        token = str(options.get("OPENCLAW_TOKEN") or "") or _read_openclaw_token()
        if not token:
            raise RuntimeError(
                "Token OpenClaw non trovato. Imposta DC_OPENCLAW_TOKEN oppure "
                f"assicurati che {_DEFAULT_OPENCLAW_CONFIG} contenga gateway.auth.token."
            )
        url = str(options.get("OPENCLAW_URL") or "http://127.0.0.1:18789")
        agent = str(options.get("OPENCLAW_AGENT_ID") or "main")
        logger.info("Backend LLM: openclaw (agente %r @ %s)", agent, url)
        return OpenClawClient(
            gateway_url=url,
            token=token,
            agent_id=agent,
            session_state_path=state / "openclaw_session.json",
        )

    if backend == "claude_code":
        client = ClaudeCodeClient(
            command=str(options.get("CLAUDE_CODE_COMMAND") or "claude"),
            model=str(options.get("CLAUDE_CODE_MODEL") or ""),
            cwd=str(options.get("CLAUDE_CODE_CWD") or ""),
            allowed_tools=str(options.get("CLAUDE_CODE_TOOLS") or ""),
            permission_mode=str(options.get("CLAUDE_CODE_PERMISSION") or "default"),
            timeout=_number(options.get("CLAUDE_CODE_TIMEOUT"), 300.0),
            session_path=state / "claude_code_session.json",
        )
        logger.info("Backend LLM: Claude Code (%s)", client.executable or "non trovato")
        return client

    if backend == "codex":
        client = CodexClient(
            command=str(options.get("CODEX_COMMAND") or ""),
            model=str(options.get("CODEX_MODEL") or ""),
            cwd=str(options.get("CODEX_CWD") or ""),
            sandbox=str(options.get("CODEX_SANDBOX") or "read-only"),
            timeout=_number(options.get("CODEX_TIMEOUT"), 300.0),
            session_path=state / "codex_session.json",
        )
        logger.info("Backend LLM: Codex (%s)", client.executable or "non trovato")
        return client

    if backend == "command":
        command = str(options.get("AGENT_COMMAND") or "")
        if not command.strip():
            raise RuntimeError("Scrivi nel pannello il comando da lanciare (per esempio: hermes chat -q {prompt}).")
        logger.info("Backend LLM: comando %r", command)
        return CommandAgentClient(
            command=command,
            cwd=str(options.get("AGENT_CWD") or ""),
            timeout=_number(options.get("AGENT_TIMEOUT"), 300.0),
        )

    raise ValueError(f"Backend LLM sconosciuto: {requested!r}")
