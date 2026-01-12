/* ============================================================
   PnL Traden — PWA (Netlify-ready)
   - Live data: reads /data/pnl.json (synced by your laptop script)
   - Accurate PnL: CSV import (Kraken Futures account log / Blofin order history / Kraken trades.csv)
   ============================================================ */

const DATA_URL = "/data/pnl.json";        // ✅ Netlify path
const REFRESH_MS = 30_000;
const FX_CACHE_KEY = "pnl_fx_cache_v1";

// Dexie (IndexedDB)
const db = new Dexie("pnl_traden_db");
db.version(2).stores({
  trades: "++id, tradeKey, datetime, exchange, symbol, marketType, side, netPnlUsd"
});

// ---------- state ----------
const state = {
  fx: { usdToEur: null, asOf: null },
  currency: "USD",
  exchange: "ALL",
  marketType: "ALL",
  range: "12m",
  search: "",
  live: {
    ok: false,
    synced_at: null,
    fills: [],
    openPositions: [],
    accounts: {}
  },
  chartMode: "equity" // "equity" or "value" (later)
};

// ---------- DOM ----------
const els = {
  currency: document.getElementById("currency"),
  exchange: document.getElementById("exchange"),
  marketType: document.getElementById("marketType"),
  range: document.getElementById("range"),
  search: document.getElementById("search"),

  fxBadge: document.getElementById("fxBadge"),
  syncBadge: document.getElementById("syncBadge") || document.getElementById("dbBadge"), // fallback
  countBadge: document.getElementById("countBadge"),

  tabs: document.getElementById("tabs"),
  views: {
    dash: document.getElementById("view-dash"),
    monthly: document.getElementById("view-monthly"),
    trades: document.getElementById("view-trades"),
    import: document.getElementById("view-import"),
    live: document.getElementById("view-live") // may not exist yet
  },

  kpiNet: document.getElementById("kpiNet"),
  kpiFees: document.getElementById("kpiFees"),
  kpiWinrate: document.getElementById("kpiWinrate"),

  equityCanvas: document.getElementById("equityCanvas"),
  monthlyCanvas: document.getElementById("monthlyCanvas"),
  monthlyHint: document.getElementById("monthlyHint"),

  tradeRows: document.getElementById("tradeRows"),
  tradeCount: document.getElementById("tradeCount"),

  fileInput: document.getElementById("fileInput"),
  importBtn: document.getElementById("importBtn"),
  importStatus: document.getElementById("importStatus"),

  exportBtn: document.getElementById("exportBtn"),
  resetBtn: document.getElementById("resetBtn")
};

// If your HTML doesn't have a Live tab/view yet, we create a simple section inside dashboard
function ensureLiveContainer() {
  let box = document.getElementById("liveBox");
  if (!box) {
    box = document.createElement("div");
    box.id = "liveBox";
    box.className = "card";
    box.style.marginTop = "16px";
    box.innerHTML = `
      <div class="cardHeader">
        <div class="cardTitle">Live (API snapshot)</div>
        <div class="cardSub muted">Open posities + accounts. Realized PnL blijft via CSV import.</div>
      </div>
      <div class="cardBody">
        <div id="liveMeta" class="muted" style="margin-bottom:10px;"></div>
        <div style="display:grid;grid-template-columns:1fr;gap:14px;">
          <div>
            <div class="muted" style="margin-bottom:6px;">Open positions</div>
            <div class="tableWrap"><table class="table"><thead>
              <tr><th>Symbol</th><th>Side</th><th class="right">Size</th><th class="right">Price</th><th class="right">UnrealizedFunding</th></tr>
            </thead><tbody id="livePositionsRows"></tbody></table></div>
          </div>
          <div>
            <div class="muted" style="margin-bottom:6px;">Accounts (snapshot)</div>
            <div class="tableWrap"><table class="table"><thead>
              <tr><th>Key</th><th class="right">Balance</th></tr>
            </thead><tbody id="liveAccountsRows"></tbody></table></div>
          </div>
        </div>
      </div>
    `;
    // place under dashboard view
    const dash = document.getElementById("view-dash") || document.body;
    dash.appendChild(box);
  }
  return box;
}

