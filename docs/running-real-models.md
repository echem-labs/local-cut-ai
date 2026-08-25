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

`local` expands to six backends in this order:

| | |
| --- | --- |
| `llm` | any OpenAI-compatible server — Ollama, llama.cpp (`LOCALCUT_LLM_URL`, `LOCALCUT_LLM_MODEL`) |
| `comfy` | headless ComfyUI on `:8188`, driven by workflow-JSON templates |
| `chatterbox` | voice-cloned narration, and only that — see [voices.md](voices.md) |
| `kokoro` | stock-voice narration on CPU (`localcut download kokoro-82m`) |
| `align` | word-timed captions (`localcut download faster-whisper-base-en`, CPU) |
| `ffmpeg` | assembly and export (`LOCALCUT_FFMPEG_BIN`) |

`chatterbox` sits ahead of `kokoro` deliberately: it claims only
`local:chatterbox` narration, so everything else falls through to the stock
voices behind it.

## ComfyUI

Packaged defaults cover SDXL keyframes and thumbnails, LTX-Video clips, Wan
2.2 I2V, and ACE-Step music. Override any of them per-file in
`~/.localcut/comfy-templates/`.

Point ComfyUI at the shared weights directory with an `extra_model_paths.yaml`
whose `base_path` is `~/.localcut/models`.

`LOCALCUT_COMFY_KINDS` decides which node kinds ComfyUI is allowed to serve.
It defaults to `auto`, which claims a kind only while an installed manifest
model can serve it — so no video model means clips fall back to the still-clip
tier instead of failing. An explicit list (`keyframe,thumbnail,clip,music`) is
the static override.

## Quality ladder

"Finalize" re-renders at higher steps and resolution through the same graph's
`quality` parameter. It can also switch the clip model outright:

```bash
LOCALCUT_FINAL_CLIP_MODEL=local:wan2.2-i2v-14b-fp8   # 16 GB+ GPUs
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
- **`speed`** (narration, 0.5–1.5) — per-line pacing.
- **`order` / `trims` / `transitions`** (timeline) — drive re-cuts without
  re-rendering any scene.
- **`captions`** (export) — captions burn in by default; `sidecar` keeps the
  `.srt` external. On-screen titles render from the screenplay.

On-screen titles need an ffmpeg with the `drawtext` filter. FFmpeg 7+ static
builds without libharfbuzz lack it — `GET /system` reports this as
`ffmpeg_drawtext`.

## Downloads over the API

`GET /models` and `POST /models/{id}/download`, with progress over `/ws`. The
desktop app's first-run screen and Settings → model library use exactly that.

## Handing off to an NLE

Per project, `POST /projects/{id}/package` generates a thumbnail plus an LLM
title/description/hashtags kit. The current timeline exports as
OpenTimelineIO (`GET /projects/{id}/export/otio` — DaVinci, Premiere via
adapters) or FCPXML (`GET /projects/{id}/export/fcpxml` — Final Cut Pro).

Both are serialized from the same timing authority as the render, so their
length always matches the rendered MP4.
