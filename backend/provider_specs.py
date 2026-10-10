"""Declaration of every available provider.

This module doesn't import ``config``: it's ``config`` that imports it, to
read from the environment every field declared here. Adding a new engine
means adding a ``spec`` here and its implementation in the matching package
— the panel adapts by itself.

Registration order = order in the panel, within each category. The texts are
English; the frontend's catalog has their Italian (frontend/src/i18n/it.js).
"""

from __future__ import annotations

from .providers import (
    LLM_REGISTRY,
    STT_REGISTRY,
    TTS_REGISTRY,
    ProviderField,
    ProviderSpec,
)

# ---------------------------------------------------------------------------
# Recurring fields
# ---------------------------------------------------------------------------


def _temperature() -> ProviderField:
    return ProviderField(
        env="TEMPERATURE",
        label="Temperature",
        type="number",
        default=0.7,
        help="How creative the reply is: 0 = always the same, 1 = unpredictable.",
        advanced=True,
    )


def _api_key(env: str, help_text: str = "", label: str = "API key") -> ProviderField:
    return ProviderField(
        env=env,
        label=label,
        type="password",
        secret=True,
        help=help_text or "It stays on your computer: the panel never reads it back.",
    )


def _timeout(env: str, default: float = 120.0) -> ProviderField:
    return ProviderField(
        env=env,
        label="Maximum time (s)",
        type="number",
        default=default,
        help="Beyond this time the reply is given up as lost.",
        advanced=True,
    )


def _workdir(env: str) -> ProviderField:
    return ProviderField(
        env=env,
        label="Working folder",
        placeholder="empty = your user folder",
        help="Where the agent can read files. Point it at a project if you want to talk to it about one.",
    )


# ---------------------------------------------------------------------------
# LLM — agents
#
# An agent isn't just a model: it has memory, personality and tools of its
# own. The companion passes it only the last message (plus the speech
# constraints) and reads its reply aloud.
# ---------------------------------------------------------------------------

LLM_REGISTRY.register(
    ProviderSpec(
        id="openclaw",
        label="OpenClaw",
        kind="llm",
        category="agent",
        pricing="free",
        tagline="Your OpenClaw agent, with its memory and its tools.",
        description=(
            "The companion becomes the voice and face of your OpenClaw agent: "
            "the same personality, the same memory, the same tools. It talks to the "
            "Gateway on your computer."
        ),
        local=True,
        fields=(
            ProviderField(
                env="OPENCLAW_URL",
                label="Gateway",
                type="url",
                default="http://127.0.0.1:18789",
            ),
            ProviderField(
                env="OPENCLAW_AGENT_ID",
                label="Agent",
                default="main",
                help="Better a dedicated agent with few tools: the prompt is much shorter.",
            ),
            _api_key("OPENCLAW_TOKEN", "Empty = read from ~/.openclaw/openclaw.json.", "Token"),
        ),
        requires=("OpenClaw Gateway running",),
        docs="https://docs.openclaw.ai",
    )
)

LLM_REGISTRY.register(
    ProviderSpec(
        id="claude_code",
        label="Claude Code",
        kind="llm",
        category="agent",
        pricing="subscription",
        recommended=True,
        tagline="Anthropic's agent, with your Claude subscription.",
        description=(
            "Uses the `claude` program already installed and signed in: no keys "
            "to copy, it uses your Claude plan. It remembers the conversation from "
            "one message to the next and can search the web."
        ),
        local=False,
        aliases=("claude-code", "claudecode"),
        fields=(
            ProviderField(
                env="CLAUDE_CODE_MODEL",
                label="Model",
                type="select",
                default="",
                options=(
                    {"value": "", "label": "Your account's default"},
                    {"value": "opus", "label": "Opus — the most capable"},
                    {"value": "sonnet", "label": "Sonnet — balanced"},
                    {"value": "haiku", "label": "Haiku — the quickest to answer"},
                ),
            ),
            _workdir("CLAUDE_CODE_CWD"),
            ProviderField(
                env="CLAUDE_CODE_TOOLS",
                label="Allowed tools",
                default="WebSearch,WebFetch,Read,Glob,Grep",
                help="Comma separated. Those not listed are refused: it can't modify files.",
                advanced=True,
            ),
            ProviderField(
                env="CLAUDE_CODE_PERMISSION",
                label="Permissions",
                type="select",
                default="default",
                options=(
                    {"value": "default", "label": "Careful — refuses what isn't allowed"},
                    {"value": "acceptEdits", "label": "Can modify files in the folder"},
                    {"value": "plan", "label": "Planning only"},
                ),
                advanced=True,
            ),
            ProviderField(
                env="CLAUDE_CODE_COMMAND",
                label="Program",
                default="claude",
                help="Name or full path of the executable.",
                advanced=True,
            ),
            _timeout("CLAUDE_CODE_TIMEOUT", 300.0),
        ),
        requires=("Claude Code installed and signed in",),
        docs="https://docs.claude.com/claude-code",
    )
)