// ---------- utils ----------
function parseNumber(x) {
  if (x === null || x === undefined) return 0;
  if (typeof x === "number") return isFinite(x) ? x : 0;
  let s = String(x).trim();
  if (!s || s === "--") return 0;
  s = s.replace(/^﻿/, "");
  const m = s.match(/-?[0-9][0-9.,]*/);
  if (!m) return 0;
  let token = m[0];
  if (token.includes(",") && token.includes(".")) token = token.replace(/,/g, "");
  else if (token.includes(",") && !token.includes(".")) token = token.replace(",", ".");
  const n = Number(token);
  return isFinite(n) ? n : 0;
}

function formatMoney(amount, currency) {
  const fmt = new Intl.NumberFormat("nl-NL", { style: "currency", currency, maximumFractionDigits: 2 });
  return fmt.format(amount || 0);
}
function formatPct(x) {
  const fmt = new Intl.NumberFormat("nl-NL", { style: "percent", maximumFractionDigits: 1 });
  return fmt.format(x || 0);
}
function pnlClass(x) { return x >= 0 ? "pos" : "neg"; }

function rangeCutoffIso(range, nowRef) {
  const now = nowRef instanceof Date ? nowRef : new Date();
  if (range === "all") return null;
  const mapDays = { "24h": 1, "1w": 7, "2w": 14, "7d": 7, "1m": 30, "30d": 30, "3m": 90, "6m": 182, "1y": 365, "12m": 365 };
  const days = mapDays[range] ?? 365;
  return new Date(now.getTime() - days * 86400000).toISOString();
}

function convertUsdToSelected(usd) {
  if (state.currency === "USD") return usd;
  const r = state.fx.usdToEur;
  if (!r) return usd;
  return usd * r;
}
function convertedLabel() { return state.currency; }

// ---------- FX ----------
async function fetchFxRate() {
  const cached = localStorage.getItem(FX_CACHE_KEY);
  if (cached) {
    try { state.fx = JSON.parse(cached) || state.fx; } catch {}
  }
  try {
    const res = await fetch("https://api.exchangerate.host/latest?base=USD&symbols=EUR");
    if (!res.ok) throw new Error("FX fetch failed");
    const data = await res.json();
    const rate = data?.rates?.EUR;
    if (rate) {
      state.fx = { usdToEur: rate, asOf: data?.date || new Date().toISOString().slice(0,10) };
      localStorage.setItem(FX_CACHE_KEY, JSON.stringify(state.fx));
    }
  } catch {}
  if (els.fxBadge) {
    els.fxBadge.textContent = state.fx.usdToEur
      ? `FX: 1 USD = ${state.fx.usdToEur.toFixed(4)} EUR (${state.fx.asOf})`
      : "FX: offline";
  }
}

// ---------- remote pnl.json loader ----------
async function fetchLiveJson() {
  try {
    const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    // Accept multiple shapes:
    // A) { generated_at, rows:[...] }
    // B) { synced_at, ok, data:{ fills:{fills:[]}, openPositions:[], accounts:{} } }
    // C) { synced_at, ok, rows:[...] } etc

    state.live.ok = !!(j.ok ?? true);
    state.live.synced_at = j.synced_at || j.generated_at || null;

    // rows can exist at top level
    const rows = Array.isArray(j.rows) ? j.rows : null;

    // fills/openPositions/accounts may exist nested
    const fills = j?.data?.fills?.fills || j?.fills || [];
    const openPositions = j?.data?.openPositions || j?.openPositions || [];
    const accounts = j?.data?.accounts || j?.accounts || {};

    state.live.fills = Array.isArray(fills) ? fills : [];
    state.live.openPositions = Array.isArray(openPositions) ? openPositions : [];
    state.live.accounts = accounts && typeof accounts === "object" ? accounts : {};

    // If rows exist, ingest them (this is the “best” case)
    if (rows && rows.length) {
      await upsertTrades(rows.map(sanitizeRow));
      if (els.syncBadge) els.syncBadge.textContent = `Sync OK (+${rows.length})`;
    } else {
      // no rows (normal if you only synced fills/accounts)
      if (els.syncBadge) els.syncBadge.textContent = `Sync OK (+0)`;
    }
  } catch (e) {
    if (els.syncBadge) els.syncBadge.textContent = "Sync: offline/failed";
  }
}

