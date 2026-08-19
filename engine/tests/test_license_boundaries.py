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
import functools
import importlib.metadata as metadata
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "packaging"))

from third_party_notices import (  # noqa: E402  (needs the path above)
    COPYLEFT_LIBRARIES,
    bundled_libraries,
)

_SRC = Path(__file__).resolve().parents[1] / "src"

#: ComfyUI's top-level packages. Only the `comfy*` names are listed: ComfyUI
#: also exposes generic ones (`nodes`, `execution`, `folder_paths`) that a
#: first-party module could legitimately be called, and a guard that cries
#: wolf on this repo's own code is a guard someone weakens.
_COMFY_ROOTS = frozenset(
    {
        "comfy",
        "comfy_api",
        "comfy_api_nodes",
        "comfy_config",
        "comfy_execution",
        "comfy_extras",
    }
)

# `importlib.import_module("comfy")` / `__import__("comfy")`. The ast walk
# below sees the call but not what the string means, so the dynamic forms are
# matched textually. The engine uses importlib in five modules, so this is an
# idiomatic way in here rather than an exotic one.
_DYNAMIC_COMFY = re.compile(
    r"""(?:import_module|__import__)\s*\(\s*['"](comfy(?:_\w+)?)(?:[.'"])"""
)

#: Distributions whose own metadata declares a copyleft licence, with why each
#: one is tolerable today. Anything not listed here fails the test.
_DECLARED_COPYLEFT = {
    "phonemizer-fork": (
        "GPLv3+. Reached through kokoro-onnx's grapheme-to-phoneme chain and "
        "imported in-process by backends/kokoro.py. Known debt: the engine's "
        "own source is unaffected (Apache-2.0 is one-way compatible into "
        "GPLv3), but the frozen binary is a combined work until this chain is "
        "replaced or moved behind a process boundary."
    ),
    "pyinstaller": (
        "GPLv2-or-later WITH the bootloader exception that expressly permits "
        "bundling non-free programs. Build-time tool; only the bootloader is "
        "redistributed, under that exception. Belongs in the notices file, "
        "not on a fix list."
    ),
    "pyinstaller-hooks-contrib": (
        "Dual Apache-2.0 / GPL-2.0, build-time only — nothing of it ships."
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


@functools.cache
def _bundled_libraries() -> frozenset[str]:
    """The closure the shipped notices are generated from.

    Imported rather than reimplemented. This file used to carry its own
    scanner and normaliser; the copy in `third_party_notices` walks the union
    of `purelib` and `platlib` where this one walked a single key, so the guard
    could pin a set the NOTICE did not describe.
    """
    return frozenset(bundled_libraries())


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
    libraries = _bundled_libraries()
    if not libraries:
        pytest.skip("no bundled shared libraries in this environment (not an installed closure)")
    return libraries


def _comfy_imports(path: Path) -> list[tuple[int, str]]:
    """`(line, module)` for every ComfyUI import in one source file.

    Parsed rather than pattern-matched, because the regex this replaced was
    wrong in four ways at once. A whitespace class matches newlines, so under
    `re.MULTILINE` the match began at the blank line above the import and the
    line number it reported was off by however many blank lines preceded it.
    It fired inside docstrings. It matched `import comfyui_client` on a bare
    prefix, and it missed `from comfy_extras.x import y` entirely. An ast walk
    gets all four right and hands back `node.lineno` for free.
    """
    source = path.read_text(encoding="utf-8")
    hits: list[tuple[int, str]] = []
    for node in ast.walk(ast.parse(source, filename=str(path))):
        if isinstance(node, ast.Import):
            modules = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            # A relative import cannot reach ComfyUI, and `node.module` is
            # None for `from . import x`.
            modules = [node.module] if node.level == 0 and node.module else []
        else:
            continue
        hits += [(node.lineno, m) for m in modules if m.split(".")[0] in _COMFY_ROOTS]
    hits += [
        (source.count("\n", 0, match.start()) + 1, match.group(1))
        for match in _DYNAMIC_COMFY.finditer(source)
    ]
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
    for dist in metadata.distributions():
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
        "record it in _KNOWN_LIBRARIES; if it is copyleft it also belongs in "
        f"_KNOWN_COPYLEFT_LIBRARIES, which is the record a licence review reads: "
        f"{sorted(unrecorded)}"
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
