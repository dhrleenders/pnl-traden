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
  ,calMonth: null, // month number 1-12
  calYear: null,  // 4-digit
  calSelected: null, // YYYY-MM-DD selected day
  calView: 'day' // 'day' | 'week' | 'month'
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

  calMonth: document.getElementById("calMonth"),
  calViewDay: document.getElementById("calViewDay"),
  calViewWeek: document.getElementById("calViewWeek"),
  calViewMonth: document.getElementById("calViewMonth"),
  calHead: document.getElementById("calHead"),
    calYear: document.getElementById("calYear"),
  calPrev: document.getElementById("calPrev"),
  calNext: document.getElementById("calNext"),
  calDetails: document.getElementById("calDetails"),
calGrid: document.getElementById("calGrid"),
  calTotalPnl: document.getElementById("calTotalPnl"),
  calTotalPct: document.getElementById("calTotalPct"),
  calWinDays: document.getElementById("calWinDays"),
  calLoseDays: document.getElementById("calLoseDays"),
  calBeDays: document.getElementById("calBeDays"),

  calMonth: document.getElementById("calMonth"),
  calViewDay: document.getElementById("calViewDay"),
  calViewWeek: document.getElementById("calViewWeek"),
  calViewMonth: document.getElementById("calViewMonth"),
  calHead: document.getElementById("calHead"),
  calGrid: document.getElementById("calGrid"),
  calTotalPnl: document.getElementById("calTotalPnl"),
  calTotalPct: document.getElementById("calTotalPct"),
  calWinDays: document.getElementById("calWinDays"),
  calLoseDays: document.getElementById("calLoseDays"),
  calBeDays: document.getElementById("calBeDays"),
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


function isRealTradeRow(t){
  const side = String(t.side || "").toUpperCase();
  const notes = String(t.notes || "").toLowerCase();

  // Exclude common non-trade events
  if (side.includes("FUNDING")) return false;
  if (side.includes("FEE")) return false;
  if (side.includes("TRANSFER")) return false;
  if (side.includes("DEPOSIT")) return false;
  if (side.includes("WITHDRAW")) return false;
  if (notes.includes("funding")) return false;
  if (notes.includes("fee")) return false;
  if (notes.includes("account log")) return false;
  if (notes.includes("account-log")) return false;

  // Include obvious trades
  if (side === "BUY" || side === "SELL") return true;
  if (side.includes("FUTURES TRADE")) return true;

  // Shape-based fallback: has qty or trade price (common for fills)
  const qty = Number(t.qty || 0);
  const price = Number(t.price || 0);
  return (isFinite(qty) && qty !== 0) || (isFinite(price) && price !== 0);
}

function rangeLabelNL(kind, startIso, endIso){
  // endIso is exclusive
  const s = new Date(startIso);
  const e = new Date(new Date(endIso).getTime() - 1);
  const fmtDay = (d)=> d.toLocaleDateString("nl-NL",{year:"numeric",month:"2-digit",day:"2-digit"});
  if(kind==="day") return fmtDay(s);
  if(kind==="week" || kind==="month") return `${fmtDay(s)} – ${fmtDay(e)}`;
  return `${fmtDay(s)} – ${fmtDay(e)}`;
}

function startOfWeekUTC(d){
  // Monday start
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (x.getUTCDay()+6)%7; // Mon=0..Sun=6
  x.setUTCDate(x.getUTCDate() - dow);
  return x;
}

