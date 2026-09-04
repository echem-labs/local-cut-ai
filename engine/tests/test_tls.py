"""Remote-engine TLS: certificate generation, pin stability, and the
pairing-code payload the frontend consumes."""

import base64
import json
import os

import pytest

from localcut_engine.tls import ensure_certificate


def test_certificate_is_generated_once_and_pin_is_stable(tmp_path):
    cert1, key1, fp1 = ensure_certificate(tmp_path / "tls", ["192.168.1.20"])
    assert cert1.exists() and key1.exists()
    assert len(fp1) == 64  # sha-256 hex
    if os.name != "nt":  # Windows ignores chmod bits — ACLs govern access there
        assert (key1.stat().st_mode & 0o777) == 0o600  # private key stays private

    # Same dir → same certificate → same pin (paired frontends keep working).
    cert2, _, fp2 = ensure_certificate(tmp_path / "tls", ["10.0.0.9"])
    assert fp2 == fp1
    assert cert2.read_bytes() == cert1.read_bytes()

    # A rotated (deleted) tls dir mints a new identity.
    cert1.unlink()
    key1.unlink()
    _, _, fp3 = ensure_certificate(tmp_path / "tls", ["192.168.1.20"])
    assert fp3 != fp1


def test_certificate_carries_usable_sans(tmp_path):
    from cryptography import x509

    cert_path, _, _ = ensure_certificate(tmp_path / "tls", ["192.168.1.20", "gpu-box.local"])
    cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
    san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    names = {str(n.value) for n in san}
    assert "192.168.1.20" in names
    assert "gpu-box.local" in names
    assert cert.not_valid_after_utc > cert.not_valid_before_utc


def test_bind_all_hosts_are_not_certified_as_names(tmp_path):
    from cryptography import x509

    cert_path, _, _ = ensure_certificate(tmp_path / "tls", ["0.0.0.0"])
    cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
    san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    assert {str(n.value) for n in san} == {"localcut-engine"}


def test_pairing_code_round_trips():
    """The base64url pairing line is the frontend contract."""
    import io
    from contextlib import redirect_stdout

    from localcut_engine.cli import _print_pairing

    buffer = io.StringIO()
    with redirect_stdout(buffer):
        _print_pairing("https", "192.168.1.20", 7830, "tok123", "ab" * 32)
    printed = buffer.getvalue().splitlines()
    code_line = next(line for line in printed if "pairing code:" in line)
    code = code_line.split("pairing code:")[1].strip()
    payload = json.loads(base64.urlsafe_b64decode(code + "=" * (-len(code) % 4)))
    assert payload == {
        "url": "https://192.168.1.20:7830",
        "token": "tok123",
        "fingerprint": "ab" * 32,
    }


def test_private_key_is_never_world_readable(tmp_path, monkeypatch):
    """The client pins this exact certificate, so a stolen key defeats the
    pin — the file must not exist, even briefly, with loose permissions.

    Asserting the final mode alone would pass for a write-then-chmod too,
    which leaves the key world-readable in between (and permanently so if
    the process dies there). Neutralizing chmod is what pins the real
    invariant: the CREATE has to carry the mode."""
    import os
    import stat
    from pathlib import Path

    from localcut_engine.tls import ensure_certificate

    if os.name == "nt":
        # POSIX mode bits are not the access-control mechanism on Windows —
        # os.stat reports a synthetic 0o666 regardless of the ACL. The
        # invariant this pins (the CREATE carries the mode) is POSIX-only.
        pytest.skip("POSIX file modes; Windows uses ACLs")

    monkeypatch.setattr(Path, "chmod", lambda self, mode: None)
    _cert_path, key_path, _fingerprint = ensure_certificate(tmp_path, ["127.0.0.1"])
    mode = stat.S_IMODE(key_path.stat().st_mode)
    assert mode & 0o077 == 0, f"key was created group/world accessible: {oct(mode)}"


# -- the pairing code has to name an address the laptop can reach ------------


def test_an_advertised_host_overrides_the_derived_one():
    """Inside a container the outbound probe answers with the bridge address,
    which is correct for the container and unreachable from the laptop
    reading the pairing code out of `docker compose logs`."""
    from localcut_engine.cli import _lan_address

    assert _lan_address("0.0.0.0", "gpu-box.local") == "gpu-box.local"
    assert _lan_address("0.0.0.0", "") != ""  # derived, whatever this box is
    assert _lan_address("10.0.0.4") == "10.0.0.4"


def test_the_pairing_code_carries_the_advertised_url(capsys):
    """The code is opaque base64, so a wrong address in it cannot be corrected
    by hand — it has to be right when it is printed."""
    import base64
    import json as _json

    from localcut_engine.cli import _print_pairing

    _print_pairing("https", "0.0.0.0", 7830, "tok", "ab" * 32, "gpu-box.local")
    printed = capsys.readouterr().out
    code = next(
        line.split("pairing code:")[1].strip()
        for line in printed.splitlines()
        if "pairing code:" in line
    )
    payload = _json.loads(base64.urlsafe_b64decode(code + "=" * (-len(code) % 4)))
    assert payload["url"] == "https://gpu-box.local:7830"


def test_an_advertised_host_may_carry_its_own_port(capsys):
    """A reverse proxy answers on 443, not on the port the engine bound."""
    import base64
    import json as _json

    from localcut_engine.cli import _print_pairing

    _print_pairing("https", "0.0.0.0", 7830, "tok", "ab" * 32, "engine.example.com:443")
    printed = capsys.readouterr().out
    code = next(
        line.split("pairing code:")[1].strip()
        for line in printed.splitlines()
        if "pairing code:" in line
    )
    payload = _json.loads(base64.urlsafe_b64decode(code + "=" * (-len(code) % 4)))
    assert payload["url"] == "https://engine.example.com:443"
