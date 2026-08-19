"""What the generated third-party notices must say to be worth shipping.

Not to be confused with `test_notices.py`, which covers the render notice
channel — an unrelated feature that owns that word in this codebase. This one
is about the licence texts the frozen engine redistributes.

The document is generated at freeze time (`localcut.spec` calls
`write_notices`), so nothing in the repository holds its content and nothing
would notice it silently emptying — a generator that returned a header and no
body would still produce a file, still land in the freeze, and still look like
compliance from the outside.

These run the real generator against the installed environment rather than a
fixture, because what is being asserted is exactly that it describes *this*
closure.
"""

from __future__ import annotations

import importlib.metadata as metadata
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "packaging"))

from third_party_notices import (  # noqa: E402  (needs the path above)
    _LICENCE_FILENAMES,
    COPYLEFT_LIBRARIES,
    _normalise_library,
    _project_url,
    copyleft_note,
    build_notices,
    bundled_libraries,
    licence_texts,
    runtime_distributions,
    site_package_roots,
    write_notices,
)

_DEV_ONLY = ("pytest", "ruff", "pyinstaller", "pre-commit")


@pytest.fixture(scope="module")
def document() -> str:
    return build_notices()


def _canonical(name: str) -> str:
    from packaging.utils import canonicalize_name

    return canonicalize_name(name)


def test_it_describes_the_runtime_closure_not_the_build_environment() -> None:
    # Canonicalised, not lowercased: `pre-commit` installs under the metadata
    # name `pre_commit`, so a raw comparison checks a hyphen against an
    # underscore and that quarter of the guard can never fire.
    names = {_canonical(dist.metadata["Name"]) for dist in runtime_distributions()}
    assert "fastapi" in names, "the runtime closure is not being walked at all"
    for tool in _DEV_ONLY:
        # Prefix, not equality: `pytest-asyncio` and `pyinstaller-hooks-contrib`
        # are build-environment packages too, and an exact match lets them
        # through the guard that exists to keep the document true.
        leaked = sorted(n for n in names if n == tool or n.startswith(f"{tool}-"))
        assert not leaked, (
            f"{leaked} is a build-time tool that is not redistributed — listing it makes "
            "the notices less true, not more complete"
        )


def test_the_extras_the_project_asks_for_are_in_the_closure() -> None:
    """`uvicorn[standard]` is a dependency of ours, so its extra ships.

    A walk that drops every requirement whose marker mentions `extra` drops
    uvloop, httptools and watchfiles — all three of which PyInstaller collects
    into the freeze — while the document goes on claiming to describe it.
    """
    from packaging.requirements import Requirement

    walked = {_canonical(dist.metadata["Name"]) for dist in runtime_distributions()}
    expected: set[str] = set()
    for raw in metadata.distribution("localcut-engine").requires or []:
        asked = Requirement(raw)
        if not asked.extras:
            continue
        for sub in metadata.distribution(asked.name).requires or []:
            behind = Requirement(sub)
            if behind.marker is None or not any(
                behind.marker.evaluate({"extra": extra}) for extra in asked.extras
            ):
                continue
            try:
                metadata.distribution(behind.name)
            except metadata.PackageNotFoundError:
                continue  # not installed on this platform, so not shipped
            expected.add(_canonical(behind.name))
    assert expected, "no dependency of ours asks for an extra any more — this test is stale"
    assert expected <= walked, f"{sorted(expected - walked)} ship but are not in the notices"


def test_every_distribution_is_named_with_a_licence(document: str) -> None:
    for dist in runtime_distributions():
        name = dist.metadata["Name"]
        assert f"\n{name} {dist.version}\n" in document, f"{name} missing from the notices"
    # "not declared" is the generator's honest fallback; it must stay rare
    # enough to be a fact about upstream rather than a hole in this code.
    assert document.count("License: not declared") <= 2


def test_a_wheel_is_named_with_the_most_precise_licence_it_declares(document: str) -> None:
    """The classifier vocabulary is coarser than the field beside it.

    "BSD License" does not say 2-, 3- or 4-clause, and for a wheel that ships
    no licence text that string is the entire compliance record. Where the
    wheel's own `License` field is more specific, that is what belongs on the
    line — except where several classifiers spell out a dual licence the field
    summarises away.
    """
    checked = 0
    for dist in runtime_distributions():
        meta = dist.metadata
        if meta.get("License-Expression"):
            continue
        classifiers = [
            v.split(" :: ")[-1]
            for k, v in meta.items()
            if k == "Classifier" and v.startswith("License ::")
        ]
        declared = (meta.get("License") or "").strip()
        if len(classifiers) != 1 or not declared or "\n" in declared or len(declared) >= 80:
            continue
        if declared == classifiers[0]:
            continue
        checked += 1
        assert f"\n{meta['Name']} {dist.version}\n    License: {declared}\n" in document, (
            f"{meta['Name']} declares {declared!r} but the notices print the "
            f"classifier {classifiers[0]!r}"
        )
    assert checked, "no wheel in the closure declares more than its classifier — test is stale"


