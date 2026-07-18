# PyInstaller spec — freezes the engine into dist/localcut-engine/ (onedir).
# Build:  uv sync --group build && uv run pyinstaller --noconfirm localcut-engine.spec
# The desktop package picks the output up as an extraResource
# (apps/desktop/electron-builder.yml).
from PyInstaller.utils.hooks import collect_data_files

# Package data read via importlib.resources at runtime: the default model
# manifest and the ComfyUI workflow templates.
datas = collect_data_files("localcut_engine")

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

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="localcut-engine",
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
    name="localcut-engine",
)
