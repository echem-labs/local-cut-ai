"""Which pinned build of a program this machine gets.

Most programs pin one build per platform. ComfyUI pins one per GPU vendor,
because each build carries the PyTorch for one vendor's cards and for
NVIDIA two: the usual build, on the newest CUDA and one for older drivers
and older cards. On Linux it also pins a build that runs on the processor,
which is what a machine with no card from those vendors gets. The hardware
probe says which vendor the machine's main card is from and for NVIDIA
which driver it runs and which compute capability it has, so the choice is
made here rather than by the user. A user whose setup failed on the usual
build can ask for one of the others by name (BUILDS) and only for one
pinned for this machine's vendor, or the processor's build where there is
one: a client still cannot name a download.
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

    Where the builds are per vendor, the machine's main card decides. Of a
    vendor's builds the usual one wins unless the card falls short of what
    it needs and another's needs are met. A machine with no card from a
    pinned vendor gets the processor's build where one is pinned and none
    where not. `build` asks for one of the vendor's other builds by name
    instead, or for the processor's."""
    if not pin.per_vendor(platform_key):
        return pin.asset_for(platform_key, None, build)
    vendor = vendor_of(gpu)
    builds = pin.builds_for(platform_key, vendor) if vendor is not None else []
    processor = pin.asset_for(platform_key, None, "cpu")
    if build is not None:
        return next(
            (asset for asset in [*builds, processor] if asset and asset.build == build), None
        )
    if not builds:
        return processor
    return next((asset for asset in builds if meets(asset, gpu)), builds[0])


def others(pin: ProgramPin, platform_key: str, chosen: ProgramAsset) -> list[ProgramAsset]:
    """The builds a user could pick instead of `chosen` on this machine: the
    rest of the same vendor's, then the processor's where one is pinned. A
    machine on the processor's build is offered none: it has no card a
    vendor's build is for, or one those builds could not use."""
    if chosen.gpu is None:
        return []
    processor = pin.asset_for(platform_key, None, "cpu")
    return [
        asset for asset in pin.builds_for(platform_key, chosen.gpu) if asset.build != chosen.build
    ] + ([processor] if processor is not None else [])
