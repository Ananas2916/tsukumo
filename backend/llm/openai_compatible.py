"""Client for any local server with an OpenAI-compatible API.

It covers **LM Studio** (default: `http://127.0.0.1:1234/v1`), as well as
llama.cpp `server`, vLLM, text-generation-webui, gpt4free and the like: they
all use the same `POST /v1/chat/completions` endpoint with SSE streaming and
the same `GET /v1/models` for the model list.

A note on "reasoning" models (e.g. minicpm, deepseek-r1, qwq, ...)
--------------------------------------------------------------------
These models send their internal reasoning in a separate field,
``delta.reasoning_content``, BEFORE the ``delta.content`` field with the real
answer. If we took all the streamed text, the companion would also read its
"thoughts" aloud (verified in practice with LM Studio + minicpm5-2b: without
this filter sentences like "We need to respond with 'hi'..." arrive before
the real answer). Here we always ignore ``reasoning_content`` and stream only
``content``.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import AsyncIterator
from typing import Any

import httpx

from ..attachments import openai_content
from .base import LLMClient, Message, describe_error

logger = logging.getLogger(__name__)


def _error_text(body: str) -> str:
    """The OpenAI standard's ``error.message``, if there is one, instead of the whole JSON."""
    try:
        error = json.loads(body).get("error")
    except (ValueError, AttributeError):
        return body
    if isinstance(error, dict) and error.get("message"):
        return str(error["message"])
    return str(error) if isinstance(error, str) and error else body


#: The source "pill" ChatGPT puts at the end of a paragraph when it searches
#: the web. gpt4free derives it from the HTML by stripping the tags, and it
#: arrives as initial + name + "+N" glued together ("Uuefa.com+1", "CClimate
#: Data"): she would read it aloud. Only after a full stop, at the end of a
#: line, and never if it ends with a real sentence's punctuation ("Aachen è
#: bella." stays).
_SOURCE_PILL = re.compile(r"(?<=[.!?:;)])[ \t]+([A-Z])(?i:\1)[^\n]{0,40}?(?<![.!?])(?=\n|$)")


def strip_source_pills(text: str) -> str:
    return _SOURCE_PILL.sub("", text)


def _chat_models(data: list[dict[str, Any]]) -> list[str]:
    """The ids of the text models.

    gpt4free also lists the image models and the names of its providers, marked
    with ``image``/``provider``: they're no use as a brain.
    """
    return [m.get("id", "") for m in data if not m.get("image") and not m.get("provider")]


class OpenAICompatibleClient(LLMClient):
    """Generic client for OpenAI-style local servers (LM Studio and the like)."""

    name = "openai"

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:1234/v1",
        model: str = "auto",
        temperature: float = 0.7,
        api_key: str | None = None,
        timeout: float = 120.0,
        name: str | None = None,
        hint: str | None = None,
    ) -> None:
        # The same client serves LM Studio, the cloud services and Hermes: the name
        # tells the panel which of the three is answering.
        if name:
            self.name = name
        self._hint = hint
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.temperature = temperature
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        # short connect (to notice right away if the server is off),
        # long read ("reasoning" models may take a while).
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout, connect=5.0),
            headers=headers,
        )
        self._resolved_model: str | None = None if model in ("", "auto") else model

    # ------------------------------------------------------------------
    async def _resolve_model(self) -> str:
        """If the model is 'auto', it takes the first one the server has loaded."""
        if self._resolved_model:
            return self._resolved_model

        response = await self._client.get(f"{self.base_url}/models", timeout=10.0)
        response.raise_for_status()
        models = _chat_models(response.json().get("data", []))
        if not models:
            raise RuntimeError(
                f"No model loaded on {self.base_url}. "
                "Load a model in LM Studio (or your server) before talking."
            )
        self._resolved_model = models[0]
        logger.info("Model resolved automatically: %s", self._resolved_model)
        return self._resolved_model

    # ------------------------------------------------------------------
    async def stream(self, messages: list[Message]) -> AsyncIterator[str]:
        model = await self._resolve_model()
        payload = {
            "model": model,
            "messages": [{"role": m.role, "content": openai_content(m.content, m.images)} for m in messages],
            "stream": True,
            "temperature": self.temperature,
        }

        async with self._client.stream(
            "POST", f"{self.base_url}/chat/completions", json=payload
        ) as response:
            if response.status_code >= 400:
                body = (await response.aread()).decode("utf-8", "replace")[:500]
                raise RuntimeError(f"{self.base_url} answered {response.status_code}: {_error_text(body)}")

            async for line in response.aiter_lines():
                line = line.strip()
                if not line or not line.startswith("data:"):
                    continue
                data = line[len("data:") :].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk: dict[str, Any] = json.loads(data)
                except json.JSONDecodeError:
                    logger.debug("Non-JSON SSE line ignored: %r", data[:120])
                    continue

                # gpt4free and OpenRouter, with the stream already open with 200, report a
                # failure with an {"error": ...} chunk: without this check the reply would
                # end up empty and mute.
                if chunk.get("error"):
                    raise RuntimeError(f"{self.base_url}: {_error_text(data)}")

                choices = chunk.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}

                # We deliberately DON'T read delta.get("reasoning_content"):
                # see the comment at the top of the module.
                piece = delta.get("content")
                # gpt4free's ChatGPT provider sends the whole reply in a single chunk, so a
                # pill is never left broken.
                if piece and chunk.get("provider") == "ChatGPT":
                    piece = strip_source_pills(piece)
                if piece:
                    yield piece

    # ------------------------------------------------------------------
    async def health(self) -> dict[str, Any]:
        try:
            response = await self._client.get(f"{self.base_url}/models", timeout=3.0)
            response.raise_for_status()
            models = _chat_models(response.json().get("data", []))
        except Exception as exc:
            return {
                "backend": self.name,
                "ok": False,
                "model": self.model,
                "error": describe_error(exc),
                "hint": self._hint
                or "Start the local server (e.g. LM Studio: 'Developer' tab -> Start Server)",
            }

        if not models:
            return {
                "backend": self.name,
                "ok": False,
                "model": self.model,
                "error": "No model loaded",
                "hint": "Load a model in the server before talking",
            }

        loaded = self._resolved_model in models if self._resolved_model else True
        return {
            "backend": self.name,
            "ok": True,
            "model": self._resolved_model or self.model,
            "modelAvailable": loaded,
            "models": models,
            "hint": None,
        }

    # ------------------------------------------------------------------
    async def close(self) -> None:
        await self._client.aclose()
