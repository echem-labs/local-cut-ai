# PyInstaller spec — freezes the engine into dist/localcut/ (onedir).
# Build:  uv sync --group build && uv run pyinstaller --noconfirm localcut.spec
# The desktop package picks the output up as an extraResource
# (apps/desktop/electron-builder.yml).
import sys
from pathlib import Path

import espeakng_loader
from PyInstaller.utils.hooks import collect_data_files

# Package data read via importlib.resources at runtime: the default model
# manifest and the ComfyUI workflow templates.
datas = collect_data_files("localcut_engine")

# Files that narration and captions read from beside their own modules.
# PyInstaller freezes a package's modules and leaves everything else behind,
# and nothing fails when it does: the engine starts, serves and answers
# `--version`, then meets FileNotFoundError at its first narration.
# packaging/speech_check.py is what notices, in package.yml.
#
#   kokoro_onnx      config.json, the phoneme vocabulary, read at import.
#   language_tags    its tag registry, read at import by csvw, which
#                    phonemizer reaches through `segments` when kokoro_onnx
#                    imports it.
#   espeakng_loader  espeak-ng-data, the dictionaries and phoneme tables
#                    espeak-ng phonemizes with. Only that directory: the rest
#                    of the package is its library, collected below.
#   faster_whisper   the Silero VAD model. The aligner passes
#                    vad_filter=False, but faster-whisper's own default is
#                    True, so the file is one changed argument from needed.
#
# phonemizer's share/ is left out on purpose. Only its festival and segments
# backends read it, and kokoro_onnx only ever builds the espeak one.
for package, subdir in (
    ("kokoro_onnx", None),
    ("language_tags", None),
    ("espeakng_loader", "espeak-ng-data"),
    ("faster_whisper", None),
):
    datas += collect_data_files(package, subdir=subdir)

# The espeak-ng library itself, under the one name espeakng_loader opens.
# Nothing collects it otherwise: the loader opens it through ctypes with a
# computed path, which PyInstaller's scan cannot follow. collect_data_files
# would not do it either, because on Linux it drops the `.so` suffix as a
# Python extension and keeps only the two versioned copies beside it, which
# nothing opens. So the package is asked where it looks. On each platform that
# is the file the freeze needs (libespeak-ng.so, libespeak-ng.dylib or
# espeak-ng.dll), and PyInstaller only ever builds for the platform it runs on.
#
# GPL-3.0-or-later, and shipped by decision: see docs/packaging.md, and the
# espeak-ng section of the THIRD-PARTY-NOTICES generated below.
binaries = [(espeakng_loader.get_library_path(), "espeakng_loader")]

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
from third_party_notices import (  # noqa: E402
    FREEZE_EXCLUDES,
    bundled_libraries,
    write_notices,
)

a = Analysis(
    ["packaging/entry.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=[],
    hookspath=[],
    # Absolute, unlike the script above it: PyInstaller joins a relative
    # `scripts` entry onto the spec's own directory, but a runtime hook goes
    # through a bare `os.path.abspath`, which resolves against the working
    # directory instead. Spelled relative, the hook is found only when
    # pyinstaller is run from `engine/` — and a same-named file under some
    # other working directory would be taken in its place.
    runtime_hooks=[str(Path(SPECPATH) / "packaging" / "rthook_av.py")],
    # Read from third_party_notices so the notices document and the freeze
    # cannot disagree about what is in the installer. See FREEZE_EXCLUDES for
    # what each one is and why it is out.
    excludes=list(FREEZE_EXCLUDES),
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
