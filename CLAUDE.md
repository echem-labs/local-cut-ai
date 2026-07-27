# Working in this repo

Conventions that are load-bearing here and not obvious from reading a single
file. Most exist because something already broke; where a test enforces one,
it is named so you can read the reasoning there rather than here.

The two halves are `engine/` (Python, the orchestrator and API) and
`apps/desktop/` (Electron + React). See README.md for what they do.

## Commits

Describe the change itself, not the process that produced it. What changed
and why, not how it was found. In particular, no meta-references: a commit
message is the permanent public history of this project, and "fix review
findings" tells a future reader nothing about the code.

## Boundaries that are actually boundaries

**The desktop talks to the engine only over HTTP/WS.** No filesystem
shortcuts, no shared paths, no reading the data dir. This is what makes a
remote engine on a GPU box work identically to a local one — a single
convenience shortcut would silently make that topology a special case.

**The CLI is a *client* of the engine, not a second way into its data.** Two
processes writing one `queue.db` and one project directory is the race the
`serve` bind ordering exists to prevent. See `automation.py`'s module
docstring.

**Every graph edit goes through `/patch`.** The canvas, the inspector and the
LLM editor all compile to the same validated ops, so the cycle check, the
voice-consent gate and the re-plan apply everywhere for free. A private
mutation path bypasses all three with nothing on screen to say so.

**`graph/patch.py` is the consent chokepoint.** The `voice_ref` port accepts
only a consented voice-sample asset, and `backends/chatterbox.py` explicitly
trusts that rather than re-checking. Any *new* route that can write an edge
has to re-establish it — template import is the second such route and had to
be fixed for exactly this.

## Rules a test will catch you on

- **CLI strings are ASCII.** Everything `cli.py` and `automation.py` put in a
  string literal reaches a console, and headless Windows stdout is the ANSI
  code page. Use `-` and `->`, not `—` and `→`. Docstrings are exempt.
  (`test_cli.py::test_every_string_the_cli_can_print_is_ascii`)
- **Constants mirrored across the Python/TS boundary get a contract test.**
  The desktop suite runs against TypeScript alone and cannot know what the
  engine sends; `DURATION_BOUNDS` drifted once already.
  (`test_ui_contract.py`)
- **Every board status needs a UI case and a catalog label.** Same file.
- **A skip is a test that did not run.** CI runs `pytest -q -rs` so what was
  skipped is readable from the log — a runner with a crippled ffmpeg once
  looked green while testing no assembly at all.
- **Tests go red without the fix.** Write the failing test first, or at least
  confirm it fails against the unfixed code before committing.

## Engine conventions

- **`project/store.py::_write_atomic` is the only writer for state files.**
  It carries an `fsync` (without which a power loss journals the rename but
  not the data) and a Windows `PermissionError` retry. Hand-rolled
  temp-write-then-rename has been reintroduced twice; don't.
- **Untrusted documents go through `jsondoc.refuse_reason`** before pydantic
  builds anything — it bounds size *and* nesting depth. Depth is the
  non-obvious one: `json.loads` parses far deeper than the encoder that
  measures it, so a small deeply-nested document raised `RecursionError` out
  of a route whose contract is to refuse with a reason.
- **Regexes shared with a pydantic path param must be checked with
  `fullmatch`.** Python's `$` also matches before a trailing newline; the
  rust engine pydantic uses reads it as end-of-text, and has no `\Z`. Keep
  the pattern text `$`-anchored and let `fullmatch` make the two agree.
- **Exit statuses are the automation contract**: 0 succeeded, 1 the operation
  failed, 2 the engine could not be reached. Nothing else may return 0.
- **Version fields are refused when newer, never reduced.** A document from a
  newer build that pydantic's `extra="ignore"` quietly strips is worse than
  one rejected with a reason — there is nothing to detect it against
  afterwards.

## Desktop conventions

- **No user-facing string is hardcoded in a component.** Everything reads
  through `t()` / `plural()` / `m()` against `src/i18n/en/*.json`, one file
  per namespace. Status words go through `status.json` — the raw wire value
  is an id (`skipped` reads "not needed" everywhere else).
- **Store actions that report a rejection return `Promise<string | null>`.**
  `null` means *it applied*; every other outcome — including "there is no
  engine client" — returns a message. Use `messageOf(err)`, not an inline
  `instanceof Error` ternary.
- **Global keys are window-level listeners in a `useEffect`,** not `onKeyDown`
  on a div. A div with no `tabIndex` never receives the event, which is how
  Escape-to-cancel silently did nothing during a pointer drag.
- **ARIA vocabulary is `group` / `img` / `dialog` / `status` / `note` /
  `menuitem` / `tab`.** Never nest interactive controls inside
  `role="button"` — ARIA specifies a button's children as presentational, so
  they vanish from assistive tech however reachable they are by Tab. Avoid
  `role="application"`; it takes a screen reader out of browse mode for
  everything inside.
- **Layout is derived, never stored.** Canvas positions are a pure function of
  the graph, deterministic across machines — so use code-unit ordering, not
  `localeCompare`, in any tie-break.

## Dependencies

Stay on latest stable, and verify the current version from the registry
rather than from memory. Renovate opens the routine bumps; the ML stack
(torch and friends) is pinned to what the vendored ComfyUI actually supports,
so those are deliberate rather than automatic.
