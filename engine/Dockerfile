# LocalCut engine, headless — the remote-engine topology's server half.
# The engine itself is CPU-side orchestration (graph, queue, TTS, alignment,
# assembly); GPU generation runs in the services it drives — ComfyUI and
# Ollama — which live on the host or in sibling containers (see
# deploy/docker-compose.yml). One engine binary, three homes.
#
# Images and the FFmpeg build are pinned: this container is network-exposed
# and processes untrusted media, so a mutable `latest` tag would be an
# unverified-code supply-chain hole. Bump the pins deliberately.

FROM python:3.14.1-slim

# LGPL-only FFmpeg static build — the licensing policy excludes GPL x264/
# x265, which distro ffmpeg packages compile in. Pinned to a dated release
# and checksum-verified before it is installed.
ARG FFMPEG_URL=https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2025-01-01-12-55/ffmpeg-n7.1-latest-linux64-lgpl-7.1.tar.xz
ADD ${FFMPEG_URL} /tmp/ffmpeg.tar.xz
RUN apt-get update \
    && apt-get install -y --no-install-recommends xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && tar -xf /tmp/ffmpeg.tar.xz -C /tmp \
    && install -m 755 /tmp/ffmpeg-*/bin/ffmpeg /tmp/ffmpeg-*/bin/ffprobe /usr/local/bin/ \
    && rm -rf /tmp/ffmpeg*

COPY --from=ghcr.io/astral-sh/uv:0.9.7 /uv /uvx /usr/local/bin/

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev
COPY src ./src
RUN uv sync --frozen --no-dev

# PyAV arrives as a faster-whisper dependency, and its wheel carries a whole
# FFmpeg build - libx264 and libx265 among it - which would put back into this
# image, in the engine's own process, exactly what the LGPL-only ffmpeg above
# exists to keep out of it. Nothing here calls PyAV: narration is decoded with
# that ffmpeg. faster-whisper still imports it at module scope, so a stub
# answers for the name; `av_stub.py` says why it is a file here and a runtime
# hook in the freeze. The import at the end fails the build rather than the
# first captions job if the stub ever stops being enough.
COPY packaging/av_stub.py ./packaging/
RUN uv pip uninstall av \
    && uv run --no-sync python -c "import pathlib, shutil, site; \
shutil.copy('packaging/av_stub.py', pathlib.Path(site.getsitepackages()[0]) / 'av.py')" \
    && rm -rf packaging \
    && uv run --no-sync python -c "import faster_whisper"

# Run as an unprivileged user: a network-reachable service that shells out to
# ffmpeg and parses untrusted input must never be root. /data is owned by it,
# and a named volume (compose default) inherits that ownership on first use.
# A bind-mounted host directory keeps the host's ownership — chown it to uid
# 10001 (or run `--user`) so the engine can write there.
RUN useradd --system --uid 10001 --home-dir /app localcut \
    && mkdir -p /data \
    && chown -R localcut:localcut /app /data
USER localcut

ENV LOCALCUT_DATA_DIR=/data \
    LOCALCUT_FFMPEG_BIN=/usr/local/bin/ffmpeg
VOLUME /data
EXPOSE 7830

# --token comes from LOCALCUT_TOKEN (compose enforces it); network bind
# serves HTTPS with a self-signed cert pinned by the pairing code.
#
# --no-sync: `uv run` reconciles the environment against the lock before it
# runs anything, and the lock still contains PyAV - it is faster-whisper's
# dependency and dropping it from the lock would drop it for the tests too. A
# plain `uv run` here would reinstall the wheel on every container start,
# putting the GPL FFmpeg build back at runtime and leaving a build that looks
# clean when it is inspected.
ENTRYPOINT ["uv", "run", "--no-sync", "localcut", "serve", "--host", "0.0.0.0"]
