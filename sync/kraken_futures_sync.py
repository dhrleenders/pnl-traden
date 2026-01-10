import os
import json
import time
import base64
import hmac
import hashlib
from datetime import datetime, timezone
from urllib.parse import urlencode, quote

import requests
from dotenv import load_dotenv


BASE_URL = "https://futures.kraken.com/derivatives"
API_PATH_PREFIX = "/api/v3"  # IMPORTANT: this is what must be used in the signing 'endpointPath' per Kraken docs.


def now_iso_utc() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def b64decode_lenient(s: str) -> bytes:
    """
    Kraken Futures api_secret is base64; sometimes copied without correct '=' padding.
    We fix padding automatically.
    """
    s = (s or "").strip()
    # add padding if missing
    missing = (-len(s)) % 4
    if missing:
        s += "=" * missing
    return base64.b64decode(s)


def build_query(params: dict | None) -> str:
    """
    Build a querystring EXACTLY as will be used in the request.
    Use %20 for spaces (quote) and keep ordering stable.
    """
    if not params:
        return ""
    # doseq for list params; quote_via=quote to get %20 instead of +
    return urlencode(params, doseq=True, quote_via=quote, safe="")


def sign_authent(api_secret_b64: str, endpoint_path: str, nonce: str, postdata: str) -> str:
    """
    Implements Kraken Derivatives REST authent generation:

    1) concat: postData + nonce + endpointPath
    2) SHA256 hash
    3) base64-decode api_secret
    4) HMAC-SHA512(secret, sha256_digest)
    5) base64-encode result

    endpointPath example: /api/v3/fills
    postData example: count=10 or greeting=hello%20world (url-encoded)
    Source: Kraken Support article. :contentReference[oaicite:3]{index=3}
    """
    secret = b64decode_lenient(api_secret_b64)

    msg = (postdata or "") + (nonce or "") + endpoint_path
    sha256_digest = hashlib.sha256(msg.encode("utf-8")).digest()

    sig = hmac.new(secret, sha256_digest, hashlib.sha512).digest()
    return base64.b64encode(sig).decode("utf-8").strip()


def private_get(api_key: str, api_secret_b64: str, api_path: str, params: dict | None = None, timeout: int = 30):
    """
    api_path: e.g. /fills  (WITHOUT /api/v3)
    We will:
      - request URL:   https://.../derivatives/api/v3/fills?...
      - sign endpoint: /api/v3/fills
      - postData:      exact querystring used
    """
    endpoint_path = f"{API_PATH_PREFIX}{api_path}"              # for signing
    query = build_query(params)                                 # MUST match what we send
    url = f"{BASE_URL}{endpoint_path}" + (f"?{query}" if query else "")

    nonce = str(int(time.time() * 1000))

    authent = sign_authent(api_secret_b64, endpoint_path, nonce, query)

    headers = {
        "APIKey": api_key,
        "Nonce": nonce,
        "Authent": authent,
    }

    r = requests.get(url, headers=headers, timeout=timeout)

    # Try to parse JSON either way
    try:
        data = r.json()
    except Exception:
        data = {"raw": r.text}

    return r.status_code, data, url, endpoint_path, query


def require_env():
    load_dotenv()
    key = (os.getenv("KRAKEN_FUTURES_KEY") or "").strip()
    secret = (os.getenv("KRAKEN_FUTURES_SECRET") or "").strip()

    if not key or not secret:
        raise SystemExit("Missing API key/secret. Put KRAKEN_FUTURES_KEY and KRAKEN_FUTURES_SECRET in .env")

    # quick sanity checks
    try:
        _ = b64decode_lenient(secret)
    except Exception:
        raise SystemExit("KRAKEN_FUTURES_SECRET is not valid base64 (even after padding fix). Re-copy from Kraken.")

    return key, secret


def main():
    key, secret = require_env()

    out = {
        "synced_at": now_iso_utc(),
        "exchange": "kraken_futures",
        "ok": True,
        "errors": [],
        "data": {}
    }

    # 1) Fills
    print("Syncing Kraken Futures fills...")
    status, data, url, sign_path, qs = private_get(key, secret, "/fills", params={"count": 500})
    print("URL:", url)
    print("SIGN:", sign_path)
    print("HTTP:", status)

    if not (isinstance(data, dict) and data.get("result") == "success"):
        out["ok"] = False
        out["errors"].append({"endpoint": "fills", "http": status, "body": data})
    out["data"]["fills"] = data

    # 2) Open positions
    print("\nSyncing Kraken Futures open positions...")
    status, data, url, sign_path, qs = private_get(key, secret, "/openpositions")
    print("URL:", url)
    print("SIGN:", sign_path)
    print("HTTP:", status)

    if not (isinstance(data, dict) and data.get("result") == "success"):
        out["ok"] = False
        out["errors"].append({"endpoint": "openpositions", "http": status, "body": data})
    out["data"]["openpositions"] = data

    # 3) Accounts
    print("\nSyncing Kraken Futures accounts...")
    status, data, url, sign_path, qs = private_get(key, secret, "/accounts")
    print("URL:", url)
    print("SIGN:", sign_path)
    print("HTTP:", status)

    if not (isinstance(data, dict) and data.get("result") == "success"):
        out["ok"] = False
        out["errors"].append({"endpoint": "accounts", "http": status, "body": data})
    out["data"]["accounts"] = data

    # Write pnl.json for the Netlify site
    # Adjust this path if your site folder differs
    target = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "site", "data", "pnl.json"))
    os.makedirs(os.path.dirname(target), exist_ok=True)

    with open(target, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    print(f"\nWrote: {target}")
    print("DONE.")


if __name__ == "__main__":
    main()