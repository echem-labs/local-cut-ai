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
import re
import sys
from pathlib import Path

import pytest
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "packaging"))

from third_party_notices import (  # noqa: E402  (needs the path above)
    FREEZE_EXCLUDES,
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
    site_package_roots,
    write_notices,
)

_DEV_ONLY = ("pytest", "ruff", "pyinstaller", "pre-commit")

#: What the freeze collects on Windows, in the spelling it collects it under.
#: The document is generated per platform precisely so each installer
#: describes itself, and this box only ever builds the POSIX one — so the
#: other two spellings need a written-down set or nothing here covers them.
_WINDOWS_COLLECTED = (
    "av.libs/avcodec-62.dll",
    "av.libs/x264-165.dll",
    "av.libs/libiconv-2-6ce5f4ff92ada49d6f23a8e413455502.dll",
    "espeakng_loader/espeak-ng.dll",
    "_soundfile_data/libsndfile_x64.dll",
    "python314.dll",
)


@pytest.fixture(scope="module")
def document() -> str:
    return build_notices()


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


def test_every_library_is_listed_in_the_spelling_its_platform_collects_it_under() -> None:
    """The same guard, run against the set a Windows freeze hands over.

    Every other assertion in this file runs the site-packages fallback on
    whichever box the suite is on, which here is always the POSIX one. A
    completeness check that only ever sees `lib`-prefixed names cannot fail
    the way the Windows document would.
    """
    libraries = bundled_libraries(_WINDOWS_COLLECTED)
    assert "avcodec" in libraries and "x264" in libraries, libraries
    listed = _library_rows(build_notices(libraries))
    assert not [library for library in libraries if library not in listed]


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


def test_the_copyleft_terms_survive_the_windows_spelling() -> None:
    """The document is generated per platform so each installer describes itself.

    `avcodec-62.dll` and `libavcodec.so.62` are one library; if only one of
    the two spellings reaches the table, the Windows installer lists FFmpeg,
    x264 and espeak-ng with none of their terms beside them.
    """
    libraries = bundled_libraries(_WINDOWS_COLLECTED)
    rows = _library_rows(build_notices(libraries))
    for library in ("avcodec", "x264", "espeak-ng", "libsndfile", "libiconv"):
        assert rows.get(library), f"{library} ships on Windows with no terms named"


def test_the_copyleft_table_still_holds_the_terms_the_freeze_turns_on() -> None:
    """Deleting a table entry is invisible to the test above.

    That one loops over the libraries the table still names, so a library
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
    and `runtime_distributions()` drops whatever provides one — so the document
    describes the installer rather than the build environment, which still has
    every one of them installed.
    """

    def test_the_notices_do_not_claim_an_excluded_distribution(self):
        # `av` is the case this exists for: faster-whisper requires it, so it
        # is in the closure and in this venv, and it is not in the freeze. A
        # notices file listing it would name a licence for something a
        # recipient never received.
        listed = {canonicalize_name(d.metadata["Name"]) for d in runtime_distributions()}
        for module in FREEZE_EXCLUDES:
            for provider in metadata.packages_distributions().get(module, ()):
                assert canonicalize_name(provider) not in listed, (
                    f"{provider} is excluded from the freeze but the notices still list it"
                )

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
        spec = (Path(__file__).resolve().parents[1] / "localcut.spec").read_text()
        assert "excludes=list(FREEZE_EXCLUDES)" in spec, (
            "localcut.spec no longer derives its excludes from FREEZE_EXCLUDES"
        )
        assert "rthook_av.py" in spec, "the PyAV stub hook is not registered in the spec"

    def test_the_stub_hook_refuses_rather_than_returning_something(self):
        # The stub stands in for a package we removed. If it answered
        # attribute lookups with a mock, a future faster-whisper that reaches
        # for PyAV somewhere new would fail somewhere far away from the cause.
        hook = (Path(__file__).resolve().parents[1] / "packaging" / "rthook_av.py").read_text()
        namespace: dict = {}
        exec(compile(hook, "rthook_av.py", "exec"), namespace)  # noqa: S102
        # The module the hook built, not `sys.modules["av"]`: this test process
        # has the real PyAV imported already (faster-whisper pulls it in), and
        # the hook's `setdefault` deliberately leaves that one alone.
        stub = namespace["_av"]
        with pytest.raises(RuntimeError, match="deliberately not bundled"):
            stub.open
