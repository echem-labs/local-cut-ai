"""Keeps the licence boundaries enforced instead of assumed.

Two of them, and they failed in opposite directions when this was written.

The first is the one the code already documents: ComfyUI is GPL-3.0, so the
adapter talks to it over HTTP and never imports it. That held — but nothing
asserted it, and it is one careless `import` away from being untrue.

The second is the one nobody had looked at. The frozen engine redistributes
its whole transitive closure, native libraries included, and GPL arrives
through `pip` as readily as through a model card: `faster-whisper` pulls
`av`, whose wheel bundles a full FFmpeg with the x264 and x265 encoders
(video is encoded by shelling out to the user's own ffmpeg, so nothing here
calls them — though `libavcodec` names them in its `DT_NEEDED`, so they load
with it either way), and `kokoro-onnx` pulls `phonemizer-fork` plus
`espeakng-loader`, which ships libespeak-ng. All of that is loaded in the
engine's own process.

So these tests do not pretend the closure is clean. They pin what is in it,
so that the next `uv lock` cannot add to it silently: a new bundled library
fails here and gets a licence decision, and the recorded copyleft may shrink
but never grow. Fixing the two chains is separate work; noticing a third one
arrive is this file's job.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "packaging"))

from third_party_notices import (  # noqa: E402  (needs the path above)
    COPYLEFT_LIBRARIES,
    bundled_libraries,
    runtime_distributions,
)

_SRC = Path(__file__).resolve().parents[1] / "src"


def _is_comfy(module: str) -> bool:
    """Does this module name belong to ComfyUI rather than to this repo?

    A prefix test on the top-level name, which is what the regex this guard
    replaced did. An enumeration was tried and was worse: ComfyUI's own tree
    carries `comfyui_version`, and it installs `comfyui_frontend_package`,
    `comfyui_workflow_templates` and `comfyui_embedded_docs` as distributions,
    none of which a hand-kept list of `comfy_*` names contains — so the list
    silently narrowed the GPL boundary while looking stricter.

    This repo's own `comfy` and `comfy_templates` packages live under
    `localcut_engine`, so their top-level name is `localcut_engine` and they
    never match.
    """
    return module.split(".")[0].startswith("comfy")


#: Callables whose first string argument names a module to import.
_DYNAMIC_IMPORTERS = frozenset({"import_module", "__import__"})

#: Distributions in the *runtime* closure whose own metadata declares a
#: copyleft licence, with why each one is tolerable today. Anything not listed
#: here fails the test.
#:
#: Scoped with `runtime_distributions()` rather than every distribution the
#: interpreter happens to hold: CI syncs `--all-groups` and the pre-push hook
#: syncs default groups, so an environment-wide scan answered differently on
#: two machines, and the next GPL dev tool would have had to be excused here as
#: though it shipped. PyInstaller and its hooks were waived here for exactly
#: that reason and are gone with the wider scan: only the bootloader is
#: redistributed, and it is the freeze's business, not this closure's.
_DECLARED_COPYLEFT = {
    "phonemizer-fork": (
        "GPLv3+. Reached through kokoro-onnx's grapheme-to-phoneme chain and "
        "imported in-process by backends/kokoro.py. Known debt: the engine's "
        "own source is unaffected (Apache-2.0 is one-way compatible into "
        "GPLv3), but the frozen binary is a combined work until this chain is "
        "replaced or moved behind a process boundary."
    ),
}

#: Native shared libraries bundled inside wheels in the runtime closure,
#: normalised free of version and build-hash suffixes. This is an inventory,
#: not a licence audit: the point is that a library appearing here for the
#: first time gets looked at, because that is how x264 and libespeak-ng
#: arrived without anyone deciding to ship them.
_KNOWN_LIBRARIES = frozenset(
    {
        # av (PyAV) — a whole FFmpeg build, and the bulk of this list.
        "libSvtAv1Enc",
        "libasound",
        "libavcodec",
        "libavdevice",
        "libavfilter",
        "libavformat",
        "libavutil",
        "libdav1d",
        "libdrm",
        "libgmp",
        "libgnutls",
        "libhogweed",
        "libmp3lame",
        "libnettle",
        "libopencore-amrnb",
        "libopencore-amrwb",
        "libopus",
        "libsharpyuv",
        "libswresample",
        "libswscale",
        "libunistring",
        "libvpl",
        "libvpx",
        "libwebp",
        "libwebpmux",
        "libx264",
        "libx265",
        "libXau",
        "libxcb",
        "libxcb-shape",
        "libxcb-shm",
        "libxcb-xfixes",
        # espeakng-loader
        "libespeak-ng",
        # soundfile
        "libsndfile",
        # onnxruntime / ctranslate2 / scipy
        "libonnxruntime",
        "libonnxruntime_providers_shared",
        "libctranslate2",
        "libscipy_openblas64_",
        # GCC runtime, carried under the GCC Runtime Library Exception.
        "libgomp",
        "libgfortran",
        "libquadmath",
    }
)

#: The copyleft record is `third_party_notices.COPYLEFT_LIBRARIES` — the table
#: that generates the NOTICE shipped beside the frozen engine. Derived rather
#: than restated: a second list here would be a licence claim on the far side of
#: a boundary no build step reconciles, and the two had already diverged (three
#: entries against twenty-one) before this was noticed.
_KNOWN_COPYLEFT_LIBRARIES = frozenset(COPYLEFT_LIBRARIES)


def _installed_closure() -> frozenset[str]:
    """The bundled libraries, or a skip if this environment has none.

    The single definition of "is this an installed closure". It used to be
    two — a `skipif` globbing `*/*` with no filter, and this walk — and they
    disagreed in both directions: a tree holding only a package's own
    `.cpython-*.so` satisfied the guard, which then ran the test against an
    empty set, while a tree whose libraries sat at depth 3
    (`onnxruntime/capi/`) was invisible to the guard and skipped with
    libraries sitting there unchecked.
    """
    libraries = frozenset(bundled_libraries())
    if not libraries:
        pytest.skip("no bundled shared libraries in this environment (not an installed closure)")
    return libraries


def _comfy_imports(path: Path) -> list[tuple[int, str]]:
    """`(line, module)` for every ComfyUI import in one source file.

    Parsed, never pattern-matched. The regex this replaced was wrong in four
    ways at once: a whitespace class matches newlines, so under `re.MULTILINE`
    the match began at the blank line above the import and the line number was
    off by however many blank lines preceded it; it fired inside docstrings; it
    matched `import comfyui_client` on a bare prefix; and it missed `from
    comfy_extras.x import y` entirely.

    The dynamic forms — `importlib.import_module("comfy")`, `__import__` — are
    read off the ast too. They were briefly matched with a second regex over
    the raw source, which reintroduced the docstring false positive the ast
    walk had just removed: a line of prose saying *not* to import ComfyUI
    reddened the guard, and `backends/comfyui.py` is exactly where such prose
    belongs. An `ast.Call` node cannot see into a comment.

    Read as bytes so `ast.parse` applies PEP 263 the way the interpreter does.
    Decoding as utf-8 first turns a BOM — which editors on Windows add by
    default, and the CI matrix is due to include Windows — into a `SyntaxError`
    from the licence guard rather than a licence verdict.
    """
    tree = ast.parse(path.read_bytes(), filename=str(path))
    hits: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            # A relative import cannot reach ComfyUI, and `node.module` is
            # None for `from . import x`.
            modules = [node.module] if node.level == 0 and node.module else []
        elif isinstance(node, ast.Call):
            name = getattr(node.func, "attr", None) or getattr(node.func, "id", None)
            if name not in _DYNAMIC_IMPORTERS or not node.args:
                continue
            first = node.args[0]
            modules = (
                [first.value]
                if isinstance(first, ast.Constant) and isinstance(first.value, str)
                else []
            )
        else:
            continue
        hits += [(node.lineno, m) for m in modules if _is_comfy(m)]
    return sorted(hits)


def test_the_engine_never_imports_comfyui_in_process() -> None:
    """The GPL containment the adapter's docstring promises."""
    sources = sorted(_SRC.rglob("*.py"))
    # Without this the guard passes on nothing the moment the layout moves:
    # `rglob` on a missing directory yields no paths, and so no offenders.
    assert sources, f"no engine sources under {_SRC} — this test would pass on nothing"
    offenders = [
        f"{path.relative_to(_SRC)}:{line} ({module})"
        for path in sources
        for line, module in _comfy_imports(path)
    ]
    assert not offenders, (
        "ComfyUI is GPL-3.0 and is reached over its HTTP/WS API precisely so its "
        f"licence does not reach this code. These import it in-process: {offenders}"
    )