// Make sure row has required keys
function sanitizeRow(r) {
  const out = { ...r };
  out.tradeKey = String(out.tradeKey || `${out.exchange||"X"}|${out.datetime||Date.now()}|${out.symbol||""}|${Math.random()}`);
  out.datetime = String(out.datetime || new Date().toISOString());
  out.exchange = String(out.exchange || "UNKNOWN");
  out.symbol = String(out.symbol || "");
  out.marketType = String(out.marketType || "UNKNOWN");
  out.side = String(out.side || "");
  out.qty = parseNumber(out.qty);
  out.price = parseNumber(out.price);
  out.realizedPnlUsd = parseNumber(out.realizedPnlUsd);
  out.feesUsd = parseNumber(out.feesUsd);
  out.fundingUsd = parseNumber(out.fundingUsd);
  out.netPnlUsd = parseNumber(out.netPnlUsd);
  out.notes = String(out.notes || "");
  return out;
}

// ---------- DB upsert (dedupe by tradeKey) ----------
async function upsertTrades(rows) {
  const existing = await db.trades.toArray();
  const keySet = new Set(existing.map(x => x.tradeKey));
  const toAdd = rows.filter(r => r && r.tradeKey && !keySet.has(r.tradeKey));
  if (toAdd.length) await db.trades.bulkAdd(toAdd);
  return { added: toAdd.length, skipped: rows.length - toAdd.length };
}

