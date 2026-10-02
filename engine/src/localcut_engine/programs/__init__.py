"""The programs LocalCut runs outside its own process, and the copies of them
it keeps in <data_dir>/programs.

Three programs make real output: FFmpeg (assembly, and the audio decode
caption timing reads), an OpenAI-compatible LLM server (Ollama by default)
and ComfyUI. `status.py` reports each one as this engine finds it, and
`setup.py` downloads a pinned build of one into a folder of its own, on
request, while the engine runs. The pins are data (`manifest.py`).

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
)

#: What a running setup is doing, in the order it does it.
SETUP_PHASES = ("downloading", "verifying", "unpacking", "checking", "installing")

#: How a setup ended.
SETUP_OUTCOMES = ("done", "failed", "cancelled")

#: Why a setup failed.
SETUP_FAILURES = (
    # The disk filled up, or would have.
    "no_space",
    # The download itself did not finish: network, HTTP status, a refused
    # redirect.
    "download_failed",
    # The download's length is not the pinned length.
    "size_mismatch",
    # The download's SHA-256 is not the pinned digest.
    "checksum_mismatch",
    # The archive is unreadable, or lacks a file the pin names.
    "unpack_failed",
    # A binary that was unpacked does not run.
    "does_not_run",
    # LocalCut's existing copy is held open by another process, so it cannot
    # be replaced.
    "in_use",
    # Moving the program into place failed for another reason.
    "install_failed",
)
