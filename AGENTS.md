# AGENTS.md

Guide for coding agents (Codex, Claude Code, Cursor, Copilot, Gemini CLI…) and
humans working on Tsukumo. Read this before changing code.

## What this is

A desktop companion: a Python backend (FastAPI) that turns any LLM or CLI
agent into a talking VRM character, a Three.js frontend that renders her and
her panel, and an Electron shell that makes her a transparent, always-on-top
desktop mascot on Windows. See [README.md](README.md) for the feature tour and
the HTTP/WebSocket API.

## Map

| Path | What lives there |
|---|---|
| `backend/server.py` | FastAPI app: REST, WebSocket `/ws`, engine switching, static files |
| `backend/security.py` | **Access control**: Host/Origin checks, remote token, security headers, body limits |
| `backend/phone.py`, `frontend/mobile.html`, `frontend/src/mobile/` | **Phone access**: Tailscale detection, the QR page `/api/phone`, the text-only chat page |
| `backend/pipeline.py` | `Companion`: brain stream → sentences → TTS → visemes → broadcast; cancel; echo detection |
| `backend/provider_specs.py` | Declarative registry of every engine (LLM, TTS, STT). The panel renders itself from it |
| `backend/llm/` | `cli_agents.py` (Claude Code, Codex, Antigravity, Gemini CLI… via subprocess), `openclaw.py`, `openai_compatible.py`, `ollama.py`, `anthropic.py`, `gemini.py`, `mock.py`, `detect.py` |
| `backend/tts/`, `backend/stt/` | Voice and speech-recognition engines |
| `backend/reminders.py` | Natural-language timers/reminders (IT/EN), `[[remind]]` tags, persistent store |
| `backend/proactive.py` | Spontaneous comments (time, weather, battery, YouTube, news) |
| `backend/usage.py`, `notify.py` | Agent usage limits from local files; Claude Code/Codex hooks |
| `frontend/src/main.js`, `vrm.js`, `body.js`, `flame.js`, `hud.js` | The character: rendering, procedural animation, spirit flame, docks |
| `frontend/src/panel.js`, `panel/`, `engines.js` | The panel (chat, character, agenda, work, engines) |
| `electron/main.js` | Windows, backend process, IPC, tray, **renderer hardening** |
| `electron/pet-physics.js`, `desktop.js` | Falling, sitting on windows, taskbar, sprints; Win32 via koffi |
| `scripts/build_installer.ps1` | Public Windows installer (embedded Python + electron-builder NSIS) |
| `tests/` | pytest suite (no network, no models, no user `.env`) |

## Commands

```powershell
.\start.ps1 -Setup                       # venv, pip, Kokoro weights, npm install, build
.venv\Scripts\python -m pytest -q        # backend tests (~20 s)
cd frontend; npm run build               # the backend serves frontend/dist
cd electron; npm start                   # desktop shell (spawns the backend)
python -m backend --port 8771            # a second backend for experiments
.\scripts\build_installer.ps1            # electron\dist\Tsukumo Setup <ver>.exe
```

Node 22.12+ is required by Electron 44. On this project's dev machine the env
var `ELECTRON_RUN_AS_NODE=1` may be set by tooling: run Electron with it unset.

## Conventions

- **Language.** Code comments, docstrings, log lines and the panel UI are in
  Italian; identifiers and config keys are in English. Public docs (README,
  this file, SECURITY.md, release notes) are in English. Match the surrounding
  style: explain *why*, not *what*.
- **Engines are data.** To add an engine, declare a `ProviderSpec` in
  `provider_specs.py`, implement the client in `llm/`, `tts/` or `stt/`, and
  add a test. Don't add per-engine code to the frontend.
- **Never block the event loop.** Model inference, file I/O on large files and
  subprocess waits go through `asyncio.to_thread`. `/api/health` must answer
  instantly and never touch the network.
- **Speech text is cleaned in one place**: `pipeline.clean_for_speech` (markdown,
  emoji, emoticons). Emoji become `mood`, not words.
- **Tests first for parsers.** Reminders, agent stream parsers and visemes have
  table-driven tests; extend them with real recorded lines.
- Keep dependencies minimal; optional engines are imported lazily.

## Security invariants (do not break)

The backend can drive agents that run commands, so:

1. All requests go through `SecurityMiddleware` (`backend/security.py`). Don't
   add routes that bypass it, don't reintroduce `CORS *`, and don't accept
   `Origin: null`. For remote clients only `security.public_shell` (the phone
   page's HTML and `/assets/*`) loads without the token: don't widen it.
2. Any new endpoint that changes configuration, installs something, launches
   programs or touches files outside `state/uploads` must be added to
   `LOCAL_ONLY`.
3. Write `.env` only through `config.save_dotenv` (it rejects newlines and
   invalid keys). Validate select-type permission fields against their options.
4. Secrets never reach the frontend: use `Settings.provider_public` /
   `_saved_options`, which mask them.
5. Paths received from clients are untrusted. Remote clients may only reference
   files under `state/uploads` (`security.within`).
6. Text from the internet (news, web pages, files) given to an agent must be
   framed as data, never as instructions.
7. Electron: keep `sandbox: true`, `contextIsolation: true`, the navigation
   lock, `openOutside` (http/https only) and the IPC sender check (`trusted`).
   Expose new renderer capabilities through `preload.js` only.
8. Add a test in `tests/test_security.py` for any change to these rules.

## Testing the real app without disturbing the user

- Run a throwaway backend: `DC_PORT=8771 DC_LLM_BACKEND=mock DC_TTS_ENGINE=formant
  DC_STT_ENGINE=none DC_STATE_DIR=<tmp> DC_ENV_FILE=<tmp>/test.env python -m backend --port 8771`.
  Always set `DC_STATE_DIR` and `DC_ENV_FILE`, otherwise you overwrite the
  user's `state/running.json` or `.env`.
- Drive Electron with hidden windows (`show:false, paintWhenInitiallyHidden:true`)
  and `DC_NO_SPAWN=1`, `DC_USER_DATA=<tmp>`, `DC_PORT=8771`; capture with
  `webContents.capturePage()`.

## Never commit

`.env`, `state/`, `logs/`, `models/`, `build/`, `electron/dist/`, personal
avatars or animation clips whose license forbids redistribution (the public
installer ships only the CC0 sample avatar, enforced by
`scripts/package_audit.py`).

## Releases

Bump the version in `backend/__init__.py`, `electron/package.json`,
`frontend/package.json` and the two root entries of each `package-lock.json`;
build the public installer; tag `vX.Y.Z`; publish a GitHub release with the
installer attached. Never overwrite or delete an existing release.
