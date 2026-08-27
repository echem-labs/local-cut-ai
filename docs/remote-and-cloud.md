# Remote engine and cloud models

## Running the engine on another machine

The engine is a server the desktop app happens to launch, so it can just as
well run headless on a GPU box while a laptop drives it.

```bash
localcut serve --host 0.0.0.0 --token "$(openssl rand -base64 32)"
```

Or with Docker — engine plus Ollama, see `deploy/docker-compose.yml`:

```bash
LOCALCUT_TOKEN="$(openssl rand -base64 32)" docker compose -f deploy/docker-compose.yml up -d
```

A network bind serves HTTPS with a self-signed certificate and prints a
pairing block: URL, certificate fingerprint, and a one-line pairing code.
Paste the code into **Settings → Remote engine** on the laptop. The frontend
pins that exact certificate — fingerprint match, both in Chromium and in the
shell's own requests — and sends the token as bearer auth.

Projects, models and renders all live with the engine. The laptop is a remote
control: close it mid-batch and the box keeps rendering.

`--no-tls` exists for VPN and tailnet links that already encrypt the path. For
anything reachable from the internet, prefer a tailnet over port forwarding.

## Cloud models (BYOK)

Nodes whose `model` is `cloud:*` route to provider adapters instead of the
local chain.

| Kind | Models |
| --- | --- |
| Scripts | `cloud:claude-*` (Anthropic), `cloud:gpt-*` (OpenAI), `cloud:gemini-*` (Google) |
| Clips | `cloud:kling-2.5`, `cloud:veo-3.1-fast`, `cloud:wan-2.2-cloud` (via fal.ai) |

Keys come from `LOCALCUT_ANTHROPIC_KEY`, `LOCALCUT_OPENAI_KEY`,
`LOCALCUT_GEMINI_KEY` and `LOCALCUT_FAL_KEY`, and are never persisted by the
engine. `GET /providers` reports what is configured.

Cloud is always optional. Nothing in the pipeline requires it.
