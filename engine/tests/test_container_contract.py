"""The container image's supply-chain pins, read off the file.

No job builds this image — test_cli_name.py says so where it explains why it
reads the Dockerfile itself — so nothing else in the suite can tell whether
the pins hold. What can be checked here is cheap and is the only check there
is.
"""

import calendar
import re
from pathlib import Path

DOCKERFILE = Path(__file__).resolve().parents[2] / "engine" / "Dockerfile"

# The release a BtbN download URL names, e.g. autobuild-2026-09-30-13-08.
_BTBN_RELEASE = re.compile(
    r"https://github\.com/BtbN/FFmpeg-Builds/releases/download/"
    r"autobuild-(?P<year>\d{4})-(?P<month>\d{2})-(?P<day>\d{2})-\d{2}-\d{2}/"
)


def _instructions(text: str) -> list[str]:
    """One string per instruction, continuations joined and comments dropped."""
    body = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))
    return [line.strip() for line in re.sub(r"\\\n\s*", " ", body).splitlines() if line.strip()]


def test_the_ffmpeg_pin_is_a_digest():
    """A blank or truncated pin verifies nothing while still looking like a
    pin, and the build that would have caught it is not one CI runs."""
    assert re.search(r"^ARG FFMPEG_SHA256=[0-9a-f]{64}$", DOCKERFILE.read_text(), re.MULTILINE)


def test_the_ffmpeg_pin_is_a_month_end_build():
    """BtbN deletes nearly every build it publishes. `util/prunetags.sh` in
    BtbN/FFmpeg-Builds runs after each daily build, keeps the 14 newest
    autobuild releases and the newest one of each of the last 24 months, and
    deletes the rest along with their assets. A pin to any other build 404s
    about two weeks after BtbN published it, and the image stops building
    with nothing changed in this repository.

    The last build of a month that has ended is the one kept for two years,
    so that is what the pin has to be. A tag dated the last day of its month
    is that build unless BtbN ran twice that day. Then only the later run is
    kept, and the date alone cannot tell the two apart.
    """
    url = next(
        step.removeprefix("ARG FFMPEG_URL=")
        for step in _instructions(DOCKERFILE.read_text())
        if step.startswith("ARG FFMPEG_URL=")
    )
    release = _BTBN_RELEASE.match(url)
    assert release, f"FFMPEG_URL is not a BtbN autobuild release: {url}"

    year, month, day = (int(release[part]) for part in ("year", "month", "day"))
    assert day == calendar.monthrange(year, month)[1], (
        f"FFMPEG_URL pins the build of {year}-{month:02d}-{day:02d}, which BtbN "
        "deletes once 14 newer builds exist. Pin the last build of a month that has ended."
    )


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
