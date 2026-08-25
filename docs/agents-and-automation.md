# Driving the engine from a script or an agent

Both surfaces below are *clients* of a running engine, not a second way into
its data. Start the engine first (`localcut serve`) and point them at it.

Every topology works the same way: the engine the desktop app spawned on this
machine, a GPU box across the room over pinned TLS, or a container in CI —
none of them is a special case, they are all a URL and a token.

## Automation CLI

```bash
localcut projects                       # list projects on the engine
localcut create "a 60s explainer on…"   # create a project from a prompt
localcut render <project-id>            # render and wait for it to finish
localcut export <id> --out cut.mp4      # write a finished cut or an NLE handoff
localcut template export|import         # move a project shape between engines
localcut workflow import|list|remove    # manage imported ComfyUI workflows
localcut packs list|enable|disable      # ComfyUI custom-node packs this engine allows
```

Each takes `--engine` (`$LOCALCUT_ENGINE_URL`, default
`http://127.0.0.1:7830`), `--token` (`$LOCALCUT_TOKEN`) and `--cert`, the PEM
of a remote engine's self-signed certificate. `--cert` is a flag only — there
is no environment variable for it. `localcut mcp` takes the same three, so an
agent reaches a GPU box across the room exactly the way a script does.

Output serves two audiences at once: a human sees lines, `--json` emits the
raw document.

**Exit status is the contract**: `0` succeeded, `1` the operation failed, `2`
the engine could not be reached. Nothing else returns `0`, so a script can
branch on it without parsing anything.

## MCP agents

`localcut mcp` serves a running engine to MCP hosts — Claude, goose, IDE
agents — over stdio.

What an agent can do: create, render, check status, export; approve
checkpoints for beginner-mode projects; run the prompt-based editor in
propose-then-act form (edits preview by default and land via a second tool
that requires the previewed scope and revision back); raw patch ops; undo and
redo.

Edits compile into the same validated patch ops as everyone else's, so the
cycle check and the voice-consent gate hold for an agent exactly as they do
for the canvas.

### What is deliberately out of reach

- **Enabling ComfyUI node packs.** That is an acknowledgment that third-party
  code will execute, which is an operator's decision, not a model's.
- **Provider keys.**
- **BYOK cloud spend.** Patch ops naming a `cloud:*` model are refused, as is
  restoring a take that was rendered on one. The rule sits at the write rather
  than on a list of routes: a cloud model the agent puts on a node that did
  not carry one is refused whether or not a render is planned for it. That
  second half is what covers `select_take` — switching back to a take is a
  cache hit, so it reaches no queue and would bill nothing today, but it
  leaves the node on a cloud model for the next render the *user* starts.
- **Writing outside one directory.** Exports are confined to `--export-dir`
  (`$LOCALCUT_MCP_EXPORT_DIR`, default `~/LocalCut`), because `out_path` is a
  model-authored string and an unconfined one is an arbitrary file write.

### Host config for a dev checkout

Use an absolute `--project` path: an MCP host launches the server from an
arbitrary working directory.

```json
{
  "mcpServers": {
    "localcut": {
      "command": "uv",
      "args": ["run", "--project", "/path/to/local-cut-ai/engine", "localcut", "mcp"],
      "env": { "LOCALCUT_TOKEN": "<the token the engine printed>" }
    }
  }
}
```
