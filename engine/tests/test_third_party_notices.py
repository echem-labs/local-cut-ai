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

import ast
import importlib.metadata as metadata
import importlib.util
import re
import sys
from pathlib import Path

import pytest
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "packaging"))

from third_party_notices import (  # noqa: E402  (needs the path above)
    FREEZE_EXCLUDES,
    _LINKED_INTO,
    _LICENCE_FILENAMES,
    _SOURCE_FILENAMES,
    _is_own_metadata,
    _normalise_library,
    _project_url,
    copyleft_note,
    build_notices,
    bundled_libraries,
    licence_classifiers,
    licence_texts,
    runtime_distributions,
    shipped_distributions,
    site_package_roots,
    statically_linked,
    write_notices,
)

# Imported for one constant rather than re-typed: what a Windows freeze
# collects is recorded there, and the sample below has to stay inside that
# record. `tests/` is not a package, so pytest's prepend import mode is what
# puts the sibling on the path.
from test_license_boundaries import _FROZEN_LIBRARIES  # noqa: E402

_DEV_ONLY = ("pytest", "ruff", "pyinstaller", "pre-commit")

#: What the freeze collects on Windows, in the spelling it collects it under.
#: The document is generated per platform precisely so each installer
#: describes itself, and this box only ever builds the POSIX one — so the
#: other two spellings need a written-down set or nothing here covers them.
#:
#: A sample rather than the whole set: `_FROZEN_LIBRARIES["win32"]` in
#: test_license_boundaries is the complete Windows inventory, and duplicating
#: 56 entries here would be a second record to keep in step. What this needs is
#: one name of each *shape* the normaliser has to survive — a wheel-private
#: directory behind a backslash, an arch suffix, a version tail in two
#: hyphenated parts, and a stem ending in digits that has to survive whole —
#: each carrying a library that is really in that inventory. That the sample
#: stays inside the inventory is asserted rather than trusted, below.
#:
#: The backslash is the shape no other fixture in this file carries and the
#: only reason `bundled_libraries` normalises the separator at all:
#: `localcut.spec` hands it PyInstaller's TOC destinations, which on Windows
#: are the paths `os.path.join` built there.
_WINDOWS_COLLECTED = (
    "_soundfile_data\\libsndfile_x64.dll",
    "api-ms-win-crt-runtime-l1-1-0.dll",
    "ctranslate2.dll",
    "msvcp140.dll",
    "python314.dll",
)


@pytest.fixture(scope="module")
def document() -> str:
    return build_notices()


@pytest.fixture(scope="module")
def windows_libraries() -> list[str]:
    return bundled_libraries(_WINDOWS_COLLECTED)


@pytest.fixture(scope="module")
def windows_document(windows_libraries: list[str]) -> str:
    """The Windows document, built once for the two tests that read it.

    Building one costs a walk of every licence file in the closure — about
    half a second — and the two get the same string to the byte, so computing
    it twice buys nothing but the wait.
    """
    return build_notices(windows_libraries)


def _library_rows(document: str) -> dict[str, str]:
    """The bundled-libraries section, as `{name: terms}`.

    Sliced at the heading rather than matched by a `  lib` prefix: Windows
    ships `avcodec-62.dll` where Linux ships `libavcodec.so.62`, so a guard
    keyed on the prefix reports every library on that platform as missing —
    on the one platform the per-platform generation exists for.
    """
    section = document.split("BUNDLED NATIVE LIBRARIES", 1)[-1]
    rows = {}
    for line in section.splitlines():
        if not line.startswith("  ") or not line.strip():
            continue
        name, _, terms = line.strip().partition(" — ")
        rows[name] = terms
    return rows


