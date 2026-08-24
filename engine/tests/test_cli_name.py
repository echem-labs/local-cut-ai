"""One command, one name, in every file that has to spell it.

`[project.scripts]` names what `uv run` and a PATH install answer to. The
PyInstaller spec names the frozen binary AND the directory it lands in, which
electron-builder copies by path, which the shell then spawns by name, which
the package guard checks before shipping, which CI smoke-tests after freezing,
and which the Docker image runs as its entrypoint. Rename one and the desktop
looks for a file nobody produces -- the app then opens permanently
disconnected, which reads as a broken app rather than a broken build (see
check-engine.mjs, which exists because that shipped once).

Two more spell it at a human rather than at a build step, and go wrong more
quietly: the Settings screen prints the command to run on a GPU box, and the
MCP instructions tell an agent which process to look for when it cannot reach
the engine. Both are advice, so a stale one is followed rather than noticed.

Nothing else covers any of it: the packaging workflow is dispatch-triggered,
no job builds the Docker image, and the rest of the suite reaches `main`
without going through the console script (test_cli.py calls `cli.main`
directly, test_mcp.py spawns `python -m localcut_engine.cli`) -- which is why
the entry point is resolved here rather than assumed.

Two things this file is careful about, because each of them lets a rename
through while a naive guard stays green:

*Counts, not presence.* A spelling repeated once per platform is that many
independent chances to drift, and `in` cannot tell one surviving occurrence
from all of them. `engine.ts` names the binary on both arms of a `win32 ?`
ternary and only the Windows arm carries `.exe`; `check-engine.mjs` names it
once per POSIX target; `package.yml` names it once per matrix row. Counting
also separates needles where one is a strict prefix of another --
`dist/x/x` of `dist/x/x.exe` -- which containment cannot.

*Its own home.* This is not in `test_ui_contract.py`: that module skips
wholesale when the desktop app is not checked out beside the engine, and the
pyproject/cli.py/spec/Dockerfile half of this contract holds precisely in
that engine-only layout -- the container is one, and it is the deployment
whose entrypoint depends on the console script most directly.

`ci-engine.yml` and `.pre-commit-config.yaml` name the files below in their
path filters. They have to: five of them live outside `engine/` — engine.ts,
check-engine.mjs, electron-builder.yml, Settings.tsx and package.yml — and a
filter that omits one lets the drift this guards against merge without
running. Both filters list all five; keep the count here honest with them,
since this paragraph is what anyone adding a sixth file reads first.

`test_ui_contract.py` and `test_license_contract.py` read files outside
`engine/` for the same reason and are gated the same way (`lib/tools.ts` and
friends under its own `ui-contract` hook; the root documents and the desktop's
package.json under `license-contract` -- see `_ROOT_INPUTS` there, which is
the list its own test reconciles against both filters), so ci-engine.yml's
filter is the union of the three lists rather than just these five -- an entry
there that is not named above belongs to one of those two tests.
"""

from __future__ import annotations

import re
import tomllib
from importlib import import_module
from importlib.metadata import entry_points
from pathlib import Path

import pytest

from localcut_engine import cli

# Anchored to this file, not walked back up from some other constant's path:
# deriving the root that way makes it depend on that file's depth, so moving
# the file moves the root - silently, until something below it is missing.
REPO_ROOT = Path(__file__).resolve().parents[2]
_DESKTOP = REPO_ROOT / "apps" / "desktop"


def _cli_name() -> str:
    """The console script -- the one name every other spelling is derived
    from, so the whole contract is read out of `[project.scripts]` rather
    than written down a second time here."""
    pyproject = tomllib.loads((REPO_ROOT / "engine" / "pyproject.toml").read_text(encoding="utf-8"))
    scripts = pyproject.get("project", {}).get("scripts")
    assert scripts, "engine/pyproject.toml declares no [project.scripts] - the name has no source"
    assert len(scripts) == 1, f"expected one console script, found {sorted(scripts)}"
    return next(iter(scripts))


_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)
# `//` that does not follow a `:` — the only way the sequence shows up outside
# a comment in these files is a URL scheme.
_SLASH_COMMENT = re.compile(r"(?<!:)//.*$", re.M)
_HASH_COMMENT = re.compile(r"#.*$", re.M)
_JS_SUFFIXES = {".ts", ".tsx", ".mjs", ".js"}


