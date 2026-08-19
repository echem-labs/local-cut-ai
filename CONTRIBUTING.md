# Contributing

## Licence and sign-off

This project is Apache-2.0. Contributions are accepted under the
[Developer Certificate of Origin](https://developercertificate.org/) — the
lightweight alternative to a CLA: you keep your copyright, and you assert
that you have the right to submit the work.

Sign off every commit:

```
git commit -s
```

That appends `Signed-off-by: Your Name <your@email>`, which is the whole
mechanism. CI checks it, because a policy nothing enforces lapses at the
first hurried merge.

## Before you open a PR

`CLAUDE.md` at the root is the real guide — it records the conventions that
are load-bearing here and the reasoning behind each, most of which exist
because something already broke. The short version:

- **Tests go red without the fix.** Write the failing test first, or at
  minimum confirm it fails against the unfixed code.
- **A value written on both sides of a boundary no build step reconciles
  gets a contract test.** The desktop suite runs against TypeScript alone
  and cannot know what the engine sends.
- **A skip is a test that did not run.** CI runs `pytest -q -rs` so what was
  skipped is readable from the log.
- **Commit messages describe the change, not the process** that produced it.

Install the hooks once — they are not active in a fresh clone, and nothing
else installs them:

```
uv run --project engine pre-commit install
```

That wires up a pre-push hook that runs the suites for the half of the tree
you touched. To run the gates by hand, in full:

```
cd engine && uv run pytest -q -rs && uv run ruff check . && uv run ruff format --check .
cd ../apps/desktop && npm run typecheck && npm test && npm run icon:check && npm run build
```

`icon:check` and `build` are easy to skip and are both CI gates: the app
icons are generated from `branding/logo.svg` and it is the committed binaries
that ship, so a mark edited without re-running `npm run icon` fails there.

The engine suite needs `ffmpeg` on `PATH` with the `drawtext`, `ass` and
`subtitles` filters, or the assembly tests skip rather than fail.

## Dependencies

Stay on latest stable and verify the current version from the registry
rather than from memory. Renovate opens the routine bumps.

A dependency that bundles a native library, or declares a copyleft licence,
will fail `engine/tests/test_license_boundaries.py`. That is not a bug in
the test — it is the licence decision arriving where someone can make it.
