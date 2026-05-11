#!/usr/bin/env python3
"""
One-time helper to complete the Etsy OAuth 2.0 + PKCE flow and get your
initial ETSY_ACCESS_TOKEN and ETSY_REFRESH_TOKEN.

Run this once, paste the printed values into .env, then run Scout normally.
Scout will refresh the access token automatically on every run.

Before running:
  1. Go to https://www.etsy.com/developers and create an app (or open an existing one).
  2. In your app settings, add this as an allowed redirect URI:
       http://localhost:3003/oauth/redirect
  3. Set ETSY_API_KEY=<your-app-api-key> in .env (or export it in your shell).

Usage:
  python scripts/get_etsy_tokens.py
"""

import base64
import hashlib
import http.server
import os
import secrets
import threading
import urllib.parse
import webbrowser

import httpx

_REDIRECT_URI = "http://localhost:3003/oauth/redirect"
_TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token"
_AUTH_BASE = "https://www.etsy.com/oauth/connect"
_SCOPE = "listings_r"
_TIMEOUT_SECS = 120


def _load_dotenv() -> None:
    env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
    if not os.path.exists(env_path):
        return
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())


def _pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode()).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    return verifier, challenge


def _auth_url(api_key: str, challenge: str, state: str) -> str:
    params = {
        "response_type": "code",
        "redirect_uri": _REDIRECT_URI,
        "scope": _SCOPE,
        "client_id": api_key,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    return f"{_AUTH_BASE}?{urllib.parse.urlencode(params)}"


def _exchange(api_key: str, verifier: str, code: str) -> dict:
    resp = httpx.post(
        _TOKEN_URL,
        data={
            "grant_type": "authorization_code",
            "client_id": api_key,
            "redirect_uri": _REDIRECT_URI,
            "code": code,
            "code_verifier": verifier,
        },
    )
    resp.raise_for_status()
    return resp.json()


def main() -> None:
    _load_dotenv()

    api_key = os.environ.get("ETSY_API_KEY", "").strip()
    if not api_key or api_key == "x":
        raise SystemExit(
            "ETSY_API_KEY is not set.\nAdd it to .env or export it, then re-run this script."
        )

    verifier, challenge = _pkce_pair()
    state = secrets.token_urlsafe(16)
    url = _auth_url(api_key, challenge, state)

    # Spin up a one-request local server to catch the redirect
    result: dict = {}

    class _Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if "code" in params:
                result["code"] = params["code"][0]
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"<h2>Authorized! You can close this tab.</h2>")
            else:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b"<h2>No code found - try again.</h2>")

        def log_message(self, *_) -> None:
            pass

    server = http.server.HTTPServer(("localhost", 3003), _Handler)
    t = threading.Thread(target=server.handle_request)
    t.start()

    print("\nOpening Etsy in your browser...")
    print(f"\nIf the browser doesn't open automatically, visit:\n  {url}\n")
    webbrowser.open(url)

    t.join(timeout=_TIMEOUT_SECS)
    server.server_close()

    if "code" not in result:
        raise SystemExit("Timed out waiting for Etsy to redirect. Run the script again.")

    print("Exchanging code for tokens...")
    tokens = _exchange(api_key, verifier, result["code"])

    access_token = tokens["access_token"]
    refresh_token = tokens.get("refresh_token", "")
    expires_in = tokens.get("expires_in", 3600)

    print("\nSuccess! Add these two lines to your .env:\n")
    print(f"ETSY_ACCESS_TOKEN={access_token}")
    print(f"ETSY_REFRESH_TOKEN={refresh_token}")
    print(f"\nThe access token expires in {expires_in}s (~1 hour).")
    print("Scout refreshes it automatically on every run using ETSY_REFRESH_TOKEN.")


if __name__ == "__main__":
    main()
