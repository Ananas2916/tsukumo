#!/usr/bin/env bash
# Starts and installs Tsukumo on macOS / Linux.
#
#   ./start.sh --setup      installs everything (venv, pip, npm, Kokoro weights, build)
#   ./start.sh              starts the backend on http://127.0.0.1:8770
#   ./start.sh --dev        backend + Vite dev server with hot reload
#   ./start.sh --electron   frameless desktop window
#   ./start.sh --test       backend tests (pytest)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

VENV_PY="$ROOT/.venv/bin/python"
KOKORO_VARIANT="full"
MODE="run"

for arg in "$@"; do
  case "$arg" in
    --setup) MODE="setup" ;;
    --dev) MODE="dev" ;;
    --electron) MODE="electron" ;;
    --test) MODE="test" ;;
    --fp16) KOKORO_VARIANT="fp16" ;;
    --int8) KOKORO_VARIANT="int8" ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n==> %s\n' "$1"; }

python_bin() {
  if [ -x "$VENV_PY" ]; then echo "$VENV_PY"; else command -v python3 || command -v python; fi
}

if [ "$MODE" = "setup" ]; then
  step "Creating the virtualenv (.venv)"
  [ -x "$VENV_PY" ] || python3 -m venv .venv

  step "Installing the Python dependencies"
  "$VENV_PY" -m pip install --upgrade pip
  "$VENV_PY" -m pip install -r requirements.txt

  step "Downloading the Kokoro weights ($KOKORO_VARIANT)"
  "$VENV_PY" scripts/download_models.py --variant "$KOKORO_VARIANT"

  step "Installing and building the frontend"
  (cd frontend && npm install && npm run build)

  step "Installing Electron (optional)"
  (cd electron && npm install)

  printf '\nSetup complete. Start with: ./start.sh --electron\n'
  exit 0
fi

PY="$(python_bin)"

[ -f "models/kokoro-v1.0.onnx" ] || {
  echo "WARNING: Kokoro weights missing -> $PY scripts/download_models.py"
  echo "         without the weights the fallback 'formant' voice is used."
}

case "$MODE" in
  test)
    "$PY" -m pytest -q || { "$PY" -m pip install -r requirements-dev.txt && "$PY" -m pytest -q; }
    ;;
  electron)
    [ -d electron/node_modules ] || (cd electron && npm install)
    step "Opening the desktop window"
    (cd electron && DC_PYTHON="$PY" npm start)
    ;;
  dev)
    step "Starting the backend in the background"
    "$PY" -m backend --reload &
    BACKEND_PID=$!
    trap 'kill $BACKEND_PID 2>/dev/null || true' EXIT
    step "Starting the Vite dev server (http://localhost:5173)"
    (cd frontend && { [ -d node_modules ] || npm install; } && npm run dev)
    ;;
  *)
    if [ ! -f frontend/dist/index.html ]; then
      echo "Frontend not built: building it now."
      (cd frontend && { [ -d node_modules ] || npm install; } && npm run build)
    fi
    step "Starting Tsukumo on http://127.0.0.1:8770"
    exec "$PY" -m backend
    ;;
esac
