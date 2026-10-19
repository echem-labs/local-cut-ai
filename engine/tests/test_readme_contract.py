"""What the docs promise about the engine, against what the engine does.

Prose is the one place a value can be written twice and drift without any
build step noticing, and documentation drifts in the direction that costs a
reader the most: it stays plausible. A sentence naming the wrong backend or
the wrong default reads exactly like one naming the right ones, so a reader
has nothing to catch it with and neither does review.

Scoped to claims that name a value the code also states. A sentence about what
"Finalize" is for cannot be pinned to anything and belongs to review; a
sentence listing the backends `local` expands to is the same tuple written in
two files. Links count as such a claim: a link names a file or a heading, and
the tree either has it or does not.

The documents live outside `engine/`, so `ci-engine.yml` and
`.pre-commit-config.yaml` have to name them in their filters or an edit to one
runs nothing that could check it. `_DOCUMENT_INPUTS` below, every page in
docs/ and every file those pages link are what both are describing, and the
test at the foot of this file reconciles all three.
"""

from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path

import pytest

from conftest import (
    REPO_ROOT,
    ci_engine_paths_by_trigger,
    hook_files_pattern,
    matches_a_path_filter,
)

from localcut_engine import cli
from localcut_engine.backends.chatterbox import INSTALL_HINT
from localcut_engine.config import EngineConfig

_RUNNING = REPO_ROOT / "docs" / "running-real-models.md"
_VOICES = REPO_ROOT / "docs" / "voices.md"
_README = REPO_ROOT / "README.md"
_PACKAGE_JSON = REPO_ROOT / "apps" / "desktop" / "package.json"
_ENGINE_TS = REPO_ROOT / "apps" / "desktop" / "electron" / "engine.ts"
_PYPROJECT = REPO_ROOT / "engine" / "pyproject.toml"
_WORKFLOWS = REPO_ROOT / ".github" / "workflows"


def _entry_points() -> list[Path]:
    """The documents a reader arrives at: the README and every page in docs/.

    Globbed rather than listed, so a page added to docs/ is read from the
    commit that adds it. A list here would be one more place to remember it.
    """
    return [_README, *sorted((REPO_ROOT / "docs").rglob("*.md"))]


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
    "docs/voices.md",
    "apps/desktop/package.json",
    "apps/desktop/electron/engine.ts",
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

#: A URL carried in an HTML attribute. GitHub renders raw HTML in a README,
#: and a layout built from it (a centred header, a grid of features, light and
#: dark variants of one picture) carries most of its links this way: `<a
#: href>`, `<img src>`, `<source srcset>`. The markdown pattern above sees none
#: of them, so without this one an image path could break and nothing would
#: go red.
_HTML_URL = re.compile(r"""\b(href|src|srcset)\s*=\s*(["'])(.*?)\2""", re.I | re.S)

#: A fenced code block, opening fence to the matching closing one. Nothing
#: inside one is rendered as a link or a heading: a `# comment` in a shell
#: block gets no anchor, and a `](path)` in an example is not a link.
_FENCE = re.compile(r"^[ \t]*(`{3,}|~{3,}).*?^[ \t]*\1[ \t]*$", re.M | re.S)

#: A heading, in either of the two forms GitHub gives an anchor: an ATX
#: heading, with any closing run of `#` dropped the way the renderer drops
#: it, or an HTML `<h1>` to `<h6>`. The HTML form matters for numbering. A
#: feature grid built from `<h3>` cells takes its slugs first, so a section
#: further down that repeats a cell's title is the `-1`.
_HEADING = re.compile(
    r"^#{1,6}[ \t]+(?P<atx>.+?)(?:[ \t]+#+)?[ \t]*$|<h([1-6])\b[^>]*>(?P<html>.*?)</h\2\s*>",
    re.M | re.I | re.S,
)

