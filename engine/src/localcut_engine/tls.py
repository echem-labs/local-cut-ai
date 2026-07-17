"""Self-signed TLS for remote engine mode.

A network-bound engine serves HTTPS with a self-signed certificate that the
frontend pins by SHA-256 fingerprint — no CA, no domain, no expiry dance on
a homelab GPU box. The certificate is generated once under the data dir and
reused across restarts so the pin survives; deleting the tls/ dir rotates
it (and every paired frontend must re-pair, which is the point).
"""

from __future__ import annotations

import ipaddress
from datetime import UTC, datetime, timedelta
from pathlib import Path

_VALID_DAYS = 3650
_COMMON_NAME = "localcut-engine"


def ensure_certificate(tls_dir: Path, hosts: list[str]) -> tuple[Path, Path, str]:
    """Return (cert_path, key_path, sha256_fingerprint_hex), generating a
    self-signed pair on first use. `hosts` become SANs so pinned-but-verified
    clients can also match the name."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    cert_path = tls_dir / "cert.pem"
    key_path = tls_dir / "key.pem"
    if not (cert_path.exists() and key_path.exists()):
        tls_dir.mkdir(parents=True, exist_ok=True)
        key = ec.generate_private_key(ec.SECP256R1())
        names: list[x509.GeneralName] = [x509.DNSName(_COMMON_NAME)]
        for host in hosts:
            if host in ("0.0.0.0", "::"):  # bind-all is not a reachable name
                continue
            try:
                names.append(x509.IPAddress(ipaddress.ip_address(host)))
            except ValueError:
                names.append(x509.DNSName(host))
        subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, _COMMON_NAME)])
        now = datetime.now(UTC)
        certificate = (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(subject)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(minutes=5))
            .not_valid_after(now + timedelta(days=_VALID_DAYS))
            .add_extension(x509.SubjectAlternativeName(names), critical=False)
            .sign(key, hashes.SHA256())
        )
        key_path.write_bytes(
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
        key_path.chmod(0o600)
        cert_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))

    loaded = x509.load_pem_x509_certificate(cert_path.read_bytes())
    fingerprint = loaded.fingerprint(hashes.SHA256()).hex()
    return cert_path, key_path, fingerprint
