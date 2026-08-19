# PyInstaller spec — freezes the engine into dist/localcut/ (onedir).
# Build:  uv sync --group build && uv run pyinstaller --noconfirm localcut.spec
# The desktop package picks the output up as an extraResource
# (apps/desktop/electron-builder.yml).
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files

# Package data read via importlib.resources at runtime: the default model
# manifest and the ComfyUI workflow templates.
datas = collect_data_files("localcut_engine")

# Apache-2.0 §4(a) wants a copy of the licence to reach every recipient, and
# §4(d) the NOTICE. This is the one place that satisfies both for all four
# installers at once: electron-builder copies dist/localcut wholesale into
# resources/engine, so the nsis exe, the dmg, the AppImage and the deb each
# pick these up from here. Doing it per-target instead would be four edits
# that drift apart, and the deb already asserts `License: Apache-2.0` in its
# control file from apps/desktop/package.json.
datas += [("../LICENSE", "."), ("../NOTICE", ".")]

# The notices for everything the freeze redistributes *besides* our own code:
# every Python distribution in the runtime closure and every native library
# collected alongside them, with the licence texts each one obliges us to
# reproduce. Generated here rather than committed because the answer is
# platform-specific — the `av` wheel bundles a different FFmpeg per OS and
# architecture — so a file written on one machine would misdescribe the
# installers built on the other two.
#
# Lands beside LICENSE and NOTICE, which on PyInstaller 6 means
# resources/engine/_internal/ rather than the top of resources/engine —
# COLLECT puts every data file there and only the executable stays above it.
# That satisfies the obligation, which is that a copy accompany the
# distribution, but it is worth writing down: the three files are one
# directory deeper than the place someone would look for them.
sys.path.insert(0, str(Path(SPECPATH) / "packaging"))
from third_party_notices import bundled_libraries, write_notices  # noqa: E402

a = Analysis(
    ["packaging/entry.py"],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=[],
    hookspath=[],
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

# Written after Analysis rather than before it, because the native libraries
# the installers carry are the ones PyInstaller collected — and most of those
# link in from the build machine rather than riding inside a wheel. Deriving
# the list from site-packages instead missed 33 of the 73 in the last Linux
# freeze, `libreadline` (plain GPL-3.0, no linking exception) among them.
#
# Both TOCs, not just `a.binaries`: Analysis splits the collected set by
# typecode, keeping BINARY and EXTENSION in `binaries` and putting everything
# else — symlinks, and any shared library a hook collected as package data —
# into `datas`. Reading one of the two would describe most of the freeze and
# call it all of it.
_notices = Path(SPECPATH) / "build" / "THIRD-PARTY-NOTICES.txt"
_notices.parent.mkdir(parents=True, exist_ok=True)
write_notices(_notices, bundled_libraries(dest for dest, _src, _kind in a.binaries + a.datas))
a.datas += [("THIRD-PARTY-NOTICES.txt", str(_notices), "DATA")]

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="localcut",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="localcut",
)
