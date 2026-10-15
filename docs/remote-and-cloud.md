# Remote engine and cloud models

## Running the engine on another machine

The engine is a server the desktop app happens to launch, so it can just as
well run headless on a GPU box while a laptop drives it.

```bash
localcut serve --host 0.0.0.0 --token "$(openssl rand -base64 32)"
```

Or with Docker — engine plus Ollama, see `deploy/docker-compose.yml`:

```bash
LOCALCUT_TOKEN="$(openssl rand -base64 32)" \
  LOCALCUT_ADVERTISE=gpu-box.local \
  docker compose -f deploy/docker-compose.yml up -d
```

Both containers get the NVIDIA GPU, so the box needs the NVIDIA Container
Toolkit. The engine renders nothing on it. It reads the card to pick the
script model and what the first-run screen recommends, the way it does on a
desktop: `qwen3:8b` on an 8 GB card, `qwen3:14b` from 10 GB. To use one
model whatever the card, set `LOCALCUT_LLM_MODEL` in the shell you run
`docker compose up` from, and pull that model into the Ollama container.

`LOCALCUT_ADVERTISE` (or `serve --advertise`) is the address the pairing code
tells the laptop to dial. Set it wherever that is not the address the engine
binds: in a container the engine's own outbound address is the Docker bridge
network, which reaches nothing from outside. It also covers a reverse proxy or
a tailnet name, and may carry its own port (`engine.example.com:443`). Left
unset outside a container, the engine works it out from the machine's outbound
interface.

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
