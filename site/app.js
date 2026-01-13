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

const db = new Dexie("pnl_traden_db");
db.version(2).stores({
  trades: "++id, tradeKey, datetime, exchange, symbol, marketType, side, netPnlUsd"
});

const state = {
  fx: { usdToEur: null, asOf: null },
  currency: "USD",
  exchangeFilter: "ALL",
  exchange: "ALL",
  marketType: "ALL",
  range: "1w",
  search: "",
  chartMode: "zero" // "zero" or "area"
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
  exPills: document.getElementById("exPills"),

  tabs: document.getElementById("tabs"),
  views: {
    dash: document.getElementById("view-dash"),
    analyse: document.getElementById("view-analyse"),
    monthly: document.getElementById("view-monthly"),
    trades: document.getElementById("view-trades"),
    calc: document.getElementById("view-calc"),
    import: document.getElementById("view-import")
  },

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
  els.fxBadge.textContent = state.fx.usdToEur ? `FX: 1 USD = ${state.fx.usdToEur.toFixed(4)} EUR (${state.fx.asOf})` : "FX: offline";
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
      }
      field+=c; i++; continue;
    } else {
      if (c === '"'){ inQuotes=true; i++; continue; }
      if (c === ','){ row.push(field); field=""; i++; continue; }
      if (c === '\n'){ row.push(field); rows.push(row); row=[]; field=""; i++; continue; }
      if (c === '\r'){ i++; continue; }
      field+=c; i++; continue;
    }
  }
  if (field.length || row.length){ row.push(field); rows.push(row); }
  return rows;
}
function rowsToObjects(rows){
  const headers = rows[0].map((h,i)=>{ let t=(h??"").toString().trim(); if(i===0) t=t.replace(/^﻿/,""); return t; });
  const objs=[];
  for(let r=1;r<rows.length;r++){
    const arr=rows[r];
    if(arr.length===1 && arr[0].trim()==="") continue;
    const obj={};
    for(let c=0;c<headers.length;c++) obj[headers[c]]=(arr[c]??"").trim();
    objs.push(obj);
  }
  return { headers, objs };
}
function detectCsvType(headers){
  const h=headers.map(x=>x.trim().replace(/^﻿/,""));
  if(h.includes("Underlying Asset") && h.includes("Order Time") && h.includes("PNL") && h.includes("Fee")) return "BLOFIN_ORDER_HISTORY";
  if(h.includes("txid") && h.includes("ordertype") && h.includes("pair") && h.includes("time")) return "KRAKEN_TRADES";
  const isKrakenFutures = h.includes("uid") && h.includes("dateTime") && h.includes("type") && h.includes("change") && (h.includes("contract") || h.includes("symbol"));
  if(isKrakenFutures) return "KRAKEN_FUTURES_ACCOUNT_LOG";
  return "UNKNOWN";
}


function normExchange(x){ return (x||"").toString().trim().toUpperCase(); }
function applyExchangeFilter(items){
  const f = normExchange(state.exchangeFilter || "ALL");
  if (f === "ALL") return items;
  return items.filter(t => normExchange(t.exchange) === f);
}


function normalizeBlofin(objs){
  const out=[];
  for(const o of objs){
    if(safeText(o["Status"]).toLowerCase()!=="filled") continue;
    const pnlRaw=safeText(o["PNL"]).trim();
    if(!pnlRaw || pnlRaw==="--") continue;
    const datetime=toIsoDateTimeFromBlofin(o["Order Time"]);
    const symbol=safeText(o["Underlying Asset"]);
    const sideRaw=safeText(o["Side"]);
    const side=sideRaw.toLowerCase().includes("sell")?"SELL":"BUY";
    const qty=parseNumber(o["Filled"]);
    const price=parseNumber(o["Avg Fill"]) || parseNumber(o["Price"]);
    const pnlUsd=parseNumber(o["PNL"]);
    const feeUsd=Math.abs(parseNumber(o["Fee"]));
    const fundingUsd=0;
    const netUsd=pnlUsd-feeUsd+fundingUsd;
    const tradeKey=`BLOFIN|${safeText(o["Order Time"])}|${symbol}|${sideRaw}|${qty}|${price}|${pnlUsd}|${feeUsd}`;
    out.push({ datetime, exchange:"BLOFIN", symbol, marketType:"FUTURES", side, qty, price, realizedPnlUsd:pnlUsd, feesUsd:feeUsd, fundingUsd, netPnlUsd:netUsd, notes:safeText(o["Order Options"])||safeText(o["Status"])||"", tradeKey });
  }
  return out.filter(x=>x.datetime);
}