LLM_REGISTRY.register(
    ProviderSpec(
        id="codex",
        label="Codex",
        kind="llm",
        category="agent",
        pricing="subscription",
        tagline="OpenAI's agent, with your ChatGPT account.",
        description=(
            "Uses `codex exec`, the same engine as the VS Code extension: if the "
            "extension is installed the program is found by itself. "
            "It remembers the conversation and by default works read-only."
        ),
        local=False,
        fields=(
            ProviderField(
                env="CODEX_MODEL",
                label="Model",
                placeholder="empty = the one in your config.toml",
            ),
            _workdir("CODEX_CWD"),
            ProviderField(
                env="CODEX_SANDBOX",
                label="Permissions",
                type="select",
                default="read-only",
                options=(
                    {"value": "read-only", "label": "Read-only"},
                    {"value": "workspace-write", "label": "Can write in the folder"},
                ),
                advanced=True,
            ),
            ProviderField(
                env="CODEX_COMMAND",
                label="Program",
                placeholder="empty = found by itself",
                help="Path of codex.exe, if it isn't found automatically.",
                advanced=True,
            ),
            _timeout("CODEX_TIMEOUT", 300.0),
        ),
        requires=("Codex CLI or the Codex VS Code extension, signed in",),
        docs="https://developers.openai.com/codex",
    )
)

LLM_REGISTRY.register(
    ProviderSpec(
        id="antigravity",
        label="Antigravity",
        kind="llm",
        category="agent",
        pricing="freemium",
        tagline="Google's agent, with Gemini and Claude included in your account.",
        description=(
            "Uses `agy`, Google Antigravity's command line: the app or the "
            "VS Code extension put it in ~/.gemini/bin and it's found by "
            "itself. It remembers the conversation. Without its window it can't "
            "ask you for permissions: the tools that need them are refused, unless "
            "you change the Permissions."
        ),
        local=False,
        aliases=("agy", "google_antigravity"),
        fields=(
            ProviderField(
                env="ANTIGRAVITY_MODEL",
                label="Model",
                placeholder="empty = the default",
                help="The list with `agy models`: for example gemini-3.1-pro-high or claude-sonnet-4-6.",
            ),
            _workdir("ANTIGRAVITY_CWD"),
            ProviderField(
                env="ANTIGRAVITY_PERMISSION",
                label="Permissions",
                type="select",
                default="default",
                options=(
                    {"value": "default", "label": "Careful — refuses what would ask for confirmation"},
                    {"value": "plan", "label": "Planning only"},
                    {"value": "accept-edits", "label": "Can modify files in the folder"},
                    {"value": "skip", "label": "Approves everything by itself (commands too) — risky"},
                ),
                help=(
                    "With \"Approve everything\" it runs any command without asking: whoever manages to "
                    "talk to her (or a text you have her read) can act on your PC. Choose it only if you know what you're doing."
                ),
                advanced=True,
            ),
            ProviderField(
                env="ANTIGRAVITY_COMMAND",
                label="Program",
                placeholder="empty = found by itself",
                help="Path of agy.exe, if it isn't found automatically.",
                advanced=True,
            ),
            _timeout("ANTIGRAVITY_TIMEOUT", 300.0),
        ),
        requires=("Antigravity (app or VS Code extension) signed in",),
        docs="https://antigravity.google",
    )
)


#: Command-line agents without a dedicated client: id -> default command.
#: The factory runs them with ``CommandAgentClient``, the detection looks for the program.
CLI_AGENT_PRESETS: dict[str, str] = {}


def _cli_agent(provider_id: str, label: str, command: str, tagline: str, pricing: str, install: str, docs: str) -> None:
    """An agent with a non-interactive mode: knowing how to run it is enough.

    The command is an editable field: if a new version changes options, it's
    fixed from the panel without waiting for an update.
    """
    prefix = provider_id.upper()
    CLI_AGENT_PRESETS[provider_id] = command
    LLM_REGISTRY.register(
        ProviderSpec(
            id=provider_id,
            label=label,
            kind="llm",
            category="agent",
            pricing=pricing,  # type: ignore[arg-type]
            tagline=tagline,
            description=(
                f"{tagline} The companion runs `{command}` at every message and reads "
                "what it prints. At every run the agent starts from scratch: the last "
                "exchanges are sent to it again."
            ),
            local=False,
            fields=(
                ProviderField(
                    env=f"{prefix}_COMMAND",
                    label="Command",
                    default=command,
                    help="{prompt} = your message; without it, it arrives on standard input. Change it if your version uses other options.",
                ),
                _workdir(f"{prefix}_CWD"),
                _timeout(f"{prefix}_TIMEOUT", 300.0),
            ),
            requires=(install,),
            docs=docs,
        )
    )


