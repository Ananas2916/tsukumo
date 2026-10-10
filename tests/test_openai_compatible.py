"""The OpenAI-compatible client and GPT4Free, with lines recorded from `g4f api`.

The answers come from g4f 8.6.5 tried live (2026-10-04): no network
here, an ``httpx.MockTransport`` sends back the same lines.
"""

import asyncio
import dataclasses
import json

import httpx
import pytest

from backend.config import Settings
from backend.llm import OpenAICompatibleClient, create_chatter_llm, create_llm_client, detect
from backend.llm.openai_compatible import strip_source_pills
from backend.provider_specs import LLM_REGISTRY

BASE = "http://127.0.0.1:1337/v1"

#: The first piece of gpt-4o-mini: g4f sends the whole sentence in one go.
G4F_CHUNK = (
    'data: {"id":"chatcmpl-dFvuaFSduGZSKk2mLLFVSEV92vyu","object":"chat.completion.chunk",'
    '"created":1791109952,"model":"","provider":"ChatGPT","choices":[{"index":0,"delta":'
    '{"role":"assistant","content":"Ciao! Mi chiamo ChatGPT.","reasoning":null,'
    '"tool_calls":null},"finish_reason":null}]}'
)
G4F_STOP = (
    'data: {"id":"chatcmpl-dFvuaFSduGZSKk2mLLFVSEV92vyu","object":"chat.completion.chunk",'
    '"created":1791109952,"model":"","provider":"ChatGPT","choices":[{"index":0,"delta":'
    '{"role":"assistant","content":"","reasoning":null,"tool_calls":null},"finish_reason":"stop"}]}'
)
#: A failure with the stream already open (g4f's format_exception): the status stays 200.
G4F_STREAM_ERROR = (
    'data: {"error": {"message": "PaymentRequiredError: Error 402: No cake credits."}, "model": "auto"}'
)
#: An unknown model: 500 before the stream.
G4F_FAILED = '{"error": {"message": "Request execution failed"}, "model": "modello-inesistente"}'

G4F_MODELS = {
    "object": "list",
    "data": [
        {"id": "default", "image": False, "vision": False, "provider": False},
        {"id": "gpt-4o-mini", "image": False, "vision": True, "provider": False},
        {"id": "flux", "image": True, "vision": False, "provider": False},
        {"id": "ChatGPT", "owned_by": "ChatGPT", "image": False, "vision": False, "provider": True},
    ],
}


def _client(handler, model: str = "gpt-4o-mini") -> OpenAICompatibleClient:
    client = OpenAICompatibleClient(base_url=BASE, model=model, name="g4f")
    client._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return client


def _sse(*lines: str) -> httpx.Response:
    return httpx.Response(200, text="\n\n".join(lines) + "\n\n", headers={"content-type": "text/event-stream"})


async def _collect(client: OpenAICompatibleClient) -> list[str]:
    return [piece async for piece in client.stream([])]


def test_a_g4f_stream_is_read_like_any_openai_server():
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        return _sse(G4F_CHUNK, G4F_STOP, "data: [DONE]")

    assert asyncio.run(_collect(_client(handler))) == ["Ciao! Mi chiamo ChatGPT."]
    assert seen["body"]["model"] == "gpt-4o-mini" and seen["body"]["stream"] is True


def test_an_error_inside_the_stream_is_not_an_empty_answer():
    with pytest.raises(RuntimeError, match="No cake credits"):
        asyncio.run(_collect(_client(lambda request: _sse(G4F_STREAM_ERROR))))


def test_an_http_error_shows_the_message_not_the_whole_json():
    with pytest.raises(RuntimeError) as caught:
        asyncio.run(_collect(_client(lambda request: httpx.Response(500, text=G4F_FAILED))))
    assert str(caught.value) == f"{BASE} answered 500: Request execution failed"
    # A body that isn't JSON stays as it is.
    with pytest.raises(RuntimeError, match="502: Bad Gateway"):
        asyncio.run(_collect(_client(lambda request: httpx.Response(502, text="Bad Gateway"))))


