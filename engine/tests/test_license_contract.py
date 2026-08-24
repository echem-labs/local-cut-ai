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
import shutil
import subprocess
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

#: What a reference to the private planning repository looks like, as ERE for
#: `git grep -E -i`. Wider than prose, because two of the three forms already
#: in the tree were not prose: a path built from separate quoted segments, and
#: a citation naming one of its filenames outright. The trailing digit is what
#: separates a citation ("specs 07", "specs doc 04") from the ordinary noun -
#: "job specs", "another box's specs" - which is why the permitted opaque form
#: is "plan doc 07" rather than a bare number.
_PRIVATE_REPO_PATTERNS = (
    r"specs[[:space:]]+repo",
    r"hm/specs",
    r"specs/hm",
    r"""[\"'`]specs[\"'`][,[:space:]]+[\"'`]hm[\"'`]""",
    r"specs[[:space:]]+(doc[[:space:]]+)?[0-9]",
)

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


def test_the_trademark_policy_exists_and_the_readme_points_at_it() -> None:
    """The one thing an Apache-2.0 grant deliberately withholds.

    Section 6 grants no rights in the licensor's trade names or marks, so a
    permissive licence plus no trademark page leaves a reader to infer the
    boundary — and the inference they are most likely to draw from "Apache-2.0"
    is that there isn't one. The name is what connects a reputation to a build;
    it is the only thing reserved, so it has to be the thing written down.
    """
    policy = _ROOT / "TRADEMARK.md"
    assert policy.exists(), "TRADEMARK.md is missing"
    text = policy.read_text(encoding="utf-8")
    for mark in ("LocalCut", "branding/logo.svg"):
        assert mark in text, f"the policy does not name {mark} as a mark it covers"
    # It has to say what is allowed, not only what is forbidden: a policy that
    # reads as a list of prohibitions chills the forking the licence invites.
    assert "fork" in text.lower(), "the policy never says forking is fine"

    readme = (_ROOT / "README.md").read_text(encoding="utf-8")
    assert "TRADEMARK.md" in readme, (
        "README does not link the trademark policy - the licence section is "
        "where a reader forms their belief about what they may reuse"
    )


def test_the_agent_orientation_file_defers_rather_than_duplicates() -> None:
    """AGENTS.md is read by tools that never open CLAUDE.md.

    Both describing the same conventions is the second-copy-that-drifts shape
    CLAUDE.md itself forbids, and the drift is silent because no build step
    compares prose. So AGENTS.md must point at CLAUDE.md rather than restate
    it, and this is what says so.
    """
    agents = _ROOT / "AGENTS.md"
    assert agents.exists(), "AGENTS.md is missing"
    text = agents.read_text(encoding="utf-8")
    assert "CLAUDE.md" in text, "AGENTS.md does not defer to CLAUDE.md"


def test_no_tracked_file_sends_a_reader_to_the_private_specs_repository() -> None:
    """A public repository cannot cite a private one as an explanation.

    Two rig scripts pointed at fixture paths in a repository nobody outside
    can open - a sentence that reads as a missing directory, with no way to
    tell whether the tooling is broken or the reference is. Opaque provenance
    is fine ("plan doc 11") and stays: it names a source without promising the
    reader can open it. Naming the repository, or one of its filenames,
    promises exactly that.

    The patterns are wider than the sentences that prompted them, because the
    forms this comes back in are not all prose. A path spelled as separate
    arguments (`path.join(root, "specs", "hm", ...)`) contains none of the
    slash-joined spellings, and a citation like "specs 07-roadmap-and-risks.md"
    names a file more precisely than any of them - both were live in the tree
    while a substring check for "specs repo" reported it clean.

    `git grep` rather than reading every tracked file: `-I` is the binary skip,
    the `:(exclude)` pathspec is the self-exclusion this file needs to be able
    to name the phrases it forbids, and one process replaces a decode loop with
    four failure modes of its own.
    """
    if not shutil.which("git") or not (_ROOT / ".git").exists():
        pytest.skip("not a git checkout - `git ls-files` cannot enumerate what to read")

    found = subprocess.run(
        [
            "git",
            "grep",
            "-I",  # skip binaries rather than reading and discarding them
            "-i",
            "-n",
            "-E",
            *(arg for phrase in _PRIVATE_REPO_PATTERNS for arg in ("-e", phrase)),
            "--",
            # This file names the phrases in order to forbid them.
            ":(exclude)engine/tests/test_license_contract.py",
        ],
        cwd=_ROOT,
        capture_output=True,
        text=True,
        # git grep exits 1 for "no match", which is the passing case.
        check=False,
    )
    assert found.returncode in (0, 1), f"git grep failed: {found.stderr.strip()}"
    assert not found.stdout, (
        "these point a public reader at a repository they cannot open:\n  "
        + "\n  ".join(found.stdout.strip().splitlines())
    )
