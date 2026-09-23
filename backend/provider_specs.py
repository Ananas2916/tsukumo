"""Dichiarazione di tutti i provider disponibili.

Questo modulo non importa ``config``: e' ``config`` a importare lui, per
leggere dall'ambiente ogni campo qui dichiarato. Aggiungere un motore nuovo
significa aggiungere uno ``spec`` qui e la sua implementazione nel package
corrispondente — il pannello si adegua da solo.
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
        help="Quanto e' creativa la risposta: 0 = sempre uguale, 1 = imprevedibile.",
    )


def _api_key(env: str, help_text: str = "") -> ProviderField:
    return ProviderField(
        env=env,
        label="API key",
        type="password",
        secret=True,
        help=help_text or "Non viene mai rimandata indietro dall'API del companion.",
    )


# ---------------------------------------------------------------------------
# LLM — motori locali
# ---------------------------------------------------------------------------

LLM_REGISTRY.register(
    ProviderSpec(
        id="ollama",
        label="Ollama",
        kind="llm",
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
                help="Un modello gia' scaricato con `ollama pull`.",
            ),
            ProviderField(env="OLLAMA_TIMEOUT", label="Timeout (s)", type="number", default=120.0),
            _temperature(),
        ),
        requires=("Ollama in esecuzione",),
    )
)

LLM_REGISTRY.register(
    ProviderSpec(
        id="openai",
        label="Server compatibile OpenAI",
        kind="llm",
        description=(
            "Qualunque server locale con API stile OpenAI: LM Studio, llama.cpp "
            "server, vLLM, text-generation-webui."
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
                help="`auto` usa il primo modello gia' caricato dal server.",
            ),
            _api_key("OPENAI_API_KEY", "Quasi mai necessaria per un server locale."),
            ProviderField(env="OPENAI_TIMEOUT", label="Timeout (s)", type="number", default=120.0),
            _temperature(),
        ),
    )
)

LLM_REGISTRY.register(
    ProviderSpec(
        id="openclaw",
        label="OpenClaw (agente)",
        kind="llm",
        description=(
            "Il companion diventa la voce e la faccia del tuo agente OpenClaw: "
            "stessa personalita', stessa memoria, stessi tool."
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
                help="Meglio un agente dedicato con pochi tool: il prompt e' molto piu' corto.",
            ),
            _api_key("OPENCLAW_TOKEN", "Vuoto = letto da ~/.openclaw/openclaw.json."),
        ),
        requires=("Gateway OpenClaw acceso",),
    )
)

LLM_REGISTRY.register(
    ProviderSpec(
        id="mock",
        label="Risponditore offline",
        kind="llm",
        description="Risposte predefinite, senza alcun modello. Utile per provare la catena.",
        local=True,
        aliases=("offline", "none"),
    )
)

# ---------------------------------------------------------------------------
# LLM — servizi cloud
#
# Groq, OpenRouter, DeepSeek, Mistral e Together parlano tutti l'API OpenAI:
# cambia solo l'indirizzo, quindi riusano lo stesso client. Anthropic e Gemini
# hanno invece un formato di messaggi proprio e un client dedicato.
# ---------------------------------------------------------------------------


def _openai_like_cloud(
    provider_id: str,
    label: str,
    base_url: str,
    model_default: str,
    description: str,
    signup_help: str,
) -> None:
    LLM_REGISTRY.register(
        ProviderSpec(
            id=provider_id,
            label=label,
            kind="llm",
            description=description,
            local=False,
            fields=(
                _api_key(f"{provider_id.upper()}_API_KEY", signup_help),
                ProviderField(
                    env=f"{provider_id.upper()}_MODEL",
                    label="Modello",
                    default=model_default,
                    placeholder=model_default,
                ),
                ProviderField(
                    env=f"{provider_id.upper()}_BASE_URL",
                    label="Indirizzo",
                    type="url",
                    default=base_url,
                    help="Da cambiare solo se passi da un proxy.",
                ),
                _temperature(),
            ),
            requires=("Connessione a internet", "Chiave API"),
        )
    )


_openai_like_cloud(
    "groq",
    "Groq",
    "https://api.groq.com/openai/v1",
    "llama-3.3-70b-versatile",
    "Inferenza molto rapida su hardware dedicato. Ha un piano gratuito generoso.",
    "Si crea su console.groq.com.",
)

_openai_like_cloud(
    "openrouter",
    "OpenRouter",
    "https://openrouter.ai/api/v1",
    "anthropic/claude-sonnet-4.5",
    "Un solo account per centinaia di modelli di provider diversi.",
    "Si crea su openrouter.ai/keys.",
)

_openai_like_cloud(
    "deepseek",
    "DeepSeek",
    "https://api.deepseek.com/v1",
    "deepseek-chat",
    "Modelli economici con buone capacita' di ragionamento.",
    "Si crea su platform.deepseek.com.",
)

_openai_like_cloud(
    "mistral",
    "Mistral",
    "https://api.mistral.ai/v1",
    "mistral-small-latest",
    "Modelli europei, con un piano gratuito per sperimentare.",
    "Si crea su console.mistral.ai.",
)

_openai_like_cloud(
    "together",
    "Together AI",
    "https://api.together.xyz/v1",
    "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    "Catalogo ampio di modelli aperti in hosting.",
    "Si crea su api.together.xyz.",
)

LLM_REGISTRY.register(
    ProviderSpec(
        id="anthropic",
        label="Anthropic (Claude)",
        kind="llm",
        description="I modelli Claude tramite l'API ufficiale Anthropic.",
        local=False,
        aliases=("claude",),
        fields=(
            _api_key("ANTHROPIC_API_KEY", "Si crea su console.anthropic.com."),
            ProviderField(
                env="ANTHROPIC_MODEL",
                label="Modello",
                default="claude-opus-5",
                placeholder="claude-opus-5",
                help="Alternative piu' economiche: claude-sonnet-5, claude-haiku-4-5.",
            ),
            ProviderField(
                env="ANTHROPIC_BASE_URL",
                label="Indirizzo",
                type="url",
                default="https://api.anthropic.com",
                help="Da cambiare solo se passi da un proxy.",
            ),
            ProviderField(
                env="ANTHROPIC_MAX_TOKENS",
                label="Token massimi",
                type="number",
                default=1024,
                help="Il companion risponde in poche frasi: non serve alzarlo.",
            ),
            _temperature(),
        ),
        requires=("Connessione a internet", "Chiave API"),
    )
)

LLM_REGISTRY.register(
    ProviderSpec(
        id="gemini",
        label="Google Gemini",
        kind="llm",
        description="I modelli Gemini tramite l'API Google AI Studio.",
        local=False,
        aliases=("google",),
        fields=(
            _api_key("GEMINI_API_KEY", "Si crea su aistudio.google.com/apikey."),
            ProviderField(
                env="GEMINI_MODEL",
                label="Modello",
                default="gemini-2.0-flash",
                placeholder="gemini-2.0-flash",
            ),
            ProviderField(
                env="GEMINI_BASE_URL",
                label="Indirizzo",
                type="url",
                default="https://generativelanguage.googleapis.com/v1beta",
            ),
            _temperature(),
        ),
        requires=("Connessione a internet", "Chiave API"),
    )
)

# ---------------------------------------------------------------------------
# TTS
# ---------------------------------------------------------------------------

TTS_REGISTRY.register(
    ProviderSpec(
        id="kokoro",
        label="Kokoro (locale)",
        kind="tts",
        description="Sintesi neurale in-process via ONNX. Nessuna rete, buona qualita'.",
        local=True,
        has_voices=True,
        fields=(
            ProviderField(
                env="KOKORO_MODEL",
                label="Percorso del modello",
                default="models/kokoro-v1.0.onnx",
            ),
            ProviderField(
                env="KOKORO_VOICES",
                label="Percorso delle voci",
                default="models/voices-v1.0.bin",
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
        description="Un server Kokoro gia' avviato, utile se lo fai girare su GPU.",
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
        label="Piper (locale)",
        kind="tts",
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
    )
)

TTS_REGISTRY.register(
    ProviderSpec(
        id="edge",
        label="Edge TTS",
        kind="tts",
        description=(
            "Le voci neurali di Microsoft Edge: molto naturali e senza chiave, "
            "ma passano da internet."
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
            ),
        ),
        requires=("pip install edge-tts", "Connessione a internet"),
    )
)

TTS_REGISTRY.register(
    ProviderSpec(
        id="elevenlabs",
        label="ElevenLabs",
        kind="tts",
        description="La qualita' piu' alta in circolazione, a consumo.",
        local=False,
        has_voices=True,
        fields=(
            _api_key("ELEVENLABS_API_KEY", "Si crea su elevenlabs.io."),
            ProviderField(
                env="ELEVENLABS_VOICE",
                label="Voce",
                default="Rachel",
                help="Nome o ID della voce nel tuo account.",
            ),
            ProviderField(
                env="ELEVENLABS_MODEL",
                label="Modello",
                default="eleven_multilingual_v2",
            ),
        ),
        requires=("Connessione a internet", "Chiave API"),
    )
)

TTS_REGISTRY.register(
    ProviderSpec(
        id="system",
        label="Voce di sistema",
        kind="tts",
        description=(
            "Le voci gia' installate nel sistema operativo (SAPI su Windows, "
            "NSSpeechSynthesizer su macOS, espeak su Linux). Sempre disponibile."
        ),
        local=True,
        has_voices=True,
        aliases=("pyttsx3", "sapi"),
        requires=("pip install pyttsx3",),
    )
)

TTS_REGISTRY.register(
    ProviderSpec(
        id="formant",
        label="Sintetizzatore a formanti",
        kind="tts",
        description=(
            "Genera le vocali A/E/I/O/U corrette. Non e' una voce vera: serve a "
            "verificare il lip-sync senza scaricare nulla."
        ),
        local=True,
        aliases=("test", "offline"),
    )
)

# ---------------------------------------------------------------------------
# STT — riconoscimento vocale
# ---------------------------------------------------------------------------

STT_REGISTRY.register(
    ProviderSpec(
        id="faster_whisper",
        label="Faster-Whisper (locale)",
        kind="stt",
        description=(
            "Whisper reimplementato con CTranslate2: molto piu' rapido "
            "dell'originale a parita' di qualita'. E' la scelta consigliata."
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
                    {"value": "small", "label": "small — piu' accurato"},
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
                help="`auto` la riconosce da sola; indicarla e' piu' preciso e rapido.",
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
        description="Un server whisper.cpp gia' avviato, utile se lo hai gia' in casa.",
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
        description="Trascrizione remota con un endpoint compatibile OpenAI.",
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
        requires=("Connessione a internet", "Chiave API"),
    )
)

STT_REGISTRY.register(
    ProviderSpec(
        id="browser",
        label="Riconoscimento del browser",
        kind="stt",
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
        description="Nessun input vocale: si parla col companion solo scrivendo.",
        local=True,
        aliases=("off", "disabled"),
    )
)