function normalizeKraken(objs){
  const out=[];
  for(const o of objs){
    const datetime=o["time"]?toIsoFromUnixSeconds(o["time"]):null;
    const symbol=safeText(o["pair"]||o["symbol"]||"");
    const type=safeText(o["type"]||o["side"]||"");
    const side=type.toLowerCase().includes("sell")?"SELL":"BUY";
    const qty=parseNumber(o["vol"]||o["qty"]||o["volume"]);
    const price=parseNumber(o["price"]||o["avgPrice"]);
    const feeUsd=Math.abs(parseNumber(o["fee"]||o["cfee"]));
    const netUsd=parseNumber(o["net"]||o["pnl"]||0);
    const pnlUsd=parseNumber(o["pnl"] || (netUsd + feeUsd));
    const fundingUsd=parseNumber(o["funding"]||0);
    const netCalc=(pnlUsd||0)-feeUsd+fundingUsd;
    const tradeKey=`KRAKEN|${safeText(o["txid"])}|${symbol}|${safeText(o["time"])}|${qty}|${price}|${netUsd}`;
    out.push({ datetime, exchange:"KRAKEN", symbol, marketType:"FUTURES", side, qty, price, realizedPnlUsd:pnlUsd||0, feesUsd:feeUsd, fundingUsd, netPnlUsd:netUsd||netCalc, notes:safeText(o["txid"]||""), tradeKey });
  }
  return out.filter(x=>x.datetime);
}

function normalizeKrakenFuturesAccountLog(objs){
  const out=[];
  for(const o of objs){
    const uid=safeText(o["uid"]||"").trim();
    const dtStr=safeText(o["dateTime"]||o["datetime"]||"").trim();
    if(!dtStr) continue;
    const dt=dtStr.replace(" ","T");
    const datetimeIso = dt.endsWith("Z")?dt:(dt+"Z");
    const typeRaw=safeText(o["type"]||"").trim();
    const type=typeRaw.toLowerCase();
    const allowed=(type==="futures trade"||type==="funding rate change"||type==="futures liquidation"||type==="futures assignor");
    if(!allowed) continue;
    const contract=safeText(o["contract"]||"").trim();
    const symbol=contract||safeText(o["symbol"]||"").trim();
    const realizedPnlUsd=parseNumber(o["realized pnl"]||o["realized_pnl"]);
    const feeUsd=Math.abs(parseNumber(o["fee"]));
    const realizedFundingUsd=parseNumber(o["realized funding"]||o["realized_funding"]);
    const liquidationFeeUsd=Math.abs(parseNumber(o["liquidation fee"]||o["liquidation_fee"]));
    let fundingUsd=0;
    if(type==="funding rate change"){
      const changeUsd=parseNumber(o["change"]);
      fundingUsd=realizedFundingUsd||changeUsd||0;
    }
    const pnlUsd=(type==="funding rate change")?0:(realizedPnlUsd||0);
    const feesTotal=(type==="funding rate change")?0:((feeUsd||0)+(liquidationFeeUsd||0));
    const netUsd=pnlUsd-feesTotal+fundingUsd;
    const tradeKey=uid?`KRAKENF_LOG|${uid}`:`KRAKENF_LOG|${datetimeIso}|${typeRaw}|${symbol}|${pnlUsd}|${feesTotal}|${fundingUsd}`;
    out.push({ datetime:datetimeIso, exchange:"KRAKEN", symbol, marketType:"FUTURES", side:typeRaw.toUpperCase(), qty:0, price:parseNumber(o["trade price"]||o["trade_price"]||0), realizedPnlUsd:pnlUsd, feesUsd:feesTotal, fundingUsd, netPnlUsd:netUsd, notes:safeText(o["position uid"]||"")||safeText(typeRaw), tradeKey });
  }
  return out.filter(x=>x.datetime);
}

