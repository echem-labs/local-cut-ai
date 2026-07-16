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
no GPU, models, or ComfyUI needed. `--backend local` expects ComfyUI on `:8188` and
an OpenAI-compatible LLM server (Ollama/llama.cpp) on `:11434`.

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