_cli_agent(
    "cline",
    "Cline",
    "cline {prompt}",
    "VS Code's open-source agent, from the terminal, with the models you chose in Cline.",
    "freemium",
    "npm install -g cline, then `cline auth`. With -y it approves everything by itself.",
    "https://docs.cline.bot/cline-cli/overview",
)
_cli_agent(
    "gemini_cli",
    "Gemini CLI",
    "gemini -p {prompt}",
    "Google's open-source agent in the terminal, free with a Google account.",
    "freemium",
    "npm install -g @google/gemini-cli, then `gemini` once to sign in",
    "https://github.com/google-gemini/gemini-cli",
)
_cli_agent(
    "cursor_agent",
    "Cursor CLI",
    "cursor-agent -p {prompt} --output-format text",
    "Cursor's agent outside the editor, with your Cursor subscription.",
    "subscription",
    "Cursor CLI installed, then `cursor-agent login`",
    "https://cursor.com/cli",
)
_cli_agent(
    "copilot",
    "GitHub Copilot CLI",
    "copilot -p {prompt}",
    "GitHub's agent, with your Copilot plan (the free one too).",
    "freemium",
    "npm install -g @github/copilot, then `copilot` once to sign in",
    "https://docs.github.com/copilot/how-tos/use-copilot-agents/use-copilot-cli",
)
_cli_agent(
    "opencode",
    "OpenCode",
    "opencode run {prompt}",
    "An open-source agent that works with almost any model, free ones too.",
    "free",
    "npm install -g opencode-ai, then `opencode auth login`",
    "https://opencode.ai/docs/cli",
)
_cli_agent(
    "qwen_code",
    "Qwen Code",
    "qwen -p {prompt}",
    "Alibaba's agent for the Qwen models, with a free quota.",
    "freemium",
    "npm install -g @qwen-code/qwen-code, then `qwen` once to sign in",
    "https://github.com/QwenLM/qwen-code",
)
_cli_agent(
    "amp",
    "Amp",
    "amp -x {prompt}",
    "Sourcegraph's agent, with a free plan.",
    "freemium",
    "npm install -g @sourcegraph/amp, then `amp login`",
    "https://ampcode.com/manual",
)
_cli_agent(
    "goose",
    "Goose",
    "goose run -t {prompt}",
    "Block's open-source agent, with the model you prefer.",
    "free",
    "Goose CLI installed and configured with `goose configure`",
    "https://block.github.io/goose",
)
_cli_agent(
    "crush",
    "Crush",
    "crush run {prompt}",
    "Charm's terminal agent, with the model you prefer.",
    "free",
    "Crush installed and with a model configured",
    "https://github.com/charmbracelet/crush",
)
_cli_agent(
    "droid",
    "Factory Droid",
    "droid exec {prompt}",
    "Factory's agent; in exec mode by default it modifies nothing.",
    "freemium",
    "Droid CLI installed and signed in",
    "https://docs.factory.ai/cli/droid-exec/overview",
)
_cli_agent(
    "continue_cli",
    "Continue CLI",
    "cn -p {prompt}",
    "Continue's agent outside the editor, with your models.",
    "free",
    "npm install -g @continuedev/cli, then `cn login`",
    "https://docs.continue.dev/cli/overview",
)
_cli_agent(
    "kiro",
    "Kiro CLI",
    "kiro-cli chat --no-interactive {prompt}",
    "AWS's agent, with your Kiro account.",
    "freemium",
    "Kiro CLI installed, then `kiro-cli login`",
    "https://kiro.dev/docs/cli",
)

LLM_REGISTRY.register(
    ProviderSpec(
        id="hermes",
        label="Hermes Agent",
        kind="llm",
        category="agent",
        pricing="free",
        tagline="Nous Research's open-source agent, through its API server.",
        description=(
            "Hermes Agent exposes an OpenAI-compatible endpoint when you turn on "
            "its API server (API_SERVER_ENABLED=true in its .env). The companion "
            "talks to it like to any model."
        ),
        local=True,
        aliases=("hermes-agent", "hermes_agent"),
        fields=(
            ProviderField(
                env="HERMES_BASE_URL",
                label="Address",
                type="url",
                default="http://127.0.0.1:8642/v1",
            ),
            ProviderField(env="HERMES_MODEL", label="Model", default="hermes-agent"),
            _api_key("HERMES_API_KEY", "Needed only if you set API_SERVER_KEY."),
            _timeout("HERMES_TIMEOUT", 300.0),
        ),
        requires=("hermes gateway with the API server on",),
        docs="https://hermes-agent.nousresearch.com/docs",
    )
)

LLM_REGISTRY.register(
    ProviderSpec(
        id="command",
        label="Another agent (command line)",
        kind="llm",
        category="agent",
        pricing="free",
        tagline="Any program that answers from the terminal.",
        description=(
            "For agents without a dedicated integration: the companion "
            "runs the command at every message and reads what it prints. "
            "{prompt} is replaced by the message; without {prompt} the message "
            "arrives on standard input."
        ),
        local=True,
        aliases=("cli", "custom"),
        fields=(
            ProviderField(
                env="AGENT_COMMAND",
                label="Command",
                placeholder="hermes chat -q {prompt}",
                help="Examples: `hermes chat -q {prompt}`, `aider --message {prompt}`, `ollama run llama3.2`.",
            ),
            _workdir("AGENT_CWD"),
            _timeout("AGENT_TIMEOUT", 300.0),
        ),
        requires=("The program installed and in the PATH",),
    )
)

# ---------------------------------------------------------------------------
# LLM — local models
# ---------------------------------------------------------------------------

