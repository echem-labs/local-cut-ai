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

## Checking a real render

`engine/scripts/real-render-check.py` renders one short project on real
models from start to finish and checks what comes out. Run it from `engine/`
on a machine with an NVIDIA card:

```bash
cd engine
uv run python scripts/real-render-check.py
```

It starts an engine from the checkout it sits in, on ports it picks and with
a token of its own, so a ComfyUI or Ollama of yours on the usual ports keeps
running untouched. It keeps everything in its own data dir,
`~/localcut-test/real-render` unless `--data-dir` names another (it refuses
`~/.localcut`). Then, through the engine's own routes:

1. It sets up LocalCut's FFmpeg and ComfyUI where the copy in the data dir is
   missing or is not the build pinned now (`POST /programs/{id}/setup`).
2. It downloads the models `GET /system` recommends for the machine that are
   not on disk yet, after printing every size and the free space.
3. It checks that ComfyUI's `/object_info` has every node class and input
   name the packaged workflow templates use.
4. It renders "A red fox trotting through a snowy pine forest at sunrise",
   16 s at 9:16 (`--prompt`, `--duration` and `--aspect` change it). The
   script comes from the mock and every other stage has to run on its real
   backend.
5. It checks the export: H.264 at the aspect's canvas and AAC at 48 kHz
   stereo with tracks as long as each other, every clip moving (FFmpeg's
   `freezedetect` and the PSNR between the clip's first and last frames),
   music that is not silent and a mix that has sound.
6. It stops the engine with `POST /shutdown` and checks that nothing it
   started is left running.

The thresholds are constants at the top of the script, each with a comment
on what it catches. `--script-model qwen3:8b` also sets up LocalCut's own
Ollama in the data dir and pulls that model into it, so a real model writes
the script too. `--keep-running` leaves the engine up afterwards and prints
its address and token.

Each run writes `report.json` and `summary.md` to
`<data dir>/reports/<timestamp>/`, beside the MP4, the clips, the music, a
few frames and the engine's and ComfyUI's logs. The summary has the versions
(engine commit, FFmpeg, ComfyUI with its Python and PyTorch, Ollama, the GPU
and its driver), each stage's backend and time from `GET /jobs` and each
check's verdict, ready to paste into a pull request. The exit status is the
CLI's: 0 when every check passed, 1 when a check or the render failed and 2
when the engine could not be started or reached.

The first run on an 8 GB NVIDIA card downloads about 29 GiB and keeps about
32 GiB. The five models recommended for that card (SDXL, LTX-Video,
ACE-Step, Kokoro and faster-whisper base.en) are 25 GiB of it. The rest is
ComfyUI's build for the card and FFmpeg, whose sizes
[programs.md](programs.md#localcuts-own-comfyui) gives. A card with 16 GB or
more is recommended Wan 2.2 for clips instead, 33 GiB on its own. A model
download that stops partway resumes on the next run, but a program setup
starts over. Later runs download nothing. On an RTX 3080 Laptop GPU (8 GB) a
run with everything in place takes about 6 minutes. Nearly all of that is
the render, where each of the two LTX-Video clips takes about 2 minutes.

Run it before merging a change to the ComfyUI, Ollama or FFmpeg pin (with
`--script-model` for Ollama's, since the mock script leaves Ollama out). Run
it too before merging an engine change that touches rendering: a backend, a
workflow template, the timeline, captions or the export.