// ---------- CSV import (kept simple: use your existing formats) ----------
function parseCsv(text) {
  const rows = [];
  let i = 0, field = "", row = [], inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    } else {
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { row.push(field); field = ""; i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      if (c === '\r') { i++; continue; }
      field += c; i++; continue;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function rowsToObjects(rows) {
  const headers = rows[0].map((h,i) => {
    let t = (h ?? "").toString().trim();
    if (i===0) t = t.replace(/^﻿/, "");
    return t;
  });
  const objs = [];
  for (let r = 1; r < rows.length; r++) {
    const arr = rows[r];
    if (arr.length === 1 && arr[0].trim() === "") continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) obj[headers[c]] = (arr[c] ?? "").trim();
    objs.push(obj);
  }
  return { headers, objs };
}

function detectCsvType(headers) {
  const h = headers.map(x => x.trim().replace(/^﻿/, "").toLowerCase());
  // Blofin order history
  if (h.includes("underlying asset") && h.includes("order time") && h.includes("pnl") && h.includes("fee")) return "BLOFIN_ORDER_HISTORY";
  // Kraken spot/futures trades.csv
  if (h.includes("txid") && h.includes("pair") && h.includes("time")) return "KRAKEN_TRADES";
  // Kraken Futures account log CSV (the one from futures.kraken.com -> Trade -> History -> Logs -> Download All)
  if (h.includes("uid") && h.includes("datetime") && h.includes("type") && h.includes("realized pnl")) return "KRAKEN_FUTURES_ACCOUNT_LOG";
  return "UNKNOWN";
}

// Blofin -> realized pnl/fee (USDT ~ USD)
function toIsoDateTimeFromBlofin(mdy) {
  const m = String(mdy).match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [_, mm, dd, yyyy, HH, MM, SS] = m;
  return new Date(Date.UTC(+yyyy, +mm-1, +dd, +HH, +MM, +SS)).toISOString();
}
function toIsoFromUnixSeconds(sec) {
  const n = parseNumber(sec);
  if (!n) return null;
  return new Date(n * 1000).toISOString();
}

function normalizeBlofin(objs) {
  const out = [];
  for (const o of objs) {
    if ((o["Status"] || "").toLowerCase() !== "filled") continue;
    const pnlRaw = (o["PNL"] || "").trim();
    if (!pnlRaw || pnlRaw === "--") continue;
    const datetime = toIsoDateTimeFromBlofin(o["Order Time"]);
    if (!datetime) continue;

    const symbol = (o["Underlying Asset"] || "").trim();
    const sideRaw = (o["Side"] || "");
    const side = sideRaw.toLowerCase().includes("sell") ? "SELL" : "BUY";
    const qty = parseNumber(o["Filled"]);
    const price = parseNumber(o["Avg Fill"]) || parseNumber(o["Price"]);
    const pnlUsd = parseNumber(o["PNL"]);
    const feeUsd = Math.abs(parseNumber(o["Fee"]));
    const fundingUsd = 0;
    const netUsd = pnlUsd - feeUsd + fundingUsd;

    out.push({
      datetime,
      exchange: "BLOFIN",
      symbol,
      marketType: "FUTURES",
      side,
      qty,
      price,
      realizedPnlUsd: pnlUsd,
      feesUsd: feeUsd,
      fundingUsd,
      netPnlUsd: netUsd,
      notes: (o["Order Options"] || o["Status"] || ""),
      tradeKey: `BLOFIN|${o["Order Time"]}|${symbol}|${side}|${qty}|${price}|${pnlUsd}|${feeUsd}`
    });
  }
  return out;
}

function normalizeKrakenTrades(objs) {
  const out = [];
  for (const o of objs) {
    const datetime = o["time"] ? toIsoFromUnixSeconds(o["time"]) : null;
    if (!datetime) continue;
    const symbol = String(o["pair"] || o["symbol"] || "");
    const type = String(o["type"] || o["side"] || "");
    const side = type.toLowerCase().includes("sell") ? "SELL" : "BUY";
    const qty = parseNumber(o["vol"] || o["qty"] || o["volume"]);
    const price = parseNumber(o["price"] || o["avgPrice"]);
    const feeUsd = Math.abs(parseNumber(o["fee"]));
    const netUsd = parseNumber(o["net"] || 0);

    out.push({
      datetime,
      exchange: "KRAKEN",
      symbol,
      marketType: "SPOT",
      side,
      qty,
      price,
      realizedPnlUsd: 0,
      feesUsd: feeUsd,
      fundingUsd: 0,
      netPnlUsd: netUsd,
      notes: String(o["txid"] || ""),
      tradeKey: `KRAKEN|${o["txid"]}|${datetime}|${symbol}|${qty}|${price}|${netUsd}`
    });
  }
  return out;
}

function normalizeKrakenFuturesAccountLog(objs) {
  // Based on the CSV you showed (uid,dateTime,account,type,...,realized pnl,fee,realized funding,...)
  const out = [];
  for (const o of objs) {
    const dtStr = (o["dateTime"] || o["datetime"] || "").trim();
    if (!dtStr) continue;

    // CSV time looks like: 11/Jan/2026 21:24:14 (as in your screenshot)
    // We'll store as-is if parse fails; app still sorts ok-ish, but best effort:
    let datetimeIso = null;
    const m = dtStr.match(/^(\d{1,2})\/([A-Za-z]{3})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
    if (m) {
      const monMap = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
      const dd = +m[1], mon = monMap[m[2]] ?? 0, yyyy = +m[3], HH = +m[4], MM = +m[5], SS = +m[6];
      datetimeIso = new Date(Date.UTC(yyyy, mon, dd, HH, MM, SS)).toISOString();
    } else {
      datetimeIso = new Date().toISOString();
    }

    const type = String(o["type"] || "").toLowerCase();
    const isTrade = type.includes("futures trade");
    const isFunding = type.includes("funding rate change");

    const symbol = String(o["contract"] || o["symbol"] || "").trim();
    const pnlUsd = isTrade ? parseNumber(o["realized pnl"]) : 0;
    const feeUsd = isTrade ? Math.abs(parseNumber(o["fee"])) : 0;
    const fundingUsd = isFunding ? parseNumber(o["realized funding"] || o["change"]) : 0;

    const netUsd = pnlUsd - feeUsd + fundingUsd;

    out.push({
      datetime: datetimeIso,
      exchange: "KRAKEN",
      symbol,
      marketType: "FUTURES",
      side: (o["type"] || "").toUpperCase(),
      qty: 0,
      price: parseNumber(o["trade price"] || 0),
      realizedPnlUsd: pnlUsd,
      feesUsd: feeUsd,
      fundingUsd,
      netPnlUsd: netUsd,
      notes: String(o["uid"] || ""),
      tradeKey: `KRAKENF|${o["uid"] || (datetimeIso + "|" + symbol + "|" + netUsd)}`
    });
  }
  return out;
}

async function importCsvFile(file) {
  const text = await file.text();
  const rows = parseCsv(text);
  if (!rows.length) return { ok:false, msg:"Leeg bestand." };
  const { headers, objs } = rowsToObjects(rows);
  const type = detectCsvType(headers);

  let normalized = [];
  if (type === "BLOFIN_ORDER_HISTORY") normalized = normalizeBlofin(objs);
  else if (type === "KRAKEN_TRADES") normalized = normalizeKrakenTrades(objs);
  else if (type === "KRAKEN_FUTURES_ACCOUNT_LOG") normalized = normalizeKrakenFuturesAccountLog(objs);
  else return { ok:false, msg:`Onbekend CSV formaat (${headers.slice(0,6).join(", ")}...)` };

  const res = await upsertTrades(normalized.map(sanitizeRow));
  return { ok:true, type, ...res };
}

// ---------- aggregation ----------
async function getFilteredTrades() {
  let items = await db.trades.toArray();
  const nowRef = items.length ? new Date(items.reduce((m,t)=> (t.datetime>m?t.datetime:m), items[0].datetime)) : new Date();
  const cutoff = rangeCutoffIso(state.range, nowRef);

  if (cutoff) items = items.filter(t => t.datetime >= cutoff);
  if (state.exchange !== "ALL") items = items.filter(t => t.exchange === state.exchange);
  if (state.marketType !== "ALL") items = items.filter(t => t.marketType === state.marketType);

  const q = (state.search || "").trim().toLowerCase();
  if (q) items = items.filter(t =>
    (t.symbol||"").toLowerCase().includes(q) ||
    (t.notes||"").toLowerCase().includes(q) ||
    (t.tradeKey||"").toLowerCase().includes(q)
  );

  items.sort((a,b)=> (a.datetime < b.datetime ? 1 : -1));
  return items;
}

function aggregateKPIs(trades) {
  const net = trades.reduce((s,t)=> s + (t.netPnlUsd||0), 0);
  const fees = trades.reduce((s,t)=> s + (t.feesUsd||0), 0);
  const wins = trades.filter(t => (t.netPnlUsd||0) > 0).length;
  const count = trades.length;
  return { net, fees, wins, count, winrate: count ? wins/count : 0 };
}

// ---------- charts (simple canvas) ----------
function clearCanvas(ctx){ ctx.clearRect(0,0,ctx.canvas.width,ctx.canvas.height); }

function drawLineChart(canvas, points, { yLabel="" } = {}) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  clearCanvas(ctx);

  if (!points.length) {
    ctx.fillStyle = "rgba(229,231,235,.8)";
    ctx.font = "14px system-ui";
    ctx.fillText("Geen data (importeer CSV).", 16, 32);
    return;
  }

  const pad = 50;
  const xs = points.map(p => new Date(p.x).getTime());
  const ys = points.map(p => p.y);

  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const ymin = Math.min(...ys), ymax = Math.max(...ys);
  const yPad = (ymax - ymin) * 0.08 || 1;
  const y0 = ymin - yPad, y1 = ymax + yPad;

  const X = (t)=> pad + (t - xmin) / (xmax - xmin || 1) * (w - pad*1.2);
  const Y = (v)=> h - pad - (v - y0) / (y1 - y0 || 1) * (h - pad*1.4);

  // grid
  ctx.strokeStyle = "rgba(154,164,178,.15)";
  ctx.lineWidth = 1;
  for (let i=0;i<5;i++){
    const y = pad + i*(h - pad*1.4)/4;
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - pad*0.2, y); ctx.stroke();
  }

  ctx.fillStyle = "rgba(154,164,178,.8)";
  ctx.font = "12px system-ui";
  ctx.fillText(yLabel, 12, 18);

  // line
  ctx.strokeStyle = "rgba(34,197,94,.9)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i=0;i<points.length;i++){
    const x = X(xs[i]), y = Y(ys[i]);
    if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  }
  ctx.stroke();

  // zero line
  const yZero = Y(0);
  ctx.strokeStyle = "rgba(239,68,68,.25)";
  ctx.beginPath(); ctx.moveTo(pad, yZero); ctx.lineTo(w - pad*0.2, yZero); ctx.stroke();
}

