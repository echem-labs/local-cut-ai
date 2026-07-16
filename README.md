# LocalCut AI

A cross-platform desktop app that turns a prompt or script into a finished video — clips, narration, music, captions, thumbnail — using AI models running **locally**, with optional cloud models (Claude, GPT, Gemini, Veo, Kling…) as an upgrade path.

> CapCut's ease of use, ComfyUI's power, running on your own GPU — your footage never has to leave your machine.

## Status

🚧 Early development — currently in the engine-spike phase: proving the spine (Electron UI ↔ Python orchestrator ↔ headless ComfyUI ↔ FFmpeg) that takes one prompt to a watchable 60-second video, unattended, on a 16 GB consumer GPU.

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
uv run localcut-engine serve --backend llm,comfy,ffmpeg,mock
```

`llm` speaks any OpenAI-compatible server (Ollama/llama.cpp, `LOCALCUT_LLM_URL`,
`LOCALCUT_LLM_MODEL`); `comfy` drives a headless ComfyUI on `:8188` via
workflow-JSON templates (packaged defaults for SDXL keyframes/thumbnails and
LTX-Video clips; override per-file in `~/.localcut/comfy-templates/`);
`ffmpeg` handles assembly/export (`LOCALCUT_FFMPEG_BIN`). Kinds ComfyUI serves
are gated by `LOCALCUT_COMFY_KINDS` (default `keyframe,thumbnail,clip`).
Point ComfyUI at the shared weights dir with an `extra_model_paths.yaml`
whose `base_path` is `~/.localcut/models`.

**Desktop app** (Node ≥22):

```bash
cd apps/desktop
npm install
npm run dev     # vite + electron; auto-spawns the engine via uv with a fresh token
```

The desktop shell spawns and owns the engine process; set `LOCALCUT_ENGINE_CMD` /
`LOCALCUT_BACKEND` to override how it is launched.

## License

TBD.
