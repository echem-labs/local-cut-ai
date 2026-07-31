"""`python -m localcut_engine` — the CLI without a console script on PATH.

The installed entry point is `localcut` (see `[project.scripts]`), and that is
what everything here spells: the desktop's dev-mode spawn, the frozen binary,
the container entrypoint. But a console script only works once its directory
is on PATH, which is precisely what is wrong on the machine where someone
reaches for `LOCALCUT_ENGINE_CMD` — the desktop's documented override for how
the engine is launched, whose own test writes it as
`"C:\\Program Files\\py\\python.exe" -m localcut_engine`. Without this module
that command answers "No module named localcut_engine.__main__", so the one
escape hatch for a broken launch is itself broken.

`localcut_engine.cli` carries the same guard for `python -m
localcut_engine.cli` (test_mcp.py spawns it that way). This is the shorter
form of the same thing, and delegating rather than duplicating is what keeps
the two from drifting.
"""

import sys

from .cli import main

if __name__ == "__main__":
    sys.exit(main())
