# Packaging (Windows and Linux)

Two steps: freeze the engine with PyInstaller, then wrap it and the shell with
electron-builder. The packaged app spawns the bundled
`resources/engine/localcut[.exe]` instead of `uv run`.

PyInstaller does not cross-compile — freeze on the OS you are packaging for.

```bash
cd engine
uv sync --group build
uv run pyinstaller --noconfirm localcut.spec   # → engine/dist/localcut/

cd ../apps/desktop
npm install

# Windows
npm run package            # → release/LocalCut Setup 0.1.0.exe (NSIS, unsigned)
npm run package:dir        # → release/win-unpacked/ only

# Linux
npm run package:linux      # → release/*.AppImage + release/*.deb
npm run package:linux:dir  # → release/linux-unpacked/ only
```

## Things to know about the result

**The packaged engine defaults to the mock backend.** Set `LOCALCUT_BACKEND=local`
— plus ComfyUI and Ollama, see [running-real-models.md](running-real-models.md)
— before launching to render with real models.

**Windows builds are unsigned for now.** SmartScreen warns on the installer:
More info → Run anyway.

**Neither package bundles ffmpeg.** The engine finds one via
`LOCALCUT_FFMPEG_BIN` or `PATH`. On-screen titles need a build with the
`drawtext` filter — FFmpeg 7+ static builds without libharfbuzz lack it, and
`GET /system` reports this as `ffmpeg_drawtext`.

**macOS** is not built yet; a beta is still to come.