// ---------- API JSON ingest ----------
function normalizeApiRows(data){
  if (Array.isArray(data?.rows)) {
    const out = data.rows.map(r => ({
      datetime: safeText(r.datetime),
      exchange: safeText(r.exchange || "KRAKEN"),
      symbol: safeText(r.symbol),
      marketType: safeText(r.marketType || "FUTURES"),
      side: safeText(r.side || ""),
      qty: Number(r.qty || 0),
      price: Number(r.price || 0),
      realizedPnlUsd: Number(r.realizedPnlUsd || 0),
      feesUsd: Number(r.feesUsd || 0),
      fundingUsd: Number(r.fundingUsd || 0),
      netPnlUsd: Number(r.netPnlUsd ?? (Number(r.realizedPnlUsd||0) - Number(r.feesUsd||0) + Number(r.fundingUsd||0))),
      notes: safeText(r.notes || ""),
      tradeKey: safeText(r.tradeKey || "")
        }));
    // Ensure tradeKey exists (some exports may omit it)
    for (let i=0;i<out.length;i++){
      if(!out[i].tradeKey){
        out[i].tradeKey = `${out[i].exchange}|${out[i].symbol}|${out[i].datetime}|${out[i].netPnlUsd}|${i}`;
      }
    }
    return out.filter(x => x.datetime);

  }
  // legacy support: closed_trades
  const out=[];
  for(const t of (data?.closed_trades||[])){
    const datetime=t.exit_dt || t.entry_dt;
    if(!datetime) continue;
    const realizedPnlUsd=Number(t.realized_pnl||0);
    const feesUsd=Number(t.fees||0);
    const fundingUsd=Number(t.funding||0);
    const netPnlUsd=Number(t.net_pnl ?? (realizedPnlUsd - feesUsd + fundingUsd));
    const tradeKey=`KRAKENF_API|${safeText(t.entry_fill_id)}|${safeText(t.exit_fill_id)}|${safeText(t.symbol)}|${datetime}`;
    out.push({
      datetime,
      exchange:"KRAKEN",
      symbol:safeText(t.symbol),
      marketType:"FUTURES",
      side:safeText(t.direction),
      qty:Number(t.qty||0),
      price:Number(t.exit_price||t.entry_price||0),
      realizedPnlUsd,
      feesUsd,
      fundingUsd,
      netPnlUsd,
      notes:`entry:${safeText(t.entry_fill_id)} exit:${safeText(t.exit_fill_id)}`,
      tradeKey
    });
  }
  return out;
}

async function upsertTrades(rows){
  // Ensure every row has a stable tradeKey so we never drop everything on mobile due to missing keys.
  const normalized = rows.map((r, idx) => {
    let tk = safeText(r.tradeKey || "");
    if (!tk) {
      // Fallback key based on deterministic fields
      tk = [
        safeText(r.exchange||""),
        safeText(r.marketType||""),
        safeText(r.symbol||""),
        safeText(r.datetime||""),
        String(Number(r.netPnlUsd||0)),
        String(Number(r.feesUsd||0)),
        String(Number(r.fundingUsd||0)),
        String(idx)
      ].join("|");
    }
    return { ...r, tradeKey: tk };
  });

  const existing = await db.trades.toArray();
  const keySet = new Set(existing.map(x=>x.tradeKey));
  const toAdd = normalized.filter(r=>r.tradeKey && !keySet.has(r.tradeKey));
  if (toAdd.length) await db.trades.bulkAdd(toAdd);
  return { added: toAdd.length, skipped: normalized.length - toAdd.length };
}

async function syncFromApiIntoDb(){
  try{
    const res = await fetch(DATA_URL, { cache:"no-store" });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const rows = normalizeApiRows(data);
    const r = await upsertTrades(rows);
    const total = await db.trades.count();
    els.dbBadge.textContent = `Sync OK (+${r.added}) • totaal ${total}`;
    return { ok:true, total, ...r };
  }catch(e){
    els.dbBadge.textContent = "Sync offline";
    return { ok:false, err:String(e?.message||e) };
  }
}

