"""What the docs promise about the engine, against what the engine does.

Prose is the one place a value can be written twice and drift without any
build step noticing, and documentation drifts in the direction that costs a
reader the most: it stays plausible. A sentence naming the wrong backend or
the wrong default reads exactly like one naming the right ones, so a reader
has nothing to catch it with and neither does review.

Scoped to claims that name a value the code also states. A sentence about what
"Finalize" is for cannot be pinned to anything and belongs to review; a
sentence listing the backends `local` expands to is the same tuple written in
two files.

The documents live outside `engine/`, so `ci-engine.yml` and
`.pre-commit-config.yaml` have to name them in their filters or an edit to one
runs nothing that could check it. `_DOCUMENT_INPUTS` below is the list both
are describing, and the test at the foot of this file reconciles all three.
"""

from __future__ import annotations

import json
import re

import pytest

from conftest import (
    REPO_ROOT,
    ci_engine_paths_by_trigger,
    hook_files_pattern,
    matches_a_path_filter,
)

from localcut_engine.config import EngineConfig

_RUNNING = REPO_ROOT / "docs" / "running-real-models.md"
_README = REPO_ROOT / "README.md"
_PACKAGE_JSON = REPO_ROOT / "apps" / "desktop" / "package.json"
_WORKFLOWS = REPO_ROOT / ".github" / "workflows"

#: What a runner label is called in prose. Keyed on the vendor half alone,
#: because the version half is the part that moves - `ubuntu-latest` becomes
#: `ubuntu-24.04` the day a pin is wanted, and that is not a change to what
#: the README should say about it.
_RUNNER_PLATFORM = {"ubuntu": "Linux", "macos": "macOS", "windows": "Windows"}

#: Everything this module reads from outside `engine/`, as repository-relative
#: paths. Both ci-engine.yml's path filter and the `readme-contract` pre-push
#: hook are describing this list, and neither can be derived from the other, so
#: the test at the foot of this file reconciles all three - a prose instruction
#: to keep them in step is not a build step.
#:
#: `config.py` is deliberately absent: it is under `engine/`, which the
#: `engine-tests` hook and ci-engine's `engine/**` already carry, and naming it
#: again would only run this module a second time on every engine push.
_DOCUMENT_INPUTS = (
    "README.md",
    "docs/running-real-models.md",
    "apps/desktop/package.json",
    ".github/workflows/ci-engine.yml",
    ".github/workflows/ci-desktop.yml",
)

#: A markdown inline link's target. `[^)\s]+` rather than `[^)]*`: a target
#: never contains whitespace, and stopping at the first space keeps a link
#: whose text wrapped onto the next line from swallowing the rest of it.
#:
#: The optional tail is the title a link may carry - `](path "Title")`. Without
#: it the pattern does not match such a link AT ALL, which is the worse
#: failure: a broken target with a title on it would go unchecked rather than
#: red, and nothing on screen would say a link had been skipped.
_LINK = re.compile(r"\]\(([^)\s]+)(?:\s+[^)]*)?\)")


def _documented_links() -> list[tuple[str, str]]:
    """Every relative link in the entry points, paired with the file it is in.

    The pair is what makes the check correct rather than approximate: a
    relative target resolves against the directory of the document holding it,
    so `docs/editing.md` written inside `docs/` is broken on GitHub even
    though the same string is right in the README. Resolving against a set of
    candidate bases would pass both.

    Fragments are cut before resolution - `voices.md#cloning` names a file
    plus a heading, and only the file half is a path. A bare `#anchor` names
    a place in the current document and has no file to check.
    """
    found: set[tuple[str, str]] = set()
    for doc in [_README, *sorted((REPO_ROOT / "docs").rglob("*.md"))]:
        for target in _LINK.findall(doc.read_text(encoding="utf-8")):
            if target.startswith(("http://", "https://", "mailto:", "#")):
                continue
            path = target.split("#", 1)[0]
            if path:
                found.add((doc.relative_to(REPO_ROOT).as_posix(), path))
    return sorted(found)