def test_it_describes_the_runtime_closure_not_the_build_environment() -> None:
    # Canonicalised, not lowercased: `pre-commit` installs under the metadata
    # name `pre_commit`, so a raw comparison checks a hyphen against an
    # underscore and that quarter of the guard can never fire.
    names = {canonicalize_name(dist.metadata["Name"]) for dist in runtime_distributions()}
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
    walked = {canonicalize_name(dist.metadata["Name"]) for dist in runtime_distributions()}
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
            expected.add(canonicalize_name(behind.name))
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
        classifiers = licence_classifiers(dist)
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
    checked = 0
    for dist in runtime_distributions():
        meta = dist.metadata
        classifiers = licence_classifiers(dist)
        if meta.get("License-Expression") or len(classifiers) < 2:
            continue
        checked += 1
        assert f"    License: {'; '.join(classifiers)}\n" in document, (
            f"{meta['Name']} is dual-licensed and the notices name only one of them"
        )
    # Its siblings above carry the same guard: wheels are migrating to PEP 639
    # `License-Expression`, which this loop skips, so the day the last
    # two-classifier wheel leaves the closure this passes asserting nothing.
    assert checked, "no wheel in the closure spells a dual licence in classifiers — test is stale"


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


def test_a_licence_a_wheel_ships_but_never_declared_is_reproduced_too(document: str) -> None:
    """`soundfile` records its own BSD and says nothing about libsndfile's LGPL.

    Returning at the first declaration made the two mutually exclusive, so a
    wheel that recorded anything stopped being scanned. `_soundfile_data/COPYING`
    is the LGPL-2.1 text for the very binary the freeze collects, and the
    document named LGPL terms for a dozen libraries while reproducing none of
    them.
    """
    undeclared = 0
    for dist in runtime_distributions():
        recorded = {name.rsplit("/", 1)[-1] for name in dist.metadata.get_all("License-File") or []}
        for path in dist.files or []:
            basename = str(path).rsplit("/", 1)[-1]
            if basename in recorded or not _LICENCE_FILENAMES.fullmatch(basename):
                continue
            try:
                body = path.read_text(encoding="utf-8").strip()
            except (OSError, UnicodeDecodeError, ValueError):
                continue
            if not body:
                continue
            undeclared += 1
            assert body.splitlines()[0].strip() in document, (
                f"{dist.metadata['Name']} ships {path} and the notices drop it"
            )
    assert undeclared, "no wheel ships an undeclared licence file any more - test is stale"


def test_the_lgpl_text_for_a_named_native_library_is_reproduced(document: str) -> None:
    """The library list says `libsndfile - LGPL-2.1-or-later`; this is that text.

    Scoped to soundfile's own entry, because a document-wide search is not
    falsifiable here: numpy vendors an LGPL component, so the wording is
    present even when the wheel carrying the binary reproduces nothing. The
    text sits in `_soundfile_data/COPYING`, which soundfile never declares —
    it declares only its own BSD — so stopping the scan at the declaration
    dropped it.
    """
    soundfile = next(
        d for d in runtime_distributions() if canonicalize_name(d.metadata["Name"]) == "soundfile"
    )
    assert "  libsndfile — LGPL-2.1-or-later" in document, "the section stopped naming libsndfile"
    heading = f"\n{soundfile.metadata['Name']} {soundfile.version}\n"
    entry = document.split(heading, 1)[1]
    entry = re.split(r"\n(?=\S)", entry, maxsplit=1)[0]
    assert "LESSER GENERAL PUBLIC" in entry.upper(), (
        "libsndfile is named with LGPL terms and the wheel that carries it reproduces no LGPL text"
    )


def test_a_declared_licence_file_that_is_source_code_is_not_reproduced(document: str) -> None:
    """`av` declares `AUTHORS.py` — the script that writes AUTHORS.rst.

    A declaration is authoritative about which files, not about what a notice
    is; pasting a hundred lines of Python into a compliance document is noise
    that makes the real texts harder to find.
    """
    assert "Generate the AUTHORS" not in document


def test_a_vendored_dist_info_does_not_stand_in_for_the_distribution_s_own(
    document: str,
) -> None:
    """A vendored package carries its own dist-info inside the package tree.

    `".dist-info" in path` is a substring test, so
    `setuptools/_vendor/autocommand-2.2.2.dist-info/LICENSE` would sort ahead
    of setuptools' own text and be printed as it.
    """
    assert not _is_own_metadata("setuptools/_vendor/autocommand-2.2.2.dist-info/LICENSE")
    assert _is_own_metadata("setuptools-80.10.0.dist-info/LICENSE")


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


