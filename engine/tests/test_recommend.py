"""What the model slate tells a user their machine can do.

This is the first thing a new user sees, and until now it had one answer for
every machine it did not recognise: "no local model fits this hardware".
Two separate problems hid behind that sentence — a GPU runtime nothing
supports, and a card that is simply too small — and the first of those was
being reported for every AMD and Intel GPU while the same screen showed the
card's name and its hardware tier.
"""

from localcut_engine.hardware.probe import GPU, HardwareProfile, Tier
from localcut_engine.manifest.loader import load_manifest
from localcut_engine.manifest.model import ModelManifest
from localcut_engine.manifest.recommend import TASKS, recommend_slate
from localcut_engine.config import EngineConfig


def _manifest() -> ModelManifest:
    return load_manifest(EngineConfig())


def _profile(
    *, vendor: str | None = "nvidia", backend: str = "cuda", vram: float = 24.0
) -> HardwareProfile:
    gpu = (
        GPU(vendor=vendor, name=f"test {vendor}", vram_gb=vram, backend=backend) if vendor else None
    )
    return HardwareProfile(
        os="linux",
        arch="x86_64",
        cpu="test",
        cores=16,
        ram_gb=64.0,
        disk_free_gb=500.0,
        gpus=[gpu] if gpu else [],
        primary_gpu=gpu,
        tier=Tier.C if vram >= 24 else Tier.A,
    )


def _slate(profile: HardwareProfile) -> dict[str, tuple[str | None, str]]:
    return {
        r.task: (r.model.id if r.model else None, r.reason)
        for r in recommend_slate(_manifest(), profile)
    }


def test_a_big_nvidia_card_gets_a_local_model_for_every_task():
    slate = _slate(_profile(backend="cuda", vram=24.0))
    assert set(slate) == set(TASKS)
    unfilled = [task for task, (model, _) in slate.items() if model is None]
    assert unfilled == [], f"tasks with no local model on a 24GB CUDA box: {unfilled}"


def test_an_amd_card_is_no_longer_told_to_use_the_cloud_for_everything():
    """The probe learned to detect Radeons, but no manifest entry declared
    `rocm` — so every AMD machine, at any size, got "no local model fits this
    hardware" for all six tasks while the UI showed it as top tier."""
    slate = _slate(_profile(vendor="amd", backend="rocm", vram=24.0))

    assert slate["image.gen"][0] is not None
    assert slate["video.i2v"][0] is not None
    assert slate["music.gen"][0] is not None


def test_an_intel_gpu_is_told_why_rather_than_just_no():
    """Intel is genuinely unsupported: nothing in the engine calls torch.xpu,
    so claiming otherwise would recommend a model that then fails to run. It
    still must not read as "your 16 GB card is not good enough"."""
    slate = _slate(_profile(vendor="intel", backend="xpu", vram=16.0))

    model, reason = slate["image.gen"]
    assert model is None
    assert "xpu" in reason
    assert "runtime" in reason


def test_a_small_card_is_told_the_size_it_needs():
    """A blocker the user can actually act on, so it must not be phrased like
    the unsupported-runtime one."""
    _, reason = _slate(_profile(backend="cuda", vram=2.0))["video.i2v"]

    assert "VRAM" in reason
    assert "2 GB" in reason
    assert "runtime" not in reason


def test_a_machine_with_no_gpu_says_so():
    _, reason = _slate(_profile(vendor=None))["video.i2v"]
    assert "no GPU detected" in reason


def test_every_task_is_answered_whatever_the_hardware():
    """The slate is a fixed set of rows; a task silently missing would leave a
    blank in First Run rather than an explanation."""
    for profile in (
        _profile(backend="cuda", vram=24.0),
        _profile(vendor="amd", backend="rocm", vram=8.0),
        _profile(vendor="intel", backend="xpu", vram=16.0),
        _profile(vendor=None),
    ):
        assert set(_slate(profile)) == set(TASKS)
        assert all(reason for _, reason in _slate(profile).values())


def test_no_recommendation_is_ever_a_non_commercial_model():
    """The slate is what a new user installs by default; a license they
    cannot ship with must never arrive by default."""
    manifest = _manifest()
    for profile in (_profile(backend="cuda", vram=24.0), _profile(vendor="amd", backend="rocm")):
        for rec in recommend_slate(manifest, profile):
            if rec.model is not None:
                assert rec.model.license.commercial, rec.model.id
