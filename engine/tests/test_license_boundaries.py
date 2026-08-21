"""Keeps the licence boundaries enforced instead of assumed.

Two of them, and they failed in opposite directions when this was written.

The first is the one the code already documents: ComfyUI is GPL-3.0, so the
adapter talks to it over HTTP and never imports it. That held — but nothing
asserted it, and it is one careless `import` away from being untrue.

The second is the one nobody had looked at. GPL arrives through `pip` as
readily as through a model card: `faster-whisper` pulls `av`, whose wheel
bundles a full FFmpeg with the x264 and x265 encoders, and `kokoro-onnx`
pulls `phonemizer-fork` plus `espeakng-loader`, which ships libespeak-ng.

Which is why the two halves of this file measure two different things. The
closure is what `uv sync` installs, `av` included; the freeze is what the
installers carry, and `localcut.spec` excludes `av` from it — narration is
decoded by shelling out to the ffmpeg binary the app already ships, so
nothing imports PyAV and the wheel does not have to be in the box. A library
can therefore be in the closure and not in the freeze, and conflating the two
is how a document ends up naming GPL encoders that no installer contains.
The espeak chain is in both: it is loaded in the engine's own process.

So these tests do not pretend either set is clean. They pin what is in each,
so that the next `uv lock` cannot add to them silently: a new bundled library
fails here and gets a licence decision, and the recorded copyleft may shrink
but never grow. Fixing the espeak chain is separate work; noticing a third
one arrive is this file's job.
"""

from __future__ import annotations

import ast
import functools
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "packaging"))