def test_every_licence_file_a_wheel_declares_is_reproduced(document: str) -> None:
    """A `License-File` entry is the wheel's own statement, not our guess.

    Filtering the declaration through a name pattern dropped numpy's
    `dragon4_LICENSE.txt` — a separate third-party notice numpy vendors — and
    the `AUTHORS` that `av`, `PyJWT` and `sse-starlette` each declare, which
    is the copyright-holder list a BSD notice exists to carry.

    Source files are the one exception, and they get their own test: a
    declaration says which files, not what counts as a notice.
    """
    checked = 0
    for dist in runtime_distributions():
        for name in dist.metadata.get_all("License-File") or []:
            basename = name.rsplit("/", 1)[-1]
            if _LICENCE_FILENAMES.fullmatch(basename) or _SOURCE_FILENAMES.search(basename):
                continue  # covered by the tests above; this is about the rest
            try:
                text = dist.read_text(f"licenses/{name}") or dist.read_text(name)
            except (OSError, ValueError):
                continue
            if not (text and text.strip()):
                continue
            checked += 1
            block = "\n".join(
                "    " + line if line.strip() else "" for line in text.strip().splitlines()
            )
            assert block in document, (
                f"{dist.metadata['Name']} declares {name} and the notices drop it"
            )
    assert checked, "no wheel declares a licence file under an unusual name — test is stale"


def test_a_project_url_written_without_a_label_is_still_read() -> None:
    """`Project-URL: https://...` with no label is malformed, and real.

    Partitioning on a comma that is not there puts the whole value in the
    label and yields nothing, so the document tells the reader a project
    names no URL on the strength of the line where it named one.
    """
    import email.message

    metadata_without_a_label = email.message.Message()
    metadata_without_a_label["Name"] = "stub"
    metadata_without_a_label["Project-URL"] = "https://example.invalid/stub"

    class _Stub:
        metadata = metadata_without_a_label

    assert _project_url(_Stub()) == "https://example.invalid/stub"


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
    listed = _library_rows(document)
    missing = [library for library in libraries if library not in listed]
    assert not missing, f"{missing} ship but are not in the notices"


def test_the_windows_sample_names_only_libraries_that_really_ship_there(
    windows_libraries: list[str],
) -> None:
    """`_WINDOWS_COLLECTED` and `_FROZEN_LIBRARIES` are one fact, written twice.

    Nothing reconciles them. This file spells the filenames a Windows freeze
    hands over; the sibling records the normalised inventory that freeze
    contains — and a library can leave the installers with only one of the two
    hearing about it, which is a stand-in asserting that something ships where
    the record says it does not, both of them green.

    A subset, not an equality: the point of the sample is that it is smaller
    than the inventory. What it may not do is name something outside it.
    """
    stray = sorted(set(windows_libraries) - _FROZEN_LIBRARIES["win32"])
    assert not stray, (
        f"{stray} stand in for what a Windows freeze collects and are in no Windows "
        "freeze. Either the recorded inventory moved and this sample has to follow, "
        "or the sample is describing an installer that does not exist"
    )