// ---------- Filtering / Aggregation ----------
async function getFilteredTrades(){
  let items = await db.trades.toArray();
  const nowRef = items.length ? new Date(items.reduce((m,t)=>(t.datetime>m?t.datetime:m), items[0].datetime)) : new Date();
  const cutoff = rangeCutoffIso(state.range, nowRef);
  if(cutoff) items = items.filter(t=>t.datetime>=cutoff);
  if(state.exchange!=="ALL") items = items.filter(t=>t.exchange===state.exchange);
  if(state.marketType!=="ALL") items = items.filter(t=>t.marketType===state.marketType);
  if(state.search){
    const q = state.search.toLowerCase();
    items = items.filter(t =>
      (t.symbol||"").toLowerCase().includes(q) ||
      (t.notes||"").toLowerCase().includes(q) ||
      (t.tradeKey||"").toLowerCase().includes(q)
    );
  }
  items.sort((a,b)=>(a.datetime<b.datetime?1:-1));
  return items;
}
function aggregateKPIs(trades){
  const net=trades.reduce((s,t)=>s+(t.netPnlUsd||0),0);
  const fees=trades.reduce((s,t)=>s+(t.feesUsd||0),0);
  const wins=trades.filter(t=>(t.netPnlUsd||0)>0).length;
  const count=trades.length;
  const winrate=count?wins/count:0;
  return { net, fees, wins, count, winrate };
}
function buildEquitySeries(tradesAsc){
  let cum=0; const pts=[];
  for(const t of tradesAsc){ cum += (t.netPnlUsd||0); pts.push({x:t.datetime,y:cum}); }
  return pts;
}
function monthlyBuckets(trades, nowRef){
  const now = nowRef instanceof Date ? nowRef : new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const months=[];
  for(let i=11;i>=0;i--){
    const d=addMonthsUTC(start.getUTCFullYear(), start.getUTCMonth(), -i);
    const key=`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`;
    months.push({ key, label:key, net:0, fees:0, funding:0 });
  }
  const map=new Map(months.map(m=>[m.key,m]));
  for(const t of trades){
    const d=new Date(t.datetime);
    const key=`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`;
    const m=map.get(key);
    if(m){ m.net+=(t.netPnlUsd||0); m.fees+=(t.feesUsd||0); m.funding+=(t.fundingUsd||0); }
  }
  return months;
}

function dailyBuckets(trades, nowRef, daysBack=30){
  const now = nowRef instanceof Date ? nowRef : new Date();
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const buckets=[];
  for(let i=daysBack-1;i>=0;i--){
    const d = new Date(base.getTime());
    d.setUTCDate(d.getUTCDate()-i);
    const key = d.toISOString().slice(0,10);
    buckets.push({ key, label: key, net: 0 });
  }
  const map=new Map(buckets.map(b=>[b.key,b]));
  for(const t of trades){
    const key = String(t.datetime||"").slice(0,10);
    const b = map.get(key);
    if (b) b.net += (t.netPnlUsd || 0);
  }
  return buckets;
}


// ---------- Charts ----------
function clearCanvas(ctx){ ctx.clearRect(0,0,ctx.canvas.width,ctx.canvas.height); }

