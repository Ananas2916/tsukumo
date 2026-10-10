"""The tests' environment: no models, no network, none of the user's .env.

The variables must be set *before* importing the backend: ``server.py``
reads the settings when it's imported, and ``load_dotenv`` doesn't
overwrite what's already in the environment.
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
        # No search for installed engines: real probes and a real .env.
        "DC_DETECT_ENGINES": "0",
        # No spontaneous comments: weather and news go through the network.
        "DC_PROACTIVE": "0",
        "DC_LOG_LEVEL": "warning",
    }
)


@pytest.fixture(scope="session")
def client():
    """One server start for all the tests, as in the real process.

    The engine monitor is global and binds its Events to the first event loop:
    a second TestClient (another loop) would break it.
    """
    from fastapi.testclient import TestClient

    from backend import server

    class LocalClient(TestClient):
        """Like the Electron shell: from the PC itself, to 127.0.0.1 (see security.py)."""

        def websocket_connect(self, url, *args, **kwargs):
            # The TestClient would send "Host: testserver" to WebSockets too.
            if url.startswith("/"):
                url = f"ws://127.0.0.1:8770{url}"
            return super().websocket_connect(url, *args, **kwargs)

    with LocalClient(server.app, base_url="http://127.0.0.1:8770", client=("127.0.0.1", 50000)) as test_client:
        yield test_client
