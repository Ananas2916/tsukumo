"""Factory of the LLM clients and the agents."""

from __future__ import annotations

import json
import logging
from pathlib import Path

from ..config import Settings
from ..provider_specs import CLI_AGENT_PRESETS
from ..providers import LLM_REGISTRY
from .base import LLMClient, Message, describe_error
from .cli_agents import AntigravityClient, ClaudeCodeClient, CodexClient, CommandAgentClient
from .fallback import FallbackLLM
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
    "AntigravityClient",
    "ClaudeCodeClient",
    "CodexClient",
    "CommandAgentClient",
    "FallbackLLM",
    "create_chatter_llm",
    "create_llm_client",
    "describe_error",
]

#: Default path of OpenClaw's configuration file in the user's account:
#: that's where the Gateway token lives, if you don't pass it by hand.
_DEFAULT_OPENCLAW_CONFIG = Path.home() / ".openclaw" / "openclaw.json"


def _read_openclaw_token() -> str:
    """Reads ``gateway.auth.token`` from the user's OpenClaw config.

    It's a convenience: if you don't set ``DC_OPENCLAW_TOKEN`` by hand, the
    backend tries to read it from where OpenClaw already keeps it. It never
    raises: if the file is missing or malformed, the caller gets an empty token
    and a clear error at the first connection attempt.
    """
    try:
        config = json.loads(_DEFAULT_OPENCLAW_CONFIG.read_text(encoding="utf-8"))
        return config["gateway"]["auth"]["token"]
    except (OSError, KeyError, json.JSONDecodeError) as exc:
        logger.warning("OpenClaw token unreadable from %s (%s)", _DEFAULT_OPENCLAW_CONFIG, exc)
        return ""


#: Cloud services that speak the OpenAI API: only the address changes, so
#: they reuse the same client. The field names follow the schema declared in
#: ``provider_specs`` (``<ID>_API_KEY``, ``<ID>_MODEL``, ``<ID>_BASE_URL``).
_OPENAI_COMPATIBLE_CLOUD = {"groq", "openrouter", "deepseek", "mistral", "together"}


