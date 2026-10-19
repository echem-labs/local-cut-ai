"""The programs a frozen engine starts get the user's library path, not the freeze's.

PyInstaller's bootloader puts the freeze's own directory at the front of
LD_LIBRARY_PATH and restarts itself, so the engine loads the libstdc++, libgcc_s
and zlib it carries. Every child inherits that path. A system program then loads
those copies in place of its own. The freeze is built on Ubuntu 22.04, so a
distribution's ffmpeg on anything newer stops with ``version `GLIBCXX_3.4.32'
not found``. `packaging/rthook_library_path.py` puts the old value back before
the engine can start anything.

The hook is read from the file that ships and run in a fresh interpreter, which
then starts a child the way the engine starts ffmpeg: a copy of the hook typed
out here could pass while the shipped one broke.
"""

from __future__ import annotations

import ast
import os
import subprocess
import sys
import textwrap
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
HOOK = ENGINE / "packaging" / "rthook_library_path.py"
SPEC = ENGINE / "localcut.spec"

#: Where PyInstaller points the path, then what the user had before it did.
FROZEN = "/opt/localcut/resources/engine/_internal"
USERS = "/opt/cuda/lib64"

#: Only the loader that reads LD_LIBRARY_PATH gets it rewritten. macOS and
#: Windows find a freeze's libraries another way. There the variable stays as
#: whoever set it left it.
REWRITES = sys.platform.startswith("linux")


def _child_sees(env: dict[str, str]) -> str | None:
    """LD_LIBRARY_PATH as a program started after the hook ran receives it."""
    script = textwrap.dedent(f"""
        import os, subprocess, sys
        source = open({str(HOOK)!r}, encoding="utf-8").read()
        exec(compile(source, "rthook_library_path.py", "exec"), {{}})
        child = subprocess.run(
            [sys.executable, "-c", "import os; print(repr(os.environ.get('LD_LIBRARY_PATH')))"],
            capture_output=True, text=True, check=True,
        )
        print(child.stdout.strip())
    """)
    base = {k: v for k, v in os.environ.items() if not k.startswith("LD_LIBRARY_PATH")}
    done = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        env={**base, **env},
        timeout=60,
    )
    assert done.returncode == 0, done.stderr[-2000:]
    return ast.literal_eval(done.stdout.strip())


def test_a_child_gets_back_the_path_the_user_started_with() -> None:
    seen = _child_sees({"LD_LIBRARY_PATH": f"{FROZEN}:{USERS}", "LD_LIBRARY_PATH_ORIG": USERS})
    assert seen == (USERS if REWRITES else f"{FROZEN}:{USERS}")


def test_a_child_gets_no_path_when_the_user_had_none() -> None:
    """PyInstaller writes LD_LIBRARY_PATH_ORIG only when there was a value to
    keep. Without it, the freeze's directory is the whole path. A child that
    inherited it would still load the freeze's libraries."""
    seen = _child_sees({"LD_LIBRARY_PATH": FROZEN})
    assert seen == (None if REWRITES else FROZEN)


def test_the_freeze_runs_the_hook() -> None:
    """A hook the spec does not name is never run. Nothing else would fail."""
    assert f'"{HOOK.name}"' in SPEC.read_text(encoding="utf-8"), (
        f"localcut.spec does not list {HOOK.name} in runtime_hooks"
    )
