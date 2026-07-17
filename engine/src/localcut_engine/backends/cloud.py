"""Cloud execution backend — serves any node whose model is `cloud:*`,
regardless of the local backend chain. BYOK adapters make the calls
directly from this machine; nothing is proxied.
"""

from __future__ import annotations

from pathlib import Path

from ..config import EngineConfig
from ..graph.compiler import JobSpec
from ..graph.model import KEYFRAME_PORT, NodeKind
from ..providers.registry import textgen_for_model, videogen_for_model
from ..providers.textgen import ProviderError
from .base import ExecutionBackend, ExecutionContext, GenerationError
from .llm import _SYSTEM_PROMPT, LLMScriptBackend


class CloudBackend(ExecutionBackend):
    name = "cloud"

    def __init__(self, config: EngineConfig) -> None:
        self.config = config

    def supports(self, kind: NodeKind) -> bool:
        return kind in (NodeKind.SCRIPT, NodeKind.CLIP)

    async def execute(self, spec: JobSpec, ctx: ExecutionContext) -> Path:
        try:
            match spec.kind:
                case NodeKind.SCRIPT:
                    return await self._script(spec, ctx)
                case NodeKind.CLIP:
                    return await self._clip(spec, ctx)
        except ProviderError as exc:
            raise GenerationError(str(exc)) from exc
        raise GenerationError(f"cloud backend cannot handle {spec.kind}")

    async def _script(self, spec: JobSpec, ctx: ExecutionContext) -> Path:
        textgen = textgen_for_model(self.config, spec.model or "")
        prompt = (
            f"Topic: {spec.params.get('prompt', '')}\n"
            f"Target duration: {spec.params.get('target_duration_s', 60)}s\n"
            f"Aspect: {spec.params.get('aspect', '9:16')}\n"
            f"Style preset: {spec.params.get('style_preset', 'cinematic')}"
        )
        raw = await textgen.complete(system=_SYSTEM_PROMPT, prompt=prompt)
        await ctx.progress(0.9)
        screenplay = LLMScriptBackend._parse_screenplay(raw)
        out = ctx.output_path(spec.output_hash, ".screenplay.json")
        out.write_text(screenplay.model_dump_json(indent=2))
        return out

    async def _clip(self, spec: JobSpec, ctx: ExecutionContext) -> Path:
        videogen = videogen_for_model(self.config, spec.model or "")
        prompt = f"{spec.params.get('prompt', '')}, {spec.params.get('motion', '')}".strip(", ")
        duration_s = float(spec.params.get("duration_s", 5))
        keyframe = ctx.input_artifacts.get(KEYFRAME_PORT)
        data = await videogen.generate(
            prompt, duration_s, image_path=str(keyframe) if keyframe else None
        )
        out = ctx.output_path(spec.output_hash, ".mp4")
        out.write_bytes(data)
        await ctx.progress(1.0)
        return out