def _code_only(path: Path, text: str) -> str:
    """The file with its comments removed.

    Counting raw text lets a comment stand in for the code it describes: move
    the live spelling and leave `// was "localcut"` behind, and the total is
    unchanged while the thing that runs says something else. Verified
    reachable -- it is the one mutation this guard missed before this existed.

    The two neighbouring contract tests in test_ui_contract.py strip comments
    first for the same reason, and say so: otherwise "the test would then pass
    by comparing against nothing."
    """
    if path.suffix in _JS_SUFFIXES:
        text = _SLASH_COMMENT.sub("", _BLOCK_COMMENT.sub("", text))
    # yml, Dockerfile, py. The .spec needs none: its own check is anchored to
    # the start of a line with `^\s*name`, which no `#` comment can satisfy.
    elif path.suffix in {".yml", ".yaml", ".py"} or path.name == "Dockerfile":
        text = _HASH_COMMENT.sub("", text)
    # Right-strip every line, because several patterns end in `$` and removing
    # a trailing comment leaves the whitespace that stood in front of it.
    # Without this, annotating a line whose name is already CORRECT --
    # `engine_bin: dist/x/x  # the POSIX layout` -- reddens the engine suite,
    # which is the false alarm this file warns about one docstring up: the
    # cheapest way to green it is to weaken the pattern, and the pattern is
    # the guard. A stray trailing space in the source would do the same.
    return "\n".join(line.rstrip() for line in text.splitlines())


def _assert_spelled(path: Path, name: str, expected: dict[str, int]) -> None:
    """Every pattern matches exactly as many times as stated.

    Patterns rather than literals so the guard pins the *name* and not the
    surrounding layout: nothing in this repo formats the TypeScript or the
    .mjs (there is no prettier config, no eslint, and `npm run typecheck`
    checks types only), so a hand-wrap or a formatter adopted later would
    otherwise turn a desktop-only reformat into a red engine suite -- and the
    cheapest way to green that is to weaken the needle, which is the guard.
    Every pattern below writes required whitespace as `\\s+` or `\\s*`.

    Reports all the mismatches at once: renaming a command touches several of
    these files, and one assertion per round trip is several round trips on a
    workflow that is dispatch-triggered.
    """
    assert path.exists(), f"{path} is gone -- update this test with it"
    text = _code_only(path, path.read_text(encoding="utf-8"))
    # re.M so a trailing `$` means end of *line*: it is what separates
    # `dist/x/x` (the POSIX engine_bin rows) from `dist/x/x.exe`, which a
    # containment check reads as the same string.
    counts = {pattern: len(re.findall(pattern, text, re.M)) for pattern in expected}
    wrong = {
        pattern: (counts[pattern], want)
        for pattern, want in expected.items()
        if counts[pattern] != want
    }
    assert not wrong, (
        f"{path.name} does not spell the CLI name as {name!r} -- "
        f"{{pattern: (found, expected)}} {wrong}"
    )


