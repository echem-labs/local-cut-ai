"""Builds the third-party notices the frozen engine has to carry.

The freeze redistributes its whole runtime closure — Python distributions and
the native libraries PyInstaller collects alongside them — so the licence
texts of all of it have to travel with the installers. Nothing generated this
before, and the default is silence: a wheel's LICENSE file is not copied
anywhere by PyInstaller, so the notice a licence obliges us to reproduce
simply did not ship.

Generated at freeze time rather than committed, because the answer is not the
same on every platform: the `av` wheel bundles a different set of FFmpeg
libraries per OS and architecture, so a file generated on Linux would
under-report what a Windows installer actually contains. `localcut.spec` calls
`write_notices()` and hands the result to PyInstaller as data.

Scoped to the runtime closure, walked from the project's own dependencies —
the build environment also holds pytest, ruff and PyInstaller, none of which
is redistributed, and listing them would make the document less true rather
than more complete. The extras the project asks for are part of that closure:
`uvicorn[standard]` installs uvloop, httptools and watchfiles, and the freeze
carries all three.

The native library list comes from what PyInstaller actually collected, not
from a scan of site-packages. Most of what the installers carry links in from
the system rather than riding inside a wheel — on Linux that is 33 of 73
libraries, `libreadline` among them — and a scan sees none of it.
"""

from __future__ import annotations

import importlib.metadata as metadata
import re
import site
import sysconfig
from collections.abc import Iterable
from pathlib import Path

_PROJECT = "localcut-engine"

# Anchored at both ends so `licenses.py` — a module, not a notice — cannot
# match on its first seven characters. Anything after the word has to start
# with a separator: LICENSE.txt, LICENSE-APACHE, COPYING.LESSER all do.
_LICENCE_FILENAMES = re.compile(r"(LICEN[CS]E|COPYING|NOTICE)([-._].*)?", re.IGNORECASE)
_SHARED_OBJECT = re.compile(r"\.(so|dylib|dll)(\.|$)", re.IGNORECASE)
_HASH_SUFFIX = re.compile(r"-[0-9a-f]{6,}$")
_VERSION_SUFFIX = re.compile(r"[-.][0-9][0-9.]*$")
# `x64`/`x86` are the spellings Windows wheels use — `libsndfile_x64.dll`
# is how the `soundfile` wheel names the LGPL library it carries there.
_ARCH_SUFFIX = re.compile(r"_(x86_64|aarch64|arm64|amd64|x64|x86)$")

#: Project-URL labels that name the project itself, best first. A wheel that
#: publishes no `Home-page` — most of this closure, the field having been
#: deprecated — still says where it lives, just under PEP 621's key instead.
_URL_LABELS = ("homepage", "home-page", "home", "repository", "source", "source code")