def test_every_library_is_listed_in_the_spelling_its_platform_collects_it_under(
    windows_libraries: list[str], windows_document: str
) -> None:
    """The same guard, run against the set a Windows freeze hands over.

    Every other assertion in this file runs the site-packages fallback on
    whichever box the suite is on, which here is always the POSIX one. A
    completeness check that only ever sees `lib`-prefixed names cannot fail
    the way the Windows document would.
    """
    # The fixture has to survive the normaliser before it can test anything:
    # a name it mangled would drop out here and leave the check below looking
    # at a shorter list rather than failing. `msvcp140` and `python314` are in
    # it for the half of that the other shapes cannot show — a stem whose own
    # last characters are digits, which the version strip must not take.
    assert set(windows_libraries) == {
        "api-ms-win-crt-runtime-l1",
        "ctranslate2",
        "libsndfile",
        "msvcp140",
        "python314",
    }, windows_libraries
    listed = _library_rows(windows_document)
    missing = [library for library in windows_libraries if library not in listed]
    assert not missing, f"{missing} are collected on Windows and the notices do not name them"


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
    """The strongest terms in the box are the ones silence hurts most.

    Membership is asked of `copyleft_note`, not of the table: the table is
    keyed on the canonical stem, so `lib in COPYLEFT_LIBRARIES` answers False
    for every POSIX name and every Windows one alike, and a guard that
    selects nothing reports nothing.
    """
    rows = _library_rows(document)
    present = [lib for lib in bundled_libraries() if copyleft_note(lib)]
    assert present, "no copyleft library found — either the scan broke or the table is stale"
    for library in present:
        assert library in rows, f"{library} ships but is not in the notices"
        assert rows[library], f"{library} is listed without naming its terms"


def test_the_copyleft_terms_survive_the_windows_spelling(windows_document: str) -> None:
    """The document is generated per platform so each installer describes itself.

    `libsndfile_x64.dll` and `libsndfile.so.1` are one library. Only the second
    is what this box ever sees, so if the first does not reach the table the
    Windows installer lists it bare — which reads as a claim that it carries no
    copyleft terms, in the document that exists to say otherwise. Here the
    architecture suffix is the whole distance between the two spellings.

    libsndfile is the whole assertion because `_FROZEN_COPYLEFT["win32"]` holds
    one name. Its stem is the same on both platforms, so the other half of the
    reconciliation — the `lib` prefix a Windows name does not carry — cannot be
    reached through anything that ships there;
    `test_the_table_is_keyed_for_a_spelling_this_box_never_builds` pins that
    instead, as a fact about the table rather than a claim that they ship.
    """
    rows = _library_rows(windows_document)
    assert rows.get("libsndfile"), "libsndfile ships on Windows with no terms named"


def test_the_table_is_keyed_for_a_spelling_this_box_never_builds() -> None:
    """The lookup has to answer for names no freeze here will ever produce.

    Kept separate from what ships. None of the three is in a Windows
    installer, so asserting them through a collected-file fixture would be
    asserting one contains PyAV's FFmpeg — which is what the exclusion exists
    to make false. Nor are all three in the closure this box installs: avcodec
    and x264 ride in PyAV's Linux wheel, but `libiconv` is only in its
    win_amd64 one, and this is the name that wheel gives it. What is still
    worth pinning is that the table is keyed by `annotation_key` rather than by
    the POSIX filename, so the day one of them returns to a freeze it is
    annotated on every platform rather than on one.
    """
    collected = (
        "av.libs/avcodec-62.dll",
        "av.libs/x264-165.dll",
        "av.libs/libiconv-2-6ce5f4ff92ada49d6f23a8e413455502.dll",
    )
    # Through the real path, because the normaliser is half of what is being
    # tested: `copyleft_note` is keyed on the stem and gets there from a
    # filename only via `bundled_libraries`.
    libraries = bundled_libraries(collected)
    # Pinned before the loop for the reason the sibling above pins its own: a
    # name the normaliser mangled leaves the list rather than failing, and a
    # loop over a shorter list asserts less without saying so — over an empty
    # one it asserts nothing at all and still passes.
    assert libraries == ["avcodec", "libiconv", "x264"], libraries
    for library in libraries:
        note = copyleft_note(library)
        assert note, f"{library} has no entry under its Windows spelling"
        # Containment, because these three do not oblige the same thing:
        # avcodec and x264 are GPL, libiconv is LGPL. What is being pinned is
        # that a copyleft obligation is still named, not which one.
        assert "GPL" in note, f"{library}'s note no longer names a copyleft obligation"


