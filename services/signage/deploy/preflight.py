"""Validate deployment settings without printing passwords or sending an AI request."""
import argparse
from pathlib import Path
import re
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]


def read_settings(path):
    """Read the simple literal KEY=value format used by .env.example."""
    settings = {}
    for number, raw in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if not separator or not re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
            raise ValueError(f"Invalid .env syntax on line {number}")
        if key in settings:
            raise ValueError(f"Duplicate setting on line {number}: {key}")
        quoted = len(value) >= 2 and value[0] == value[-1] == "'"
        if quoted:
            value = value[1:-1]
        elif value.startswith(("'", '"')) or " #" in value:
            raise ValueError(f"Use literal values or single quotes on line {number}")
        if key == "EDITOR_PASSWORD_HASH" and not quoted:
            raise ValueError("EDITOR_PASSWORD_HASH must be single-quoted to preserve dollar signs")
        settings[key] = value
    return settings


def validate_settings(settings):
    errors = []
    domain = settings.get("DOMAIN", "")
    label = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
    if not re.fullmatch(rf"{label}(?:\.{label})+", domain) or len(domain) > 253:
        errors.append("DOMAIN must be a lowercase DNS name without protocol, path or port")
    elif domain.lower().endswith((".example.com", ".example.org", ".example.net", ".invalid", ".test")):
        errors.append("Replace the example DOMAIN with your own DNS name")
    email = settings.get("ACME_EMAIL", "")
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email) or email.endswith("@example.com"):
        errors.append("Set your ACME_EMAIL for certificate notifications")
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", settings.get("EDITOR_USER", "")):
        errors.append("EDITOR_USER must contain 1–64 letters, digits, underscores, dots or hyphens")
    if not re.fullmatch(r"\$2[aby]\$(?:0[4-9]|[12][0-9]|3[01])\$[./A-Za-z0-9]{53}",
                        settings.get("EDITOR_PASSWORD_HASH", "")):
        errors.append("Generate EDITOR_PASSWORD_HASH with caddy hash-password")
    if settings.get("CODEX_VERSION") and not re.fullmatch(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?", settings["CODEX_VERSION"]):
        errors.append("CODEX_VERSION must be an exact release, not latest or a version range")
    if settings.get("APP_VERSION") and not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}", settings["APP_VERSION"]):
        errors.append("APP_VERSION must be a valid Docker image tag")
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=ROOT / ".env")
    parser.add_argument("--static", action="store_true", help="Validate settings only, without Docker")
    args = parser.parse_args()
    try:
        errors = validate_settings(read_settings(args.env_file))
    except (OSError, ValueError) as exc:
        errors = [str(exc)]
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print("Deployment settings: valid")
    if args.static:
        print("Docker and Caddy have not been checked (--static).")
        return 0
    if not shutil.which("docker"):
        print("ERROR: Docker with Compose v2 is required on the VPS.", file=sys.stderr)
        return 1
    checks = (
        ["docker", "compose", "version"],
        ["docker", "info", "--format", "{{.OSType}}/{{.Architecture}}"],
        ["docker", "compose", "--env-file", str(args.env_file.resolve()), "config", "--quiet"],
    )
    for check in checks:
        try:
            result = subprocess.run(check, cwd=ROOT, text=True, capture_output=True, timeout=30)
        except (OSError, subprocess.SubprocessError):
            print("ERROR: A Docker check could not complete.", file=sys.stderr)
            return 1
        if result.returncode:
            # Do not echo arbitrary Docker output, which may contain substituted secrets.
            print(f"ERROR: Docker check failed: {' '.join(check[:3])}", file=sys.stderr)
            return 1
        if check[1] == "info" and not result.stdout.strip().startswith("linux/"):
            print("ERROR: Docker must use Linux containers.", file=sys.stderr)
            return 1
    print("Docker daemon and Compose configuration: ready")
    print("Next: build, validate Caddy, sign in to Codex, then run a real image test.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