function addDaysUTC(d, n){
  const x = new Date(d.getTime());
  x.setUTCDate(x.getUTCDate() + n);
  return x;
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

  // tradeKey is primary key -> bulkPut overwrites, prevents duplicates on refresh
  const valid = normalized.filter(r=>r.tradeKey);
  if(valid.length) await db.trades.bulkPut(valid);
  return { added: valid.length, skipped: normalized.length - valid.length };
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
// Like getFilteredTrades(), but ignores the selected time range/search so totals don’t jump when you switch 1w/1m/etc.
async function getTradesForTotalKpi(){
  let items = await db.trades.toArray();

  // Respect exchange + marketType filters
  if(state.exchangeFilter && state.exchangeFilter !== "ALL"){
    items = items.filter(t => (t.exchange || '').toUpperCase() === state.exchangeFilter);
  }
  if(state.marketType && state.marketType !== "ALL"){
    items = items.filter(t => (t.marketType || '').toUpperCase() === state.marketType);
  }
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

function drawLineChart(canvas, points, { yLabel = "", percentBase = null, percentMode = "pnl" } = {}) {
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

  // Always render the nicer "filled" style (similar to the Kraken app)
  const fillArea = true;
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

  // Kraken-like crosshair + tooltip (amount + %) on hover/drag
  try {
    const baseVal = points.length ? (Number(points[0].y) || 0) : 0;
    const pctBase = (Number.isFinite(percentBase) && Number(percentBase) > 0) ? Number(percentBase) : null;
    const pixelPoints = points.map(p => {
      const t = new Date(p.x).getTime();
      const val = Number(p.y) || 0;
      let pct = 0;
      if (pctBase){
        pct = (percentMode === "total") ? (((val - pctBase) / pctBase) * 100) : ((val / pctBase) * 100);
      } else if (baseVal){
        pct = ((val - baseVal) / Math.abs(baseVal)) * 100;
      }
      const label = new Date(p.x).toISOString().slice(0, 10);
      return { x: X(t), y: Y(val), val, pct, label };
    });
    setupInteractiveLineChart(canvas, pixelPoints, {
      valueLabel: yLabel || "Value",
      formatValue: (v) => formatMoney(v),
      formatExtra: (_v, pt) => `(${(pt?.pct ?? 0).toFixed(2)}%)`,
    });
  } catch (e) {
    console.warn("crosshair setup failed", e);
  }
}



// ------------------------------------------------------------
// Interactive line chart (crosshair + tooltip) for canvas charts
// ------------------------------------------------------------
function setupInteractiveLineChart(baseCanvas, points, opts = {}) {
  if (!baseCanvas || !points || points.length === 0) return;
  const wrap = baseCanvas.parentElement;
  if (wrap) wrap.classList.add("chartWrap");

  let overlay = wrap ? wrap.querySelector("canvas.chartOverlay") : null;
  if (!overlay) {
    overlay = document.createElement("canvas");
    overlay.className = "chartOverlay";
    if (wrap) wrap.appendChild(overlay);
  }
  overlay.width = baseCanvas.width;
  overlay.height = baseCanvas.height;
  overlay.style.width = baseCanvas.style.width || "100%";
  overlay.style.height = baseCanvas.style.height || "100%";

  let tip = wrap ? wrap.querySelector(".chartTooltip") : null;
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "chartTooltip";
    tip.style.display = "none";
    if (wrap) wrap.appendChild(tip);
  }

  const ctx = overlay.getContext("2d");

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
  }[c]));

  function getPctBase() {
    const raw = localStorage.getItem("pnl_start_balance_usd");
    const n = raw ? Number(raw) : 0;
    return Number.isFinite(n) ? n : 0;
  }
  const fmtMoney = (n) => {
    if (!Number.isFinite(n)) return "—";
    const cur = convertedLabel();
    return formatMoney(n, cur);
  };
  const fmtPct = (p) => {
    if (!Number.isFinite(p)) return "—";
    const sign = p >= 0 ? "+" : "";
    return sign + p.toFixed(2) + "%";
  };

  function clear() { ctx.clearRect(0,0,overlay.width,overlay.height); }

  function drawAt(clientX, clientY) {
    const rect = overlay.getBoundingClientRect();
    const xCss = clientX - rect.left;
    const sx = overlay.width / rect.width;
    const x = xCss * sx;

    let best = 0, bestDx = Infinity;
    for (let i=0;i<points.length;i++){
      const dx = Math.abs(points[i].x - x);
      if (dx < bestDx) { bestDx = dx; best = i; }
    }
    const p = points[best];
    if (!p) return;

    clear();

    // crosshair
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(p.x + 0.5, 0);
    ctx.lineTo(p.x + 0.5, overlay.height);
    ctx.stroke();

    // point
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4.5, 0, Math.PI*2);
    ctx.fill();
    ctx.stroke();
    
    ctx.restore();

    const base = getPctBase();
    const pct = (base && Number.isFinite(p.val)) ? (p.val / base * 100) : NaN;
    const pctClass = Number.isFinite(pct) ? (pct >= 0 ? "pos" : "neg") : "";

    tip.innerHTML =
      `<div><b>${esc(p.label || "")}</b></div>` +
      `<div>${esc(opts.valueLabel || "Value")}: <b>${esc(fmtMoney(p.val))}</b></div>` +
      `<div class="pct ${pctClass}">Return: <b>${esc(fmtPct(pct))}</b></div>` +
      (base ? `<div style="opacity:.75">Base: ${esc(base.toFixed(2))}</div>` :
              `<div style="opacity:.75">Tip: long-press / right-click to set base</div>`);

    tip.style.display = "block";

    // position tooltip (CSS coords)
    const tipPad = 10;
    const tipW = tip.offsetWidth || 160;
    const tipH = tip.offsetHeight || 60;

    let left = (p.x / sx) + tipPad;
    let top = (p.y / (overlay.height / rect.height)) - tipH - tipPad;

    if (left + tipW > rect.width) left = (p.x / sx) - tipW - tipPad;
    if (left < 0) left = 0;
    if (top < 0) top = (p.y / (overlay.height / rect.height)) + tipPad;
    if (top + tipH > rect.height) top = rect.height - tipH;

    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }

  let raf = 0;
  function onMove(e){
    const pt = e.touches ? e.touches[0] : e;
    if (!pt) return;
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => drawAt(pt.clientX, pt.clientY));
  }
  function onLeave(){
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    clear();
    tip.style.display = "none";
  }

  overlay.addEventListener("mousemove", onMove, {passive:true});
  overlay.addEventListener("mouseleave", onLeave, {passive:true});
  overlay.addEventListener("touchstart", onMove, {passive:true});
  overlay.addEventListener("touchmove", onMove, {passive:true});
  overlay.addEventListener("touchend", onLeave, {passive:true});

  // mobile-friendly base setter
  overlay.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    const current = localStorage.getItem("pnl_start_balance_usd") || "";
    const v = prompt("Start balance (USD) for % return calc:", current);
    if (v === null) return;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) {
      localStorage.removeItem("pnl_start_balance_usd");
      alert("Cleared start balance.");
    } else {
      localStorage.setItem("pnl_start_balance_usd", String(n));
    }
  });
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
// Manual base (stortingen - opnames) per exchange filter
const deposits = loadDeposits();
const depositBaseUsd = depositsForCurrentExchange(deposits); // number or null
const baseUsd = (typeof depositBaseUsd === "number" && isFinite(depositBaseUsd)) ? depositBaseUsd : 0;

  els.summaryLine.textContent = `${k.count} trades • ${state.exchangeFilter}/${state.marketType} • ${state.range}`;

  const netC=convertUsdToSelected(k.net);
  const feeC=convertUsdToSelected(k.fees);
  // Total value (manual deposits) should NOT change when you switch 1w/1m/etc.
  const tradesAll = await getTradesForTotalKpi();
  const kAll = aggregateKPIs(tradesAll);
  const totalValueUsd = baseUsd + (kAll.net || 0);
  const totalValueC = convertUsdToSelected(totalValueUsd);



  if (els.kpiTotal) setKpi(els.kpiTotal, formatMoney(totalValueC, convertedLabel()), totalValueC>=0 ? "good":"bad", "(Stortingen - opnames) + Net PnL");
  if (els.kpiNet) setKpi(els.kpiNet, formatMoney(netC, convertedLabel()), netC>=0 ? "good":"bad");
  if (els.kpiFees) setKpi(els.kpiFees, formatMoney(feeC, convertedLabel()));
  if (els.kpiWinrate) setKpi(els.kpiWinrate, formatPct(k.winrate), null, `${k.wins} / ${k.count}`);  els.tradeCount.textContent = `${k.count} trades`;

