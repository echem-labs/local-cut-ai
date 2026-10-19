# Running with real models

The default backend is `mock`: the whole pipeline runs with deterministic
placeholder artifacts, no GPU or models needed. This page is about swapping in
the real ones.

## The backend chain

`--backend` takes a comma-separated chain. The first backend that serves a
node kind wins, so a trailing `mock` gives you a hybrid — real where you have
it, placeholder for the rest.

```bash
uv run localcut models                  # manifest + download status
uv run localcut download sdxl-base-1.0  # resumable, checksummed → ~/.localcut/models
uv run localcut serve --backend local,mock
```

`local` expands to this chain, in this order:

| Backend | Serves |
| --- | --- |
| `llm` | any OpenAI-compatible server — Ollama, llama.cpp (`LOCALCUT_LLM_URL`, `LOCALCUT_LLM_MODEL`) |
| `comfy` | headless ComfyUI on `:8188`, driven by workflow-JSON templates |
| `chatterbox` | voice-cloned narration, and only that — see [voices.md](voices.md) |
| `kokoro` | stock-voice narration on CPU (`localcut download kokoro-82m`) |
| `align` | word-timed captions (`localcut download faster-whisper-base-en`, CPU) |
| `ffmpeg` | assembly and export (`LOCALCUT_FFMPEG_BIN`, or LocalCut's own copy: [programs.md](programs.md)) |

`chatterbox` sits ahead of `kokoro` deliberately: it claims only
`local:chatterbox` narration, so everything else falls through to the stock
voices behind it.

## The script model

Scripts are written with the model picked under Settings > Models > Default
models. Until one is picked, the engine asks the LLM server for the text
model the first-run screen recommends for this machine, by the name
`ollama pull` takes: `qwen3:8b` on an 8 GB card, `qwen3:14b` from 10 GB.
With no GPU that fits either, it asks for `qwen3:14b`. `LOCALCUT_LLM_MODEL`
names one model for every machine instead.

If the server does not have that model, the readiness report says so by
name (`llm_model_missing`) rather than writing the script with another
model it happens to have. When the server is an Ollama, the fix is pulling
it: the Get button in Settings > Programs or in the render gate, or
`localcut programs pull ollama` from a terminal.

## Ollama

Any OpenAI-compatible server writes scripts. An Ollama of your own on
`127.0.0.1:11434` is used as it is. Without one, LocalCut can set up its own
copy on Windows x64 and Linux x64: Set up Ollama in Settings > Programs or on
the first-run screen, or `localcut programs setup ollama`. That downloads the
pinned Ollama build into `~/.localcut/programs/ollama`, starts it and pulls
the script model into `~/.localcut/models/ollama`. From then on the engine
starts it when the engine starts and stops it when the engine stops, as long
as no Ollama of yours answers at `LOCALCUT_LLM_URL` first.
[programs.md](programs.md#localcuts-own-ollama) has what it keeps, where it
logs and how it is restarted.

## ComfyUI

Packaged defaults cover SDXL keyframes and thumbnails, LTX-Video clips, Wan
2.2 I2V, and ACE-Step music. Override any of them per-file in
`~/.localcut/comfy-templates/`. Every node they use is in ComfyUI's core, so
they need no custom node pack.

On Windows x64 and Linux x64, LocalCut can set up and run its own ComfyUI:
Settings > Programs, the first-run Programs step, or `localcut programs setup
comfyui`. On Windows it is the official portable build for your graphics
card. On Linux, where ComfyUI publishes no build, it is one LocalCut puts
together from pinned pieces: a standalone Python, ComfyUI's source and the
wheels for your card's PyTorch (CUDA, ROCm or XPU), each checked against its
SHA-256, with no system Python and no sudo. A Linux machine with no card
from those vendors gets the build that runs on the processor, which works
and is much slower. Either way the copy is kept in
`~/.localcut/programs/comfyui`, started while the engine runs and stopped
with it and already pointed at LocalCut's models. A ComfyUI of your own that
answers at the address is used instead and LocalCut's copy stays stopped.
[programs.md](programs.md#localcuts-own-comfyui) has the details, including
the build for older NVIDIA drivers and what each build downloads.

On macOS and Linux for ARM, or with your own install, point ComfyUI at the shared weights
directory with an `extra_model_paths.yaml` whose `base_path` is
`~/.localcut/models`, naming the folders the engine downloads into:

```yaml
localcut:
  base_path: /home/you/.localcut/models
  checkpoints: checkpoints
  diffusion_models: diffusion_models
  text_encoders: text_encoders
  vae: vae
  clip: clip
  loras: loras
```

Settings > Programs shows this file with the engine's own models folder filled
in, ready to copy.
If ComfyUI is not on `127.0.0.1:8188` (another host, another port, a
container), `LOCALCUT_COMFYUI_URL` is the whole base URL.

`LOCALCUT_COMFY_KINDS` decides which node kinds ComfyUI is allowed to serve.
It defaults to `auto`, which claims a kind only while an installed manifest
model can serve it — so no video model means clips fall back to the still-clip
tier instead of failing. An explicit list (`keyframe,thumbnail,clip,music`) is
the static override.

## Quality ladder

"Finalize" re-renders at higher steps and resolution through the same graph's
`quality` parameter. It can also switch the clip model outright:

```bash
# 16 GB+ GPUs. The engine reads this from the environment, so it goes on the
# command that starts it — a bare assignment sets a shell variable and nothing
# more.
LOCALCUT_FINAL_CLIP_MODEL=local:wan2.2-i2v-14b-fp8 \
  uv run localcut serve --backend local,mock
```

## Timing, audio and re-cuts

Scene timing follows the narration. A scene whose narration outruns the clip
ceiling splits into sequential takes of the same keyframe; at assembly a short
clip may be slowed by at most 15% before it loops with a crossfaded seam.

A few parameters worth knowing:

- **`ducking`** (timeline) — the music bed sidechain-ducks under narration by
  default; `false` restores a constant-level bed.
- **`beat_align`** (timeline) — snaps scene cuts onto the music's detected beat
  grid by flexing only the pad after each line. Speech is never cut.
- **`speed`** (narration) — per-line pacing. Both narration backends clamp
  it to 0.5–2.0; a natural-language edit will not write past 1.5.
- **`order` / `trims` / `transitions`** (timeline) — drive re-cuts without
  re-rendering any scene.
- **`captions`** (export) — captions burn in by default; `sidecar` keeps the
  `.srt` external. On-screen titles render from the screenplay.

On-screen titles and burned-in captions both need an ffmpeg with the `ass`
filter (libass), and `GET /system` reports whether this one draws them as
`ffmpeg_drawtext`. On an ffmpeg that cannot, an export with either is refused
before it renders a scene, and the readiness report says so beforehand with
`ffmpeg_cannot_draw_text`.

## Downloads over the API

`GET /models` and `POST /models/{id}/download`, with progress over `/ws`. The
desktop app's first-run screen and Settings → model library use exactly that.
Programs work the same way, through `GET /programs` and
`POST /programs/{id}/setup`, as does pulling a model into Ollama with
`POST /programs/ollama/pull`; [programs.md](programs.md) has the details.

## Handing off to an NLE

Per project, `POST /projects/{id}/package` generates a thumbnail plus an LLM
title/description/hashtags kit. The current timeline exports as
OpenTimelineIO (`GET /projects/{id}/export/otio` — DaVinci, Premiere via
adapters) or FCPXML (`GET /projects/{id}/export/fcpxml` — Final Cut Pro).

Both are serialized from the same timing authority as the render, so their
length always matches the rendered MP4.
