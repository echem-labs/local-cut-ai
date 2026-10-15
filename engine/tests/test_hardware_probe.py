"""The hardware probe's view of the card a build has to run on: which
driver an NVIDIA card runs and which compute capability it has and on
Windows the AMD and Intel cards no vendor tool reports. Setting ComfyUI up
picks its build from these (programs/builds.py)."""

from __future__ import annotations

import contextlib
import platform
import subprocess
import sys

from localcut_engine.hardware import probe


def test_nvidia_smi_says_which_driver_and_which_card(monkeypatch):
    """The driver and the compute capability come from the same query as the
    name and the memory. A driver too old to know `compute_cap` refuses the
    whole query and is asked again without it rather than going unseen."""
    asked: list[str] = []

    def run(argv, **kwargs):  # noqa: ANN001, ANN003 - subprocess.run's
        query = argv[1]
        asked.append(query)
        if "compute_cap" in query and len(asked) == 1:
            raise subprocess.CalledProcessError(2, argv, 'Field "compute_cap" is not valid')
        if "compute_cap" in query:
            out = "NVIDIA GeForce RTX 3080 Laptop GPU, 8192, 595.91.07, 8.6\n"
        else:
            out = "Quadro K2200, 4096, 471.41\n"
        return subprocess.CompletedProcess(argv, 0, out, "")

    monkeypatch.setattr(probe.shutil, "which", lambda name: name)
    monkeypatch.setattr(probe.subprocess, "run", run)
    [old] = probe._detect_nvidia()
    assert (old.name, old.vram_gb, old.driver_version, old.compute_capability) == (
        "Quadro K2200",
        4.0,
        "471.41",
        None,
    )
    assert asked == [
        "--query-gpu=name,memory.total,driver_version,compute_cap",
        "--query-gpu=name,memory.total,driver_version",
    ]
    [new] = probe._detect_nvidia()
    assert (new.driver_version, new.compute_capability) == ("595.91.07", "8.6")
    cards = probe._nvidia_cards("A, card, 8192, [N/A], [Not Supported]\n", fields=4)
    assert (cards[0].name, cards[0].driver_version, cards[0].compute_capability) == (
        "A, card",
        None,
        None,
    )


class _Registry:
    """The display adapter class key, as winreg reads it."""

    HKEY_LOCAL_MACHINE = object()

    def __init__(self, adapters: dict[str, dict]) -> None:
        self.adapters = adapters

    def OpenKey(self, parent, name):  # noqa: N802, ANN001 - winreg's names
        if parent is self.HKEY_LOCAL_MACHINE:
            assert name == probe._DISPLAY_CLASS
            return contextlib.nullcontext("class")
        if name not in self.adapters:
            raise OSError(name)
        return contextlib.nullcontext(self.adapters[name])

    def EnumKey(self, key, index):  # noqa: N802, ANN001
        names = [*self.adapters, "Properties", "Configuration"]
        if index >= len(names):
            raise OSError("no more")
        return names[index]

    def QueryValueEx(self, key, name):  # noqa: N802, ANN001
        if name not in key:
            raise OSError(name)
        return key[name], 1


def test_windows_cards_with_no_vendor_tool_are_read_from_the_registry(monkeypatch):
    """AMD and Intel ship no rocm-smi or xpu-smi for Windows, so a Radeon or
    an Arc there was no GPU at all and a setup could not pick its build.
    The registry has each adapter's PCI vendor, name and memory; adapters
    from vendors no build is for are left out."""
    registry = _Registry(
        {
            "0000": {
                "MatchingDeviceId": "PCI\\VEN_1002&DEV_744C",
                "DriverDesc": "AMD Radeon RX 7900 XTX",
                "HardwareInformation.qwMemorySize": 24 * 2**30,
            },
            "0001": {
                "MatchingDeviceId": "pci\\ven_8086&dev_56a0",
                "DriverDesc": "Intel(R) Arc(TM) A770 Graphics",
                "HardwareInformation.MemorySize": (16 * 2**30).to_bytes(8, "little"),
            },
            "0002": {
                "MatchingDeviceId": "root\\basicdisplay",
                "DriverDesc": "Microsoft Basic Display Adapter",
            },
        }
    )
    monkeypatch.setattr(platform, "system", lambda: "Windows")
    monkeypatch.setitem(sys.modules, "winreg", registry)
    cards = probe._detect_windows_adapters()
    assert [(c.vendor, c.name, c.vram_gb, c.backend) for c in cards] == [
        ("amd", "AMD Radeon RX 7900 XTX", 24.0, "rocm"),
        ("intel", "Intel(R) Arc(TM) A770 Graphics", 16.0, "xpu"),
    ]
    monkeypatch.setattr(platform, "system", lambda: "Linux")
    assert probe._detect_windows_adapters() == []
