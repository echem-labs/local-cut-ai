# Packaging

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
npm run package            # → release/LocalCut AI Setup 0.1.0.exe (NSIS, unsigned)
npm run package:dir        # → release/win-unpacked/ only

# Linux
npm run package:linux      # → release/*.AppImage + release/*.deb
npm run package:linux:dir  # → release/linux-unpacked/ only

# macOS — the arch is on the CLI, because one freeze packages one arch
npm run package:mac        # → release/*.dmg (arm64)
npm run package:mac:x64    # → release/*.dmg (Intel, from an Intel freeze)
npm run package:mac:dir    # → the unpacked .app only
```

## Things to know about the result

**The packaged app launches the engine on `local,mock`**, the same hybrid the
dev flow uses: real backends claim what they can serve, mock catches the rest.
Install ComfyUI and Ollama — see [running-real-models.md](running-real-models.md)
— for the real ones to have anything to claim, or set `LOCALCUT_BACKEND` to
pin the chain yourself.

**Windows builds are unsigned for now.** SmartScreen warns on the installer:
More info → Run anyway.

**No package bundles ffmpeg.** The engine finds one via
`LOCALCUT_FFMPEG_BIN` or `PATH`. On-screen titles need a build with the
`drawtext` filter — FFmpeg 7+ static builds without libharfbuzz lack it, and
`GET /system` reports this as `ffmpeg_drawtext`.

**macOS builds are unsigned and un-notarized.** `.github/workflows/package.yml`
builds an arm64 dmg on every release run, but `electron-builder.yml` sets
`notarize: false` and the workflow turns identity discovery off, so a dmg from
CI is fine for testing and Gatekeeper will refuse it on anyone else's machine.
Signing reads `CSC_LINK` / `CSC_KEY_PASSWORD` from the environment when they
are set.