def test_models_list_only_text_models():
    client = _client(lambda request: httpx.Response(200, json=G4F_MODELS))
    health = asyncio.run(client.health())
    assert health["ok"] is True and health["models"] == ["default", "gpt-4o-mini"]
    # `auto` takes the first text model, never a provider or an image model.
    auto = _client(lambda request: httpx.Response(200, json=G4F_MODELS), model="auto")
    assert asyncio.run(auto._resolve_model()) == "default"


#: Real answers of gpt-4o-mini (ChatGPT provider) to questions that make it
#: search the web: the source pill arrives attached to the paragraph.
@pytest.mark.parametrize(
    "raw, spoken",
    [
        ("il club parigino. Uuefa.com+1\nSe vuoi", "il club parigino.\nSe vuoi"),
        ("serie climatica considerata. IiLMeteo.it+1\n- Sole", "serie climatica considerata.\n- Sole"),
        ("intorno ai 21–22 °C. CClimate Data\nIn pratica", "intorno ai 21–22 °C.\nIn pratica"),
        ("Un'ultima cosa. Uuefa.com+1", "Un'ultima cosa."),
        # Real sentences that look like it stay whole.
        ("Mi piace. Aachen è bella.", "Mi piace. Aachen è bella."),
        ("Davvero. Ok", "Davvero. Ok"),
        ("Vedi ChatGPT. Oppure no", "Vedi ChatGPT. Oppure no"),
    ],
)
def test_chatgpt_source_pills_are_not_read_aloud(raw, spoken):
    assert strip_source_pills(raw) == spoken


def test_pills_are_stripped_only_from_the_chatgpt_provider():
    pill = G4F_CHUNK.replace("Ciao! Mi chiamo ChatGPT.", "Ha vinto il PSG. Uuefa.com+1")
    assert asyncio.run(_collect(_client(lambda request: _sse(pill)))) == ["Ha vinto il PSG."]
    other = pill.replace('"provider":"ChatGPT"', '"provider":"Gemini"')
    assert asyncio.run(_collect(_client(lambda request: _sse(other)))) == ["Ha vinto il PSG. Uuefa.com+1"]


def test_g4f_is_a_free_keyless_cloud_engine():
    spec = LLM_REGISTRY.get("g4f")
    assert spec is not None and spec.category == "cloud" and spec.pricing == "free"
    assert LLM_REGISTRY.resolve("gpt4free") == "g4f"
    fields = {field.env: field for field in spec.fields}
    assert fields["G4F_BASE_URL"].default == BASE
    # `auto` goes through g4f.dev's credit service: the default is a specific model.
    assert fields["G4F_MODEL"].default == "gemini-2.5-flash"
    assert fields["G4F_API_KEY"].secret is True


def test_the_factory_builds_g4f_without_a_key():
    base = Settings.from_env()
    options = {k: v for k, v in base.provider_options.items() if not k.startswith("G4F_")}
    settings = dataclasses.replace(base, provider_options=options)
    client = create_llm_client(settings, "gpt4free")
    assert isinstance(client, OpenAICompatibleClient)
    assert (client.name, client.base_url, client.model) == ("g4f", BASE, "gemini-2.5-flash")
    assert "Authorization" not in client._client.headers
    keyed = create_llm_client(settings, "g4f", overrides={"G4F_API_KEY": "segreto", "G4F_MODEL": "gpt-4o"})
    assert keyed._client.headers["Authorization"] == "Bearer segreto" and keyed.model == "gpt-4o"
    # It can write the chatter, with a queue of fallback models.
    brain = create_chatter_llm(settings, "g4f", "gpt-4o-mini, gemini-2.5-flash")
    assert [c.model for c in brain.clients] == ["gpt-4o-mini", "gemini-2.5-flash"]


def test_g4f_is_detected_but_never_picked_by_itself():
    assert "g4f" in detect.DETECTORS and "g4f" not in detect.AUTO_ORDER
