"""Hardware probe → capability tier. Runs on first start;
recommendations = manifest matched against this profile. Multi-GPU:
primary = largest-VRAM CUDA device, user-overridable.
"""

from __future__ import annotations

import platform
import shutil
import subprocess
from enum import StrEnum

import psutil
from pydantic import BaseModel


class Tier(StrEnum):
    S = "S"  # cloud-assist: <8 GB VRAM or no GPU
    A = "A"  # entry: 8-12 GB
    B = "B"  # sweet spot: 16 GB
    C = "C"  # enthusiast: 24 GB+


class GPU(BaseModel):
    vendor: str
    name: str
    vram_gb: float
    backend: str  # cuda | mps | rocm | none


class HardwareProfile(BaseModel):
    os: str
    arch: str
    ram_gb: float
    disk_free_gb: float
    gpus: list[GPU]
    primary_gpu: GPU | None
    tier: Tier


def _detect_nvidia() -> list[GPU]:
    if shutil.which("nvidia-smi") is None:
        return []
    try:
        output = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        ).stdout
    except (subprocess.SubprocessError, OSError):
        return []
    gpus = []
    for line in output.strip().splitlines():
        name, _, mem = line.rpartition(",")
        try:
            vram_gb = round(float(mem.strip()) / 1024, 1)
        except ValueError:
            continue
        gpus.append(GPU(vendor="nvidia", name=name.strip(), vram_gb=vram_gb, backend="cuda"))
    return gpus


def _detect_apple() -> list[GPU]:
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        return []
    # Unified memory: usable "VRAM" ≈ ~70% of system RAM.
    ram_gb = psutil.virtual_memory().total / 2**30
    return [
        GPU(
            vendor="apple",
            name=f"Apple Silicon ({platform.processor() or 'arm64'})",
            vram_gb=round(ram_gb * 0.7, 1),
            backend="mps",
        )
    ]


def _tier_for(vram_gb: float) -> Tier:
    if vram_gb >= 24:
        return Tier.C
    if vram_gb >= 14:
        return Tier.B
    if vram_gb >= 8:
        return Tier.A
    return Tier.S


def probe_hardware(disk_path: str = "/") -> HardwareProfile:
    gpus = _detect_nvidia() or _detect_apple()
    primary = max(gpus, key=lambda g: g.vram_gb) if gpus else None
    return HardwareProfile(
        os=platform.system().lower(),
        arch=platform.machine(),
        ram_gb=round(psutil.virtual_memory().total / 2**30, 1),
        disk_free_gb=round(psutil.disk_usage(disk_path).free / 2**30, 1),
        gpus=gpus,
        primary_gpu=primary,
        tier=_tier_for(primary.vram_gb) if primary else Tier.S,
    )
