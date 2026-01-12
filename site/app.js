/* ============================================================
   PnL Traden — FIXED app.js (Kraken Futures Account Log + JSON sync)
   - Auto-load latest /data/pnl.json (Netlify/GitHub pages)
   - Import CSV: Kraken Futures Account Log (exact headers you showed)
   - Shows Realized PnL / Fees / Funding / Net in UI + charts
   ============================================================ */

/* global Dexie */

const DATA_URL = "/data/pnl.json";         // Netlify: https://<site>.netlify.app/data/pnl.json
const REFRESH_MS = 30_000;
const FX_CACHE_KEY = "pnl_fx_cache_v1";

const db = new Dexie("pnl_traden_db");
db.version(2).stores({
  trades: "++id, tradeKey, datetime, exchange, symbol, marketType, side, netPnlUsd"
});

const state = {
  fx: { usdToEur: null, asOf: null },
  currency: "USD",
  exchange: "ALL",
  marketType: "ALL",
  range: "12m",
  search: ""
};

const els = {
  currency: document.getElementById("currency"),
  exchange: document.getElementById("exchange"),
  marketType: document.getElementById("marketType"),
  range: document.getElementById("range"),
  summaryLine: document.getElementById("summaryLine"),
  fxBadge: document.getElementById("fxBadge"),
  dbBadge: document.getElementById("dbBadge"),
  exportBtn: document.getElementById("exportBtn"),
  resetBtn: document.getElementById("resetBtn"),

  tabs: document.getElementById("tabs"),
  views: {
    dash: document.getElementById("view-dash"),
    monthly: document.getElementById("view-monthly"),
    trades: document.getElementById("view-trades"),
    import: document.getElementById("view-import")
  },

  kpiNet: document.getElementById("kpiNet"),
  kpiFees: document.getElementById("kpiFees"),
  kpiWinrate: document.getElementById("kpiWinrate"),
  countBadge: document.getElementById("countBadge"),
  equityCanvas: document.getElementById("equityCanvas"),
  monthlyCanvas: document.getElementById("monthlyCanvas"),
  monthlyHint: document.getElementById("monthlyHint"),

  search: document.getElementById("search"),
  tradeRows: document.getElementById("tradeRows"),
  tradeCount: document.getElementById("tradeCount"),

  fileInput: document.getElementById("fileInput"),
  importBtn: document.getElementById("importBtn"),
  importStatus: document.getElementById("importStatus"),
  loadSamplesBtn: document.getElementById("loadSamplesBtn"),
  sampleStatus: document.getElementById("sampleStatus")
};

// ----------------- Utils -----------------
function safeText(s) { return (s ?? "").toString(); }

function parseNumber(x) {
  if (x === null || x === undefined) return 0;
  if (typeof x === "number") return isFinite(x) ? x : 0;
  let s = String(x).trim();
  if (!s || s === "--") return 0;
  s = s.replace(/^﻿/, ""); // BOM
  const m = s.match(/-?[0-9][0-9.,]*/);
  if (!m) return 0;
  let token = m[0];
  if (token.includes(",") && token.includes(".")) token = token.replace(/,/g, "");
  else if (token.includes(",") && !token.includes(".")) token = token.replace(",", ".");
  const n = Number(token);
  return isFinite(n) ? n : 0;
}

function formatMoney(amount, currency) {
  return new Intl.NumberFormat("nl-NL", {
    style: "currency",
    currency,
    maximumFractionDigits: 2
  }).format(amount);
}

function formatPct(x) {
  return new Intl.NumberFormat("nl-NL", {
    style: "percent",
    maximumFractionDigits: 1
  }).format(x);
}

function pnlClass(x) { return x >= 0 ? "pos" : "neg"; }

function convertUsdToSelected(usd) {
  if (state.currency === "USD") return usd;
  const r = state.fx.usdToEur;
  return r ? usd * r : usd;
}
function convertedLabel() { return state.currency; }

