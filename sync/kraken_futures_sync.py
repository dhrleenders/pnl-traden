import os
import json
import time
import base64
import hmac
import hashlib
from datetime import datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

# ------------------------------------------------------------
# CONFIG
# ------------------------------------------------------------
BASE_URL = "https://futures.kraken.com"  # host is correct
API_PREFIX = "/derivatives"             # IMPORTANT for Kraken Futures REST
API_VERSION = "/api/v3"

FILL_COUNT = int(os.getenv("FILL_COUNT", "500"))

ROOT = Path(__file__).resolve().parents[1]  # ...\pnl_traden_github_netlify_ready
OUT_FILE = ROOT / "site" / "data" / "pnl.json"

TIMEOUT = 30


# ------------------------------------------------------------
# Helpers
# ------------------------------------------------------------
def now_utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def must_env(name: str) -> str:
    v = os.getenv(name, "")
    if not v:
        raise RuntimeError(f"Missing env var: {name}")
    return v


def b64decode_secret(secret_b64: str) -> bytes:
    """
    Kraken Futures API secret is base64. Common issues:
    - accidental spaces/newlines
    - missing padding '='
    """
    s = (secret_b64 or "").strip().replace(" ", "").replace("\n", "").replace("\r", "")
    # fix padding
    pad = (-len(s)) % 4
    if pad:
        s += "=" * pad
    return base64.b64decode(s)


def sign_request(secret_b64: str, path: str, nonce: str, postdata: str) -> str:
    """
    Kraken Futures signing:
    message = postdata + nonce + path
    HMAC_SHA256(secret, message) -> base64
    """
    secret = b64decode_secret(secret_b64)
    msg = (postdata + nonce + path).encode("utf-8")
    sig = hmac.new(secret, msg, hashlib.sha256).digest()
    return base64.b64encode(sig).decode("utf-8")


def signed_get(key: str, secret_b64: str, endpoint_path: str, params: dict | None = None) -> dict:
    """
    endpoint_path must be like: /api/v3/fills  (WITHOUT /derivatives)
    We will call: https://futures.kraken.com/derivatives + endpoint_path
    And sign path: endpoint_path (as required by Kraken Futures)
    """
    params = params or {}
    url = f"{BASE_URL}{API_PREFIX}{endpoint_path}"

    nonce = str(int(time.time() * 1000))
    postdata = ""  # GET has empty postdata

    auth = sign_request(secret_b64, endpoint_path, nonce, postdata)

    headers = {
        "APIKey": key,
        "Nonce": nonce,
        "Authent": auth,
        "User-Agent": "pnl-traden-sync/1.0",
        "Accept": "application/json",
    }

    r = requests.get(url, params=params, headers=headers, timeout=TIMEOUT)
    try:
        data = r.json()
    except Exception:
        data = {"raw": r.text}

    # handy debug (keeps it readable)
    print(f"URL: {r.url}")
    print(f"HTTP: {r.status_code}")

    return {"status": r.status_code, "data": data}


# ------------------------------------------------------------
# Fetchers
# ------------------------------------------------------------
def fetch_fills(key: str, secret: str, count: int = 500) -> list[dict]:
    # IMPORTANT: endpoint path for signing is WITHOUT /derivatives
    endpoint = f"{API_VERSION}/fills"
    res = signed_get(key, secret, endpoint, params={"count": count})

    if res["status"] != 200:
        raise RuntimeError(f"Fills failed ({res['status']}): {res['data']}")

    data = res["data"]
    if data.get("result") != "success":
        raise RuntimeError(f"Fills error: {data}")

    return data.get("fills", [])


def fetch_open_positions(key: str, secret: str) -> list[dict]:
    endpoint = f"{API_VERSION}/openpositions"
    res = signed_get(key, secret, endpoint)

    if res["status"] != 200:
        print("Openpositions warning:", res["data"])
        return []

    data = res["data"]
    if data.get("result") != "success":
        print("Openpositions warning:", data)
        return []

    return data.get("openPositions", [])


def fetch_accounts(key: str, secret: str) -> dict:
    endpoint = f"{API_VERSION}/accounts"
    res = signed_get(key, secret, endpoint)

    if res["status"] != 200:
        print("Accounts warning:", res["data"])
        return {}

    data = res["data"]
    if data.get("result") != "success":
        print("Accounts warning:", data)
        return {}

    return data.get("accounts", {})


# ------------------------------------------------------------
# Normalization for the APP
# The app expects:
# { "generated_at": "...", "rows": [ { datetime, exchange, symbol, marketType, side, qty, price, realizedPnlUsd, feesUsd, fundingUsd, netPnlUsd, notes, tradeKey } ] }
#
# NOTE: Kraken "fills" do NOT contain realized PnL. So we store trades with pnl=0 for now.
# Later we can add account-log parsing for realized PnL if your endpoint is available.
# ------------------------------------------------------------
def normalize_rows_from_fills(fills: list[dict]) -> list[dict]:
    rows = []
    for f in fills:
        fill_id = f.get("fill_id") or f.get("fillId") or ""
        symbol = f.get("symbol") or ""
        side = (f.get("side") or "").upper()  # buy/sell
        size = f.get("size") or 0
        price = f.get("price") or 0
        fill_time = f.get("fillTime") or f.get("time") or ""

        # Ensure ISO-ish datetime
        dt = fill_time
        if isinstance(dt, str) and dt and not dt.endswith("Z") and "T" in dt:
            dt = dt + "Z"

        trade_key = f"KRAKENF|FILL|{fill_id}|{symbol}"

        rows.append({
            "datetime": dt or now_utc_iso(),
            "exchange": "KRAKEN",
            "symbol": symbol,
            "marketType": "FUTURES",
            "side": side,
            "qty": float(size) if size is not None else 0.0,
            "price": float(price) if price is not None else 0.0,
            "realizedPnlUsd": 0.0,
            "feesUsd": 0.0,
            "fundingUsd": 0.0,
            "netPnlUsd": 0.0,
            "notes": "Kraken Futures fill (PnL via account-log later)",
            "tradeKey": trade_key
        })
    return rows


def write_json(rows: list[dict], extra: dict):
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_at": now_utc_iso(),
        "rows": rows,
        **extra
    }
    OUT_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote: {OUT_FILE}")
    print(f"Rows: {len(rows)}")


# ------------------------------------------------------------
# MAIN
# ------------------------------------------------------------
def main():
    # load .env from current folder (sync)
    load_dotenv()

    key = os.getenv("KRAKEN_FUTURES_KEY", "").strip()
    secret = os.getenv("KRAKEN_FUTURES_SECRET", "").strip()

    if not key or not secret:
        raise RuntimeError("Missing API key/secret in .env (KRAKEN_FUTURES_KEY / KRAKEN_FUTURES_SECRET)")

    print("Syncing Kraken Futures fills...")
    fills = fetch_fills(key, secret, count=FILL_COUNT)

    print("\nSyncing Kraken Futures open positions...")
    positions = fetch_open_positions(key, secret)

    print("\nSyncing Kraken Futures accounts...")
    accounts = fetch_accounts(key, secret)

    rows = normalize_rows_from_fills(fills)

    write_json(
        rows,
        extra={
            "ok": True,
            "exchange": "kraken_futures",
            "raw_meta": {
                "fills_count": len(fills),
                "positions_count": len(positions),
                "accounts_keys": list(accounts.keys())[:20],
            }
        }
    )

    print("DONE.")


if __name__ == "__main__":
    main()