#: An explicit anchor, `<a id="...">` or `<a name="...">`.
_HTML_ANCHOR = re.compile(r"""<a\b[^>]*?\b(?:id|name)\s*=\s*(["'])(.*?)\1""", re.I)


def _prose(text: str) -> str:
    """A document with its fenced code blocks taken out."""
    return _FENCE.sub("", text)


def _targets(text: str) -> list[str]:
    """Every link target in a document, markdown and HTML alike.

    A `srcset` holds a list, each entry a URL optionally followed by a width or
    density descriptor (`mark@2x.png 2x`), so each entry contributes its first
    word.
    """
    prose = _prose(text)
    targets = list(_LINK.findall(prose))
    for attribute, _quote, value in _HTML_URL.findall(prose):
        if attribute.lower() == "srcset":
            targets.extend(entry.split()[0] for entry in value.split(",") if entry.strip())
        else:
            targets.append(value.strip())
    return targets


def _is_external(target: str) -> bool:
    return target.startswith(("http://", "https://", "mailto:"))


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
    for doc in _entry_points():
        for target in _targets(doc.read_text(encoding="utf-8")):
            if _is_external(target) or target.startswith("#"):
                continue
            # A query (`?raw=true` on an image) is not part of the path.
            path = target.split("#", 1)[0].split("?", 1)[0]
            if path:
                found.add((doc.relative_to(REPO_ROOT).as_posix(), path))
    return sorted(found)