from third_party_notices import (  # noqa: E402  (needs the path above)
    annotation_key,
    bundled_libraries,
    copyleft_note,
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

#: The libraries whose terms are strongest and whose annotation therefore
#: matters most. Deliberately a short hand-kept list on this side of the
#: boundary, checked through `copyleft_note()` rather than against the table's
#: keys: `third_party_notices` keys `COPYLEFT_LIBRARIES` on the unprefixed,
#: lowercased name so one entry can cover `libx264` and Windows' `x264`, and a
#: test comparing key sets directly would only be asserting that two spellings
#: match. What is worth pinning is the answer the notices generator gives.
_MUST_STAY_ANNOTATED = frozenset({"libx264", "libx265", "libespeak-ng"})


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


def test_the_strongest_copyleft_is_still_named_with_what_it_obliges() -> None:
    """Present in the closure, and still annotated by the notices generator.

    Two ways the record can quietly stop being true, and this covers both. The
    library can leave the closure — which is the fix landing, and the entry
    should then be pruned deliberately rather than discovered later. Or its
    entry can be deleted from `COPYLEFT_LIBRARIES` to silence something, and
    then it still ships while the generated NOTICE lists it as a bare name.
    That second one is the dangerous direction: the document's own prose says
    copyleft libraries are named with what they oblige, so silence beside a
    name is an affirmative claim that it carries no copyleft terms.
    """
    closure = _installed_closure()
    for library in sorted(_MUST_STAY_ANNOTATED):
        assert library in closure, (
            f"{library} is recorded as shipping and is no longer in the closure. "
            "If the chain was replaced this is the fix landing and the entry "
            "should be pruned here; if it merely moved, the record is now wrong."
        )
        assert copyleft_note(library), (
            f"{library} ships and third_party_notices.COPYLEFT_LIBRARIES no "
            "longer names its terms, so the generated NOTICE lists it with "
            "nothing beside it — which reads as a claim that it is not copyleft."
        )


#: What each platform's frozen engine ships, normalised. This is the artifact
#: the installers carry, and it is not the installed closure: PyInstaller
#: resolves some of it from the build machine rather than from any wheel, so
#: no scan of site-packages can reach it. On the Linux runner that is five
#: libraries, three of which carry copyleft terms — libstdc++ and libgcc_s
#: under the GCC runtime exception, and glibc's libmvec.
#:
#: Recorded from a real `package.yml` run, not from a developer machine. That
#: distinction is the whole point and it is easy to get wrong: transcribed from
#: an Ubuntu desktop this set had 73 entries, 29 of which the headless runner
#: does not build in at all -- libreadline, libpulse, the X11 set -- because
#: the desktop had those system libraries installed and the runner does not.
#: A record taken from the wrong machine reports a licence change on every
#: build.
#:
#: Keyed by platform because the answer differs sharply: 12 libraries on Linux,
#: 10 on macOS, 56 on Windows — most of the Windows set being UCRT and MSVC
#: runtime pieces the other two take from the system.
#:
#: The `av` wheel is in none of them: `localcut.spec` excludes it, so the FFmpeg
#: build it carries — 32 libraries on Linux, x264 and x265 among them — reaches
#: no installer. It is still in the closure `_KNOWN_LIBRARIES` above records,
#: because it is still faster-whisper's declared dependency and still installed
#: for the tests. The two sets describing different things is why there are
#: two: `libmp3lame` leaving this one while staying in that one is the freeze
#: getting narrower, not a dependency going away.
_FROZEN_LIBRARIES = {
    "linux": frozenset(
        {
            "libctranslate2",
            "libgcc_s",
            "libgfortran",
            "libgomp",
            "libmvec",
            "libonnxruntime_providers_shared",
            "libpython3",
            "libquadmath",
            "libscipy_openblas64_",
            "libsndfile",
            "libstdc++",
            "libz",
        }
    ),
    "darwin": frozenset(
        {
            "libcrypto",
            "libctranslate2",
            "liblzma",
            "libmpdec",
            "libonnxruntime",
            "libsndfile",
            "libsqlite3",
            "libssl",
            "libzstd",
            "onnxruntime_pybind11_state",
        }
    ),
    "win32": frozenset(
        {
            "api-ms-win-core-console-l1",
            "api-ms-win-core-datetime-l1",
            "api-ms-win-core-debug-l1",
            "api-ms-win-core-errorhandling-l1",
            "api-ms-win-core-fibers-l1",
            "api-ms-win-core-file-l1",
            "api-ms-win-core-file-l2",
            "api-ms-win-core-handle-l1",
            "api-ms-win-core-heap-l1",
            "api-ms-win-core-interlocked-l1",
            "api-ms-win-core-kernel32-legacy-l1",
            "api-ms-win-core-libraryloader-l1",
            "api-ms-win-core-localization-l1",
            "api-ms-win-core-memory-l1",
            "api-ms-win-core-namedpipe-l1",
            "api-ms-win-core-processenvironment-l1",
            "api-ms-win-core-processthreads-l1",
            "api-ms-win-core-profile-l1",
            "api-ms-win-core-rtlsupport-l1",
            "api-ms-win-core-string-l1",
            "api-ms-win-core-synch-l1",
            "api-ms-win-core-sysinfo-l1",
            "api-ms-win-core-timezone-l1",
            "api-ms-win-core-util-l1",
            "api-ms-win-crt-conio-l1",
            "api-ms-win-crt-convert-l1",
            "api-ms-win-crt-environment-l1",
            "api-ms-win-crt-filesystem-l1",
            "api-ms-win-crt-heap-l1",
            "api-ms-win-crt-locale-l1",
            "api-ms-win-crt-math-l1",
            "api-ms-win-crt-private-l1",
            "api-ms-win-crt-process-l1",
            "api-ms-win-crt-runtime-l1",
            "api-ms-win-crt-stdio-l1",
            "api-ms-win-crt-string-l1",
            "api-ms-win-crt-time-l1",
            "api-ms-win-crt-utility-l1",
            "ctranslate2",
            "libcrypto",
            "libffi",
            "libiomp5md",
            "libscipy_openblas64_",
            "libsndfile",
            "libssl",
            "msvcp140",
            "MSVCP140_1",
            "onnxruntime",
            "onnxruntime_providers_shared",
            "python3",
            "python314",
            "pywintypes314",
            "sqlite3",
            "ucrtbase",
            "vcruntime140",
            "vcruntime140_1",
        }
    ),
}

#: The members of each freeze that carry copyleft terms today, so that losing
#: an annotation is a failure rather than a silent change to the shipped
#: NOTICE. Also recorded from the same run: which libraries these are is a
#: per-platform fact, and asserting a POSIX-spelled list everywhere fails on
#: the platforms that simply do not ship them.
_FROZEN_COPYLEFT = {
    "linux": frozenset(
        {
            "libgcc_s",
            "libgfortran",
            "libgomp",
            "libmvec",
            "libquadmath",
            "libsndfile",
            "libstdc++",
        }
    ),
    "darwin": frozenset(
        {
            "libsndfile",
        }
    ),
    "win32": frozenset(
        {
            "libsndfile",
        }
    ),
}

_FROZEN_TREE = Path(__file__).resolve().parents[1] / "dist" / "localcut" / "_internal"

#: Set by `package.yml`, which is the only job where the freeze exists and the
#: only one that redistributes it. Asked for explicitly rather than inferred
#: from `dist/` being present, for two reasons that point the same way. A
#: developer's `dist/` is gitignored and can be months old, and the pre-push
#: hook runs this whole suite — so inferring would measure a stale artifact,
#: against that developer's own system libraries rather than the build image's,
#: and fail on `git push` for reasons that are not about this branch. And once
#: the packaging job HAS asked, a tree that is missing or empty is a layout
#: change, not an absence: skipping there would report success from the one
#: place that can inspect the artifact, having inspected nothing.
_FROZEN_ENGINE_ENV = "LOCALCUT_CHECK_FROZEN_ENGINE"


@functools.cache
def _frozen_libraries() -> frozenset[str]:
    """What the built artifact holds, or a skip if this is not a packaging run.

    Cached: `_FROZEN_TREE` is the whole PyInstaller output and each of the
    three callers below would otherwise walk it again to reach the same answer.
    """
    if not os.environ.get(_FROZEN_ENGINE_ENV):
        pytest.skip(
            f"{_FROZEN_ENGINE_ENV} is unset - run `pyinstaller localcut.spec` and set it "
            "to check the artifact (package.yml does)"
        )
    assert _FROZEN_TREE.is_dir(), (
        f"no frozen engine at {_FROZEN_TREE}, but {_FROZEN_ENGINE_ENV} says one was built. "
        "PyInstaller's output layout has moved - fix the path rather than letting this "
        "guard skip in the job that redistributes the artifact"
    )
    libraries = frozenset(bundled_libraries(str(p) for p in _FROZEN_TREE.rglob("*")))
    assert libraries, (
        f"{_FROZEN_TREE} holds no shared libraries at all. An empty scan subtracts to an "
        "empty set, so the unrecorded-library check below would pass on it having looked "
        "at nothing"
    )
    return libraries


def _recorded_frozen_libraries() -> frozenset[str]:
    """The inventory for this platform, or a failure naming what to record.

    One definition, so both directions agree: a platform with no record fails
    rather than skips, which is what `_FROZEN_LIBRARIES` above says it does.
    Written twice, the drop-out direction skipped — so on the first build for a
    new platform the half that catches a library *leaving* would not run.
    """
    recorded = _FROZEN_LIBRARIES.get(sys.platform)
    assert recorded is not None, (
        f"no frozen inventory recorded for {sys.platform!r}. The freeze ships a "
        "different set on each platform, so record this one after checking each "
        f"library's licence: {sorted(_frozen_libraries())}"
    )
    return recorded


@pytest.mark.freeze
def test_no_unrecorded_library_ships_in_the_frozen_engine() -> None:
    """The guard the installed-closure tests cannot make.

    They scan site-packages, which holds neither the system libraries
    PyInstaller resolves from the build machine nor, necessarily, the same
    versions. A library can therefore ship in every installer while every
    other test in this file is green.
    """
    present = _frozen_libraries()
    unrecorded = present - _recorded_frozen_libraries()
    assert not unrecorded, (
        "the frozen engine ships a native library nobody has licensed. Unlike the "
        "closure tests, this covers what PyInstaller pulls from the build machine "
        "- libstdc++, libgcc_s and libmvec reach the installers this way today. "
        "Establish each one's licence, then record it here and, if it is "
        "copyleft, in third_party_notices' terms table so the shipped NOTICE "
        f"names what it obliges: {sorted(unrecorded)}"
    )


@pytest.mark.freeze
def test_the_frozen_engine_still_ships_what_was_recorded() -> None:
    """The other direction: a library dropping out is a licence change too."""
    present = _frozen_libraries()
    missing = _recorded_frozen_libraries() - present
    assert not missing, (
        "a library recorded as shipping in the frozen engine is no longer there. "
        "If that is a dependency being dropped it is the fix landing and the "
        f"entry should be pruned; if it merely moved, the record is wrong: {sorted(missing)}"
    )


@pytest.mark.freeze
def test_every_copyleft_library_in_the_freeze_is_named_in_the_notices() -> None:
    """Silence beside a name in the NOTICE is a claim, not an omission.

    The generated document says copyleft libraries are named with what they
    oblige, so one listed bare reads as an assertion that it carries no such
    terms — in the text Apache-2.0 §4(d) obliges every redistributor to
    reproduce. This pins the ones that carried terms when the record was taken,
    so deleting a row from the terms table is a failure rather than a quiet
    change to what ships.

    Per-platform, because which libraries these are is a per-platform fact:
    six of the seven Linux entries — the GCC runtime set and glibc's libmvec,
    which PyInstaller resolves from the build machine — are in neither of the
    others, where the toolchain runtime comes from the system instead. A single
    POSIX-spelled list asserted everywhere fails on the two platforms that
    simply do not ship them. Membership is tested on the key `copyleft_note`
    looks a name up by rather than on the literal string, so a platform
    spelling its libraries differently is not read as an absence.
    """
    recorded = _FROZEN_COPYLEFT.get(sys.platform)
    assert recorded is not None, (
        f"no copyleft record for {sys.platform!r} - record it alongside the "
        "inventory, from a real packaging run"
    )
    present = {annotation_key(name) for name in _frozen_libraries()}
    for library in sorted(recorded):
        assert annotation_key(library) in present, (
            f"{library} is recorded as shipping in this platform's frozen engine "
            "and is not in it - prune the record deliberately, or find out where "
            "it went"
        )
        assert copyleft_note(library), (
            f"{library} ships in the frozen engine and third_party_notices no "
            "longer names its terms, so the NOTICE lists it with nothing beside it"
        )
