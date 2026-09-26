"""Ambiente dei test: nessun modello, nessuna rete, niente .env dell'utente.

Le variabili vanno impostate *prima* di importare il backend: ``server.py``
legge le impostazioni quando viene importato, e ``load_dotenv`` non
sovrascrive cio' che c'e' gia' nell'ambiente.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

_STATE = tempfile.mkdtemp(prefix="tsukumo-test-")

os.environ.update(
    {
        "DC_LLM_BACKEND": "mock",
        "DC_TTS_ENGINE": "formant",
        "DC_STT_ENGINE": "none",
        "DC_STATE_DIR": _STATE,
        "DC_LLM_FALLBACK": "0",
        "DC_TTS_FALLBACK": "1",
        "DC_STATUS_INTERVAL": "60",
        # Niente ricerca dei motori installati: sonde vere e .env vero.
        "DC_DETECT_ENGINES": "0",
        # Niente commenti spontanei: meteo e notizie passano dalla rete.
        "DC_PROACTIVE": "0",
        "DC_LOG_LEVEL": "warning",
    }
)


@pytest.fixture(scope="session")
def client():
    """Un solo avvio del server per tutti i test, come nel processo vero.

    Il monitor dei motori e' globale e lega i suoi Event al primo event loop:
    un secondo TestClient (un altro loop) lo romperebbe.
    """
    from fastapi.testclient import TestClient

    from backend import server

    with TestClient(server.app) as test_client:
        yield test_client
