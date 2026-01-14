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

KRAKEN_CSV_DEFAULT = Path(__file__).resolve().parent / "account_log_work.csv"
BLOFIN_CSV_DEFAULT = Path(__file__).resolve().parent / "blofin_order_history.csv"

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
    # 1,23 -> 1.23
    if "," in s and "." not in s:
        s = s.replace(",", ".")
    # strip currency tokens like "2.175 USDT"
    # keep first numeric
    out = []
    seen_digit = False
    for ch in s:
        if ch.isdigit() or ch in ".-":
            out.append(ch)
            if ch.isdigit():
                seen_digit = True
        elif seen_digit:
            break
    try:
        return float("".join(out)) if out else 0.0
    except Exception:
        return 0.0


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
# Kraken account-log CSV -> rows (ACCURATE)
# ------------------------------------------------------------
def parse_kraken_dt(dt_str: str) -> str:
    """
    Kraken futures log example: 11/Jan/2026 21:24:14
    """
    s = (dt_str or "").strip()
    if not s:
        return now_utc_iso()

    try:
        dt = datetime.strptime(s, "%d/%b/%Y %H:%M:%S")
        dt = dt.replace(tzinfo=timezone.utc)
        return dt.isoformat().replace("+00:00", "Z")
    except Exception:
        try:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        except Exception:
            return now_utc_iso()


def load_kraken_account_log_csv(path: Path) -> list[dict]:
    if not path.exists():
        print(f"Kraken CSV not found: {path}")
        return []

    rows = []
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        fieldnames = [c.strip() for c in (reader.fieldnames or [])]
        lower_map = {c.lower(): c for c in fieldnames}

        def get(row, key_lower):
            k = lower_map.get(key_lower)
            return row.get(k, "") if k else ""

        for r in reader:
            uid = get(r, "uid").strip()
            dt = parse_kraken_dt(get(r, "datetime") or get(r, "dateTime"))
            typ = (get(r, "type") or "").strip().lower()

            symbol = (get(r, "contract") or get(r, "symbol") or "").strip()
            trade_price = num(get(r, "trade price"))
            realized_pnl = num(get(r, "realized pnl"))
            fee = num(get(r, "fee"))
            realized_funding = num(get(r, "realized funding"))
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
                funding_usd = realized_funding if realized_funding != 0 else change

            net_usd = pnl_usd - fee_usd + funding_usd

            # skip noise rows
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

    rows.sort(key=lambda x: x.get("datetime", ""))
    return rows


# ------------------------------------------------------------
# Blofin Order History CSV -> rows
# Expected columns (common): Underlying Asset, Order Time, Status, Side, Filled, Avg Fill, Price, PNL, Fee, Order Options
# ------------------------------------------------------------
def parse_blofin_dt(dt_str: str) -> str:
    """
    Blofin often: MM/DD/YYYY HH:MM:SS
    Example: 01/09/2026 06:40:54
    """
    s = (dt_str or "").strip()
    if not s:
        return now_utc_iso()

    try:
        dt = datetime.strptime(s, "%m/%d/%Y %H:%M:%S")
        dt = dt.replace(tzinfo=timezone.utc)
        return dt.isoformat().replace("+00:00", "Z")
    except Exception:
        try:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        except Exception:
            return now_utc_iso()


def load_blofin_order_history_csv(path: Path) -> list[dict]:
    if not path.exists():
        print(f"Blofin CSV not found: {path}")
        return []

    rows = []
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        # normalize headers
        headers = [h.strip() for h in (reader.fieldnames or [])]
        hmap = {h.lower(): h for h in headers}

        def g(row, name):
            key = hmap.get(name.lower())
            return row.get(key, "") if key else ""

        for r in reader:
            status = (g(r, "Status") or "").strip().lower()
            if status and status != "filled":
                continue

            pnl_raw = (g(r, "PNL") or "").strip()
            # Skip rows without realized pnl (Blofin sometimes uses --)
            if pnl_raw in ("", "--", "—"):
                continue

            dt = parse_blofin_dt(g(r, "Order Time"))
            symbol = (g(r, "Underlying Asset") or g(r, "Symbol") or "").strip()
            side_raw = (g(r, "Side") or "").strip()
            side = "SELL" if "sell" in side_raw.lower() else "BUY"

            qty = num(g(r, "Filled"))
            price = num(g(r, "Avg Fill")) or num(g(r, "Price"))
            pnl_usd = num(pnl_raw)  # usually USDT
            fee_usd = abs(num(g(r, "Fee")))
            funding_usd = 0.0
            net_usd = pnl_usd - fee_usd + funding_usd

            # Build a stable tradeKey from multiple fields
            trade_key = f"BLOFIN|{g(r,'Order Time')}|{symbol}|{side_raw}|{qty}|{price}|{pnl_usd}|{fee_usd}"

            notes = (g(r, "Order Options") or g(r, "Order ID") or "").strip()

            rows.append({
                "datetime": dt,
                "exchange": "BLOFIN",
                "symbol": symbol,
                "marketType": "FUTURES",
                "side": side,
                "qty": float(qty),
                "price": float(price),
                "realizedPnlUsd": float(pnl_usd),
                "feesUsd": float(fee_usd),
                "fundingUsd": float(funding_usd),
                "netPnlUsd": float(net_usd),
                "notes": notes or "Blofin order history",
                "tradeKey": trade_key,
            })

    rows.sort(key=lambda x: x.get("datetime", ""))
    return rows


# ------------------------------------------------------------
# Optional API snapshot (Kraken Futures) — not required for Blofin CSV
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

    kraken_csv = Path(os.getenv("KRAKEN_FUTURES_ACCOUNT_LOG_CSV", str(KRAKEN_CSV_DEFAULT)))
    blofin_csv = Path(os.getenv("BLOFIN_ORDER_HISTORY_CSV", str(BLOFIN_CSV_DEFAULT)))

    print(f"Reading Kraken account-log CSV: {kraken_csv}")
    kraken_rows = load_kraken_account_log_csv(kraken_csv)

    print(f"Reading Blofin order-history CSV: {blofin_csv}")
    blofin_rows = load_blofin_order_history_csv(blofin_csv)

    # Merge + dedupe by tradeKey
    merged = []
    seen = set()
    for r in (kraken_rows + blofin_rows):
        k = r.get("tradeKey") or f"FALLBACK|{r.get('datetime')}|{r.get('exchange')}|{r.get('symbol')}|{r.get('netPnlUsd')}"
        if k in seen:
            continue
        seen.add(k)
        r["tradeKey"] = k
        merged.append(r)

    merged.sort(key=lambda x: x.get("datetime", ""))

    # Optional API snapshot (Kraken)
    key = os.getenv("KRAKEN_FUTURES_KEY", "").strip()
    secret = os.getenv("KRAKEN_FUTURES_SECRET", "").strip()

    open_positions = []
    accounts = {}
    if key and secret:
        print("Fetching Kraken API snapshot (open positions + accounts)...")
        open_positions = fetch_open_positions(key, secret)
        accounts = fetch_accounts(key, secret)

    write_json(
        merged,
        extra={
            "ok": True,
            "exchange": "kraken_futures+blofin",
            "synced_at": now_utc_iso(),
            "sources": {
                "kraken_rows": len(kraken_rows),
                "blofin_rows": len(blofin_rows),
            },
            "data": {
                "openPositions": open_positions,
                "accounts": accounts
            }
        }
    )

    print("DONE.")


if __name__ == "__main__":
    main()