function monthlyBuckets(trades, nowRef) {
  const now = nowRef instanceof Date ? nowRef : new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const months = [];
  for (let i=11;i>=0;i--){
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth()-i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`;
    months.push({ key, label:key, net:0 });
  }
  const map = new Map(months.map(m=>[m.key,m]));
  for (const t of trades) {
    const d = new Date(t.datetime);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`;
    const m = map.get(key);
    if (m) m.net += (t.netPnlUsd||0);
  }
  return months;
}

function drawBarChart(canvas, buckets) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  clearCanvas(ctx);

  if (!buckets.length) return;

  const pad = 50;
  const vals = buckets.map(b=>b.net);
  const vmax = Math.max(...vals, 0);
  const vmin = Math.min(...vals, 0);
  const span = (vmax - vmin) || 1;

  const Y = (v)=> h - pad - (v - vmin) / span * (h - pad*1.4);

  ctx.strokeStyle = "rgba(154,164,178,.15)";
  ctx.lineWidth = 1;
  for (let i=0;i<5;i++){
    const y = pad + i*(h - pad*1.4)/4;
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - pad*0.2, y); ctx.stroke();
  }

  const barW = (w - pad*1.2) / buckets.length;
  for (let i=0;i<buckets.length;i++){
    const b = buckets[i];
    const x = pad + i*barW + barW*0.15;
    const bw = barW*0.7;
    const y0 = Y(0);
    const yv = Y(b.net);
    const top = Math.min(y0, yv);
    const bh = Math.abs(y0 - yv);
    ctx.fillStyle = b.net >= 0 ? "rgba(34,197,94,.85)" : "rgba(239,68,68,.85)";
    ctx.fillRect(x, top, bw, bh);
  }

  ctx.fillStyle = "rgba(154,164,178,.9)";
  ctx.font = "11px system-ui";
  for (let i=0;i<buckets.length;i+=2){
    const x = pad + i*barW + barW*0.1;
    ctx.fillText(buckets[i].label.slice(2), x, h - 18);
  }
}