LLM_REGISTRY.register(
    ProviderSpec(
        id="openai",
        label="LM Studio / OpenAI server",
        kind="llm",
        category="local",
        pricing="free",
        recommended=True,
        tagline="LM Studio, llama.cpp, vLLM: any OpenAI-style local server.",
        description=(
            "Any local server with an OpenAI-style API: LM Studio, llama.cpp "
            "server, vLLM, text-generation-webui. Also an agent that exposes "
            "/v1/chat/completions."
        ),
        local=True,
        aliases=("lmstudio", "lm_studio", "vllm", "llamacpp", "llama.cpp"),
        fields=(
            ProviderField(
                env="OPENAI_BASE_URL",
                label="Address",
                type="url",
                default="http://127.0.0.1:1234/v1",
                help="LM Studio uses port 1234 (Developer tab -> Start Server).",
            ),
            ProviderField(
                env="OPENAI_MODEL",
                label="Model",
                default="auto",
                source="models",
                help="`auto` uses the first model already loaded by the server.",
            ),
            _api_key("OPENAI_API_KEY", "Almost never needed for a local server."),
            _timeout("OPENAI_TIMEOUT"),
            _temperature(),
        ),
        requires=("Local server running",),
        docs="https://lmstudio.ai",
    )
)

LLM_REGISTRY.register(
    ProviderSpec(
        id="ollama",
        label="Ollama",
        kind="llm",
        category="local",
        pricing="free",
        tagline="Local models served by Ollama.",
        description="Local models served by Ollama. No key, no network.",
        local=True,
        fields=(
            ProviderField(
                env="OLLAMA_URL",
                label="Address",
                type="url",
                default="http://127.0.0.1:11434",
            ),
            ProviderField(
                env="OLLAMA_MODEL",
                label="Model",
                default="llama3.2",
                placeholder="llama3.2",
                source="models",
                help="A model already downloaded with `ollama pull`.",
            ),
            _timeout("OLLAMA_TIMEOUT"),
            _temperature(),
        ),
        requires=("Ollama running",),
        docs="https://ollama.com",
    )
)

# ---------------------------------------------------------------------------
# LLM — cloud services
#
# Groq, OpenRouter, DeepSeek, Mistral and Together all speak the OpenAI API:
# only the address changes, so they reuse the same client. Anthropic and
# Gemini instead have a message format of their own and a dedicated client.
# ---------------------------------------------------------------------------

LLM_REGISTRY.register(
    ProviderSpec(
        id="anthropic",
        label="Claude (API)",
        kind="llm",
        category="cloud",
        pricing="paid",
        tagline="Claude models with an API key, pay per use.",
        description="Claude models through the official Anthropic API.",
        local=False,
        aliases=("claude",),
        fields=(
            _api_key("ANTHROPIC_API_KEY", "Created at console.anthropic.com."),
            ProviderField(
                env="ANTHROPIC_MODEL",
                label="Model",
                type="select",
                default="claude-opus-5",
                options=(
                    {"value": "claude-opus-5", "label": "Opus 5 — the most capable"},
                    {"value": "claude-sonnet-5", "label": "Sonnet 5 — balanced"},
                    {"value": "claude-haiku-4-5", "label": "Haiku 4.5 — the quickest and cheapest"},
                ),
            ),
            ProviderField(
                env="ANTHROPIC_BASE_URL",
                label="Address",
                type="url",
                default="https://api.anthropic.com",
                help="Change it only if you go through a proxy.",
                advanced=True,
            ),
            ProviderField(
                env="ANTHROPIC_MAX_TOKENS",
                label="Maximum tokens",
                type="number",
                default=1024,
                help="The companion answers in a few sentences: no need to raise it.",
                advanced=True,
            ),
        ),
        requires=("API key",),
        docs="https://console.anthropic.com",
    )
)

LLM_REGISTRY.register(
    ProviderSpec(
        id="gemini",
        label="Google Gemini",
        kind="llm",
        category="cloud",
        pricing="freemium",
        tagline="Gemini models, with a free plan.",
        description="Gemini models through the Google AI Studio API.",
        local=False,
        aliases=("google",),
        fields=(
            _api_key("GEMINI_API_KEY", "Created at aistudio.google.com/apikey."),
            ProviderField(
                env="GEMINI_MODEL",
                label="Model",
                default="gemini-2.5-flash",
                placeholder="gemini-2.5-flash",
            ),
            ProviderField(
                env="GEMINI_BASE_URL",
                label="Address",
                type="url",
                default="https://generativelanguage.googleapis.com/v1beta",
                advanced=True,
            ),
            _temperature(),
        ),
        requires=("API key",),
        docs="https://aistudio.google.com/apikey",
    )
)


def _openai_like_cloud(
    provider_id: str,
    label: str,
    base_url: str,
    model_default: str,
    description: str,
    signup_help: str,
    pricing: str,
    docs: str,
) -> None:
    LLM_REGISTRY.register(
        ProviderSpec(
            id=provider_id,
            label=label,
            kind="llm",
            category="cloud",
            pricing=pricing,  # type: ignore[arg-type]
            tagline=description,
            description=description,
            local=False,
            fields=(
                _api_key(f"{provider_id.upper()}_API_KEY", signup_help),
                ProviderField(
                    env=f"{provider_id.upper()}_MODEL",
                    label="Model",
                    default=model_default,
                    placeholder=model_default,
                    source="models",
                ),
                ProviderField(
                    env=f"{provider_id.upper()}_BASE_URL",
                    label="Address",
                    type="url",
                    default=base_url,
                    help="Change it only if you go through a proxy.",
                    advanced=True,
                ),
                _temperature(),
            ),
            requires=("API key",),
            docs=docs,
        )
    )


