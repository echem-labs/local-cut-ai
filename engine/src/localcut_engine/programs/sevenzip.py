"""Unpacking a 7z archive with 7-Zip's own console extractor.

Python reads zip and tar and not 7z. ComfyUI's portable builds are 7z
archives packed with LZMA2 behind the BCJ2 filter, which no pure-Python
reader decodes (py7zr has no BCJ2), so a setup that unpacks one downloads
7-Zip's `7zr.exe`, pinned in programs-manifest.json like a program build,
into its scratch folder and runs it there. It is gone with that folder.

Three steps, each one able to refuse the archive before anything of it is
used:

1. list: `7zr l -slt` names every member with its size and attributes and
   the listing is checked before anything is written. Every member sits
   under the pinned top folder; no name climbs out of it with `..` or names a
   drive, an absolute path or an alternate data stream; nothing is a link or
   a reparse point; no name repeats, in any case; and the files and their
   total size are the pin's.
2. extract: `7zr x -o<folder>` writes them into a folder of the scratch
   folder and reports a percentage that becomes bytes for the progress bar.
   7-Zip checks each file's CRC as it writes it.
3. walk: what landed is walked without following anything and has to be
   the pin's count of files and bytes, with no link or junction anywhere.

The digest of the archive is checked before any of this, so a listing that
fails here is a pinned build that is not what its pin says and is refused
the same way.
"""

from __future__ import annotations

import os
import re
import stat
import subprocess
import threading
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from .manifest import KeptTree

# A listing of tens of thousands of members takes a few seconds; one that
# takes minutes is an extractor that is stuck.
_LIST_TIMEOUT_S = 300.0
# How often the extracting thread looks for a cancel while 7-Zip works.
_POLL_S = 0.2
# 7-Zip's attribute letters for a Windows reparse point (a symlink or a
# junction) and the unix mode bits it prints after them.
_REPARSE_LETTER = "L"
_UNIX_MODE = re.compile(r"[-dlcbps][-rwxsStT]{9}")
_PERCENT = re.compile(rb"(\d{1,3})%")
# A drive ("C:"), or anything after a colon, which on NTFS names an
# alternate data stream of the file before it.
_COLON = ":"


class ArchiveRefused(Exception):
    """The archive cannot be unpacked as pinned: the extractor failed, or
    the listing or the unpacked tree is not what the pin says."""


class Stopped(Exception):
    """The unpack was cancelled; the extractor has been stopped."""


@dataclass(frozen=True)
class Member:
    path: str
    size: int
    folder: bool


def command(extractor: Path) -> list[str]:
    """How the extractor is started. A test runs a stand-in through its
    interpreter by replacing this."""
    return [str(extractor)]


