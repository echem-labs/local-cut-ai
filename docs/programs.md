# Programs

Real output needs three programs LocalCut does not ship: FFmpeg, which puts
the video together and decodes narration for caption timing; an
OpenAI-compatible LLM server, Ollama by default, which writes the script; and
ComfyUI, which draws the keyframes, animates the clips and makes the music.

The engine reports each of them as it finds them, and on Windows x64 and Linux
x64 it can download and set up its own copy of each. Ollama's copy runs while
the engine runs, with the script model pulled into it. ComfyUI's runs the
same way: on Windows the official portable build for the machine's graphics
card, on Linux one LocalCut builds from pinned pieces, since ComfyUI
publishes no Linux build. Everything below happens on the machine the engine
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

## LocalCut's own Ollama

Ollama's copy is the standalone build from
[Ollama's own releases](https://github.com/ollama/ollama/releases), version
0.40.4. It is downloaded only when someone presses Set up. It is pinned the
same way as FFmpeg's: `ollama-windows-amd64.zip` on Windows (1.37 GiB,
1.81 GiB unpacked) and `ollama-linux-amd64.tar.zst` on Linux (1.34 GiB,
2.10 GiB unpacked). Ollama is MIT-licensed. Its licence and those of the
libraries it ships stay in `lib/ollama` beside them.

Everything in the archive is kept: the binary (`ollama.exe`, or `bin/ollama`)
and the whole `lib/ollama` tree it loads its CPU, CUDA and Vulkan libraries
from. On Linux that includes the 17 links that give those libraries their
sonames. NVIDIA cards run through CUDA. AMD and Intel cards run through
Vulkan, which the same build ships and Ollama turns on by default. Ollama's
ROCm add-on archives are not pinned, so an AMD card that Vulkan does not
cover runs on the CPU. There is no managed Ollama on macOS or on Linux for
ARM.

Ollama looks for GPUs through Vulkan at every start, beside CUDA, before it
answers anything. Where CUDA runs the NVIDIA card, that pass only finds the
same card again and any integrated graphics. Ollama drops both. So
LocalCut starts its copy with `OLLAMA_VULKAN=0` when the hardware probe
finds an NVIDIA card whose driver and compute capability Ollama 0.40.4's
CUDA libraries take: a driver of 550 or newer for compute 7.0 and up, or 570
or newer for compute 5.0 and up. Everywhere else Vulkan stays on, since it
is how an AMD or Intel card gets the GPU. It stays on too for an NVIDIA card
whose driver or compute capability nvidia-smi did not report. The engine
probes the hardware before it first starts its copy. The `ollama serve` a
setup runs to check a new build looks for every GPU it can, Vulkan included.

The engine starts its copy as `ollama serve` when the engine starts, if the
copy is there and nothing answers at `LOCALCUT_LLM_URL`. It stops the copy
and every process the copy started when it shuts down, however the stop was
asked for: it asks the copy to exit and kills it a second later if it has
not, so the engine's whole stop stays inside the ten seconds the desktop
gives it. The copy listens on
the address in `LOCALCUT_LLM_URL` (`127.0.0.1:11434` by default), which has
to be a loopback address over plain HTTP. An address on another machine is
someone else's server, so LocalCut's copy is neither offered nor started for
it. On Windows the copy gets no window. What it prints goes to
`<data_dir>/logs/ollama.log`, which starts over once it passes 5 MiB (the run
before is kept as `ollama.log.1`). The desktop's support bundle includes its
last 128 KiB.

- An Ollama of your own that answers at the address wins. LocalCut uses it
  and leaves its own copy stopped. If yours stops while LocalCut runs, start
  LocalCut's copy from Settings > Programs, or it starts the next time the
  engine does.
- Something at the address that is not Ollama is reported as `port_in_use`.
  LocalCut does not try to take the port.
- A copy that stops by itself is started again up to three times in ten
  minutes, after 1, 2 and 4 seconds. After that it is `crashed` with the
  reason and the last lines it printed, until someone starts it again.
- An engine that dies without stopping its copy leaves
  `<data_dir>/run/ollama.json` behind, naming the process. The next engine
  stops that process before it looks for a server at the address, as long as
  it is still the process that was started and runs LocalCut's binary. So an
  orphan is never taken for an install of yours. On POSIX the copy shares the
  engine's process group, which means a signal to the group (a terminal's
  Ctrl+C, the desktop quitting) reaches both.
- Jobs wait for the copy to answer when the engine starts, for a minute at
  most. A script left queued is then not written by the stand-in while
  Ollama starts.

Its models are kept in `<models_dir>/ollama` (`OLLAMA_MODELS`) with the other
weights, not in the program's folder. An update replaces that folder whole.
Removing the program keeps the models, because they are most of the download
and a reinstall would fetch them again; Settings > Storage counts them with
the rest of the models. Ollama keeps a key pair in its home folder, which for
LocalCut's copy is `<data_dir>/run/ollama-home`. Nothing is written outside
the data dir.

