"""The container image's supply-chain pins, read off the file.

No job builds this image — test_cli_name.py says so where it explains why it
reads the Dockerfile itself — so nothing else in the suite can tell whether
the pins hold. What can be checked here is cheap and is the only check there
is.
"""

import re
from pathlib import Path

DOCKERFILE = Path(__file__).resolve().parents[2] / "engine" / "Dockerfile"


def _instructions(text: str) -> list[str]:
    """One string per instruction, continuations joined and comments dropped."""
    body = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))
    return [line.strip() for line in re.sub(r"\\\n\s*", " ", body).splitlines() if line.strip()]


def test_the_ffmpeg_pin_is_a_digest():
    """A blank or truncated pin verifies nothing while still looking like a
    pin, and the build that would have caught it is not one CI runs."""
    assert re.search(r"^ARG FFMPEG_SHA256=[0-9a-f]{64}$", DOCKERFILE.read_text(), re.MULTILINE)


def test_the_ffmpeg_tarball_is_verified_by_something_every_builder_runs():
    """`ADD --checksum=` is a BuildKit feature: the legacy builder accepts the
    flag, ignores it, and builds clean against a digest that does not match.
    podman, buildah and any runner with BuildKit disabled take that path, and
    this container is network-exposed and processes untrusted media — so the
    verification that has to hold is one in a RUN, which every builder
    executes.

    Asserted against the step that unpacks the tarball rather than against
    the file. A check anywhere would satisfy a whole-file search while the
    unpacking step went on reading whatever was downloaded; what matters is
    that nothing uses the file before something has verified it.
    """
    unpacking = next(
        step
        for step in _instructions(DOCKERFILE.read_text())
        if "tar -xf /tmp/ffmpeg.tar.xz" in step
    )

    assert "sha256sum -c" in unpacking
    assert unpacking.index("sha256sum -c") < unpacking.index("tar -xf")
    # The pin, not a second copy of the digest for the two to drift apart on.
    assert "${FFMPEG_SHA256}" in unpacking
