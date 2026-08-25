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

The `chatterbox-tts` package is an optional runtime, like ComfyUI — install it
into the engine environment when its wheels support your Python.
