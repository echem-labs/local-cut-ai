# Narration voices

Two separate things: picking one of the stock voices, and cloning a real
speaker's. They use different backends and have very different consent rules.

## Picking a stock voice

The shipped Kokoro pack holds fifty-four voices. Which of them are actually
installed is a property of your machine, so the list is read from the pack:

```
GET  /voices                    the voices this engine can actually synthesize
GET  /voices/{id}/preview       that voice saying one line, so it can be auditioned
```

A preview is synthesized on first request and served from disk afterwards, so
auditioning the pack costs one synthesis per voice.

Set a voice at either level:

- **Per node** — the narration node's `voice_id` param names one exact speaker
  and overrides the style brief.
- **Across the project** — "use this voice for every scene" writes that same
  param over every scene that narrates, and a scene added afterwards inherits
  it from its neighbours. A re-run that grows the screenplay is the gap: the
  scenes that already existed keep their pick, and the new ones fall back to
  the style brief until you set them.

Leave `voice_id` unset and the voice is chosen per node from the style brief.
That is the default and it is not one fixed voice — different briefs resolve
to different speakers.

`/voices` reports `available: false` when narration would not route to Kokoro
at all — a chain pointing narration at Chatterbox or mock cannot honour a
pick, and neither can a machine with no weights yet. It answers in the same
shape as an empty pack, so a client renders its empty state rather than
special-casing an error.

## Cloning a voice (consent-gated)

Uploading audio with `consent=true` — an explicit affirmation that you have
the speaker's permission — is what stamps the asset as a voice sample. It is
the only place that stamp can be minted, and audio uploaded without it is an
ordinary asset: a music bed is not asked a question that is not its.

The enforcement point is the other end. `graph/patch.py` is the chokepoint:
the `voice_ref` port accepts only a stamped asset, so an unconsented one can
never reach the TTS backend however it was uploaded — and every new route that
can write a `voice_ref` edge has to go through it.

A narration node whose model is `local:chatterbox`, with a sample on its
`voice_ref` port, synthesizes with Chatterbox TTS (MIT, runs locally).

Routing is strict: a clone request never silently falls back to a stock voice.
If Chatterbox cannot serve it, the render fails rather than quietly producing
someone else's voice.

## Installing Chatterbox

`chatterbox-tts` is an optional runtime, like ComfyUI. It is not in the
engine's lockfile, because it brings PyTorch with it and most installs never
clone a voice. Install it into the engine's environment, from `engine/`:

```bash
uv pip install chatterbox-tts "setuptools<81"
```

Don't drop the setuptools pin. Chatterbox watermarks everything it generates
with resemble-perth, which imports `pkg_resources`, and setuptools stopped
shipping that module in 82 (81 still has it, behind a warning that recommends
`<81`). perth hides its failed import, so without the pin the package installs
and imports, and then every clone fails to load its model with
`TypeError: 'NoneType' object is not callable`.

On Windows, the torch you get from PyPI is CPU-only. Cloning works on it, but
slowly: one narration line took 17 minutes on a test machine. Using a GPU means
replacing it with a CUDA build of torch from PyTorch's own package index.

The install also moves tokenizers back a release, since the transformers
version chatterbox-tts pins refuses anything newer than 0.23.0. The rest of the
engine is fine with that. It is also the change a dev checkout keeps undoing.

### Keeping it in a dev checkout

`uv run` syncs the environment to `uv.lock` before it runs anything, which puts
the locked tokenizers and setuptools back over the ones chatterbox needs. The
desktop's dev shell starts the engine with `uv run localcut serve`, so every
launch breaks cloning again. Turn the sync off while you use it:

```bash
UV_NO_SYNC=1 npm run dev           # the desktop dev shell
uv run --no-sync localcut serve    # an engine you start yourself
```

In PowerShell the first one is `$env:UV_NO_SYNC = "1"; npm run dev`.

`uv sync` goes further and uninstalls chatterbox-tts, because the lockfile
doesn't list it. That includes the `uv sync --all-groups` from the setup
steps, so install it again after one. `uv run pytest` re-syncs too.

### Checking it

`GET /voices` answers `"cloning": true` only once chatterbox has imported
inside the engine. When it is false, `cloning_reason` says why: the package
is missing, the backend chain has no `chatterbox`, or the import failed, in
which case the reason quotes the error. The desktop's inspector shows the same
text where the clone control would be. The engine tries the import once per run
(it loads PyTorch), so restart the engine after you fix the environment.