def test_no_distribution_declares_copyleft_outside_the_recorded_set() -> None:
    found = {}
    for dist in runtime_distributions():
        meta = dist.metadata
        name = meta["Name"]
        if name is None:
            continue
        declared = " ".join(
            [meta.get("License-Expression") or "", meta.get("License") or ""]
            + [v for k, v in meta.items() if k == "Classifier" and v.startswith("License")]
        ).lower()
        # "lgpl" is deliberately included: it carries notice and relink duties
        # even though it does not make the whole a derived work.
        if "gpl" in declared or "affero" in declared:
            found[name] = declared[:120]
    unrecorded = {n: d for n, d in found.items() if n not in _DECLARED_COPYLEFT}
    assert not unrecorded, (
        "a dependency declaring a copyleft licence arrived without a decision — "
        "record it in _DECLARED_COPYLEFT with the reason it is acceptable, or "
        f"replace it: {unrecorded}"
    )


def test_no_unrecorded_native_library_ships_in_the_closure() -> None:
    unrecorded = _installed_closure() - _KNOWN_LIBRARIES
    assert not unrecorded, (
        "a wheel started bundling a native library nobody has licensed — this is "
        "how x264 and libespeak-ng arrived. Establish each one's licence, then "
        "record it in _KNOWN_LIBRARIES here; if it is copyleft it also belongs "
        "in third_party_notices.COPYLEFT_LIBRARIES, which is the table the "
        f"shipped NOTICE is generated from: {sorted(unrecorded)}"
    )


