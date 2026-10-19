"""Stands in for ComfyUI's server in the tests: the routes the engine's
adapter uses (/system_stats, /queue, /prompt, /ws, /history/{id}, /view and
/upload/image) on --port, keeping its files in the folders ComfyUI 0.40.0
takes on its command line. --output-directory and --input-directory are the
folders themselves and --temp-directory is the folder `temp` goes in; any
that is not given is under --base-directory, as ComfyUI keeps them.

A prompt runs the moment it is queued. Every node with a `filename_prefix`
writes one file the way ComfyUI's save nodes do: the prefix's folder under
the output folder, named `<prefix's last part>_00001_.<ext>`, with the
counter one past the highest already there. A prompt the same as one run
before is answered from the cache, as ComfyUI answers it: its history names
the files the first one wrote and nothing is written. A LoadImage node needs
its image in the input folder, or the prompt is refused the way ComfyUI
refuses it. An upload lands in the input folder, under the subfolder it
names.

FAKE_COMFYUI, a JSON object in the environment, changes what it says:

- "report": the entries its history lists for a prompt, each a
  {"filename", "subfolder", "type"} as ComfyUI reports a file, in place of
  the files it wrote. /view then serves a few bytes for any name, the way a
  server that is not ComfyUI might;
- "upload": the reply to an upload, in place of where it put the image;
- "hold_s": how long a prompt takes to finish after it has written its
  files, the way a render is still running when its save node is done.

It runs with the Python running the tests, so it has the engine's own
packages: Starlette and uvicorn.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import uuid
from email.parser import BytesParser
from email.policy import HTTP
from pathlib import Path

import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route, WebSocketRoute
from starlette.websockets import WebSocket, WebSocketDisconnect

# A 1x1 PNG, so a keyframe it renders is an image.
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c6360f8cfc00000030101009a2e5ecc"
    "0000000049454e44ae426082"
)
_EXTENSIONS = {"SaveImage": ".png", "SaveVideo": ".mp4", "SaveAudio": ".flac"}


def _argument(name: str) -> str | None:
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else None


def main() -> None:
    port = int(_argument("--port") or 8188)
    base = Path(_argument("--base-directory") or Path.cwd()).resolve()
    output = Path(_argument("--output-directory") or base / "output").resolve()
    inputs = Path(_argument("--input-directory") or base / "input").resolve()
    temp = Path(_argument("--temp-directory") or base).resolve() / "temp"
    for folder in (output, inputs, temp):
        folder.mkdir(parents=True, exist_ok=True)
    behaviour = json.loads(os.environ.get("FAKE_COMFYUI") or "{}")
    folders = {"output": output, "input": inputs, "temp": temp}
    history: dict[str, dict] = {}
    cache: dict[str, dict] = {}
    sockets: dict[str, WebSocket] = {}
    tasks: set[asyncio.Task] = set()

    def save(prefix: str, extension: str) -> dict:
        prefix = os.path.normpath(prefix)
        subfolder, name = os.path.dirname(prefix), os.path.basename(prefix)
        folder = (output / subfolder).resolve()
        if folder != output and output not in folder.parents:
            raise ValueError("Saving image outside the output folder is not allowed.")
        folder.mkdir(parents=True, exist_ok=True)
        pattern = re.compile(re.escape(name) + r"_(\d{5})_")
        taken = [int(m.group(1)) for f in os.listdir(folder) if (m := pattern.match(f))]
        filename = f"{name}_{max(taken, default=0) + 1:05}_{extension}"
        (folder / filename).write_bytes(PNG)
        return {"filename": filename, "subfolder": subfolder, "type": "output"}

    async def system_stats(request: Request) -> Response:
        system = {"comfyui_version": "0.40.0", "argv": sys.argv}
        return JSONResponse({"system": system, "devices": []})

    async def queue(request: Request) -> Response:
        return JSONResponse({"queue_running": [], "queue_pending": []})

    async def prompt(request: Request) -> Response:
        body = await request.json()
        workflow, client = body["prompt"], body.get("client_id")
        for node_id, node in workflow.items():
            image = node.get("inputs", {}).get("image")
            if node.get("class_type") == "LoadImage" and not (inputs / image).is_file():
                error = {"type": "prompt_outputs_failed_validation", "node": node_id}
                return JSONResponse({"error": error, "node_errors": {}}, status_code=400)
        prompt_id = uuid.uuid4().hex
        outputs: dict[str, dict] = {}
        for node_id, node in workflow.items():
            prefix = node.get("inputs", {}).get("filename_prefix")
            if isinstance(prefix, str):
                signature = json.dumps([node_id, workflow], sort_keys=True)
                if signature not in cache:
                    saved = save(prefix, _EXTENSIONS.get(node.get("class_type"), ".png"))
                    key = "audio" if node.get("class_type") == "SaveAudio" else "images"
                    cache[signature] = {key: [saved]}
                outputs[node_id] = cache[signature]
        if "report" in behaviour:
            outputs = {"save": {"images": behaviour["report"]}}
        history[prompt_id] = {"outputs": outputs, "status": {"completed": True}}
        socket = sockets.get(client)
        if socket is not None:
            done = {"type": "executing", "data": {"node": None, "prompt_id": prompt_id}}

            async def finish() -> None:
                await asyncio.sleep(float(behaviour.get("hold_s", 0)))
                await socket.send_text(json.dumps(done))

            tasks.add(asyncio.create_task(finish()))
        return JSONResponse({"prompt_id": prompt_id, "number": len(history), "node_errors": {}})

    async def prompt_history(request: Request) -> Response:
        prompt_id = request.path_params["prompt_id"]
        return JSONResponse({prompt_id: history[prompt_id]} if prompt_id in history else {})

    async def view(request: Request) -> Response:
        if "report" in behaviour:
            return Response(PNG, media_type="image/png")
        query = request.query_params
        root = folders.get(query.get("type", "output"))
        if root is None:
            return Response(status_code=400)
        path = (root / query.get("subfolder", "") / query["filename"]).resolve()
        if root not in path.parents or not path.is_file():
            return Response(status_code=404)
        return Response(path.read_bytes(), media_type="application/octet-stream")

    async def upload(request: Request) -> Response:
        header = f"Content-Type: {request.headers['content-type']}\r\n\r\n".encode()
        form = BytesParser(policy=HTTP).parsebytes(header + await request.body())
        fields = {
            part.get_param("name", header="content-disposition"): part for part in form.iter_parts()
        }
        image = fields["image"]
        subfolder = fields["subfolder"].get_content() if "subfolder" in fields else ""
        folder = (inputs / os.path.normpath(subfolder)).resolve()
        if folder != inputs and inputs not in folder.parents:
            return Response(status_code=400)
        folder.mkdir(parents=True, exist_ok=True)
        (folder / image.get_filename()).write_bytes(image.get_payload(decode=True))
        reply = {"name": image.get_filename(), "subfolder": subfolder, "type": "input"}
        return JSONResponse(behaviour.get("upload", reply))

    async def events(socket: WebSocket) -> None:
        await socket.accept()
        client = socket.query_params.get("clientId", "")
        sockets[client] = socket
        try:
            while True:
                await socket.receive_text()
        except WebSocketDisconnect:
            sockets.pop(client, None)

    app = Starlette(
        routes=[
            Route("/system_stats", system_stats),
            Route("/queue", queue, methods=["GET", "POST"]),
            Route("/prompt", prompt, methods=["POST"]),
            Route("/history/{prompt_id}", prompt_history),
            Route("/view", view),
            Route("/upload/image", upload, methods=["POST"]),
            WebSocketRoute("/ws", events),
        ]
    )
    print("listening", flush=True)
    asyncio.run(uvicorn.Server(uvicorn.Config(app, port=port, log_level="warning")).serve())


if __name__ == "__main__":
    main()