// Kraken Futures Account Log datetime sometimes is like: 11/Jan/2026 21:24:14
function parseKrakenFuturesDateTime(dtStrRaw) {
  const s = safeText(dtStrRaw).trim();
  if (!s) return null;

  // If it's already ISO-ish, let Date handle it
  if (s.includes("T")) {
    const d = new Date(s.endsWith("Z") ? s : (s + "Z"));
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  // Format: DD/Mon/YYYY HH:mm:ss
  const m = s.match(/^(\d{1,2})\/([A-Za-z]{3})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) {
    const d2 = new Date(s);
    return isNaN(d2.getTime()) ? null : d2.toISOString();
  }
  const dd = Number(m[1]);
  const mon = m[2].toLowerCase();
  const yyyy = Number(m[3]);
  const HH = Number(m[4]);
  const MM = Number(m[5]);
  const SS = Number(m[6]);

  const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  const mo = months[mon];
  if (mo === undefined) return null;

  // Kraken futures history timestamps are effectively UTC for our use; store as UTC ISO.
  const d = new Date(Date.UTC(yyyy, mo, dd, HH, MM, SS));
  return d.toISOString();
}

function rangeCutoffIso(range, nowRef) {
  const now = nowRef instanceof Date ? nowRef : new Date();
  if (range === "all") return null;
  const mapDays = {
    "24h": 1, "1w": 7, "2w": 14, "7d": 7,
    "1m": 30, "30d": 30, "3m": 90, "6m": 182,
    "1y": 365, "12m": 365
  };
  const days = mapDays[range] ?? 365;
  const cutoff = new Date(now.getTime() - days * 24 * 3600 * 1000);
  return cutoff.toISOString();
}

// ----------------- FX -----------------
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
      state.fx = { usdToEur: rate, asOf: data?.date || new Date().toISOString().slice(0, 10) };
      localStorage.setItem(FX_CACHE_KEY, JSON.stringify(state.fx));
    }
  } catch {}

  els.fxBadge.textContent = state.fx.usdToEur
    ? `FX: 1 USD = ${state.fx.usdToEur.toFixed(4)} EUR (${state.fx.asOf})`
    : "FX: offline";
}