function drawLineChart(canvas, points, { yLabel = "" } = {}) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  if (!points.length) {
    ctx.fillStyle = "rgba(229,231,235,.8)";
    ctx.font = "14px system-ui";
    ctx.fillText("Geen data (wacht op sync of importeer).", 16, 32);
    return;
  }

  const pad = 50;
  const xs = points.map(p => new Date(p.x).getTime());
  const ys = points.map(p => p.y);

  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const ymin = Math.min(...ys), ymax = Math.max(...ys);
  const yPad = (ymax - ymin) * 0.08 || 1;
  const y0 = ymin - yPad, y1 = ymax + yPad;

  const X = (t) => pad + (t - xmin) / (xmax - xmin || 1) * (w - pad * 1.2);
  const Y = (v) => h - pad - (v - y0) / (y1 - y0 || 1) * (h - pad * 1.4);

  // grid
  ctx.strokeStyle = "rgba(154,164,178,.15)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 5; i++) {
    const gy = pad + i * (h - pad * 1.4) / 4;
    ctx.beginPath();
    ctx.moveTo(pad, gy);
    ctx.lineTo(w - pad * 0.2, gy);
    ctx.stroke();
  }

  // labels
  ctx.fillStyle = "rgba(154,164,178,.8)";
  ctx.font = "12px system-ui";
  ctx.fillText(yLabel, 12, 18);

  // zero line
  const yZero = Y(0);
  ctx.strokeStyle = "rgba(154,164,178,.35)";
  ctx.beginPath();
  ctx.moveTo(pad, yZero);
  ctx.lineTo(w - pad * 0.2, yZero);
  ctx.stroke();

  const fillArea = (state.chartMode === "area");
  const green = "rgba(34,197,94,0.95)";
  const red = "rgba(239,68,68,0.95)";

  function drawSegment(pA, pB, color) {
    const x1 = X(new Date(pA.x).getTime());
    const y1p = Y(pA.y);
    const x2 = X(new Date(pB.x).getTime());
    const y2p = Y(pB.y);

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x1, y1p);
    ctx.lineTo(x2, y2p);
    ctx.stroke();

    if (fillArea) {
      // crude opacity adjustment: keeps hue but makes it transparent
      const fill = color.includes("34,197,94") ? "rgba(34,197,94,0.18)" : "rgba(239,68,68,0.18)";
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(x1, yZero);
      ctx.lineTo(x1, y1p);
      ctx.lineTo(x2, y2p);
      ctx.lineTo(x2, yZero);
      ctx.closePath();
      ctx.fill();
    }
  }

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const aPos = a.y >= 0;
    const bPos = b.y >= 0;

    if (aPos === bPos) {
      drawSegment(a, b, aPos ? green : red);
      continue;
    }

    // crossing: split at y=0 by linear interpolation
    const t = (0 - a.y) / (b.y - a.y || 1);
    const ax = new Date(a.x).getTime();
    const bx = new Date(b.x).getTime();
    const ix = ax + (bx - ax) * t;
    const ip = { x: new Date(ix).toISOString(), y: 0 };

    drawSegment(a, ip, aPos ? green : red);
    drawSegment(ip, b, bPos ? green : red);
  }
}


function drawBarChart(canvas, buckets){
  const ctx=canvas.getContext("2d");
  const w=canvas.width, h=canvas.height;
  clearCanvas(ctx);
  if(!buckets.length) return;
  const pad=50;
  const vals=buckets.map(b=>b.net);
  const vmax=Math.max(...vals,0);
  const vmin=Math.min(...vals,0);
  const span=(vmax-vmin)||1;
  function Y(v){ return h-pad - (v-vmin)/span*(h-pad*1.4); }

  ctx.strokeStyle="rgba(154,164,178,.15)";
  ctx.lineWidth=1;
  for(let i=0;i<5;i++){
    const y=pad + i*(h-pad*1.4)/4;
    ctx.beginPath(); ctx.moveTo(pad,y); ctx.lineTo(w-pad*0.2,y); ctx.stroke();
  }

  const barW=(w-pad*1.2)/buckets.length;
  for(let i=0;i<buckets.length;i++){
    const b=buckets[i];
    const x=pad + i*barW + barW*0.15;
    const bw=barW*0.7;
    const y0=Y(0), yv=Y(b.net);
    const top=Math.min(y0,yv);
    const bh=Math.abs(y0-yv);
    ctx.fillStyle=b.net>=0 ? "rgba(34,197,94,.85)" : "rgba(239,68,68,.85)";
    ctx.fillRect(x, top, bw, bh);
  }

  ctx.fillStyle="rgba(154,164,178,.9)";
  ctx.font="11px system-ui";
  for(let i=0;i<buckets.length;i+=2){
    const x=pad + i*barW + barW*0.1;
    ctx.fillText(buckets[i].label.slice(2), x, h-18);
  }
}

// ---------- Render ----------
function setKpi(el, valueText, goodBad=null, subText=null){
  el.classList.remove("good","bad");
  if(goodBad==="good") el.classList.add("good");
  if(goodBad==="bad") el.classList.add("bad");
  el.querySelector(".value").textContent=valueText;
  if(subText!==null) el.querySelector(".sub").textContent=subText;
}