// Equity / charts
const tradesAsc=[...trades].sort((a,b)=>(a.datetime>b.datetime?1:-1));
const ptsUsd=buildEquitySeries(tradesAsc);
const baseUsdForSeries = baseUsd;

// Choose chart series
const seriesUsd = (state.chartMode === "total")
  ? ptsUsd.map(p => ({ x: p.x, y: baseUsdForSeries + (p.y || 0) }))
  : ptsUsd;

const pts = seriesUsd.map(p => ({ x: p.x, y: convertUsdToSelected(p.y) }));
const yLabel = (state.chartMode === "total")
  ? `Totale waarde (${convertedLabel()})`
  : `Cumulatief PnL (${convertedLabel()})`;

// Percent base = deposits (converted)
const pctBase = convertUsdToSelected(baseUsdForSeries);

drawLineChart(els.equityCanvas, pts, { yLabel, percentBase: pctBase, percentMode: state.chartMode });

if (els.dashChartTitle) els.dashChartTitle.textContent = (state.chartMode === "total") ? "Total chart" : "PnL chart";
if (els.dashChartSub) {
  els.dashChartSub.textContent = (state.chartMode === "total")
    ? "Schatting: stortingen + cumulatieve PnL."
    : "Cumulatieve Net PnL uit je trades/account-log.";
}

  // Monthly (view removed; keep as optional so older code doesn't crash)
  if (els.monthlyCanvas && els.monthlyHint) {
    const nowRef = trades.length ? new Date(trades[0].datetime) : new Date();
    const bucketsUsd = monthlyBuckets(trades, nowRef);
    const buckets = bucketsUsd.map(b => ({ ...b, net: convertUsdToSelected(b.net) }));
    drawBarChart(els.monthlyCanvas, buckets);
    const net12 = buckets.reduce((s, b) => s + b.net, 0);
    els.monthlyHint.textContent = `Som 12 maanden: ${formatMoney(net12, convertedLabel())}`;
  }


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

    // Calendar
    if (els.calMonth && els.calGrid) {
      const deps = await loadDeposits();
      renderAnalyseCalendar(analyseBase, deps);
    }

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


