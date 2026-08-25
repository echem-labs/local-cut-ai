"""What the docs promise about the engine, against what the engine does.

Prose is the one place a value can be written twice and drift without any
build step noticing, and documentation drifts in the direction that costs a
reader the most: it stays plausible. Both claims below were wrong in the
README before this module existed - the `local` backend chain was missing a
backend, and the ComfyUI kind gate was documented with a literal list where
the code had grown a behaviour - and neither is the kind of error a reader can
catch, because both read exactly like the truth.

Scoped to claims that name a value the code also states. A sentence about what
"Finalize" is for cannot be pinned to anything and belongs to review; a
sentence listing the six backends `local` expands to is the same tuple written
in two files.

`ci-engine.yml` and `.pre-commit-config.yaml` name the files below in their
path filters, for the reason `test_license_contract.py` gives at length: the
documents live outside `engine/`, so a filter that omits one lets exactly the
edit this module guards through with nothing run.
"""

from __future__ import annotations

import json
import re

import pytest

from conftest import REPO_ROOT

from localcut_engine.config import EngineConfig

_RUNNING = REPO_ROOT / "docs" / "running-real-models.md"
_README = REPO_ROOT / "README.md"
_PACKAGE_JSON = REPO_ROOT / "apps" / "desktop" / "package.json"


def test_the_documented_local_chain_is_the_chain_the_engine_builds() -> None:
    """`local` is a shorthand, and the docs spell out what it expands to.

    Order is part of the claim, not incidental: `chatterbox` sits ahead of
    `kokoro` because it claims only `local:chatterbox` narration and lets
    everything else fall through, so a table that lists the same six backends
    in another order describes a different routing.

    Read from the table's first column rather than from prose, so the check is
    against the thing a reader actually scans.
    """
    assert _RUNNING.exists(), "docs/running-real-models.md is missing"
    text = _RUNNING.read_text(encoding="utf-8")

    section = re.search(r"^## The backend chain\b.*?(?=^## |\Z)", text, re.S | re.M)
    assert section, "no 'The backend chain' section to read the expansion from"
    documented = re.findall(r"^\| `([a-z]+)` \|", section.group(0), re.M)
    assert documented, "the backend chain section no longer holds a table of backends"

    actual = EngineConfig(backend="local").backend_chain
    assert documented == actual, (
        f"docs/running-real-models.md documents the `local` chain as {documented}, "
        f"but EngineConfig builds {actual} - order matters, because the first "
        "backend that serves a node kind wins"
    )


def test_the_readme_states_the_node_floor_the_manifest_declares() -> None:
    """A version a reader installs against, pinned to the one that is enforced.

    The README named a Node version while `package.json` declared no `engines`
    at all, so the number was advice with nothing behind it and no way to
    notice it going stale. Now npm reads one of them; this is what keeps the
    other saying the same thing.
    """
    declared = json.loads(_PACKAGE_JSON.read_text(encoding="utf-8")).get("engines", {}).get("node")
    assert declared, "apps/desktop/package.json declares no engines.node"

    floor = re.fullmatch(r">=\s*(\d+)", declared.strip())
    assert floor, f"engines.node is {declared!r}; this test reads the `>=N` form"

    stated = re.findall(r"Node\s*[>=≥]+\s*(\d+)", _README.read_text(encoding="utf-8"))
    assert stated, "the README no longer states a Node version - update this test with it"
    assert set(stated) == {floor.group(1)}, (
        f"the README says Node {sorted(set(stated))} while apps/desktop/package.json "
        f"declares {declared!r}, which is the one npm enforces"
    )


@pytest.mark.parametrize(
    "link",
    sorted(
        {
            target
            for doc in (REPO_ROOT / "docs").glob("*.md")
            for target in re.findall(r"\]\(([^)#][^)]*)\)", doc.read_text(encoding="utf-8"))
            if not target.startswith(("http://", "https://", "mailto:"))
        }
        | {
            target
            for target in re.findall(
                r"\]\(([^)#][^)]*)\)", (REPO_ROOT / "README.md").read_text(encoding="utf-8")
            )
            if not target.startswith(("http://", "https://", "mailto:"))
        }
    ),
)
def test_every_relative_link_in_the_docs_resolves(link: str) -> None:
    """A dead link in a README is the first thing a new reader hits.

    Parametrized so the failure names the one broken target rather than a list
    - the fix is per-link, and a single assertion listing five would be read
    as one problem.

    Relative targets only: an http URL needs the network to check, which would
    make this suite fail for a reason that has nothing to do with the tree.
    """
    for base in (REPO_ROOT, REPO_ROOT / "docs"):
        if (base / link).exists():
            return
    pytest.fail(f"{link!r} is linked from the docs but resolves to nothing")