def _number(value: object, default: float) -> float:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def create_llm_client(
    settings: Settings,
    backend: str | None = None,
    overrides: dict[str, object] | None = None,
) -> LLMClient:
    """Instantiates the engine named by ``DC_LLM_BACKEND`` (or by ``backend``).

    The name is normalized by the provider registry, so the historical aliases
    (``lmstudio``, ``claude``, ``offline``, ...) still hold. ``overrides``
    replaces some saved fields (for example the model).
    """
    requested = backend or settings.llm_backend
    backend = LLM_REGISTRY.resolve(requested) or (requested or "ollama").lower()
    options = {**settings.provider_config("llm", backend), **(overrides or {})}
    state = settings.state_dir

    if backend == "mock":
        logger.info("Backend LLM: mock (offline)")
        return MockLLM()

    if backend in _OPENAI_COMPATIBLE_CLOUD:
        prefix = backend.upper()
        api_key = str(options.get(f"{prefix}_API_KEY", "") or "")
        if not api_key:
            raise RuntimeError(
                f"The {backend} API key is missing. Set it in the panel "
                f"or with DC_{prefix}_API_KEY."
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
                "The Anthropic API key is missing. Set it in the panel "
                "or with DC_ANTHROPIC_API_KEY."
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
                "The Gemini API key is missing. Set it in the panel "
                "or with DC_GEMINI_API_KEY."
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
        # LM Studio, llama.cpp server, vLLM: the registry has already normalized the
        # aliases, and they all speak the same API.
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
        # Hermes Agent with the API server on speaks /v1/chat/completions: for the
        # companion it's an OpenAI server like the others.
        base_url = str(options.get("HERMES_BASE_URL") or "http://127.0.0.1:8642/v1").rstrip("/")
        logger.info("Backend LLM: Hermes Agent @ %s", base_url)
        return OpenAICompatibleClient(
            base_url=base_url,
            model=str(options.get("HERMES_MODEL") or "hermes-agent"),
            temperature=settings.temperature,
            api_key=str(options.get("HERMES_API_KEY") or "") or None,
            timeout=_number(options.get("HERMES_TIMEOUT"), 300.0),
            name="hermes",
            hint="Start Hermes with the API server on: API_SERVER_ENABLED=true, then `hermes gateway`.",
        )

    if backend == "g4f":
        # gpt4free with `g4f api` is a local OpenAI server; the key is optional
        # (only with --g4f-api-key).
        base_url = str(options.get("G4F_BASE_URL") or "http://127.0.0.1:1337/v1").rstrip("/")
        model = str(options.get("G4F_MODEL") or "gemini-2.5-flash")
        logger.info("Backend LLM: gpt4free (%s @ %s)", model, base_url)
        return OpenAICompatibleClient(
            base_url=base_url,
            model=model,
            temperature=_number(options.get("TEMPERATURE"), settings.temperature),
            api_key=str(options.get("G4F_API_KEY") or "") or None,
            timeout=_number(options.get("G4F_TIMEOUT"), 60.0),
            name="g4f",
            hint='Start gpt4free: pip install -U "g4f[api]", then `g4f api --bind 127.0.0.1:1337 --no-gui`.',
        )

    if backend == "openclaw":
        token =str(options.get("OPENCLAW_TOKEN") or "") or _read_openclaw_token()
        if not token:
            raise RuntimeError(
                "OpenClaw token not found. Set DC_OPENCLAW_TOKEN or "
                f"make sure {_DEFAULT_OPENCLAW_CONFIG} contains gateway.auth.token."
            )
        url = str(options.get("OPENCLAW_URL") or "http://127.0.0.1:18789")
        agent = str(options.get("OPENCLAW_AGENT_ID") or "main")
        logger.info("Backend LLM: openclaw (agent %r @ %s)", agent, url)
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
        logger.info("Backend LLM: Claude Code (%s)", client.executable or "not found")
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
        logger.info("Backend LLM: Codex (%s)", client.executable or "not found")
        return client

    if backend == "antigravity":
        client = AntigravityClient(
            command=str(options.get("ANTIGRAVITY_COMMAND") or ""),
            model=str(options.get("ANTIGRAVITY_MODEL") or ""),
            cwd=str(options.get("ANTIGRAVITY_CWD") or ""),
            permission=str(options.get("ANTIGRAVITY_PERMISSION") or "default"),
            timeout=_number(options.get("ANTIGRAVITY_TIMEOUT"), 300.0),
            session_path=state / "antigravity_session.json",
        )
        logger.info("Backend LLM: Antigravity (%s)", client.executable or "not found")
        return client

    if backend in CLI_AGENT_PRESETS:
        # Cline, Gemini CLI, Cursor...: a ready-made command, editable from the panel.
        prefix = backend.upper()
        command = str(options.get(f"{prefix}_COMMAND") or CLI_AGENT_PRESETS[backend])
        spec = LLM_REGISTRY.get(backend)
        logger.info("Backend LLM: %s (%r)", backend, command)
        return CommandAgentClient(
            command=command,
            cwd=str(options.get(f"{prefix}_CWD") or ""),
            timeout=_number(options.get(f"{prefix}_TIMEOUT"), 300.0),
            name=backend,
            label=spec.label if spec else backend,
        )

    if backend == "command":
        command = str(options.get("AGENT_COMMAND") or "")
        if not command.strip():
            raise RuntimeError("Write in the panel the command to run (for example: hermes chat -q {prompt}).")
        logger.info("Backend LLM: command %r", command)
        return CommandAgentClient(
            command=command,
            cwd=str(options.get("AGENT_CWD") or ""),
            timeout=_number(options.get("AGENT_TIMEOUT"), 300.0),
        )

    raise ValueError(f"Backend LLM sconosciuto: {requested!r}")


#: Who can write the chatter: the models, not the agents (which keep a
#: session of their own and cost a whole turn for every comment).
CHATTER_CATEGORIES = ("cloud", "local")


def create_chatter_llm(settings: Settings, backend: str, models: str = "") -> LLMClient:
    """The chatter brain: a cloud or local model, usually cheap.

    ``models`` is a comma-separated row (``a:free, b:free``): if the first
    doesn't answer the second is tried. Empty = the model saved for that engine.
    The key and the other fields are the engine's, the same as in the Engines tab.
    """
    spec = LLM_REGISTRY.get(LLM_REGISTRY.resolve(backend) or backend)
    if spec is None or spec.category not in CHATTER_CATEGORIES:
        raise ValueError(f"{backend!r} can't write the chatter: it needs a cloud or local model.")
    model_env = next((f.env for f in spec.fields if f.env.endswith("_MODEL")), None)
    names = [name.strip() for name in models.split(",") if name.strip()]
    if model_env is None or not names:
        return create_llm_client(settings, spec.id)
    clients = [create_llm_client(settings, spec.id, overrides={model_env: name}) for name in names]
    return clients[0] if len(clients) == 1 else FallbackLLM(clients, name=spec.id)