#: Grouped so a note shared by several libraries is written once. Seven FFmpeg
#: libraries carry the same sentence, and the failure mode of seven copies is
#: correcting six of them — leaving one library quietly stating different
#: terms from its siblings, with nothing to catch the divergence.
_COPYLEFT_TERMS = {
    ("libx264", "libx265"): "GPL-2.0-or-later — bundled inside the `av` wheel's FFmpeg build",
    (
        "libavcodec",
        "libavdevice",
        "libavfilter",
        "libavformat",
        "libavutil",
        "libswresample",
        "libswscale",
    ): "GPL-2.0-or-later as built — FFmpeg linked against libx264/libx265",
    (
        "libgmp",
        "libnettle",
        "libhogweed",
        "libunistring",
    ): "LGPL-3.0-or-later or GPL-2.0-or-later — via the `av` wheel's GnuTLS",
    (
        "libgnutls",
        "libasound",
        "libiconv",
    ): "LGPL-2.1-or-later — bundled inside the `av` wheel's FFmpeg build",
    ("libmp3lame",): "LGPL-2.0-or-later — bundled inside the `av` wheel's FFmpeg build",
    ("libespeak-ng",): "GPL-3.0 — bundled inside the `espeakng-loader` wheel",
    ("libpcaudio",): "GPL-3.0-or-later — espeak-ng's audio output library",
    ("libsndfile",): "LGPL-2.1-or-later — bundled inside the `soundfile` wheel",
    ("libmpg123",): "LGPL-2.1-only — via the `soundfile` wheel's libsndfile",
    (
        "libgfortran",
        "libstdc++",
        "libgcc_s",
        # MinGW spells the GCC runtime `libgcc_s_seh-1.dll`, which shares no
        # stem with the POSIX `libgcc_s.so.1`, so it needs its own key.
        "libgcc_s_seh",
    ): "GPL-3.0-or-later WITH GCC-exception-3.1",
    (
        "libgomp",
    ): "GPL-3.0-or-later WITH GCC-exception-3.1 — the exception is what makes this unencumbering",
    ("libquadmath",): "LGPL-2.1-or-later WITH GCC-exception-3.1",
    ("libmvec",): "LGPL-2.1-or-later WITH glibc exceptions — part of glibc",
    # Collected from the system rather than from a wheel, which is why a
    # site-packages scan never saw them. readline is the one that matters:
    # plain GPL, no linking exception, pulled in by CPython's own readline
    # module.
    ("libreadline",): "GPL-3.0-or-later — linked by CPython's `readline` module",
    ("libtinfo",): "X11 (ncurses) — linked by libreadline",
    (
        "libpulse",
        "libpulse-simple",
        "libpulsecommon",
    ): "LGPL-2.1-or-later — linked by libasound/libsndfile",
    ("libasyncns",): "LGPL-2.1-or-later — linked by libpulse",
    ("libapparmor",): "LGPL-2.1-or-later — linked by libdbus",
    ("libsystemd",): "LGPL-2.1-or-later — linked by libdbus/libpulse",
    ("libdbus",): "AFL-2.1 or GPL-2.0-or-later, at your option — linked by libpulse",
}

#: Native libraries known to carry copyleft terms, and what each one obliges.
#: Recorded rather than derived: a `.so` inside a wheel has no metadata to read,
#: so the only alternative to a table is silence about the strongest terms in
#: the box.
COPYLEFT_LIBRARIES = {
    library: note for libraries, note in _COPYLEFT_TERMS.items() for library in libraries
}

#: The same table keyed the way Windows spells these: `avcodec-62.dll`, not
#: `libavcodec.so.62`. Generating the document per platform is the whole
#: reason this runs at build time, so a lookup that only knew the POSIX
#: spelling would drop every copyleft annotation from the one installer the
#: per-platform generation exists for.
_COPYLEFT_BY_STEM = {
    key.lower().removeprefix("lib"): note for key, note in COPYLEFT_LIBRARIES.items()
}


def _normalise_library(filename: str) -> str:
    """`libx264-d6533a8d.so.165` -> `libx264`."""
    name = re.sub(r"\.(so|dylib|dll)(\.[0-9.]+)?$", "", filename, flags=re.IGNORECASE)
    name = _ARCH_SUFFIX.sub("", name)
    while True:
        stripped = _VERSION_SUFFIX.sub("", _HASH_SUFFIX.sub("", name))
        if stripped == name:
            return name
        name = stripped


def copyleft_note(library: str) -> str | None:
    """What a normalised library name obliges, in either spelling."""
    return COPYLEFT_LIBRARIES.get(library) or _COPYLEFT_BY_STEM.get(
        library.lower().removeprefix("lib")
    )


def _requirement_names(
    dist: metadata.Distribution, extras: frozenset[str] = frozenset()
) -> list[tuple[str, frozenset[str]]]:
    """Runtime requirements, each with the extras it was asked for.

    Markers are evaluated rather than pattern-matched. An `extra == "..."`
    marker guards a dependency that IS installed once something asks for that
    extra, and this project asks: `uvicorn[standard]` pulls in uvloop,
    httptools and watchfiles, all three of which the freeze ships. Skipping
    every marker that mentions `extra` left all three out of the notices.
    Evaluating also drops what genuinely is not installed here — a
    `python_version < "3.11"` or `sys_platform == "win32"` requirement.
    """
    from packaging.requirements import Requirement

    names: list[tuple[str, frozenset[str]]] = []
    # The empty string stands for "asked for with no extra", which is how a
    # requirement carrying only a platform marker has to be evaluated.
    candidates = set(extras) | {""}
    for raw in dist.requires or []:
        # Deliberately not swallowed: a requirement this cannot parse prunes
        # the whole subtree behind it, and the result is a document that is
        # short by however much hung off it with nothing on its face to say
        # so. The module's position everywhere else is that an unbuildable
        # closure stops the build rather than shipping a quiet half-answer.
        requirement = Requirement(raw)
        marker = requirement.marker
        if marker is not None and not any(
            marker.evaluate({"extra": extra}) for extra in candidates
        ):
            continue
        names.append((requirement.name, frozenset(requirement.extras)))
    return names


