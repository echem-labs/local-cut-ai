"""Pins the licence to one value across the six places that state it.

The repository declares its licence in the LICENSE text, in the engine's
`pyproject.toml`, in the desktop's `package.json`, in the README, in NOTICE
and in CONTRIBUTING.md — six files, no build step reconciling them. That is
the shape CLAUDE.md gives a contract test, and the cost of drift is not
cosmetic here:
electron-builder reads `package.json` to stamp the `.deb` control file, so a
manifest that disagrees with LICENSE ships a package making a false statement
about its own terms.

CONTRIBUTING.md is the one a contributor actually reads before granting
anything: it is what GitHub surfaces on the New PR page, and the DCO sign-off
it asks for is an assertion about the right to submit under *this* licence.
It was the sixth statement and the only unpinned one, in a file that matched
no path filter and no hook — so a PR editing it alone ran nothing at all, and
a relicence could reconcile the other five and leave it telling every inbound
contributor the old terms.

NOTICE is pinned for the licence it names, not only for its copyright line.
Apache-2.0 §4(d) makes NOTICE the one text every downstream redistributor is
obliged to reproduce verbatim, so it is the worst of the six to leave loose.

The LICENSE text itself is checked by shape rather than by hash: an Apache
release could be re-served with different line endings, and a test that fails
on that says nothing about the contract it is guarding. The phrases it checks
are spread the length of the document rather than clustered at the top —
every one of them sits in the header of a truncated copy, so pinning only
those passes a LICENSE cut to a third of its length.

`ci-engine.yml` and `.pre-commit-config.yaml` both name this module's five
out-of-engine inputs in their filters. They have to: LICENSE, NOTICE,
README.md and CONTRIBUTING.md match no other workflow or hook in the
repository at all, and `apps/desktop/package.json` matches only the desktop
suite, which cannot run pytest. Keep the two lists in step with the constants
below — and `test_cli_name.py`'s docstring, which enumerates these same
inputs when it explains why ci-engine's filter is the union of three lists.
"""

from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
_LICENSE = _ROOT / "LICENSE"
_NOTICE = _ROOT / "NOTICE"
_README = _ROOT / "README.md"
_PYPROJECT = _ROOT / "engine" / "pyproject.toml"
_PACKAGE_JSON = _ROOT / "apps" / "desktop" / "package.json"
_CONTRIBUTING = _ROOT / "CONTRIBUTING.md"

#: The one value every manifest must state, as an SPDX identifier.
LICENSE_ID = "Apache-2.0"


def _license_section(path: Path) -> str:
    """The body of a document's licence section, bounded by the next heading.

    Bounded, rather than everything following the heading: unbounded, the
    assertions below answer for the whole rest of the file, so an unrelated
    section could fail them for reasons that have nothing to do with the
    licence - and the cheapest way to green that is to weaken the pattern,
    which is the guard. Bounding also stops the section being satisfied by an
    `Apache-2.0` occurring somewhere further down, which is the whole failure
    the CONTRIBUTING.md pin exists for: a relicence that rewrites the grant
    but leaves the old identifier in a historical note further down the file.

    Either spelling of the heading: the README's is "License" while the prose
    under it is British, so which one a future edit lands on is a coin toss.
    Words after it are allowed - CONTRIBUTING.md's is "Licence and sign-off",
    because the grant and the sign-off it is granted through belong together.
    """
    assert path.exists(), f"no {path.name} at the repository root"
    body = path.read_text(encoding="utf-8")
    # `[^\n]*`, not `.*`: `re.S` is on for the body capture below, and a `.`
    # that matches newlines runs the heading match to the end of the file and
    # hands back an empty section - which every assertion here then passes on.
    match = re.search(r"^## Licen[cs]e\b[^\n]*\n(.*?)(?=^## |\Z)", body, re.S | re.M)
    assert match, f"{path.name} has no licence section"
    return match.group(1)


def test_the_repository_ships_the_apache_license_text() -> None:
    assert _LICENSE.exists(), "no LICENSE at the repository root"
    # Collapsed, because the text is hard-wrapped and several of the phrases
    # worth asserting on span a line break.
    text = " ".join(_LICENSE.read_text(encoding="utf-8").split())
    assert "Apache License" in text, "LICENSE is not headed as the Apache licence"
    assert "Version 2.0, January 2004" in text, "LICENSE is not the 2.0 text"
    # In document order, and deliberately reaching the end: the grant, the
    # retaliation clause this licence was chosen over MIT for, the two
    # disclaimers a redistributor actually relies on, and the terminator.
    for clause in (
        "patent license to make, have made, use",
        "institute patent litigation",
        "Disclaimer of Warranty",
        "WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND",
        "Limitation of Liability",
        "END OF TERMS AND CONDITIONS",
    ):
        assert clause in text, f"LICENSE is missing {clause!r} - truncated or substituted?"


def test_the_engine_manifest_declares_the_license() -> None:
    project = tomllib.loads(_PYPROJECT.read_text(encoding="utf-8"))["project"]
    assert project.get("license") == LICENSE_ID, (
        f"engine/pyproject.toml declares {project.get('license')!r}, expected {LICENSE_ID!r}"
    )


@pytest.mark.skipif(not _PACKAGE_JSON.exists(), reason="desktop app not present beside the engine")
def test_the_desktop_manifest_declares_the_same_license() -> None:
    manifest = json.loads(_PACKAGE_JSON.read_text(encoding="utf-8"))
    assert manifest.get("license") == LICENSE_ID, (
        f"apps/desktop/package.json declares {manifest.get('license')!r}, expected"
        f" {LICENSE_ID!r} - electron-builder stamps this into the .deb control file"
    )


def test_the_readme_names_the_license() -> None:
    section = _license_section(_README)
    assert LICENSE_ID in section, f"README's License section does not name {LICENSE_ID!r}"


def test_the_notice_carries_a_copyright_line_and_names_the_license() -> None:
    assert _NOTICE.exists(), "no NOTICE at the repository root"
    text = _NOTICE.read_text(encoding="utf-8")
    # A year and a holder, in the form Apache's appendix asks for. The holder
    # is not pinned by name: renaming it is a decision, not a regression.
    # `[0-9]` rather than `\d`, which also matches Arabic-Indic and Devanagari
    # digits - no licence tool downstream would read those as a year.
    assert re.search(r"^Copyright [0-9]{4} \S", text, re.M), (
        "NOTICE has no 'Copyright <year> <holder>' line"
    )
    # The fifth place the licence is written down, and the one Apache-2.0
    # §4(d) obliges every redistributor to carry.
    assert "Apache License, Version 2.0" in text, "NOTICE does not name the Apache licence"


def test_the_contributing_guide_names_the_same_license() -> None:
    """The statement a contributor grants against, pinned like the other five.

    Read through the same bounded section reader as the README, and for the
    reason its docstring gives: the sentence that has to state the terms is
    the one a contributor reads before signing off, and an `Apache-2.0`
    anywhere else in the file must not stand in for it.
    """
    section = _license_section(_CONTRIBUTING)
    assert LICENSE_ID in section, (
        f"CONTRIBUTING.md's licence section does not name {LICENSE_ID!r} - it is what "
        "GitHub shows on the New PR page, and the DCO sign-off it asks for is an "
        "assertion about the right to submit under this licence"
    )