_openai_like_cloud(
    "groq",
    "Groq",
    "https://api.groq.com/openai/v1",
    "llama-3.3-70b-versatile",
    "Very fast inference, with a generous free plan.",
    "Created at console.groq.com.",
    "freemium",
    "https://console.groq.com/keys",
)

_openai_like_cloud(
    "openrouter",
    "OpenRouter",
    "https://openrouter.ai/api/v1",
    "anthropic/claude-haiku-4.5",
    "One account for hundreds of models, some of them free.",
    "Created at openrouter.ai/keys.",
    "freemium",
    "https://openrouter.ai/keys",
)

_openai_like_cloud(
    "deepseek",
    "DeepSeek",
    "https://api.deepseek.com/v1",
    "deepseek-chat",
    "Cheap models with good reasoning abilities.",
    "Created at platform.deepseek.com.",
    "paid",
    "https://platform.deepseek.com",
)

_openai_like_cloud(
    "mistral",
    "Mistral",
    "https://api.mistral.ai/v1",
    "mistral-small-latest",
    "European models, with a free plan to experiment.",
    "Created at console.mistral.ai.",
    "freemium",
    "https://console.mistral.ai",
)

_openai_like_cloud(
    "together",
    "Together AI",
    "https://api.together.xyz/v1",
    "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    "A wide catalogue of hosted open models.",
    "Created at api.together.xyz.",
    "paid",
    "https://api.together.xyz",
)

# gpt4free runs on the PC as an OpenAI server but passes the questions on to
# public chat sites: for the panel it's a cloud service, free and keyless.
# With `auto` it goes through g4f.dev's credit service, which answers 402
# after a minute (tried with g4f 8.6.5): that's why the default is a precise
# model. Gemini sends the text in pieces and without ChatGPT's source pills
# (see openai_compatible.strip_source_pills).
LLM_REGISTRY.register(
    ProviderSpec(
        id="g4f",
        label="GPT4Free",
        kind="llm",
        category="cloud",
        pricing="free",
        tagline="Free models without a key, through public chat sites.",
        description=(
            "gpt4free (g4f) uses ChatGPT, Gemini and other chat sites as a browser "
            "would, without an account. It isn't an official service: the working "
            "models change often and the messages go through third-party sites, "
            "so no personal data."
        ),
        local=False,
        aliases=("gpt4free",),
        fields=(
            ProviderField(
                env="G4F_BASE_URL",
                label="Address",
                type="url",
                default="http://127.0.0.1:1337/v1",
                help=(
                    "Install with `pip install -U \"g4f[api]\"` and start `g4f api --bind 127.0.0.1:1337 --no-gui`: "
                    "without --bind it stays open to the whole network."
                ),
            ),
            ProviderField(
                env="G4F_MODEL",
                label="Model",
                default="gemini-2.5-flash",
                placeholder="gemini-2.5-flash",
                source="models",
                help="Tried: gemini-2.5-flash, gpt-4o-mini, gpt-4o. Avoid `auto`: it goes through paid credits.",
            ),
            _api_key("G4F_API_KEY", "Needed only if you start g4f with --g4f-api-key."),
            _timeout("G4F_TIMEOUT", 60.0),
            _temperature(),
        ),
        requires=("g4f api running",),
        docs="https://github.com/xtekky/gpt4free",
    )
)

LLM_REGISTRY.register(
    ProviderSpec(
        id="mock",
        label="Offline answerer",
        kind="llm",
        category="test",
        pricing="free",
        tagline="Canned replies, to try the chain without models.",
        description="Canned replies, without any model. Handy to try voice and animations.",
        local=True,
        aliases=("offline", "none"),
    )
)

# ---------------------------------------------------------------------------
# TTS — local voices
# ---------------------------------------------------------------------------

TTS_REGISTRY.register(
    ProviderSpec(
        id="kokoro",
        label="Kokoro",
        kind="tts",
        category="local",
        pricing="free",
        recommended=True,
        tagline="A neural voice on your computer, with the most precise lip-sync.",
        description=(
            "In-process neural synthesis via ONNX: no network, good quality and "
            "exact timings for every phoneme, so the mouth is perfectly in time."
        ),
        local=True,
        has_voices=True,
        fields=(
            ProviderField(
                env="KOKORO_MODEL",
                label="Model path",
                default="models/kokoro-v1.0.onnx",
                advanced=True,
            ),
            ProviderField(
                env="KOKORO_VOICES",
                label="Voices path",
                default="models/voices-v1.0.bin",
                advanced=True,
            ),
        ),
        requires=("Kokoro weights downloaded (scripts/download_models.py)",),
    )
)

TTS_REGISTRY.register(
    ProviderSpec(
        id="kokoro_http",
        label="Kokoro-FastAPI",
        kind="tts",
        category="local",
        pricing="free",
        tagline="A Kokoro server already running, for example on a GPU.",
        description="A Kokoro server already running, handy if you run it on a GPU.",
        local=True,
        has_voices=True,
        fields=(
            ProviderField(
                env="KOKORO_HTTP_URL",
                label="Address",
                type="url",
                default="http://127.0.0.1:8880",
            ),
        ),
        requires=("Kokoro-FastAPI server running",),
    )
)