// ----------------- CSV parsing -----------------
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
  const headers = rows[0].map((h, i) => {
    let t = (h ?? "").toString().trim();
    if (i === 0) t = t.replace(/^﻿/, "");
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

  // Kraken Futures Account Log (your exact header includes these)
  const isKrakenFutures =
    h.includes("uid") &&
    h.includes("datetime") &&
    h.includes("type") &&
    h.includes("realized pnl") &&
    h.includes("fee") &&
    h.includes("realized funding");

  if (isKrakenFutures) return "KRAKEN_FUTURES_ACCOUNT_LOG";

  return "UNKNOWN";
}

function normalizeKrakenFuturesAccountLog(objs) {
  // Based on your columns:
  // uid,dateTime,account,type,symbol,contract,change,new balance,new average entry price,trade price,mark price,funding rate,realized pnl,fee,realized funding,collateral,conversion spread percentage,liquidation fee,position uid

  const out = [];

  for (const o of objs) {
    const uid = safeText(o["uid"]).trim();
    const typeRaw = safeText(o["type"]).trim(); // e.g. "futures trade", "funding rate change", etc.
    const dtIso = parseKrakenFuturesDateTime(o["dateTime"] || o["datetime"]);
    if (!dtIso) continue;

    // We include rows that have any effect on PnL/funding/fees.
    const realizedPnl = parseNumber(o["realized pnl"]);
    const fee = Math.abs(parseNumber(o["fee"]));
    const realizedFunding = parseNumber(o["realized funding"]);
    const liqFee = Math.abs(parseNumber(o["liquidation fee"]));

    const hasEffect = (realizedPnl !== 0) || (fee !== 0) || (realizedFunding !== 0) || (liqFee !== 0);
    if (!hasEffect) continue;

    // symbol/contract
    const symbol = (safeText(o["contract"] || o["symbol"])).trim().toUpperCase();

    // Net: pnl - fees - liquidationFee + funding
    const net = realizedPnl - fee - liqFee + realizedFunding;

    const tradeKey = uid ? `KRAKENF|${uid}` : `KRAKENF|${dtIso}|${symbol}|${typeRaw}|${realizedPnl}|${fee}|${realizedFunding}|${liqFee}`;

    out.push({
      datetime: dtIso,
      exchange: "KRAKEN",
      symbol,
      marketType: "FUTURES",
      side: typeRaw.toUpperCase(),
      qty: 0,
      price: parseNumber(o["trade price"]),
      realizedPnlUsd: realizedPnl,
      feesUsd: fee + liqFee,
      fundingUsd: realizedFunding,
      netPnlUsd: net,
      notes: safeText(o["position uid"] || ""),
      tradeKey
    });
  }

  return out;
}

// ----------------- DB upsert -----------------
async function upsertTrades(rows) {
  if (!rows?.length) return { added: 0, skipped: 0 };

  // Build keyset from DB (tradeKey unique)
  const existing = await db.trades.toArray();
  const keySet = new Set(existing.map(x => x.tradeKey));

  const toAdd = rows.filter(r => r.tradeKey && !keySet.has(r.tradeKey));
  if (toAdd.length) await db.trades.bulkAdd(toAdd);

  return { added: toAdd.length, skipped: rows.length - toAdd.length };
}

async function importCsvFile(file) {
  const text = await file.text();
  const rows = parseCsv(text);
  if (!rows.length) return { ok: false, msg: "Leeg bestand." };

  const { headers, objs } = rowsToObjects(rows);
  const type = detectCsvType(headers);

  let normalized = [];
  if (type === "KRAKEN_FUTURES_ACCOUNT_LOG") normalized = normalizeKrakenFuturesAccountLog(objs);
  else return { ok: false, msg: `Onbekend CSV formaat. Headers: ${headers.slice(0, 8).join(", ")}...` };

  const res = await upsertTrades(normalized);
  return { ok: true, type, ...res };
}

// ----------------- JSON sync (Netlify) -----------------
async function syncFromJson() {
  try {
    const url = `${DATA_URL}?ts=${Date.now()}`; // cache-buster
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const payload = await r.json();

    // Expected format:
    // { generated_at: "...", rows: [ ... ] }
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];

    if (!rows.length) {
      els.dbBadge.textContent = "Sync OK (+0)";
      return { ok: true, added: 0 };
    }

    const res = await upsertTrades(rows);
    els.dbBadge.textContent = `Sync OK (+${res.added})`;
    return { ok: true, ...res };
  } catch (e) {
    els.dbBadge.textContent = "Sync: offline";
    return { ok: false, err: String(e?.message || e) };
  }
}

// ----------------- Filtering & Aggregation -----------------
async function getFilteredTrades(nowRef) {
  let items = await db.trades.toArray();

  const cutoff = rangeCutoffIso(state.range, nowRef);
  if (cutoff) items = items.filter(t => t.datetime >= cutoff);

  if (state.exchange !== "ALL") items = items.filter(t => t.exchange === state.exchange);
  if (state.marketType !== "ALL") items = items.filter(t => t.marketType === state.marketType);

  if (state.search) {
    const q = state.search.toLowerCase();
    items = items.filter(t =>
      (t.symbol || "").toLowerCase().includes(q) ||
      (t.notes || "").toLowerCase().includes(q) ||
      (t.tradeKey || "").toLowerCase().includes(q)
    );
  }

  items.sort((a, b) => (a.datetime < b.datetime ? 1 : -1));
  return items;
}

function aggregateKPIs(trades) {
  const net = trades.reduce((s, t) => s + (t.netPnlUsd || 0), 0);
  const fees = trades.reduce((s, t) => s + (t.feesUsd || 0), 0);
  const wins = trades.filter(t => (t.netPnlUsd || 0) > 0).length;
  const count = trades.length;
  const winrate = count ? wins / count : 0;
  return { net, fees, wins, count, winrate };
}

function buildEquitySeries(tradesAsc) {
  let cum = 0;
  const pts = [];
  for (const t of tradesAsc) {
    cum += (t.netPnlUsd || 0);
    pts.push({ x: t.datetime, y: cum });
  }
  return pts;
}

function monthlyBuckets(trades, nowRef) {
  const now = nowRef instanceof Date ? nowRef : new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    d.setUTCMonth(d.getUTCMonth() - i);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    months.push({ key, label: key, net: 0, fees: 0, funding: 0 });
  }
  const map = new Map(months.map(m => [m.key, m]));
  for (const t of trades) {
    const d = new Date(t.datetime);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const m = map.get(key);
    if (m) {
      m.net += (t.netPnlUsd || 0);
      m.fees += (t.feesUsd || 0);
      m.funding += (t.fundingUsd || 0);
    }
  }
  return months;
}

