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

`ci-engine.yml` and `.pre-commit-config.yaml` both name this module's
out-of-engine inputs in their filters. They have to: the root documents match
no other workflow or hook in the repository at all, and
`apps/desktop/package.json` matches only the desktop suite, which cannot run
pytest. `_ROOT_INPUTS` below is the list both are describing, and the test at
the foot of this file reconciles all three — so the two filters are kept in
step by that test rather than by this paragraph.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import tomllib
from pathlib import Path

import pytest

from conftest import (
    REPO_ROOT as _ROOT,
    ci_engine_paths_by_trigger,
    hook_files_pattern,
    matches_a_path_filter,
)

_LICENSE = _ROOT / "LICENSE"
_NOTICE = _ROOT / "NOTICE"
_README = _ROOT / "README.md"
_PYPROJECT = _ROOT / "engine" / "pyproject.toml"
_PACKAGE_JSON = _ROOT / "apps" / "desktop" / "package.json"
_CONTRIBUTING = _ROOT / "CONTRIBUTING.md"
_TRADEMARK = _ROOT / "TRADEMARK.md"
_AGENTS = _ROOT / "AGENTS.md"
_CLAUDE = _ROOT / "CLAUDE.md"
_SECURITY = _ROOT / "SECURITY.md"

#: Everything this module reads from outside `engine/`, as repository-relative
#: paths. Both ci-engine.yml's path filter and the `license-contract` pre-push
#: hook are describing this list, and neither can be derived from the other, so
#: the test at the foot of this file reconciles all three - a prose instruction
#: to keep them in step is not a build step.
#:
#: CLAUDE.md is one of them: the index test below asserts that every rule it
#: states is named in AGENTS.md, so renaming or adding a rule there is what
#: turns this module red, and a filter that omits it lets exactly that commit
#: through with nothing run.
_ROOT_INPUTS = (
    "LICENSE",
    "NOTICE",
    "README.md",
    "CONTRIBUTING.md",
    "TRADEMARK.md",
    "AGENTS.md",
    "CLAUDE.md",
    "SECURITY.md",
    "apps/desktop/package.json",
)

#: An address written in prose. The domain is a repeated group rather than a
#: trailing character class, so a sentence-final full stop is not read as part
#: of it.
_EMAIL = r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+"