def test_the_copyleft_table_still_holds_the_terms_the_closure_turns_on() -> None:
    """Deleting a table entry is invisible to the test above.

    That one loops over the libraries the table still names, so a library
    dropped from the table simply leaves the loop and the document goes on
    listing it bare.

    The *closure*, not the freeze: `uv sync` installs PyAV and espeakng-loader,
    so four of these five are loaded in the engine's own process when it runs
    from a checkout, and `build_notices()` with no arguments describes exactly
    that. `libreadline` is the fifth and is in neither set: no wheel carries
    it, so the site-packages scan never reaches it, and it enters a document
    only where PyInstaller resolves it from a build machine that has one. It is
    in the loop because `FREEZE_EXCLUDES` drops CPython's `readline` module on
    the strength of the terms recorded here. Which of them reach an installer
    is a narrower question and a different record — `_FROZEN_LIBRARIES` in
    test_license_boundaries. Naming the wrong one here is how a docstring ends
    up asserting the repo ships GPL encoders it does not.
    """
    for library in ("libx264", "libx265", "libavcodec", "libespeak-ng", "libreadline"):
        note = copyleft_note(library)
        assert note, f"{library} carries copyleft terms the table no longer names"
        # The prefix, not containment: every one of these five is plain GPL,
        # and `LGPL` contains `GPL`. A row relabelled `LGPL-2.1-or-later`
        # understates what it obliges while reading as a licence identifier,
        # which is the one kind of wrong entry a substring cannot see.
        assert note.startswith("GPL-"), (
            f"{library} is GPL and its note now reads {note!r} - a note that no longer "
            "opens with its identifier is naming different terms from the ones it owes"
        )


