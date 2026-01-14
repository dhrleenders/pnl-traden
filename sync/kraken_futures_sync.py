import os
import csv
import json
import time
import base64
import hmac
import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Dict, Any, List

import requests
from dotenv import load_dotenv

# ------------------------------------------------------------
# CONFIG
# ------------------------------------------------------------
BASE_URL = "https://futures.kraken.com"
API_PREFIX = "/derivatives"
API_VERSION = "/api/v3"

TIMEOUT = 30
FILL_COUNT = int(os.getenv("FILL_COUNT", "500"))

# Project root = ...\pnl_traden_github_netlify_ready
ROOT = Path(__file__).resolve().parents[1]
OUT_FILE = ROOT / "site" / "data" / "pnl.json"

# Default CSV path (you can override with env var)
DEFAULT_ACCOUNT_LOG_CSV = Path(__file__).resolve().parent / "account_log_work.csv"


# ------------------------------------------------------------
# Helpers
# ------------------------------------------------------------
def now_utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _norm_key(s: str) -> str:
    """Normalize header keys: lowercase, strip, collapse spaces."""
    return " ".join((s or "").strip().lower().split())


def _to_float(x) -> Optional[float]:
    if x is None:
        return None
    s = str(x).strip()
    if not s:
        return None
    # Remove thousands separators if any and normalize decimal comma
    # NOTE: we keep it simple & robust for typical Kraken CSV formats
    s = s.replace(" ", "")
    # if both , and . exist, assume , is thousands separator (rare in these exports)
    if "," in s and "." in s:
        # remove commas (thousands)
        s = s.replace(",", "")
    else:
        # treat comma as decimal separator
        s = s.replace(",", ".")
    try:
        return float(s)
    except Exception:
        return None


