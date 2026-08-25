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
- **Per project** — a project can be given a voice, and new narration nodes
  inherit it.

Leave `voice_id` unset and the voice is chosen per node from the style brief.
That is the default and it is not one fixed voice — different briefs resolve
to different speakers.

`/voices` reports `available: false` when narration would not route to Kokoro
at all — a chain pointing narration at Chatterbox or mock cannot honour a
pick, and neither can a machine with no weights yet. It answers in the same
shape as an empty pack, so a client renders its empty state rather than
special-casing an error.

## Cloning a voice (consent-gated)

Audio assets are voice samples, and the upload route refuses them without
`consent=true` — an explicit affirmation that you have the speaker's
permission. That single door is the enforcement point, and every route that
can write a `voice_ref` edge has to re-establish it.

A narration node whose model is `local:chatterbox`, with a sample on its
`voice_ref` port, synthesizes with Chatterbox TTS (MIT, runs locally).

Routing is strict: a clone request never silently falls back to a stock voice.
If Chatterbox cannot serve it, the render fails rather than quietly producing
someone else's voice.

The `chatterbox-tts` package is an optional runtime, like ComfyUI — install it
into the engine environment when its wheels support your Python.
