"""`av` with PyAV taken out, for an environment that installs from the lock.

Copied into the image's site-packages as `av.py`. The frozen build solves the
same problem with `rthook_av.py`, and cannot solve it this way: PyInstaller's
`excludes` match by name, so a source file called `av.py` is dropped along with
the real package and the import fails outright. Nothing here runs in the
freeze, and nothing in `rthook_av.py` runs in the image.

Why either exists is in `rthook_av.py`; the short version is that
`faster-whisper` imports `av` at module scope for a decode step this engine
does not use, and the wheel carrying it bundles a full FFmpeg build with GPL
libx264/libx265 - which is what the LGPL-only ffmpeg pinned in the Dockerfile
exists to keep out of this image.

Being a real module on disk, this one is handed `__file__`, `__spec__` and the
rest by the import system, so `__getattr__` is reached only for names a module
genuinely does not have. `__path__` is one of them, and it has to answer
`AttributeError`: CPython reads it inside an `except AttributeError` to decide
whether `import av.audio` is a submodule import, so refusing there raises a
RuntimeError out of a statement whose failure an `except ImportError` is
written to catch.
"""


def __getattr__(name: str):
    if name.startswith("__") and name.endswith("__"):
        raise AttributeError(name)
    raise RuntimeError(
        "PyAV is deliberately not bundled - decode audio with the ffmpeg binary "
        f"and pass an ndarray to transcribe() (something asked for av.{name})"
    )