def runtime_distributions() -> list[metadata.Distribution]:
    """Breadth-first from the project's own dependencies."""
    from packaging.utils import canonicalize_name

    seen: dict[str, metadata.Distribution] = {}
    # Keyed on the extras too: a distribution reached first without extras and
    # again with them has more requirements the second time.
    visited: set[tuple[str, frozenset[str]]] = set()
    try:
        queue = _requirement_names(metadata.distribution(_PROJECT))
    except metadata.PackageNotFoundError as exc:
        # Returning nothing here would write a header with no body: a file that
        # exists, lands in the freeze, and looks like compliance from the
        # outside while naming none of what it ships. Fail the build instead.
        raise LookupError(
            f"{_PROJECT} is not installed in this environment, so the runtime closure "
            "cannot be walked and the notices would ship empty"
        ) from exc
    while queue:
        name, extras = queue.pop(0)
        key = canonicalize_name(name)
        if (key, extras) in visited:
            continue
        visited.add((key, extras))
        try:
            dist = metadata.distribution(name)
        except metadata.PackageNotFoundError:
            continue
        seen.setdefault(key, dist)
        queue.extend(_requirement_names(dist, extras))
    return [seen[k] for k in sorted(seen)]


def licence_texts(dist: metadata.Distribution) -> list[str]:
    """Every licence text a distribution published, from wherever the wheel put it.

    All of them, not the first: `cryptography` and `packaging` each declare
    LICENSE, LICENSE.APACHE and LICENSE.BSD, where the first is a three-line
    pointer at the other two — reproducing only it reproduces no licence at
    all.

    Modern wheels (PEP 639) record the files in metadata; older ones just drop
    them in the dist-info; a few put them nowhere but the package directory,
    which is where `onnxruntime` keeps the only copy of its MIT text.
    """
    declared: list[str] = []
    for name in dist.metadata.get_all("License-File") or []:
        if not _LICENCE_FILENAMES.fullmatch(name.rsplit("/", 1)[-1]):
            continue
        try:
            text = dist.read_text(f"licenses/{name}") or dist.read_text(name)
        except (OSError, ValueError):
            text = None
        if text and text.strip():
            declared.append(text.strip())
    if declared:
        return declared

    # Nothing recorded. Look at what was installed, preferring the dist-info
    # over the package directory so a vendored licence never stands in for the
    # distribution's own.
    in_dist_info: list[str] = []
    in_package: list[str] = []
    for path in dist.files or []:
        location = str(path)
        if not _LICENCE_FILENAMES.fullmatch(location.rsplit("/", 1)[-1]):
            continue
        try:
            body = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError, ValueError):
            continue
        if not (body and body.strip()):
            continue
        (in_dist_info if ".dist-info" in location else in_package).append(body.strip())
    return in_dist_info or in_package


def _project_url(dist: metadata.Distribution) -> str:
    """Where the project lives, from either metadata key that can say so."""
    home = (dist.metadata.get("Home-page") or "").strip()
    if home:
        return home
    entries = [entry.partition(",") for entry in dist.metadata.get_all("Project-URL") or []]
    for label in _URL_LABELS:
        for name, _, url in entries:
            if name.strip().lower() == label:
                return url.strip()
    return entries[0][2].strip() if entries else ""


def _declared_licence(dist: metadata.Distribution, has_text: bool) -> str:
    """What the wheel says its licence is, in the most precise form it offers.

    PEP 639's `License-Expression` first, being the only one that is SPDX by
    construction. Then the wheel's own `License` field ahead of a single
    classifier, because the classifier vocabulary is coarse where the field is
    exact: `babel` declares `BSD-3-Clause` and classifies as "BSD License",
    which does not say 2-, 3- or 4-clause. Several classifiers outrank it
    again — they are how a wheel spells a dual licence that the field
    summarises away, as `python-dateutil` does with "Dual License".
    """
    meta = dist.metadata
    expression = meta.get("License-Expression")
    if expression:
        return expression
    classifiers = [
        v.split(" :: ")[-1]
        for k, v in meta.items()
        if k == "Classifier" and v.startswith("License ::")
    ]
    declared = (meta.get("License") or "").strip()
    # Some wheels put the entire licence text in the License field, which is
    # not a name and does not belong on this line.
    concise = declared if declared and "\n" not in declared and len(declared) < 80 else ""
    if len(classifiers) > 1:
        return "; ".join(classifiers)
    if concise:
        return concise
    if classifiers:
        return classifiers[0]
    return "see the text below" if declared or has_text else "not declared"