def test_a_dual_licence_keeps_the_classifiers_that_spell_it_out(document: str) -> None:
    """`python-dateutil`'s License field reads "Dual License" and names neither.

    Preferring the field unconditionally would replace two classifiers that
    say Apache and BSD with a string that says nothing.
    """
    for dist in runtime_distributions():
        meta = dist.metadata
        classifiers = [
            v.split(" :: ")[-1]
            for k, v in meta.items()
            if k == "Classifier" and v.startswith("License ::")
        ]
        if meta.get("License-Expression") or len(classifiers) < 2:
            continue
        assert f"    License: {'; '.join(classifiers)}\n" in document, (
            f"{meta['Name']} is dual-licensed and the notices name only one of them"
        )


def test_it_reproduces_licence_texts_rather_than_only_naming_them(document: str) -> None:
    # The obligation this file exists for. An SPDX identifier is not a notice.
    assert document.count("Permission is hereby granted") >= 10
    assert "Apache License" in document


def test_a_wheel_that_ships_no_licence_text_says_so(document: str) -> None:
    """Silence would read as 'nothing to reproduce'."""
    assert "This wheel publishes no licence file" in document


def test_a_licence_file_outside_the_dist_info_is_still_found() -> None:
    """`onnxruntime` keeps the only copy of its MIT text in the package directory.

    Reporting "publishes no licence file" for a wheel that ships one states a
    falsehood about upstream in a document whose whole value is being true.
    """
    for dist in runtime_distributions():
        if licence_texts(dist):
            continue
        stray = [
            str(path)
            for path in dist.files or []
            if _LICENCE_FILENAMES.fullmatch(str(path).rsplit("/", 1)[-1])
        ]
        assert not stray, f"{dist.metadata['Name']} ships {stray[0]} but the notices deny it"


def test_a_wheel_declaring_several_licence_files_reproduces_all_of_them(document: str) -> None:
    """`cryptography` declares LICENSE, LICENSE.APACHE and LICENSE.BSD.

    The first is a three-line pointer at the other two, so reproducing only
    the first reproduces no licence at all.
    """
    several = [dist for dist in runtime_distributions() if len(licence_texts(dist)) > 1]
    assert several, "no wheel in the closure declares more than one licence file — test is stale"
    for dist in several:
        for text in licence_texts(dist):
            block = "\n".join("    " + line if line.strip() else "" for line in text.splitlines())
            assert block in document, (
                f"{dist.metadata['Name']} declares a licence file the document drops"
            )


def test_a_distribution_that_says_where_it_lives_is_linked(document: str) -> None:
    """Most of these wheels publish `Project-URL` and no `Home-page`.

    Reading only the deprecated key leaves "see the project above" pointing at
    nothing, which is the one line a reader follows when a wheel ships no text.
    """
    for dist in runtime_distributions():
        if not (dist.metadata.get("Home-page") or dist.metadata.get_all("Project-URL")):
            continue
        assert _project_url(dist), f"{dist.metadata['Name']} names a URL the document drops"
    # And the sentence that sends the reader to that URL only appears where one
    # was printed: `espeakng-loader` — the GPL-3.0 one — publishes neither.
    for entry in document.split("\n\n"):
        if "see the project above" not in entry:
            continue
        assert "http" in entry, f"'see the project above' points at nothing:\n{entry}"


def test_the_bundled_native_libraries_are_listed(document: str) -> None:
    """Matched whole-line, because five of these names prefix another one.

    `  libxcb` is a substring of `  libxcb-shape`, so a containment check
    passes with the `libxcb` line deleted outright — and the same holds for
    `libwebp` under `libwebpmux` and `libonnxruntime` under
    `libonnxruntime_providers_shared`. A test whose failure message is
    "ships but is not in the notices" has to be able to detect that.
    """
    libraries = bundled_libraries()
    assert len(libraries) > 20, "the native libraries inside wheels are not being found"
    listed = {ln.split(" — ", 1)[0] for ln in document.splitlines() if ln.startswith("  lib")}
    missing = [library for library in libraries if f"  {library}" not in listed]
    assert not missing, f"{missing} ship but are not in the notices"


