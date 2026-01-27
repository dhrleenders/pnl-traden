/**
 * Cloudflare Pages Function
 * GET /api/coach-feed
 *
 * Uses Kraken Futures REST v3: GET https://futures.kraken.com/derivatives/api/v3/fills
 * Optional query: lastFillTime (string)
 *
 * Secrets (Cloudflare Pages -> Settings -> Environment variables -> Secrets):
 * - KRAKEN_FUTURES_API_KEY
 * - KRAKEN_FUTURES_API_SECRET   (base64 string as shown in Kraken UI)
 */
function b64ToBytes(b64){
  // atob works in Workers. Normalize padding.
  const s = b64.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes){
  let bin = "";
  for(let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
async function sha256Bytes(str){
  const buf = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return new Uint8Array(digest);
}
async function hmacSha512(keyBytes, msgBytes){
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, msgBytes);
  return new Uint8Array(sig);
}
function buildQuery(params){
  const usp = new URLSearchParams();
  Object.entries(params || {}).forEach(([k,v])=>{
    if(v==null || v==="") return;
    usp.set(k, String(v));
  });
  return usp.toString(); // already url-encoded
}

/**
 * Authent per Kraken Futures REST guide:
 * 1) msg = postData + nonce + endpointPath
 * 2) sha256(msg)
 * 3) hmac-sha512(secret_b64_decoded, sha256_digest)
 * 4) base64(hmac)
 */
async function makeAuthent({ secretB64, nonce, endpointPath, postData }){
  const msg = `${postData}${nonce}${endpointPath}`;
  const sha = await sha256Bytes(msg);
  const secretBytes = b64ToBytes(secretB64);
  const sig = await hmacSha512(secretBytes, sha);
  return bytesToB64(sig);
}

function normalizeFill(f){
  // Field names differ slightly across docs/clients; keep it defensive.
  const t = f.fillTime || f.time || f.timestamp || f.createdTime || f.created_at || f.date;
  const ts = t ? Date.parse(t) : (f.fillTimeMs || f.timeMs || f.ts || null);
  return {
    id: String(f.fill_id || f.fillId || f.uid || f.execId || f.executionId || f.tradeId || `${t||""}|${f.symbol||""}|${f.order_id||f.orderId||""}|${f.price||""}|${f.size||f.qty||""}`),
    ts: ts || null,
    timeISO: t || (ts ? new Date(ts).toISOString() : null),
    exchange: "kraken_futures",
    symbol: f.symbol || f.instrument || f.product || null,
    side: (f.side || f.direction || "").toLowerCase(),
    price: f.price != null ? Number(f.price) : null,
    qty: f.size != null ? Number(f.size) : (f.qty != null ? Number(f.qty) : null),
    fee: f.fee != null ? Number(f.fee) : null,
    orderId: f.order_id || f.orderId || null
  };
}

export async function onRequestGet(context){
  const { request, env } = context;
  const apiKey = env.KRAKEN_FUTURES_API_KEY;
  const apiSecret = env.KRAKEN_FUTURES_API_SECRET;

  if(!apiKey || !apiSecret){
    return new Response(JSON.stringify({
      error: "Missing Cloudflare secrets. Set KRAKEN_FUTURES_API_KEY and KRAKEN_FUTURES_API_SECRET in Cloudflare Pages -> Settings -> Environment variables (Secrets)."
    }), { status: 500, headers: { "content-type":"application/json" }});
  }

  const url = new URL(request.url);
  const lastFillTime = url.searchParams.get("lastFillTime") || "";
  const endpointPath = "/api/v3/fills";
  const query = buildQuery(lastFillTime ? { lastFillTime } : {});
  const postData = query; // for GET, params are in URL query string
  const nonce = String(Date.now());
  const authent = await makeAuthent({ secretB64: apiSecret, nonce, endpointPath, postData });

  const upstreamUrl = `https://futures.kraken.com/derivatives${endpointPath}${query ? `?${query}` : ""}`;
  const res = await fetch(upstreamUrl, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "APIKey": apiKey,
      "Nonce": nonce,
      "Authent": authent,
      "User-Agent": "pnl-traden-coach/1.0"
    }
  });

  const rawText = await res.text();
  let data = null;
  try{ data = JSON.parse(rawText); }catch(_){}

  if(!res.ok){
    return new Response(JSON.stringify({
      error: "Upstream error from Kraken Futures",
      status: res.status,
      body: data || rawText
    }), { status: 502, headers: { "content-type":"application/json" }});
  }

  const fills = (data && (data.fills || data.fill || data.result?.fills)) || [];
  const events = Array.isArray(fills) ? fills.map(normalizeFill).filter(x=>x.ts!=null) : [];
  events.sort((a,b)=> (b.ts||0) - (a.ts||0));

  const cursor = events.length ? (events[events.length-1].timeISO || "") : (lastFillTime || "");

  return new Response(JSON.stringify({
    source: "kraken_futures",
    asOf: Date.now(),
    cursor,
    events,
    raw: data
  }), {
    status: 200,
    headers: {
      "content-type":"application/json",
      "cache-control":"no-store"
    }
  });
}