TTS_REGISTRY.register(
    ProviderSpec(
        id="piper",
        label="Piper",
        kind="tts",
        category="local",
        pricing="free",
        tagline="Very light local synthesis, it runs on any CPU.",
        description="Very light local synthesis: it runs well even on modest CPUs.",
        local=True,
        has_voices=True,
        fields=(
            ProviderField(
                env="PIPER_MODEL",
                label="Path of the .onnx model",
                placeholder="models/piper/it_IT-riccardo-x_low.onnx",
                help="Voices are downloaded from huggingface.co/rhasspy/piper-voices.",
            ),
        ),
        requires=("pip install piper-tts", "A Piper voice downloaded"),
        docs="https://huggingface.co/rhasspy/piper-voices",
    )
)

TTS_REGISTRY.register(
    ProviderSpec(
        id="chatterbox",
        label="Chatterbox",
        kind="tts",
        category="local",
        pricing="free",
        tagline="Record quality among open models, but it needs an NVIDIA GPU.",
        description=(
            "Resemble AI's open-source model: in blind listening tests it often beats "
            "even ElevenLabs. It clones a voice from a few seconds of audio: "
            "from the Character tab, \"Clone a voice\". Multilingual, Italian "
            "included. On the CPU it's too slow for real-time use."
        ),
        local=True,
        has_voices=True,
        fields=(
            ProviderField(
                env="CHATTERBOX_DEVICE",
                label="Device",
                type="select",
                default="auto",
                options=(
                    {"value": "auto", "label": "automatico"},
                    {"value": "cuda", "label": "NVIDIA GPU"},
                    {"value": "cpu", "label": "CPU (very slow)"},
                ),
            ),
            ProviderField(
                env="CHATTERBOX_LANGUAGE",
                label="Language of the default voice",
                default="it",
                placeholder="it",
                help="Cloned voices each have their own language, chosen when you clone them.",
            ),
            ProviderField(
                env="CHATTERBOX_EXAGGERATION",
                label="Expressiveness",
                type="number",
                default=0.5,
                help="0 = flat, 1 = very marked.",
                advanced=True,
            ),
            ProviderField(
                env="CHATTERBOX_CFG_WEIGHT",
                label="Adherence to the reference",
                type="number",
                default=0.5,
                help="Higher = more faithful to the reference voice, but stiffer.",
                advanced=True,
            ),
        ),
        requires=("pip install chatterbox-tts", "NVIDIA GPU recommended (~3GB of VRAM)"),
        docs="https://github.com/resemble-ai/chatterbox",
    )
)

TTS_REGISTRY.register(
    ProviderSpec(
        id="system",
        label="System voice",
        kind="tts",
        category="local",
        pricing="free",
        tagline="The voices already installed in Windows.",
        description=(
            "The voices already installed in the operating system (SAPI on Windows, "
            "NSSpeechSynthesizer on macOS, espeak on Linux). Always available."
        ),
        local=True,
        has_voices=True,
        aliases=("pyttsx3", "sapi"),
        requires=("pip install pyttsx3",),
    )
)

# ---------------------------------------------------------------------------
# TTS — online voices
# ---------------------------------------------------------------------------

TTS_REGISTRY.register(
    ProviderSpec(
        id="elevenlabs",
        label="ElevenLabs",
        kind="tts",
        category="cloud",
        pricing="freemium",
        recommended=True,
        tagline="The most natural voices around. Free plan, then pay per use.",
        description=(
            "Very high quality and cloned voices. The companion also asks for the timings "
            "of every letter, so the lip-sync stays as precise as with Kokoro. "
            "The check shows how many characters you have left this month."
        ),
        local=False,
        has_voices=True,
        fields=(
            _api_key("ELEVENLABS_API_KEY", "Created at elevenlabs.io (Profile -> API Keys)."),
            ProviderField(
                env="ELEVENLABS_VOICE",
                label="Voice",
                default="Rachel",
                source="voices",
                help="Name or ID of a voice in your account: press Check for the list.",
            ),
            ProviderField(
                env="ELEVENLABS_MODEL",
                label="Model",
                type="select",
                default="eleven_flash_v2_5",
                options=(
                    {"value": "eleven_flash_v2_5", "label": "Flash v2.5 — very fast, half a credit per character"},
                    {"value": "eleven_turbo_v2_5", "label": "Turbo v2.5 — fast, good quality"},
                    {"value": "eleven_multilingual_v2", "label": "Multilingual v2 — the most expressive"},
                    {"value": "eleven_v3", "label": "v3 — emotions and intonation, slower"},
                ),
            ),
            ProviderField(
                env="ELEVENLABS_STABILITY",
                label="Stability",
                type="number",
                default=0.5,
                help="0 = very expressive and variable, 1 = always the same.",
                advanced=True,
            ),
            ProviderField(
                env="ELEVENLABS_SIMILARITY",
                label="Similarity",
                type="number",
                default=0.75,
                help="How faithful it stays to the original voice.",
                advanced=True,
            ),
            ProviderField(
                env="ELEVENLABS_STYLE",
                label="Style",
                type="number",
                default=0.0,
                help="Exaggerates the voice's style (it costs a little latency).",
                advanced=True,
            ),
            ProviderField(
                env="ELEVENLABS_LANGUAGE",
                label="Language",
                placeholder="empty = automatic (e.g. it, en)",
                help="Forces the language with the Flash and Turbo models.",
                advanced=True,
            ),
        ),
        requires=("API key",),
        docs="https://elevenlabs.io/app/settings/api-keys",
    )
)

