# Editing a project

Every edit — from the canvas, the inspector, an LLM instruction or an agent —
compiles to the same validated patch ops. Only the dirty subgraph re-renders.

## Prompt-based editing

```
POST /projects/{id}/edit
```

Takes a natural-language instruction at project or scene scope: *"make scene 2
darker"*, *"crossfade everything"*, *"remove scene 3"*.

The LLM sees a whitelisted view of the graph and returns a constrained edit
plan, which the engine compiles into the same patch ops the inspector uses.

Edits run on the local script LLM by default. Pass `model: "cloud:…"` to opt a
single edit into a BYOK provider.

## Using your own image

```
POST /projects/{id}/assets
```

Imports an image as a graph node — raw bytes over the API, no filesystem
shortcuts. Wire it into a clip's keyframe port with a `connect` patch op and
the clip animates from your image instead of the generated keyframe.

The conditioning survives script re-runs, and the inspector's "Use my image"
picker does the same thing from the UI.

One thing worth knowing: a clip prompt that names something the keyframe does
not contain will make the video model drift toward it. Keep the prompt
faithful to the image you supplied.

## Re-cutting without re-rendering

The timeline node's `order`, `trims` and `transitions` params change the cut
without touching any scene render. See
[running-real-models.md](running-real-models.md) for the full parameter list.