def test_the_documented_local_chain_is_the_chain_the_engine_builds() -> None:
    """`local` is a shorthand, and the docs spell out what it expands to.

    Order is part of the claim, not incidental: `chatterbox` sits ahead of
    `kokoro` because it claims only `local:chatterbox` narration and lets
    everything else fall through, so a table that lists the same six backends
    in another order describes a different routing.

    Read from the table's first column rather than from prose, so the check is
    against the thing a reader actually scans. The cell is captured as
    anything inside backticks rather than as `[a-z]+`: a backend named with a
    digit or a hyphen would otherwise drop out of the documented list
    silently, and the failure would then accuse the table of being short.
    """
    assert _RUNNING.exists(), "docs/running-real-models.md is missing"
    text = _RUNNING.read_text(encoding="utf-8")

    section = re.search(r"^## The backend chain\b.*?(?=^## |\Z)", text, re.S | re.M)
    assert section, "no 'The backend chain' section to read the expansion from"
    documented = re.findall(r"^\| `([^`]+)` \|", section.group(0), re.M)
    assert documented, "the backend chain section no longer holds a table of backends"

    actual = EngineConfig(backend="local").backend_chain
    assert documented == actual, (
        f"docs/running-real-models.md documents the `local` chain as {documented}, "
        f"but EngineConfig builds {actual} - order matters, because the first "
        "backend that serves a node kind wins"
    )


def test_the_documented_comfy_kinds_default_is_the_one_the_config_carries() -> None:
    """The other half of the routing a reader configures by hand.

    `auto` is not a spelling of a kind list: it claims a kind only while an
    installed manifest model can serve it, so a machine with no video model
    falls to the still-clip tier instead of failing. A doc that names a
    literal list where the code says `auto` describes a static gate the engine
    does not have, and the behaviour it hides is the useful one.
    """
    text = _RUNNING.read_text(encoding="utf-8")
    stated = re.search(r"`LOCALCUT_COMFY_KINDS`.*?defaults to `([^`]+)`", text, re.S)
    assert stated, "docs/running-real-models.md no longer states a LOCALCUT_COMFY_KINDS default"

    actual = EngineConfig().comfy_kinds
    assert stated.group(1) == actual, (
        f"docs/running-real-models.md documents the LOCALCUT_COMFY_KINDS default as "
        f"{stated.group(1)!r}, but EngineConfig carries {actual!r}"
    )


def test_the_readme_states_the_node_floor_the_manifest_declares() -> None:
    """A version a reader installs against, pinned to the one npm reads.

    The floor is the strictest of the direct dependencies rather than a round
    major: vite, electron and the react plugin want 22.12, and jsdom wants
    22.13, so a `>=22` that npm accepts would still leave `npm run dev`
    failing on the first Node it let through.

    Read as a whole version rather than a major, so tightening the floor to a
    patch stays expressible - a test that only understands `>=N` refuses the
    correction it exists to make possible.
    """
    declared = json.loads(_PACKAGE_JSON.read_text(encoding="utf-8")).get("engines", {}).get("node")
    assert declared, "apps/desktop/package.json declares no engines.node"

    floor = re.fullmatch(r">=\s*(\d+(?:\.\d+)*)", declared.strip())
    assert floor, f"engines.node is {declared!r}; this test reads the `>=VERSION` form"

    # `\d+(?:\.\d+)*` rather than `[\d.]+`: the sentence ends on a full stop,
    # and a trailing `.` is punctuation, not another version segment.
    stated = re.findall(r"Node\s*[>=≥]+\s*(\d+(?:\.\d+)*)", _README.read_text(encoding="utf-8"))
    assert stated, "the README no longer states a Node version - update this test with it"
    assert set(stated) == {floor.group(1)}, (
        f"the README says Node {sorted(set(stated))} while apps/desktop/package.json "
        f"declares {declared!r}, which is the one npm reads"
    )


def _matrix_platforms(workflow: str) -> list[str]:
    """The platforms one CI workflow's job matrix runs on, in prose names.

    Read from the live `os:` line rather than from every `os:` in the file: a
    matrix narrowed for a while tends to leave the wider list behind as a
    commented line, and a reader of YAML-as-text has to be able to tell those
    apart. `^[ ]*os:` cannot match a `#`-prefixed one.
    """
    text = (_WORKFLOWS / workflow).read_text(encoding="utf-8")
    lists = re.findall(r"^[ ]*os: \[([^\]]+)\]$", text, re.M)
    assert len(lists) == 1, (
        f"{workflow} declares {len(lists)} live matrix `os:` lists; this test reads one"
    )

    platforms = []
    for runner in (entry.strip() for entry in lists[0].split(",")):
        vendor = runner.split("-", 1)[0]
        assert vendor in _RUNNER_PLATFORM, (
            f"{workflow} runs on {runner!r}, which this test has no prose name for - add it"
        )
        platforms.append(_RUNNER_PLATFORM[vendor])
    return platforms


