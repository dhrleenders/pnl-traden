import crypto from "node:crypto";

function hmacSha256Base64(secretBase64, message) {
  const key = Buffer.from(secretBase64, "base64");
  return crypto.createHmac("sha256", key).update(message).digest("base64");
}

function normalizeFill(fill) {
  const ts = fill.fillTime || fill.time || fill.timestamp || fill.createdAt || Date.now();
  const symbol = fill.symbol || fill.instrument || fill.productId || fill.pair || "UNKNOWN";
  const sideRaw = (fill.side || fill.buySell || fill.direction || "").toString().toLowerCase();
  const side =
    sideRaw === "buy" || sideRaw === "sell"
      ? sideRaw
      : (Number(fill.qty ?? fill.size ?? 0) >= 0 ? "buy" : "sell");

  const price = Number(fill.price ?? fill.fillPrice ?? fill.executionPrice ?? fill.avgPrice ?? 0);
  const qty = Math.abs(Number(fill.qty ?? fill.size ?? fill.quantity ?? fill.contracts ?? fill.amount ?? 0));
  const fee = Number(fill.fee ?? fill.commission ?? 0);
  const orderId = fill.orderId || fill.clientOrderId || fill.order_id || null;
  const fillId = fill.fillId || fill.tradeId || fill.executionId || fill.fill_id || null;

  return { ts:Number(ts), exchange:"kraken-futures", symbol:String(symbol), side, price, qty, fee, orderId, fillId };
}

export async function onRequestGet({ request, env }) {
  try {
    const key = env.KRAKEN_FUTURES_API_KEY;
    const secret = env.KRAKEN_FUTURES_API_SECRET;

    if (!key || !secret) {
      return new Response(JSON.stringify({
        ok:false,
        error:"Missing secrets. Set KRAKEN_FUTURES_API_KEY and KRAKEN_FUTURES_API_SECRET in Cloudflare Pages."
      }), { status: 500, headers: { "content-type":"application/json" } });
    }

    const url = new URL(request.url);
    const lastFillTime = url.searchParams.get("lastFillTime");

    const endpointPath = "/derivatives/api/v3/fills";
    const qs = lastFillTime ? `?lastFillTime=${encodeURIComponent(lastFillTime)}` : "";
    const fullPath = `${endpointPath}${qs}`;
    const apiUrl = `https://futures.kraken.com${fullPath}`;

    const nonce = Date.now().toString();
    const payload = nonce + fullPath;
    const sig = hmacSha256Base64(secret, payload);

    const res = await fetch(apiUrl, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "API-Key": key,
        "API-Sign": sig,
        "API-Nonce": nonce
      }
    });

    const txt = await res.text();
    let data = null;
    try { data = JSON.parse(txt); } catch {}

    if (!res.ok) {
      return new Response(JSON.stringify({
        ok:false,
        status: res.status,
        error: (data && (data.error || data.message)) || txt || "API error"
      }), { status: 502, headers: { "content-type":"application/json" } });
    }

    const fills = (data && (data.fills || (data.result && data.result.fills) || data.data)) || [];
    const events = Array.isArray(fills) ? fills.map(normalizeFill).filter(e => e.qty > 0 && e.price > 0) : [];
    const next = (data && (data.lastFillTime || data.nextLastFillTime)) || (events.length ? events[events.length-1].ts : null);

    return new Response(JSON.stringify({
      ok:true,
      asOf: Date.now(),
      nextLastFillTime: next ? Number(next) : null,
      events
    }), { status: 200, headers: { "content-type":"application/json" } });

  } catch (e) {
    return new Response(JSON.stringify({ ok:false, error: String(e?.message || e) }), {
      status: 500,
      headers: { "content-type":"application/json" }
    });
  }
}
