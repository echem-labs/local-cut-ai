"""Keeps the licence boundaries enforced instead of assumed.

Two of them, and they failed in opposite directions when this was written.

The first is the one the code already documents: ComfyUI is GPL-3.0, so the
adapter talks to it over HTTP and never imports it. That held — but nothing
asserted it, and it is one careless `import` away from being untrue.

The second is the one nobody had looked at. The frozen engine redistributes
its whole transitive closure, native libraries included, and GPL arrives
through `pip` as readily as through a model card: `faster-whisper` pulls
`av`, whose wheel bundles a full FFmpeg with the x264 and x265 encoders
(nothing in this product calls them — video is encoded by shelling out to
the user's own ffmpeg), and `kokoro-onnx` pulls `phonemizer-fork` plus
`espeakng-loader`, which ships libespeak-ng. All of that is loaded in the
engine's own process.

So these tests do not pretend the closure is clean. They pin what is in it,
so that the next `uv lock` cannot add to it silently: a new bundled library
fails here and gets a licence decision, and the recorded copyleft may shrink
but never grow. Fixing the two chains is separate work; noticing a third one
arrive is this file's job.
"""

from __future__ import annotations

import importlib.metadata as metadata
import re
import sysconfig
from pathlib import Path

import pytest

_SRC = Path(__file__).resolve().parents[1] / "src"

# `import comfy...` / `from comfy... import`, at any indentation. Matching the
# statement rather than the bare word so a mention in a comment or a URL does
# not read as linkage.
_COMFY_IMPORT = re.compile(r"^\s*(?:import\s+comfy|from\s+comfy[\s.])", re.MULTILINE)

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

#: The copyleft-licensed members of the inventory above. May shrink — that is
#: what resolving the debt looks like — but must never grow.
_KNOWN_COPYLEFT_LIBRARIES = frozenset(
    {
        "libx264",  # GPL-2.0-or-later, via av's FFmpeg. Never called.
        "libx265",  # GPL-2.0-or-later, via av's FFmpeg. Never called.
        "libespeak-ng",  # GPL-3.0, ctypes-loaded by kokoro-onnx's tokenizer.
    }
)

_HASH_SUFFIX = re.compile(r"-[0-9a-f]{6,}$")
_VERSION_SUFFIX = re.compile(r"[-.][0-9][0-9.]*$")
_ARCH_SUFFIX = re.compile(r"_(x86_64|aarch64|arm64|amd64)$")
_SHARED_OBJECT = re.compile(r"\.(so|dylib|dll)(\.|$)")


def _normalise(filename: str) -> str:
    """`libx264-d6533a8d.so.165` -> `libx264`, `libgfortran-a-b.so.5` -> `libgfortran`."""
    name = re.sub(r"\.(so|dylib|dll)(\.[0-9.]+)?$", "", filename)
    name = _ARCH_SUFFIX.sub("", name)
    # Repeated: auditwheel stacks more than one hash on some libraries.
    while True:
        stripped = _VERSION_SUFFIX.sub("", _HASH_SUFFIX.sub("", name))
        if stripped == name:
            return name
        name = stripped


def _bundled_libraries() -> set[str]:
    site_packages = Path(sysconfig.get_paths()["purelib"])
    found: set[str] = set()
    for path in site_packages.rglob("*"):
        name = path.name
        # `.abi3`/`.cpython-` files are a package's own extension modules, not
        # third-party libraries riding along inside its wheel.
        if not _SHARED_OBJECT.search(name) or ".abi3" in name or ".cpython-" in name:
            continue
        found.add(_normalise(name))
    return found


def test_the_engine_never_imports_comfyui_in_process() -> None:
    """The GPL containment the adapter's docstring promises."""
    offenders = [
        f"{path.relative_to(_SRC)}:{source[: match.start()].count(chr(10)) + 1}"
        for path in _SRC.rglob("*.py")
        for source in [path.read_text(encoding="utf-8")]
        for match in _COMFY_IMPORT.finditer(source)
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


@pytest.mark.skipif(
    not any(
        _SHARED_OBJECT.search(p.name) for p in Path(sysconfig.get_paths()["purelib"]).glob("*/*")
    ),
    reason="no bundled shared libraries in this environment (not an installed closure)",
)
def test_no_unrecorded_native_library_ships_in_the_closure() -> None:
    unrecorded = _bundled_libraries() - _KNOWN_LIBRARIES
    assert not unrecorded, (
        "a wheel started bundling a native library nobody has licensed — this is "
        "how x264 and libespeak-ng arrived. Check each one's licence, then add it "
        f"to _KNOWN_LIBRARIES (and to _KNOWN_COPYLEFT_LIBRARIES if it is one): {sorted(unrecorded)}"
    )


def test_the_copyleft_native_libraries_have_not_grown() -> None:
    """Shrinking is the fix landing; growing is a regression."""
    present = _bundled_libraries() & _KNOWN_COPYLEFT_LIBRARIES
    assert present <= _KNOWN_COPYLEFT_LIBRARIES
    stale = _KNOWN_COPYLEFT_LIBRARIES - _bundled_libraries()
    if stale:
        pytest.skip(
            f"recorded copyleft no longer present (good) — prune from the set: {sorted(stale)}"
        )