def site_package_roots() -> list[Path]:
    """Every directory installed distributions can be under, deduplicated.

    Only used when nothing hands over what the freeze collected. `purelib` and
    `platlib` are the same directory in every scheme CPython ships — checked,
    not assumed — so taking their union is not what makes this
    layout-independent; `site.getsitepackages()` is. Under a Debian system
    Python `sysconfig`'s default scheme resolves to
    `/usr/local/lib/pythonX/dist-packages` while apt installs into
    `/usr/lib/python3/dist-packages`, and only `site` names the second.
    """
    roots: list[Path] = []
    candidates = [sysconfig.get_paths()["purelib"], sysconfig.get_paths()["platlib"]]
    try:
        candidates += site.getsitepackages()
    except AttributeError:  # pragma: no cover - absent under virtualenv's site
        pass
    for candidate in candidates:
        root = Path(candidate)
        if root.is_dir() and root not in roots:
            roots.append(root)
    return roots


def bundled_libraries(filenames: Iterable[str] | None = None) -> list[str]:
    """Native libraries the freeze carries, normalised free of version noise.

    `filenames` is what PyInstaller actually collected — the spec passes
    `Analysis.binaries`, and that is the only list that describes the
    installers. Scanning site-packages instead sees only the libraries riding
    inside wheels and misses every system library those wheels link against:
    on the last Linux freeze that was 33 of 73, `libreadline` (GPL-3.0) among
    them. The scan stays as the default so the answer is still available
    outside a build.
    """
    if filenames is None:
        filenames = (str(path) for root in site_package_roots() for path in root.rglob("*"))
    found = set()
    for filename in filenames:
        name = filename.replace("\\", "/").rsplit("/", 1)[-1]
        if not _SHARED_OBJECT.search(name) or ".abi3" in name or ".cpython-" in name:
            continue
        found.add(_normalise_library(name))
    return sorted(found)


def build_notices(libraries: list[str] | None = None) -> str:
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
        texts = licence_texts(dist)
        lines.append(f"{name} {dist.version}")
        lines.append(f"    License: {_declared_licence(dist, bool(texts))}")
        url = _project_url(dist)
        if url:
            lines.append(f"    {url}")
        if texts:
            for text in texts:
                lines.append("")
                lines += ["    " + line if line.strip() else "" for line in text.splitlines()]
        else:
            # Silence here would read as "nothing to reproduce" when what it
            # means is "this wheel shipped no text to reproduce". The reader
            # needs to know which, because the second one is a gap upstream
            # owns and the strongest terms in this document sit behind one
            # of them (espeakng-loader ships a GPL library with no licence
            # file and no License field at all).
            lines.append(
                "    This wheel publishes no licence file; see the project above."
                if url
                else "    This wheel publishes no licence file and names no project URL."
            )
        lines.append("")

    if libraries is None:
        libraries = bundled_libraries()
    lines += ["", "BUNDLED NATIVE LIBRARIES", "-" * 72, ""]
    lines += [
        "These ship as part of the freeze rather than as packages of their",
        "own — some inside the wheels above, the rest linked in from the build",
        "machine. Those carrying copyleft terms are named with what they",
        "oblige; for their full texts and corresponding source, see the",
        "upstream project for each.",
        "",
    ]
    for library in libraries:
        note = copyleft_note(library)
        lines.append(f"  {library}" + (f" — {note}" if note else ""))
    lines.append("")

    return "\n".join(lines) + "\n"


def write_notices(destination: Path, libraries: list[str] | None = None) -> Path:
    destination.write_text(build_notices(libraries), encoding="utf-8")
    return destination


if __name__ == "__main__":  # pragma: no cover - a convenience for inspecting it
    import sys

    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("THIRD-PARTY-NOTICES.txt")
    print(f"wrote {write_notices(target)}")