#: What a reference to the private planning repository looks like, as ERE for
#: `git grep -E -i`. Wider than prose, because a reference is not always prose:
#: it can be a path built from separate quoted segments, or a citation naming
#: one of the repository's filenames outright.
#:
#: Three things the shapes are chosen around:
#:
#: A two-digit number is what separates a citation ("specs 07", "specs doc 04")
#: from the ordinary noun - "job specs", "hardware specs 2 GB" - which is why
#: the permitted opaque form is "plan doc 07" rather than a bare number.
#:
#: The directory forms are anchored to a path-segment boundary, so a tracked
#: `docs/algorithm/specs/` does not read as `hm/specs`.
#:
#: `git grep` matches a line at a time, and comment prose here wraps at 76
#: columns, so a citation split across two lines carries "specs" on one and its
#: number on the next and none of the above sees it. The filename shape is what
#: covers that: the planning documents are `NN-words.md`, no tracked file is
#: named or cites anything of that shape, and half a wrapped citation still is.
_PRIVATE_REPO_PATTERNS = (
    r"specs[[:space:]]+repo",
    r"(^|[^[:alnum:]_.-])hm/specs",
    r"(^|[^[:alnum:]_.-])specs/hm",
    r"""[\"'`]specs[\"'`][,[:space:]]+[\"'`]hm[\"'`]""",
    r"specs[[:space:]]+(doc[[:space:]]+)?[0-9][0-9]([^0-9]|$)",
    r"[0-9][0-9]-[a-z][a-z0-9-]*\.md",
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
    assert _TRADEMARK.exists(), "TRADEMARK.md is missing"
    text = _TRADEMARK.read_text(encoding="utf-8")
    for mark in ("LocalCut", "branding/logo.svg"):
        assert mark in text, f"the policy does not name {mark} as a mark it covers"
    # It has to say what is allowed, not only what is forbidden: a policy that
    # reads as a list of prohibitions chills the forking the licence invites.
    assert "fork" in text.lower(), "the policy never says forking is fine"

    # Bounded to the licence section for the reason `_license_section` exists:
    # that section is where a reader forms their belief about what they may
    # reuse, and a link further down the file does not reach them there.
    assert "TRADEMARK.md" in _license_section(_README), (
        "README's licence section does not link the trademark policy - that "
        "section is where a reader forms their belief about what they may reuse"
    )


@pytest.mark.skipif(not _PACKAGE_JSON.exists(), reason="desktop app not present beside the engine")
def test_every_published_contact_is_the_one_the_policy_gives() -> None:
    """The maintainer address, pinned to the one place it is decided.

    electron-builder.yml sets no `linux.maintainer`, so `package.json`'s
    `author` is what it stamps into the .deb control file and the AppImage
    metadata - a published address, read by `dpkg -I` long after the commit
    that set it. TRADEMARK.md offers an address for permission questions and
    SECURITY.md for vulnerability reports, and a reader who finds three has no
    way to tell which one is answered.

    Pinned against the policy's address rather than a literal here: this is a
    decision to make once, and a third copy living in a test is a third thing
    to remember on the day it changes.
    """
    asking = re.search(
        r"^## Asking\b[^\n]*\n(.*?)(?=^## |\Z)", _TRADEMARK.read_text(encoding="utf-8"), re.S | re.M
    )
    assert asking, "TRADEMARK.md has no Asking section, so there is nothing to reconcile against"
    published = re.findall(_EMAIL, asking.group(1))
    assert len(published) == 1, (
        f"TRADEMARK.md's Asking section offers {len(published)} addresses, expected exactly one"
    )

    author = json.loads(_PACKAGE_JSON.read_text(encoding="utf-8")).get("author", "")
    assert re.findall(_EMAIL, author) == published, (
        f"apps/desktop/package.json ships {author!r}, whose address disagrees with the "
        f"{published[0]!r} TRADEMARK.md publishes - electron-builder stamps this one into "
        "the .deb Maintainer field, where it outlives the commit that set it"
    )

    # The third consumer, and the one where a wrong address is worst: a
    # vulnerability report sent to an unread mailbox is a report nobody
    # answers, and the reporter's next move is the public issue this file
    # asks them not to open.
    assert set(re.findall(_EMAIL, _SECURITY.read_text(encoding="utf-8"))) == set(published), (
        f"SECURITY.md's reporting address disagrees with the {published[0]!r} "
        "TRADEMARK.md publishes"
    )


def test_a_private_channel_exists_for_reporting_a_vulnerability() -> None:
    """The one report a public repository must not receive in public.

    Without SECURITY.md the repository has no Security tab and no "Report a
    vulnerability" button, so a finder's only obvious move is an issue - which
    IS the disclosure, to everyone, before there is a fix. The file is what
    turns that button on, so its absence is not cosmetic.

    Asserted by shape rather than by wording: that it tells a reader not to
    file publicly, and that it gives them somewhere private to go instead. The
    address itself is pinned against TRADEMARK.md above, not here.
    """
    assert _SECURITY.exists(), (
        "no SECURITY.md - GitHub shows no 'Report a vulnerability' button without it, "
        "so the only channel a finder has is the public issue this file exists to prevent"
    )
    text = _SECURITY.read_text(encoding="utf-8")
    lowered = text.lower()

    assert "public issue" in lowered, (
        "SECURITY.md never tells a reader not to report in public, which is the "
        "one instruction it exists to carry"
    )
    # Somewhere private to go instead. Either channel satisfies it; naming
    # neither leaves a reader told what not to do and not what to do.
    assert re.search(_EMAIL, text) or "security/advisories" in lowered, (
        "SECURITY.md names no private channel - an address or the advisories form"
    )


def _rule_titles(markdown: str) -> list[str]:
    """The bolded rule names in a conventions document, whitespace-normalised.

    Normalised because CLAUDE.md wraps at 76 columns and AGENTS.md's index
    does not, so the same title is a different string in the two files and a
    line-for-line comparison would fail on the wrap alone.

    A title may wrap but never spans a blank line, and the bullet has to sit
    on the same line as the `**`. Both bounds are load-bearing: with `\\s*` and
    DOTALL, a line-initial `**` that is not a bold delimiter — a `**/*.py`
    glob in a fenced example — pairs with the NEXT title's opening `**` and
    swallows the rule between them, and the failure then names an innocent
    rule as missing.
    """
    found = re.findall(r"^-?[ \t]*\*\*((?:(?!\n[ \t]*\n).)+?)\*\*", markdown, re.M | re.S)
    # Trailing comma stripped: CLAUDE.md bolds a few titles mid-sentence, and
    # an index line should not end on the punctuation that joined it to prose.
    return [" ".join(m.split()).rstrip(",") for m in found]


def _shingles(text: str, width: int) -> set[tuple[str, ...]]:
    """Every run of `width` consecutive words, as a set."""
    words = text.split()
    return {tuple(words[i : i + width]) for i in range(len(words) - width + 1)}


def test_the_agent_orientation_file_indexes_claude_md_without_restating_it() -> None:
    """AGENTS.md is read by tools that never open CLAUDE.md.

    Both describing the same conventions is the second-copy-that-drifts shape
    CLAUDE.md itself forbids, and the drift is silent because no build step
    compares prose. Asserting only that the string "CLAUDE.md" appears in
    AGENTS.md does not check that: it is true of a file that pastes CLAUDE.md
    in full, so it cannot fail for the thing it would be named after.

    What is checkable is the shape the deferral takes. AGENTS.md carries an
    index of rule TITLES, delimited so this test can find it; every title has
    to still exist in CLAUDE.md, so deleting or renaming a rule there is what
    goes red. Outside that index, no fourteen consecutive words of CLAUDE.md
    may appear - long enough that shared vocabulary and a shared sentence
    about the same subject do not trip it, short enough that a restated rule
    does.
    """
    assert _AGENTS.exists(), "AGENTS.md is missing"
    assert _CLAUDE.exists(), "CLAUDE.md is missing - AGENTS.md defers to a file that is not there"
    agents = _AGENTS.read_text(encoding="utf-8")
    claude = _CLAUDE.read_text(encoding="utf-8")

    assert "CLAUDE.md" in agents, "AGENTS.md does not defer to CLAUDE.md"

    block = re.search(
        r"<!-- begin CLAUDE\.md rule index -->(.*?)<!-- end CLAUDE\.md rule index -->",
        agents,
        re.S,
    )
    assert block, "AGENTS.md has no delimited CLAUDE.md rule index"

    # `re.sub`, not `lstrip("- ")`: lstrip strips a character SET, so a title
    # that opens on a dash - `--no-banner is always passed` - loses the dashes
    # too, and both directions below then fail naming a string in neither file.
    indexed = {
        " ".join(re.sub(r"^-[ \t]*", "", line.strip()).split())
        for line in block.group(1).strip().splitlines()
        if line.strip()
    }
    assert indexed, "the rule index is empty"

    known = set(_rule_titles(claude))
    stale = sorted(indexed - known)
    assert not stale, "AGENTS.md indexes rules CLAUDE.md no longer states:\n  " + "\n  ".join(stale)

    # The other direction: an index that silently stops covering half the
    # conventions sends an agent away believing it has seen them.
    missing = sorted(known - indexed)
    assert not missing, "CLAUDE.md states rules AGENTS.md's index does not name:\n  " + "\n  ".join(
        missing
    )

    outside = agents.replace(block.group(0), " ")
    borrowed = _shingles(claude, 14) & _shingles(outside, 14)
    assert not borrowed, (
        "AGENTS.md restates CLAUDE.md rather than pointing at it:\n  "
        + "\n  ".join(" ".join(run) for run in sorted(borrowed)[:5])
    )


def test_no_tracked_file_sends_a_reader_to_the_private_specs_repository() -> None:
    """A public repository cannot cite a private one as an explanation.

    Two rig scripts pointed at fixture paths in a repository nobody outside
    can open - a sentence that reads as a missing directory, with no way to
    tell whether the tooling is broken or the reference is. Opaque provenance
    is fine ("plan doc 11") and stays: it names a source without promising the
    reader can open it. Naming the repository, or one of its filenames,
    promises exactly that.

    The patterns are wider than prose, because the forms this comes back in
    are not all prose. A path spelled as separate arguments
    (`path.join(root, "specs", "hm", ...)`) contains none of the slash-joined
    spellings, and a citation like "specs 07-roadmap-and-risks.md" names a
    file more precisely than any of them; a substring check for "specs repo"
    sees neither.

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
        # Named, not `text=True`: that decodes with the locale encoding, which
        # on Windows is the ANSI code page, and the tree holds UTF-8 bytes it
        # cannot decode - so the one run that has a violation to report would
        # raise out of subprocess instead of printing it.
        encoding="utf-8",
        errors="replace",
        # git grep exits 1 for "no match", which is the passing case.
        check=False,
    )
    assert found.returncode in (0, 1), f"git grep failed: {found.stderr.strip()}"
    assert not found.stdout, (
        "these point a public reader at a repository they cannot open:\n  "
        + "\n  ".join(found.stdout.strip().splitlines())
    )


def test_ci_and_the_hook_run_this_module_for_the_files_it_reads() -> None:
    """A contract test that cannot fire is not a contract.

    Every path in `_ROOT_INPUTS` matches no other workflow or hook in the
    repository: an edit to the README's licence section, a deleted LICENSE, or
    a TRADEMARK.md that stops naming the mark would otherwise run nothing at
    all, and package.json alone runs only the desktop suite, which cannot
    execute pytest.

    Both sides are checked, because they fail at different moments: the hook
    is what catches it before the push, and the workflow is what catches a PR
    opened from a machine with no hooks installed.

    And both of the workflow's triggers, separately. ci-engine.yml writes the
    list once under `push:` and once under `pull_request:` because the parser
    does not expand YAML anchors, so pooling the two hides the drift this
    exists to make loud: an input named only under `push:` still lets a PR
    that edits it merge with no suite run, and one named only under
    `pull_request:` lets the same edit reach main unchecked.
    """
    filters = ci_engine_paths_by_trigger()
    for trigger in ("push", "pull_request"):
        assert filters.get(trigger), (
            f"ci-engine.yml no longer lists quoted paths under {trigger} - update this test with it"
        )

    hook = hook_files_pattern("license-contract")

    for path in _ROOT_INPUTS:
        for trigger, globs in filters.items():
            assert matches_a_path_filter(path, globs), (
                f"ci-engine.yml's {trigger} path filter does not name {path}, which this "
                "module reads - a change to it would run no suite that can check these assertions"
            )
        assert hook.match(path), (
            f"the license-contract pre-push hook does not name {path}, so a commit "
            "touching it alone is pushed with nothing run"
        )
