# AGENTS.md

Orientation for AI coding agents working in this repository. Humans want
[README.md](README.md) for what the app is and
[CONTRIBUTING.md](CONTRIBUTING.md) for how to submit a change.

## Read CLAUDE.md first

[CLAUDE.md](CLAUDE.md) holds the conventions that are load-bearing here — the
boundaries that must not be crossed, and the rules a test will fail you on.
Read it before you change anything.

What follows is an index of what is in there, by title only. Not a summary:
each line is the rule's name, and the reasoning that makes it followable is in
CLAUDE.md next to it. Restating any of it here would produce a second copy of
a convention list with nothing reconciling the two — which is itself one of
the rules in it, and the copy a reader trusts is always the stale one.

<!-- begin CLAUDE.md rule index -->

- The desktop talks to the engine only over HTTP/WS.
- The CLI is a *client* of the engine, not a second way into its data.
- Every graph edit goes through `/patch`.
- `graph/patch.py` is the consent chokepoint.
- CLI strings are ASCII.
- A value written down twice, on either side of a boundary no build step reconciles, gets a contract test.
- Every board status needs a UI case and a catalog label.
- A skip is a test that did not run.
- Tests go red without the fix.
- `project/store.py::_write_atomic` is the only writer for state files.
- Untrusted documents go through `jsondoc.refuse_reason`
- Regexes shared with a pydantic path param must be checked with `fullmatch`.
- Exit statuses are the automation contract
- Version fields are refused when newer, never reduced.
- No user-facing string is hardcoded in a component.
- Store actions that report a rejection return `Promise<string | null>`.
- Global keys are window-level listeners in a `useEffect`
- Tooltips are `<Tip>`, never the `title` attribute.
- Modals are `<Modal>`, never a hand-rolled overlay div.
- ARIA vocabulary is `group` / `img` / `dialog` / `status` / `note` / `menuitem` / `tab`.
- Layout is derived, never stored.
- Every app icon is rendered from `branding/logo.svg`.

<!-- end CLAUDE.md rule index -->

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

**ffmpeg must be on `PATH`** or the assembly tests skip rather than fail, and
the suite reads green while testing no assembly at all. That is why `-rs` is
not optional: read the skip list, and if it names the assembly module, ffmpeg
is missing rather than the tests being irrelevant. (No count of them here, or
anywhere — a number in prose is a number nobody updates, and `-rs` prints the
real one every run.)

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

Only what the index above does not already name — everything else is a rule
with its reasoning in CLAUDE.md, and this is not the place to learn it twice.

- **Do not run Prettier.** There is no config for it here; running it reflows
  the entire repository, and recovering by hand loses whatever you were doing.
- Commit messages describe the change, not the process that produced it.
  Sign off with `git commit -s` (DCO — see CONTRIBUTING.md).

## Driving the app as an agent, rather than editing it

Separate surface, same engine. `localcut mcp` speaks Model Context Protocol
over stdio and drives the engine's HTTP API — so it is a *client*, never a
second way into the data directory, and an agent's mutations land at the same
`/patch` chokepoint as everyone else's.

```
engine_info · list_projects · create_project · get_project · get_graph
approve · start_render · render_status · cancel_render · export_video
edit_project · apply_edit · patch_project · undo · redo · project_history
```

(That list is pinned against the registered tools by
`test_mcp.py::test_the_agents_file_lists_the_toolset_it_documents`, because a
toolset written down twice is a list that goes stale in the copy a reader
trusts.)

Natural-language edits are propose-then-act: `edit_project` returns a plan,
and `apply_edit` requires the previewed scope and revision.

**What is deliberately absent is the feature**, and a test holds it there.
The toolset cannot enable ComfyUI node packs (running third-party code is a
human's acknowledgment), touch provider keys, spend BYOK cloud models,
download weights, or delete projects. The cloud rule is enforced at the queue
rather than per route, because three client-side gates leaked in turn before
it was written that way. Enforced there, it is about the spend and not about
who asked: a render that would bill a provider key is refused whoever put that
node on a cloud model, so expect a 403 naming the nodes rather than a partial
render. Cached artifacts are not re-rendered and so do not trip it. Exports
are confined to one directory, because `out_path` is a model-authored string
and unconfined it is an arbitrary file write.

If you add an agent-reachable surface, re-establish those boundaries
explicitly. They are not inherited.
