"""Builds the third-party notices the frozen engine has to carry.

The freeze redistributes its whole runtime closure — Python distributions and
the native libraries their wheels bundle — so the licence texts of all of it
have to travel with the installers. Nothing generated this before, and the
default is silence: a wheel's LICENSE file is not copied anywhere by
PyInstaller, so the notice a licence obliges us to reproduce simply did not
ship.

Generated at freeze time rather than committed, because the answer is not the
same on every platform: the `av` wheel bundles a different set of FFmpeg
libraries per OS and architecture, so a file generated on Linux would
under-report what a Windows installer actually contains. `localcut.spec` calls
`write_notices()` and hands the result to PyInstaller as data.

Scoped to the runtime closure, walked from the project's own dependencies —
the build environment also holds pytest, ruff and PyInstaller, none of which
is redistributed, and listing them would make the document less true rather
than more complete.
"""

from __future__ import annotations

import importlib.metadata as metadata
import re
import sysconfig
from pathlib import Path

_PROJECT = "localcut-engine"

_LICENCE_FILENAMES = re.compile(r"^(LICEN[CS]E|COPYING|NOTICE)", re.IGNORECASE)
_SHARED_OBJECT = re.compile(r"\.(so|dylib|dll)(\.|$)")
_HASH_SUFFIX = re.compile(r"-[0-9a-f]{6,}$")
_VERSION_SUFFIX = re.compile(r"[-.][0-9][0-9.]*$")
_ARCH_SUFFIX = re.compile(r"_(x86_64|aarch64|arm64|amd64)$")

#: Native libraries known to carry copyleft terms, and what each one obliges.
#: Recorded rather than derived: a `.so` inside a wheel has no metadata to read,
#: so the only alternative to a table is silence about the strongest terms in
#: the box.
COPYLEFT_LIBRARIES = {
    "libx264": "GPL-2.0-or-later — bundled inside the `av` wheel's FFmpeg build",
    "libx265": "GPL-2.0-or-later — bundled inside the `av` wheel's FFmpeg build",
    "libespeak-ng": "GPL-3.0 — bundled inside the `espeakng-loader` wheel",
    "libsndfile": "LGPL-2.1-or-later — bundled inside the `soundfile` wheel",
    "libmp3lame": "LGPL-2.0-or-later — bundled inside the `av` wheel's FFmpeg build",
    "libgnutls": "LGPL-2.1-or-later — bundled inside the `av` wheel's FFmpeg build",
    "libgmp": "LGPL-3.0-or-later or GPL-2.0-or-later — via the `av` wheel's GnuTLS",
    "libnettle": "LGPL-3.0-or-later or GPL-2.0-or-later — via the `av` wheel's GnuTLS",
    "libhogweed": "LGPL-3.0-or-later or GPL-2.0-or-later — via the `av` wheel's GnuTLS",
    "libunistring": "LGPL-3.0-or-later or GPL-2.0-or-later — via the `av` wheel's GnuTLS",
    "libasound": "LGPL-2.1-or-later — bundled inside the `av` wheel's FFmpeg build",
    # FFmpeg itself is LGPL-2.1 by default, but this build is configured with
    # libx264 and libx265, and linking a GPL encoder makes the resulting
    # libraries GPL. Saying "LGPL" here because the project usually is would
    # understate what these particular binaries carry.
    "libavcodec": "GPL-2.0-or-later as built — FFmpeg linked against libx264/libx265",
    "libavdevice": "GPL-2.0-or-later as built — FFmpeg linked against libx264/libx265",
    "libavfilter": "GPL-2.0-or-later as built — FFmpeg linked against libx264/libx265",
    "libavformat": "GPL-2.0-or-later as built — FFmpeg linked against libx264/libx265",
    "libavutil": "GPL-2.0-or-later as built — FFmpeg linked against libx264/libx265",
    "libswresample": "GPL-2.0-or-later as built — FFmpeg linked against libx264/libx265",
    "libswscale": "GPL-2.0-or-later as built — FFmpeg linked against libx264/libx265",
    "libgomp": "GPL-3.0-or-later WITH GCC-exception-3.1 — the exception is what makes this unencumbering",
    "libgfortran": "GPL-3.0-or-later WITH GCC-exception-3.1",
    "libquadmath": "LGPL-2.1-or-later WITH GCC-exception-3.1",
}


def _normalise_library(filename: str) -> str:
    """`libx264-d6533a8d.so.165` -> `libx264`."""
    name = re.sub(r"\.(so|dylib|dll)(\.[0-9.]+)?$", "", filename)
    name = _ARCH_SUFFIX.sub("", name)
    while True:
        stripped = _VERSION_SUFFIX.sub("", _HASH_SUFFIX.sub("", name))
        if stripped == name:
            return name
        name = stripped


def _requirement_names(dist: metadata.Distribution) -> list[str]:
    """Runtime requirements only — extras are not installed, so not shipped."""
    from packaging.requirements import Requirement

    names = []
    for raw in dist.requires or []:
        try:
            requirement = Requirement(raw)
        except Exception:
            continue
        marker = requirement.marker
        # `extra == "..."` markers guard optional dependencies. Nothing here
        # installs extras, so anything behind one is not in the freeze.
        if marker is not None and "extra" in str(marker):
            continue
        names.append(requirement.name)
    return names