// ----------------- Canvas charts -----------------
function clearCanvas(ctx) { ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height); }

function drawLineChart(canvas, points, { yLabel = "" } = {}) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  clearCanvas(ctx);

  if (!points.length) {
    ctx.fillStyle = "rgba(229,231,235,.8)";
    ctx.font = "14px system-ui";
    ctx.fillText("Geen data (sync of import).", 16, 32);
    return;
  }

  const pad = 50;
  const xs = points.map(p => new Date(p.x).getTime());
  const ys = points.map(p => p.y);

  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const ymin = Math.min(...ys), ymax = Math.max(...ys);
  const yPad = (ymax - ymin) * 0.08 || 1;
  const y0 = ymin - yPad, y1 = ymax + yPad;

  function X(t) { return pad + (t - xmin) / (xmax - xmin || 1) * (w - pad * 1.2); }
  function Y(v) { return h - pad - (v - y0) / (y1 - y0 || 1) * (h - pad * 1.4); }

  // grid
  ctx.strokeStyle = "rgba(154,164,178,.15)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 5; i++) {
    const y = pad + i * (h - pad * 1.4) / 4;
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - pad * 0.2, y); ctx.stroke();
  }

  // label
  ctx.fillStyle = "rgba(154,164,178,.8)";
  ctx.font = "12px system-ui";
  ctx.fillText(yLabel, 12, 18);

  // line
  ctx.strokeStyle = "rgba(139,92,246,.95)"; // purple-ish
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    const x = X(xs[i]);
    const y = Y(ys[i]);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // zero line
  const yZero = Y(0);
  ctx.strokeStyle = "rgba(239,68,68,.25)";
  ctx.beginPath(); ctx.moveTo(pad, yZero); ctx.lineTo(w - pad * 0.2, yZero); ctx.stroke();
}

function drawBarChart(canvas, buckets) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  clearCanvas(ctx);
  if (!buckets.length) return;

  const pad = 50;
  const vals = buckets.map(b => b.net);
  const vmax = Math.max(...vals, 0);
  const vmin = Math.min(...vals, 0);
  const span = (vmax - vmin) || 1;
  function Y(v) { return h - pad - (v - vmin) / span * (h - pad * 1.4); }

  ctx.strokeStyle = "rgba(154,164,178,.15)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 5; i++) {
    const y = pad + i * (h - pad * 1.4) / 4;
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - pad * 0.2, y); ctx.stroke();
  }

  const barW = (w - pad * 1.2) / buckets.length;
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    const x = pad + i * barW + barW * 0.15;
    const bw = barW * 0.7;
    const y0 = Y(0);
    const yv = Y(b.net);
    const top = Math.min(y0, yv);
    const bh = Math.abs(y0 - yv);
    ctx.fillStyle = b.net >= 0 ? "rgba(34,197,94,.85)" : "rgba(239,68,68,.85)";
    ctx.fillRect(x, top, bw, bh);
  }

  ctx.fillStyle = "rgba(154,164,178,.9)";
  ctx.font = "11px system-ui";
  for (let i = 0; i < buckets.length; i += 2) {
    const x = pad + i * barW + barW * 0.1;
    ctx.fillText(buckets[i].label.slice(2), x, h - 18);
  }
}

// ----------------- UI render -----------------
function setKpi(el, valueText, goodBad = null, subText = null) {
  el.classList.remove("good", "bad");
  if (goodBad === "good") el.classList.add("good");
  if (goodBad === "bad") el.classList.add("bad");
  el.querySelector(".value").textContent = valueText;
  if (subText !== null) el.querySelector(".sub").textContent = subText;
}

