"""Stand in for PyAV before anything can import the real one.

`faster-whisper` imports `av` at module scope (`faster_whisper/audio.py`, via
`faster_whisper/__init__.py`) for a decode step this engine does not use:
`AlignBackend` hands `transcribe()` an array it decoded with the ffmpeg binary
the app already ships, and an array reaches the model without `decode_audio`
being called at all.

The wheel is worth keeping out. It bundles a complete FFmpeg build - libx264
and libx265 among it, both GPL-2.0-or-later - which is 100 MB of installer and
two video encoders nothing in this engine calls, against a repository whose
own Dockerfile pins an LGPL ffmpeg because "the licensing policy excludes GPL
x264/x265".

A module rather than an `excludes` entry alone: PyInstaller's excludes match by
name, so a stub source file named `av.py` is excluded along with the real
package and the import fails outright. Registering it here runs before the
first import instead.

Dunder names answer with `AttributeError` rather than the refusal, because a
module is expected to answer `hasattr`, `getattr(..., default)` and `repr()`
instead of raising out of them. `inspect.getmodule` walks every entry in
`sys.modules` asking `hasattr(module, "__file__")`, `pickle` probes modules
inside an `except AttributeError`, and CPython's own module `repr` reads
`__file__` the same way; a stub that refuses those turns an unrelated
traceback, log line or introspection call anywhere in the frozen engine into
"PyAV is deliberately not bundled". It also makes `import av.audio` fail as
the `ModuleNotFoundError` an `except ImportError` around it can catch, rather
than as a RuntimeError that escapes one. A real PyAV attribute is still
refused loudly - answering with a mock would fail far from the cause.
"""

import importlib.machinery
import sys
import types


class _RefusingModule(types.ModuleType):
    """`av` with PyAV taken out: every real attribute raises where it is asked."""

    def __getattr__(self, name: str):
        if name.startswith("__") and name.endswith("__"):
            raise AttributeError(name)
        raise RuntimeError(
            "PyAV is deliberately not bundled - decode audio with the ffmpeg binary "
            f"and pass an ndarray to transcribe() (something asked for av.{name})"
        )


_av = _RefusingModule("av")
# A spec, because `importlib.util.find_spec("av")` raises ValueError rather
# than answering for a module whose `__spec__` is None, which is what
# `types.ModuleType` leaves it as.
_av.__spec__ = importlib.machinery.ModuleSpec("av", loader=None)
# setdefault, not assignment: if a real PyAV is already imported, something
# needs it and silently replacing it with a raising stub would be worse than
# carrying it.
sys.modules.setdefault("av", _av)