def runtime_distributions() -> list[metadata.Distribution]:
    """Breadth-first from the project's own dependencies."""
    seen: dict[str, metadata.Distribution] = {}
    try:
        queue = _requirement_names(metadata.distribution(_PROJECT))
    except metadata.PackageNotFoundError:
        return []
    while queue:
        name = queue.pop(0)
        key = name.lower().replace("_", "-")
        if key in seen:
            continue
        try:
            dist = metadata.distribution(name)
        except metadata.PackageNotFoundError:
            continue
        seen[key] = dist
        queue.extend(_requirement_names(dist))
    return [seen[k] for k in sorted(seen)]


def _licence_text(dist: metadata.Distribution) -> str:
    """A distribution's own licence text, from wherever the wheel put it."""
    # Modern wheels (PEP 639) record them; older ones just drop a file in the
    # dist-info. Try the record first, then look.
    for name in dist.metadata.get_all("License-File") or []:
        try:
            text = dist.read_text(f"licenses/{name}") or dist.read_text(name)
        except (OSError, ValueError):
            text = None
        if text:
            return text.strip()
    files = dist.files or []
    for path in files:
        parts = str(path).split("/")
        if (
            len(parts) >= 2
            and parts[-2] in {"licenses", "license"}
            or _LICENCE_FILENAMES.match(parts[-1])
        ):
            if ".dist-info" not in str(path):
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError, ValueError):
                continue
            if text and text.strip():
                return text.strip()
    return ""


def _declared_licence(dist: metadata.Distribution) -> str:
    meta = dist.metadata
    expression = meta.get("License-Expression")
    if expression:
        return expression
    classifiers = [v for k, v in meta.items() if k == "Classifier" and v.startswith("License ::")]
    if classifiers:
        return "; ".join(c.split(" :: ")[-1] for c in classifiers)
    declared = (meta.get("License") or "").strip()
    # Some wheels put the entire licence text in the License field.
    if declared and "\n" not in declared and len(declared) < 80:
        return declared
    return "see the text below" if declared else "not declared"


def site_package_roots() -> list[Path]:
    """Both install roots, deduplicated.

    `purelib` and `platlib` are the same directory inside a venv, which is why
    scanning either looks sufficient — but they are distinct under a Debian
    system Python and on some packaging layouts, and compiled wheels land in
    `platlib`. Scanning the union means the answer does not depend on which
    interpreter built the freeze.
    """
    paths = sysconfig.get_paths()
    roots = []
    for key in ("purelib", "platlib"):
        root = Path(paths[key])
        if root.is_dir() and root not in roots:
            roots.append(root)
    return roots


def bundled_libraries() -> list[str]:
    """Native libraries riding inside wheels, normalised free of version noise."""
    found = set()
    for root in site_package_roots():
        for path in root.rglob("*"):
            name = path.name
            if not _SHARED_OBJECT.search(name) or ".abi3" in name or ".cpython-" in name:
                continue
            found.add(_normalise_library(name))
    return sorted(found)


def build_notices() -> str:
    """The whole document, as it should land beside LICENSE in the freeze."""
    lines = [
        "THIRD-PARTY NOTICES — LocalCut AI engine",
        "=" * 72,
        "",
        "LocalCut AI is licensed under the Apache License 2.0 (see LICENSE).",
        "This file records the third-party software the engine is distributed",
        "with, and reproduces the licence notices those components require.",
        "",
        "It is generated at build time from the packaged environment, so it",
        "describes this build on this platform rather than a checkout.",
        "",
    ]

    distributions = runtime_distributions()
    lines += ["", "PYTHON DISTRIBUTIONS", "-" * 72, ""]
    for dist in distributions:
        name = dist.metadata["Name"]
        lines.append(f"{name} {dist.version}")
        lines.append(f"    License: {_declared_licence(dist)}")
        url = dist.metadata.get("Home-page") or ""
        if url:
            lines.append(f"    {url}")
        text = _licence_text(dist)
        if text:
            lines.append("")
            lines += ["    " + line if line else "" for line in text.splitlines()]
        else:
            # Silence here would read as "nothing to reproduce" when what it
            # means is "this wheel shipped no text to reproduce". The reader
            # needs to know which, because the second one is a gap upstream
            # owns and the strongest terms in this document sit behind one
            # of them (espeakng-loader ships a GPL library with no licence
            # file and no License field at all).
            lines.append("    This wheel publishes no licence file; see the project above.")
        lines.append("")

    libraries = bundled_libraries()
    lines += ["", "BUNDLED NATIVE LIBRARIES", "-" * 72, ""]
    lines += [
        "These ship inside the wheels above rather than as packages of their",
        "own. Those carrying copyleft terms are named with what they oblige;",
        "for their full texts and corresponding source, see the upstream",
        "project for each.",
        "",
    ]
    for library in libraries:
        note = COPYLEFT_LIBRARIES.get(library)
        lines.append(f"  {library}" + (f" — {note}" if note else ""))
    lines.append("")

    return "\n".join(lines) + "\n"


def write_notices(destination: Path) -> Path:
    destination.write_text(build_notices(), encoding="utf-8")
    return destination


if __name__ == "__main__":  # pragma: no cover - a convenience for inspecting it
    import sys

    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("THIRD-PARTY-NOTICES.txt")
    print(f"wrote {write_notices(target)}")
