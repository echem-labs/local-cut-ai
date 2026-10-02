# Programs

Real output needs three programs LocalCut does not ship: FFmpeg, which puts
the video together and decodes narration for caption timing; an
OpenAI-compatible LLM server, Ollama by default, which writes the script; and
ComfyUI, which draws the keyframes, animates the clips and makes the music.

The engine reports each of them as it finds them, and on Windows x64 and Linux
x64 it can download and set up its own copy of FFmpeg. Ollama and ComfyUI are
reported only, for now. Everything below happens on the machine the engine
runs on, so a desktop paired with a GPU box sees that box's programs and sets
them up there, over the same HTTP API.

## Where the engine finds FFmpeg

It runs the first of these that applies, looked up again at every use:

1. `LOCALCUT_FFMPEG_BIN`, when it is set, whether or not anything is there.
2. `<data_dir>/bin/ffmpeg` (`ffmpeg.exe` on Windows), a binary you put there
   yourself.
3. `<data_dir>/programs/ffmpeg/ffmpeg`, LocalCut's own copy. It exists only
   because someone asked for it, so it outranks an install on `PATH`.
4. `ffmpeg` on the engine's `PATH`.

ffprobe always comes from beside the ffmpeg that won, or from `PATH` when that
ffmpeg was found there. A copy that appears in either folder while the engine
runs is used from the next job on, with no restart. `PATH` is the one the
engine started with, so an installer that adds a directory to it needs an
engine restart.

## LocalCut's own copies

Each program LocalCut sets up gets one folder, `<data_dir>/programs/<id>/`,
with no admin rights and nothing written outside the data dir. Removing the
folder removes the program.

FFmpeg's copy is a month-end LGPL build from
[BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds), pinned by URL,
size and SHA-256 in `engine/src/localcut_engine/programs/programs-manifest.json`.
BtbN keeps the last build of each month for two years and deletes most others
within weeks, which is why the pin is always a month-end one. Only `ffmpeg`
and `ffprobe` are kept, beside a `program.json` that records which build they
are. There is no managed setup on macOS or on Linux for ARM: install FFmpeg
yourself there, a build with libass, or titles and burned captions will not
draw.

## The API

Every route needs the engine token, like the rest of the API.

### GET /programs

Cheap enough to call often. It runs a binary only the first time it sees it,
asks each server with a two-second timeout and keeps the answer for three
seconds, and never downloads anything.

```json
{
  "platform": "linux-x64",
  "programs_dir": "/home/me/.localcut/programs",
  "programs_bytes": 283956127,
  "disk_free_bytes": 15032385536,
  "programs": [
    {
      "id": "ffmpeg",
      "state": "ready",
      "problem": null,
      "source": "managed",
      "location": "/home/me/.localcut/programs/ffmpeg/ffmpeg",
      "setting": "LOCALCUT_FFMPEG_BIN",
      "version": "8.1.3",
      "checks": { "draws_text": true },
      "managed": {
        "location": "/home/me/.localcut/programs/ffmpeg",
        "bytes": 283956127,
        "version": "8.1.3",
        "current": true,
        "in_use": true
      },
      "setup": {
        "available": true,
        "unavailable_reason": null,
        "takes_effect": true,
        "version": "8.1.3",
        "url": "https://github.com/BtbN/FFmpeg-Builds/releases/download/...",
        "download_bytes": 137034436,
        "install_bytes": 283955728,
        "job": null,
        "last": { "job": "3f9c2a7d1e04", "outcome": "done", "reason": null, "error": null }
      }
    },
    {
      "id": "ollama",
      "state": "ready",
      "problem": null,
      "source": "default",
      "location": "http://127.0.0.1:11434/v1",
      "setting": "LOCALCUT_LLM_URL",
      "version": "0.35.0",
      "checks": { "server": "ollama", "model": "qwen3:14b", "model_present": false },
      "managed": null,
      "setup": {
        "available": false,
        "unavailable_reason": "program_not_supported",
        "takes_effect": false,
        "version": null,
        "url": null,
        "download_bytes": null,
        "install_bytes": null,
        "job": null,
        "last": null
      }
    },
    {
      "id": "comfyui",
      "state": "missing",
      "problem": "unreachable",
      "source": "default",
      "location": "http://127.0.0.1:8188",
      "setting": "LOCALCUT_COMFYUI_URL",
      "version": null,
      "checks": {},
      "managed": null,
      "setup": { "available": false, "unavailable_reason": "program_not_supported" }
    }
  ]
}
```

Top level: `platform` is the engine machine as a pin names it (`windows-x64`,
`linux-arm64`, `macos-arm64` and so on, or null for one no pin can name).
`programs_dir` is where LocalCut's copies live, resolved, and
`programs_bytes` is everything in it. `disk_free_bytes` is the free space on
that disk.

Per program, always in the order `ffmpeg`, `ollama`, `comfyui`:

- `state` is `ready`, `missing` or `broken`, and `problem` says why it is not
  ready: `not_found`, `ffprobe_missing`, `does_not_run`, `unreachable` or
  `unexpected_response`.
- `source` and `location` say where the engine looks, even when nothing is
  there: `managed` (LocalCut's copy), `configured` (set by the variable in
  `setting`), `data_dir` (`<data_dir>/bin`), `path` (found on `PATH`, or the
  bare name when it is not), or `default` (a server at its usual address).
  `location` is a path for FFmpeg and a URL for the servers.
