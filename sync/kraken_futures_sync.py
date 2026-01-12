import os
import json
import csv
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
BASE_URL = "https://futures.kraken.com"
API_PREFIX = "/derivatives"
API_VERSION = "/api/v3"

ROOT = Path(__file__).resolve().parents[1]  # ...\pnl_traden_github_netlify_ready
OUT_FILE = ROOT / "site" / "data" / "pnl.json"

CSV_DEFAULT = Path(__file__).resolve().parent / "kraken_futures_account_log.csv"
TIMEOUT = 30


# ------------------------------------------------------------
# Helpers
# ------------------------------------------------------------
def now_utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def num(x) -> float:
    if x is None:
        return 0.0
    s = str(x).strip()
    if s in ("", "--", "—"):
        return 0.0
    # allow "1,23" etc
    if "," in s and "." not in s:
        s = s.replace(",", ".")
    try:
        return float(s)
    except Exception:
        return 0.0


def parse_dt(dt_str: str) -> str:
    """
    Kraken futures log example: 11/Jan/2026 21:24:14
    """
    s = (dt_str or "").strip()
    if not s:
        return now_utc_iso()

    try:
        # format: DD/Mon/YYYY HH:MM:SS  (Mon = Jan, Feb, ...)
        dt = datetime.strptime(s, "%d/%b/%Y %H:%M:%S")
        # logs are effectively UTC in many setups; if yours is local, you can change this.
        dt = dt.replace(tzinfo=timezone.utc)
        return dt.isoformat().replace("+00:00", "Z")
    except Exception:
        # fallback: try ISO
        try:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        except Exception:
            return now_utc_iso()


def write_json(rows: list, extra: dict):
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_at": now_utc_iso(),
        "rows": rows,
        "counts": {"rows": len(rows)},
        **extra,
    }
    OUT_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote: {OUT_FILE}")
    print(f"Rows: {len(rows)}")


# ------------------------------------------------------------
# CSV -> rows (ACCURATE)
# ------------------------------------------------------------
def load_account_log_csv(path: Path) -> list[dict]:
    if not path.exists():
        print(f"CSV not found: {path}")
        return []

    rows = []
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        # normalize headers
        fieldnames = [c.strip() for c in (reader.fieldnames or [])]
        lower_map = {c.lower(): c for c in fieldnames}

        def get(row, key_lower):
            k = lower_map.get(key_lower)
            return row.get(k, "") if k else ""

        for r in reader:
            uid = get(r, "uid").strip()
            dt = parse_dt(get(r, "datetime") or get(r, "dateTime"))
            typ = (get(r, "type") or "").strip().lower()

            symbol = (get(r, "contract") or get(r, "symbol") or "").strip()
            trade_price = num(get(r, "trade price"))
            realized_pnl = num(get(r, "realized pnl"))
            fee = num(get(r, "fee"))
            realized_funding = num(get(r, "realized funding"))
            # funding events sometimes appear in "change"
            change = num(get(r, "change"))

            funding_usd = 0.0
            pnl_usd = 0.0
            fee_usd = 0.0

            is_trade = "futures trade" in typ
            is_funding = "funding" in typ

            if is_trade:
                pnl_usd = realized_pnl
                fee_usd = abs(fee)
            if is_funding:
                # some logs put it in realized funding, some in change
                funding_usd = realized_funding if realized_funding != 0 else change

            net_usd = pnl_usd - fee_usd + funding_usd

            # IMPORTANT: skip rows that are not trade/funding AND have net 0 (noise)
            if (not is_trade and not is_funding) and abs(net_usd) < 1e-12:
                continue

            trade_key = f"KRAKENF|LOG|{uid or (dt + '|' + symbol + '|' + str(net_usd))}"

            rows.append({
                "datetime": dt,
                "exchange": "KRAKEN",
                "symbol": symbol,
                "marketType": "FUTURES",
                "side": (get(r, "type") or "").upper(),
                "qty": 0.0,
                "price": trade_price,
                "realizedPnlUsd": pnl_usd,
                "feesUsd": fee_usd,
                "fundingUsd": funding_usd,
                "netPnlUsd": net_usd,
                "notes": "Kraken Futures account-log",
                "tradeKey": trade_key,
            })

    # sort ascending
    rows.sort(key=lambda x: x.get("datetime", ""))
    return rows


# ------------------------------------------------------------
# Optional: API fetch (NOT used for realized PnL)
# ------------------------------------------------------------
def b64decode_secret(secret_b64: str) -> bytes:
    s = (secret_b64 or "").strip().replace(" ", "").replace("\n", "").replace("\r", "")
    pad = (-len(s)) % 4
    if pad:
        s += "=" * pad
    return base64.b64decode(s)


def sign_request(secret_b64: str, path: str, nonce: str, postdata: str) -> str:
    secret = b64decode_secret(secret_b64)
    msg = (postdata + nonce + path).encode("utf-8")
    sig = hmac.new(secret, msg, hashlib.sha256).digest()
    return base64.b64encode(sig).decode("utf-8")


def signed_get(key: str, secret_b64: str, endpoint_path: str, params: dict | None = None) -> dict:
    params = params or {}
    url = f"{BASE_URL}{API_PREFIX}{endpoint_path}"
    nonce = str(int(time.time() * 1000))
    postdata = ""
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
    return {"status": r.status_code, "data": data}


def fetch_open_positions(key: str, secret: str) -> list[dict]:
    endpoint = f"{API_VERSION}/openpositions"
    res = signed_get(key, secret, endpoint)
    if res["status"] != 200:
        return []
    data = res["data"]
    if data.get("result") != "success":
        return []
    return data.get("openPositions", [])


def fetch_accounts(key: str, secret: str) -> dict:
    endpoint = f"{API_VERSION}/accounts"
    res = signed_get(key, secret, endpoint)
    if res["status"] != 200:
        return {}
    data = res["data"]
    if data.get("result") != "success":
        return {}
    return data.get("accounts", {})


# ------------------------------------------------------------
# MAIN
# ------------------------------------------------------------
def main():
    load_dotenv()

    # 1) CSV (accurate realized PnL)
    csv_path = Path(os.getenv("KRAKEN_FUTURES_ACCOUNT_LOG_CSV", str(CSV_DEFAULT)))
    print(f"Reading account-log CSV: {csv_path}")
    rows = load_account_log_csv(csv_path)

    # 2) Optional API snapshot for Live box (open positions + accounts)
    key = os.getenv("KRAKEN_FUTURES_KEY", "").strip()
    secret = os.getenv("KRAKEN_FUTURES_SECRET", "").strip()

    open_positions = []
    accounts = {}

    if key and secret:
        print("Fetching API snapshot (open positions + accounts)...")
        open_positions = fetch_open_positions(key, secret)
        accounts = fetch_accounts(key, secret)
    else:
        print("API keys not set (snapshot skipped).")

    write_json(
        rows,
        extra={
            "ok": True,
            "exchange": "kraken_futures",
            "synced_at": now_utc_iso(),
            "data": {
                "openPositions": open_positions,
                "accounts": accounts
            }
        }
    )

    print("DONE.")


if __name__ == "__main__":
    main()