TTS_REGISTRY.register(
    ProviderSpec(
        id="openai_tts",
        label="OpenAI TTS",
        kind="tts",
        category="cloud",
        pricing="paid",
        tagline="OpenAI's voices, which you can tell what tone to speak in.",
        description=(
            "gpt-4o-mini-tts accepts instructions on the tone (\"cheerful, in a low "
            "voice\"). It also works with any compatible server "
            "/v1/audio/speech: just change the address."
        ),
        local=False,
        has_voices=True,
        aliases=("openai-tts",),
        fields=(
            _api_key("OPENAI_TTS_API_KEY", "Created at platform.openai.com/api-keys."),
            ProviderField(
                env="OPENAI_TTS_VOICE",
                label="Voice",
                type="select",
                default="coral",
                options=tuple(
                    {"value": v, "label": v.capitalize()}
                    for v in (
                        "alloy", "ash", "ballad", "cedar", "coral", "echo", "fable",
                        "marin", "nova", "onyx", "sage", "shimmer", "verse",
                    )
                ),
            ),
            ProviderField(
                env="OPENAI_TTS_MODEL",
                label="Model",
                type="select",
                default="gpt-4o-mini-tts",
                options=(
                    {"value": "gpt-4o-mini-tts", "label": "gpt-4o-mini-tts — follows the tone instructions"},
                    {"value": "tts-1", "label": "tts-1 — fast"},
                    {"value": "tts-1-hd", "label": "tts-1-hd — higher quality"},
                ),
            ),
            ProviderField(
                env="OPENAI_TTS_INSTRUCTIONS",
                label="Tone",
                type="textarea",
                placeholder="Speak in a warm, cheerful way, like a friend.",
                help="Only with gpt-4o-mini-tts.",
            ),
            ProviderField(
                env="OPENAI_TTS_BASE_URL",
                label="Address",
                type="url",
                default="https://api.openai.com/v1",
                help="Change it for a compatible server (Kokoro-FastAPI, openedai-speech...).",
                advanced=True,
            ),
        ),
        requires=("API key",),
        docs="https://platform.openai.com/api-keys",
    )
)

TTS_REGISTRY.register(
    ProviderSpec(
        id="azure",
        label="Azure Speech",
        kind="tts",
        category="cloud",
        pricing="freemium",
        tagline="Hundreds of Microsoft neural voices, 500 thousand free characters a month.",
        description=(
            "Azure's neural voices, with excellent Italian and multilingual voices. The "
            "free plan (F0) is enough for everyday use."
        ),
        local=False,
        has_voices=True,
        aliases=("azure_tts", "microsoft"),
        fields=(
            _api_key("AZURE_SPEECH_KEY", "Azure portal -> Speech resource -> Keys and endpoint."),
            ProviderField(
                env="AZURE_SPEECH_REGION",
                label="Region",
                default="westeurope",
                placeholder="westeurope",
            ),
            ProviderField(
                env="AZURE_SPEECH_VOICE",
                label="Voice",
                default="it-IT-IsabellaMultilingualNeural",
                source="voices",
                help="Press Check for the full list.",
            ),
        ),
        requires=("API key",),
        docs="https://portal.azure.com",
    )
)

TTS_REGISTRY.register(
    ProviderSpec(
        id="google_tts",
        label="Google Cloud TTS",
        kind="tts",
        category="cloud",
        pricing="freemium",
        tagline="Google's WaveNet, Neural2 and Chirp voices, with a free monthly quota.",
        description=(
            "Google Cloud Text-to-Speech voices. It needs an API key of a "
            "project with the Text-to-Speech API enabled."
        ),
        local=False,
        has_voices=True,
        aliases=("google_cloud_tts", "gcloud"),
        fields=(
            _api_key("GOOGLE_TTS_API_KEY", "console.cloud.google.com -> APIs & Services -> Credentials."),
            ProviderField(
                env="GOOGLE_TTS_VOICE",
                label="Voice",
                default="it-IT-Chirp3-HD-Aoede",
                source="voices",
                help="Press Check for the full list.",
            ),
        ),
        requires=("API key",),
        docs="https://console.cloud.google.com/apis/library/texttospeech.googleapis.com",
    )
)

TTS_REGISTRY.register(
    ProviderSpec(
        id="cartesia",
        label="Cartesia",
        kind="tts",
        category="cloud",
        pricing="freemium",
        tagline="Realistic voices with very low latency.",
        description="Cartesia's Sonic voices: very natural and among the quickest to answer.",
        local=False,
        has_voices=True,
        fields=(
            _api_key("CARTESIA_API_KEY", "Created at play.cartesia.ai/keys."),
            ProviderField(
                env="CARTESIA_VOICE",
                label="Voice",
                placeholder="Voice ID",
                source="voices",
                help="Press Check to choose from the list.",
            ),
            ProviderField(
                env="CARTESIA_MODEL",
                label="Model",
                type="select",
                default="sonic-2",
                options=(
                    {"value": "sonic-2", "label": "Sonic 2 — best quality"},
                    {"value": "sonic-turbo", "label": "Sonic Turbo — minimal latency"},
                ),
            ),
            ProviderField(
                env="CARTESIA_LANGUAGE",
                label="Language",
                default="it",
                placeholder="it",
            ),
        ),
        requires=("API key",),
        docs="https://play.cartesia.ai/keys",
    )
)

