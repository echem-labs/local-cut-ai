"""Hardware probe → capability tier. Runs on first start;
recommendations = manifest matched against this profile. Multi-GPU:
primary = largest-VRAM CUDA device, user-overridable.
"""

from __future__ import annotations

import json
import platform
import shutil
import subprocess
import threading
from enum import StrEnum
from pathlib import Path

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
    # NVIDIA only, as nvidia-smi reports them: the driver ("581.57") and the
    # card's compute capability ("8.6"). A CUDA build of a program names the
    # oldest of each it runs on, so these pick the build a setup downloads
    # (programs/builds.py). None where the probe could not tell.
    driver_version: str | None = None
    compute_capability: str | None = None


class HardwareProfile(BaseModel):
    os: str
    arch: str
    ram_gb: float
    disk_free_gb: float
    gpus: list[GPU]
    primary_gpu: GPU | None
    tier: Tier


# What nvidia-smi is asked, newest first. `compute_cap` is a field only
# drivers from 2021 on know and an older one refuses the whole query over it,
# so that card is asked again without it rather than going unseen.
_NVIDIA_QUERIES = (
    "name,memory.total,driver_version,compute_cap",
    "name,memory.total,driver_version",
)


def _detect_nvidia() -> list[GPU]:
    if shutil.which("nvidia-smi") is None:
        return []
    for query in _NVIDIA_QUERIES:
        try:
            output = subprocess.run(
                ["nvidia-smi", f"--query-gpu={query}", "--format=csv,noheader,nounits"],
                capture_output=True,
                text=True,
                timeout=10,
                check=True,
            ).stdout
        except subprocess.CalledProcessError:
            continue
        except (subprocess.SubprocessError, OSError):
            return []
        return _nvidia_cards(output, fields=query.count(",") + 1)
    return []


def _nvidia_cards(output: str, *, fields: int) -> list[GPU]:
    """The cards in nvidia-smi's CSV answer. Split from the right, because a
    card's name is the one field that could hold a comma."""
    gpus = []
    for line in output.strip().splitlines():
        parts = [part.strip() for part in line.rsplit(",", fields - 1)]
        if len(parts) != fields:
            continue
        name, mem, *rest = parts
        try:
            vram_gb = round(float(mem) / 1024, 1)
        except ValueError:
            continue
        driver = rest[0] if rest and _known(rest[0]) else None
        compute = rest[1] if len(rest) > 1 and _known(rest[1]) else None
        gpus.append(
            GPU(
                vendor="nvidia",
                name=name,
                vram_gb=vram_gb,
                backend="cuda",
                driver_version=driver,
                compute_capability=compute,
            )
        )
    return gpus


def _known(value: str) -> bool:
    """nvidia-smi writes "[N/A]" or "[Not Supported]" for a field it cannot
    read."""
    return bool(value) and not value.startswith("[")


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


# The display adapter class in the Windows registry: one numbered subkey per
# adapter, written by its driver's installer.
_DISPLAY_CLASS = r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}"
# PCI vendor ids, as the subkeys' MatchingDeviceId spells them.
_PCI_VENDORS = {"10de": ("nvidia", "cuda"), "1002": ("amd", "rocm"), "8086": ("intel", "xpu")}


def _detect_windows_adapters() -> list[GPU]:
    """Display adapters from the Windows registry, for the cards the tools
    above miss there: AMD and Intel ship no rocm-smi or xpu-smi for Windows,
    so without this every Radeon and Arc on Windows read as no GPU and a
    setup could not tell which build of a program the card needs. Each
    adapter's driver installer writes its PCI ids, its name and its memory
    under the display class key. Adapters from any other vendor (Microsoft's
    basic display driver, a virtual machine's) are not GPUs anything here
    can use."""
    if platform.system() != "Windows":
        return []
    try:
        import winreg
    except ImportError:
        return []
    gpus = []
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, _DISPLAY_CLASS) as adapters:
            index = 0
            while True:
                try:
                    subkey = winreg.EnumKey(adapters, index)
                except OSError:
                    break
                index += 1
                if not subkey.isdigit():
                    continue
                try:
                    with winreg.OpenKey(adapters, subkey) as adapter:
                        gpu = _windows_adapter(winreg, adapter)
                except OSError:
                    continue
                if gpu is not None:
                    gpus.append(gpu)
    except OSError:
        return []
    return gpus


def _windows_adapter(winreg, adapter) -> GPU | None:  # noqa: ANN001 - the winreg module and a key
    def value(name: str):
        try:
            return winreg.QueryValueEx(adapter, name)[0]
        except OSError:
            return None

    device = str(value("MatchingDeviceId") or "").lower()
    vendor_id = device.partition("ven_")[2][:4]
    if vendor_id not in _PCI_VENDORS:
        return None
    vendor, backend = _PCI_VENDORS[vendor_id]
    # The 64-bit size where the driver writes one; the older 32-bit value
    # stops at 4 GB and some drivers store it as four raw bytes.
    memory = value("HardwareInformation.qwMemorySize")
    if memory is None:
        memory = value("HardwareInformation.MemorySize")
    if isinstance(memory, bytes):
        memory = int.from_bytes(memory[:8], "little")
    try:
        vram_gb = round(int(memory) / 2**30, 1)
    except (TypeError, ValueError):
        vram_gb = 0.0
    name = str(value("DriverDesc") or f"{vendor} GPU").strip()
    return GPU(vendor=vendor, name=name, vram_gb=vram_gb, backend=backend)