// ---------- render ----------
function setKpi(el, valueText, goodBad=null, subText=null) {
  if (!el) return;
  el.classList.remove("good","bad");
  if (goodBad === "good") el.classList.add("good");
  if (goodBad === "bad") el.classList.add("bad");
  const v = el.querySelector(".value");
  const s = el.querySelector(".sub");
  if (v) v.textContent = valueText;
  if (s && subText !== null) s.textContent = subText;
}

function renderLiveBox() {
  const box = ensureLiveContainer();
  const meta = document.getElementById("liveMeta");
  const posRows = document.getElementById("livePositionsRows");
  const accRows = document.getElementById("liveAccountsRows");

  const when = state.live.synced_at ? new Date(state.live.synced_at).toLocaleString("nl-NL") : "—";
  if (meta) meta.textContent = `Laatste sync: ${when} • fills: ${state.live.fills.length} • open pos: ${state.live.openPositions.length}`;

  if (posRows) {
    posRows.innerHTML = (state.live.openPositions || []).slice(0, 50).map(p => {
      const sym = p.symbol || "";
      const side = p.side || "";
      const size = parseNumber(p.size);
      const price = parseNumber(p.price);
      const uf = parseNumber(p.unrealizedFunding);
      return `<tr>
        <td>${sym}</td>
        <td>${side}</td>
        <td class="right mono">${size.toFixed(4)}</td>
        <td class="right mono">${price.toFixed(4)}</td>
        <td class="right mono">${uf.toFixed(4)}</td>
      </tr>`;
    }).join("") || `<tr><td colspan="5" class="muted">Geen open positions in snapshot.</td></tr>`;
  }

  if (accRows) {
    const keys = Object.keys(state.live.accounts || {}).slice(0, 30);
    accRows.innerHTML = keys.map(k => {
      const v = state.live.accounts[k];
      // try balance-like fields
      const bal = (v && typeof v === "object")
        ? (v.cash?.balance ?? v.balance ?? v.cash ?? "")
        : v;
      return `<tr><td class="mono">${k}</td><td class="right mono">${String(bal)}</td></tr>`;
    }).join("") || `<tr><td colspan="2" class="muted">Geen accounts data.</td></tr>`;
  }
}

