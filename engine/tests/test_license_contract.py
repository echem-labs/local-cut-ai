"""Pins the licence to one value across the four places that state it.

The repository declares its licence in the LICENSE text, in the engine's
`pyproject.toml`, in the desktop's `package.json` and in the README — four
files, no build step reconciling them. That is the shape CLAUDE.md gives a
contract test, and the cost of drift is not cosmetic here: electron-builder
reads `package.json` to stamp the `.deb` control file, so a manifest that
disagrees with LICENSE ships a package making a false statement about its
own terms (before this landed, the field was absent and the deb said
`License: unknown`).

The LICENSE text itself is checked by shape rather than by hash: an Apache
release could be re-served with different line endings, and a test that
fails on that says nothing about the contract it is guarding.
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

#: The one value every manifest must state, as an SPDX identifier.
LICENSE_ID = "Apache-2.0"


def test_the_repository_ships_the_apache_license_text() -> None:
    assert _LICENSE.exists(), "no LICENSE at the repository root"
    # Collapsed, because the text is hard-wrapped and every phrase worth
    # asserting on spans a line break.
    text = " ".join(_LICENSE.read_text(encoding="utf-8").split())
    assert "Apache License" in text and "Version 2.0, January 2004" in text
    # The clause this licence was chosen over MIT for, so a truncated or
    # substituted text cannot pass.
    assert "patent license to make, have made, use" in text


def test_the_engine_manifest_declares_the_license() -> None:
    project = tomllib.loads(_PYPROJECT.read_text(encoding="utf-8"))["project"]
    assert project.get("license") == LICENSE_ID, (
        f"engine/pyproject.toml declares {project.get('license')!r}, expected {LICENSE_ID!r}"
    )


@pytest.mark.skipif(not _PACKAGE_JSON.exists(), reason="desktop app not present beside the engine")
def test_the_desktop_manifest_declares_the_same_license() -> None:
    manifest = json.loads(_PACKAGE_JSON.read_text(encoding="utf-8"))
    assert manifest.get("license") == LICENSE_ID, (
        f"apps/desktop/package.json declares {manifest.get('license')!r}, expected {LICENSE_ID!r}"
        " — electron-builder stamps this into the .deb control file"
    )


def test_the_readme_names_the_license_and_no_longer_says_tbd() -> None:
    body = _README.read_text(encoding="utf-8")
    section = body.split("## License", 1)
    assert len(section) == 2, "README has no License section"
    tail = section[1]
    assert LICENSE_ID in tail
    assert "TBD" not in tail, "README still parks the licence decision"


def test_the_notice_carries_a_copyright_line() -> None:
    assert _NOTICE.exists(), "no NOTICE at the repository root"
    text = _NOTICE.read_text(encoding="utf-8")
    # A year and a holder, in the form Apache's appendix asks for. The holder
    # is not pinned by name: renaming it is a decision, not a regression.
    assert re.search(r"Copyright \d{4} \S", text), "NOTICE has no 'Copyright <year> <holder>' line"
