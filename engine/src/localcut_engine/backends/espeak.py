"""espeak-ng, the native library Kokoro narration phonemizes through, and
what to do when it cannot start.

kokoro-onnx turns narration text into phonemes with phonemizer, and
phonemizer drives espeak-ng 1.52.0, from the espeakng-loader wheel, through
ctypes. It starts each copy of the library with
`espeak_Initialize(AUDIO_OUTPUT_SYNCHRONOUS, 0, data_path, 0)`. With no
options, espeak-ng calls exit(1) when it cannot load its data, and the whole
engine goes with it: every job, every connection, the queue. The narration
that was rendering is requeued on the next start, and ends that one too.

`never_exit` adds espeakINITIALIZE_DONT_EXIT to that call. espeak-ng then
returns a sample rate of 0 instead of exiting, the call raises
`EspeakDidNotStart`, and the Kokoro backend fails the narration with
`failure_text`.

Two causes are known, and both are about the path to the data:

- It is too long. espeak-ng copies the path into `path_home[N_PATH_HOME]`
  (speech.h), and a path that does not fit is cut short. espeak-ng then
  looks in whatever folder the shortened path happens to name, or, when it
  names none, in the folder it was built in on espeakng-loader's CI. Neither
  holds the data. An install or a checkout in a deep folder does this.
- On Windows, it holds characters outside ASCII and the process's ANSI code
  page is not UTF-8. phonemizer encodes the path as UTF-8, and espeak-ng opens
  it with the narrow Windows APIs, which read those bytes in the ANSI code
  page. The frozen engine declares UTF-8 in its manifest (localcut.spec), and
  Windows honours that from 10 1903. Only the first start fails to find the
  data. As it starts, espeak-ng sets LC_CTYPE to a UTF-8 locale (speech.c) in
  the C runtime Python shares on Windows, so a later start opens the data
  through it and then finds no voices: espeak-ng lists them with
  FindFirstFileA, which reads the path in the ANSI code page whatever the
  locale. phonemizer reports that as a RuntimeError, and `path_failure` gives
  the backend the same reason for it.

`data_path`, `encoded` and `too_long` judge a path without starting
espeak-ng, and import nothing heavier than espeakng-loader.
"""

from __future__ import annotations

import ctypes
import sys
from pathlib import Path

#: espeakINITIALIZE_DONT_EXIT in espeak-ng's speak_lib.h: "don't exit if
#: espeak_data is not found".
DONT_EXIT = 0x8000

#: The shortest path to the data that espeak-ng 1.52.0 cuts short. It copies
#: the path into `path_home[N_PATH_HOME]` (speech.h), which holds 160 bytes on
#: Linux and macOS, terminating NUL included, so 160 is the first length that
#: does not fit. On Windows the buffer holds 230, but espeakng-loader's DLL
#: formats into it with MSVC's legacy _snprintf, which writes no NUL when the
#: path fills the buffer exactly. The zero padding after the buffer ends a
#: 230-byte path there, so the first length that fails is 231.
#: test_espeak.py holds this number to the library espeakng-loader ships, on
#: all three platforms.
DATA_PATH_LIMIT = 231 if sys.platform == "win32" else 160


class EspeakDidNotStart(Exception):
    """espeak-ng could not load its data, and returned instead of exiting.

    Deliberately not a RuntimeError. phonemizer's `is_available()` catches
    RuntimeError and the narration then fails with "espeak not installed on
    your system", which names neither the path nor what is wrong with it.
    """

    def __init__(self, data_path: bytes | None) -> None:
        super().__init__(data_path)
        self.data_path = data_path


def never_exit() -> None:
    """Make every copy of espeak-ng that phonemizer starts return when it
    cannot load its data, rather than end the process.

    phonemizer's `EspeakAPI.__init__` loads a private copy of the library,
    assigns it to `self._library`, and on the next line calls
    `self._library.espeak_Initialize(0x02, 0, data_path, 0)`. Neither
    phonemizer nor kokoro-onnx has a way to pass options, so `_library`
    becomes a property here. The assignment hands it the library before the
    call reads it back, and the property wraps `espeak_Initialize` in between.
    Every other call on the library reaches it untouched.

    test_espeak.py fails if phonemizer stops initialising through `_library`.
    Calling this again changes nothing.
    """
    from phonemizer.backend.espeak.api import EspeakAPI

    if EspeakAPI.__dict__.get("_library") is not _LIBRARY:
        EspeakAPI._library = _LIBRARY