def _slug(heading: str) -> str:
    """The anchor GitHub gives a heading.

    GitHub works from the rendered text: a link keeps its text, a code span
    keeps its content and loses the backticks, emphasis markers disappear.
    That text is lowercased, everything but letters, digits, `_`, `-` and
    spaces is dropped, and each space becomes a hyphen, one for one.
    """
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", heading)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"[`*]", "", text)
    text = re.sub(r"[^\w\- ]", "", text.strip().lower())
    return text.replace(" ", "-")


def _anchors(text: str) -> set[str]:
    """Every anchor a document defines, as GitHub numbers them.

    A repeated heading gets `-1`, `-2` and so on after its first use, which is
    why this counts rather than collecting a set of slugs directly.
    """
    prose = _prose(text)
    seen: dict[str, int] = {}
    found: set[str] = set()
    for match in _HEADING.finditer(prose):
        slug = _slug(match.group("atx") or match.group("html"))
        count = seen.get(slug, 0)
        found.add(slug if count == 0 else f"{slug}-{count}")
        seen[slug] = count + 1
    found.update(anchor for _quote, anchor in _HTML_ANCHOR.findall(prose))
    return found


def _documented_fragments() -> list[tuple[str, str, str]]:
    """Every link into a heading: the document it is in, the file it names
    (itself, for a bare `#anchor`) and the fragment.

    Only fragments into markdown are collected. An anchor into a YAML or
    Python file names a line GitHub draws, not a heading this module can read.
    """
    found: set[tuple[str, str, str]] = set()
    for doc in _entry_points():
        here = doc.relative_to(REPO_ROOT).as_posix()
        for target in _targets(doc.read_text(encoding="utf-8")):
            if _is_external(target) or "#" not in target:
                continue
            path, fragment = target.split("#", 1)
            named = (doc.parent / path).resolve() if path else doc
            if fragment and named.suffix == ".md" and named.exists():
                found.add((here, named.relative_to(REPO_ROOT).as_posix(), fragment))
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


#: A Python requirement stated in prose: "Python 3.13 or 3.14", "Python
#: ≥3.13", "Python 3.13 or later". The versions are a list a reader can read
#: off, and the two open-ended spellings say there is no ceiling.
_PYTHON_STATED = re.compile(
    r"Python\s*(?P<at_least>(?:>=|≥)\s*)?"
    r"(?P<versions>\d+\.\d+(?:(?:,\s*|\s+or\s+|\s+and\s+)\d+\.\d+)*)"
    r"(?P<later>\s+or\s+(?:later|newer))?"
)


def _declared_python() -> tuple[list[str], bool]:
    """The 3.x releases engine/pyproject.toml admits, and whether it caps them.

    Read as `>=X.Y` with an optional `<X.Z`, the two clauses a floor and a
    ceiling take. Any other clause fails here rather than being skipped: an
    exclusion like `!=3.14.1` changes what a reader can install, and a reader
    that dropped it would pass a README that never mentions it.
    """
    project = tomllib.loads(_PYPROJECT.read_text(encoding="utf-8"))["project"]
    declared = project.get("requires-python")
    assert declared, "engine/pyproject.toml declares no requires-python"

    bounds: dict[str, tuple[int, int]] = {}
    for clause in (c.strip() for c in declared.split(",")):
        parsed = re.fullmatch(r"(>=|<)\s*(\d+)\.(\d+)", clause)
        assert parsed, f"requires-python is {declared!r}; this test reads `>=X.Y` and `<X.Y`"
        bounds[parsed.group(1)] = (int(parsed.group(2)), int(parsed.group(3)))
    assert ">=" in bounds, f"requires-python is {declared!r}, which sets no floor"

    major, floor = bounds[">="]
    if "<" not in bounds:
        return [f"{major}.{floor}"], False
    ceiling_major, ceiling = bounds["<"]
    assert ceiling_major == major, f"requires-python is {declared!r}, across a major version"
    return [f"{major}.{minor}" for minor in range(floor, ceiling)], True


def test_the_readme_states_the_python_versions_the_engine_declares() -> None:
    """The other version a reader installs against, pinned like the Node one.

    `requires-python` is what uv enforces when it builds the engine's
    environment, so a README naming another range sends a reader to an
    install uv then refuses. The ceiling counts as much as the floor: a
    ceiling is there because a dependency publishes no wheels for the next
    release, and "or later" would read as an invitation to the version that
    fails.
    """
    admitted, capped = _declared_python()
    stated = list(_PYTHON_STATED.finditer(_README.read_text(encoding="utf-8")))
    assert stated, "the README states no Python version - update this test with what replaced it"

    *rest, last = admitted
    expected = f"{', '.join(rest)} or {last}" if rest else last
    if not capped:
        expected += " or later"
    for claim in stated:
        listed = re.findall(r"\d+\.\d+", claim.group("versions"))
        open_ended = bool(claim.group("at_least") or claim.group("later"))
        assert (listed, open_ended) == (admitted, not capped), (
            f"the README says {claim.group(0)!r}, but engine/pyproject.toml admits "
            f"Python {expected}, which is what uv reads"
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
        r"CI runs the engine suite on ([^.;]+?),? and the desktop suite on ([^.;]+?)\.", prose
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


def test_the_documented_clone_setup_is_the_one_the_dev_shell_runs() -> None:
    """Voice cloning's runtime stays out of uv.lock, so a dev checkout gets
    it by layering a requirements file over `uv run`, and three places spell
    that out: the desktop dev shell's engine command, docs/voices.md and the
    engine's own hint when the package is missing. An opt-in renamed in one
    of them reads as correct in the other two, and the reader following the
    stale one starts an engine without cloning and is told nothing.
    """
    shell = _ENGINE_TS.read_text(encoding="utf-8")
    opt_in = re.search(r'process\.env\.(LOCALCUT_\w+) === "1"', shell)
    layered = re.search(r'"--with-requirements",\s*path\.join\(engineDir, "([^"]+)"\)', shell)
    assert opt_in and layered, (
        "engine.ts no longer layers a requirements file over `uv run` behind an "
        "opt-in - update this test with it"
    )
    variable, requirements = opt_in.group(1), layered.group(1)

    listed = (REPO_ROOT / "engine" / requirements).read_text(encoding="utf-8")
    pins = [
        line.strip() for line in listed.splitlines() if line.strip() and not line.startswith("#")
    ]
    assert "chatterbox-tts" in pins

    doc = _VOICES.read_text(encoding="utf-8")
    assert f"{variable}=1" in doc, f"docs/voices.md does not tell you to set {variable}=1"
    assert f"uv run --with-requirements {requirements}" in doc
    for pin in pins:
        assert pin in doc, f"docs/voices.md does not say what {requirements} pins: {pin}"

    assert requirements in INSTALL_HINT and variable in INSTALL_HINT


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


def test_the_link_reader_sees_html_as_well_as_markdown() -> None:
    """The reader under the link checks, against a layout built from HTML.

    One of each shape a centred header, a feature grid and a theme-aware
    picture use, beside a markdown link, so a reader that handles only one
    kind cannot pass by finding the other. The fenced block holds a link that
    is not one: GitHub draws it as text.
    """
    sample = (
        '<img src="docs/media/storyboard.webp" alt="The storyboard">\n'
        "<a href='docs/voices.md#cloning'>voices</a>\n"
        '<source media="(prefers-color-scheme: dark)" srcset="dl-dark.svg, dl-dark@2x.svg 2x">\n'
        "[editing](docs/editing.md)\n"
        "```markdown\n[an example](not/a/link.md)\n```\n"
    )
    assert sorted(_targets(sample)) == sorted(
        [
            "docs/media/storyboard.webp",
            "docs/voices.md#cloning",
            "dl-dark.svg",
            "dl-dark@2x.svg",
            "docs/editing.md",
        ]
    )


def test_the_anchor_reader_names_headings_the_way_github_does() -> None:
    """Slugs for the heading shapes these documents use, checked by hand
    against the anchors GitHub renders for them."""
    text = (
        "# LocalCut AI\n"
        "## What is LocalCut AI?\n"
        "```bash\n# not a heading\n```\n"
        "## Scripts and agents\n"
        "### `localcut` from a script\n"
        "## Windows 10, version 1903 or later ##\n"
        "## LocalCut's own Ollama\n"
        "## [Programs](docs/programs.md) it needs\n"
        "## What is LocalCut AI?\n"
        '<a id="hero"></a>\n'
        '<td><h3 align="center">One-off <b>tools</b></h3></td>\n'
        "## One-off tools\n"
    )
    assert _anchors(text) == {
        "localcut-ai",
        "what-is-localcut-ai",
        "scripts-and-agents",
        "localcut-from-a-script",
        "windows-10-version-1903-or-later",
        "localcuts-own-ollama",
        "programs-it-needs",
        "what-is-localcut-ai-1",
        "hero",
        "one-off-tools",
        "one-off-tools-1",
    }


def test_every_link_into_a_heading_finds_it() -> None:
    """A link row at the top of the README points into the page by heading.

    Renaming the heading moves its anchor, and the link then opens the top of
    the page with nothing on screen to say it missed. The relative-link check
    above cannot see it, because the file half still resolves. The same holds
    for a docs page linking a heading in another page.

    One test over the whole list rather than a parametrized one: a document
    with no links into headings is a normal state, and an empty parameter set
    reports as a skip.
    """
    missed = [
        f"{doc} links {named}#{fragment}"
        for doc, named, fragment in _documented_fragments()
        if fragment not in _anchors((REPO_ROOT / named).read_text(encoding="utf-8"))
    ]
    assert not missed, "no heading has these anchors:\n  " + "\n  ".join(missed)


#: A command named in prose or a code block: `localcut <command>`, and for a
#: command that takes an action, the action or an `a|b|c` list of them. An
#: action only counts when a separator follows it, so the model id in
#: `localcut download kokoro-82m` is not read as an action cut short.
_COMMAND = re.compile(
    r"\blocalcut ([a-z][a-z-]*)(?: ([a-z][a-z-]*(?:\|[a-z][a-z-]*)*)(?=[\s`'\")\].,]|$))?"
)


def _documented_commands() -> dict[str, set[str]]:
    """Each `localcut` command the entry points name, with any actions named for it."""
    found: dict[str, set[str]] = {}
    for doc in _entry_points():
        for command, actions in _COMMAND.findall(doc.read_text(encoding="utf-8")):
            found.setdefault(command, set()).update(a for a in actions.split("|") if a)
    return found


def test_every_documented_command_is_one_the_cli_has(capsys: pytest.CaptureFixture[str]) -> None:
    """A command a reader copies out of the docs has to exist.

    The CLI and the pages that introduce it are the same list written twice,
    and a renamed subcommand leaves the old name in prose that still reads
    right. Asked through `--help` rather than read out of the parser's
    internals: argparse exits 0 for a command it has and 2 for one it does
    not, which is what a reader meets.
    """
    documented = _documented_commands()
    assert documented, "README.md and docs/ name no `localcut <command>` at all"

    missing = []
    for command, actions in sorted(documented.items()):
        with pytest.raises(SystemExit) as exited:
            cli.main([command, "--help"])
        usage = capsys.readouterr().out
        if exited.value.code != 0:
            missing.append(command)
            continue
        # A command with actions shows them as `{a,b,c} ...` in its usage.
        offered = re.search(r"\{([a-z,-]+)\} \.\.\.", usage)
        if offered:
            known = set(offered.group(1).split(","))
            missing.extend(f"{command} {action}" for action in sorted(actions - known))
    assert not missing, "the docs name commands the CLI does not have: " + ", ".join(missing)


def _linked_files() -> list[str]:
    """Every file or directory the entry points link, repository-relative.

    A directory keeps its trailing slash, which is what lets `deploy/` match
    a `deploy/**` path filter. A target that resolves to nothing is left to
    the link check, which names it.
    """
    found: set[str] = set()
    for doc, link in _documented_links():
        resolved = ((REPO_ROOT / doc).parent / link).resolve()
        if resolved.exists() and resolved.is_relative_to(REPO_ROOT):
            path = resolved.relative_to(REPO_ROOT).as_posix()
            found.add(f"{path}/" if resolved.is_dir() else path)
    return sorted(found)


def test_ci_and_the_hook_run_this_module_for_the_documents_it_reads() -> None:
    """A contract test that cannot fire is not a contract.

    Every path in `_DOCUMENT_INPUTS` sits outside `engine/`: a PR that only
    rewrites a docs page, or only bumps the Node floor in package.json,
    matches no filter that can run pytest unless these name it. package.json
    alone runs the desktop suite, which cannot import EngineConfig.

    The link checks read two more sets: every page in docs/, and every file
    those pages and the README link, since whether a link resolves is a
    property of its target as much as of the page. Renaming a linked file
    breaks a link in a commit that touches no document at all.

    Both sides are checked, because they fail at different moments: the hook
    is what catches it before the push, and the workflow is what catches a PR
    opened from a machine with no hooks installed. And both of the workflow's
    triggers separately, since ci-engine.yml carries the list twice. A path
    under `engine/` needs nothing from the hook: `engine-tests` runs the whole
    suite, this module included, on any change there.
    """
    filters = ci_engine_paths_by_trigger()
    for trigger in ("push", "pull_request"):
        assert filters.get(trigger), (
            f"ci-engine.yml no longer lists quoted paths under {trigger} - update this test with it"
        )

    hook = hook_files_pattern("readme-contract")

    read = {
        *_DOCUMENT_INPUTS,
        *(doc.relative_to(REPO_ROOT).as_posix() for doc in _entry_points()),
        *_linked_files(),
    }
    for path in sorted(read):
        for trigger, globs in filters.items():
            assert matches_a_path_filter(path, globs), (
                f"ci-engine.yml's {trigger} path filter does not name {path}, which this "
                "module reads - a change to it would run no suite that can check these claims"
            )
        assert path.startswith("engine/") or hook.match(path), (
            f"the readme-contract pre-push hook does not name {path}, so a commit "
            "touching it alone is pushed with nothing run"
        )
