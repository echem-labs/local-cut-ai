# LocalCut AI

A cross-platform desktop app that turns a prompt or script into a finished video — clips, narration, music, captions, thumbnail — using AI models running **locally**, with optional cloud models (Claude, GPT, Gemini, Veo, Kling…) as an upgrade path.

> CapCut's ease of use, ComfyUI's power, running on your own GPU — your footage never has to leave your machine.

## Status

🚧 Early development. The engine spike is complete — one prompt renders to a
watchable 60-second video, unattended, on an 8 GB consumer GPU (script →
storyboard → I2V clips → narration → music → assembly). The MVP feature set
is in place: word-timed captions, draft→final quality ladder (up to Wan 2.2
finals), timeline editing, scene splitting, Quick Tools, review checkpoints,
BYOK cloud providers, in-app model downloads with a first-run hardware
screen, publish-kit generation, and OTIO handoff. Editing depth is landing
next: natural-language edits ("make scene 2 darker") that patch the project
graph, and an advanced per-node inspector (seeds, model overrides, pinning)
are in. Installers build for Windows (NSIS) and Linux (AppImage/deb); macOS
beta is still to come.

## What it will do

- **Prompt → full video**: script generation, storyboard keyframes, image-to-video clips, TTS narration, music, assembly, and export — end to end.
- **Four modes, one project**: prompt-only, beginner wizard, advanced inspector, and a node/flowchart canvas — all views over the same project graph.
- **Local-first**: unlimited generation on your own hardware, with hardware-aware model recommendations. Cloud models are optional, never required.
- **Local or remote engine**: run everything on one machine, or run the engine headless on a big-GPU box and connect from a laptop.

## Repository layout

```text
engine/         Python orchestrator — story graph + compiler, job queue/scheduler,
                execution backends (headless ComfyUI, llama.cpp, FFmpeg, mock),
                hardware probe, model manifest, provider adapters, FastAPI + WS API
apps/desktop/   Electron + React frontend — talks to the engine exclusively over
                its HTTP/WS API (works identically against a remote engine)
```

## Development

**Hooks** (once, from the repo root):

```bash
uv run --project engine pre-commit install
```

Commits get `ruff check --fix` and `ruff format`; pushes additionally get the
engine suite, the desktop typecheck and the desktop tests — gated on which half
of the tree you touched, so a desktop-only push does not run pytest. CI is
Ubuntu-only while the repo is private, so a green push hook is very nearly the
same verdict CI gives. `--no-verify` skips them.

