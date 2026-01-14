// PnL Traden — local-first PWA (cloud-ready)
// - Loads latest synced JSON from /data/pnl.json (Netlify/GitHub)
// - Stores trades in IndexedDB (Dexie) so phone works offline
// - Optional CSV imports (BloFin, Kraken trades.csv, Kraken Futures account log CSV)
//
// Data file format supported:
// A) { rows: [ {datetime, exchange, symbol, marketType, side, qty, price, realizedPnlUsd, feesUsd, fundingUsd, netPnlUsd, notes, tradeKey} ], generated_at: ... }
// B) Legacy: { closed_trades: [...] }  (we still support it)

const DATA_URL = "/data/pnl.json";
const REFRESH_MS = 30_000;
const FX_CACHE_KEY = "pnl_fx_cache_v1";
const DEPOSITS_KEY = "pnl_manual_deposits_v1"; // {KRAKEN:number, BLOFIN:number}

const db = new Dexie("pnl_traden_db");
db.version(2).stores({
  // Use tradeKey as primary key to avoid duplicates across refreshes.
  trades: "tradeKey, datetime, exchange, symbol, marketType, side, netPnlUsd"
});

// ---------------- Deposits (manual base) ----------------
function loadDeposits(){
  try{
    const raw = localStorage.getItem(DEPOSITS_KEY);
    if(!raw) return { KRAKEN: 0, BLOFIN: 0 };
    const obj = JSON.parse(raw);
    return {
      KRAKEN: Number(obj?.KRAKEN ?? 0) || 0,
      BLOFIN: Number(obj?.BLOFIN ?? 0) || 0,
    };
  }catch(_){
    return { KRAKEN: 0, BLOFIN: 0 };
  }
}

function saveDeposits(next){
  const clean = {
    KRAKEN: Number(next?.KRAKEN ?? 0) || 0,
    BLOFIN: Number(next?.BLOFIN ?? 0) || 0,
  };
  localStorage.setItem(DEPOSITS_KEY, JSON.stringify(clean));
}

function depositsForCurrentExchange(depositsObj){
  const f = (state.exchangeFilter || "ALL").toUpperCase();
  if(f === "KRAKEN") return depositsObj.KRAKEN;
  if(f === "BLOFIN") return depositsObj.BLOFIN;
  return (depositsObj.KRAKEN || 0) + (depositsObj.BLOFIN || 0);
}

const state = {
  fx: { usdToEur: null, asOf: null },
  currency: "USD",
  exchangeFilter: "ALL",
  exchange: "ALL",
  marketType: "ALL",
  range: "1w",
  search: "",
  chartMode: "pnl" // "pnl" or "total"
};

const els = {
  currency: document.getElementById("currency"),
  exchange: document.getElementById("exchange"),
  marketType: document.getElementById("marketType"),
  range: document.getElementById("range"),
  summaryLine: document.getElementById("summaryLine"),
  dashChartTitle: document.getElementById("dashChartTitle"),
  dashChartSub: document.getElementById("dashChartSub"),
  fxBadge: document.getElementById("fxBadge"),
  dbBadge: document.getElementById("dbBadge"),
  exportBtn: document.getElementById("exportBtn"),
  resetBtn: document.getElementById("resetBtn"),
  exPills: document.getElementById("exPills"),
  collapseBtn: document.getElementById("collapseBtn"),
  collapsibleHeader: document.getElementById("collapsibleHeader"),

  btnChartPnl: document.getElementById("btnChartPnl"),
  btnChartTotal: document.getElementById("btnChartTotal"),

  tabs: document.getElementById("tabs"),
  views: {
    dash: document.getElementById("view-dash"),
    analyse: document.getElementById("view-analyse"),
    trades: document.getElementById("view-trades"),
    calc: document.getElementById("view-calc"),
    import: document.getElementById("view-import")
  },

  kpiTotal: document.getElementById("kpiTotal"),
  kpiNet: document.getElementById("kpiNet"),
  kpiFees: document.getElementById("kpiFees"),
  kpiWinrate: document.getElementById("kpiWinrate"),
  kpiToday: document.getElementById("kpiToday"),
  kpi7d: document.getElementById("kpi7d"),
  kpi30d: document.getElementById("kpi30d"),
  analyseRangeBadge: document.getElementById("analyseRangeBadge"),
  analyseWinrate: document.getElementById("analyseWinrate"),
  analyseTrades: document.getElementById("analyseTrades"),
  analyseAvg: document.getElementById("analyseAvg"),
  analyseEquityCanvas: document.getElementById("analyseEquityCanvas"),
  analyseDailyCanvas: document.getElementById("analyseDailyCanvas"),
  equityCanvas: document.getElementById("equityCanvas"),
  btnChartPnl: document.getElementById("btnChartPnl"),
  btnChartTotal: document.getElementById("btnChartTotal"),

  // 12 maanden view is removed in v1.7; keep optional refs so older code paths never crash
  monthlyCanvas: document.getElementById("monthlyCanvas"),
  monthlyHint: document.getElementById("monthlyHint"),


  search: document.getElementById("search"),
  tradeRows: document.getElementById("tradeRows"),
  tradeCount: document.getElementById("tradeCount"),

    depKraken: document.getElementById("depKraken"),
  depBlofin: document.getElementById("depBlofin"),
  saveDepositsBtn: document.getElementById("saveDepositsBtn"),
  depositStatus: document.getElementById("depositStatus"),
fileInput: document.getElementById("fileInput"),
  importBtn: document.getElementById("importBtn"),
  importStatus: document.getElementById("importStatus"),
  loadSamplesBtn: document.getElementById("loadSamplesBtn"),
  sampleStatus: document.getElementById("sampleStatus")

,
  // Calculator
  calcSide: document.getElementById("calcSide"),
  calcEntry: document.getElementById("calcEntry"),
  calcStop: document.getElementById("calcStop"),
  calcTP: document.getElementById("calcTP"),
  calcRisk: document.getElementById("calcRisk"),
  calcBalance: document.getElementById("calcBalance"),
  calcRiskPct: document.getElementById("calcRiskPct"),
  calcUsePct: document.getElementById("calcUsePct"),
  calcContractSize: document.getElementById("calcContractSize"),
  calcRiskCur: document.getElementById("calcRiskCur"),
  calcLev: document.getElementById("calcLev"),
  calcFeePct: document.getElementById("calcFeePct"),
  calcResetBtn: document.getElementById("calcResetBtn"),
  calcHint: document.getElementById("calcHint"),

  calcKpiQty: document.getElementById("calcKpiQty"),
  calcKpiNotional: document.getElementById("calcKpiNotional"),
  calcKpiMargin: document.getElementById("calcKpiMargin"),
  calcKpiSL: document.getElementById("calcKpiSL"),
  calcKpiTP: document.getElementById("calcKpiTP")
};