// ---- Analyse: calendar ----
function fmtYM(d){
  const y=d.getUTCFullYear();
  const m=String(d.getUTCMonth()+1).padStart(2,'0');
  return `${y}-${m}`;
}
function parseYM(ym){
  const [y,m]=ym.split('-').map(n=>parseInt(n,10));
  return {y, m};
}
function getMonthOptions(trades){
  const set=new Set();
  for(const t of trades){
    if(!t.datetime) continue;
    const d=new Date(t.datetime);
    if(isNaN(d)) continue;
    set.add(fmtYM(d));
  }
  return Array.from(set).sort((a,b)=>a>b?-1:1);
}
function dateKeyUTC(d){
  const y=d.getUTCFullYear();
  const m=String(d.getUTCMonth()+1).padStart(2,'0');
  const day=String(d.getUTCDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

function renderAnalyseCalendar(tradesAll, deposits){
  if(!els.calMonth || !els.calGrid) return;

  // Build available year-month set from trades (UTC)
  const ymSet = new Set();
  const yearSet = new Set();
  for (const t of tradesAll){
    if(!t.datetime) continue;
    const d = new Date(t.datetime);
    if(isNaN(d)) continue;
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    yearSet.add(y);
    ymSet.add(`${y}-${String(m).padStart(2,'0')}`);
  }
  const years = Array.from(yearSet).sort((a,b)=>b-a);
  const monthsAvail = Array.from(ymSet);

  if(years.length===0){
    els.calGrid.innerHTML='';
    if(els.calTotalPnl) els.calTotalPnl.textContent='—';
    if(els.calTotalPct) els.calTotalPct.textContent='—';
    if(els.calWinDays) els.calWinDays.textContent='—';
    if(els.calLoseDays) els.calLoseDays.textContent='—';
    if(els.calBeDays) els.calBeDays.textContent='—';
    if(els.calDetails) els.calDetails.innerHTML='';
    return;
  }

  // Default year/month = most recent trade month
  // Find most recent ym
  let mostRecent = null;
  for (const ym of monthsAvail){
    if(!mostRecent || ym > mostRecent) mostRecent = ym;
  }
  const mr = parseYM(mostRecent);
  if(!state.calYear) state.calYear = mr.y;
  if(!state.calMonth) state.calMonth = mr.m;

  // Populate Year select
  if(els.calYear){
    if(els.calYear.options.length !== years.length){
      els.calYear.innerHTML = years.map(y=>`<option value="${y}">${y}</option>`).join('');
    }
    els.calYear.value = String(state.calYear);
  }

  // Populate Month select (01-12)
  const monthLabels = ["01","02","03","04","05","06","07","08","09","10","11","12"];
  if(els.calMonth){
    if(els.calMonth.options.length !== 12){
      els.calMonth.innerHTML = monthLabels.map(mm=>`<option value="${mm}">${mm}</option>`).join('');
    }
    els.calMonth.value = String(state.calMonth).padStart(2,'0');
  }

  const y = Number(state.calYear);
  const m = Number(state.calMonth);
  const ymKey = `${y}-${String(m).padStart(2,'0')}`;

  
  // View mode: day (current month), week (weeks in current month), month (months in selected year)
  const pnlConv = (usd)=> convertUsdToSelected(usd);
  const eps = 0.0000001;

  // Toggle header + grid layout
  if (els.calHead) els.calHead.style.display = (state.calView === 'day') ? '' : 'none';
  if (els.calGrid){
    els.calGrid.classList.remove('week','month');
    if (state.calView === 'week') els.calGrid.classList.add('week');
    if (state.calView === 'month') els.calGrid.classList.add('month');
  }

  let totalPnlUsd = 0, win=0, lose=0, be=0;
  let html = "";

  if (state.calView === 'month') {
    // 12 month tiles for selected year (ignore month selector for grid)
    const monthTiles = [];
    for (let mm=1; mm<=12; mm++){
      const start = new Date(Date.UTC(y, mm-1, 1));
      const end = new Date(Date.UTC(y, mm, 1));
      let pnl = 0;
      for(const t of tradesAll){
        if(!t.datetime) continue;
        const d = new Date(t.datetime);
        if(isNaN(d)) continue;
        if(d >= start && d < end){
          pnl += Number(t.netPnlUsd||0);
        }
      }
      monthTiles.push({mm, start, end, pnl});
    }

    html = monthTiles.map(t=>{
      totalPnlUsd += t.pnl;
      if(t.pnl > eps) win++; else if(t.pnl < -eps) lose++; else be++;
      const cls = t.pnl > eps ? 'gain' : (t.pnl < -eps ? 'loss' : 'flat');
      const val = pnlConv(t.pnl);
      const show = Math.abs(val) < 0.005 ? '0.00' : val.toFixed(2);
      const sign = t.pnl===0 ? '' : (t.pnl>0?'+':'');
      const selected = (state.calSelected && state.calSelected===`${y}-${String(t.mm).padStart(2,'0')}`) ? ' selected' : '';
      return `<div class="calDay monthCell ${cls}${selected}" data-kind="month" data-start="${t.start.toISOString()}" data-end="${t.end.toISOString()}" data-key="${y}-${String(t.mm).padStart(2,'0')}">
        <div class="n">${String(t.mm).padStart(2,'0')}</div>
        <div class="v">${t.pnl===0?'' : `${sign}${show}`}</div>
        <div class="sub">${y}</div>
      </div>`;
    }).join("");

  } else if (state.calView === 'week') {
    // Weeks that intersect the selected month
    const monthStart = new Date(Date.UTC(y, m-1, 1));
    const monthEnd = new Date(Date.UTC(y, m, 1));

    const firstWeekStart = startOfWeekUTC(monthStart);
    const weekTiles = [];
    for (let ws = new Date(firstWeekStart); ws < monthEnd; ws = addDaysUTC(ws, 7)){
      const we = addDaysUTC(ws, 7);
      // Sum pnl for dates in [ws, we), but only count days that intersect current month
      let pnl = 0;
      for(const t of tradesAll){
        if(!t.datetime) continue;
        const d = new Date(t.datetime);
        if(isNaN(d)) continue;
        if(d >= ws && d < we){
          // intersect check with month
          if(d >= monthStart && d < monthEnd){
            pnl += Number(t.netPnlUsd||0);
          }
        }
      }
      // Label like W02
      const jan1 = new Date(Date.UTC(y,0,1));
      const weekNo = Math.floor((startOfWeekUTC(ws) - startOfWeekUTC(jan1)) / (7*24*3600*1000)) + 1;
      weekTiles.push({ws, we, pnl, weekNo});
    }

    html = weekTiles.map(t=>{
      totalPnlUsd += t.pnl;
      if(t.pnl > eps) win++; else if(t.pnl < -eps) lose++; else be++;
      const cls = t.pnl > eps ? 'gain' : (t.pnl < -eps ? 'loss' : 'flat');
      const val = pnlConv(t.pnl);
      const show = Math.abs(val) < 0.005 ? '0.00' : val.toFixed(2);
      const sign = t.pnl===0 ? '' : (t.pnl>0?'+':'');
      const key = `${y}-W${String(t.weekNo).padStart(2,'0')}`;
      const selected = (state.calSelected && state.calSelected===key) ? ' selected' : '';
      const sLab = new Date(t.ws).toLocaleDateString("nl-NL",{month:"2-digit",day:"2-digit"});
      const eLab = new Date(addDaysUTC(t.we, -1)).toLocaleDateString("nl-NL",{month:"2-digit",day:"2-digit"});
      return `<div class="calDay weekCell ${cls}${selected}" data-kind="week" data-start="${t.ws.toISOString()}" data-end="${t.we.toISOString()}" data-key="${key}">
        <div class="n">W${String(t.weekNo).padStart(2,'0')}</div>
        <div class="v">${t.pnl===0?'' : `${sign}${show}`}</div>
        <div class="sub">${sLab}–${eLab}</div>
      </div>`;
    }).join("");

  } else {
    // DAY view: month grid (Mon-Sun)
    const first = new Date(Date.UTC(y, m-1, 1));
    const nextMonth = new Date(Date.UTC(y, m, 1));
    const daysInMonth = Math.round((nextMonth - first) / (24*3600*1000));

    // Daily pnl map for selected month
    const daily = new Map();
    for(const t of tradesAll){
      if(!t.datetime) continue;
      const d = new Date(t.datetime);
      if(isNaN(d)) continue;
      if(d.getUTCFullYear() !== y) continue;
      if((d.getUTCMonth()+1) !== m) continue;
      const k = dateKeyUTC(d);
      const v = Number(t.netPnlUsd||0);
      daily.set(k, (daily.get(k)||0) + (isFinite(v)?v:0));
    }

    const dow = (first.getUTCDay()+6)%7; // Sun->6, Mon->0
    const cells = [];
    const totalCells = dow + daysInMonth;
    const padAfter = (7 - (totalCells%7))%7;

    for(let i=0;i<dow;i++) cells.push({blank:true});
    for(let day=1; day<=daysInMonth; day++){
      const d=new Date(Date.UTC(y, m-1, day));
      const k=dateKeyUTC(d);
      const pnlUsd = daily.get(k) || 0;
      cells.push({blank:false, day, pnlUsd, dateKey:k});
    }
    for(let i=0;i<padAfter;i++) cells.push({blank:true});

    html = cells.map(c=>{
      if(c.blank) return `<div class="calDay blank"></div>`;
      totalPnlUsd += c.pnlUsd;
      if(c.pnlUsd > eps) win++; else if(c.pnlUsd < -eps) lose++; else be++;

      const cls = c.pnlUsd > eps ? 'gain' : (c.pnlUsd < -eps ? 'loss' : 'flat');
      const val = pnlConv(c.pnlUsd);
      const show = Math.abs(val) < 0.005 ? '0.00' : val.toFixed(2);
      const sign = c.pnlUsd===0 ? '' : (c.pnlUsd>0?'+':'');
      const selected = (state.calSelected && state.calSelected===c.dateKey) ? ' selected' : '';
      return `<div class="calDay ${cls}${selected}" data-kind="day" data-start="${new Date(Date.UTC(y,m-1,c.day)).toISOString()}" data-end="${new Date(Date.UTC(y,m-1,c.day+1)).toISOString()}" data-key="${c.dateKey}">
        <div class="n">${c.day}</div>
        <div class="v">${c.pnlUsd===0?'' : `${sign}${show}`}</div>
      </div>`;
    }).join('');
  }

  els.calGrid.innerHTML = html;


  // Summary
  const baseUsd = depositsForCurrentExchange(deposits) || 0;
  const pct = baseUsd ? (totalPnlUsd / baseUsd) : 0;

  if(els.calTotalPnl) els.calTotalPnl.textContent = formatMoney(pnlConv(totalPnlUsd), convertedLabel());
  if(els.calTotalPct) els.calTotalPct.textContent = baseUsd ? (pct*100).toFixed(2) + "%" : "—";
  if(els.calWinDays) els.calWinDays.textContent = String(win);
  if(els.calLoseDays) els.calLoseDays.textContent = String(lose);
  if(els.calBeDays) els.calBeDays.textContent = String(be);

  // Click handler (delegated)
  if(!els.calGrid._boundClick){
    els.calGrid.addEventListener("click", async (ev)=>{
      const cell = ev.target.closest(".calDay");
      if(!cell || cell.classList.contains("blank")) return;
      const kind = cell.getAttribute('data-kind') || 'day';
      const startIso = cell.getAttribute('data-start');
      const endIso = cell.getAttribute('data-end');
      const key = cell.getAttribute('data-key') || '';
      state.calSelected = key || null;
      renderAnalyseCalendar(tradesAll, deposits);
      if(kind==='day'){
        await renderCalendarDetails(tradesAll, key);
      } else {
        await renderCalendarDetailsRange(tradesAll, startIso, endIso, kind);
      }
    });
    els.calGrid._boundClick = true;
  }

  // Month navigation buttons
  const nav = (delta)=>{
    let yy = Number(state.calYear);
    let mm = Number(state.calMonth);
    mm += delta;
    if(mm<=0){ mm=12; yy-=1; }
    if(mm>=13){ mm=1; yy+=1; }
    state.calYear = yy;
    state.calMonth = mm;
    state.calSelected = null;
    if(els.calYear) els.calYear.value = String(yy);
    if(els.calMonth) els.calMonth.value = String(mm).padStart(2,'0');
    if(els.calDetails) els.calDetails.innerHTML='';
    renderAnalyseCalendar(tradesAll, deposits);
  };

  if(els.calPrev && !els.calPrev._bound){
    els.calPrev.addEventListener("click", ()=>nav(-1));
    els.calPrev._bound = true;
  }
  if(els.calNext && !els.calNext._bound){
    els.calNext.addEventListener("click", ()=>nav(1));
    els.calNext._bound = true;
  }

  // Year/month selects
  if(els.calYear && !els.calYear._bound){
    els.calYear.addEventListener("change", ()=>{
      state.calYear = Number(els.calYear.value);
      state.calSelected = null;
      if(els.calDetails) els.calDetails.innerHTML='';
      renderAnalyseCalendar(tradesAll, deposits);
    });
    els.calYear._bound = true;
  }
  if(els.calMonth && !els.calMonth._bound){
    els.calMonth.addEventListener("change", ()=>{
      state.calMonth = Number(els.calMonth.value);
      state.calSelected = null;
      if(els.calDetails) els.calDetails.innerHTML='';
      renderAnalyseCalendar(tradesAll, deposits);
    });
    els.calMonth._bound = true;
  }


  // Calendar view buttons
  const setView = (v)=>{
    state.calView = v;
    // reset selection + details
    state.calSelected = null;
    if(els.calDetails) els.calDetails.innerHTML='';
    // button UI
    const btns = [
      [els.calViewDay,'day'],
      [els.calViewWeek,'week'],
      [els.calViewMonth,'month']
    ];
    for(const [b,val] of btns){
      if(!b) continue;
      b.classList.toggle('active', v===val);
    }
    renderAnalyseCalendar(tradesAll, deposits);
  };

  if(els.calViewDay && !els.calViewDay._bound){
    els.calViewDay.addEventListener('click', ()=>setView('day'));
    els.calViewDay._bound = true;
  }
  if(els.calViewWeek && !els.calViewWeek._bound){
    els.calViewWeek.addEventListener('click', ()=>setView('week'));
    els.calViewWeek._bound = true;
  }
  if(els.calViewMonth && !els.calViewMonth._bound){
    els.calViewMonth.addEventListener('click', ()=>setView('month'));
    els.calViewMonth._bound = true;
  }

  // Ensure details show something if a day already selected
  if(state.calSelected){
    renderCalendarDetails(tradesAll, state.calSelected);
  } else if (els.calDetails){
    els.calDetails.innerHTML = '';
  }
}

async function renderCalendarDetails(tradesAll, dateKey){
  if(!els.calDetails) return;
  // Filter trades by UTC dateKey
  const dayTrades = tradesAll.filter(t=>{
    if(!t.datetime) return false;
    const d=new Date(t.datetime);
    if(isNaN(d)) return false;
    return dateKeyUTC(d) === dateKey;
  }).sort((a,b)=> (a.datetime>b.datetime?1:-1));

  const pnlUsd = dayTrades.reduce((s,t)=>s+(Number(t.netPnlUsd)||0),0);
  const feeUsd = dayTrades.reduce((s,t)=>s+(Number(t.feesUsd)||0),0);
  const cnt = dayTrades.length;

  const rowsHtml = dayTrades.slice(0,25).map(t=>{
    const dt = new Date(t.datetime);
    const dtLabel = dt.toLocaleString("nl-NL", { year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" });
    const net = convertUsdToSelected(Number(t.netPnlUsd)||0);
    const cls = net>=0 ? "pos":"neg";
    return `<tr>
      <td class="mono">${dtLabel}</td>
      <td>${t.exchange||""}</td>
      <td class="mono">${t.symbol||""}</td>
      <td class="right mono ${cls}">${formatMoney(net, convertedLabel())}</td>
    </tr>`;
  }).join("");

  els.calDetails.innerHTML = `
    <div class="title">${dateKey} • ${cnt} trades</div>
    <div class="muted small" style="margin-bottom:8px">
      Day Net: <span class="${(pnlUsd>=0?'pos':'neg')}">${formatMoney(convertUsdToSelected(pnlUsd), convertedLabel())}</span>
      • Fees: ${formatMoney(convertUsdToSelected(feeUsd), convertedLabel())}
    </div>
    <table>
      <tr><td class="muted small">Time</td><td class="muted small">Ex</td><td class="muted small">Symbol</td><td class="muted small right">Net</td></tr>
      ${rowsHtml || `<tr><td colspan="4" class="muted small">Geen trades.</td></tr>`}
    </table>
    ${cnt>25?`<div class="muted small" style="margin-top:6px">Toont 25/${cnt} trades.</div>`:""}
  `;

function renderCalendarDetailsRange(tradesAll, startIso, endIso, kind){
  if(!els.calDetails) return;
  const start = new Date(startIso);
  const end = new Date(endIso); // exclusive
  const items = tradesAll.filter(t=>{
    if(!t.datetime) return false;
    const d = new Date(t.datetime);
    if(isNaN(d)) return false;
    return d >= start && d < end;
  }).filter(isRealTradeRow).sort((a,b)=> (a.datetime>b.datetime?1:-1));

  const pnlUsd = items.reduce((s,t)=>s+(Number(t.netPnlUsd)||0),0);
  const feeUsd = items.reduce((s,t)=>s+(Number(t.feesUsd)||0),0);
  const cnt = items.length;
  const title = rangeLabelNL(kind, startIso, endIso);

  const rowsHtml = items.slice(0,50).map(t=>{
    const dt = new Date(t.datetime);
    const dtLabel = dt.toLocaleString("nl-NL", { year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" });
    const net = convertUsdToSelected(Number(t.netPnlUsd)||0);
    const cls = net>=0 ? "pos":"neg";
    return `<tr>
      <td class="mono">${dtLabel}</td>
      <td>${t.exchange||""}</td>
      <td class="mono">${t.symbol||""}</td>
      <td class="right mono ${cls}">${formatMoney(net, convertedLabel())}</td>
    </tr>`;
  }).join("");

  els.calDetails.innerHTML = `
    <div class="title">${title} • ${cnt} trades</div>
    <div class="muted small" style="margin-bottom:8px">
      Net: <span class="${(pnlUsd>=0?'pos':'neg')}">${formatMoney(convertUsdToSelected(pnlUsd), convertedLabel())}</span>
      • Fees: ${formatMoney(convertUsdToSelected(feeUsd), convertedLabel())}
    </div>
    <table>
      <tr><td class="muted small">Time</td><td class="muted small">Ex</td><td class="muted small">Symbol</td><td class="muted small right">Net</td></tr>
      ${rowsHtml || `<tr><td colspan="4" class="muted small">Geen trades.</td></tr>`}
    </table>
    ${cnt>50?`<div class="muted small" style="margin-top:6px">Toont 50/${cnt} trades.</div>`:""}
  `;
}


}


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
