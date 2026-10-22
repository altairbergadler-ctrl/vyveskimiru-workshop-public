"""Verify the Workshop owner session without retaining or logging its cookie."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

OWNER_COOKIE = 'finance_session'
MAX_RESPONSE_BYTES = 16 * 1024


class AuthenticationUnavailable(Exception):
    """The authority could not produce a bounded, trustworthy response."""


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def validate_authority_url(url: str) -> str:
    try:
        parsed = urlsplit(url)
        valid = (parsed.scheme in ('http', 'https') and parsed.hostname and parsed.port != 0
                 and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment
                 and parsed.path == '/api/session')
    except ValueError:
        valid = False
    if not valid:
        raise ValueError('WORKSHOP_AUTH_URL must be a fixed http(s) /api/session URL without credentials or query.')
    return url


def valid_cookie(value: str) -> bool:
    # Forward one cookie value only. Exclude header injection, additional
    # cookies and cookie quoting characters; never forward request headers.
    return bool(value and len(value) <= 4096 and all(33 <= ord(char) <= 126 and char not in ';,\\"' for char in value))


def verify_owner_session(authority_url: str, cookie: str) -> bool:
    if not valid_cookie(cookie):
        return False
    request = Request(authority_url, headers={
        'Cookie': OWNER_COOKIE + '=' + cookie,
        'Accept': 'application/json',
    }, method='GET')
    # Ignore HTTP_PROXY environment settings: the owner credential must only
    # travel directly to the configured authority inside the Docker network.
    opener = build_opener(ProxyHandler({}), _NoRedirect())
    try:
        with opener.open(request, timeout=2) as response:
            if response.status != 200:
                raise AuthenticationUnavailable()
            payload = response.read(MAX_RESPONSE_BYTES + 1)
            if len(payload) > MAX_RESPONSE_BYTES:
                raise AuthenticationUnavailable()
        body = json.loads(payload.decode('utf-8'))
        return isinstance(body, dict) and body.get('authenticated') is True
    except HTTPError as exc:
        if exc.code in (401, 403):
            return False
        # Redirects are deliberately not followed, including same-host ones.
        raise AuthenticationUnavailable() from None
    except (URLError, OSError, TimeoutError, UnicodeError, ValueError):
        raise AuthenticationUnavailable() from None


def load_csrf_secret(data_dir: Path) -> bytes:
    path = data_dir / 'csrf-secret'
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(descriptor, 'wb') as file:
            file.write(secrets.token_bytes(32))
            file.flush()
            os.fsync(file.fileno())
    secret = path.read_bytes()
    if len(secret) != 32:
        raise RuntimeError('Invalid persisted CSRF secret; repair the data/csrf-secret file before startup.')
    return secret


def csrf_for_owner(secret: bytes, cookie: str) -> str:
    return hmac.new(secret, b'stamp-workshop-csrf\0' + cookie.encode('ascii'), hashlib.sha256).hexdigest()


def matching_origin(request_host: str, origin: str) -> bool:
    try:
        parsed = urlsplit(origin)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
            return False
        # Compare authorities, including explicit ports. The reverse proxy
        # must preserve the public Host header (as the Workshop proxy does).
        return parsed.netloc.lower() == request_host.lower()
    except ValueError:
        return False