TTS_REGISTRY.register(
    ProviderSpec(
        id="edge",
        label="Edge TTS",
        kind="tts",
        category="cloud",
        pricing="free",
        tagline="Microsoft Edge's neural voices, free and keyless.",
        description=(
            "Microsoft Edge's neural voices: very natural and keyless, "
            "but they go through the internet and the service isn't official."
        ),
        local=False,
        has_voices=True,
        aliases=("edge_tts",),
        fields=(
            ProviderField(
                env="EDGE_VOICE",
                label="Voice",
                default="it-IT-ElsaNeural",
                placeholder="it-IT-ElsaNeural",
                source="voices",
            ),
        ),
        requires=("pip install edge-tts soundfile",),
    )
)

TTS_REGISTRY.register(
    ProviderSpec(
        id="formant",
        label="Formant synthesizer",
        kind="tts",
        category="test",
        pricing="free",
        tagline="Vowels only: it's for trying the lip-sync without downloading anything.",
        description=(
            "It generates correct A/E/I/O/U vowels. It isn't a real voice: it's for "
            "checking the lip-sync without downloading anything."
        ),
        local=True,
        aliases=("test",),
    )
)

# ---------------------------------------------------------------------------
# STT — speech recognition
# ---------------------------------------------------------------------------

STT_REGISTRY.register(
    ProviderSpec(
        id="faster_whisper",
        label="Faster-Whisper",
        kind="stt",
        category="local",
        pricing="free",
        recommended=True,
        tagline="Whisper on your computer: precise and private.",
        description=(
            "Whisper reimplemented with CTranslate2: much faster than the "
            "original at the same quality. It's the recommended choice."
        ),
        local=True,
        aliases=("whisper",),
        fields=(
            ProviderField(
                env="WHISPER_MODEL",
                label="Model",
                type="select",
                default="base",
                options=(
                    {"value": "tiny", "label": "tiny — very fast, imprecise"},
                    {"value": "base", "label": "base — a good compromise"},
                    {"value": "small", "label": "small — more accurate"},
                    {"value": "medium", "label": "medium — slow on the CPU"},
                    {"value": "large-v3", "label": "large-v3 — needs a GPU"},
                ),
            ),
            ProviderField(
                env="WHISPER_DEVICE",
                label="Device",
                type="select",
                default="auto",
                options=(
                    {"value": "auto", "label": "automatico"},
                    {"value": "cpu", "label": "CPU"},
                    {"value": "cuda", "label": "NVIDIA GPU"},
                ),
            ),
            ProviderField(
                env="WHISPER_LANGUAGE",
                label="Language",
                default="auto",
                help="`auto` detects it by itself; setting it is more precise and faster.",
            ),
        ),
        requires=("pip install faster-whisper",),
    )
)

STT_REGISTRY.register(
    ProviderSpec(
        id="whisper_cpp",
        label="whisper.cpp",
        kind="stt",
        category="local",
        pricing="free",
        tagline="A whisper.cpp server already running.",
        description="A whisper.cpp server already running, handy if you already have one.",
        local=True,
        fields=(
            ProviderField(
                env="WHISPER_CPP_URL",
                label="Address",
                type="url",
                default="http://127.0.0.1:8080",
            ),
        ),
        requires=("whisper.cpp server running",),
    )
)

STT_REGISTRY.register(
    ProviderSpec(
        id="openai_whisper_api",
        label="Whisper via API",
        kind="stt",
        category="cloud",
        pricing="paid",
        tagline="Online transcription with an OpenAI-compatible endpoint.",
        description="Remote transcription with an OpenAI-compatible endpoint (OpenAI, Groq...).",
        local=False,
        fields=(
            _api_key("STT_API_KEY"),
            ProviderField(
                env="STT_BASE_URL",
                label="Address",
                type="url",
                default="https://api.openai.com/v1",
            ),
            ProviderField(env="STT_MODEL", label="Model", default="whisper-1"),
        ),
        requires=("API key",),
    )
)

STT_REGISTRY.register(
    ProviderSpec(
        id="browser",
        label="Browser recognition",
        kind="stt",
        category="cloud",
        pricing="free",
        tagline="The one built into Chrome/Electron: it goes through Google's servers.",
        description=(
            "Uses the speech recognition built into Chrome/Electron: nothing to "
            "install, but it goes through Google's servers."
        ),
        local=False,
        requires=("Chrome or Electron",),
    )
)

STT_REGISTRY.register(
    ProviderSpec(
        id="none",
        label="Off",
        kind="stt",
        category="test",
        pricing="free",
        tagline="You talk only by typing.",
        description="No voice input: you talk to the companion only by typing.",
        local=True,
        aliases=("off", "disabled"),
    )
)
