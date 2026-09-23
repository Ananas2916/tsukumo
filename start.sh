#!/usr/bin/env bash
# Avvio e installazione del Desk Companion su macOS / Linux.
#
#   ./start.sh --setup      installa tutto (venv, pip, npm, pesi Kokoro, build)
#   ./start.sh              avvia il backend su http://127.0.0.1:8770
#   ./start.sh --dev        backend + dev server Vite con hot reload
#   ./start.sh --electron   finestra desktop senza cornice

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
    --fp16) KOKORO_VARIANT="fp16" ;;
    --int8) KOKORO_VARIANT="int8" ;;
    *) echo "Argomento sconosciuto: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n==> %s\n' "$1"; }

python_bin() {
  if [ -x "$VENV_PY" ]; then echo "$VENV_PY"; else command -v python3 || command -v python; fi
}

if [ "$MODE" = "setup" ]; then
  step "Creo il virtualenv (.venv)"
  [ -x "$VENV_PY" ] || python3 -m venv .venv

  step "Installo le dipendenze Python"
  "$VENV_PY" -m pip install --upgrade pip
  "$VENV_PY" -m pip install -r requirements.txt

  step "Scarico i pesi di Kokoro ($KOKORO_VARIANT)"
  "$VENV_PY" scripts/download_models.py --variant "$KOKORO_VARIANT"

  step "Installo e compilo il frontend"
  (cd frontend && npm install && npm run build)

  step "Installo Electron (opzionale)"
  (cd electron && npm install)

  printf '\nSetup completato.\n'
  printf 'Copia un avatar in frontend/public/models/avatar.vrm, poi: ./start.sh\n'
  exit 0
fi

PY="$(python_bin)"

[ -f "models/kokoro-v1.0.onnx" ] || {
  echo "ATTENZIONE: pesi Kokoro mancanti -> $PY scripts/download_models.py"
  echo "            senza pesi viene usata la voce di servizio 'formant'."
}

ls frontend/public/models/*.vrm >/dev/null 2>&1 || {
  echo "ATTENZIONE: nessun .vrm in frontend/public/models/ (trascinane uno sulla finestra)."
}

case "$MODE" in
  electron)
    [ -d electron/node_modules ] || (cd electron && npm install)
    step "Apro la finestra desktop"
    (cd electron && DC_PYTHON="$PY" npm start)
    ;;
  dev)
    step "Avvio il backend in background"
    "$PY" -m backend --reload &
    BACKEND_PID=$!
    trap 'kill $BACKEND_PID 2>/dev/null || true' EXIT
    step "Avvio il dev server Vite (http://localhost:5173)"
    (cd frontend && { [ -d node_modules ] || npm install; } && npm run dev)
    ;;
  *)
    if [ ! -f frontend/dist/index.html ]; then
      echo "Frontend non compilato: lo compilo adesso."
      (cd frontend && { [ -d node_modules ] || npm install; } && npm run build)
    fi
    step "Avvio il Desk Companion su http://127.0.0.1:8770"
    exec "$PY" -m backend
    ;;
esac