def test_the_library_list_can_come_from_what_the_freeze_collected() -> None:
    """The spec passes `Analysis.binaries`, because that is the shipped set.

    Most of what the installers carry links in from the build machine rather
    than riding inside a wheel — 33 of 73 on the last Linux freeze — so a
    site-packages scan cannot be the whole answer, and `libreadline` is plain
    GPL-3.0 with no linking exception.
    """
    collected = [
        "/usr/lib/x86_64-linux-gnu/libreadline.so.8",
        "av.libs/libx264-d6533a8d.so.165",
        "_cffi_backend.cpython-314-x86_64-linux-gnu.so",
    ]
    assert bundled_libraries(collected) == ["libreadline", "libx264"]
    document = build_notices(bundled_libraries(collected))
    assert "  libreadline — GPL-3.0-or-later" in document


def test_the_copyleft_libraries_are_named_with_what_they_oblige(document: str) -> None:
    """The strongest terms in the box are the ones silence hurts most."""
    section = document.split("BUNDLED NATIVE LIBRARIES", 1)[-1]
    present = [lib for lib in bundled_libraries() if lib in COPYLEFT_LIBRARIES]
    assert present, "no copyleft library found — either the scan broke or the table is stale"
    for library in present:
        line = next(
            (ln for ln in section.splitlines() if ln.strip().startswith(library)),
            None,
        )
        assert line is not None, f"{library} ships but is not in the notices"
        assert "—" in line, f"{library} is listed without naming its terms"


def test_the_copyleft_table_still_holds_the_terms_the_freeze_turns_on() -> None:
    """Deleting a table entry is invisible to the test above.

    It iterates `bundled_libraries() & COPYLEFT_LIBRARIES`, so a library
    dropped from the table simply leaves the loop and the document goes on
    listing it bare. These are the entries the repo's licensing position rests
    on — GPL encoders linked into FFmpeg, and the GPL-3.0 speech synthesiser —
    so losing one silently changes what the installers may be redistributed
    under.
    """
    for library in ("libx264", "libx265", "libavcodec", "libespeak-ng", "libreadline"):
        note = copyleft_note(library)
        assert note, f"{library} carries copyleft terms the table no longer names"
        assert "GPL" in note, f"{library}'s note no longer names a GPL obligation"


def test_the_copyleft_table_is_read_in_every_platform_s_spelling() -> None:
    """Windows ships `avcodec-62.dll` where Linux ships `libavcodec.so.62`.

    The document is generated per platform precisely so the Windows installer
    describes itself — a table only keyed the POSIX way would leave that one
    installer with FFmpeg, x264 and espeak-ng listed and none of their terms.
    """
    for filename in (
        "avcodec-62.dll",
        "x264-165.dll",
        "espeak-ng.dll",
        "AVCODEC-62.DLL",
        # `soundfile` names its Windows binary by architecture, and `x64` is
        # not the spelling any other platform uses.
        "libsndfile_x64.dll",
        # Both of these are real names inside av's win_amd64 wheel, and
        # neither shares a stem with what the same library is called on Linux.
        "libiconv-2-6ce5f4ff92ada49d6f23a8e413455502.dll",
        "libgcc_s_seh-1-4c0a762e4178b574f72d1ef1f8bb5fc9.dll",
    ):
        library = _normalise_library(filename)
        assert copyleft_note(library), f"{filename} normalises to {library}, which names no terms"
    # macOS puts the version before the extension instead of after it.
    assert copyleft_note(_normalise_library("libavcodec.62.dylib"))


def test_the_fallback_scan_reaches_where_the_closure_is_installed() -> None:
    """Asserting the roots are deduplicated certified nothing.

    `site_package_roots()` dedups by construction, and `purelib` and `platlib`
    are the same directory in every scheme CPython ships — so the old
    assertions held for any input, including a function gutted to a single
    hardcoded path. The falsifiable claim is the one the scan depends on:
    every distribution it is meant to find is under a root it returns.
    """
    roots = site_package_roots()
    assert roots, "no site-packages root resolved"
    unreachable = sorted(
        dist.metadata["Name"]
        for dist in runtime_distributions()
        if not any(Path(dist.locate_file("")).resolve() == root.resolve() for root in roots)
    )
    assert not unreachable, f"{unreachable} are installed where the fallback scan never looks"


def test_an_environment_without_the_project_fails_the_build(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The silent failure this file exists to prevent is its own empty output.

    A header with no body still writes a file, still lands in the freeze, and
    still reads as compliance from outside — so an environment the closure
    cannot be walked in has to stop the build, not ship one.
    """
    import third_party_notices

    monkeypatch.setattr(third_party_notices, "_PROJECT", "no-such-distribution")
    with pytest.raises(LookupError):
        runtime_distributions()


def test_it_writes_a_file_with_a_body(tmp_path: Path) -> None:
    written = write_notices(tmp_path / "THIRD-PARTY-NOTICES.txt")
    text = written.read_text(encoding="utf-8")
    # A header-only document is the failure mode that still looks like success
    # from the outside: the file exists, in the right place, saying nothing.
    assert len(text.splitlines()) > 500
    assert text.endswith("\n")
