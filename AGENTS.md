# AGENTS.md

Orientation for AI coding agents working in this repository. Humans want
[README.md](README.md) for what the app is and
[CONTRIBUTING.md](CONTRIBUTING.md) for how to submit a change.

## Read CLAUDE.md first

[CLAUDE.md](CLAUDE.md) holds the conventions that are load-bearing here — the
boundaries that must not be crossed, and the rules a test will fail you on.
It is not duplicated into this file on purpose: a second copy of a convention
list is a copy that drifts, which is itself one of the rules in it.

The short version, so you know what you are agreeing to read:

- **The desktop talks to the engine only over HTTP/WS.** No filesystem
  shortcuts. This is what makes a remote engine on a GPU box work identically
  to a local one.
- **Every graph edit goes through `/patch`.** The canvas, the inspector, the
  LLM editor and the MCP server all compile to the same validated ops, so the
  cycle check, the voice-consent gate and the re-plan apply everywhere.
- **`graph/patch.py` is the consent chokepoint** for voice cloning. A new
  route that can write an edge has to re-establish it.
- **Tests go red without the fix.** Write the failing test first, or at least
  confirm it fails against the unfixed code.
- **A value written down twice, across a boundary no build step reconciles,
  gets a contract test.**

## Layout

| | |
| --- | --- |
| `engine/` | Python. The orchestrator, the HTTP/WS API, the CLI, the backends. |
| `apps/desktop/` | Electron + React. The shell and the UI. |
| `branding/` | `logo.svg`, the source every app icon is generated from. |

## Commands

Engine (from `engine/`):

```bash
uv sync --all-groups
uv run pytest -q -rs        # -rs prints skip reasons; a skip is a test that did not run
uv run ruff check .
uv run ruff format --check .
```

**ffmpeg must be on `PATH`** or ~20 assembly tests skip rather than fail, and
the suite reads green while testing no assembly at all. That is why `-rs` is
not optional.

Desktop (from `apps/desktop/`):

```bash
npm install
npm run typecheck
npx vitest run
npm run build
npm run icon:check          # committed icons still match branding/logo.svg
npm run notices:check       # the third-party attribution list still resolves
```

## Things that will waste your time if you don't know them

- **Do not run Prettier.** There is no config; it reflows the whole repo.
- **CLI strings are ASCII.** Everything `cli.py` and `automation.py` can print
  reaches a console, and headless Windows stdout is the ANSI code page. Use
  `-` and `->`. A test enforces it.
- **Icons ship from `public/`, never `build/`.** electron-builder treats
  `build/` as build resources and leaves it out of the package, so a path into
  it resolves in dev and is missing in the installed app.
- **Layout is derived, never stored.** Canvas positions are a pure function of
  the graph, so tie-breaks use code-unit ordering, not `localeCompare`.
- Commit messages describe the change, not the process that produced it.
  Sign off with `git commit -s` (DCO — see CONTRIBUTING.md).

## Driving the app as an agent, rather than editing it

Separate surface, same engine. `localcut mcp` speaks Model Context Protocol
over stdio and drives the engine's HTTP API — so it is a *client*, never a
second way into the data directory, and an agent's mutations land at the same
`/patch` chokepoint as everyone else's.

```
engine_info · list_projects · create_project · get_project · get_graph
approve · start_render · render_status · export_video
edit_project · apply_edit · patch_project · undo · redo · project_history
```

Natural-language edits are propose-then-act: `edit_project` returns a plan,
and `apply_edit` requires the previewed scope and revision.

**What is deliberately absent is the feature**, and a test holds it there.
The toolset cannot enable ComfyUI node packs (running third-party code is a
human's acknowledgment), touch provider keys, spend BYOK cloud models,
download weights, or delete projects. The cloud rule is enforced at the queue
rather than per route, because three client-side gates leaked in turn before
it was written that way. The honest guarantee: an agent cannot *choose* cloud,
but a node the user already put on a cloud model still re-renders. Exports are
confined to one directory, because `out_path` is a model-authored string and
unconfined it is an arbitrary file write.

If you add an agent-reachable surface, re-establish those boundaries
explicitly. They are not inherited.
