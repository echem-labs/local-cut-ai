"""LocalCut AI engine — the Python orchestrator.

A server the UI happens to launch: story graph store + compiler, job
queue/scheduler, model manager, hardware probe, provider adapters, and
execution backends (headless ComfyUI, llama.cpp, FFmpeg).
"""

__version__ = "0.1.0"

ENGINE_API_VERSION = 1
