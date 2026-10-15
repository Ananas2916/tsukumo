"""Parakeet engine: the spec, the factory and the transcription, with a fake onnx_asr."""

from __future__ import annotations

import sys
import types

import numpy as np
import pytest

from backend.config import Settings
from backend.providers import STT_REGISTRY
from backend.stt import create_stt_engine
from backend.stt.parakeet_engine import ParakeetSTT


class FakeModel:
    def __init__(self, text: str) -> None:
        self.text = text
        self.calls: list[tuple[int, int]] = []

    def recognize(self, waveform, *, sample_rate=16000, **_):
        self.calls.append((len(waveform), sample_rate))
        return self.text


@pytest.fixture
def fake_onnx_asr(monkeypatch):
    loaded: list[dict] = []
    model = FakeModel("Ricordami di chiamare Marco domani alle 10 e mezza.")

    def load_model(name, path=None, *, quantization=None, providers=None, **_):
        loaded.append({"name": name, "quantization": quantization, "providers": providers})
        return model

    module = types.SimpleNamespace(load_model=load_model)
    monkeypatch.setitem(sys.modules, "onnx_asr", module)
    return loaded, model


def test_spec_is_local_with_defaults():
    spec = STT_REGISTRY.get("parakeet")
    assert spec is not None and spec.local and spec.category == "local"
    fields = {f.env: f for f in spec.fields}
    assert fields["PARAKEET_MODEL"].default == "v3"
    assert fields["PARAKEET_QUANTIZATION"].default == "int8"
    assert {o["value"] for o in fields["PARAKEET_QUANTIZATION"].options} == {"int8", "none"}


@pytest.mark.parametrize(
    ("options", "name", "quantization"),
    [
        ({}, "nemo-parakeet-tdt-0.6b-v3", "int8"),
        ({"PARAKEET_MODEL": "v2"}, "nemo-parakeet-tdt-0.6b-v2", "int8"),
        ({"PARAKEET_QUANTIZATION": "none"}, "nemo-parakeet-tdt-0.6b-v3", None),
    ],
)
def test_factory_maps_options(fake_onnx_asr, options, name, quantization):
    loaded, _ = fake_onnx_asr
    engine = create_stt_engine(Settings(stt_engine="parakeet", provider_options=options))
    assert isinstance(engine, ParakeetSTT)
    engine.prepare()
    # CPU only: the GPU is left to the voice.
    assert loaded == [{"name": name, "quantization": quantization, "providers": ["CPUExecutionProvider"]}]


def test_transcribe_loads_once_and_strips(fake_onnx_asr):
    loaded, model = fake_onnx_asr
    model.text = "  Che tempo fa oggi a Genova? "
    engine = ParakeetSTT()
    audio = np.zeros(16000 * 2, dtype=np.float32)
    first = engine.transcribe(audio, language="it")
    engine.transcribe(audio)
    assert first.text == "Che tempo fa oggi a Genova?"
    assert first.duration == pytest.approx(2.0)
    assert first.meta["engine"] == "parakeet"
    assert len(loaded) == 1
    # The dry run at load time, then the two sentences.
    assert model.calls == [(8000, 16000), (32000, 16000), (32000, 16000)]


def test_clicks_skip_the_model(fake_onnx_asr):
    loaded, _ = fake_onnx_asr
    result = ParakeetSTT().transcribe(np.zeros(1000, dtype=np.float32))
    assert result.is_empty and loaded == []


def test_missing_package_falls_back_to_typing(monkeypatch):
    monkeypatch.setitem(sys.modules, "onnx_asr", None)
    assert create_stt_engine(Settings(stt_engine="parakeet")) is None
