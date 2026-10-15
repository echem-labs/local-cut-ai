"""Which pinned build of a program this machine gets.

Most programs pin one build per platform. ComfyUI pins one per GPU vendor
on Windows, because its portable builds each carry the PyTorch for one
vendor's cards and for NVIDIA two: the usual build, on the newest CUDA and
one for older drivers and older cards. The hardware probe says which vendor
the machine's main card is from and for NVIDIA which driver it runs and
which compute capability it has, so the choice is made here rather than by
the user. A user whose setup failed on the usual build can ask for one of
the others by name (BUILDS) and only for one pinned for this machine's
vendor: a client still cannot name a download.
"""

from __future__ import annotations

from ..hardware.probe import GPU
from .manifest import ProgramAsset, ProgramPin


def version_tuple(version: str) -> tuple[int, ...]:
    """A dotted version as numbers, for comparing: "581.57" > "580"."""
    return tuple(int(part) for part in version.split(".") if part.isdigit())


def meets(asset: ProgramAsset, gpu: GPU | None) -> bool:
    """Whether the card meets what the build says it needs. A figure the
    probe could not read counts as met: the setup's check is what finds a
    build that cannot use the card."""
    needs = asset.requires
    if needs is None or gpu is None:
        return True
    if needs.nvidia_driver and gpu.driver_version:
        if version_tuple(gpu.driver_version) < version_tuple(needs.nvidia_driver):
            return False
    if needs.compute_capability and gpu.compute_capability:
        if version_tuple(gpu.compute_capability) < version_tuple(needs.compute_capability):
            return False
    return True


def vendor_of(gpu: GPU | None) -> str | None:
    return gpu.vendor if gpu is not None else None


def choose(
    pin: ProgramPin, platform_key: str, gpu: GPU | None, build: str | None = None
) -> ProgramAsset | None:
    """The build this machine gets, or None when none is pinned for it.

    Where the builds are per vendor, the machine's main card decides and a
    machine with no card from a pinned vendor gets none. Of a vendor's
    builds the usual one wins unless the card falls short of what it needs
    and another's needs are met. `build` asks for one of the vendor's other
    builds by name instead."""
    if not pin.per_vendor(platform_key):
        return pin.asset_for(platform_key, None, build)
    vendor = vendor_of(gpu)
    if vendor is None:
        return None
    builds = pin.builds_for(platform_key, vendor)
    if build is not None:
        return next((asset for asset in builds if asset.build == build), None)
    if not builds:
        return None
    return next((asset for asset in builds if meets(asset, gpu)), builds[0])


def others(pin: ProgramPin, platform_key: str, chosen: ProgramAsset) -> list[ProgramAsset]:
    """The builds a user could pick instead of `chosen` on this machine: the
    rest of the same vendor's."""
    return [
        asset
        for asset in pin.builds_for(platform_key, chosen.gpu)
        if asset.gpu is not None and asset.build != chosen.build
    ]
