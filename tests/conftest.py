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
        "DC_LOG_LEVEL": "warning",
    }
)
