import os
import csv
import json
import time
import base64
import hmac
import hashlib
from datetime import datetime, timezone

import requests
from dotenv import load_dotenv

# ---------------------------
# Config
# ---------------------------
BASE_URL = "https://futures.kraken.com"
API_PREFIX = "/derivatives"
API_VERSION = "/api/v3"
TIMEOUT = 30

DEFAULT_CSV = os.path.join(os.path.dirname(__file__), "account_log_work.csv")


# ---------------------------
# Helpers
# ---------------------------
def now_utc_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def b64decode_secret(secret_b64: str) -> bytes:
    s = (secret_b64 or "").strip().replace(" ", "").replace("\n", "").replace("\r", "")
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
    endpoint_path must be like /api/v3/openpositions (WITHOUT /derivatives)
    request URL becomes https://futures.kraken.com/derivatives + endpoint_path
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

    return {"status": r.status_code, "data": data, "url": r.url}


# ---------------------------
# CSV loader (Kraken Futures account log export)
# ---------------------------
def load_account_log_csv(path: str) -> list[dict]:
    if not os.path.exists(path):
        print(f"CSV not found: {path}")
        return []

    rows = []
    # Kraken export is usually utf-8-sig
    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for r in reader:
            # Normalize keys we care about
            # Expected columns (example): dateTime, type, symbol, contract, trade price, realized pnl, fee, realized funding, ...
            dt = (r.get("dateTime") or r.get("datetime") or r.get("time") or "").strip()
            typ = (r.get("type") or "").strip()
            sym = (r.get("symbol") or "").strip()
            contract = (r.get("contract") or "").strip()

            # Numbers (safe parse)
            def fnum(x):
                try:
                    return float(str(x).strip()) if str(x).strip() != "" else 0.0
                except Exception:
                    return 0.0

            realized_pnl = fnum(r.get("realized pnl"))
            fee = fnum(r.get("fee"))
            realized_funding = fnum(r.get("realized funding"))

            # side is not always present in account-log; keep empty if unknown
            side = (r.get("side") or "").strip().upper()

            trade_price = fnum(r.get("trade price"))
            qty = fnum(r.get("change"))  # account-log 'change' is often size/Δ; keep as qty proxy

            net = realized_pnl - fee + realized_funding

            # Make a stable tradeKey
            uid = (r.get("uid") or r.get("id") or "").strip()
            if not uid:
                uid = f"{dt}|{typ}|{sym}|{contract}|{trade_price}|{qty}"

            rows.append({
                "datetime": dt if dt else now_utc_iso(),
                "exchange": "KRAKEN",
                "symbol": sym or contract,
                "marketType": "FUTURES",
                "side": side,
                "qty": qty,
                "price": trade_price,
                "realizedPnlUsd": realized_pnl,
                "feesUsd": fee,
                "fundingUsd": realized_funding,
                "netPnlUsd": net,
                "notes": typ,
                "tradeKey": f"KRAKENF|ACCLOG|{uid}",
                "_raw": r,
            })

    return rows


# ---------------------------
# API snapshot (optional)
# ---------------------------
def fetch_open_positions(key: str, secret: str) -> list[dict]:
    endpoint = f"{API_VERSION}/openpositions"
    res = signed_get(key, secret, endpoint)
    if res["status"] != 200:
        print("Openpositions warning:", res["status"], res["data"])
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
        print("Accounts warning:", res["status"], res["data"])
        return {}
    data = res["data"]
    if data.get("result") != "success":
        print("Accounts warning:", data)
        return {}
    return data.get("accounts", {})


# ---------------------------
# Output
# ---------------------------
def write_pnl_json(rows: list[dict], meta: dict):
    out = {
        "generated_at": now_utc_iso(),
        "ok": True,
        "exchange": "kraken_futures",
        "rows": rows,
        "counts": {"rows": len(rows)},
        "meta": meta,
    }

    # Write to site/data/pnl.json (relative to this file)
    here = os.path.dirname(os.path.abspath(__file__))
    target = os.path.abspath(os.path.join(here, "..", "site", "data", "pnl.json"))
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)

    print(f"OK: wrote {len(rows)} rows -> {target}")


# ---------------------------
# Main
# ---------------------------
def main():
    load_dotenv()

    key = (os.getenv("KRAKEN_FUTURES_KEY") or "").strip()
    secret = (os.getenv("KRAKEN_FUTURES_SECRET") or "").strip()

    csv_path = (os.getenv("KRAKEN_FUTURES_ACCOUNT_LOG_CSV") or DEFAULT_CSV).strip()

    print(f"Reading account-log CSV: {csv_path}")
    rows = load_account_log_csv(csv_path)

    # Optional API snapshot (you said live isn't important now, but keep it harmless)
    meta = {"csv_path": csv_path, "synced_at": now_utc_iso()}
    if key and secret:
        print("Fetching API snapshot (open positions + accounts)...")
        positions = fetch_open_positions(key, secret)
        accounts = fetch_accounts(key, secret)
        meta["open_positions_count"] = len(positions)
        meta["accounts_keys"] = list(accounts.keys())[:50]
    else:
        meta["api_snapshot"] = "skipped (no key/secret)"

    # Convert rows into app-friendly fields (remove _raw to keep file smaller)
    clean_rows = []
    for r in rows:
        raw = r.pop("_raw", None)
        clean_rows.append(r)

    write_pnl_json(clean_rows, meta)
    print("DONE.")


if __name__ == "__main__":
    main()