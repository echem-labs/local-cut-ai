"""Which ComfyUI nodes an imported workflow is allowed to use.

Doc 07 risk 9, restated: a ComfyUI custom node is arbitrary Python running
inside the ComfyUI process, which already has the user's models, their disk
and the network. An imported community workflow is therefore a
code-execution vector wearing a JSON hat, and "does this JSON parse" is not
a security control.

So the rule is an allowlist with two tiers:

**Builtins** are stock ComfyUI class_types. Using one is not a supply-chain
decision — the code is whatever ComfyUI itself shipped — so they need no
opt-in. The seed list is in node_packs.json.

**Packs** are third-party. The shipped catalog is a list of packs this build
knows how to describe; it grants nothing. A pack becomes usable only when the
operator enables it, and enabling requires two things risk 9 asks for
literally: an acknowledgement that they are allowing third-party code to run,
and a **version**. The version is not one we guessed — it is the one they
have on disk, supplied at enable time and recorded. A pin to a version the
engine invented would be a pin to nothing.

Enablement is per-engine state under the data dir, not per-project: the packs
live in one ComfyUI install, so the grant belongs to the machine that runs it.
"""

from __future__ import annotations

import importlib.resources
import json
import re
import threading
from pathlib import Path

from pydantic import BaseModel, Field

# A ComfyUI class_type as it appears in a workflow. Deliberately permissive
# about spaces (real nodes are named "RIFE VFI") and deliberately not
# permissive about anything path- or code-shaped: this string is compared
# against the allowlist and echoed into error messages.
CLASS_TYPE_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,79}$")

# A version string the operator reports for an installed pack. Any shape a
# real project uses (v1.2.3, 1.2.3, a commit sha) is fine; the point is that
# it is recorded, short and inert.
_VERSION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$")

_STATE_FILE = "comfy-node-packs.json"

# Grants live in ONE document, so every writer rewrites the whole map — which
# makes enable and disable a read-modify-write, and both run on the server's
# threadpool where two in flight at once is ordinary. Unlocked, a disable that
# read before an enable wrote had the revoked pack still in its map, and the
# enable's save put it back. A revoked grant returning is the one direction
# this must never fail in: the grant IS the gate on running third-party code.
#
# A thread lock is the whole story because one process owns the data dir —
# that is what the `serve` bind ordering exists to guarantee.
_GRANTS_LOCK = threading.Lock()

# The sentence an operator has to be shown before third-party node code is
# allowed to run. Kept here rather than in the UI so every client — desktop,
# CLI, a script hitting the API — carries the same wording.
CODE_EXECUTION_WARNING = (
    "Custom node packs are third-party Python that runs inside ComfyUI, with access to "
    "your models, your files and the network. Enable a pack only if you installed it "
    "yourself and trust its source. LocalCut AI does not sandbox or review pack code."
)


class NodePack(BaseModel):
    """A catalog entry. Inert until enabled."""

    id: str
    name: str
    repo: str
    summary: str = ""
    nodes: list[str] = Field(default_factory=list)


class PackGrant(BaseModel):
    """An operator's decision to allow one pack, at one version."""

    pack_id: str
    version: str


class Allowlist(BaseModel):
    """The resolved answer to "may this workflow use this node?"."""

    builtin: frozenset[str]
    packs: list[NodePack]
    grants: dict[str, str] = Field(default_factory=dict)  # pack id → version

    model_config = {"arbitrary_types_allowed": True}

    def pack_for(self, class_type: str) -> NodePack | None:
        """The catalog pack providing `class_type`, enabled or not.

        Returning disabled packs on purpose: "install and enable
        ComfyUI-VideoHelperSuite" is a far better rejection message than "node
        VHS_VideoCombine is not allowed", and the caller decides which to say.
        """
        for pack in self.packs:
            if class_type in pack.nodes:
                return pack
        return None

    def allows(self, class_type: str) -> bool:
        if class_type in self.builtin:
            return True
        pack = self.pack_for(class_type)
        return pack is not None and pack.id in self.grants


def load_catalog() -> tuple[frozenset[str], list[NodePack]]:
    """The shipped builtin set and pack catalog."""
    raw = json.loads(
        (importlib.resources.files("localcut_engine.comfy") / "node_packs.json").read_text(
            encoding="utf-8"
        )
    )
    builtin = frozenset(str(name) for name in raw.get("builtin", []))
    packs = [NodePack.model_validate(entry) for entry in raw.get("packs", [])]
    return builtin, packs


def _state_path(data_dir: Path) -> Path:
    return data_dir / _STATE_FILE


def load_grants(data_dir: Path) -> dict[str, str]:
    """Enabled packs for this engine, pack id → recorded version.

    A missing, unreadable or malformed file means "nothing is enabled". That
    is the safe direction: the failure mode of a corrupt state file must be
    losing a grant the operator can re-make, never inheriting one they did
    not.
    """
    try:
        raw = json.loads(_state_path(data_dir).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return {}
    if not isinstance(raw, dict):
        return {}
    grants = raw.get("enabled")
    if not isinstance(grants, dict):
        return {}
    return {
        str(pack_id): str(version)
        for pack_id, version in grants.items()
        if isinstance(version, str) and _VERSION_PATTERN.match(version)
    }


def save_grants(data_dir: Path, grants: dict[str, str]) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    path = _state_path(data_dir)
    # Same atomic-rename discipline the project store uses: a half-written
    # grants file reads as "nothing enabled", which would silently break
    # every workflow using a pack the operator had already allowed.
    temp = path.with_suffix(".json.tmp")
    temp.write_text(json.dumps({"enabled": grants}, indent=2), encoding="utf-8")
    temp.replace(path)


def current(data_dir: Path) -> Allowlist:
    builtin, packs = load_catalog()
    return Allowlist(builtin=builtin, packs=packs, grants=load_grants(data_dir))


def enable_pack(data_dir: Path, pack_id: str, version: str, *, acknowledged: bool) -> PackGrant:
    """Allow one catalogued pack at one version.

    `acknowledged` is the opt-in risk 9 requires, threaded through as a
    parameter rather than assumed by the caller: an API client and a CLI both
    have to say it, and neither can enable a pack by omission.
    """
    if not acknowledged:
        raise ValueError(CODE_EXECUTION_WARNING)
    if not _VERSION_PATTERN.match(version or ""):
        raise ValueError(
            "give the version of the pack you installed (e.g. 1.2.3 or a commit sha) — "
            "the allowlist pins what is on this machine, not a version we guessed"
        )
    _, packs = load_catalog()
    if not any(pack.id == pack_id for pack in packs):
        known = ", ".join(sorted(pack.id for pack in packs)) or "none"
        raise KeyError(f"unknown node pack {pack_id!r} — catalogued packs: {known}")
    with _GRANTS_LOCK:
        grants = load_grants(data_dir)
        grants[pack_id] = version
        save_grants(data_dir, grants)
    return PackGrant(pack_id=pack_id, version=version)


def disable_pack(data_dir: Path, pack_id: str) -> bool:
    """Revoke a grant. True if one was there to revoke."""
    with _GRANTS_LOCK:
        grants = load_grants(data_dir)
        if pack_id not in grants:
            return False
        grants.pop(pack_id)
        save_grants(data_dir, grants)
    return True
