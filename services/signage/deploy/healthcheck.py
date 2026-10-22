"""Local readiness probe; never calls Codex or performs a generation."""
import json
import os
import sys
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, Request, build_opener


def main():
    port = int(os.environ.get("EDITOR_PORT", "8080"))
    origin = os.environ.get("EDITOR_PUBLIC_ORIGIN", "")
    host = urlsplit(origin).netloc if origin else f"127.0.0.1:{port}"
    request = Request(f"http://127.0.0.1:{port}/healthz", headers={"Host": host})
    try:
        with build_opener(ProxyHandler({})).open(request, timeout=3) as response:
            return 0 if response.status == 200 and json.load(response).get("status") == "ok" else 1
    except Exception:
        return 1


if __name__ == "__main__":
    sys.exit(main())
