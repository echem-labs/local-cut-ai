"""The workflow jobs that call the GitHub CLI can tell it which repository.

`gh` finds the repository from the git remote of the directory it runs in. A
job that checks nothing out has no remote, so every `gh` call in it stops at
"not a git repository" unless `GH_REPO` names the repository. package.yml's
release job is such a job, and it only runs on a version tag, so nothing
exercises it until a release is being cut.
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = REPO_ROOT / ".github" / "workflows"

# `gh` in command position: first on a line, after a shell separator or
# after a keyword that takes a command. `gh api` is left out because its
# path names the repository itself (codeql.yml's `repos/${{ github.repository }}`).
_GH_CALL = re.compile(r"(?:^\s*|[;&|(!]\s*|\b(?:if|then|else|do)\s+)gh\s+(?!api\b)", re.MULTILINE)


def _checks_out(job: dict) -> bool:
    return any(
        str(step.get("uses", "")).startswith("actions/checkout@") for step in job.get("steps", [])
    )


def _gh_steps_without_a_repository(workflows: Path) -> list[str]:
    missing = []
    for workflow in sorted(workflows.glob("*.yml")):
        document = yaml.safe_load(workflow.read_text(encoding="utf-8")) or {}
        workflow_env = document.get("env") or {}
        for name, job in (document.get("jobs") or {}).items():
            if _checks_out(job):
                continue
            job_env = job.get("env") or {}
            for step in job.get("steps", []):
                if not _GH_CALL.search(str(step.get("run", ""))):
                    continue
                env = {**workflow_env, **job_env, **(step.get("env") or {})}
                if "GH_REPO" not in env:
                    missing.append(f"{workflow.name}: {name}: {step.get('name', '(unnamed)')}")
    return missing


def test_every_gh_call_without_a_checkout_names_its_repository():
    assert _gh_steps_without_a_repository(WORKFLOWS) == []


def test_the_check_finds_a_gh_call_in_a_job_with_no_checkout(tmp_path):
    """The guard above passes vacuously if it never recognises a gh call, so
    it is held to a job shaped like package.yml's release job."""
    (tmp_path / "release.yml").write_text(
        "jobs:\n"
        "  release:\n"
        "    steps:\n"
        "      - uses: actions/download-artifact@v8\n"
        "      - name: Attach\n"
        "        env:\n"
        "          GH_TOKEN: x\n"
        "        run: |\n"
        "          set -euo pipefail\n"
        "          ls installers/\n"
        '          gh release upload "$TAG" installers/*\n',
        encoding="utf-8",
    )
    assert _gh_steps_without_a_repository(tmp_path) == ["release.yml: release: Attach"]


def test_the_check_leaves_alone_a_job_that_checks_out(tmp_path):
    (tmp_path / "ci.yml").write_text(
        "jobs:\n"
        "  label:\n"
        "    steps:\n"
        "      - uses: actions/checkout@v7\n"
        "      - run: gh pr edit --add-label x\n",
        encoding="utf-8",
    )
    assert _gh_steps_without_a_repository(tmp_path) == []


def test_the_check_leaves_alone_a_gh_api_call_that_names_the_repository(tmp_path):
    (tmp_path / "scan.yml").write_text(
        "jobs:\n"
        "  eligible:\n"
        "    steps:\n"
        "      - run: |\n"
        '          repo=$(gh api "repos/owner/name")\n',
        encoding="utf-8",
    )
    assert _gh_steps_without_a_repository(tmp_path) == []