def test_the_readme_names_the_platforms_ci_actually_runs_on() -> None:
    """What a contributor is told a push will be checked against.

    The claim in this file with the shortest half-life. A matrix is the one
    thing here that gets narrowed for reasons unrelated to the code - a slow
    runner, a flaky leg, a billing ceiling - and the sentence describing it is
    in another file entirely, so the narrowing and the correction are never
    the same edit. What is left is a reader trusting a platform is covered.

    Both directions, and per suite. A README naming a platform CI does not run
    promises coverage that is not there; one omitting a platform CI does run
    leaves a contributor surprised by a red leg they had no reason to expect.
    The two suites are checked against their own matrices, because they do not
    have to agree with each other - only with themselves.
    """
    # Newlines collapsed first: this is prose in a hard-wrapped document, so
    # where its line breaks fall is a function of how long the platform names
    # happen to be, and a pattern that had to know would go red on a reflow
    # that changed nothing.
    prose = " ".join(_README.read_text(encoding="utf-8").split())
    claim = re.search(
        r"CI runs the engine suite on ([^.;]+?), and the desktop suite on ([^.;]+?)\.", prose
    )
    assert claim, (
        "the README no longer states which platforms CI runs each suite on - "
        "update this test with the sentence that replaced it"
    )

    for suite, stated, workflow in (
        ("engine", claim.group(1), "ci-engine.yml"),
        ("desktop", claim.group(2), "ci-desktop.yml"),
    ):
        named = sorted(re.findall("|".join(_RUNNER_PLATFORM.values()), stated))
        runs_on = sorted(_matrix_platforms(workflow))
        assert named == runs_on, (
            f"the README says the {suite} suite runs on {named}, but {workflow}'s "
            f"matrix runs it on {runs_on}"
        )


def test_the_entry_points_hold_links_to_check() -> None:
    """The floor under the parametrized test below.

    An empty parameter set is one skip rather than a failure, and a skip is a
    test that did not run - so a pattern that quietly stopped matching the way
    the documents are written would leave the link check reading green having
    resolved nothing.
    """
    assert _documented_links(), (
        "no relative links were extracted from README.md or docs/ - the link "
        "pattern no longer matches the way these documents are written"
    )


@pytest.mark.parametrize(("doc", "link"), _documented_links())
def test_every_relative_link_in_the_docs_resolves(doc: str, link: str) -> None:
    """A dead link in a README is the first thing a new reader hits.

    Parametrized so the failure names the one broken target rather than a list
    - the fix is per-link, and a single assertion listing five would be read
    as one problem. The document is carried alongside so the message names the
    file to open, which a set of bare targets could not.

    Relative targets only: an http URL needs the network to check, which would
    make this suite fail for a reason that has nothing to do with the tree.
    """
    resolved = (REPO_ROOT / doc).parent / link
    assert resolved.exists(), f"{doc} links {link!r}, which resolves to nothing"


def test_ci_and_the_hook_run_this_module_for_the_documents_it_reads() -> None:
    """A contract test that cannot fire is not a contract.

    Every path in `_DOCUMENT_INPUTS` sits outside `engine/`: a PR that only
    rewrites a docs page, or only bumps the Node floor in package.json,
    matches no filter that can run pytest unless these name it. package.json
    alone runs the desktop suite, which cannot import EngineConfig.

    Both sides are checked, because they fail at different moments: the hook
    is what catches it before the push, and the workflow is what catches a PR
    opened from a machine with no hooks installed. And both of the workflow's
    triggers separately, since ci-engine.yml carries the list twice.
    """
    filters = ci_engine_paths_by_trigger()
    for trigger in ("push", "pull_request"):
        assert filters.get(trigger), (
            f"ci-engine.yml no longer lists quoted paths under {trigger} - update this test with it"
        )

    hook = hook_files_pattern("readme-contract")

    for path in _DOCUMENT_INPUTS:
        for trigger, globs in filters.items():
            assert matches_a_path_filter(path, globs), (
                f"ci-engine.yml's {trigger} path filter does not name {path}, which this "
                "module reads - a change to it would run no suite that can check these claims"
            )
        assert hook.match(path), (
            f"the readme-contract pre-push hook does not name {path}, so a commit "
            "touching it alone is pushed with nothing run"
        )
