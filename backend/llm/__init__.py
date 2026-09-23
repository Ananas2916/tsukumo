"""Factory dei client LLM."""

from __future__ import annotations

import json
import logging
from pathlib import Path

from ..config import Settings
from ..providers import LLM_REGISTRY
from .base import LLMClient, Message
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
    "create_llm_client",
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


def create_llm_client(settings: Settings) -> LLMClient:
    """Istanzia il backend LLM indicato da ``DC_LLM_BACKEND``.

    Il nome viene normalizzato dal registro dei provider, quindi gli alias
    storici (``lmstudio``, ``claude``, ``offline``, ...) continuano a valere.
    """
    backend = LLM_REGISTRY.resolve(settings.llm_backend) or (settings.llm_backend or "ollama").lower()

    if backend == "mock":
        logger.info("Backend LLM: mock (offline)")
        return MockLLM()

    if backend in _OPENAI_COMPATIBLE_CLOUD:
        options = settings.provider_config("llm", backend)
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
            temperature=float(options.get("TEMPERATURE", settings.temperature)),
            api_key=api_key,
            timeout=settings.openai_timeout,
        )

    if backend == "anthropic":
        from .anthropic import AnthropicClient

        options = settings.provider_config("llm", "anthropic")
        api_key = str(options.get("ANTHROPIC_API_KEY", "") or "")
        if not api_key:
            raise RuntimeError(
                "Manca la chiave API di Anthropic. Impostala nel pannello "
                "oppure con DC_ANTHROPIC_API_KEY."
            )
        logger.info("Backend LLM: anthropic (%s)", options.get("ANTHROPIC_MODEL"))
        return AnthropicClient(
            api_key=api_key,
            model=str(options.get("ANTHROPIC_MODEL", "")),
            base_url=str(options.get("ANTHROPIC_BASE_URL", "")).rstrip("/"),
            max_tokens=int(float(options.get("ANTHROPIC_MAX_TOKENS", 1024))),
            temperature=float(options.get("TEMPERATURE", settings.temperature)),
        )

    if backend == "gemini":
        from .gemini import GeminiClient

        options = settings.provider_config("llm", "gemini")
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
            temperature=float(options.get("TEMPERATURE", settings.temperature)),
        )

    if backend == "ollama":
        logger.info("Backend LLM: ollama (%s @ %s)", settings.ollama_model, settings.ollama_url)
        return OllamaClient(
            base_url=settings.ollama_url,
            model=settings.ollama_model,
            temperature=settings.temperature,
            timeout=settings.ollama_timeout,
        )

    if backend == "openai":
        # LM Studio, llama.cpp server, vLLM: gli alias li ha gia' normalizzati
        # il registro, e parlano tutti la stessa API.
        logger.info(
            "Backend LLM: openai-compatible (%s @ %s)",
            settings.openai_model,
            settings.openai_base_url,
        )
        return OpenAICompatibleClient(
            base_url=settings.openai_base_url,
            model=settings.openai_model,
            temperature=settings.temperature,
            api_key=settings.openai_api_key or None,
            timeout=settings.openai_timeout,
        )

    if backend == "openclaw":
        token = settings.openclaw_token or _read_openclaw_token()
        if not token:
            raise RuntimeError(
                "Token OpenClaw non trovato. Imposta DC_OPENCLAW_TOKEN oppure "
                f"assicurati che {_DEFAULT_OPENCLAW_CONFIG} contenga gateway.auth.token."
            )
        logger.info(
            "Backend LLM: openclaw (agente %r @ %s)", settings.openclaw_agent_id, settings.openclaw_url
        )
        return OpenClawClient(
            gateway_url=settings.openclaw_url,
            token=token,
            agent_id=settings.openclaw_agent_id,
            session_state_path=settings.openclaw_session_state,
        )

    raise ValueError(f"Backend LLM sconosciuto: {settings.llm_backend!r}")