async function renderAll(){
  const trades=await getFilteredTrades();
  const k=aggregateKPIs(trades);
  els.summaryLine.textContent = `${k.count} trades • ${state.exchangeFilter}/${state.marketType} • ${state.range}`;

  const netC=convertUsdToSelected(k.net);
  const feeC=convertUsdToSelected(k.fees);

  if (els.kpiNet) setKpi(els.kpiNet, formatMoney(netC, convertedLabel()), netC>=0 ? "good":"bad");
  if (els.kpiFees) setKpi(els.kpiFees, formatMoney(feeC, convertedLabel()));
  if (els.kpiWinrate) setKpi(els.kpiWinrate, formatPct(k.winrate), null, `${k.wins} / ${k.count}`);

  els.countBadge.textContent = `${k.count} trades`;
  els.tradeCount.textContent = `${k.count} trades`;
  // Equity
  const tradesAsc=[...trades].sort((a,b)=>(a.datetime>b.datetime?1:-1));
  const ptsUsd=buildEquitySeries(tradesAsc);
  const pts=ptsUsd.map(p=>({x:p.x,y:convertUsdToSelected(p.y)}));
  drawLineChart(els.equityCanvas, pts, { yLabel:`Cumulatief (${convertedLabel()})` });

  // Monthly
  const nowRef = trades.length ? new Date(trades[0].datetime) : new Date();
  const bucketsUsd=monthlyBuckets(trades, nowRef);
  const buckets=bucketsUsd.map(b=>({ ...b, net:convertUsdToSelected(b.net) }));
  drawBarChart(els.monthlyCanvas, buckets);
  const net12=buckets.reduce((s,b)=>s+b.net,0);
  els.monthlyHint.textContent=`Som 12 maanden: ${formatMoney(net12, convertedLabel())}`;


  // Analyse (fixed windows based on latest timestamp in filtered dataset, ignoring state.range)
  try{
    const allForAnalyse = applyExchangeFilter(await db.trades.toArray());
    const analyseBase = allForAnalyse
      .filter(t => (state.marketType==="ALL" || t.marketType===state.marketType))
      .filter(t => (state.exchange==="ALL" || t.exchange===state.exchange));
    analyseBase.sort((a,b)=>(a.datetime<b.datetime?-1:1));
    const nowIso = analyseBase.length ? analyseBase[analyseBase.length-1].datetime : new Date().toISOString();
    const now = new Date(nowIso);
    const cutoffDays = (d)=> new Date(now.getTime() - d*24*3600*1000).toISOString();
    const sumNet = (arr)=>arr.reduce((s,t)=>s+(t.netPnlUsd||0),0);
    const inWindow = (d)=> analyseBase.filter(t=>t.datetime>=cutoffDays(d));
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const todayRows = analyseBase.filter(t=>t.datetime>=todayStart);
    const rows7 = inWindow(7);
    const rows30 = inWindow(30);
    const netToday = convertUsdToSelected(sumNet(todayRows));
    const net7 = convertUsdToSelected(sumNet(rows7));
    const net30 = convertUsdToSelected(sumNet(rows30));

    if (els.kpiToday) setKpi(els.kpiToday, formatMoney(netToday, convertedLabel()), netToday>=0?"good":"bad");
    if (els.kpi7d) setKpi(els.kpi7d, formatMoney(net7, convertedLabel()), net7>=0?"good":"bad");
    if (els.kpi30d) setKpi(els.kpi30d, formatMoney(net30, convertedLabel()), net30>=0?"good":"bad");

    const wins = analyseBase.filter(t=>(t.netPnlUsd||0)>0).length;
    const cnt = analyseBase.length;
    const winrate = cnt? wins/cnt:0;
    if (els.analyseWinrate) els.analyseWinrate.textContent = `${(winrate*100).toFixed(1)}% (${wins}/${cnt})`;
    if (els.analyseTrades) els.analyseTrades.textContent = String(cnt);
    if (els.analyseAvg) {
      const avg = cnt ? convertUsdToSelected(sumNet(analyseBase))/cnt : 0;
      els.analyseAvg.textContent = formatMoney(avg, convertedLabel());
    }
    if (els.analyseRangeBadge) els.analyseRangeBadge.textContent = `${state.exchangeFilter} • ${state.marketType}`;

    // Analyse charts
    const ptsAUsd = buildEquitySeries(analyseBase);
    const ptsA = ptsAUsd.map(p=>({x:p.x,y:convertUsdToSelected(p.y)}));
    if (els.analyseEquityCanvas) drawLineChart(els.analyseEquityCanvas, ptsA, { yLabel:`Cumulatief (${convertedLabel()})` });

    const daily = dailyBuckets(analyseBase, now, 30).map(b=>({ ...b, net: convertUsdToSelected(b.net) }));
    if (els.analyseDailyCanvas) drawBarChart(els.analyseDailyCanvas, daily, { labelMode:"DD-MM" });
  }catch(e){ /* ignore */ }


  // Table
  const rows=trades.slice(0,500);
  els.tradeRows.innerHTML = rows.map(t=>{
    const dt=new Date(t.datetime);
    const dtLabel=dt.toLocaleString("nl-NL",{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"});
    const fees=convertUsdToSelected(t.feesUsd||0);
    const pnl=convertUsdToSelected(t.realizedPnlUsd||0);
    const net=convertUsdToSelected(t.netPnlUsd||0);
    return `<tr>
      <td class="mono">${dtLabel}</td>
      <td>${t.exchange}</td>
      <td>${t.symbol}</td>
      <td>${t.marketType}</td>
      <td>${t.side}</td>
      <td class="right mono">${Number(t.qty||0).toFixed(4)}</td>
      <td class="right mono">${Number(t.price||0).toFixed(4)}</td>
      <td class="right mono">${formatMoney(fees, convertedLabel())}</td>
      <td class="right mono ${pnlClass(pnl)}">${formatMoney(pnl, convertedLabel())}</td>
      <td class="right mono ${pnlClass(net)}">${formatMoney(net, convertedLabel())}</td>
      <td class="mono muted">${safeText(t.notes).slice(0,40)}</td>
    </tr>`;
  }).join("");
}


// ---------- Calculator ----------
const CALC_LS_KEY = "pnl_calc_v1";

function loadCalcDefaults(){
  try{
    const raw = localStorage.getItem(CALC_LS_KEY);
    if(!raw) return;
    const o = JSON.parse(raw);
    if (els.calcSide && o.side) els.calcSide.value = o.side;
    if (els.calcEntry && o.entry !== undefined) els.calcEntry.value = o.entry;
    if (els.calcStop && o.stop !== undefined) els.calcStop.value = o.stop;
    if (els.calcTP && o.tp !== undefined) els.calcTP.value = o.tp;
    if (els.calcBalance && o.balance !== undefined) els.calcBalance.value = o.balance;
    if (els.calcRiskPct && o.riskPct !== undefined) els.calcRiskPct.value = o.riskPct;
    if (els.calcUsePct && o.usePct !== undefined) els.calcUsePct.checked = !!o.usePct;
    if (els.calcRisk && o.risk !== undefined) els.calcRisk.value = o.risk;
    if (els.calcContractSize && o.contractSize !== undefined) els.calcContractSize.value = o.contractSize;
    if (els.calcLev && o.lev !== undefined) els.calcLev.value = o.lev;
    if (els.calcFeePct && o.feePct !== undefined) els.calcFeePct.value = o.feePct;
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
      lev: els.calcLev?.value || "1",
      feePct: els.calcFeePct?.value || "0.08",
      balance: els.calcBalance?.value || "",
      riskPct: els.calcRiskPct?.value || "",
      usePct: !!els.calcUsePct?.checked,
      contractSize: els.calcContractSize?.value || "1"
    };
    localStorage.setItem(CALC_LS_KEY, JSON.stringify(o));
  }catch{}
}

function setKpiText(kpiEl, valueText, subText){
  if(!kpiEl) return;
  kpiEl.querySelector(".value").textContent = valueText;
  if (subText !== undefined) kpiEl.querySelector(".sub").textContent = subText;
}

function fmtInputNumber(n, decimals=8){
  if(n === null || n === undefined || !isFinite(n)) return "";
  const s = Number(n).toFixed(decimals);
  return s.replace(/\.0+$/,'').replace(/(\.\d*?)0+$/,'$1');
}

function convertAmountBetweenCurrencies(amount, fromCur, toCur){
  const r = state.fx.usdToEur;
  if(!r) return amount;
  if(fromCur === toCur) return amount;
  if(fromCur === "USD" && toCur === "EUR") return amount * r;
  if(fromCur === "EUR" && toCur === "USD") return amount / r;
  return amount;
}

// When switching USD/EUR, keep underlying USD value constant by converting the input fields.
function convertCalculatorInputs(prevCur, nextCur){
  if(!state.fx.usdToEur) return;
  const fields = [els.calcEntry, els.calcStop, els.calcTP, els.calcRisk, els.calcBalance];
  for(const el of fields){
    if(!el) continue;
    const v = parseNumber(el.value);
    if(!v) continue;
    const converted = convertAmountBetweenCurrencies(v, prevCur, nextCur);
    const dec = (el === els.calcRisk || el === els.calcBalance) ? 2 : 8;
    el.value = fmtInputNumber(converted, dec);
  }
}

function calcCompute(){
  if(!els.calcEntry) return;

  // risk currency badge follows selected currency in header
  if (els.calcRiskCur) els.calcRiskCur.textContent = state.currency;

  const side = (els.calcSide?.value || "LONG").toUpperCase();

  // Calculator inputs follow the selected currency (USD/EUR)
  const entrySelected = parseNumber(els.calcEntry.value);
  const stopSelected = parseNumber(els.calcStop.value);
  const tpSelected = parseNumber(els.calcTP?.value || "");

  let entryUsd = entrySelected;
  let stopUsd  = stopSelected;
  let tpUsd    = tpSelected;

  if (state.currency === "EUR" && state.fx.usdToEur) {
    entryUsd = entrySelected / state.fx.usdToEur;
    stopUsd  = stopSelected  / state.fx.usdToEur;
    tpUsd    = tpSelected    / state.fx.usdToEur;
  }
  const lev = Math.max(1, parseNumber(els.calcLev?.value || "1") || 1);
  const feePct = Math.max(0, parseNumber(els.calcFeePct?.value || "0") || 0) / 100;
  const contractSize = Math.max(0, parseNumber(els.calcContractSize?.value || "1") || 0) || 1;

  // Inputs are in selected currency (header). Convert to USD for sizing.
  const riskSelected = parseNumber(els.calcRisk?.value || "");
  const balSelected = parseNumber(els.calcBalance?.value || "");
  const riskPct = parseNumber(els.calcRiskPct?.value || "");
  const usePct = !!els.calcUsePct?.checked;

  let riskUsd = riskSelected;
  let balUsd = balSelected;

  if (state.currency === "EUR" && state.fx.usdToEur) {
    riskUsd = riskSelected / state.fx.usdToEur;
    balUsd = balSelected / state.fx.usdToEur;
  }

  if (usePct) {
    if (!balUsd || !riskPct) {
      els.calcHint && (els.calcHint.textContent = "Vul balance + risk% in (of zet 'gebruik %' uit).");
      return;
    }
    riskUsd = balUsd * (riskPct / 100);
  }

  if (!entryUsd || !stopUsd || !riskUsd) {
    els.calcHint && (els.calcHint.textContent = "Vul entry, stop en risico in.");
    setKpiText(els.calcKpiQty, "—", "Aantal contracts/coins");
    setKpiText(els.calcKpiNotional, "—", "Entry × qty");
    setKpiText(els.calcKpiMargin, "—", "Notional / leverage");
    setKpiText(els.calcKpiSL, "—", "Doel ≈ risico");
    setKpiText(els.calcKpiTP, "—", "RR: —");
    els.calcKpiTP?.classList.remove("good","bad","warn");
    return;
  }

  const perUnitRisk = Math.abs(entryUsd - stopUsd);
  if (perUnitRisk <= 0) {
    els.calcHint && (els.calcHint.textContent = "Stop mag niet gelijk zijn aan entry.");
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

// Chart toggle buttons
const btnChartZero = document.getElementById("btnChartZero");
const btnChartArea = document.getElementById("btnChartArea");
function setChartMode(mode){
  state.chartMode = mode;
  btnChartZero?.classList.toggle("active", mode==="zero");
  btnChartArea?.classList.toggle("active", mode==="area");
  renderAll();
}
btnChartZero?.addEventListener("click", ()=>setChartMode("zero"));
btnChartArea?.addEventListener("click", ()=>setChartMode("area"));


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
  state.currency=els.currency.value;
  state.exchange=els.exchange.value;
  state.marketType=els.marketType.value;
  state.range=els.range.value;

  state.exchangeFilter = localStorage.getItem("pnl_exchange_filter") || "ALL";
  if (els.exPills){
    [...els.exPills.querySelectorAll(".ex-pill")].forEach(x=>x.classList.toggle("active", x.dataset.ex===state.exchangeFilter));
  }

  wireCalculator();

  // first sync + render
  await syncFromApiIntoDb();
  await renderAll();

  // auto refresh
  setInterval(async()=>{
    await syncFromApiIntoDb();
    await renderAll();
  }, REFRESH_MS);
})();