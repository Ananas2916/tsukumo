"""Dichiarazione di tutti i provider disponibili.

Questo modulo non importa ``config``: e' ``config`` a importare lui, per
leggere dall'ambiente ogni campo qui dichiarato. Aggiungere un motore nuovo
significa aggiungere uno ``spec`` qui e la sua implementazione nel package
corrispondente — il pannello si adegua da solo.

Ordine di registrazione = ordine nel pannello, dentro ogni categoria.
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
# Campi ricorrenti
# ---------------------------------------------------------------------------


def _temperature() -> ProviderField:
    return ProviderField(
        env="TEMPERATURE",
        label="Temperatura",
        type="number",
        default=0.7,
        help="Quanto è creativa la risposta: 0 = sempre uguale, 1 = imprevedibile.",
        advanced=True,
    )


def _api_key(env: str, help_text: str = "", label: str = "API key") -> ProviderField:
    return ProviderField(
        env=env,
        label=label,
        type="password",
        secret=True,
        help=help_text or "Resta sul tuo computer: il pannello non la rilegge mai.",
    )


def _timeout(env: str, default: float = 120.0) -> ProviderField:
    return ProviderField(
        env=env,
        label="Tempo massimo (s)",
        type="number",
        default=default,
        help="Oltre questo tempo la risposta viene data per persa.",
        advanced=True,
    )


def _workdir(env: str) -> ProviderField:
    return ProviderField(
        env=env,
        label="Cartella di lavoro",
        placeholder="vuoto = la tua cartella utente",
        help="Dove l'agente può leggere file. Mettilo su un progetto se vuoi parlargliene.",
    )


# ---------------------------------------------------------------------------
# LLM — agenti
#
# Un agente non e' solo un modello: ha memoria, personalita' e strumenti
# propri. Il companion gli passa soltanto l'ultimo messaggio (piu' i vincoli
# del parlato) e legge ad alta voce la sua risposta.
# ---------------------------------------------------------------------------

LLM_REGISTRY.register(
    ProviderSpec(
        id="openclaw",
        label="OpenClaw",
        kind="llm",
        category="agent",
        pricing="free",
        tagline="Il tuo agente OpenClaw, con la sua memoria e i suoi tool.",
        description=(
            "Il companion diventa la voce e la faccia del tuo agente OpenClaw: "
            "stessa personalità, stessa memoria, stessi strumenti. Parla col "
            "Gateway sul tuo computer."
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
                label="Agente",
                default="main",
                help="Meglio un agente dedicato con pochi tool: il prompt è molto più corto.",
            ),
            _api_key("OPENCLAW_TOKEN", "Vuoto = letto da ~/.openclaw/openclaw.json.", "Token"),
        ),
        requires=("Gateway OpenClaw acceso",),
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
        tagline="L'agente di Anthropic, col tuo abbonamento Claude.",
        description=(
            "Usa il programma `claude` già installato e autenticato: niente chiavi "
            "da copiare, consuma il tuo piano Claude. Ricorda la conversazione tra "
            "un messaggio e l'altro e può cercare sul web."
        ),
        local=False,
        aliases=("claude-code", "claudecode"),
        fields=(
            ProviderField(
                env="CLAUDE_CODE_MODEL",
                label="Modello",
                type="select",
                default="",
                options=(
                    {"value": "", "label": "Quello predefinito del tuo account"},
                    {"value": "opus", "label": "Opus — il più capace"},
                    {"value": "sonnet", "label": "Sonnet — equilibrato"},
                    {"value": "haiku", "label": "Haiku — il più rapido a rispondere"},
                ),
            ),
            _workdir("CLAUDE_CODE_CWD"),
            ProviderField(
                env="CLAUDE_CODE_TOOLS",
                label="Strumenti permessi",
                default="WebSearch,WebFetch,Read,Glob,Grep",
                help="Separati da virgola. Quelli non elencati vengono rifiutati: non può modificare file.",
                advanced=True,
            ),
            ProviderField(
                env="CLAUDE_CODE_PERMISSION",
                label="Permessi",
                type="select",
                default="default",
                options=(
                    {"value": "default", "label": "Prudente — rifiuta ciò che non è permesso"},
                    {"value": "acceptEdits", "label": "Puo' modificare file nella cartella"},
                    {"value": "plan", "label": "Solo pianificazione"},
                ),
                advanced=True,
            ),
            ProviderField(
                env="CLAUDE_CODE_COMMAND",
                label="Programma",
                default="claude",
                help="Nome o percorso completo dell'eseguibile.",
                advanced=True,
            ),
            _timeout("CLAUDE_CODE_TIMEOUT", 300.0),
        ),
        requires=("Claude Code installato e autenticato",),
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
        tagline="L'agente di OpenAI, col tuo account ChatGPT.",
        description=(
            "Usa `codex exec`, lo stesso motore dell'estensione di VS Code: se "
            "l'estensione è installata il programma viene trovato da solo. "
            "Ricorda la conversazione e di default lavora in sola lettura."
        ),
        local=False,
        fields=(
            ProviderField(
                env="CODEX_MODEL",
                label="Modello",
                placeholder="vuoto = quello del tuo config.toml",
            ),
            _workdir("CODEX_CWD"),
            ProviderField(
                env="CODEX_SANDBOX",
                label="Permessi",
                type="select",
                default="read-only",
                options=(
                    {"value": "read-only", "label": "Sola lettura"},
                    {"value": "workspace-write", "label": "Puo' scrivere nella cartella"},
                ),
                advanced=True,
            ),
            ProviderField(
                env="CODEX_COMMAND",
                label="Programma",
                placeholder="vuoto = cercato da solo",
                help="Percorso di codex.exe, se non viene trovato automaticamente.",
                advanced=True,
            ),
            _timeout("CODEX_TIMEOUT", 300.0),
        ),
        requires=("Codex CLI o l'estensione Codex di VS Code, con login fatto",),
        docs="https://developers.openai.com/codex",
    )
)

LLM_REGISTRY.register(
    ProviderSpec(
        id="hermes",
        label="Hermes Agent",
        kind="llm",
        category="agent",
        pricing="free",
        tagline="L'agente open source di Nous Research, via il suo API server.",
        description=(
            "Hermes Agent espone un endpoint compatibile OpenAI quando attivi il "
            "suo API server (API_SERVER_ENABLED=true nel suo .env). Il companion "
            "ci parla come a un modello qualsiasi."
        ),
        local=True,
        aliases=("hermes-agent", "hermes_agent"),
        fields=(
            ProviderField(
                env="HERMES_BASE_URL",
                label="Indirizzo",
                type="url",
                default="http://127.0.0.1:8642/v1",
            ),
            ProviderField(env="HERMES_MODEL", label="Modello", default="hermes-agent"),
            _api_key("HERMES_API_KEY", "Serve solo se hai impostato API_SERVER_KEY."),
            _timeout("HERMES_TIMEOUT", 300.0),
        ),
        requires=("hermes gateway con l'API server attivo",),
        docs="https://hermes-agent.nousresearch.com/docs",
    )
)

LLM_REGISTRY.register(
    ProviderSpec(
        id="command",
        label="Altro agente (riga di comando)",
        kind="llm",
        category="agent",
        pricing="free",
        tagline="Qualunque programma che risponde da terminale.",
        description=(
            "Per gli agenti che non hanno un'integrazione dedicata: il companion "
            "lancia il comando a ogni messaggio e legge quello che stampa. "
            "{prompt} viene sostituito dal messaggio; senza {prompt} il messaggio "
            "arriva sullo standard input."
        ),
        local=True,
        aliases=("cli", "custom"),
        fields=(
            ProviderField(
                env="AGENT_COMMAND",
                label="Comando",
                placeholder="hermes chat -q {prompt}",
                help="Esempi: `hermes chat -q {prompt}`, `aider --message {prompt}`, `ollama run llama3.2`.",
            ),
            _workdir("AGENT_CWD"),
            _timeout("AGENT_TIMEOUT", 300.0),
        ),
        requires=("Il programma installato e nel PATH",),
    )
)

# ---------------------------------------------------------------------------
# LLM — modelli locali
# ---------------------------------------------------------------------------

LLM_REGISTRY.register(
    ProviderSpec(
        id="openai",
        label="LM Studio / server OpenAI",
        kind="llm",
        category="local",
        pricing="free",
        recommended=True,
        tagline="LM Studio, llama.cpp, vLLM: qualunque server locale stile OpenAI.",
        description=(
            "Qualunque server locale con API stile OpenAI: LM Studio, llama.cpp "
            "server, vLLM, text-generation-webui. Anche un agente che espone "
            "/v1/chat/completions."
        ),
        local=True,
        aliases=("lmstudio", "lm_studio", "vllm", "llamacpp", "llama.cpp"),
        fields=(
            ProviderField(
                env="OPENAI_BASE_URL",
                label="Indirizzo",
                type="url",
                default="http://127.0.0.1:1234/v1",
                help="LM Studio usa la porta 1234 (tab Developer -> Start Server).",
            ),
            ProviderField(
                env="OPENAI_MODEL",
                label="Modello",
                default="auto",
                source="models",
                help="`auto` usa il primo modello già caricato dal server.",
            ),
            _api_key("OPENAI_API_KEY", "Quasi mai necessaria per un server locale."),
            _timeout("OPENAI_TIMEOUT"),
            _temperature(),
        ),
        requires=("Server locale in esecuzione",),
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
        tagline="Modelli locali serviti da Ollama.",
        description="Modelli locali serviti da Ollama. Nessuna chiave, nessuna rete.",
        local=True,
        fields=(
            ProviderField(
                env="OLLAMA_URL",
                label="Indirizzo",
                type="url",
                default="http://127.0.0.1:11434",
            ),
            ProviderField(
                env="OLLAMA_MODEL",
                label="Modello",
                default="llama3.2",
                placeholder="llama3.2",
                source="models",
                help="Un modello già scaricato con `ollama pull`.",
            ),
            _timeout("OLLAMA_TIMEOUT"),
            _temperature(),
        ),
        requires=("Ollama in esecuzione",),
        docs="https://ollama.com",
    )
)

# ---------------------------------------------------------------------------
# LLM — servizi cloud
#
# Groq, OpenRouter, DeepSeek, Mistral e Together parlano tutti l'API OpenAI:
# cambia solo l'indirizzo, quindi riusano lo stesso client. Anthropic e Gemini
# hanno invece un formato di messaggi proprio e un client dedicato.
# ---------------------------------------------------------------------------

LLM_REGISTRY.register(
    ProviderSpec(
        id="anthropic",
        label="Claude (API)",
        kind="llm",
        category="cloud",
        pricing="paid",
        tagline="I modelli Claude con una chiave API, a consumo.",
        description="I modelli Claude tramite l'API ufficiale Anthropic.",
        local=False,
        aliases=("claude",),
        fields=(
            _api_key("ANTHROPIC_API_KEY", "Si crea su console.anthropic.com."),
            ProviderField(
                env="ANTHROPIC_MODEL",
                label="Modello",
                type="select",
                default="claude-opus-5",
                options=(
                    {"value": "claude-opus-5", "label": "Opus 5 — il più capace"},
                    {"value": "claude-sonnet-5", "label": "Sonnet 5 — equilibrato"},
                    {"value": "claude-haiku-4-5", "label": "Haiku 4.5 — il più rapido ed economico"},
                ),
            ),
            ProviderField(
                env="ANTHROPIC_BASE_URL",
                label="Indirizzo",
                type="url",
                default="https://api.anthropic.com",
                help="Da cambiare solo se passi da un proxy.",
                advanced=True,
            ),
            ProviderField(
                env="ANTHROPIC_MAX_TOKENS",
                label="Token massimi",
                type="number",
                default=1024,
                help="Il companion risponde in poche frasi: non serve alzarlo.",
                advanced=True,
            ),
        ),
        requires=("Chiave API",),
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
        tagline="I modelli Gemini, con un piano gratuito.",
        description="I modelli Gemini tramite l'API Google AI Studio.",
        local=False,
        aliases=("google",),
        fields=(
            _api_key("GEMINI_API_KEY", "Si crea su aistudio.google.com/apikey."),
            ProviderField(
                env="GEMINI_MODEL",
                label="Modello",
                default="gemini-2.5-flash",
                placeholder="gemini-2.5-flash",
            ),
            ProviderField(
                env="GEMINI_BASE_URL",
                label="Indirizzo",
                type="url",
                default="https://generativelanguage.googleapis.com/v1beta",
                advanced=True,
            ),
            _temperature(),
        ),
        requires=("Chiave API",),
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
                    label="Modello",
                    default=model_default,
                    placeholder=model_default,
                    source="models",
                ),
                ProviderField(
                    env=f"{provider_id.upper()}_BASE_URL",
                    label="Indirizzo",
                    type="url",
                    default=base_url,
                    help="Da cambiare solo se passi da un proxy.",
                    advanced=True,
                ),
                _temperature(),
            ),
            requires=("Chiave API",),
            docs=docs,
        )
    )


_openai_like_cloud(
    "groq",
    "Groq",
    "https://api.groq.com/openai/v1",
    "llama-3.3-70b-versatile",
    "Inferenza velocissima, con un piano gratuito generoso.",
    "Si crea su console.groq.com.",
    "freemium",
    "https://console.groq.com/keys",
)

_openai_like_cloud(
    "openrouter",
    "OpenRouter",
    "https://openrouter.ai/api/v1",
    "anthropic/claude-haiku-4.5",
    "Un solo account per centinaia di modelli, alcuni gratuiti.",
    "Si crea su openrouter.ai/keys.",
    "freemium",
    "https://openrouter.ai/keys",
)

_openai_like_cloud(
    "deepseek",
    "DeepSeek",
    "https://api.deepseek.com/v1",
    "deepseek-chat",
    "Modelli economici con buone capacità di ragionamento.",
    "Si crea su platform.deepseek.com.",
    "paid",
    "https://platform.deepseek.com",
)

_openai_like_cloud(
    "mistral",
    "Mistral",
    "https://api.mistral.ai/v1",
    "mistral-small-latest",
    "Modelli europei, con un piano gratuito per sperimentare.",
    "Si crea su console.mistral.ai.",
    "freemium",
    "https://console.mistral.ai",
)

_openai_like_cloud(
    "together",
    "Together AI",
    "https://api.together.xyz/v1",
    "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    "Catalogo ampio di modelli aperti in hosting.",
    "Si crea su api.together.xyz.",
    "paid",
    "https://api.together.xyz",
)

LLM_REGISTRY.register(
    ProviderSpec(
        id="mock",
        label="Risponditore offline",
        kind="llm",
        category="test",
        pricing="free",
        tagline="Risposte predefinite, per provare la catena senza modelli.",
        description="Risposte predefinite, senza alcun modello. Utile per provare voce e animazioni.",
        local=True,
        aliases=("offline", "none"),
    )
)

# ---------------------------------------------------------------------------
# TTS — voci locali
# ---------------------------------------------------------------------------

TTS_REGISTRY.register(
    ProviderSpec(
        id="kokoro",
        label="Kokoro",
        kind="tts",
        category="local",
        pricing="free",
        recommended=True,
        tagline="Voce neurale sul tuo computer, con il lip-sync più preciso.",
        description=(
            "Sintesi neurale in-process via ONNX: nessuna rete, buona qualità e "
            "tempi esatti per ogni fonema, quindi la bocca è perfettamente a tempo."
        ),
        local=True,
        has_voices=True,
        fields=(
            ProviderField(
                env="KOKORO_MODEL",
                label="Percorso del modello",
                default="models/kokoro-v1.0.onnx",
                advanced=True,
            ),
            ProviderField(
                env="KOKORO_VOICES",
                label="Percorso delle voci",
                default="models/voices-v1.0.bin",
                advanced=True,
            ),
        ),
        requires=("Pesi Kokoro scaricati (scripts/download_models.py)",),
    )
)

TTS_REGISTRY.register(
    ProviderSpec(
        id="kokoro_http",
        label="Kokoro-FastAPI",
        kind="tts",
        category="local",
        pricing="free",
        tagline="Un server Kokoro già avviato, per esempio su GPU.",
        description="Un server Kokoro già avviato, utile se lo fai girare su GPU.",
        local=True,
        has_voices=True,
        fields=(
            ProviderField(
                env="KOKORO_HTTP_URL",
                label="Indirizzo",
                type="url",
                default="http://127.0.0.1:8880",
            ),
        ),
        requires=("Server Kokoro-FastAPI in esecuzione",),
    )
)

TTS_REGISTRY.register(
    ProviderSpec(
        id="piper",
        label="Piper",
        kind="tts",
        category="local",
        pricing="free",
        tagline="Sintesi locale leggerissima, gira su qualunque CPU.",
        description="Sintesi locale molto leggera: gira bene anche su CPU modeste.",
        local=True,
        has_voices=True,
        fields=(
            ProviderField(
                env="PIPER_MODEL",
                label="Percorso del modello .onnx",
                placeholder="models/piper/it_IT-riccardo-x_low.onnx",
                help="Le voci si scaricano da huggingface.co/rhasspy/piper-voices.",
            ),
        ),
        requires=("pip install piper-tts", "Una voce Piper scaricata"),
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
        tagline="Qualita' da record tra i modelli aperti, ma serve una GPU NVIDIA.",
        description=(
            "Il modello open source di Resemble AI: in ascolti alla cieca batte "
            "spesso anche ElevenLabs. Clona una voce da pochi secondi di audio: "
            "dalla scheda Personaggio, \"Clona una voce\". Multilingua, italiano "
            "incluso. Su CPU è troppo lento per l'uso in tempo reale."
        ),
        local=True,
        has_voices=True,
        fields=(
            ProviderField(
                env="CHATTERBOX_DEVICE",
                label="Dispositivo",
                type="select",
                default="auto",
                options=(
                    {"value": "auto", "label": "automatico"},
                    {"value": "cuda", "label": "GPU NVIDIA"},
                    {"value": "cpu", "label": "CPU (molto lento)"},
                ),
            ),
            ProviderField(
                env="CHATTERBOX_LANGUAGE",
                label="Lingua della voce predefinita",
                default="it",
                placeholder="it",
                help="Le voci clonate hanno ognuna la sua lingua, scelta quando le cloni.",
            ),
            ProviderField(
                env="CHATTERBOX_EXAGGERATION",
                label="Espressivita'",
                type="number",
                default=0.5,
                help="0 = piatta, 1 = molto marcata.",
                advanced=True,
            ),
            ProviderField(
                env="CHATTERBOX_CFG_WEIGHT",
                label="Aderenza al riferimento",
                type="number",
                default=0.5,
                help="Piu' alta = piu' fedele alla voce di riferimento, ma piu' rigida.",
                advanced=True,
            ),
        ),
        requires=("pip install chatterbox-tts", "GPU NVIDIA consigliata (~3GB di VRAM)"),
        docs="https://github.com/resemble-ai/chatterbox",
    )
)

TTS_REGISTRY.register(
    ProviderSpec(
        id="system",
        label="Voce di sistema",
        kind="tts",
        category="local",
        pricing="free",
        tagline="Le voci già installate in Windows.",
        description=(
            "Le voci già installate nel sistema operativo (SAPI su Windows, "
            "NSSpeechSynthesizer su macOS, espeak su Linux). Sempre disponibile."
        ),
        local=True,
        has_voices=True,
        aliases=("pyttsx3", "sapi"),
        requires=("pip install pyttsx3",),
    )
)

# ---------------------------------------------------------------------------
# TTS — voci in rete
# ---------------------------------------------------------------------------

TTS_REGISTRY.register(
    ProviderSpec(
        id="elevenlabs",
        label="ElevenLabs",
        kind="tts",
        category="cloud",
        pricing="freemium",
        recommended=True,
        tagline="Le voci più naturali in circolazione. Piano gratuito, poi a consumo.",
        description=(
            "Qualità altissima e voci clonate. Il companion chiede anche i tempi "
            "di ogni lettera, così il lip-sync resta preciso come con Kokoro. "
            "La verifica mostra quanti caratteri ti restano nel mese."
        ),
        local=False,
        has_voices=True,
        fields=(
            _api_key("ELEVENLABS_API_KEY", "Si crea su elevenlabs.io (Profilo -> API Keys)."),
            ProviderField(
                env="ELEVENLABS_VOICE",
                label="Voce",
                default="Rachel",
                source="voices",
                help="Nome o ID di una voce del tuo account: premi Verifica per l'elenco.",
            ),
            ProviderField(
                env="ELEVENLABS_MODEL",
                label="Modello",
                type="select",
                default="eleven_flash_v2_5",
                options=(
                    {"value": "eleven_flash_v2_5", "label": "Flash v2.5 — rapidissimo, mezzo credito a carattere"},
                    {"value": "eleven_turbo_v2_5", "label": "Turbo v2.5 — rapido, buona qualità"},
                    {"value": "eleven_multilingual_v2", "label": "Multilingual v2 — la più espressiva"},
                    {"value": "eleven_v3", "label": "v3 — emozioni e intonazione, più lento"},
                ),
            ),
            ProviderField(
                env="ELEVENLABS_STABILITY",
                label="Stabilità",
                type="number",
                default=0.5,
                help="0 = molto espressiva e variabile, 1 = sempre uguale.",
                advanced=True,
            ),
            ProviderField(
                env="ELEVENLABS_SIMILARITY",
                label="Somiglianza",
                type="number",
                default=0.75,
                help="Quanto resta fedele alla voce originale.",
                advanced=True,
            ),
            ProviderField(
                env="ELEVENLABS_STYLE",
                label="Stile",
                type="number",
                default=0.0,
                help="Esagera lo stile della voce (costa un po' di latenza).",
                advanced=True,
            ),
            ProviderField(
                env="ELEVENLABS_LANGUAGE",
                label="Lingua",
                placeholder="vuoto = automatica (es. it, en)",
                help="Forza la lingua con i modelli Flash e Turbo.",
                advanced=True,
            ),
        ),
        requires=("Chiave API",),
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
        tagline="Le voci di OpenAI, a cui puoi dire con che tono parlare.",
        description=(
            "gpt-4o-mini-tts accetta istruzioni sul tono (\"allegra, a bassa "
            "voce\"). Funziona anche con qualunque server compatibile "
            "/v1/audio/speech: basta cambiare indirizzo."
        ),
        local=False,
        has_voices=True,
        aliases=("openai-tts",),
        fields=(
            _api_key("OPENAI_TTS_API_KEY", "Si crea su platform.openai.com/api-keys."),
            ProviderField(
                env="OPENAI_TTS_VOICE",
                label="Voce",
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
                label="Modello",
                type="select",
                default="gpt-4o-mini-tts",
                options=(
                    {"value": "gpt-4o-mini-tts", "label": "gpt-4o-mini-tts — segue le istruzioni sul tono"},
                    {"value": "tts-1", "label": "tts-1 — rapido"},
                    {"value": "tts-1-hd", "label": "tts-1-hd — qualità più alta"},
                ),
            ),
            ProviderField(
                env="OPENAI_TTS_INSTRUCTIONS",
                label="Tono",
                type="textarea",
                placeholder="Parla in modo caldo e allegro, come un'amica.",
                help="Solo con gpt-4o-mini-tts.",
            ),
            ProviderField(
                env="OPENAI_TTS_BASE_URL",
                label="Indirizzo",
                type="url",
                default="https://api.openai.com/v1",
                help="Cambialo per un server compatibile (Kokoro-FastAPI, openedai-speech...).",
                advanced=True,
            ),
        ),
        requires=("Chiave API",),
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
        tagline="Centinaia di voci neurali Microsoft, 500 mila caratteri gratis al mese.",
        description=(
            "Le voci neurali di Azure, con ottime voci italiane e multilingua. Il "
            "piano gratuito (F0) basta per l'uso di tutti i giorni."
        ),
        local=False,
        has_voices=True,
        aliases=("azure_tts", "microsoft"),
        fields=(
            _api_key("AZURE_SPEECH_KEY", "Portale Azure -> risorsa Speech -> Chiavi ed endpoint."),
            ProviderField(
                env="AZURE_SPEECH_REGION",
                label="Area",
                default="westeurope",
                placeholder="westeurope",
            ),
            ProviderField(
                env="AZURE_SPEECH_VOICE",
                label="Voce",
                default="it-IT-IsabellaMultilingualNeural",
                source="voices",
                help="Premi Verifica per l'elenco completo.",
            ),
        ),
        requires=("Chiave API",),
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
        tagline="Le voci WaveNet, Neural2 e Chirp di Google, con quota gratuita mensile.",
        description=(
            "Le voci di Google Cloud Text-to-Speech. Serve una chiave API di un "
            "progetto con l'API Text-to-Speech attiva."
        ),
        local=False,
        has_voices=True,
        aliases=("google_cloud_tts", "gcloud"),
        fields=(
            _api_key("GOOGLE_TTS_API_KEY", "console.cloud.google.com -> API e servizi -> Credenziali."),
            ProviderField(
                env="GOOGLE_TTS_VOICE",
                label="Voce",
                default="it-IT-Chirp3-HD-Aoede",
                source="voices",
                help="Premi Verifica per l'elenco completo.",
            ),
        ),
        requires=("Chiave API",),
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
        tagline="Voci realistiche con latenza bassissima.",
        description="Le voci Sonic di Cartesia: molto naturali e tra le più rapide a rispondere.",
        local=False,
        has_voices=True,
        fields=(
            _api_key("CARTESIA_API_KEY", "Si crea su play.cartesia.ai/keys."),
            ProviderField(
                env="CARTESIA_VOICE",
                label="Voce",
                placeholder="ID della voce",
                source="voices",
                help="Premi Verifica per scegliere dall'elenco.",
            ),
            ProviderField(
                env="CARTESIA_MODEL",
                label="Modello",
                type="select",
                default="sonic-2",
                options=(
                    {"value": "sonic-2", "label": "Sonic 2 — qualità migliore"},
                    {"value": "sonic-turbo", "label": "Sonic Turbo — latenza minima"},
                ),
            ),
            ProviderField(
                env="CARTESIA_LANGUAGE",
                label="Lingua",
                default="it",
                placeholder="it",
            ),
        ),
        requires=("Chiave API",),
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
        tagline="Le voci neurali di Microsoft Edge, gratis e senza chiave.",
        description=(
            "Le voci neurali di Microsoft Edge: molto naturali e senza chiave, "
            "ma passano da internet e il servizio non è ufficiale."
        ),
        local=False,
        has_voices=True,
        aliases=("edge_tts",),
        fields=(
            ProviderField(
                env="EDGE_VOICE",
                label="Voce",
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
        label="Sintetizzatore a formanti",
        kind="tts",
        category="test",
        pricing="free",
        tagline="Solo vocali: serve a provare il lip-sync senza scaricare nulla.",
        description=(
            "Genera le vocali A/E/I/O/U corrette. Non è una voce vera: serve a "
            "verificare il lip-sync senza scaricare nulla."
        ),
        local=True,
        aliases=("test",),
    )
)

# ---------------------------------------------------------------------------
# STT — riconoscimento vocale
# ---------------------------------------------------------------------------

STT_REGISTRY.register(
    ProviderSpec(
        id="faster_whisper",
        label="Faster-Whisper",
        kind="stt",
        category="local",
        pricing="free",
        recommended=True,
        tagline="Whisper sul tuo computer: preciso e privato.",
        description=(
            "Whisper reimplementato con CTranslate2: molto più rapido "
            "dell'originale a parita' di qualità. È la scelta consigliata."
        ),
        local=True,
        aliases=("whisper",),
        fields=(
            ProviderField(
                env="WHISPER_MODEL",
                label="Modello",
                type="select",
                default="base",
                options=(
                    {"value": "tiny", "label": "tiny — rapidissimo, impreciso"},
                    {"value": "base", "label": "base — buon compromesso"},
                    {"value": "small", "label": "small — più accurato"},
                    {"value": "medium", "label": "medium — lento su CPU"},
                    {"value": "large-v3", "label": "large-v3 — richiede GPU"},
                ),
            ),
            ProviderField(
                env="WHISPER_DEVICE",
                label="Dispositivo",
                type="select",
                default="auto",
                options=(
                    {"value": "auto", "label": "automatico"},
                    {"value": "cpu", "label": "CPU"},
                    {"value": "cuda", "label": "GPU NVIDIA"},
                ),
            ),
            ProviderField(
                env="WHISPER_LANGUAGE",
                label="Lingua",
                default="auto",
                help="`auto` la riconosce da sola; indicarla è più preciso e rapido.",
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
        tagline="Un server whisper.cpp già avviato.",
        description="Un server whisper.cpp già avviato, utile se lo hai già in casa.",
        local=True,
        fields=(
            ProviderField(
                env="WHISPER_CPP_URL",
                label="Indirizzo",
                type="url",
                default="http://127.0.0.1:8080",
            ),
        ),
        requires=("Server whisper.cpp in esecuzione",),
    )
)

STT_REGISTRY.register(
    ProviderSpec(
        id="openai_whisper_api",
        label="Whisper via API",
        kind="stt",
        category="cloud",
        pricing="paid",
        tagline="Trascrizione in rete con un endpoint compatibile OpenAI.",
        description="Trascrizione remota con un endpoint compatibile OpenAI (OpenAI, Groq...).",
        local=False,
        fields=(
            _api_key("STT_API_KEY"),
            ProviderField(
                env="STT_BASE_URL",
                label="Indirizzo",
                type="url",
                default="https://api.openai.com/v1",
            ),
            ProviderField(env="STT_MODEL", label="Modello", default="whisper-1"),
        ),
        requires=("Chiave API",),
    )
)

STT_REGISTRY.register(
    ProviderSpec(
        id="browser",
        label="Riconoscimento del browser",
        kind="stt",
        category="cloud",
        pricing="free",
        tagline="Quello integrato in Chrome/Electron: passa dai server di Google.",
        description=(
            "Usa il riconoscimento vocale integrato in Chrome/Electron: niente da "
            "installare, ma passa dai server di Google."
        ),
        local=False,
        requires=("Chrome o Electron",),
    )
)

STT_REGISTRY.register(
    ProviderSpec(
        id="none",
        label="Disattivato",
        kind="stt",
        category="test",
        pricing="free",
        tagline="Si parla solo scrivendo.",
        description="Nessun input vocale: si parla col companion solo scrivendo.",
        local=True,
        aliases=("off", "disabled"),
    )
)