# Linux's display adapters: one card<N> per adapter, with its PCI device
# under it, as the kernel's DRM drivers expose them.
_DRM = Path("/sys/class/drm")
# A Radeon with less memory of its own than this is integrated with the
# processor and shares the system's memory; ROCm's PyTorch is for discrete
# cards and the large-memory parts that report tens of gigabytes here.
_MIN_RADEON_VRAM = 4 << 30


def _detect_linux_radeons(root: Path = _DRM) -> list[GPU]:
    """AMD cards from sysfs, for the Linux machines without rocm-smi. Those
    are most of them: ROCm's PyTorch wheels carry the ROCm libraries they
    load, so the kernel's amdgpu driver is all a Radeon needs to run them.
    Without this every Radeon on a stock Ubuntu read as no GPU. amdgpu
    writes the card's own memory in `mem_info_vram_total`."""
    if platform.system() != "Linux":
        return []
    gpus = []
    try:
        cards = sorted(root.glob("card[0-9]*"))
    except OSError:
        return []
    for card in cards:
        # card0-DP-1 and the like are the card's connectors, not cards.
        if "-" in card.name:
            continue
        device = card / "device"
        try:
            if (device / "vendor").read_text().strip().lower() != "0x1002":
                continue
            vram = int((device / "mem_info_vram_total").read_text().strip())
        except (OSError, ValueError):
            continue
        if vram < _MIN_RADEON_VRAM:
            continue
        try:
            name = (device / "product_name").read_text().strip()
        except OSError:
            name = ""
        if not name:
            try:
                name = f"AMD Radeon ({(device / 'device').read_text().strip()})"
            except OSError:
                name = "AMD Radeon"
        gpus.append(GPU(vendor="amd", name=name, vram_gb=round(vram / 2**30, 1), backend="rocm"))
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
    # Vendor precedence, first hit wins: NVIDIA (the best-supported path),
    # then Apple, then AMD, then Intel, then on Windows whatever display
    # adapters the registry lists and on Linux the Radeons sysfs lists. Deliberately NOT a union — each probe
    # shells out to a vendor tool, and a machine with a discrete NVIDIA card
    # alongside an integrated Intel one would otherwise pay for both on every
    # call while the integrated part could never be the primary anyway (the
    # primary is the largest-VRAM device below).
    gpus = (
        _detect_nvidia()
        or _detect_apple()
        or _detect_amd()
        or _detect_intel()
        or _detect_windows_adapters()
        or _detect_linux_radeons()
    )
    primary = max(gpus, key=lambda g: g.vram_gb) if gpus else None
    return HardwareProfile(
        os=platform.system().lower(),
        arch=platform.machine(),
        ram_gb=round(psutil.virtual_memory().total / 2**30, 1),
        disk_free_gb=_disk_free_gb(disk_path),
        gpus=gpus,
        primary_gpu=primary,
        tier=_tier_for(primary.vram_gb) if primary else Tier.S,
    )


def _disk_free_gb(disk_path: str) -> float:
    return round(psutil.disk_usage(disk_path).free / 2**30, 1)


# The probe's answer per disk path, kept for the life of the process. GPUs
# and RAM do not change while the engine runs, and asking shells out to a
# vendor tool that can take seconds under GPU load. Keeping it is also what
# keeps /system's recommendation, which the first-run wizard shows, and what
# Auto means for the script model on the same hardware.
_profiles: dict[str, HardwareProfile] = {}
_profiles_lock = threading.Lock()


def machine_profile(disk_path: str) -> HardwareProfile:
    """This machine: the GPUs, RAM and tier from one `probe_hardware` call
    kept for the life of the process, and the free disk measured now. Free
    disk is the one figure that moves while the engine runs (it falls by
    tens of GB as models download, and the wizard shows it), and measuring
    it costs a statfs, not a vendor tool.

    Blocks for the probe on the first call for a path, so a caller on the
    event loop takes it to a thread. Concurrent first calls wait for the one
    probe rather than each running their own."""
    with _profiles_lock:
        kept = _profiles.get(disk_path)
        if kept is None:
            kept = probe_hardware(disk_path)
        else:
            kept = kept.model_copy(update={"disk_free_gb": _disk_free_gb(disk_path)})
        _profiles[disk_path] = kept
        return kept


def known_profile(disk_path: str) -> HardwareProfile | None:
    """The kept profile, free disk as of the last `machine_profile` call, or
    None when nothing has probed yet. Never probes or measures, so it is
    safe on the event loop."""
    return _profiles.get(disk_path)