- `version` is the release number the program reports: `8.1.3` for FFmpeg's
  `n8.1.3-9-g29e619e767`, the server's own version for Ollama and ComfyUI.
  Null when it reported none, which is the usual answer from an LLM server
  that is not Ollama.
- `checks` for FFmpeg is `draws_text`: whether it drew a title and a caption
  with LocalCut's font, through the probe an export's refusal reads. False
  means exports with titles or burned captions will refuse. For the LLM
  server it is `server` (`ollama` or `other`), the `model` scripts are
  written with, and `model_present`, null when the server does not list its
  models.
- `managed` is LocalCut's own copy when there is one: where, how many bytes,
  which version, whether it is the build pinned now (`current`), and whether
  the engine is using it (`in_use`). A copy can be there and not in use, when
  `LOCALCUT_FFMPEG_BIN` or `<data_dir>/bin` outranks it.
- `setup` is what a setup would do here. When `available` is false,
  `unavailable_reason` is `platform_not_supported` (builds are pinned for
  other machines) or `program_not_supported`, and the size fields are null.
  `takes_effect` is false when something outranks LocalCut's copy, so setting
  it up would not change what the engine runs. `download_bytes` and
  `install_bytes` are exact; a setup needs both free at once. `job` is the
  setup running now (`id`, `phase`, `done`, `total`, `bytes_per_s`), and
  `last` is how the last one in this engine's life ended (`outcome` `done`,
  `failed` or `cancelled`, with `reason` and `error` for a failure).

### POST /programs/{id}/setup

Starts a setup in the background and returns at once. It takes no body, and
nothing a client sends changes what is downloaded.

- `200 {"status": "started", "job": "<id>"}`. Progress and the outcome
  arrive over `/ws`, and the outcome stays in `setup.last` with the same job
  id.
- `200 {"status": "installed"}` when LocalCut's copy is already the pinned
  build, complete.
- `404` for an unknown program.
- `409` when a setup of it is already running, when there is no build for
  this machine, or when a render is running LocalCut's copy and the setup
  would replace it.
- `507` when the disk cannot hold the download and the unpacked copy at once.

A setup downloads the pinned archive into a scratch folder in
`<data_dir>/programs`, checks its size to the byte and its SHA-256, unpacks
only the files the pin names, and runs them where they were unpacked: both
binaries must answer `-version` and ffmpeg must get through the text probe.
Then it renames the whole folder into place, so the engine never sees an
ffmpeg without its ffprobe, and replaces an earlier copy the same way. A
failed or cancelled setup removes what it wrote before it says so, and what
an engine that stopped mid-setup left behind is cleared when it next starts.
An ffmpeg that runs and draws no text is still installed, and `done` says
`draws_text: false`.

### DELETE /programs/{id}/setup

Cancels the running setup: `200 {"ok": true}`, then `program.setup.cancelled`
once its files are gone. `409` when nothing is running, or when it is already
moving the copy into place, which takes a moment and then finishes.

### DELETE /programs/{id}

Removes LocalCut's own copy, `200 {"ok": true, "freed_bytes": N}`, and 0 when
there was none. It never touches an install of yours, on `PATH`, in
`<data_dir>/bin` or at a configured path. The engine uses the next FFmpeg it
finds from the next job on. `409` while a setup of the program runs, while a
render is running LocalCut's copy, or when another process holds one of its
files open (Windows will not move the folder then).

### Events on /ws

```json
{"type": "program.setup.progress", "program": "ffmpeg", "phase": "downloading", "done": 68157440, "total": 137034436, "bytes_per_s": 3407872}
{"type": "program.setup.done", "program": "ffmpeg", "version": "8.1.3", "location": "/home/me/.localcut/programs/ffmpeg/ffmpeg", "in_use": true, "draws_text": true}
{"type": "program.setup.failed", "program": "ffmpeg", "reason": "checksum_mismatch", "error": "the download's SHA-256 is ..."}
{"type": "program.setup.cancelled", "program": "ffmpeg"}
{"type": "program.removed", "program": "ffmpeg", "freed_bytes": 283956127}
```

`phase` runs `downloading`, `verifying`, `unpacking`, `checking`,
`installing`, and each phase is announced as it starts. `done` and `total`
are bytes of the archive while downloading and verifying, and bytes of the
kept files while unpacking; the other phases report 0 of 0. Progress is
throttled to one event every half second. `bytes_per_s` is measured over the
last few seconds of the download and is null in the other phases.

A failure's `reason` is one of `no_space`, `download_failed`,
`size_mismatch`, `checksum_mismatch`, `unpack_failed`, `does_not_run`,
`in_use` and `install_failed`. `error` is the same failure in English, for
logs and the CLI.

### In the readiness report

Where LocalCut's copy of FFmpeg would fix a row, the row's fix is
`{"type": "setup_program", "program": "ffmpeg", "size_bytes": N}`, with the
download's size. That is a `no_ffmpeg` row (assembly, or captions that need
ffmpeg to decode narration), and an `ffmpeg_cannot_draw_text` row whose
ffmpeg came from `PATH`. It is not offered where nothing is pinned for this
machine, where `LOCALCUT_FFMPEG_BIN` or `<data_dir>/bin` would still win, or
where LocalCut's copy is already the one in use.