async function renderAll() {
  const trades = await getFilteredTrades();
  const k = aggregateKPIs(trades);

  const netC = convertUsdToSelected(k.net);
  const feeC = convertUsdToSelected(k.fees);

  setKpi(els.kpiNet, formatMoney(netC, convertedLabel()), netC>=0 ? "good":"bad");
  setKpi(els.kpiFees, formatMoney(feeC, convertedLabel()));
  setKpi(els.kpiWinrate, formatPct(k.winrate), null, `${k.wins} / ${k.count}`);

  if (els.countBadge) els.countBadge.textContent = `${k.count} trades`;
  if (els.tradeCount) els.tradeCount.textContent = `${trades.length} trades`;

  // equity
  if (els.equityCanvas) {
    const tradesAsc = [...trades].sort((a,b)=> (a.datetime > b.datetime ? 1 : -1));
    let cum = 0;
    const pts = tradesAsc.map(t => {
      cum += (t.netPnlUsd||0);
      return { x: t.datetime, y: convertUsdToSelected(cum) };
    });
    drawLineChart(els.equityCanvas, pts, { yLabel: `Cumulatief (${convertedLabel()})` });
  }

  // monthly
  if (els.monthlyCanvas) {
    const nowRef = trades.length ? new Date(trades[0].datetime) : new Date();
    const bucketsUsd = monthlyBuckets(trades, nowRef);
    const buckets = bucketsUsd.map(b => ({ ...b, net: convertUsdToSelected(b.net) }));
    drawBarChart(els.monthlyCanvas, buckets);
    const net12 = buckets.reduce((s,b)=>s+b.net,0);
    if (els.monthlyHint) els.monthlyHint.textContent = `Som 12 maanden: ${formatMoney(net12, convertedLabel())}`;
  }

  // table
  if (els.tradeRows) {
    const rows = trades.slice(0, 500);
    els.tradeRows.innerHTML = rows.map(t => {
      const dtLabel = new Date(t.datetime).toLocaleString("nl-NL", { year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" });
      const fees = convertUsdToSelected(t.feesUsd || 0);
      const pnl = convertUsdToSelected(t.realizedPnlUsd || 0);
      const net = convertUsdToSelected(t.netPnlUsd || 0);
      return `<tr>
        <td class="mono">${dtLabel}</td>
        <td>${t.exchange}</td>
        <td>${t.symbol}</td>
        <td>${t.marketType}</td>
        <td>${t.side}</td>
        <td class="right mono">${(t.qty ?? 0).toFixed(4)}</td>
        <td class="right mono">${(t.price ?? 0).toFixed(4)}</td>
        <td class="right mono">${formatMoney(fees, convertedLabel())}</td>
        <td class="right mono ${pnlClass(pnl)}">${formatMoney(pnl, convertedLabel())}</td>
        <td class="right mono ${pnlClass(net)}">${formatMoney(net, convertedLabel())}</td>
        <td class="mono muted">${String(t.notes||"").slice(0,40)}</td>
      </tr>`;
    }).join("");
  }

  renderLiveBox();
}

// ---------- UI wiring ----------
function setActiveTab(tab) {
  const tabs = els.tabs?.querySelectorAll?.(".tab") || [];
  tabs.forEach(el => el.classList.toggle("active", el.dataset.tab === tab));

  // hide views
  for (const [k,v] of Object.entries(els.views || {})) {
    if (v) v.style.display = (k === tab) ? "" : "none";
  }
}

els.tabs?.addEventListener("click", (e) => {
  const t = e.target.closest(".tab");
  if (!t) return;
  setActiveTab(t.dataset.tab);
});

els.currency?.addEventListener("change", async () => { state.currency = els.currency.value; await renderAll(); });
els.exchange?.addEventListener("change", async () => { state.exchange = els.exchange.value; await renderAll(); });
els.marketType?.addEventListener("change", async () => { state.marketType = els.marketType.value; await renderAll(); });
els.range?.addEventListener("change", async () => { state.range = els.range.value; await renderAll(); });
els.search?.addEventListener("input", async () => { state.search = els.search.value; await renderAll(); });

els.importBtn?.addEventListener("click", async () => {
  const f = els.fileInput?.files?.[0];
  if (!f) { if (els.importStatus) els.importStatus.textContent = "Kies eerst een CSV."; return; }
  if (els.importStatus) els.importStatus.textContent = "Importeren…";
  try {
    const res = await importCsvFile(f);
    if (els.importStatus) els.importStatus.textContent = res.ok
      ? `OK: ${res.type} • +${res.added} • ${res.skipped} overgeslagen`
      : `Error: ${res.msg}`;
    await renderAll();
  } catch {
    if (els.importStatus) els.importStatus.textContent = "Error: import mislukt.";
  }
});

els.exportBtn?.addEventListener("click", async () => {
  const trades = await db.trades.toArray();
  const headers = ["datetime","exchange","symbol","marketType","side","qty","price","realizedPnlUsd","feesUsd","fundingUsd","netPnlUsd","notes","tradeKey"];
  const lines = [headers.join(",")].concat(trades.map(t => headers.map(h => `"${String(t[h] ?? "").replace(/"/g,'""')}"`).join(",")));
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `pnl_trades_export_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

els.resetBtn?.addEventListener("click", async () => {
  if (!confirm("Weet je zeker dat je alle lokale data wilt wissen?")) return;
  await db.trades.clear();
  await renderAll();
});

// ---------- boot ----------
(async function init(){
  await fetchFxRate();

  // defaults from UI if present
  if (els.currency) state.currency = els.currency.value;
  if (els.exchange) state.exchange = els.exchange.value;
  if (els.marketType) state.marketType = els.marketType.value;
  if (els.range) state.range = els.range.value;

  await fetchLiveJson();
  await renderAll();

  // auto refresh
  setInterval(async () => {
    await fetchFxRate();
    await fetchLiveJson();
    await renderAll();
  }, REFRESH_MS);
})();