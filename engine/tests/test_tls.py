"""Remote-engine TLS: certificate generation, pin stability, and the
pairing-code payload the frontend consumes."""

import base64
import json
import os

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