function safeText(s){ return (s ?? "").toString(); }

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
  return new Intl.NumberFormat("nl-NL", { style: "currency", currency, maximumFractionDigits: 2 }).format(amount);
}
function formatPct(x) {
  return new Intl.NumberFormat("nl-NL", { style: "percent", maximumFractionDigits: 1 }).format(x);
}
function pnlClass(x){ return x >= 0 ? "pos" : "neg"; }

function toIsoDateTimeFromBlofin(mdy){
  const m = String(mdy).match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [_, mm, dd, yyyy, HH, MM, SS] = m;
  return new Date(Date.UTC(+yyyy, +mm-1, +dd, +HH, +MM, +SS)).toISOString();
}
function toIsoFromUnixSeconds(sec){
  const n = parseNumber(sec);
  if (!n) return null;
  return new Date(n * 1000).toISOString();
}

function addMonthsUTC(y, m, delta){
  const d = new Date(Date.UTC(y, m, 1));
  d.setUTCMonth(d.getUTCMonth() + delta);
  return d;
}
function rangeCutoffIso(range, nowRef){
  const now = nowRef instanceof Date ? nowRef : new Date();
  if (range === "all") return null;
  const mapDays = { "24h":1, "1w":7, "2w":14, "7d":7, "1m":30, "30d":30, "3m":90, "6m":182, "1y":365, "12m":365 };
  const days = mapDays[range] ?? 365;
  return new Date(now.getTime() - days*24*3600*1000).toISOString();
}

function convertUsdToSelected(usd){
  if (state.currency === "USD") return usd;
  const r = state.fx.usdToEur;
  if (!r) return usd;
  return usd * r;
}
function convertedLabel(){ return state.currency; }

async function fetchFxRate(){
  const cached = localStorage.getItem(FX_CACHE_KEY);
  if (cached) {
    try {
      const obj = JSON.parse(cached);
      if (obj?.usdToEur && obj?.asOf) state.fx = obj;
    } catch {}
  }
  // On some phones/networks exchangerate.host can fail (adblock/DNS). We try multiple providers.
  const providers = [
    async () => {
      const url = `https://api.exchangerate.host/latest?base=USD&symbols=EUR&_=${Date.now()}`;
      const data = await fetchJsonWithTimeout(url, 8000);
      const rate = data?.rates?.EUR;
      if (!rate) throw new Error("no rate");
      return { rate, asOf: data?.date || new Date().toISOString().slice(0,10), src:"exchangerate.host" };
    },
    async () => {
      const url = `https://open.er-api.com/v6/latest/USD?_=${Date.now()}`;
      const data = await fetchJsonWithTimeout(url, 8000);
      const rate = data?.rates?.EUR;
      if (!rate) throw new Error("no rate");
      return { rate, asOf: data?.time_last_update_utc || new Date().toISOString(), src:"open.er-api.com" };
    },
  ];
  for (const p of providers) {
    try {
      const r = await p();
      state.fx = { usdToEur: r.rate, asOf: r.asOf, src: r.src };
      localStorage.setItem(FX_CACHE_KEY, JSON.stringify(state.fx));
      break;
    } catch {}
  }
  els.fxBadge.textContent = state.fx.usdToEur
    ? `FX: 1 USD = ${state.fx.usdToEur.toFixed(4)} EUR`
    : "FX: offline";
}