def test_the_engine_spells_its_own_name_the_same_way_everywhere():
    """The half that holds without a desktop checkout: the console script, the
    argparse prog, the frozen binary, and the container entrypoint."""
    name = _cli_name()
    q = re.escape(name)

    # The declaration is a string until something resolves it. Nothing else in
    # the suite does: the CLI tests call `cli.main` directly and test_mcp.py
    # spawns `python -m localcut_engine.cli`, which is the module, not the
    # console script. So a target repointed by a refactor -- `:run`, a moved
    # module -- leaves every test green while `uv run localcut` (the desktop's
    # dev-mode spawn and the Dockerfile entrypoint) dies at launch.
    installed = {e.name: e for e in entry_points(group="console_scripts")}
    assert name in installed, (
        f"no console script {name!r} is installed -- "
        f"`uv sync` after changing [project.scripts], or it only exists on paper"
    )
    assert installed[name].load() is cli.main, (
        f"the {name!r} console script resolves to {installed[name].value}, not localcut_engine.cli:main"
    )

    # `python -m localcut_engine`, the same CLI without a console script on
    # PATH. It is the shape the desktop's LOCALCUT_ENGINE_CMD override is
    # documented in (engine.test.ts writes it verbatim), and the one thing
    # left to try when a packaged launch fails -- which is exactly the moment
    # a PATH is not to be relied on. Asserting the module resolves to the
    # same `main` is what stops the two entry points drifting apart.
    module_main = import_module("localcut_engine.__main__")
    assert module_main.main is cli.main, (
        "python -m localcut_engine does not run the same entry point as the console script"
    )

    # What argparse calls itself in --help. Hardcoded rather than taken from
    # argv[0] on purpose: the frozen binary must introduce itself the same way
    # the dev-mode script does, whatever the file on disk is called.
    _assert_spelled(
        REPO_ROOT / "engine" / "src" / "localcut_engine" / "cli.py",
        name,
        {rf'prog="{q}"': 1},
    )

    # The sentence an MCP host shows its agent when a tool cannot reach the
    # engine. It is the one message in the product whose whole job is to
    # unstick someone who has no engine running, so a stale one sends them
    # looking for a process that cannot exist under that name.
    _assert_spelled(
        REPO_ROOT / "engine" / "src" / "localcut_engine" / "mcp_server.py",
        name,
        {rf"`{q} serve`": 1, rf"`{q} mcp`": 1},
    )

    # PyInstaller writes dist/<COLLECT name>/<EXE name>, and every packaging
    # path in the other test is derived from that pair -- one of the two
    # renamed alone is the mismatch check-engine.mjs exists because of.
    #
    # Matched by regex rather than by counting one literal: nothing lints or
    # formats a .spec file (ruff discovers .py/.pyi/.ipynb only), so
    # `name = "x"` with spaces would count zero and a later BUNDLE() block for
    # a signed .app would count three -- each reported as a divergence that is
    # not there.
    spec = REPO_ROOT / "engine" / f"{name}.spec"
    assert spec.exists(), f"{spec} is gone -- the spec file is named after the command"
    declared = re.findall(
        r"^\s*name\s*=\s*['\"]([^'\"]+)['\"]", spec.read_text(encoding="utf-8"), re.M
    )
    assert declared == [name, name], (
        f"{spec.name} declares names {declared!r}; EXE and COLLECT must both be {name!r}"
    )

    # `uv run <name>` again, inside the image, as the entrypoint. The image
    # copies only pyproject.toml, uv.lock and src, so it depends on the
    # console script more directly than anything else here -- and nothing
    # builds it in CI, so a missed rename surfaces as a container that
    # restart-loops on "Failed to spawn" the first time someone deploys it.
    #
    # `uv run` takes flags of its own before the command, so they are skipped
    # over rather than spelled out: what this pins is the name, and a pattern
    # that also pinned the flag list would go red for a change that has nothing
    # to do with what the command is called.
    _assert_spelled(
        REPO_ROOT / "engine" / "Dockerfile",
        name,
        {rf'"run",\s*(?:"--[\w-]+",\s*)*"{q}",\s*"serve"': 1},
    )


@pytest.mark.skipif(not _DESKTOP.exists(), reason="desktop app not present beside the engine")
def test_everything_that_packages_or_spawns_the_engine_agrees_on_its_name():
    """The half that needs the full checkout: what freezes the binary, copies
    it into the installer, spawns it, refuses to ship a broken one, and tells
    the user what to type."""
    name = _cli_name()
    q = re.escape(name)
    mirrors = {
        _DESKTOP / "electron" / "engine.ts": {
            # Twice bare: the packaged macOS/Linux exe and the dev-mode `uv
            # run` argv. Windows carries `.exe` and counts separately --
            # collapsing the two is what lets a rename of the POSIX arm ship,
            # and that arm is the one inside the dmg and the AppImage.
            rf'"{q}"': 2,
            rf'"{q}\.exe"': 1,
            # The receiving end of electron-builder's `to: engine`.
            r'resourcesPath,\s*"engine"': 1,
        },
        _DESKTOP / "scripts" / "check-engine.mjs": {
            rf'exe:\s*"{q}"': 2,  # linux and mac, which drift independently
            rf'exe:\s*"{q}\.exe"': 1,
            rf'"dist",\s*"{q}"': 1,
            rf"pyinstaller\s+{q}\.spec": 1,  # the remediation it prints on failure
        },
        # Both halves of the copy: where PyInstaller wrote it, and the
        # subdirectory of resources/ it lands in. Pinning `from:` alone leaves
        # `to:` free, and electron-builder falls back to the basename of
        # `from` when it is absent -- so the engine would arrive in
        # resources/<name>/ while engine.ts still joins resources/engine/,
        # with every test and both CI workflows green.
        _DESKTOP / "electron-builder.yml": {rf"engine/dist/{q}$": 1, r"^\s*to:\s*engine\s*$": 1},
        _DESKTOP / "src" / "screens" / "Settings.tsx": {
            # The remote-engine screen tells the user verbatim what to run on
            # the GPU box; a stale one instructs a command that does not exist.
            rf"<code>{q} serve": 1,
        },
        REPO_ROOT / ".github" / "workflows" / "package.yml": {
            rf"dist/{q}/{q}$": 2,  # the macOS and Linux engine_bin rows
            rf"dist/{q}/{q}\.exe": 1,  # and the Windows one
            rf"pyinstaller\s+--noconfirm\s+{q}\.spec": 1,  # the spec's filename
        },
    }
    for path, expected in mirrors.items():
        _assert_spelled(path, name, expected)
