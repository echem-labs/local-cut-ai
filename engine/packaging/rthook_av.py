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

A module rather than a `excludes` entry alone: PyInstaller's excludes match by
name, so a stub source file named `av.py` is excluded along with the real
package and the import fails outright. Registering it here runs before the
first import instead.
"""

import sys
import types

_av = types.ModuleType("av")


def _refuse(name: str):
    raise RuntimeError(
        "PyAV is deliberately not bundled - decode audio with the ffmpeg binary "
        f"and pass an ndarray to transcribe() (something asked for av.{name})"
    )


_av.__getattr__ = _refuse
# setdefault, not assignment: if a real PyAV is already imported, something
# needs it and silently replacing it with a raising stub would be worse than
# carrying it.
sys.modules.setdefault("av", _av)