def _parse_dt_iso(value: str) -> str:
    """
    Kraken CSV often has e.g. 11/Jan/2026 21:24:14 or ISO.
    We'll try multiple patterns and fall back to now.
    """
    if not value:
        return now_utc_iso()

    v = value.strip()

    # If already ISO-like with T
    if "T" in v:
        # add Z if missing timezone
        if v.endswith("Z"):
            return v
        # if has +00:00 etc, keep it
        if "+" in v or v.endswith("Z"):
            return v
        return v + "Z"

    patterns = [
        "%d/%b/%Y %H:%M:%S",  # 11/Jan/2026 21:24:14
        "%d/%m/%Y %H:%M:%S",  # 11/01/2026 21:24:14
        "%Y-%m-%d %H:%M:%S",  # 2026-01-11 21:24:14
        "%Y/%m/%d %H:%M:%S",  # 2026/01/11 21:24:14
    ]
    for p in patterns:
        try:
            dt = datetime.strptime(v, p).replace(tzinfo=timezone.utc)
            return dt.isoformat().replace("+00:00", "Z")
        except Exception:
            pass

    # last resort
    return now_utc_iso()


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
    endpoint_path must be like: /api/v3/fills (WITHOUT /derivatives)
    We call: https://futures.kraken.com/derivatives + endpoint_path
    and sign endpoint_path
    """
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

    print(f"URL: {r.url}")
    print(f"HTTP: {r.status_code}")
    return {"status": r.status_code, "data": data}


def fetch_open_positions(key: str, secret: str) -> List[Dict[str, Any]]:
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


def fetch_accounts(key: str, secret: str) -> Dict[str, Any]:
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
# CSV loader (Account Log)
# ------------------------------------------------------------
def _detect_csv_dialect(sample: str) -> csv.Dialect:
    """
    Try detect delimiter etc. Kraken exports are usually comma.
    We also handle semicolon.
    """
    try:
        return csv.Sniffer().sniff(sample, delimiters=[",", ";", "\t"])
    except Exception:
        # default
        class Simple(csv.Dialect):
            delimiter = ","
            quotechar = '"'
            doublequote = True
            skipinitialspace = True
            lineterminator = "\n"
            quoting = csv.QUOTE_MINIMAL
        return Simple()


def load_account_log_csv(path: Path) -> List[Dict[str, Any]]:
    """
    Reads Kraken Futures account log CSV and converts to normalized rows.
    Critical: includes balanceUsd derived from "new balance" column.
    """
    if not path.exists():
        print(f"CSV not found: {path}")
        return []

    # Try utf-8-sig first (Kraken sometimes includes BOM)
    # Read small sample for sniffing dialect
    raw = path.read_text(encoding="utf-8-sig", errors="replace")
    sample = raw[:4096]
    dialect = _detect_csv_dialect(sample)

    # Now parse properly with csv
    rows_out: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8-sig", errors="replace", newline="") as f:
        reader = csv.reader(f, dialect)
        try:
            headers = next(reader)
        except StopIteration:
            return []

        # Normalize headers mapping
        norm_headers = [_norm_key(h) for h in headers]
        idx = {norm_headers[i]: i for i in range(len(norm_headers))}

        def get(entry: List[str], key: str) -> Optional[str]:
            k = _norm_key(key)
            if k not in idx:
                return None
            i = idx[k]
            if i < 0 or i >= len(entry):
                return None
            return entry[i]

        for entry in reader:
            if not entry or len(entry) < 3:
                continue

            uid = get(entry, "uid") or get(entry, "id") or ""
            dt_raw = get(entry, "dateTime") or get(entry, "datetime") or get(entry, "date time") or ""
            typ = (get(entry, "type") or "").strip()
            symbol = (get(entry, "symbol") or "").strip()
            contract = (get(entry, "contract") or "").strip()

            change = _to_float(get(entry, "change")) or 0.0
            new_balance = _to_float(get(entry, "new balance"))  # ✅ KRITISCH
            fee = _to_float(get(entry, "fee")) or 0.0
            realized_pnl = _to_float(get(entry, "realized pnl")) or 0.0
            realized_funding = _to_float(get(entry, "realized funding")) or 0.0

            trade_price = _to_float(get(entry, "trade price")) or 0.0
            mark_price = _to_float(get(entry, "mark price")) or 0.0
            new_avg_entry = _to_float(get(entry, "new average entry price")) or 0.0

            dt_iso = _parse_dt_iso(dt_raw)

            # netPnl: for futures account log we treat realized pnl + realized funding - fee
            # (fees are negative in some exports; we keep it consistent by subtracting fee)
            net = (realized_pnl + realized_funding) - fee

            # qty/price: account-log rows often don't contain qty. Keep 0 unless it's derivable.
            qty = 0.0
            price = trade_price if trade_price else mark_price

            # side: keep the "type" as side so the app can filter / display
            side = typ.upper() if typ else "ACCOUNT_LOG"

            # Make a unique tradeKey
            trade_key = f"KRAKENF|LOG|{uid}|{symbol or contract or 'NA'}"

            rows_out.append({
                "datetime": dt_iso,
                "exchange": "KRAKEN",
                "symbol": (contract or symbol).upper(),
                "marketType": "FUTURES",
                "side": side,
                "qty": qty,
                "price": float(price),
                "realizedPnlUsd": float(realized_pnl),
                "feesUsd": float(fee),
                "fundingUsd": float(realized_funding),
                "netPnlUsd": float(net),
                "balanceUsd": float(new_balance) if new_balance is not None else None,  # ✅
                "notes": "Kraken Futures account-log",
                "tradeKey": trade_key,
                # helpful extra meta
                "meta": {
                    "uid": uid,
                    "change": change,
                    "newAvgEntry": new_avg_entry,
                    "markPrice": mark_price,
                }
            })

    # Sort by datetime ascending (important for charts)
    rows_out.sort(key=lambda r: r.get("datetime", ""))
    return rows_out


# ------------------------------------------------------------
# Output
# ------------------------------------------------------------
def write_json(rows: List[Dict[str, Any]], extra: Dict[str, Any]):
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_at": now_utc_iso(),
        "rows": rows,
        "counts": {"rows": len(rows)},
        **extra
    }
    OUT_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote: {OUT_FILE}")
    print(f"Rows: {len(rows)}")


# ------------------------------------------------------------
# MAIN
# ------------------------------------------------------------
def main():
    load_dotenv()

    # CSV path: env override or default
    csv_env = os.getenv("KRAKEN_FUTURES_ACCOUNT_LOG_CSV", "").strip()
    csv_path = Path(csv_env) if csv_env else DEFAULT_ACCOUNT_LOG_CSV

    print(f"Reading account-log CSV: {csv_path}")
    rows = load_account_log_csv(csv_path)

    # Optional: API snapshot for open positions / accounts (doesn't affect rows)
    key = os.getenv("KRAKEN_FUTURES_KEY", "").strip()
    secret = os.getenv("KRAKEN_FUTURES_SECRET", "").strip()

    positions = []
    accounts = {}

    if key and secret:
        print("Fetching API snapshot (open positions + accounts)...")
        try:
            positions = fetch_open_positions(key, secret)
        except Exception as e:
            print("Openpositions snapshot failed:", e)
        try:
            accounts = fetch_accounts(key, secret)
        except Exception as e:
            print("Accounts snapshot failed:", e)
    else:
        print("API keys not set (KRAKEN_FUTURES_KEY/SECRET). Skipping API snapshot.")

    write_json(
        rows,
        extra={
            "ok": True,
            "exchange": "kraken_futures",
            "synced_at": now_utc_iso(),
            "raw_meta": {
                "csv_used": str(csv_path),
                "positions_count": len(positions),
                "accounts_keys": list(accounts.keys())[:30] if isinstance(accounts, dict) else [],
            }
        }
    )

    print("DONE.")


if __name__ == "__main__":
    main()