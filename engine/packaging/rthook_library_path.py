"""Give every program the frozen engine starts the user's library path back.

On Linux, PyInstaller's bootloader puts the freeze's own directory at the
front of LD_LIBRARY_PATH and starts itself again, so the dynamic loader finds
the libstdc++, libgcc_s and zlib the freeze carries before the system's. The
loader reads the variable once, when a process starts. By the time this hook
runs, the engine is already running on those libraries.

A child would inherit the variable, though. A system program would then load
the freeze's copies in place of its own. The freeze is built on Ubuntu 22.04,
so a distribution's ffmpeg on 24.04 or later, linked against a newer
libstdc++, stops with ``version `GLIBCXX_3.4.32' not found``. So does
anything else the engine starts that was built for the machine rather than for
the freeze: Ollama, ComfyUI's Python, nvidia-smi.

PyInstaller keeps the value from before in LD_LIBRARY_PATH_ORIG and leaves it
unset when there was none. Either way, that is what goes back into the
environment here, before the engine can start anything. LD_LIBRARY_PATH_ORIG
stays, which is where PyInstaller's own documentation says to read it from.

macOS and Windows find a freeze's libraries without this variable, so it is
left to whoever set it there.
"""

import os
import sys

if sys.platform.startswith("linux"):
    _users = os.environ.get("LD_LIBRARY_PATH_ORIG")
    if _users is None:
        os.environ.pop("LD_LIBRARY_PATH", None)
    else:
        os.environ["LD_LIBRARY_PATH"] = _users
