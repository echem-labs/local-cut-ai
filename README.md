# LocalCut AI

A cross-platform desktop app that turns a prompt or a script into a finished
video — clips, narration, music, captions, thumbnail — using AI models running
**locally**, with cloud models as an optional upgrade.

> CapCut's ease of use, ComfyUI's power, running on your own GPU — your footage
> never has to leave your machine.

## What it does

- **Prompt → full video.** Script, storyboard keyframes, image-to-video clips,
  TTS narration, music, assembly, export. End to end.
- **Four ways to work, one project.** Prompt-only, beginner wizard, advanced
  inspector, and a node canvas — all views over the same project graph.
- **Local-first.** Unlimited generation on your own hardware, with
  hardware-aware model recommendations. Cloud is never required.
- **Local or remote engine.** Everything on one machine, or the engine headless
  on a big-GPU box with a laptop driving it.

## Status

🚧 **Early development.** One prompt renders to a watchable 60-second video,
unattended, on an 8 GB consumer GPU.

The MVP feature set is in: word-timed captions, a draft→final quality ladder
up to Wan 2.2, timeline editing, scene splitting, review checkpoints, BYOK
cloud providers, in-app model downloads, publish kits, NLE handoff, and
natural-language editing.

Installers build for Windows (NSIS) and Linux (AppImage/deb). macOS beta is
still to come.

## Try it

No GPU, no models and no ComfyUI needed — the mock backend runs the whole
pipeline with deterministic placeholder artifacts:

```bash
cd apps/desktop
npm install
npm run dev
```

That spawns its own engine with a fresh token. To drive the API directly
instead:

```bash
cd engine
uv sync
uv run localcut serve --backend mock   # API on 127.0.0.1:7830
```

Ready for real models? → **[docs/running-real-models.md](docs/running-real-models.md)**

## Repository layout

```text
engine/         Python orchestrator — story graph, compiler, job queue,
                execution backends, model manifest, FastAPI + WS API
apps/desktop/   Electron + React frontend — talks to the engine only over
                its HTTP/WS API, so a remote engine behaves identically
branding/       logo.svg, the source every app icon is generated from
deploy/         docker-compose for running the engine on a GPU box
docs/           the guides linked below
```

## Documentation

| | |
| --- | --- |
| [Running with real models](docs/running-real-models.md) | Backends, ComfyUI, the quality ladder, timing and audio |
| [Narration voices](docs/voices.md) | Choosing a stock voice, and consent-gated cloning |
| [Editing a project](docs/editing.md) | Natural-language edits, your own images, re-cuts |
| [Remote engine and cloud](docs/remote-and-cloud.md) | Headless on a GPU box, TLS pairing, BYOK providers |
| [Agents and automation](docs/agents-and-automation.md) | The automation CLI and the MCP server |
| [Packaging](docs/packaging.md) | Freezing the engine and building installers |

## Development

**Requirements:** Python ≥3.13 with [uv](https://docs.astral.sh/uv/), Node ≥22.

Install the hooks once, from the repo root:

```bash
uv run --project engine pre-commit install
```

Commits get `ruff check --fix` and `ruff format`. Pushes additionally get the
engine suite, the desktop typecheck and the desktop tests — gated on which half
of the tree you touched, so a desktop-only push does not run pytest.
`--no-verify` skips them.

**Engine:**

```bash
cd engine
uv run pytest -q -rs                   # -rs prints what skipped
uv run ruff check . && uv run ruff format --check .
uv run localcut probe                  # hardware profile + tier
```

`-rs` is not decoration. Without ffmpeg on `PATH` the assembly tests *skip*
rather than fail, so the suite reads green having tested no assembly at all.
If the skip list names the assembly module, install ffmpeg — or point
`LOCALCUT_FFMPEG_BIN` at one — rather than believing the green.

**Desktop:**

```bash
cd apps/desktop
npm run typecheck
npm test
npm run icon:check      # committed icons still match branding/logo.svg
```

CI is Ubuntu-only while the repo is private, so a green push hook is very
nearly the verdict CI gives.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers how to submit a change and the
sign-off it needs. [CLAUDE.md](CLAUDE.md) holds the conventions a test will
fail you on — worth reading before a first PR — and [AGENTS.md](AGENTS.md) is
the same orientation for an AI coding agent.

Found a security problem? **Do not open an issue** — an issue is the
disclosure. [SECURITY.md](SECURITY.md) gives two private ways to reach the
maintainer.

## License

Apache-2.0 — see [LICENSE](LICENSE). Contributions are accepted under the
Developer Certificate of Origin: sign off your commits with `git commit -s`.

The licence covers this repository's own source. It does not extend to the
model weights the app downloads, which carry their own terms (SDXL and
LTX-Video in particular are gated or non-OSI), nor to media generated with
them.

The **name and logo** are not covered by it either - Apache-2.0 section 6
grants no trademark rights beyond describing where the work came from and
reproducing NOTICE, whose attribution notices section 4(d) asks a derivative
work to carry anyway. Fork the code freely; give a modified build its own name.
[TRADEMARK.md](TRADEMARK.md) says what that means in practice, and what you
can do without asking.
