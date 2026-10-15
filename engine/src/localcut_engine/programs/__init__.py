"""The programs LocalCut runs outside its own process, and the copies of them
it keeps in <data_dir>/programs.

Three programs make real output: FFmpeg (assembly, and the audio decode
caption timing reads), an OpenAI-compatible LLM server (Ollama by default)
and ComfyUI. `status.py` reports each one as this engine finds it, and
`setup.py` downloads a pinned build of one into a folder of its own, on
request, while the engine runs. The pins are data (`manifest.py`) and
`builds.py` picks between a program's builds for the machine's graphics card.
A 7z archive is unpacked by a pinned 7-Zip extractor (`sevenzip.py`). A
program that runs as a server is run from that folder by `server.py` while
the engine runs; `ollama.py` and `comfyui.py` hold what is particular to
Ollama and to ComfyUI.

Everything here crosses the wire as codes plus data, like the readiness
report: the desktop words each code from its own catalog. The closed sets
below are those codes. A copy of one on the desktop's side is a value
written down twice, so it gets a contract test in test_ui_contract.py, the
way the readiness vocabulary has one.
"""

from __future__ import annotations

#: The programs, in the order the report lists them.
PROGRAM_IDS = ("ffmpeg", "ollama", "comfyui")

#: Whether the program the engine would use is there and works.
PROGRAM_STATES = ("ready", "missing", "broken")

#: Why a program is missing or broken.
PROGRAM_PROBLEMS = (
    # Nothing at the path or name the engine looks up.
    "not_found",
    # An ffmpeg with no ffprobe beside it: assembly needs both.
    "ffprobe_missing",
    # The binary is there and does not run.
    "does_not_run",
    # Nothing answers at the server's address.
    "unreachable",
    # Something answers there, and not the way the program does.
    "unexpected_response",
)

#: Where the program the engine uses comes from.
PROGRAM_SOURCES = (
    # LocalCut's own copy, in <data_dir>/programs/<id>.
    "managed",
    # A path or address set explicitly (LOCALCUT_FFMPEG_BIN, LOCALCUT_LLM_URL,
    # LOCALCUT_COMFYUI_URL).
    "configured",
    # A binary someone put in <data_dir>/bin by hand.
    "data_dir",
    # The engine's PATH: the user's own install.
    "path",
    # The program's usual local address: the user's own server.
    "default",
)

#: Why the engine cannot set a program up itself.
SETUP_UNAVAILABLE = (
    # Builds are pinned for other machines, not this OS and architecture.
    "platform_not_supported",
    # LocalCut does not set this program up at all yet.
    "program_not_supported",
    # The program's builds are per GPU vendor and this machine has no card
    # from a vendor one is pinned for (or no GPU at all).
    "gpu_not_supported",
)

#: The builds a program can have besides a vendor's usual one, as a pin
#: names them and a client asks for one.
BUILDS = (
    # A CUDA build for drivers and cards, older than the usual build needs.
    "older_drivers",
)

#: What a running setup is doing, in the order it does it. A program that
#: runs as a server goes on to `starting` it and to `pulling` the model it
#: serves, and a pull asked for on its own is a job with `pulling` alone.
SETUP_PHASES = (
    "downloading",
    "verifying",
    "unpacking",
    "checking",
    "installing",
    "starting",
    "pulling",
)

#: How a setup ended.
SETUP_OUTCOMES = ("done", "failed", "cancelled")

#: Why a setup failed.
SETUP_FAILURES = (
    # The disk filled up, or would have.
    "no_space",
    # The download itself did not finish: network, HTTP status, a refused
    # redirect.
    "download_failed",
    # The server says the pinned build is not at its address any more (404
    # or 410), so asking again will not fetch it.
    "download_gone",
    # The download's length is not the pinned length.
    "size_mismatch",
    # The download's SHA-256 is not the pinned digest.
    "checksum_mismatch",
    # The archive is unreadable, or lacks a file the pin names.
    "unpack_failed",
    # A binary that was unpacked does not run.
    "does_not_run",
    # The program runs and its PyTorch cannot use the graphics card: a
    # driver older than the build needs, or a card it has no kernels for.
    "gpu_not_usable",
    # LocalCut's existing copy is held open by another process, so it cannot
    # be replaced.
    "in_use",
    # Moving the program into place failed for another reason.
    "install_failed",
    # LocalCut's copy of a server was set up and did not start.
    "did_not_start",
    # The server would not pull the model, or stopped partway.
    "pull_failed",
)

#: What LocalCut's own copy of a server is doing (server.py).
SERVER_STATES = (
    # Not running, and not meant to be: never started, stopped on request,
    # or left alone because another server answers at its address.
    "stopped",
    # Started, and not answering yet.
    "starting",
    "running",
    # Gave up on it: it would not start, kept stopping, or found its address
    # taken. `reason` says which.
    "crashed",
)

#: Why LocalCut's copy of a server is stopped or crashed.
SERVER_REASONS = (
    # The user's own server answers at the address, so LocalCut uses that.
    "own_server",
    # Stopped through the API.
    "stopped",
    # Something that is not this program holds the address.
    "port_in_use",
    # The system would not run it.
    "cannot_start",
    # It ran and did not answer in time.
    "no_answer",
    # It stopped by itself, again after every restart allowed.
    "exited",
)
