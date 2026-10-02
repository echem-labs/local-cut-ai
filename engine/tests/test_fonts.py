"""The typeface the engine ships, held to what the code says about it.

The faces are binaries that nothing builds, so every fact the code states
about them is a second copy of something already inside the file: the family
an ASS style asks for, the weight a bold caption needs, the release the
notices name. Each one is read back out of the font tables here, because a
face swapped for another release or another cut keeps working on any machine
with system fonts, and on one without them goes blank or fake-bold.
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path

import pytest

from localcut_engine import fonts

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "packaging"))

from third_party_notices import FONT_LICENSE, build_notices  # noqa: E402

FACES = (fonts.REGULAR, fonts.BOLD)


def _tables(data: bytes) -> dict[bytes, bytes]:
    """The sfnt table directory, as `{tag: table bytes}`."""
    (count,) = struct.unpack_from(">H", data, 4)
    tables = {}
    for index in range(count):
        tag, _checksum, offset, length = struct.unpack_from(">4sIII", data, 12 + 16 * index)
        tables[tag] = data[offset : offset + length]
    return tables


def _names(data: bytes, name_id: int) -> set[str]:
    """Every Windows-platform (Unicode) string the face records under `name_id`."""
    table = _tables(data)[b"name"]
    _format, count, storage = struct.unpack_from(">HHH", table, 0)
    found = set()
    for index in range(count):
        platform, _encoding, _language, record, length, offset = struct.unpack_from(
            ">6H", table, 6 + 12 * index
        )
        if platform == 3 and record == name_id:
            start = storage + offset
            found.add(table[start : start + length].decode("utf-16-be"))
    return found


def _face(name: str) -> bytes:
    return (fonts.DIR / name).read_bytes()


@pytest.mark.parametrize("name", FACES)
def test_each_face_declares_the_family_the_captions_ask_for(name: str) -> None:
    """libass finds a caption's font by the family in its style, among the
    faces in the directory it is handed. A face declaring any other family is
    passed over for whatever the system has, and a machine without fonts
    then burns blank captions with ffmpeg reporting success."""
    assert _names(_face(name), 1) == {fonts.FAMILY}


def test_the_bold_caption_style_has_a_real_bold_face() -> None:
    """The caption style is bold. Given only a regular face, libass thickens
    its outline instead, which is how a variable font's Bold came out too."""
    weights = {
        name: struct.unpack_from(">H", _tables(_face(name))[b"OS/2"], 4)[0] for name in FACES
    }
    assert weights == {fonts.REGULAR: 400, fonts.BOLD: 700}
    for name in FACES:
        assert b"fvar" not in _tables(_face(name)), f"{name} is a variable font"


def test_the_recorded_release_is_the_one_the_faces_carry() -> None:
    """The notices name `fonts.VERSION`. Inter writes its release X.Y into
    each face as font revision X.00Y, so 4.1 is 4.001."""
    major, minor = (int(part) for part in fonts.VERSION.split("."))
    for name in FACES:
        (revision,) = struct.unpack_from(">i", _tables(_face(name))[b"head"], 4)
        assert revision / 65536 == pytest.approx(major + minor / 1000, abs=0.0005), name


def test_the_fonts_directory_holds_the_faces_and_nothing_else() -> None:
    """libass loads every file in its fonts directory as a font and logs an
    error for each one that is not, so the licence lives a level up."""
    assert sorted(path.name for path in fonts.DIR.iterdir()) == sorted(FACES)


def test_the_licence_ships_beside_the_faces_and_is_the_one_the_notices_name() -> None:
    text = fonts.LICENSE.read_text(encoding="utf-8")
    title = {"OFL-1.1": "SIL OPEN FONT LICENSE Version 1.1"}[FONT_LICENSE]
    assert title in text
    assert "Copyright (c) 2016 The Inter Project Authors" in text


def test_the_notices_credit_the_font_and_reproduce_its_licence() -> None:
    document = build_notices()
    section = document.split("\nFONTS\n", 1)[1].split("\nPYTHON DISTRIBUTIONS\n", 1)[0]
    assert f"{fonts.FAMILY} {fonts.VERSION}" in section
    assert f"License: {FONT_LICENSE}" in section
    assert fonts.SOURCE in section
    licence = fonts.LICENSE.read_text(encoding="utf-8").strip().splitlines()
    assert all(line.strip() in section for line in licence)
    # Above the libraries, whose section is read as rows to the end.
    assert document.index("\nFONTS\n") < document.index("BUNDLED NATIVE LIBRARIES")