LocalCut's copy runs with Ollama's cloud features off (`OLLAMA_NO_CLOUD=1`),
whatever the engine's own environment says. So does the `ollama serve` a
setup starts to check the build. With them on, Ollama 0.40.4 calls
ollama.com by itself. It fetches model recommendations as it starts and
again every few hours. It also lists Ollama's cloud models and their details
as it starts. LocalCut uses none of it and tells people it goes online only
when they ask. The same setting stops the copy from running a model on Ollama's
servers. What the copy still fetches is a model someone asked for, from
Ollama's registry. An Ollama of your own keeps its own settings, which
LocalCut does not change. A cloud model you pick in it runs on Ollama's
servers.

## LocalCut's own ComfyUI

### On Windows

On Windows x64, LocalCut's ComfyUI is the official portable build from
[Comfy-Org/ComfyUI's releases](https://github.com/Comfy-Org/ComfyUI/releases),
version 0.40.0, pinned by URL, size and SHA-256. There is one per GPU vendor
(NVIDIA, AMD and Intel) and for NVIDIA a second build for older drivers. The
hardware probe picks the build. An NVIDIA card gets the usual build, on CUDA
13, when its driver is 580 or newer and the card is a Turing or newer and the
build for older drivers (CUDA 12.6, from driver 525) when nvidia-smi says it is
not. A figure the probe could not read counts as met. A machine with no card
from one of those vendors gets no build (`gpu_not_supported`). There is no
portable build for Linux or macOS. On Linux x64 LocalCut builds the same
folder itself ([below](#on-linux)); on macOS and on Linux for ARM the setup
is yours to do and the Programs screen gives the steps. ComfyUI is GPL-3.0;
LocalCut runs it as a separate program and talks to it over HTTP.

A portable build is a 7z archive, packed with the BCJ2 filter, which Python's
standard library cannot read and no pure-Python reader decodes. The same
click downloads 7-Zip's own console extractor, `7zr.exe` 26.04
(LGPL-2.1-or-later), pinned like the build in the manifest's `extractors`,
into the setup's scratch folder. It lists the archive first and the setup
refuses it unless every member sits under its one top folder, no name climbs
out with `..` or names a drive, an absolute path or an alternate data stream,
nothing is a link, no name repeats in any case and the files are the pin's
count and size. Then it unpacks the archive and the setup walks what landed,
following nothing, against the same count and size. The extractor goes with
the scratch folder. The walk and the removal of a scratch folder use Windows'
extended-length paths, since the deepest files sit more than 190 characters
inside the build.

Before the copy replaces anything, the build's own Python imports its
PyTorch and sums a few numbers on the card. A build that cannot use the card
fails the setup with `gpu_not_usable` and keeps nothing; on NVIDIA the build
for older drivers can then be asked for by name.

The copy is the whole portable folder: 61,925 files and about 4.1 GiB for
NVIDIA's usual build, 4.96 to 5.75 GiB for the others. LocalCut starts it the
way the build's own `run_nvidia_gpu.bat` does, with the address the engine
asks for, no browser, the model paths file it writes beside the copy and
every folder ComfyUI writes to while it runs in a working folder of
LocalCut's, `<data_dir>\work\comfyui`:

```
python_embeded\python.exe -s ComfyUI\main.py --windows-standalone-build
    --disable-auto-launch --listen 127.0.0.1 --port 8188
    --extra-model-paths-config <data_dir>\programs\comfyui\extra_model_paths.yaml
    --output-directory <data_dir>\work\comfyui\output
    --input-directory <data_dir>\work\comfyui\input
    --temp-directory <data_dir>\work\comfyui
    --user-directory <data_dir>\work\comfyui\user
    --previews-directory <data_dir>\work\comfyui\previews
```

Those are ComfyUI 0.40.0's own flags. `--temp-directory` names the folder
ComfyUI puts its `temp` folder in, so the scratch files land in
`<data_dir>\work\comfyui\temp`. `user` holds ComfyUI's settings and its asset
database and `previews` the previews that database makes. With all of them
outside the copy, the copy stays the pinned build at the size Settings >
Programs reports, an update replaces it without losing anything and a
removal walks only the build. [Below](#what-renders-leave-in-comfyuis-folders)
is what ComfyUI keeps in the working folder and when LocalCut deletes it.

### On Linux

ComfyUI publishes no build for Linux, so on Linux x64 LocalCut builds one of
the same shape from pieces it pins, each by URL, size and SHA-256 like
everything else here:

- a standalone CPython, 3.13.16 from
  [python-build-standalone](https://github.com/astral-sh/python-build-standalone)
  (its `install_only_stripped` build, 35,099,487 bytes), pinned in the manifest's
  `runtimes`;
- ComfyUI's source at the v0.40.0 tag, as GitHub's archive of the tag
  (12,722,767 bytes), the same release the Windows builds are;
- every wheel that ComfyUI's `requirements.txt` at that tag needs with the
  PyTorch for the card, from PyPI and PyTorch's own index. They are a lock
  per build, `engine/src/localcut_engine/programs/locks/pylock.comfyui-<build>.toml`,
  in the standard lock file format (PEP 751): exactly one wheel per package,
  with its URL, its size, its SHA-256 and the licence its own metadata
  states.

Every build has PyTorch 2.14.1:

| Lock (`build`) | PyTorch for | Wheels | Download | Unpacked | Files |
|---|---|---|---|---|---|
| `cu130` | NVIDIA, CUDA 13.0 | 103 | 3,832,985,505 | 7,035,024,767 | 50,633 |
| `cu126` (`older_drivers`) | NVIDIA, CUDA 12.6 | 103 | 4,479,183,693 | 8,093,388,773 | 50,684 |
| `rocm72` | AMD, ROCm 7.2 | 85 | 7,417,020,765 | 17,189,252,421 | 55,517 |
| `xpu` | Intel, XPU | 108 | 3,258,233,446 | 8,670,502,369 | 52,129 |
| `cpu` (`cpu`) | the processor | 84 | 1,024,764,154 | 2,282,132,615 | 49,770 |

The download counts the Python and the source; the unpacked size is the
whole copy. Both are what the setup screen shows and what a setup checks. The
usual NVIDIA build is CUDA 13, which needs a 580 driver and a Turing card or
newer, as on Windows; the build for older drivers is CUDA 12.6, from 525.
The probe finds an AMD card through rocm-smi, or without it through sysfs:
ROCm's PyTorch wheels carry the ROCm libraries they load, so the kernel's
amdgpu driver is all they need. Most Radeons on Linux have no rocm-smi.
A Radeon that reports less than 4 GiB of its own memory is an integrated one
and is left out. An Intel card is found through xpu-smi. Its PyTorch needs
Intel's GPU compute runtime and Level Zero from the distribution. Without
them the check below fails.

A machine with no card from those vendors gets the build that runs on the
processor rather than none. The Programs screen says so before the click:
it renders, but a keyframe takes minutes rather than seconds. The same build
is offered after a card's own builds could not use it (`gpu_not_usable`), on
NVIDIA after the build for older drivers and on AMD and Intel straight away.
It is asked for as `?build=cpu`. A copy of it stays that build at the
next setup, as a copy of the build for older drivers does. Windows pins no
build for the processor.

A setup downloads the Python, the source and the wheels into its scratch
folder, four at a time, each through the same download and retry as
everything else and held to its own size and digest. Then the engine unpacks
them itself: the Python into `python`, the source into `ComfyUI` and each
wheel, in the lock's order, into the Python's own site-packages. Nothing
resolves or installs a package at setup time and nothing is fetched that the
lock does not name. A wheel is a zip of the files site-packages holds, so
unpacking one is writing its members: `<name>.data/purelib` and `platlib` go
into site-packages too and `<name>.data/data` under the Python's folder.
Console scripts and C headers are left out, since nothing runs one or builds
against them. A later wheel's file replaces an earlier one's, which is what
happens to the `nvidia/__init__.py` every NVIDIA library wheel carries. A
member whose name climbs out, is absolute or would be written through a link
refuses the setup. So does a link in a wheel. The Python's and the
source's archives are checked member by member against their pins before
anything is written: every member under the top folder, no hard link or
device, every link pointing at something else inside it with nothing written
through one and the pinned count of files, bytes and links. The source's
`requirements.txt` has to be the one the lock was made from. Once everything
is in, the folder is walked and held to the build's count of files, bytes
and links.

There is no venv. A venv writes the absolute path of its interpreter into
`pyvenv.cfg` and `bin/python`, so one built in the scratch folder would point
at nothing once the folder is renamed into place. The standalone Python finds
its own files from where it is, as the portable build's embedded Python does,
so the copy moves into place whole like every other one.

The device check is the one Windows has, run by the copy's own Python. The
processor's build sums on the processor and its `done` says `device: "CPU"`.
LocalCut starts the copy the way it starts the portable build, without the
Windows flag:

```
python/bin/python3 -s -E ComfyUI/main.py --disable-auto-launch
    --listen 127.0.0.1 --port 8188
    --extra-model-paths-config <data_dir>/programs/comfyui/extra_model_paths.yaml
    --output-directory <data_dir>/work/comfyui/output
    --input-directory <data_dir>/work/comfyui/input
    --temp-directory <data_dir>/work/comfyui
    --user-directory <data_dir>/work/comfyui/user
    --previews-directory <data_dir>/work/comfyui/previews
```

`-E` keeps a `PYTHONPATH` or `PYTHONHOME` set for another project out of it.
The processor's build adds `--cpu`. A frozen engine runs it with the
`LD_LIBRARY_PATH` the engine itself was started with, not the one PyInstaller
points at the engine's own libraries. The first start compiles every module
it imports and keeps the bytecode beside them, so the copy grows past the
size its setup recorded: by 105 MB for the CUDA 13 build.

Everything a lock names is downloaded on the click, onto the engine's
machine, from the index that publishes it. Nothing of it ships in
LocalCut's installer. These are the files `pip install` fetches for ComfyUI
and that card's PyTorch. ComfyUI itself, its frontend, its docs and
`comfy-aimdo` are GPL-3.0; the frontend and `comfy-aimdo` state no licence in
their metadata; their repositories say GPL-3.0. PyTorch, torchvision,
NumPy, SciPy and most of the rest are BSD, MIT, Apache-2.0, PSF or MPL-2.0.
The standalone Python is PSF-2.0, with the licences of the libraries it
bundles listed in its own `PYTHON.json`. The CUDA builds bring NVIDIA's CUDA
libraries (cuBLAS, cuDNN, NCCL and the rest) under NVIDIA's proprietary
licence, which allows redistributing them with an application. The XPU build
brings Intel's oneAPI runtime under the Intel Simplified Software License and
the ROCm build's PyTorch carries AMD's ROCm libraries, mostly MIT. Each lock
names each wheel's licence.

When ComfyUI's pin moves, the locks move with it:

```bash
cd engine
uv run python scripts/lock-comfyui-linux.py --comfyui 0.40.0 \
    --python 3.13.16 --python-release 20261013 --torch 2.14.1
```

It needs `uv` on `PATH`. It resolves the new tag's `requirements.txt` with
`uv pip compile --torch-backend <backend> --generate-hashes --only-binary
:all:` for each build, keeps the wheel CPython 3.13.16 on x86_64 Linux
prefers for each package, reads what each wheel unpacks to from its zip
directory with Range requests and writes the locks and the linux-x64 assets
in `programs-manifest.json`. `test_programs_comfyui_linux.py` fails until it
has run: every lock has to be the lock for the ComfyUI version and source
archive pinned, meet every requirement of that source's `requirements.txt`
and hold only wheels that install on the target.

### Running it

`extra_model_paths.yaml` points ComfyUI at `<data_dir>/models`. A start
writes it again whenever it would say something else, so it follows the
models folder if that moves. Every node the workflow templates use is in
ComfyUI's core, so no custom node pack is installed.

The copy runs the way Ollama's does: started with the engine when nothing
answers at `LOCALCUT_COMFYUI_URL`, stopped with it, restarted within the same
limit, logged to `<data_dir>/logs/comfyui.log` and left stopped when a
ComfyUI of your own answers at the address. Its first start loads PyTorch and
every node, so it has ten minutes to answer rather than one and jobs wait
for it when the engine starts.

## What renders leave in ComfyUI's folders

ComfyUI keeps every file a workflow saves in its `output` folder and every
image sent to it in its `input` folder. The engine fetches each result into
the project over HTTP, so what ComfyUI kept is a second copy LocalCut never
reads again. A 60-second video is nine clips, their keyframes and a music
bed, so a few projects come to gigabytes.

Every render saves its files under `localcut/` in ComfyUI's output folder,
named with a token of its own, such as
`localcut/keyframe_3f9c2a7d1e04_00001_.png`. A clip sends its keyframe to
`localcut/` in the input folder. An imported workflow's save nodes get the
same: `localcut/` in front of their `filename_prefix` and the token after it.
The token also makes ComfyUI save again for a render it has seen before. Its
cache would otherwise answer with the file an earlier render wrote, which
LocalCut's own copy has deleted by then.

In LocalCut's own copy the engine deletes:

- the files a render wrote under `output/localcut` once the render is done
  with them: its result is in the project, or it failed and nothing will
  fetch them;
- the keyframe a clip sent to `input/localcut` once that clip's render is
  done;
- when the engine starts, whatever in `output/localcut`, `input/localcut` and
  `temp` was last written before that start. A render an earlier engine never
  finished (cancelled, failed or cut off when it stopped) leaves files there
  that nothing will fetch.

ComfyUI empties `temp` itself each time it starts and stops. LocalCut deletes
only regular files inside the working folder and treats the filename and
subfolder ComfyUI reports as untrusted text. A name with `..`, a separator, a
drive or an absolute path deletes nothing. A link is neither followed nor
removed. An output is deleted only when it is under `localcut/` with the
render's own token in its name. A file in `output` or `input` that is not
under `localcut/`, such as an image you made in the copy's own page in a
browser, is never touched. `user` and `previews` are left alone too.

What is left shows in Settings > Storage as ComfyUI's working files, with a
button that clears it. Over the API that is `comfyui_bytes` in `GET
/storage` (null when LocalCut's copy has never run on that engine) and
`POST /storage/comfyui/cleanup`, which answers `{"ok": true, "freed_bytes":
N}` or `409` while a render is using LocalCut's copy. Removing the program
leaves the working folder where it is.

A ComfyUI of your own, on this machine or another, is never touched. Its
folders are yours. On another machine the engine could not reach them
anyway. LocalCut leaves its renders under `localcut/` in that ComfyUI's `output`
folder and the keyframes it sent under `localcut/` in its `input` folder.
Every result is already in its project, so you can delete both whenever you
like.

## The API

Every route needs the engine token, like the rest of the API.

### GET /programs

Cheap enough to call often. It runs a binary only the first time it sees it,
asks each server with a two-second timeout and keeps the answer for three
seconds, and never downloads anything. A kept answer is dropped early when a
setup or a pull ends, or when LocalCut's copy of the server starts or stops.
A server's row reads its `setup` and `managed.server` before the server is
asked, so a row that says a setup or a pull has ended reports the server as it
answered after the end.

```json
{
  "platform": "linux-x64",
  "programs_dir": "/home/me/.localcut/programs",
  "programs_bytes": 284840101,
  "disk_free_bytes": 15032385536,
  "bin_dir": "/home/me/.localcut/bin",
  "models_dir": "/home/me/.localcut/models",
  "programs": [
    {
      "id": "ffmpeg",
      "state": "ready",
      "problem": null,
      "source": "managed",
      "location": "/home/me/.localcut/programs/ffmpeg/ffmpeg",
      "setting": "LOCALCUT_FFMPEG_BIN",
      "version": "9.0.2",
      "checks": { "draws_text": true },
      "managed": {
        "location": "/home/me/.localcut/programs/ffmpeg",
        "bytes": 284840101,
        "version": "9.0.2",
        "current": true,
        "in_use": true
      },
      "setup": {
        "available": true,
        "unavailable_reason": null,
        "takes_effect": true,
        "version": "9.0.2",
        "url": "https://github.com/BtbN/FFmpeg-Builds/releases/download/...",
        "download_bytes": 137863452,
        "install_bytes": 284839696,
        "gpu": null,
        "build": null,
        "builds": [],
        "job": null,
        "last": { "job": "3f9c2a7d1e04", "outcome": "done", "reason": null, "error": null, "build": null }
      }
    },
    {
      "id": "ollama",
      "state": "ready",
      "problem": null,
      "source": "managed",
      "location": "http://127.0.0.1:11434/v1",
      "setting": "LOCALCUT_LLM_URL",
      "version": "0.40.4",
      "checks": { "server": "ollama", "model": "qwen3:8b", "model_present": true },
      "managed": {
        "location": "/home/me/.localcut/programs/ollama",
        "bytes": 2255368362,
        "version": "0.40.4",
        "current": true,
        "in_use": true,
        "server": {
          "state": "running",
          "reason": null,
          "error": null,
          "pid": 48211,
          "url": "http://127.0.0.1:11434",
          "restarts": 0,
          "log": "/home/me/.localcut/logs/ollama.log"
        }
      },
      "setup": {
        "available": true,
        "unavailable_reason": null,
        "takes_effect": true,
        "version": "0.40.4",
        "url": "https://github.com/ollama/ollama/releases/download/v0.40.4/ollama-linux-amd64.tar.zst",
        "download_bytes": 1436408810,
        "install_bytes": 2255368362,
        "gpu": null,
        "build": null,
        "builds": [],
        "pull": null,
        "job": null,
        "last": { "job": "7497cc9940ae", "outcome": "done", "reason": null, "error": null, "build": null }
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
      "setup": {
        "available": true,
        "unavailable_reason": null,
        "takes_effect": true,
        "version": "0.40.0",
        "url": "https://github.com/Comfy-Org/ComfyUI/archive/refs/tags/v0.40.0.tar.gz",
        "download_bytes": 3832985505,
        "install_bytes": 7035024767,
        "gpu": "nvidia",
        "build": null,
        "builds": [
          { "build": "older_drivers", "download_bytes": 4479183693, "install_bytes": 8093388773 },
          { "build": "cpu", "download_bytes": 1024764154, "install_bytes": 2282132615 }
        ],
        "job": null,
        "last": null
      }
    }
  ]
}
```

Top level: `platform` is the engine machine as a pin names it (`windows-x64`,
`linux-arm64`, `macos-arm64` and so on, or null for one no pin can name).
`programs_dir` is where LocalCut's copies live, resolved, and
`programs_bytes` is the disk its copies take, each as its setup recorded it
(a setup still running is not counted). `disk_free_bytes` is the free space on
that disk. `bin_dir` is `<data_dir>/bin`, where an FFmpeg you put there
yourself outranks LocalCut's copy, and `models_dir` is where the engine keeps
model weights, the folder ComfyUI's `extra_model_paths.yaml` points at. Both
are resolved paths on the engine's machine, for the steps of setting a
program up by hand.

Per program, always in the order `ffmpeg`, `ollama`, `comfyui`:

- `state` is `ready`, `missing` or `broken`, and `problem` says why it is not
  ready: `not_found`, `ffprobe_missing`, `does_not_run`, `unreachable` or
  `unexpected_response`.
- `source` and `location` say where the engine looks, even when nothing is
  there: `managed` (LocalCut's copy; for a server, LocalCut's copy is the
  one answering), `configured` (set by the variable in `setting`), `data_dir`
  (`<data_dir>/bin`), `path` (found on `PATH`, or the bare name when it is
  not), or `default` (a server at its usual address). `location` is a path
  for FFmpeg and a URL for the servers.
- `version` is the release number the program reports: `9.0.2` for FFmpeg's
  `n9.0.2-17-g2a571b6068`, the server's own version for Ollama and ComfyUI.
  Null when it reported none, which is the usual answer from an LLM server
  that is not Ollama.
- `checks` for FFmpeg is `draws_text`: whether it drew a title and a caption
  with LocalCut's font, through the probe an export's refusal reads. False
  means exports with titles or burned captions will refuse. For the LLM
  server it is `server` (`ollama` or `other`), the `model` scripts are
  written with and `model_present`. That is null when a server that is not
  Ollama lists no models (plenty serve chat without listing). An Ollama lists
  every model it has, so its empty list is `false`.
- `managed` is LocalCut's own copy when there is one: where, how many bytes
  it took when it was set up (the figure its setup recorded, so the report
  never walks ComfyUI's tens of thousands of files), which version and which
  `build`, whether it is the build pinned now for its line (`current`; a
  copy of the build for older drivers is compared with that build) and
  whether the engine is using it (`in_use`). A copy can be there and not in
  use, when `LOCALCUT_FFMPEG_BIN` or `<data_dir>/bin` outranks it, or for
  Ollama and ComfyUI when a server of your own answers at the address. A program LocalCut runs as a
  server adds `server`: its `state` (`stopped`, `starting`, `running` or
  `crashed`), the `reason` it is stopped or crashed (`own_server`, `stopped`,
  `port_in_use`, `cannot_start`, `no_answer` or `exited`) with `error` in
  English, its `pid` while it runs, the `url` it answers at, `restarts` (how
  many times it was started again since it was last started on request) and
  its `log`.
- `setup` is what a setup would do here. When `available` is false,
  `unavailable_reason` is `platform_not_supported` (builds are pinned for
  other machines), `program_not_supported`, or `gpu_not_supported` (the
  builds are per GPU vendor and this machine has no card from one of them)
  and the size fields are null. `takes_effect` is false when something
  outranks LocalCut's copy, so setting it up would not change what the
  engine runs, which for Ollama and ComfyUI is an address on another
  machine. `download_bytes` and `install_bytes` are exact; a setup needs both
  free at once and `download_bytes` counts the extractor a 7z comes with, or
  for ComfyUI on Linux the Python, the source and every wheel. For Ollama, `pull` is the model a setup
  would pull into LocalCut's copy and about how much disk it takes (`bytes`,
  the model catalog's figure, or null for a model the catalog does not hold),
  or null when the copy has it already. `job` is the setup running now (`id`,
  `phase`, `done`, `total`, `bytes_per_s`, `build`) and `last` is how the
  last one in this engine's life ended (`outcome` `done`, `failed` or
  `cancelled`, with `reason` and `error` for a failure and the `build` it
  set up).
- `setup.gpu`, `setup.build` and `setup.builds` say which build a setup
  would fetch, for a program pinned per GPU vendor: the vendor (`nvidia`,
  `amd`, `intel`), which of that vendor's builds (null for the usual one,
  `older_drivers` for NVIDIA's build for older drivers) and the vendor's
  other builds, each with its `build` and sizes, which a client can ask for
  instead. On Linux the processor's build (`cpu`, with `gpu` null) comes
  last among those and is the one a machine with no card from those
  vendors gets. For FFmpeg and Ollama they are null, null and empty. The
  report above is Linux's; on a Windows machine with an NVIDIA card on a
  current driver, ComfyUI's reads:

  ```json
  {
    "available": true,
    "unavailable_reason": null,
    "takes_effect": true,
    "version": "0.40.0",
    "url": "https://github.com/Comfy-Org/ComfyUI/releases/download/v0.40.0/ComfyUI_windows_portable_nvidia.7z",
    "download_bytes": 2010504119,
    "install_bytes": 4421748361,
    "gpu": "nvidia",
    "build": null,
    "builds": [
      { "build": "older_drivers", "download_bytes": 1902221251, "install_bytes": 5596292364 }
    ],
    "job": null,
    "last": null
  }
  ```

### POST /programs/{id}/setup

Starts a setup in the background and returns at once. It takes no body, and
nothing a client sends names what is downloaded. A program with more than
one build for this machine's card takes `?build=` with one of their names
(`older_drivers`, ComfyUI's NVIDIA build for older drivers, or `cpu`, its
Linux build for the processor), which picks between the builds pinned for
that card and nothing else. Without it the
engine picks and a copy already set up from another build keeps that
build.

- `200 {"status": "started", "job": "<id>"}`. Progress and the outcome
  arrive over `/ws`, and the outcome stays in `setup.last` with the same job
  id.
- `200 {"status": "installed"}` when LocalCut's copy is already the pinned
  build and complete. For Ollama it has to be running with the script model
  too.
- `404` for an unknown program.
- `409` when a setup of it is already running, when there is no build for
  this machine (or none by the name asked for, for its card), or when a
  render is running LocalCut's copy and the setup would replace it.
- `422` for a `build` that is not a build's name.
- `507` when the disk cannot hold the download and the unpacked copy at once.
  For Ollama the model it pulls has to fit too, on the disk that holds
  `models_dir`.

A setup downloads the pinned archive into a scratch folder in
`<data_dir>/programs`, checks its size to the byte and its SHA-256, unpacks
only the files the pin names, and runs them where they were unpacked: both
binaries must answer `-version` and ffmpeg must get through the text probe.
Then it renames the whole folder into place, so the engine never sees an
ffmpeg without its ffprobe, and replaces an earlier copy the same way. A
failed or cancelled setup removes what it wrote before it says so. What an
engine that stopped mid-setup left behind is deleted while the next engine
serves. A deletion under way when the engine stops (a half-unpacked ComfyUI
is tens of thousands of files) stops between files, so the engine exits
inside the time the desktop gives it. The next start carries on with it.
An ffmpeg that runs and draws no text is still installed, and `done` says
`draws_text: false`.

A ComfyUI build is unpacked whole by the extractor it was downloaded with
and checked as [above](#on-windows), or on Linux built from its Python, its
source and its wheels as [above](#on-linux). Its PyTorch has to use the card
before anything is replaced. Then, like Ollama, it goes on to
`starting`, which has ten minutes for a first start. `done` names the card
PyTorch found as `device`, or `CPU` for the processor's build.

Ollama's check is a real start. The unpacked `ollama serve` runs on a free
loopback port with an empty model store and has to answer `/api/version`
within a minute, which loads its libraries and looks at the GPUs. A running
copy is stopped before its folder is replaced. Once the new one is in place
the setup goes on to `starting` it, which has to answer, then to `pulling`
the script model into it through Ollama's `/api/pull` unless the copy has it
already. A server of your own at the address skips both: LocalCut leaves it
and its models alone, so `done` says `in_use: false`.

Cancelling or failing after the copy is in place leaves it there. Ollama is
set up then and the model is not, so setting up again pulls only what is
missing. Setting up a copy that is already the pinned build starts it and
pulls, where either is left to do. Each layer Ollama names is held against
the free space where the copy keeps its models. The pull stops with
`no_space` before it would fill the disk.

A download that stops partway picks up where it stopped. When the connection
is closed or reset before the archive is complete, or nothing arrives for two
minutes, the setup asks for the rest with a `Range` request starting at the
first byte it does not have. It adds what comes back only from a `206` whose
`Content-Range` starts at that byte. A `200` with the whole file starts the
download over, and a `206` from any other byte is thrown away along with the
partial download, so the next attempt asks for the whole file. A server that
answers `429`, `500`, `502`, `503` or `504`, or a host name that does not
resolve, is asked again the same way, after the wait a `Retry-After` names
(up to a minute) where the server sends one. Attempts go on for as long as
each one brings new bytes. Six in a row that bring none fail the setup with
`download_failed`, after waits of 1, 2, 4, 8 and 16 seconds between them, and
it can be cancelled during a wait like at any other point. Any other status
fails it on the first answer: `404` or `410` with `download_gone`, because the
pinned build is no longer where it was published, and the rest with
`download_failed`. However many attempts it took, the size and the SHA-256 of
the whole archive are what decide whether it is the pinned build. Model
downloads ask again by the same rules.

### POST /programs/{id}/pull

Pulls a model through the Ollama that answers at `LOCALCUT_LLM_URL`
(LocalCut's copy or your own) and returns at once. It reports like a setup:
a job with the one phase `pulling`, over the same events. This is the fix for
the most common gap after installing Ollama by hand, where it runs without
the model. The body is optional. `{"model": "qwen3:8b"}` names a model the
way `ollama pull` takes it, checked against that form. Without one it is the
model scripts are written with.

- `200 {"status": "started", "job": "<id>", "model": "qwen3:8b"}`.
- `200 {"status": "present", "model": "qwen3:8b"}` when the server has it.
- `409` when no Ollama answers at the address, when a setup or pull of it is
  already running, or for a program with no models (`ffmpeg`, `comfyui`).
- `422` for a model name `ollama pull` would not take.
- `507` when LocalCut's copy is the server and the catalog's figure for the
  model does not fit. A server of your own keeps its models where LocalCut
  cannot measure, so it is left to say so itself.

### POST /programs/{id}/start and POST /programs/{id}/stop

Start LocalCut's copy of a server program and answer once it answers or has
given up, a minute at most, or stop it and every process it started. Both
answer with the copy's state, the same object as `managed.server`. A copy
that was stopped stays stopped until it is started again or the engine
restarts. Starting gives a crashed copy its restarts back. `409` for a
program LocalCut does not run as a server or a copy that is not set up, or a
stop while a script job is using it.

### GET /programs/{id}/log

The last 128 KiB of what LocalCut's copy of a server printed, as text, for a
support bundle. Empty when it never ran.

### DELETE /programs/{id}/setup

Cancels the running setup: `200 {"ok": true}`, then `program.setup.cancelled`
once its files are gone. `409` when nothing is running, or when it is already
moving the copy into place, which takes a moment and then finishes.

### DELETE /programs/{id}

Removes LocalCut's own copy, `200 {"ok": true, "freed_bytes": N}`, and 0 when
there was none. It never touches an install of yours, on `PATH`, in
`<data_dir>/bin` or at a configured path. The engine uses the next FFmpeg it
finds from the next job on. LocalCut's Ollama is stopped first. The models it
pulled stay in `<models_dir>/ollama` and ComfyUI's working folder stays in
`<data_dir>/work/comfyui`. `409` while a setup of the program
runs, while a render is running LocalCut's copy, or when another process
holds one of its files open (Windows will not move the folder then).

### Events on /ws

```json
{"type": "program.setup.progress", "program": "ffmpeg", "phase": "downloading", "done": 68157440, "total": 137863452, "bytes_per_s": 3407872}
{"type": "program.setup.done", "program": "ffmpeg", "version": "9.0.2", "location": "/home/me/.localcut/programs/ffmpeg/ffmpeg", "in_use": true, "draws_text": true}
{"type": "program.setup.failed", "program": "ffmpeg", "reason": "checksum_mismatch", "error": "the download's SHA-256 is ..."}
{"type": "program.setup.cancelled", "program": "ffmpeg"}
{"type": "program.removed", "program": "ffmpeg", "freed_bytes": 284840101}
{"type": "program.setup.done", "program": "ollama", "version": "0.40.4", "location": "/home/me/.localcut/programs/ollama/bin/ollama", "in_use": true, "draws_text": null, "model": "qwen3:8b"}
{"type": "program.server", "program": "ollama", "state": "running", "reason": null}
```

`phase` runs `downloading`, `verifying`, `unpacking`, `checking` and
`installing`, then for Ollama `starting` and `pulling` and for ComfyUI
`starting`. Each phase is announced as it starts. A pull on its own is the
one phase `pulling`. `done` and `total` are bytes of the archive while
downloading and verifying (with the extractor's for a 7z; for ComfyUI on Linux
they are every file it downloads, counted together) and bytes of the kept
files while unpacking, which for a tree the extractor unpacks move with the
percentage it reports and for ComfyUI on Linux count every file written into
the copy. While pulling they are bytes of
every layer Ollama has named so far, so a pull's total grows as it finds
them. The other
phases report 0 of 0. Progress is throttled to one event every half second.
`bytes_per_s` is the speed of a download, an unpack or a pull over its last
five seconds (over all of it in its first five). It is null for its first half
second and in the other phases. While nothing arrives, as when a dropped
download waits to try again, `GET /programs` reports it as 0. Ollama's
`done` adds the `model` it pulled. A pull's `done` has the server's address
as its `location` and no `version`.

`program.server` goes out each time LocalCut's copy of a server changes
state, with the `reason` when it is stopped or crashed.

A failure's `reason` is one of `no_space`, `download_failed`,
`download_gone`, `size_mismatch`, `checksum_mismatch`, `unpack_failed`,
`does_not_run`, `gpu_not_usable` (the build's PyTorch cannot use the card),
`in_use`, `install_failed`, `did_not_start` (LocalCut's
copy was set up and did not start) and `pull_failed` (Ollama would not pull
the model, or stopped partway; its own message is in `error`). `error` is the
same failure in English, for logs and the CLI.

### In the readiness report

Where LocalCut's copy of FFmpeg would fix a row, the row's fix is
`{"type": "setup_program", "program": "ffmpeg", "size_bytes": N}`, with the
download's size. That is a `no_ffmpeg` row (assembly, or captions that need
ffmpeg to decode narration), and an `ffmpeg_cannot_draw_text` row whose
ffmpeg came from `PATH`. It is not offered where nothing is pinned for this
machine, where `LOCALCUT_FFMPEG_BIN` or `<data_dir>/bin` would still win, or
where LocalCut's copy is already the one in use.

An `llm_server_down` row gets the same fix for Ollama, where LocalCut's copy
would serve `LOCALCUT_LLM_URL` and is not set up yet. Its `size_bytes` is the
download plus the script model the setup pulls (the catalog's figure, nothing
for a model the catalog does not hold), the figure `GET /programs` gives that
setup as `download_bytes` and `pull.bytes`. A copy that is set up and stopped is started from Settings > Programs
instead. An `llm_model_missing` row whose server is an Ollama gets
`{"type": "pull_model", "program": "ollama", "model": "qwen3:8b",
"size_bytes": N}`, which `POST /programs/ollama/pull` with that model carries
out; `size_bytes` is the catalog's figure, null for a model it does not hold.
A server that is not Ollama cannot pull, so its row keeps the `pick_model`
fix.

A `comfyui_down` row carries the setup for ComfyUI, with everything it
downloads for this machine's card (the build and its extractor, or on Linux
the Python, the source and the wheels), where LocalCut's copy would be the
ComfyUI the engine renders with: the address is on this machine, a build is
pinned for the card, the report already knows which card that is (from
`GET /system` or `GET /programs`; the readiness report never runs the
hardware probe itself) and the copy is not set up yet. On Linux a card
nobody has looked for yet is not taken for none, so the processor's build
is not offered before the probe has run either.

A keyframe, clip or music row whose weights are not downloaded either is a
`comfyui_down` row too, while ComfyUI does not answer: a model download would
land and change nothing until it does. Its `data.weights_installed` says
whether the stage's weights are on disk. Once ComfyUI answers, the same row
becomes `no_model_installed`, or `still_clip_tier` for clips, with the
download as its fix.

## From a terminal

The CLI is a client of a running engine like the desktop, so a headless GPU
box sets itself up from its own shell:

```bash
localcut programs list                # each program, and what setup would take
localcut programs setup ffmpeg        # download LocalCut's copy, and wait
localcut programs setup ollama        # the same, then start it and pull the script model
localcut programs setup comfyui       # the build for this machine's card, then start it
localcut programs setup comfyui --build older_drivers
localcut programs setup comfyui --build cpu   # Linux: the build for the processor
localcut programs pull ollama         # pull the script model through whichever Ollama runs
localcut programs pull ollama --model llama3.2
localcut programs stop ollama         # stop LocalCut's copy, never your own
localcut programs start ollama        # start it again and wait until it answers
localcut programs cancel ffmpeg       # stop a setup or a pull
localcut programs remove ffmpeg       # remove LocalCut's copy, never your own
```

Each takes `--engine`, `--token`, `--cert` and `--json`, as in
[agents-and-automation.md](agents-and-automation.md). `setup` and `pull` exit
0 when the copy is in place or the model is there. They exit 1 when it failed
or was cancelled and 2 when no engine answered. They wait up to `--timeout`
seconds (7200 by default, since Ollama and its model are several gigabytes)
and then exit 1 too. Only the wait ends there: the work carries on in the
engine while `localcut programs list` shows how far it has got. `list` says
which build a ComfyUI setup would fetch and after a build whose PyTorch could
not use the card, the commands that fetch the others, the processor's last. `start` exits
0 once the copy runs and `stop` once it has stopped; either exits 1 when it
did not.
