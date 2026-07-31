"""PyInstaller entry point for the frozen engine executable.

The desktop shell spawns this binary with the same flags and handshake as
the dev-mode `uv run localcut` (see apps/desktop/electron/engine.ts).
"""

import multiprocessing
import sys

from localcut_engine.cli import main

if __name__ == "__main__":
    multiprocessing.freeze_support()
    sys.exit(main())
