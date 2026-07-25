"""Hardware probe → capability tier. Runs on first start;
recommendations = manifest matched against this profile. Multi-GPU:
primary = largest-VRAM CUDA device, user-overridable.
"""

from __future__ import annotations

import json
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
    vendor: str  # nvidia | apple | amd | intel
    name: str
    vram_gb: float
    # The compute backend this card runs on. Every value here is produced by
    # one of the _detect_* probes below — an unproduced value would tier real
    # hardware as "no GPU" and recommend cloud for every task.
    backend: str  # cuda | mps | rocm | xpu


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


def _detect_amd() -> list[GPU]:
    """AMD via rocm-smi. Reported as backend "rocm", which the GPU model has
    always listed but nothing produced — so every Radeon read as "no GPU",
    tiered the machine to S, and recommended cloud for every task on hardware
    that runs the top tier."""
    if shutil.which("rocm-smi") is None:
        return []
    try:
        output = subprocess.run(
            ["rocm-smi", "--showproductname", "--showmeminfo", "vram", "--json"],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        ).stdout
    except (subprocess.SubprocessError, OSError):
        return []
    try:
        payload = json.loads(output)
    except ValueError:
        return []
    gpus = []
    for card, info in sorted(payload.items()):
        if not isinstance(info, dict):
            continue
        name = str(
            info.get("Card Series") or info.get("Card Model") or info.get("Card SKU") or card
        ).strip()
        total = next(
            (v for k, v in info.items() if "vram" in k.lower() and "total" in k.lower()),
            None,
        )
        try:
            vram_gb = round(int(str(total).strip()) / 2**30, 1)
        except (TypeError, ValueError):
            continue
        if vram_gb > 0:
            gpus.append(GPU(vendor="amd", name=name, vram_gb=vram_gb, backend="rocm"))
    return gpus


def _detect_intel() -> list[GPU]:
    """Intel Arc / Xe via xpu-smi. Same rationale as _detect_amd; the backend
    value matches PyTorch's device string for these parts."""
    if shutil.which("xpu-smi") is None:
        return []
    try:
        output = subprocess.run(
            ["xpu-smi", "discovery", "-j"],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        ).stdout
    except (subprocess.SubprocessError, OSError):
        return []
    try:
        payload = json.loads(output)
    except ValueError:
        return []
    devices = payload.get("device_list", payload) if isinstance(payload, dict) else payload
    if not isinstance(devices, list):
        return []
    gpus = []
    for device in devices:
        if not isinstance(device, dict):
            continue
        name = str(device.get("device_name", "Intel GPU")).strip()
        raw = device.get("memory_physical_size_byte") or device.get("memory_physical_size")
        try:
            vram_gb = round(float(raw) / 2**30, 1)
        except (TypeError, ValueError):
            continue
        if vram_gb > 0:
            gpus.append(GPU(vendor="intel", name=name, vram_gb=vram_gb, backend="xpu"))
    return gpus


def _tier_for(vram_gb: float) -> Tier:
    if vram_gb >= 24:
        return Tier.C
    if vram_gb >= 14:
        return Tier.B
    if vram_gb >= 8:
        return Tier.A
    return Tier.S


def probe_hardware(disk_path: str = "/") -> HardwareProfile:
    # NVIDIA first (the best-supported path), then Apple, then AMD and Intel.
    # All four are tried rather than stopping at the first hit: a box can
    # have a discrete card alongside an integrated one, and the primary is
    # picked by VRAM below.
    gpus = _detect_nvidia() or _detect_apple() or _detect_amd() or _detect_intel()
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