def test_no_recorded_native_library_has_left_the_closure() -> None:
    """The inventory was pinned in the addition direction only.

    Nothing asserted that a recorded library is still *found*, so a wheel
    renaming a file — or a recogniser that stopped matching it — dropped it
    from the shipped notices with the suite green: the neighbouring count
    assertion tolerates losing twenty of the forty-one, and subtracting in the
    addition direction cannot see a disappearance.
    """
    missing = _KNOWN_LIBRARIES - _installed_closure()
    assert not missing, (
        "a recorded native library is no longer being found. It has been "
        "renamed, dropped by a wheel, or is no longer recognised as a shared "
        "object — the last of which would silently remove it from the shipped "
        f"NOTICE: {sorted(missing)}"
    )


def test_the_recorded_copyleft_is_part_of_the_inventory() -> None:
    """The two sets are maintained by hand and have to describe one closure."""
    orphaned = _KNOWN_COPYLEFT_LIBRARIES - _KNOWN_LIBRARIES
    assert not orphaned, (
        "recorded as copyleft but absent from the inventory — one of the two sets "
        f"was edited without the other: {sorted(orphaned)}"
    )


def test_the_recorded_copyleft_is_still_present() -> None:
    """Shrinking is the fix landing, and the record has to shrink with it.

    A hard failure rather than the skip this used to be. `pytest.skip` was
    being used to report a result, and it reported the wrong one: it fired
    whenever the scan came back empty, which far more often means "the closure
    is not installed here" than "the GPL debt was paid" — and what it printed
    under `-rs` was `recorded copyleft no longer present (good) — prune from
    the set`. A maintainer acting on that deletes the only record that x264,
    x265 and libespeak-ng ship at all. `_installed_closure()` now owns the one
    legitimate skip here, and it says which case it is.
    """
    stale = _KNOWN_COPYLEFT_LIBRARIES - _installed_closure()
    assert not stale, (
        "recorded copyleft is no longer in the closure. If the chain was replaced "
        "this is the fix landing and the entry should be pruned; if it merely moved "
        f"or was renamed, the record is now wrong: {sorted(stale)}"
    )
