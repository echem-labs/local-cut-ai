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

**The engine ships the font it draws text with.** On-screen titles and
burned-in captions use Inter, which the engine package carries in
`localcut_engine/assets/fonts/` and the freeze picks up as package data. They
do not depend on any font the machine has, so they render where none is
installed. Inter is by the Inter Project Authors under the SIL Open Font
License 1.1, and every installer's `THIRD-PARTY-NOTICES.txt` names the release
and reproduces the licence. Characters Inter lacks, CJK among them, come from
system fonts, in titles and captions alike, wherever libass's font provider
finds one.

**No package bundles ffmpeg.** The engine finds one via
`LOCALCUT_FFMPEG_BIN` or `PATH`. Titles and burned-in captions both need its
`ass` filter, which a build without libass lacks. `GET /system` reports
`ffmpeg_drawtext` as true only after the engine has burned in a title and a
caption with the bundled font.

**The installers include espeak-ng, which is GPL-3.0-or-later.** Kokoro
narration turns text into phonemes with espeak-ng, through phonemizer-fork
(also GPL-3.0-or-later), and narration cannot run without it. The frozen
engine carries espeak-ng's library and voice data in
`resources/engine/_internal/espeakng_loader/`. The installers distribute
those components under the GPL's terms. LocalCut AI's own source stays
Apache-2.0. Every installer's `THIRD-PARTY-NOTICES.txt`, beside `LICENSE` in
`resources/engine/_internal/`, names espeak-ng with its licence text and where
its source is.

**After changing `localcut.spec`, make the freeze narrate.** PyInstaller
freezes a package's modules and leaves behind the files the package reads
from beside them. An engine missing those still starts and answers
`--version`, then fails every narration. Render a short project through your
freeze, with ffmpeg and ffprobe on `PATH`:

```bash
cd engine
uv run python packaging/speech_check.py dist/localcut/localcut --data-dir /tmp/lc-speech
```

It downloads the Kokoro and faster-whisper weights through the frozen binary
(about 500 MB, once per data dir), renders, and fails unless every narration
and the captions came from the real backends. `package.yml` runs it on the
Linux and Windows builds.

**macOS builds are unsigned and un-notarized.** `.github/workflows/package.yml`
builds an arm64 dmg on every release run, but `electron-builder.yml` sets
`notarize: false` and the workflow turns identity discovery off, so a dmg from
CI is fine for testing and Gatekeeper will refuse it on anyone else's machine.
Signing reads `CSC_LINK` / `CSC_KEY_PASSWORD` from the environment when they
are set.