def _library_of(api: object) -> object:
    return vars(api).get("_library")


def _keep_library(api: object, library: object) -> None:
    if library is not None:
        _initialise_without_exit(library)
    vars(api)["_library"] = library


_LIBRARY = property(_library_of, _keep_library)


def _initialise_without_exit(library: ctypes.CDLL) -> None:
    """Wrap `library.espeak_Initialize` so it is called with DONT_EXIT.

    Set on the library object itself, where ctypes caches the functions it
    has looked up, so phonemizer's attribute lookup finds the wrapper.
    """
    try:
        initialise = library.espeak_Initialize
    except AttributeError:
        return  # not espeak-ng, and phonemizer says so itself when it calls it

    def initialise_without_exit(
        output: int, buflength: int, path: bytes | None, options: int
    ) -> int:
        rate = initialise(output, buflength, path, options | DONT_EXIT)
        if rate <= 0:
            raise EspeakDidNotStart(path)
        return rate

    initialise_without_exit.__wrapped__ = initialise
    library.espeak_Initialize = initialise_without_exit


def data_path() -> Path | None:
    """The path to espeak-ng's data that a narration hands espeak-ng, or None
    when it cannot be found.

    kokoro-onnx asks espeakng-loader, which finds the data beside its own
    files, and phonemizer resolves that path before it encodes it.
    """
    try:
        import espeakng_loader

        return Path(espeakng_loader.get_data_path()).resolve()
    except (ImportError, OSError, RuntimeError):
        return None


def encoded(path: Path | str) -> bytes:
    """A path as phonemizer hands it to espeak-ng, which is in UTF-8."""
    return str(path).encode("utf-8", "surrogateescape")


def too_long(path: Path | str | bytes) -> bool:
    """Whether espeak-ng would cut this path to its data short."""
    raw = path if isinstance(path, bytes) else encoded(path)
    return len(raw) >= DATA_PATH_LIMIT


def _misread_code_page(path: str) -> int | None:
    """The ANSI code page Windows reads `path` in, where reading the UTF-8
    bytes in it names a different path. None where it does not."""
    if sys.platform != "win32" or path.isascii():
        return None
    code_page = ctypes.windll.kernel32.GetACP()
    return None if code_page == 65001 else code_page


def path_failure() -> str | None:
    """`failure_text` for the path a narration hands espeak-ng, when the path
    alone shows why espeak-ng cannot read it, and None when it does not."""
    path = data_path()
    if path is None:
        return None
    raw = encoded(path)
    if not too_long(raw) and _misread_code_page(str(path)) is None:
        return None
    return failure_text(raw)


def failure_text(data_path: bytes | None) -> str:
    """Why espeak-ng did not start, as a failed narration says it.

    `data_path` is what phonemizer handed espeak-ng. The causes are the ones
    the path shows. espeak-ng also prints its own line to stderr, naming the
    file it could not open, which is where an unknown cause is found.
    """
    if data_path is None:
        return (
            "Narration needs espeak-ng, which could not load its data. "
            "espeak-ng's own message is in the engine log."
        )
    path = data_path.decode("utf-8", "replace")
    causes = []
    fixes = []
    if too_long(data_path):
        causes.append(
            f"the path is {len(data_path)} bytes long, and espeak-ng needs one shorter "
            f"than {DATA_PATH_LIMIT} bytes"
        )
        fixes.append("shorter")
    code_page = _misread_code_page(path)
    if code_page is not None:
        causes.append(
            "the path has characters outside ASCII, and Windows reads it in code page "
            f"{code_page} rather than UTF-8"
        )
        fixes.append("plain ASCII")
    if not causes:
        return (
            f"Narration needs espeak-ng, which could not load its data from {path}. "
            "espeak-ng's own message is in the engine log."
        )
    return (
        f"Narration needs espeak-ng, which cannot read its data at {path}: "
        f"{'; and '.join(causes)}. "
        f"Install LocalCut AI in a folder whose path is {' and '.join(fixes)}."
    )
