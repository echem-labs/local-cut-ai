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

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "packaging"))

from third_party_notices import (  # noqa: E402  (needs the path above)
    COPYLEFT_LIBRARIES,
    build_notices,
    bundled_libraries,
    runtime_distributions,
    site_package_roots,
    write_notices,
)

_DEV_ONLY = ("pytest", "ruff", "pyinstaller", "pre-commit")


@pytest.fixture(scope="module")
def document() -> str:
    return build_notices()


def test_it_describes_the_runtime_closure_not_the_build_environment() -> None:
    names = {dist.metadata["Name"].lower() for dist in runtime_distributions()}
    assert "fastapi" in names, "the runtime closure is not being walked at all"
    for tool in _DEV_ONLY:
        assert tool not in names, (
            f"{tool} is a build-time tool that is not redistributed — listing it makes "
            "the notices less true, not more complete"
        )


def test_every_distribution_is_named_with_a_licence(document: str) -> None:
    for dist in runtime_distributions():
        name = dist.metadata["Name"]
        assert f"\n{name} {dist.version}\n" in document, f"{name} missing from the notices"
    # "not declared" is the generator's honest fallback; it must stay rare
    # enough to be a fact about upstream rather than a hole in this code.
    assert document.count("License: not declared") <= 2


def test_it_reproduces_licence_texts_rather_than_only_naming_them(document: str) -> None:
    # The obligation this file exists for. An SPDX identifier is not a notice.
    assert document.count("Permission is hereby granted") >= 10
    assert "Apache License" in document


def test_a_wheel_that_ships_no_licence_text_says_so(document: str) -> None:
    """Silence would read as 'nothing to reproduce'."""
    assert "This wheel publishes no licence file" in document


def test_the_bundled_native_libraries_are_listed(document: str) -> None:
    libraries = bundled_libraries()
    assert len(libraries) > 20, "the native libraries inside wheels are not being found"
    for library in libraries:
        assert f"  {library}" in document, f"{library} ships but is not in the notices"


def test_the_copyleft_libraries_are_named_with_what_they_oblige(document: str) -> None:
    """The strongest terms in the box are the ones silence hurts most."""
    present = [lib for lib in bundled_libraries() if lib in COPYLEFT_LIBRARIES]
    assert present, "no copyleft library found — either the scan broke or the table is stale"
    for library in present:
        line = next(ln for ln in document.splitlines() if ln.strip().startswith(library))
        assert "—" in line, f"{library} is listed without naming its terms"


def test_both_install_roots_are_scanned() -> None:
    """purelib and platlib are one directory in a venv and two elsewhere."""
    roots = site_package_roots()
    assert roots, "no site-packages root resolved"
    assert len(roots) == len(set(roots)), "the same root was scanned twice"


def test_it_writes_a_file_with_a_body(tmp_path: Path) -> None:
    written = write_notices(tmp_path / "THIRD-PARTY-NOTICES.txt")
    text = written.read_text(encoding="utf-8")
    # A header-only document is the failure mode that still looks like success
    # from the outside: the file exists, in the right place, saying nothing.
    assert len(text.splitlines()) > 500
    assert text.endswith("\n")