def test_the_copyleft_table_is_read_in_every_platform_s_spelling() -> None:
    """Windows ships `avcodec-62.dll` where Linux ships `libavcodec.so.62`.

    The document is generated per platform precisely so each installer
    describes itself, and a table only keyed the POSIX way answers for none of
    the spellings the other two collect under. About the table's keying, not
    about what any installer holds: `_FROZEN_LIBRARIES` records that, and none
    of FFmpeg, x264 or espeak-ng is in the Windows set. The day one of them
    returns to a freeze it has to be annotated on every platform, and this is
    what makes a new spelling cost no new row.
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
        # MinGW names the GCC runtime after its exception model, and seh is
        # only the 64-bit one.
        "libgcc_s_dw2-1.dll",
        "libgcc_s_sjlj-1.dll",
        # A Windows TOC entry keeps whatever case the filesystem gave it, and
        # the arch and the repair hash have to come off in either one.
        "LIBSNDFILE_X64.DLL",
        "LibIconv-2-6CE5F4FF92ADA49D6F23A8E413455502.dll",
    ):
        library = _normalise_library(filename)
        assert copyleft_note(library), f"{filename} normalises to {library}, which names no terms"
    # macOS puts the version before the extension instead of after it.
    assert copyleft_note(_normalise_library("libavcodec.62.dylib"))


def test_an_architecture_suffix_behind_a_hash_is_still_stripped() -> None:
    """delvewheel puts its hash last, so the architecture stops being last.

    `libsndfile_x64.dll` normalises, but a repaired wheel spells the same
    library `libsndfile_x64-<hash>.dll` — and stripping the architecture once,
    before the hash comes off, leaves `libsndfile_x64`, which the table does
    not know and the LGPL note goes with it.
    """
    for filename in (
        "libsndfile_x64-4c0a762e4178b574f72d1ef1f8bb5fc9.dll",
        "libsndfile_x64-1.dll",
        "libsndfile_x86_64.so",
        "libsndfile_x64.dll",
    ):
        assert _normalise_library(filename) == "libsndfile", filename
        assert copyleft_note(_normalise_library(filename)), filename


def test_a_soname_tail_that_is_not_all_digits_still_comes_off() -> None:
    """A version is not always digits and dots, and the extension has to go.

    The strip used to require the tail to be `[0-9.]`, so a soname carrying
    anything else matched nothing and kept its extension — and the copyleft
    table is keyed without one, so `copyleft_note` returned None and the
    strongest-licensed binary in the box would have shipped in the notices
    with its GPL terms unnamed. All three of these are real shapes: a
    release-candidate FFmpeg build, Debian's t64 transition, and the mingw
    import library beside a DLL.
    """
    for filename, expected in (
        ("libx264.so.165rc", "libx264"),
        ("libaio.so.1t64", "libaio"),
        ("libsndfile.dll.a", "libsndfile"),
    ):
        assert _normalise_library(filename) == expected, filename
    # The two that carry terms still reach them, which is what the strip is for.
    assert copyleft_note(_normalise_library("libx264.so.165rc"))
    assert copyleft_note(_normalise_library("libsndfile.dll.a"))


def test_a_document_with_no_libraries_fails_the_build() -> None:
    """A heading with nothing under it is the empty file in another shape.

    The section still gets its title and its four-line preamble, the file
    still lands in the freeze, and it still reads as compliance from the
    outside — which is the failure the walk already refuses for the other
    half of the document.
    """
    with pytest.raises(LookupError):
        build_notices([])


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


class TestWhatIsKeptOutOfTheFreeze:
    """`FREEZE_EXCLUDES` is the one list of what the installer does not carry.

    Both ends read it — `localcut.spec` passes it to PyInstaller's `excludes`,
    and `shipped_distributions()` drops whatever provides one — so the document
    describes the installer rather than the build environment, which still has
    every one of them installed.
    """

    def test_the_notices_do_not_claim_an_excluded_distribution(self):
        # `av` is the case this exists for: faster-whisper requires it, so it
        # is in the closure and in this venv, and it is not in the freeze. A
        # notices file listing it would name a licence for something a
        # recipient never received.
        shipped = {canonicalize_name(d.metadata["Name"]) for d in shipped_distributions()}
        walked = {canonicalize_name(d.metadata["Name"]) for d in runtime_distributions()}
        assert "av" not in shipped, "PyAV is excluded from the freeze but the notices still list it"
        # Asserted from the other side too, because a walk that stopped
        # reaching `av` at all would satisfy the line above while the filter
        # did nothing: `av` has to be in the closure for its absence from the
        # shipped set to mean the subtraction ran.
        assert "av" in walked, "the closure no longer reaches PyAV, so nothing proves the filter"

    def test_the_closure_the_licence_guards_read_is_not_narrowed_by_the_excludes(self):
        # `test_no_distribution_declares_copyleft_outside_the_recorded_set`
        # walks `runtime_distributions()` to force a decision on every
        # dependency declaring GPL terms. Subtracting the freeze's excludes
        # there would let a name added to FREEZE_EXCLUDES carry a new copyleft
        # dependency past that guard — while `uv sync` and the Docker image
        # still install it.
        walked = {canonicalize_name(d.metadata["Name"]) for d in runtime_distributions()}
        excluded = {
            canonicalize_name(provider)
            for module in FREEZE_EXCLUDES
            for provider in metadata.packages_distributions().get(module, ())
        }
        assert excluded, "no FREEZE_EXCLUDES entry resolves to a distribution — test is stale"
        assert excluded <= walked, f"{sorted(excluded - walked)} left the closure the guards read"

    def test_av_is_installed_here_so_the_filter_is_doing_something(self):
        # Without this the test above passes in an environment that simply
        # never had `av`, which is the shape that makes a filter look correct
        # while doing nothing.
        assert metadata.packages_distributions().get("av"), (
            "av is not installed, so nothing proves the exclusion filter runs"
        )

    def test_the_spec_takes_its_excludes_from_this_list(self):
        # The value would otherwise be written twice on either side of a
        # boundary no build step reconciles: PyInstaller never reads this
        # module's list, and this module never reads the spec.
        #
        # Read off the ast rather than out of the text, for the reason
        # test_license_boundaries states about its own guard: a substring test
        # cannot tell live code from a line someone commented out while
        # debugging a build, and a commented-out `runtime_hooks` ships a freeze
        # that dies on faster-whisper's module-scope `import av`.
        spec = (Path(__file__).resolve().parents[1] / "localcut.spec").read_text()
        analysis = next(
            node
            for node in ast.walk(ast.parse(spec))
            if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "Analysis"
        )
        arguments = {keyword.arg: keyword.value for keyword in analysis.keywords}
        excludes = arguments.get("excludes")
        assert (
            isinstance(excludes, ast.Call)
            and getattr(excludes.func, "id", None) == "list"
            and [getattr(arg, "id", None) for arg in excludes.args] == ["FREEZE_EXCLUDES"]
        ), "localcut.spec no longer derives its excludes from FREEZE_EXCLUDES"
        hooks = ast.unparse(arguments.get("runtime_hooks") or ast.Constant(""))
        assert "rthook_av.py" in hooks, "the PyAV stub hook is not registered in the spec"
        # Anchored to SPECPATH, because PyInstaller resolves a relative
        # `scripts` entry against the spec's directory but pushes a runtime
        # hook through a bare `os.path.abspath` — which resolves against the
        # working directory. Spelled relative, the hook is found only when
        # pyinstaller runs from `engine/`.
        assert "SPECPATH" in hooks, (
            "the runtime hook path is not anchored at SPECPATH, so it resolves "
            "against the working directory instead of the spec's own"
        )

    def test_the_stub_hook_registers_a_module_that_refuses(self, monkeypatch):
        # The stub stands in for a package we removed. If it answered
        # attribute lookups with a mock, a future faster-whisper that reaches
        # for PyAV somewhere new would fail somewhere far away from the cause.
        hook = (Path(__file__).resolve().parents[1] / "packaging" / "rthook_av.py").read_text()
        # Run against a `sys.modules` this test owns, because the hook's whole
        # job is a side effect on that dict. Asserting on the module object the
        # hook happens to build leaves the registration untested - delete the
        # `setdefault` and the freeze ships a hook that builds a stub and
        # throws it away, with the suite green. Executing it against the live
        # dict is not free either: on a checkout with no ASR weights nothing
        # has imported PyAV yet, so the raising stub would outlive this test in
        # a process every later test shares.
        monkeypatch.setitem(sys.modules, "av", None)
        del sys.modules["av"]

        namespace: dict = {}
        exec(compile(hook, "rthook_av.py", "exec"), namespace)  # noqa: S102

        stub = sys.modules["av"]
        assert stub is namespace["_av"], "the hook built a stub and never registered it"
        with pytest.raises(RuntimeError, match="deliberately not bundled"):
            stub.open
        # Dunders answer rather than refuse. `inspect.getmodule` walks every
        # entry in sys.modules asking `hasattr(module, "__file__")` and
        # `pickle` probes modules inside an `except AttributeError`, so a stub
        # that raises out of those puts "PyAV is deliberately not bundled" on
        # an unrelated traceback anywhere in the frozen engine.
        assert getattr(stub, "__file__", None) is None
        assert repr(stub) == "<module 'av'>"


class TestWhatShipsInsideSomethingElse:
    """Libraries with no file of their own still have to be named.

    Everything else in this module answers "what is in the box" by looking at
    filenames, which is the right question for a directory of `.so`s and the
    wrong one for a static link: `soundfile`'s libsndfile is built with LAME
    and mpg123 compiled in and ships as a single binary. Both are LGPL and both
    are redistributed, so a document assembled from filenames alone is silent
    about them.
    """

    def test_a_library_compiled_into_another_one_is_named(self):
        # Named through the carrier, so the claim is conditional on the
        # carrier actually shipping rather than asserted unconditionally.
        assert statically_linked(["libsndfile"]) == ["libmp3lame", "libmpg123"]
        assert statically_linked(["libctranslate2"]) == []

    def test_the_document_carries_them_under_a_heading_that_says_why(self):
        document = build_notices(["libsndfile", "libctranslate2"])
        for library in ("libmp3lame", "libmpg123"):
            assert f"  {library} — " in document, f"{library} ships and the notices do not name it"
        assert "no file of their own" in document, (
            "the carried libraries are listed with the rest, so the document "
            "reads as though a file was found for them"
        )

    def test_one_that_also_ships_as_a_file_is_not_named_twice(self):
        # A machine with a system libsndfile pulls its dependencies in beside
        # it, so `libmp3lame` can arrive as a file as well. Listed from both
        # places it reads as two components rather than one named twice.
        assert statically_linked(["libsndfile", "libmp3lame"]) == ["libmpg123"]
        document = build_notices(["libsndfile", "libmp3lame"])
        assert document.count("  libmp3lame — ") == 1

    def test_the_carrier_really_carries_them(self):
        # The rest of this class asserts the plumbing. This asserts the fact,
        # which is the half that can quietly stop being true: an upstream
        # `soundfile` that dropped mp3 support, or linked LAME dynamically,
        # would leave the document naming something the box no longer has.
        # Read out of the installed binary rather than recorded here, so the
        # next wheel is what answers.
        carrier = next(
            (
                path
                for root in site_package_roots()
                for path in (root / "_soundfile_data").glob("libsndfile*")
                if path.is_file()
            ),
            None,
        )
        if carrier is None:
            pytest.skip("the soundfile wheel's libsndfile is not installed here")
        blob = carrier.read_bytes()
        for library, marker in (("libmp3lame", b"LAME3."), ("libmpg123", b"mpg123")):
            assert marker in blob, (
                f"{carrier.name} no longer contains {library}, which _LINKED_INTO "
                f"says it carries - prune the entry rather than shipping a "
                f"notice for something that is not there"
            )

    def test_each_one_is_named_with_its_terms(self):
        # Same rule the collected libraries are held to: listed bare, a
        # copyleft library reads as a claim that it carries no such terms.
        for guests in _LINKED_INTO.values():
            for guest in guests:
                assert copyleft_note(guest), f"{guest} is listed with nothing beside it"


class TestTheContainerKeepsPyAVOutToo:
    """The image is the second thing that redistributes this closure.

    `localcut.spec` keeps PyAV out of the installers; without the same move
    here, `uv sync` puts its FFmpeg build - x264 and x265 among it - into an
    image whose own ffmpeg is pinned to an LGPL build precisely to keep them
    out.
    """

    @staticmethod
    def _stub():
        path = Path(__file__).resolve().parents[1] / "packaging" / "av_stub.py"
        spec = importlib.util.spec_from_file_location("av_stub_under_test", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_it_refuses_a_real_pyav_attribute(self):
        with pytest.raises(RuntimeError, match="deliberately not bundled"):
            self._stub().open

    def test_it_answers_the_lookups_a_module_is_expected_to_answer(self):
        # Same reasoning as the freeze's hook: `__path__` in particular is read
        # inside an `except AttributeError` to decide whether `import av.audio`
        # is a submodule import, so refusing there raises a RuntimeError out of
        # a statement an `except ImportError` is written to catch.
        stub = self._stub()
        assert getattr(stub, "__path__", None) is None
        assert isinstance(repr(stub), str)

    def test_the_dockerfile_drops_pyav_and_puts_the_stub_in_its_place(self):
        dockerfile = (Path(__file__).resolve().parents[1] / "Dockerfile").read_text()
        assert "uv pip uninstall av" in dockerfile, "the image still installs PyAV"
        assert "packaging/av_stub.py" in dockerfile, (
            "PyAV is uninstalled with nothing standing in for it, so "
            "faster-whisper's module-scope import fails at the first captions job"
        )

    def test_the_entrypoint_does_not_put_it_back(self):
        # `uv run` reconciles the environment against the lock before running
        # anything, and the lock still contains PyAV - it is faster-whisper's
        # dependency and dropping it there would drop it for the tests. Without
        # --no-sync the wheel is reinstalled on every container start, so the
        # image is clean when it is inspected and not when it runs.
        dockerfile = (Path(__file__).resolve().parents[1] / "Dockerfile").read_text()
        entrypoint = next(line for line in dockerfile.splitlines() if line.startswith("ENTRYPOINT"))
        assert '"--no-sync"' in entrypoint, (
            "the entrypoint re-syncs from the lock, which reinstalls PyAV at runtime"
        )