**Engine** (Python ≥3.13, [uv](https://docs.astral.sh/uv/)):

```bash
cd engine
uv sync
uv run pytest                    # test suite
uv run localcut-engine probe     # hardware profile + tier
uv run localcut-engine serve --backend mock   # API on 127.0.0.1:7830
```

`--backend mock` runs the whole pipeline with deterministic placeholder artifacts —
no GPU, models, or ComfyUI needed.

**Real models.** The backend flag takes a comma-separated chain; the first backend
that serves a node kind wins, so a trailing `mock` gives a hybrid pipeline:

```bash
uv run localcut-engine models                    # manifest + download status
uv run localcut-engine download sdxl-base-1.0    # resumable, checksummed → ~/.localcut/models
uv run localcut-engine serve --backend local,mock
```

`local` expands to `llm,comfy,kokoro,align,ffmpeg`: `llm` speaks any
OpenAI-compatible server (Ollama/llama.cpp, `LOCALCUT_LLM_URL`,
`LOCALCUT_LLM_MODEL`); `comfy` drives a headless ComfyUI on `:8188` via
workflow-JSON templates (packaged defaults for SDXL keyframes/thumbnails,
LTX-Video clips, Wan 2.2 I2V, and ACE-Step music; override per-file in
`~/.localcut/comfy-templates/`); `kokoro` synthesizes narration on CPU
(`localcut-engine download kokoro-82m`); `align` turns narration into
word-timed captions (`localcut-engine download faster-whisper-base-en`, CPU);
`ffmpeg` handles assembly/export (`LOCALCUT_FFMPEG_BIN`) — captions burn in by
default (set the export node's `captions` param to `sidecar` to keep the
`.srt` external), on-screen titles render from the screenplay, and the
timeline node's `order`/`trims`/`transitions` params drive re-cuts without
re-rendering scenes. Kinds ComfyUI serves are gated by `LOCALCUT_COMFY_KINDS`
(default `keyframe,thumbnail,clip,music`); "Finalize" re-renders at higher
steps/resolution via the same graph's `quality` parameter — and can switch
the clip model entirely (`LOCALCUT_FINAL_CLIP_MODEL=local:wan2.2-i2v-14b-fp8`
renders finals through the Wan 2.2 14B workflow on 16 GB+ GPUs). Point
ComfyUI at the shared weights dir with an `extra_model_paths.yaml` whose
`base_path` is `~/.localcut/models`.

Scene timing follows the narration: a scene whose narration outruns the clip
ceiling splits into sequential takes of the same keyframe; at assembly a
short clip may be slowed at most 15% before it loops with a crossfaded seam.
The music bed sidechain-ducks under narration by default (timeline param
`ducking: false` restores a constant-level bed), `beat_align: true` snaps
scene cuts onto the music's detected beat grid by flexing only the pad
after each line — speech is never cut — and narration nodes take a `speed`
param (0.5–1.5) for per-line pacing.
Downloads are also available through the API (`GET /models`,
`POST /models/{id}/download` with progress over `/ws`) — the desktop app's
first-run screen and Settings → model library use exactly that. Per project,
`POST /projects/{id}/package` generates a thumbnail plus an LLM
title/description/hashtags kit, and the current timeline hands off to pro
NLEs as OpenTimelineIO (`GET /projects/{id}/export/otio` — DaVinci,
Premiere via adapters) or FCPXML (`GET /projects/{id}/export/fcpxml` —
Final Cut Pro); both are serialized from the same timing authority, so
their length always matches the rendered MP4.

**Asset conditioning.** `POST /projects/{id}/assets` imports a user image as
a graph node (no filesystem shortcuts — raw bytes over the API); wiring it
into a clip's keyframe port via a `connect` patch op makes the clip animate
from your image instead of the generated keyframe. The conditioning
survives script re-runs and works from the inspector's "Use my image"
picker.

**Voice cloning (consent-gated).** Audio assets are voice samples and the
upload route refuses them without `consent=true` — an explicit affirmation
that you have the speaker's permission; that single door is the enforcement
point. A narration node whose model is `local:chatterbox` with a sample on
its `voice_ref` port synthesizes with Chatterbox TTS (MIT, runs locally);
routing is strict — a clone request never silently falls back to a stock
voice. The `chatterbox-tts` package is an optional runtime (like ComfyUI):
install it into the engine environment when its wheels support your Python.

**Prompt-based editing.** `POST /projects/{id}/edit` takes a natural-language
instruction ("make scene 2 darker", "crossfade everything", "remove scene 3")
at project or scene scope: the LLM sees a whitelisted view of the graph,
returns a constrained edit plan, and the engine compiles it into the same
validated patch ops the inspector uses — only the dirty subgraph re-renders.
Edits run on the local script LLM by default; pass `model: "cloud:…"` to
opt a single edit into a BYOK provider.

**MCP agents.** `localcut-engine mcp` serves a running engine to MCP hosts
(Claude, goose, IDE agents) over stdio: create/render/status/export,
checkpoint approval for beginner-mode projects, the prompt-based editor in
propose-then-act form (edits preview by default and land via a second tool
that requires the previewed scope and revision back), raw patch ops,
undo/redo. It is a client of the engine exactly like the automation CLI —
same `--engine`/`--token`/`--cert` flags and env vars, any doc-02 topology —
and an agent's edits compile into the same validated patch ops as everyone
else's, so the cycle check and the voice-consent gate hold. Deliberately not
exposed to agents: node-pack enabling (that's an operator's code-execution
acknowledgment), provider keys, and BYOK cloud spend — patch ops naming a
`cloud:*` model are refused, as is restoring a take that was rendered on one,
keeping that a decision made in the app. Exports are confined to one
directory (`--export-dir`, `$LOCALCUT_MCP_EXPORT_DIR`, default `~/LocalCut`):
`out_path` is a model-authored string, and an unconfined one is an arbitrary
file write. A host config for a dev checkout:

The engine must already be running (`localcut-engine serve`) — this command
is a client of it, not a second engine. Use an absolute `--project` path: an
MCP host launches the server from an arbitrary working directory.

```json
{
  "mcpServers": {
    "localcut": {
      "command": "uv",
      "args": ["run", "--project", "/path/to/local-cut-ai/engine", "localcut-engine", "mcp"],
      "env": { "LOCALCUT_TOKEN": "<the token the engine printed>" }
    }
  }
}
```

**Remote engine.** The engine is a server the app happens to launch — so it
can just as well run headless on a GPU box while a laptop drives it:

```bash
localcut-engine serve --host 0.0.0.0 --token "$(openssl rand -base64 32)"
# or, with Docker (engine + Ollama; see deploy/docker-compose.yml):
LOCALCUT_TOKEN="$(openssl rand -base64 32)" docker compose -f deploy/docker-compose.yml up -d
```

A network bind serves HTTPS with a self-signed certificate and prints a
pairing block — URL, certificate fingerprint, and a one-line pairing code.
Paste the code into Settings → Remote engine on the laptop: the frontend
pins that exact certificate (fingerprint match, both in Chromium and the
shell's own requests) and sends the token as bearer auth. Projects, models,
and renders live with the engine; the laptop is a remote control — close it
mid-batch and the box keeps rendering. `--no-tls` exists for VPN/tailnet
links that already encrypt the path; for internet use prefer a tailnet over
port forwarding.

**Cloud (BYOK).** Nodes whose `model` is `cloud:*` route to provider adapters
instead of the local chain — `cloud:claude-*` (Anthropic), `cloud:gpt-*`
(OpenAI), `cloud:gemini-*` (Google) for scripts; `cloud:kling-2.5`,
`cloud:veo-3.1-fast`, `cloud:wan-2.2-cloud` (via fal.ai) for clips. Keys come
from `LOCALCUT_ANTHROPIC_KEY` / `LOCALCUT_OPENAI_KEY` / `LOCALCUT_GEMINI_KEY`
/ `LOCALCUT_FAL_KEY` and are never persisted; `GET /providers` reports what's
configured.

**Desktop app** (Node ≥22):

```bash
cd apps/desktop
npm install
npm run dev     # vite + electron; auto-spawns the engine via uv with a fresh token
```

The desktop shell spawns and owns the engine process; set `LOCALCUT_ENGINE_CMD` /
`LOCALCUT_BACKEND` to override how it is launched.

## Packaging (Windows & Linux)

Two steps: freeze the engine with PyInstaller, then wrap it and the shell
with electron-builder — the packaged app spawns the bundled
`resources/engine/localcut-engine[.exe]` instead of `uv run`. PyInstaller
does not cross-compile: freeze on the OS you're packaging for.

```bash
cd engine
uv sync --group build
uv run pyinstaller --noconfirm localcut-engine.spec   # → engine/dist/localcut-engine/

cd ../apps/desktop
npm install
# Windows
npm run package            # → release/LocalCut Setup 0.1.0.exe (NSIS, unsigned)
npm run package:dir        # → release/win-unpacked/ only (run LocalCut.exe directly)
# Linux
npm run package:linux      # → release/*.AppImage + release/*.deb
npm run package:linux:dir  # → release/linux-unpacked/ only
```

The packaged engine defaults to the mock backend; set `LOCALCUT_BACKEND=local`
(plus ComfyUI/Ollama per the sections above) before launching to render with
real models. Windows builds are unsigned for now — SmartScreen will warn on
the installer (More info → Run anyway). Neither package bundles ffmpeg: the
engine finds one via `LOCALCUT_FFMPEG_BIN`/PATH, and on-screen titles need a
build with the `drawtext` filter (FFmpeg 7+ static builds without libharfbuzz
lack it — `GET /system` reports this as `ffmpeg_drawtext`).

## License

TBD.
