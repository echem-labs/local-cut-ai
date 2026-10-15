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
engine's lockfile, because it brings PyTorch and its own transformers with it
and most installs never clone a voice. `engine/clone-requirements.txt` lists
what it needs:

```
chatterbox-tts
setuptools<81
```

Don't drop the setuptools pin. Chatterbox watermarks everything it generates
with resemble-perth, which imports `pkg_resources`, and setuptools stopped
shipping that module in 82 (81 still has it, behind a warning that recommends
`<81`). perth hides its failed import, so without the pin the package installs
and imports, and then every clone fails to load its model with
`TypeError: 'NoneType' object is not callable`.

On Windows, the torch you get from PyPI is CPU-only. Cloning works on it, but
slowly: one narration line took 17 minutes on a test machine. Using a GPU there
means a CUDA build of torch from PyTorch's own package index, which these steps
don't set up. On Linux the PyPI build is the CUDA one.

### In a dev checkout

Don't install it into the engine's `.venv`. Let uv layer it on top instead, from
`engine/`:

```bash
uv run --with-requirements clone-requirements.txt localcut serve
```

uv resolves the file on its own, builds a separate environment from it on
top of `.venv`, caches that environment and reuses it on later runs. Packages in
the layer win over the same packages in `.venv`, so this engine sees the older
tokenizers and setuptools chatterbox needs while `.venv` keeps the locked ones.
With chatterbox-tts 0.1.7 the layer also brings starlette 0.52.1 in place of
the locked 1.x, because gradio, which chatterbox depends on, wants starlette
below 1.0. `uv sync`, `uv run pytest` and a pull that changes `uv.lock` leave
cloning alone.

The desktop dev shell runs that command when you ask for it:

```bash
LOCALCUT_DEV_CLONE=1 npm run dev     # from apps/desktop
```

In PowerShell that is `$env:LOCALCUT_DEV_CLONE = "1"; npm run dev`.

The first run downloads PyTorch and the rest (the layer is about 6 GB on
Linux, most of it CUDA libraries), and the dev shell gives the engine 30
seconds to come up. Build the layer once from a terminal before the first
`npm run dev` with it, so the app doesn't give up on an engine that is still
downloading:

```bash
uv run --with-requirements clone-requirements.txt python -c "import chatterbox.tts"
```

Installing into `.venv` with `uv pip install -r clone-requirements.txt` works
until the next `uv run`, which syncs `.venv` to `uv.lock` before it runs
anything. That sync leaves alone the packages the lock doesn't list (so
`--inexact` adds nothing), but it puts back the locked version of every
package the lock does list: tokenizers 0.23.1 and setuptools 83 return and the
import fails. `UV_NO_SYNC=1` or `uv run --no-sync` keeps the install, but then
`.venv` stops following the lockfile, and the next `uv sync` uninstalls
chatterbox-tts outright.

### In an environment you manage

For an engine installed into an environment no `uv run` touches, install the
same file into it, e.g. `uv pip install -r engine/clone-requirements.txt` with
that environment active.

### Checking it

`GET /voices` answers `"cloning": true` only once chatterbox has imported
inside the engine. When it is false, `cloning_reason` says why: the package
is missing, the backend chain has no `chatterbox`, or the import failed, in
which case the reason quotes the error. The desktop's inspector shows the same
text where the clone control would be. The engine tries the import once per run
(it loads PyTorch), so restart the engine after you fix the environment.

A project whose narration is already cloned gets the same sentence from its
readiness report, as a `will_fail` narration row with the reason
`clone_unavailable` and the text in `data.cloning_reason`. The board's banner
and the check before a render show it, so a broken environment is caught
before the render rather than by every narration failing in it.

The engine inside the installed app can never clone. It is a frozen build that
loads only what it was built with, and chatterbox-tts isn't part of it, so
there is nothing to install into. It says so in `cloning_reason`. To clone a
voice, run the engine from a source checkout as described above.
