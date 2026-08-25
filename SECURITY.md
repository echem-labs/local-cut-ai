# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** A public issue
is the disclosure — everyone who reads it learns the flaw before there is a
fix, including the people who would use it.

Two private channels, either is fine:

- **GitHub** → the [Security tab](../../security/advisories/new) → "Report a
  vulnerability". This opens a private advisory only the maintainer can see.
- **Email** hanzlamateen@live.com, the same address
  [TRADEMARK.md](TRADEMARK.md) gives.

What helps, in rough order of usefulness: what an attacker gets, the steps to
reproduce it, the version or commit, and how the engine was reachable — a
local `127.0.0.1` bind and a `--host 0.0.0.0` bind on a shared network are
very different situations. A proof of concept is welcome and never required;
a clear description of the mechanism is worth more than a working exploit.

## What to expect

This is a small project with one maintainer, so the honest commitments are
modest ones:

- an acknowledgement **within 7 days** that a human has read it;
- an assessment — whether it is a real issue, and how serious — within 30 days;
- credit in the release notes when it is fixed, unless you would rather not be
  named.

If a week passes with no reply, assume the message went astray rather than
that it was ignored, and try the other channel.

There is no bug bounty. Nothing here is an offer of payment.

## What is in scope

The code in this repository, which is roughly:

- the **engine** — its HTTP/WS API, the bearer token that guards it, the TLS
  certificate pinning a remote engine uses, and the project store;
- the **MCP server** — the agent-facing surface, and the boundaries around it:
  the cloud-spend refusal, the export directory confinement, and anything
  reachable through a model-authored value;
- the **desktop app** — the Electron shell, its IPC, and how it holds the
  engine's token;
- the **packaging and release workflows** in `.github/workflows/`.

Reports about the engine being reachable from the network **when it was
deliberately bound there** are in scope only if the token, the TLS pinning, or
the API's own checks can be got around. `--host 0.0.0.0` and `--no-tls` do
what they say; using them is a decision about your network, not a flaw here.

## What is out of scope

Not because these do not matter, but because a report here cannot fix them:

- **Model weights** and what they generate. SDXL, LTX-Video and the rest carry
  their own licences and their own behaviour; this project downloads and runs
  them and makes no claim about their output.
- **ComfyUI, Ollama and other services the engine talks to.** They are not
  vendored here — the engine reaches them over HTTP. Report those upstream.
- **Third-party dependencies**, unless this repository uses one in a way that
  is itself unsafe. Report the library to its own maintainers; Renovate
  carries the version bumps here.
- Findings that require an attacker who **already has the user's machine or
  their data directory**. The engine's token and every project live there, so
  that access is game over by construction and is not a boundary this project
  claims to hold.

## Supported versions

Pre-1.0, and there is no release train yet: fixes land on `main` and go out in
the next build. Only the latest commit on `main` is supported. If you are on
an older build, the answer to "is it fixed" is "update".