def list_members(extractor: Path, archive: Path) -> list[Member]:
    """Every member of the archive, as 7-Zip's technical listing names it."""
    try:
        done = subprocess.run(
            [*command(extractor), "l", "-slt", "-ba", "-sccUTF-8", str(archive)],
            capture_output=True,
            timeout=_LIST_TIMEOUT_S,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise ArchiveRefused(f"the extractor could not list the archive: {exc}") from exc
    if done.returncode != 0:
        raise ArchiveRefused(
            f"the extractor could not list the archive (exit {done.returncode}): "
            f"{_last_line(done.stderr) or _last_line(done.stdout)}"
        )
    return parse_listing(done.stdout.decode("utf-8", errors="replace"))


def parse_listing(text: str) -> list[Member]:
    """The members in a `-slt` listing: blocks of `Key = value` lines, one
    block per member, separated by blank lines. A block that describes the
    archive itself (it has a `Type`) is not a member."""
    members: list[Member] = []
    for block in re.split(r"\r?\n\s*\r?\n", text):
        fields: dict[str, str] = {}
        for line in block.splitlines():
            key, sep, value = line.partition(" = ")
            if not sep:
                key, sep, value = line.partition(" =")
            if sep:
                fields[key.strip()] = value
        if "Path" not in fields or "Type" in fields:
            continue
        refusal = _unsafe(fields)
        if refusal:
            raise ArchiveRefused(refusal)
        attributes = fields.get("Attributes", "")
        letters = attributes.split(" ")[0]
        folder = fields.get("Folder", "-") == "+" or "D" in letters
        try:
            size = int(fields.get("Size") or 0)
        except ValueError:
            raise ArchiveRefused(f"{fields['Path']} has no size the listing can read") from None
        members.append(Member(path=fields["Path"], size=size, folder=folder))
    return members


def _unsafe(fields: dict[str, str]) -> str | None:
    """Why one member must not be unpacked, or None."""
    name = fields["Path"]
    for key in ("Symbolic Link", "Hard Link", "Link"):
        if fields.get(key):
            return f"{name} is a link"
    attributes = fields.get("Attributes", "")
    letters, _, rest = attributes.partition(" ")
    if _REPARSE_LETTER in letters:
        return f"{name} is a link or a junction"
    mode = _UNIX_MODE.search(rest)
    if mode and mode.group(0)[0] not in "-d":
        return f"{name} is not a plain file or folder"
    return None


def check_members(members: list[Member], tree: KeptTree) -> None:
    """Refuse the listing unless every member lands inside the pinned top
    folder and the files are exactly the pin's in number and size."""
    seen: set[str] = set()
    files = 0
    total = 0
    for member in members:
        parts = _parts(member.path)
        if parts is None or parts[0] != tree.root:
            raise ArchiveRefused(f"{member.path} would land outside {tree.root}")
        key = "/".join(parts).casefold()
        if key in seen:
            raise ArchiveRefused(f"{member.path} is in the archive twice")
        seen.add(key)
        if member.folder:
            continue
        if len(parts) == 1:
            raise ArchiveRefused(f"{member.path} is a file where the top folder should be")
        files += 1
        total += member.size
    if (files, total) != (tree.files, tree.bytes):
        raise ArchiveRefused(
            f"the archive holds {files} files of {total} bytes and the pin says "
            f"{tree.files} files of {tree.bytes} bytes"
        )


def _parts(path: str) -> list[str] | None:
    """A member's name as folder names, or None for one that is not a plain
    relative path: absolute, on a drive, with an alternate data stream, or
    climbing with `..`. Both separators count, whichever system wrote it."""
    if not path or path[0] in "/\\" or _COLON in path:
        return None
    parts = re.split(r"[/\\]", path)
    if any(part in ("", ".", "..") for part in parts):
        return None
    return parts


def extract(
    extractor: Path,
    archive: Path,
    into: Path,
    *,
    report: Callable[[int], None],
    stop: threading.Event,
) -> None:
    """Run 7-Zip to unpack the whole archive into `into`, where its top
    folder lands beside whatever else is there (the archive itself, in a
    setup's scratch folder). `report` gets the percentage done, 0 to 100.
    Setting `stop` kills the extractor and raises Stopped."""
    into.mkdir(parents=True, exist_ok=True)
    errors = into / "extractor-errors.txt"
    with errors.open("wb") as stderr:
        try:
            process = subprocess.Popen(
                [
                    *command(extractor),
                    "x",
                    "-y",
                    "-bso0",
                    "-bsp1",
                    "-bb0",
                    "-sccUTF-8",
                    f"-o{into}",
                    str(archive),
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=stderr,
            )
        except OSError as exc:
            raise ArchiveRefused(f"the extractor did not start: {exc}") from exc
        reader = threading.Thread(target=_read_progress, args=(process, report), daemon=True)
        reader.start()
        try:
            while process.poll() is None:
                if stop.wait(_POLL_S):
                    process.kill()
                    process.wait()
                    raise Stopped
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            reader.join(timeout=5)
    said = errors.read_bytes()
    errors.unlink(missing_ok=True)
    if process.returncode != 0:
        raise ArchiveRefused(
            f"the extractor stopped with exit {process.returncode}: "
            f"{_last_line(said) or 'no message'}"
        )


def _read_progress(process: subprocess.Popen, report: Callable[[int], None]) -> None:
    """7-Zip redraws its percentage in place with backspaces; the last one
    in each read is where it has got to."""
    assert process.stdout is not None
    last = -1
    while chunk := process.stdout.read1(4096):
        found = _PERCENT.findall(chunk)
        if found:
            percent = min(100, int(found[-1]))
            if percent != last:
                last = percent
                report(percent)


def long_path(path: Path) -> Path:
    r"""`path` in the form Windows reads past 260 characters (`\\?\C:\...`),
    on Windows; unchanged elsewhere. A portable build's deepest files sit
    more than 190 characters inside it, so in a user's data folder some of
    their paths are longer than that and a program that has not opted in to
    long paths (or runs where the system has not) cannot open them by the
    plain form. 7-Zip uses this form itself."""
    if os.name != "nt":
        return path
    return Path(extended(str(path.absolute())))


def extended(text: str) -> str:
    r"""An absolute Windows path in its extended-length form: a drive path
    gets `\\?\` in front, a share `\\?\UNC\` and one that has it already
    is left as it is."""
    if text.startswith("\\\\?\\"):
        return text
    if text.startswith("\\\\"):
        return "\\\\?\\UNC\\" + text[2:]
    return "\\\\?\\" + text


def verify_tree(folder: Path, tree: KeptTree) -> None:
    """Walk what was unpacked, following nothing and refuse it unless it is
    the pin's count of files and bytes with no link or junction anywhere."""
    files = 0
    total = 0
    pending = [long_path(folder)]
    while pending:
        current = pending.pop()
        with os.scandir(current) as entries:
            for entry in entries:
                info = entry.stat(follow_symlinks=False)
                if _is_link(entry, info):
                    raise ArchiveRefused(f"{entry.path} is a link")
                if stat.S_ISDIR(info.st_mode):
                    pending.append(Path(entry.path))
                elif stat.S_ISREG(info.st_mode):
                    files += 1
                    total += info.st_size
                else:
                    raise ArchiveRefused(f"{entry.path} is not a plain file")
    if (files, total) != (tree.files, tree.bytes):
        raise ArchiveRefused(
            f"{files} files of {total} bytes were unpacked and the pin says "
            f"{tree.files} files of {tree.bytes} bytes"
        )


def _is_link(entry: os.DirEntry, info: os.stat_result) -> bool:
    if entry.is_symlink() or entry.is_junction():
        return True
    attributes = getattr(info, "st_file_attributes", 0)
    return bool(attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))


def _last_line(output: bytes) -> str:
    lines = [
        line.strip()
        for line in output.decode("utf-8", errors="replace").splitlines()
        if line.strip()
    ]
    return lines[-1] if lines else ""