async function fetchJsonWithTimeout(url, timeoutMs){
  const ctl = new AbortController();
  const t = setTimeout(()=>ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// ---------- CSV parsing ----------
function parseCsv(text){
  const rows=[]; let i=0, field="", row=[], inQuotes=false;
  while (i<text.length){
    const c=text[i];
    if (inQuotes){
      if (c === '"'){
        if (text[i+1] === '"'){ field+='"'; i+=2; continue; }
        inQuotes=false; i++; continue;
      } else { field+=c; i++; continue; }
    } else {
      if (c === '"'){ inQuotes=true; i++; continue; }
      if (c === ','){ row.push(field); field=""; i++; continue; }
      if (c === '\r'){ i++; continue; }
      if (c === '\n'){ row.push(field); rows.push(row); field=""; row=[]; i++; continue; }
      field+=c; i++; continue;
    }
  }
  row.push(field); rows.push(row);
  return rows.filter(r=>r.some(x=>String(x).trim()!==""));
}

function rowsToObjects(rows){
  const headers = rows[0].map(h=>String(h).trim());
  const objs = rows.slice(1).map(r=>{
    const o={};
    headers.forEach((h,idx)=>{ o[h]=r[idx] ?? ""; });
    return o;
  });
  return { headers, objs };
}

function detectCsvType(headers){
  const h = headers.map(x=>x.toLowerCase());
  // BloFin order history export usually has "UID" and "Realized PnL" and "DateTime"
  if (h.includes("uid") && h.includes("realized pnl") && h.includes("datetime")) return "BLOFIN_ORDER_HISTORY";
  // Kraken spot trades export typically has "txid" or "ordertxid" and "pair" and "time"
  if (h.includes("txid") && h.includes("pair") && (h.includes("time") || h.includes("date"))) return "KRAKEN_TRADES";
  // Kraken futures account log has "new balance" etc
  if (h.includes("new balance") && h.includes("funding rate") && h.includes("realized pnl")) return "KRAKEN_FUTURES_ACCOUNT_LOG";
  return "UNKNOWN";
}

function normalizeBlofin(objs){
  // We treat each row as a "closed order" trade-like record
  return objs.map(o=>{
    const dt = toIsoDateTimeFromBlofin(o["DateTime"] ?? o["dateTime"] ?? o["datetime"]);
    const realized = parseNumber(o["Realized PnL"] ?? o["realized pnl"]);
    const fee = parseNumber(o["Fee"] ?? o["fee"]);
    const funding = parseNumber(o["Realized Funding"] ?? o["realized funding"]);
    const net = realized - fee + funding;
    const symbol = safeText(o["Symbol"] ?? o["symbol"]).toUpperCase();
    const side = safeText(o["Type"] ?? o["type"]).toUpperCase();
    const qty = parseNumber(o["Contract"] ?? o["contract"] ?? o["Qty"] ?? o["qty"]);
    const price = parseNumber(o["Trade Price"] ?? o["trade price"] ?? o["price"]);
    const key = `BLOFIN|${o["UID"] ?? o["uid"]}|${dt ?? ""}|${symbol}|${side}|${qty}|${price}`;
    return {
      datetime: dt ?? new Date().toISOString(),
      exchange: "BLOFIN",
      symbol,
      marketType: "FUTURES",
      side,
      qty,
      price,
      realizedPnlUsd: realized,
      feesUsd: fee,
      fundingUsd: funding,
      netPnlUsd: net,
      notes: "BloFin order history csv",
      tradeKey: key
    };
  }).filter(x=>x.datetime);
}

function normalizeKraken(objs){
  // Kraken spot trades.csv has fields like: txid,ordertxid,pair,time,type,ordertype,price,cost,fee,vol,margin,misc,ledgers
  return objs.map(o=>{
    const dt = o["time"] ? new Date(o["time"]).toISOString() : (o["Time"] ? new Date(o["Time"]).toISOString() : null);
    const symbol = safeText(o["pair"] ?? o["Pair"] ?? o["symbol"] ?? o["Symbol"]).toUpperCase();
    const type = safeText(o["type"] ?? o["Type"]).toUpperCase(); // BUY/SELL
    const qty = parseNumber(o["vol"] ?? o["Vol"] ?? o["volume"] ?? o["Volume"]);
    const price = parseNumber(o["price"] ?? o["Price"]);
    const fee = parseNumber(o["fee"] ?? o["Fee"]);
    // For spot, realized pnl isn't in export. We'll treat net as negative fees only (or 0 if you prefer).
    const net = -fee;
    const key = `KRAKEN|${o["txid"] ?? o["Txid"] ?? ""}|${dt ?? ""}|${symbol}|${type}|${qty}|${price}`;
    return {
      datetime: dt ?? new Date().toISOString(),
      exchange: "KRAKEN",
      symbol,
      marketType: "SPOT",
      side: type,
      qty,
      price,
      realizedPnlUsd: 0,
      feesUsd: fee,
      fundingUsd: 0,
      netPnlUsd: net,
      notes: "Kraken trades.csv",
      tradeKey: key
    };
  });
}

function normalizeKrakenFuturesAccountLog(objs){
  // Header example:
  // uid,dateTime,account,type,symbol,contract,change,new balance,new average entry price,trade price,mark price,funding rate,realized pnl,fee,realized funding,collateral,conversion spread percentage,liquidation fee,position uid
  return objs.map(o=>{
    const dt = o["dateTime"] || o["datetime"] || o["DateTime"] || o["time"];
    const iso = dt ? new Date(dt).toISOString() : null;
    const symbol = safeText(o["symbol"] ?? o["Symbol"]).toLowerCase();
    const type = safeText(o["type"] ?? o["Type"]).toUpperCase(); // e.g. FUTURES TRADE, FUNDING, LIQUIDATION...
    const contract = parseNumber(o["contract"] ?? o["Contract"]);
    const tradePrice = parseNumber(o["trade price"] ?? o["tradePrice"] ?? o["trade_price"]);
    const realized = parseNumber(o["realized pnl"] ?? o["realizedPnl"] ?? o["realized_pnl"]);
    const fee = parseNumber(o["fee"] ?? o["Fee"]);
    const rf = parseNumber(o["realized funding"] ?? o["realizedFunding"] ?? o["realized_funding"]);
    // Some rows can have funding rate but 0 realized funding, etc.
    const net = realized - fee + rf;

    const key = `KRAKEN|LOG|${o["uid"] ?? ""}|${iso ?? ""}|${symbol}|${type}|${contract}|${tradePrice}`;
    return {
      datetime: iso ?? new Date().toISOString(),
      exchange: "KRAKEN",
      symbol,
      marketType: "FUTURES",
      side: type,
      qty: contract,
      price: tradePrice,
      realizedPnlUsd: realized,
      feesUsd: fee,
      fundingUsd: rf,
      netPnlUsd: net,
      notes: "Kraken futures account-log",
      tradeKey: key,
      newBalanceUsd: parseNumber(o["new balance"] ?? o["newBalance"] ?? o["new_balance"])
    };
  });
}

// ---------- DB / syncing ----------
async function upsertTrades(trades){
  let added=0, skipped=0;
  for(const t of trades){
    try{
      const existing = await db.trades.get(t.tradeKey);
      if(existing){
        skipped++;
      }else{
        await db.trades.put(t);
        added++;
      }
    }catch{
      skipped++;
    }
  }
  return { added, skipped };
}

function normalizeJsonPayload(json){
  if (json?.rows && Array.isArray(json.rows)){
    return json.rows.map(r=>({
      datetime: r.datetime,
      exchange: r.exchange,
      symbol: r.symbol,
      marketType: r.marketType,
      side: r.side,
      qty: parseNumber(r.qty),
      price: parseNumber(r.price),
      realizedPnlUsd: parseNumber(r.realizedPnlUsd),
      feesUsd: parseNumber(r.feesUsd),
      fundingUsd: parseNumber(r.fundingUsd),
      netPnlUsd: parseNumber(r.netPnlUsd),
      notes: r.notes ?? "",
      tradeKey: r.tradeKey ?? `${r.exchange}|${r.datetime}|${r.symbol}|${r.side}|${r.qty}|${r.price}`,
      newBalanceUsd: parseNumber(r.newBalanceUsd ?? r.new_balance_usd ?? r.new_balance ?? r["new balance"])
    }));
  }
  if (json?.closed_trades && Array.isArray(json.closed_trades)){
    return json.closed_trades.map(r=>({
      datetime: r.datetime ?? r.time ?? new Date().toISOString(),
      exchange: r.exchange ?? "KRAKEN",
      symbol: r.symbol ?? r.pair ?? "",
      marketType: r.marketType ?? "FUTURES",
      side: r.side ?? r.type ?? "",
      qty: parseNumber(r.qty ?? r.volume),
      price: parseNumber(r.price),
      realizedPnlUsd: parseNumber(r.realizedPnlUsd ?? r.realizedPnl),
      feesUsd: parseNumber(r.feesUsd ?? r.fee),
      fundingUsd: parseNumber(r.fundingUsd ?? 0),
      netPnlUsd: parseNumber(r.netPnlUsd ?? r.netPnl ?? 0),
      notes: r.notes ?? "legacy",
      tradeKey: r.tradeKey ?? `${r.exchange}|${r.datetime}|${r.symbol}|${r.side}|${r.qty}|${r.price}`,
      newBalanceUsd: parseNumber(r.newBalanceUsd ?? r.new_balance_usd ?? r.new_balance ?? r["new balance"])
    }));
  }
  return [];
}

async function syncFromApiIntoDb(){
  try{
    const res = await fetch(DATA_URL, { cache:"no-store" });
    if(!res.ok) throw new Error("fetch failed");
    const json = await res.json();
    const trades = normalizeJsonPayload(json);
    const r = await upsertTrades(trades);
    const count = await db.trades.count();
    const asof = json?.generated_at ? new Date(json.generated_at).toLocaleString("nl-NL") : "";
    els.dbBadge.textContent = `Sync OK (+${r.added}) • totaal ${count}`;
    if(asof) els.dbBadge.title = `Updated: ${asof}`;
  }catch(e){
    const count = await db.trades.count();
    els.dbBadge.textContent = `Offline • lokaal ${count}`;
  }
}

// ---------- Filtering / KPIs ----------
async function getFilteredTrades(){
  const all = await db.trades.toArray();
  const cutoff = rangeCutoffIso(state.range);
  const search = (state.search || "").toLowerCase();

  return all.filter(t=>{
    if (state.exchangeFilter && state.exchangeFilter !== "ALL" && (t.exchange || "").toUpperCase() !== state.exchangeFilter) return false;

    if (state.exchange !== "ALL" && (t.exchange || "") !== state.exchange) return false;
    if (state.marketType !== "ALL" && (t.marketType || "") !== state.marketType) return false;
    if (cutoff && t.datetime < cutoff) return false;
    if (search){
      const blob = `${t.exchange} ${t.symbol} ${t.marketType} ${t.side} ${t.notes}`.toLowerCase();
      if (!blob.includes(search)) return false;
    }
    return true;
  });
}

function aggregateKPIs(trades){
  const net = trades.reduce((a,t)=>a+parseNumber(t.netPnlUsd),0);
  const fees = trades.reduce((a,t)=>a+parseNumber(t.feesUsd),0);
  // winrate: count net>0 as win among all trades
  const wins = trades.filter(t=>parseNumber(t.netPnlUsd)>0).length;
  const count = trades.length || 1;
  const winrate = wins / count;

  // Today / 7d / 30d (UTC)
  const now = new Date();
  const startToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start7d = new Date(startToday.getTime() - 7*24*3600*1000);
  const start30d = new Date(startToday.getTime() - 30*24*3600*1000);

  const today = trades.filter(t=> new Date(t.datetime) >= startToday).reduce((a,t)=>a+parseNumber(t.netPnlUsd),0);
  const p7d = trades.filter(t=> new Date(t.datetime) >= start7d).reduce((a,t)=>a+parseNumber(t.netPnlUsd),0);
  const p30d = trades.filter(t=> new Date(t.datetime) >= start30d).reduce((a,t)=>a+parseNumber(t.netPnlUsd),0);

  return { net, fees, wins, count: trades.length, winrate, today, p7d, p30d };
}

function setKpi(el, valueText, goodBad=null, subText=null){
  if(!el) return;
  el.classList.remove("good","bad");
  if(goodBad==="good") el.classList.add("good");
  if(goodBad==="bad") el.classList.add("bad");
  el.querySelector(".value").textContent=valueText;
  if(subText!==null) el.querySelector(".sub").textContent=subText;
}

// ---------- Charts ----------
function buildEquitySeries(tradesAsc){
  // Trades already filtered; compute cumulative net pnl (USD)
  let cum=0;
  const pts=[];
  for(const t of tradesAsc){
    cum += parseNumber(t.netPnlUsd);
    pts.push({ x: new Date(t.datetime), y: cum, meta: t });
  }
  return pts;
}

function niceTimeLabels(points, range){
  // Build x-axis labels depending on selected range
  // 24h: hours
  // 1w: weekdays
  // 1m: dd-MM
  // 1y: months
  const xs = points.map(p=>p.x);
  if(xs.length===0) return [];
  const fmtHour = new Intl.DateTimeFormat("nl-NL", { hour:"2-digit" });
  const fmtWeek = new Intl.DateTimeFormat("nl-NL", { weekday:"short" });
  const fmtDay = new Intl.DateTimeFormat("nl-NL", { day:"2-digit", month:"2-digit" });
  const fmtMonth = new Intl.DateTimeFormat("nl-NL", { month:"short" });

  const map = {
    "24h": fmtHour,
    "1w": fmtWeek,
    "2w": fmtDay,
    "1m": fmtDay,
    "30d": fmtDay,
    "3m": fmtDay,
    "6m": fmtMonth,
    "1y": fmtMonth,
    "12m": fmtMonth,
    "all": fmtMonth
  };
  const fmt = map[range] || fmtDay;
  return xs.map(d=>fmt.format(d));
}

function makeCrosshair(canvas, points, yLabelCb){
  // Adds touch/mouse crosshair + value bubble
  const ctx = canvas.getContext("2d");
  let active = false;
  let idx = -1;

  function findNearest(xPx){
    if(points.length===0) return -1;
    // x positions are stored in points._px by drawLineChart
    let best=-1, bestDist=1e9;
    for(let i=0;i<points.length;i++){
      const px = points[i]._px;
      const dist = Math.abs(px - xPx);
      if(dist<bestDist){ bestDist=dist; best=i; }
    }
    return best;
  }

  function drawOverlay(){
    if(!active || idx<0 || idx>=points.length) return;
    const p = points[idx];
    // vertical line
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(p._px, 0);
    ctx.lineTo(p._px, canvas.height);
    ctx.stroke();

    // dot
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.beginPath();
    ctx.arc(p._px, p._py, 3.5, 0, Math.PI*2);
    ctx.fill();

    // bubble
    const text = yLabelCb(p);
    ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, Arial";
    const pad = 6;
    const w = ctx.measureText(text).width + pad*2;
    const h = 22;
    let bx = Math.min(canvas.width - w - 6, Math.max(6, p._px - w/2));
    let by = Math.max(6, p._py - h - 10);

    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 1;
    roundRect(ctx, bx, by, w, h, 8);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "white";
    ctx.textBaseline = "middle";
    ctx.fillText(text, bx+pad, by+h/2);
    ctx.restore();
  }

  function handleMove(clientX){
    const r = canvas.getBoundingClientRect();
    const x = clientX - r.left;
    idx = findNearest(x);
    active = true;
  }

  function clear(){
    active=false; idx=-1;
  }

  canvas.addEventListener("mousemove", (e)=>{
    handleMove(e.clientX);
  });
  canvas.addEventListener("mouseleave", clear);

  canvas.addEventListener("touchstart", (e)=>{
    if(e.touches?.[0]) handleMove(e.touches[0].clientX);
    e.preventDefault();
  }, { passive:false });
  canvas.addEventListener("touchmove", (e)=>{
    if(e.touches?.[0]) handleMove(e.touches[0].clientX);
    e.preventDefault();
  }, { passive:false });
  canvas.addEventListener("touchend", clear);

  return { drawOverlay, clear };
}

function roundRect(ctx, x, y, w, h, r){
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y, x+w, y+h, r);
  ctx.arcTo(x+w, y+h, x, y+h, r);
  ctx.arcTo(x, y+h, x, y, r);
  ctx.arcTo(x, y, x+w, y, r);
  ctx.closePath();
}

function drawLineChart(canvas, points, opts){
  const ctx = canvas.getContext("2d");
  const w = canvas.width = canvas.clientWidth * devicePixelRatio;
  const h = canvas.height = canvas.clientHeight * devicePixelRatio;
  ctx.clearRect(0,0,w,h);
  ctx.scale(devicePixelRatio, devicePixelRatio);

  const padding = 28;
  const innerW = canvas.clientWidth - padding*2;
  const innerH = canvas.clientHeight - padding*2;

  // Prepare scale
  const ys = points.map(p=>p.y);
  const minY = Math.min(...ys, 0);
  const maxY = Math.max(...ys, 0);
  const span = (maxY - minY) || 1;

  function xToPx(i){ return padding + (i/(Math.max(points.length-1,1))) * innerW; }
  function yToPy(y){
    return padding + (1 - (y - minY)/span) * innerH;
  }

  // Store pixel positions for crosshair
  points.forEach((p,i)=>{
    p._px = xToPx(i);
    p._py = yToPy(p.y);
  });

  // grid
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  for(let g=0; g<=4; g++){
    const y = padding + (g/4)*innerH;
    ctx.beginPath(); ctx.moveTo(padding,y); ctx.lineTo(padding+innerW,y); ctx.stroke();
  }

  // Determine stroke based on direction if requested
  let stroke = opts?.stroke || "rgba(0, 220, 120, 0.95)";
  if (opts?.directional){
    const dy = points.length>=2 ? (points[points.length-1].y - points[0].y) : 0;
    stroke = dy>=0 ? "rgba(0, 220, 120, 0.95)" : "rgba(255, 80, 80, 0.95)";
  }

  // area fill
  if(opts?.fill){
    ctx.beginPath();
    points.forEach((p,i)=>{
      if(i===0) ctx.moveTo(p._px, p._py);
      else ctx.lineTo(p._px, p._py);
    });
    // close to bottom
    ctx.lineTo(points[points.length-1]._px, padding+innerH);
    ctx.lineTo(points[0]._px, padding+innerH);
    ctx.closePath();
    ctx.fillStyle = opts.fill;
    ctx.fill();
  }

  // line
  ctx.beginPath();
  points.forEach((p,i)=>{
    if(i===0) ctx.moveTo(p._px, p._py);
    else ctx.lineTo(p._px, p._py);
  });
  ctx.strokeStyle = stroke;
  ctx.lineWidth = (opts?.lineWidth || 3);
  ctx.stroke();

  // x labels (sparse)
  const labels = opts?.xLabels || [];
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = "11px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const steps = Math.min(5, points.length);
  for(let i=0;i<steps;i++){
    const idx = Math.round(i*(points.length-1)/(steps-1 || 1));
    const p = points[idx];
    const lab = labels[idx] ?? "";
    ctx.fillText(lab, p._px, padding+innerH+6);
  }

  // y label
  if(opts?.yLabel){
    ctx.save();
    ctx.translate(10, canvas.clientHeight/2);
    ctx.rotate(-Math.PI/2);
    ctx.fillStyle="rgba(255,255,255,0.45)";
    ctx.font="12px system-ui, -apple-system, Segoe UI, Roboto, Arial";
    ctx.textAlign="center";
    ctx.fillText(opts.yLabel, 0, 0);
    ctx.restore();
  }
}

function renderTradesTable(trades){
  if(!els.tradeRows) return;
  els.tradeRows.innerHTML = "";
  const frag=document.createDocumentFragment();
  const sorted=[...trades].sort((a,b)=>a.datetime<b.datetime?1:-1).slice(0,250);
  for(const t of sorted){
    const tr=document.createElement("tr");
    tr.innerHTML = `
      <td>${new Date(t.datetime).toLocaleString("nl-NL")}</td>
      <td>${t.exchange}</td>
      <td>${t.symbol}</td>
      <td>${t.marketType}</td>
      <td>${t.side}</td>
      <td class="${pnlClass(t.netPnlUsd)}">${formatMoney(convertUsdToSelected(t.netPnlUsd), convertedLabel())}</td>
    `;
    frag.appendChild(tr);
  }
  els.tradeRows.appendChild(frag);
  els.tradeCount.textContent = `${trades.length} trades`;
}

// ---------- Render ----------
async function renderAll(){
  const trades=await getFilteredTrades();
  const k=aggregateKPIs(trades);

  // Manual base = (stortingen - opnames) per exchange filter
  const depositsObj = loadDeposits();
  const depositBaseUsd = depositsForCurrentExchange(depositsObj); // number

  const baseUsd = (typeof depositBaseUsd === "number" && isFinite(depositBaseUsd)) ? depositBaseUsd : 0;

  els.summaryLine.textContent = `${k.count} trades • ${state.exchangeFilter}/${state.marketType} • ${state.range}`;
  // KPIs
  const netC=convertUsdToSelected(k.net);
  const feeC=convertUsdToSelected(k.fees);
  const baseC=convertUsdToSelected(baseUsd);
  const totalC=convertUsdToSelected(baseUsd + k.net);

  // Totale waarde = (stortingen - opnames) + Net PnL
  if (els.kpiTotal) {
    const goodBad = (typeof totalC === "number" && isFinite(totalC) && totalC>=0) ? "good" : "bad";
    setKpi(
      els.kpiTotal,
      formatMoney(isFinite(totalC) ? totalC : 0, convertedLabel()),
      goodBad,
      `Basis: ${formatMoney(isFinite(baseC) ? baseC : 0, convertedLabel())}`
    );
  }

  if (els.kpiNet) setKpi(els.kpiNet, formatMoney(netC, convertedLabel()), netC>=0?"good":"bad");
  if (els.kpiFees) setKpi(els.kpiFees, formatMoney(feeC, convertedLabel()));
  if (els.kpiWinrate) setKpi(els.kpiWinrate, formatPct(k.winrate), null, `${k.wins} wins / ${k.count}`);
  if (els.kpiToday) setKpi(els.kpiToday, formatMoney(convertUsdToSelected(k.today), convertedLabel()), k.today>=0?"good":"bad");
  if (els.kpi7d) setKpi(els.kpi7d, formatMoney(convertUsdToSelected(k.p7d), convertedLabel()), k.p7d>=0?"good":"bad");
  if (els.kpi30d) setKpi(els.kpi30d, formatMoney(convertUsdToSelected(k.p30d), convertedLabel()), k.p30d>=0?"good":"bad");

  // Trades table
  renderTradesTable(trades);

  // Equity / charts
  const tradesAsc=[...trades].sort((a,b)=>(a.datetime>b.datetime?1:-1));
  const ptsUsd=buildEquitySeries(tradesAsc);
  const baseUsdForSeries = baseUsd;

  // choose chart series
  const seriesUsd = (state.chartMode === "total")
    ? ptsUsd.map(p=>({ x: p.x, y: baseUsdForSeries + (p.y || 0) }))
    : ptsUsd;

  const pts = seriesUsd.map(p => ({ x: p.x, y: convertUsdToSelected(p.y) }));
  const yLabel = (state.chartMode === "total")
    ? `Totale waarde (${convertedLabel()})`
    : `Cumulatief (${convertedLabel()})`;

  // Title/sub
  if (els.dashChartTitle) els.dashChartTitle.textContent = (state.chartMode === "total") ? "Total chart" : "PnL chart";
  if (els.dashChartSub) els.dashChartSub.textContent = (state.chartMode === "total")
    ? "Basis (stortingen - opnames) + cumulatieve Net PnL."
    : "Cumulatieve Net PnL per trade/order.";

  // Draw main chart with filled area + thicker line; green/red directional for PnL chart
  if (els.equityCanvas){
    const labels = niceTimeLabels(pts, state.range);
    drawLineChart(els.equityCanvas, pts, {
      yLabel,
      xLabels: labels,
      lineWidth: 5,
      fill: "rgba(0, 220, 120, 0.10)",
      directional: (state.chartMode === "pnl")
    });

    // Crosshair (amount + percentage vs base)
    const cross = makeCrosshair(els.equityCanvas, pts, (p)=>{
      const amount = formatMoney(p.y, convertedLabel());
      let pct = "";
      if (state.chartMode === "pnl" && baseUsdForSeries > 0){
        const baseSel = convertUsdToSelected(baseUsdForSeries);
        const perc = baseSel ? (p.y / baseSel) : 0;
        pct = ` • ${formatPct(perc)}`;
      } else if (state.chartMode === "total" && baseUsdForSeries > 0){
        const baseSel = convertUsdToSelected(baseUsdForSeries);
        const perc = baseSel ? ((p.y - baseSel) / baseSel) : 0;
        pct = ` • ${formatPct(perc)}`;
      }
      return `${amount}${pct}`;
    });

    // re-draw overlay on move: easiest approach: hook into events by redrawing chart on RAF
    let raf=0;
    const redraw = ()=>{
      drawLineChart(els.equityCanvas, pts, {
        yLabel,
        xLabels: labels,
        lineWidth: 5,
        fill: "rgba(0, 220, 120, 0.10)",
        directional: (state.chartMode === "pnl")
      });
      cross.drawOverlay();
      raf=0;
    };
    const schedule = ()=>{ if(!raf) raf=requestAnimationFrame(redraw); };

    els.equityCanvas.addEventListener("mousemove", schedule);
    els.equityCanvas.addEventListener("touchstart", schedule, {passive:false});
    els.equityCanvas.addEventListener("touchmove", schedule, {passive:false});
    els.equityCanvas.addEventListener("mouseleave", schedule);
    els.equityCanvas.addEventListener("touchend", schedule);
  }

  // Analyse view can re-use same style if desired (keep simple for now)
  if (els.analyseEquityCanvas){
    const labels = niceTimeLabels(pts, state.range);
    drawLineChart(els.analyseEquityCanvas, pts, {
      yLabel,
      xLabels: labels,
      lineWidth: 5,
      fill: "rgba(0, 220, 120, 0.10)",
      directional: (state.chartMode === "pnl")
    });
  }
}

// ---------- Calculator ----------
function setKpiText(el, valueText, subText){
  if(!el) return;
  el.querySelector(".value").textContent = valueText;
  el.querySelector(".sub").textContent = subText;
}
function calcColorRR(rr){
  if(!isFinite(rr)) return "";
  if(rr < 2) return "bad";
  if(rr < 3) return "warn";
  return "good";
}
function convertCalculatorInputs(prevCur, nextCur){
  // Convert input values if they are money-like and user toggles USD/EUR
  if(prevCur === nextCur) return;
  const r = state.fx.usdToEur;
  if(!r) return;
  const mul = (prevCur==="USD" && nextCur==="EUR") ? r : (prevCur==="EUR" && nextCur==="USD") ? (1/r) : 1;
  const fields = [els.calcEntry, els.calcStop, els.calcTP, els.calcRisk, els.calcBalance];
  fields.forEach(f=>{
    if(!f) return;
    const n = parseNumber(f.value);
    if(!n) return;
    f.value = (n * mul).toFixed(4);
  });
}

function loadCalcDefaults(){
  try{
    const raw = localStorage.getItem("pnl_calc_v1");
    if(!raw) return;
    const o = JSON.parse(raw);
    if (els.calcSide && o.side) els.calcSide.value = o.side;
    if (els.calcEntry && o.entry) els.calcEntry.value = o.entry;
    if (els.calcStop && o.stop) els.calcStop.value = o.stop;
    if (els.calcTP && o.tp) els.calcTP.value = o.tp;
    if (els.calcRisk && o.risk) els.calcRisk.value = o.risk;
    if (els.calcBalance && o.balance) els.calcBalance.value = o.balance;
    if (els.calcRiskPct && o.riskPct) els.calcRiskPct.value = o.riskPct;
    if (els.calcUsePct) els.calcUsePct.checked = !!o.usePct;
    if (els.calcContractSize && o.contractSize) els.calcContractSize.value = o.contractSize;
    if (els.calcLev && o.lev) els.calcLev.value = o.lev;
    if (els.calcFeePct && o.feePct) els.calcFeePct.value = o.feePct;
  }catch{}
}
function saveCalcDefaults(){
  try{
    const o = {
      side: els.calcSide?.value || "LONG",
      entry: els.calcEntry?.value || "",
      stop: els.calcStop?.value || "",
      tp: els.calcTP?.value || "",
      risk: els.calcRisk?.value || "",
      balance: els.calcBalance?.value || "",
      riskPct: els.calcRiskPct?.value || "",
      usePct: !!els.calcUsePct?.checked,
      contractSize: els.calcContractSize?.value || "1",
      lev: els.calcLev?.value || "1",
      feePct: els.calcFeePct?.value || "0.08"
    };
    localStorage.setItem("pnl_calc_v1", JSON.stringify(o));
  }catch{}
}

function calcCompute(){
  if(!els.calcEntry) return;

  const side = (els.calcSide?.value || "LONG").toUpperCase();
  const entry = parseNumber(els.calcEntry.value);
  const stop = parseNumber(els.calcStop.value);
  const tp = parseNumber(els.calcTP.value);
  const contractSize = Math.max(0.0000001, parseNumber(els.calcContractSize?.value || 1));
  const lev = Math.max(1, parseNumber(els.calcLev?.value || 1));
  const feePct = Math.max(0, parseNumber(els.calcFeePct?.value || 0)) / 100;

  const usePct = !!els.calcUsePct?.checked;
  const balance = parseNumber(els.calcBalance?.value);
  const riskPct = parseNumber(els.calcRiskPct?.value) / 100;
  let risk = parseNumber(els.calcRisk.value);

  // If using %: compute risk from balance
  if(usePct && balance>0 && riskPct>0){
    risk = balance * riskPct;
    if(els.calcRisk) els.calcRisk.value = risk.toFixed(4);
    if(els.calcRiskCur) els.calcRiskCur.textContent = convertedLabel();
  }

  // Convert inputs to USD for calculations if currency is EUR
  const r = state.fx.usdToEur;
  const toUsd = (v)=> (state.currency==="USD" || !r) ? v : (v / r);

  const entryUsd = toUsd(entry);
  const stopUsd = toUsd(stop);
  const tpUsd = toUsd(tp);
  const riskUsd = toUsd(risk);

  if(!entryUsd || !stopUsd || !riskUsd){
    setKpiText(els.calcKpiQty, "—", "Vul entry/stop/risk");
    setKpiText(els.calcKpiNotional, "—", "");
    setKpiText(els.calcKpiMargin, "—", "");
    setKpiText(els.calcKpiSL, "—", "");
    setKpiText(els.calcKpiTP, "—", "");
    els.calcHint.textContent = "Vul minimaal Entry, Stop en Risk (of Risk%).";
    return;
  }
  // Per-unit risk
  const perUnitRisk = Math.abs(entryUsd - stopUsd);
  if(perUnitRisk <= 0){
    els.calcHint.textContent = "Stop mag niet gelijk zijn aan entry.";
    return;
  }

  // qty to match risk (excluding fees first)
  let qty = riskUsd / perUnitRisk;

  // fees: approximate round-trip fees on notional (entry and exit)
  const notional = entryUsd * qty;
  const feesUsd = (notional * feePct) * 2; // entry + exit
  // adjust qty so that (perUnitRisk*qty + fees) ~= riskUsd
  // qty*(perUnitRisk + entryUsd*feePct*2) = riskUsd
  qty = riskUsd / (perUnitRisk + entryUsd * feePct * 2);

  const notionalAdj = entryUsd * qty;
  const marginUsd = notionalAdj / lev;

  const stopPnlUsd = -perUnitRisk * qty - (notionalAdj * feePct * 2);
  const stopPnlSel = convertUsdToSelected(stopPnlUsd);

  const contracts = qty / contractSize;
  const qtySub = contractSize === 1 ? "Aantal contracts/coins" : `Contract size: ${contractSize} (qty=${qty.toFixed(4)})`;
  setKpiText(els.calcKpiQty, contracts.toFixed(4), contractSize === 1 ? "Aantal contracts/coins" : `Contracts (qty/contractSize)`);
  if (contractSize !== 1) {
    els.calcKpiQty?.querySelector(".sub") && (els.calcKpiQty.querySelector(".sub").textContent = `Underlying qty: ${qty.toFixed(4)} • Contract size: ${contractSize}`);
  }
  setKpiText(els.calcKpiNotional, formatMoney(convertUsdToSelected(notionalAdj), convertedLabel()), "Entry × qty");
  setKpiText(els.calcKpiMargin, formatMoney(convertUsdToSelected(marginUsd), convertedLabel()), "Notional / leverage");
  setKpiText(els.calcKpiSL, formatMoney(stopPnlSel, convertedLabel()), "≈ -risico (incl. fees)");

  // TP / RR
  if (tpUsd) {
    const perUnitGain = Math.abs(tpUsd - entryUsd);
    const tpPnlUsd = perUnitGain * qty - (notionalAdj * feePct * 2);
    const rr = Math.abs(tpPnlUsd / stopPnlUsd);
    setKpiText(els.calcKpiTP, formatMoney(convertUsdToSelected(tpPnlUsd), convertedLabel()), `RR: ${isFinite(rr) ? rr.toFixed(2) : "—"}`);
    // RR coloring: <2 red, 2-3 yellow, >3 green
    els.calcKpiTP?.classList.remove("good","bad","warn");
    if (isFinite(rr)) {
      if (rr < 2) els.calcKpiTP?.classList.add("bad");
      else if (rr < 3) els.calcKpiTP?.classList.add("warn");
      else els.calcKpiTP?.classList.add("good");
    }
    els.calcHint && (els.calcHint.textContent = "Ok.");
  } else {
    setKpiText(els.calcKpiTP, "—", "RR: —");
    els.calcKpiTP?.classList.remove("good","bad","warn");
    els.calcHint && (els.calcHint.textContent = "Ok (TP leeg).");
  }
}

function wireCalculator(){
  if(!els.calcEntry) return;

  loadCalcDefaults();
  calcCompute();

  const onAny = () => { saveCalcDefaults(); calcCompute(); };

  ["change","input"].forEach(evt => {
    els.calcSide?.addEventListener(evt, onAny);
    els.calcEntry?.addEventListener(evt, onAny);
    els.calcStop?.addEventListener(evt, onAny);
    els.calcTP?.addEventListener(evt, onAny);
    els.calcRisk?.addEventListener(evt, onAny);
    els.calcBalance?.addEventListener(evt, onAny);
    els.calcRiskPct?.addEventListener(evt, onAny);
    els.calcUsePct?.addEventListener(evt, onAny);
    els.calcContractSize?.addEventListener(evt, onAny);
    els.calcLev?.addEventListener(evt, onAny);
    els.calcFeePct?.addEventListener(evt, onAny);
  });

  els.calcResetBtn?.addEventListener("click", () => {
    if (els.calcSide) els.calcSide.value = "LONG";
    if (els.calcEntry) els.calcEntry.value = "";
    if (els.calcStop) els.calcStop.value = "";
    if (els.calcTP) els.calcTP.value = "";
    if (els.calcBalance) els.calcBalance.value = "";
    if (els.calcRiskPct) els.calcRiskPct.value = "";
    if (els.calcUsePct) els.calcUsePct.checked = false;
    if (els.calcRisk) els.calcRisk.value = ""; 
    if (els.calcContractSize) els.calcContractSize.value = "1";
    if (els.calcLev) els.calcLev.value = "1";
    if (els.calcFeePct) els.calcFeePct.value = "0.08";
    saveCalcDefaults();
    calcCompute();
  });
}
// ---------- Events ----------
function setActiveTab(tab){
  for(const el of [...els.tabs.querySelectorAll(".tab")]) el.classList.toggle("active", el.dataset.tab===tab);
  for(const [k,v] of Object.entries(els.views)) v.style.display = (k===tab) ? "" : "none";
}
els.tabs.addEventListener("click",(e)=>{
  const t=e.target.closest(".tab"); if(!t) return;
  setActiveTab(t.dataset.tab);
});

// Sticky exchange pills
if (els.exPills){
  els.exPills.addEventListener("click", async (e)=>{
    const b = e.target.closest(".ex-pill");
    if (!b) return;
    const ex = b.dataset.ex || "ALL";
    state.exchangeFilter = ex;
    localStorage.setItem("pnl_exchange_filter", ex);
    [...els.exPills.querySelectorAll(".ex-pill")].forEach(x=>x.classList.toggle("active", x.dataset.ex===ex));
    await renderAll();
  });
}
els.currency.addEventListener("change", async()=>{ const prev=state.currency; const next=els.currency.value; convertCalculatorInputs(prev, next); state.currency=next; await renderAll(); calcCompute(); });
els.exchange.addEventListener("change", async()=>{ state.exchange=els.exchange.value; await renderAll(); });
els.marketType.addEventListener("change", async()=>{ state.marketType=els.marketType.value; await renderAll(); });
els.range.addEventListener("change", async()=>{ state.range=els.range.value; await renderAll(); });
els.search.addEventListener("input", async()=>{ state.search=els.search.value; await renderAll(); });


els.importBtn.addEventListener("click", async()=>{
  const f=els.fileInput.files?.[0];
  if(!f){ els.importStatus.textContent="Kies eerst een CSV."; return; }
  els.importStatus.textContent="Importeren…";
  try{
    const text=await f.text();
    const rows=parseCsv(text);
    const { headers, objs } = rowsToObjects(rows);
    const type=detectCsvType(headers);
    let normalized=[];
    if(type==="BLOFIN_ORDER_HISTORY") normalized=normalizeBlofin(objs);
    else if(type==="KRAKEN_TRADES") normalized=normalizeKraken(objs);
    else if(type==="KRAKEN_FUTURES_ACCOUNT_LOG") normalized=normalizeKrakenFuturesAccountLog(objs);
    else { els.importStatus.textContent=`Onbekend CSV formaat (${headers.slice(0,5).join(", ")}…)`; return; }
    const r=await upsertTrades(normalized);
    els.importStatus.textContent=`OK: ${type} • +${r.added} • ${r.skipped} overgeslagen`;
    await renderAll();
  }catch(e){
    els.importStatus.textContent="Error: import mislukt.";
  }
});

// Deposits save (local)
if (els.saveDepositsBtn) {
  els.saveDepositsBtn.addEventListener("click", async () => {
    const k = Number(els.depKraken?.value || 0);
    const b = Number(els.depBlofin?.value || 0);
    const dep = { KRAKEN: Number.isFinite(k) ? k : 0, BLOFIN: Number.isFinite(b) ? b : 0 };
    saveDeposits(dep);
    if (els.depositStatus) els.depositStatus.textContent = "Opgeslagen ✅";
    await renderAll();
  });
}


els.exportBtn.addEventListener("click", async()=>{
  const trades = await db.trades.toArray();
  const headers = ["datetime","exchange","symbol","marketType","side","qty","price","realizedPnlUsd","feesUsd","fundingUsd","netPnlUsd","notes","tradeKey"];
  const lines=[headers.join(",")].concat(trades.map(t=>headers.map(h=>{
    const v=t[h] ?? "";
    const s=String(v).replace(/"/g,'""');
    return `"${s}"`;
  }).join(",")));
  const blob=new Blob([lines.join("\n")],{type:"text/csv;charset=utf-8"});
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download=`pnl_trades_export_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

els.resetBtn.addEventListener("click", async()=>{
  if(!confirm("Weet je zeker dat je alle lokale data wilt wissen?")) return;
  await db.trades.clear();
  await renderAll();
});

(async function init(){
  await fetchFxRate();

// Load deposits into UI
try{
  const dep = loadDeposits();
  if (els.depKraken) els.depKraken.value = dep.KRAKEN ? String(dep.KRAKEN) : "";
  if (els.depBlofin) els.depBlofin.value = dep.BLOFIN ? String(dep.BLOFIN) : "";
}catch{}
  state.currency=els.currency.value;
  state.exchange=els.exchange.value;
  state.marketType=els.marketType.value;
  state.range = els.range.value;
  state.chartMode = "pnl";
  if (els.btnChartPnl) els.btnChartPnl.classList.add("active");
  if (els.btnChartTotal) els.btnChartTotal.classList.remove("active");

  state.exchangeFilter = localStorage.getItem("pnl_exchange_filter") || "ALL";
  if (els.exPills){
    [...els.exPills.querySelectorAll(".ex-pill")].forEach(x=>x.classList.toggle("active", x.dataset.ex===state.exchangeFilter));
  }

  // Chart toggle: PnL vs Total
  const setChartMode = (mode) => {
    state.chartMode = mode;
    if (els.btnChartPnl) els.btnChartPnl.classList.toggle("active", mode === "pnl");
    if (els.btnChartTotal) els.btnChartTotal.classList.toggle("active", mode === "total");
    renderAll();
  };
  if (els.btnChartPnl) els.btnChartPnl.addEventListener("click", () => setChartMode("pnl"));
  if (els.btnChartTotal) els.btnChartTotal.addEventListener("click", () => setChartMode("total"));
  // Default (also ensures correct active state on load)
  setChartMode(state.chartMode || "pnl");

  wireCalculator();

  // Sticky header collapse (mobile friendly)
  try {
    const collapsed = localStorage.getItem("pnl_header_collapsed") === "1";
    if (els.collapsibleHeader) els.collapsibleHeader.classList.toggle("collapsed", collapsed);
    if (els.collapseBtn) els.collapseBtn.classList.toggle("collapsed", collapsed);
    if (els.collapseBtn && els.collapsibleHeader){
      els.collapseBtn.addEventListener("click", ()=>{
        const isCollapsed = els.collapsibleHeader.classList.toggle("collapsed");
        els.collapseBtn.classList.toggle("collapsed", isCollapsed);
        els.collapseBtn.textContent = isCollapsed ? "▸" : "▾";
        localStorage.setItem("pnl_header_collapsed", isCollapsed ? "1" : "0");
      });
      // initial icon state
      els.collapseBtn.textContent = collapsed ? "▸" : "▾";
    }
  } catch(_) {}

  // first sync + render
  await syncFromApiIntoDb();
  await renderAll();

  // auto refresh
  setInterval(async()=>{
    await syncFromApiIntoDb();
    await renderAll();
  }, REFRESH_MS);
})();