"""Optional password-only access for the private HTTPS editor.

The JSON secret file is provisioned separately from the application image. No
passwords or sessions are stored in browser storage or generation artifacts.
"""
from __future__ import annotations

from collections import deque
import argparse
import getpass
import hashlib
import hmac
from http.cookies import CookieError, SimpleCookie
import json
import os
from pathlib import Path
import re
import secrets
import threading
import time


COOKIE_NAME = "__Secure-signage_session"
ITERATIONS = 600_000
MAX_PASSWORD_BYTES = 1024


def _cookie_path(value):
    if (not isinstance(value, str) or not re.fullmatch(r"/(?:[A-Za-z0-9_-]+/)*", value)
            or len(value) > 200):
        raise ValueError("cookie_path must be an absolute directory path, e.g. /signs/")
    return value


def make_config(password, cookie_path="/", session_ttl_seconds=43200):
    """Build a fresh private JSON configuration; callers must save it securely."""
    if (not isinstance(password, str) or not password
            or len(password.encode("utf-8")) > MAX_PASSWORD_BYTES):
        raise ValueError("Password must contain 1..1024 UTF-8 bytes")
    salt = secrets.token_bytes(16)
    config = {
        "version": 1,
        "password": {"algorithm": "pbkdf2_sha256", "iterations": ITERATIONS,
                     "salt_hex": salt.hex(),
                     "hash_hex": hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, ITERATIONS).hex()},
        "session_secret_hex": secrets.token_hex(32),
        "cookie_path": _cookie_path(cookie_path),
        "session_ttl_seconds": session_ttl_seconds,
    }
    PasswordAuth(config)  # Validate the complete result before it can be saved.
    return config


class PasswordAuth:
    def __init__(self, config):
        try:
            password = config["password"]
            if type(config["version"]) is not int or config["version"] != 1 or password["algorithm"] != "pbkdf2_sha256":
                raise ValueError("Unsupported auth configuration")
            self.iterations = password["iterations"]
            self.ttl = config["session_ttl_seconds"]
            if (type(self.iterations) is not int or not 100_000 <= self.iterations <= 2_000_000
                    or type(self.ttl) is not int or not 300 <= self.ttl <= 86400):
                raise ValueError("Invalid auth configuration limits")
            for value, pattern in ((password["salt_hex"], r"[0-9a-f]{32,128}"),
                                   (password["hash_hex"], r"[0-9a-f]{64}"),
                                   (config["session_secret_hex"], r"[0-9a-f]{64}")):
                if not isinstance(value, str) or not re.fullmatch(pattern, value):
                    raise ValueError("Invalid auth configuration encoding")
            self.salt = bytes.fromhex(password["salt_hex"])
            self.password_hash = bytes.fromhex(password["hash_hex"])
            self.path = _cookie_path(config["cookie_path"])
            secret = bytes.fromhex(config["session_secret_hex"])
            # Replacing the password hash or cookie path invalidates all sessions.
            self.session_key = hmac.digest(secret, self.password_hash + self.path.encode("ascii"), "sha256")
        except (KeyError, TypeError, AttributeError) as exc:
            raise ValueError("Incomplete auth configuration") from exc
        self._failures = deque(maxlen=5)
        self._lock = threading.Lock()

    @classmethod
    def from_file(cls, filename):
        path = Path(filename)
        if not path.is_absolute():
            raise ValueError("EDITOR_AUTH_FILE must be an absolute path")
        try:
            if not path.is_file() or path.stat().st_size > 8192:
                raise ValueError("Invalid authentication file")
            return cls(json.loads(path.read_text(encoding="utf-8-sig")))
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError("Cannot read EDITOR_AUTH_FILE; authentication is not disabled") from exc

    def authenticate(self, password, now=None):
        """Return (accepted, retry_after); bound failures globally for this instance."""
        now = time.monotonic() if now is None else now
        with self._lock:
            while self._failures and self._failures[0] <= now - 60:
                self._failures.popleft()
            if len(self._failures) == self._failures.maxlen:
                return False, max(1, int(self._failures[0] + 61 - now))
            valid_format = (isinstance(password, str) and bool(password)
                            and len(password.encode("utf-8")) <= MAX_PASSWORD_BYTES)
            if valid_format:
                candidate = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), self.salt, self.iterations)
                accepted = hmac.compare_digest(candidate, self.password_hash)
            else:
                accepted = False
            if not accepted:
                self._failures.append(now)
            return accepted, 0

    def session_cookie(self, now=None):
        now = time.time() if now is None else now
        payload = f"{int(now) + self.ttl}.{secrets.token_hex(16)}"
        signature = hmac.digest(self.session_key, payload.encode("ascii"), "sha256").hex()
        return self._cookie(payload + "." + signature, self.ttl)

    def clear_cookie(self):
        return self._cookie("", 0)

    def _cookie(self, value, max_age):
        cookie = SimpleCookie()
        cookie[COOKIE_NAME] = value
        item = cookie[COOKIE_NAME]
        item["path"] = self.path
        item["max-age"] = str(max_age)
        item["secure"] = True
        item["httponly"] = True
        item["samesite"] = "Strict"
        return item.OutputString()

    def authorized(self, cookie_header, now=None):
        if not isinstance(cookie_header, str) or len(cookie_header) > 8192:
            return False
        try:
            cookies = SimpleCookie()
            cookies.load(cookie_header)
            token = cookies[COOKIE_NAME].value
        except (CookieError, KeyError):
            return False
        if not re.fullmatch(r"[0-9]{1,12}\.[0-9a-f]{32}\.[0-9a-f]{64}", token):
            return False
        payload, signature = token.rsplit(".", 1)
        expected = hmac.digest(self.session_key, payload.encode("ascii"), "sha256").hex()
        if not hmac.compare_digest(signature, expected):
            return False
        now = time.time() if now is None else now
        expiry = int(payload.split(".", 1)[0])
        return now < expiry <= now + self.ttl


def save_config_exclusive(config, filename):
    """Create a new 0600 file; never replace a configured password by accident."""
    PasswordAuth(config)
    path = Path(filename)
    if not path.is_absolute():
        raise ValueError("Output path must be absolute")
    data = (json.dumps(config, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return path


def main(argv=None):
    parser = argparse.ArgumentParser(description="Create a private password configuration without recording plaintext.")
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create", help="Write a new configuration file; existing files are never replaced")
    create.add_argument("--output", type=Path, required=True)
    create.add_argument("--cookie-path", default="/")
    args = parser.parse_args(argv)
    try:
        if not args.output.is_absolute():
            raise ValueError("Output path must be absolute")
        if args.output.exists() or args.output.is_symlink():
            raise ValueError("Output already exists; choose a new filename")
        _cookie_path(args.cookie_path)
        password = getpass.getpass("New editor password: ")
        if password != getpass.getpass("Repeat editor password: "):
            raise ValueError("Passwords do not match; no file was written")
        path = save_config_exclusive(make_config(password, args.cookie_path), args.output)
        print(f"Created private authentication file: {path}")
        print("Configure EDITOR_AUTH_FILE and restart the editor to apply it.")
    except (OSError, ValueError) as exc:
        raise SystemExit(str(exc)) from exc


if __name__ == "__main__":
    main()