async function renderAll() {
  // FIX: nowRef must exist here
  const all = await db.trades.toArray();
  const nowRef = all.length
    ? new Date(all.reduce((m, t) => (t.datetime > m ? t.datetime : m), all[0].datetime))
    : new Date();

  const trades = await getFilteredTrades(nowRef);
  const k = aggregateKPIs(trades);

  els.summaryLine.textContent = `${k.count} trades • ${state.exchange}/${state.marketType} • ${state.range}`;

  const netC = convertUsdToSelected(k.net);
  const feeC = convertUsdToSelected(k.fees);

  setKpi(els.kpiNet, formatMoney(netC, convertedLabel()), netC >= 0 ? "good" : "bad");
  setKpi(els.kpiFees, formatMoney(feeC, convertedLabel()));
  setKpi(els.kpiWinrate, formatPct(k.winrate), null, `${k.wins} / ${k.count}`);

  els.countBadge.textContent = `${k.count} trades`;
  els.tradeCount.textContent = `${k.count} trades`;
  els.dbBadge.textContent = els.dbBadge.textContent || "Lokaal";

  const tradesAsc = [...trades].sort((a, b) => (a.datetime > b.datetime ? 1 : -1));
  const ptsUsd = buildEquitySeries(tradesAsc);
  const pts = ptsUsd.map(p => ({ x: p.x, y: convertUsdToSelected(p.y) }));
  drawLineChart(els.equityCanvas, pts, { yLabel: `Cumulatief (${convertedLabel()})` });

  const bucketsUsd = monthlyBuckets(trades, nowRef);
  const buckets = bucketsUsd.map(b => ({
    ...b,
    net: convertUsdToSelected(b.net),
    fees: convertUsdToSelected(b.fees),
    funding: convertUsdToSelected(b.funding)
  }));
  drawBarChart(els.monthlyCanvas, buckets);
  const net12 = buckets.reduce((s, b) => s + b.net, 0);
  els.monthlyHint.textContent = `Som 12 maanden: ${formatMoney(net12, convertedLabel())}`;

  const rows = trades.slice(0, 500);
  els.tradeRows.innerHTML = rows.map(t => {
    const dt = new Date(t.datetime);
    const dtLabel = dt.toLocaleString("nl-NL", { year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" });
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
      <td class="mono muted">${safeText(t.notes).slice(0,40)}</td>
    </tr>`;
  }).join("");

  els.tradeCount.textContent = `${trades.length} trades${trades.length > 500 ? " (top 500 getoond)" : ""}`;
}

// ----------------- Tabs & Events -----------------
function setActiveTab(tab) {
  for (const el of [...els.tabs.querySelectorAll(".tab")]) {
    el.classList.toggle("active", el.dataset.tab === tab);
  }
  for (const [k, v] of Object.entries(els.views)) {
    v.style.display = (k === tab) ? "" : "none";
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
  const f = els.fileInput.files?.[0];
  if (!f) { els.importStatus.textContent = "Kies eerst een CSV."; return; }
  els.importStatus.textContent = "Importeren…";
  try {
    const res = await importCsvFile(f);
    els.importStatus.textContent = res.ok
      ? `OK: ${res.type} • +${res.added} • ${res.skipped} overgeslagen`
      : `Error: ${res.msg}`;
    await renderAll();
  } catch (e) {
    els.importStatus.textContent = `Error: import mislukt (${String(e?.message || e)})`;
  }
});

els.exportBtn?.addEventListener("click", async () => {
  const trades = await db.trades.toArray();
  const headers = ["datetime","exchange","symbol","marketType","side","qty","price","realizedPnlUsd","feesUsd","fundingUsd","netPnlUsd","notes","tradeKey"];
  const lines = [headers.join(",")].concat(trades.map(t => headers.map(h => {
    const v = t[h] ?? "";
    const s = String(v).replace(/"/g,'""');
    return `"${s}"`;
  }).join(",")));
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

// ----------------- Boot -----------------
(async function init() {
  await fetchFxRate();

  state.currency = els.currency?.value || "USD";
  state.exchange = els.exchange?.value || "ALL";
  state.marketType = els.marketType?.value || "ALL";
  state.range = els.range?.value || "12m";

  // 1) Try auto-sync from Netlify JSON
  await syncFromJson();

  // 2) Render
  await renderAll();

  // 3) Periodic refresh (optional)
  setInterval(async () => {
    await syncFromJson();
    await renderAll();
  }, REFRESH_MS);
})();