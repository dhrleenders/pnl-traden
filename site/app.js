// PnL Traden – local-first PWA (cloud-ready)
// - Loads latest synced JSON from /data/pnl.json (Netlify/GitHub/Cloudflare Pages)
// - Stores trades in IndexedDB (Dexie) so phone works offline
// - Optional CSV imports (BloFin, Kraken trades.csv, Kraken Futures account log CSV)
//
// Data file format supported:
// A) { rows: [ { datetime, exchange, symbol, marketType, side, qty, price, realizedPnlUsd, feesUsd, fundingUsd, netPnlUsd, ... } ] }
// B) Legacy: { closed_trades: [...] }  (we still support it)

const DATA_URL = "/data/pnl.json";
const REFRESH_MS = 30_000;
const FX_CACHE_KEY = "pnl_fx_cache_v1";

const db = new Dexie("pnl_traden_db");
db.version(2).stores({
  trades: "++id, tradeKey, datetime, exchange, symbol, marketType, side, netPnlUsd"
});

const state = {
  fx: { usdToEur: null, asof: null },
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
  importBtn: document.getElementById("importBtn"),
  tabDashboard: document.getElementById("tabDashboard"),
  tabTrades: document.getElementById("tabTrades"),
  tabImport: document.getElementById("tabImport"),
  tabCalculator: document.getElementById("tabCalculator"),
  tabAnalyse: document.getElementById("tabAnalyse"),

  pageDashboard: document.getElementById("pageDashboard"),
  pageTrades: document.getElementById("pageTrades"),
  pageImport: document.getElementById("pageImport"),
  pageCalculator: document.getElementById("pageCalculator"),
  pageAnalyse: document.getElementById("pageAnalyse"),

  kpiNet: document.getElementById("kpiNet"),
  kpiFees: document.getElementById("kpiFees"),
  kpiWinrate: document.getElementById("kpiWinrate"),

  equityCanvas: document.getElementById("equityCanvas"),
  equityWrap: document.getElementById("equityWrap"),
};

function safeNum(x){
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function convertedLabel(){
  return state.currency === "EUR" ? "EUR" : "USD";
}

function convertUsdToSelected(usd){
  if (state.currency === "EUR"){
    const fx = safeNum(state.fx?.usdToEur);
    if (fx > 0) return usd * fx;
  }
  return usd;
}

// Manual base (stortingen - opnames) per exchange filter, stored locally.
// This keeps "Totale waarde" stable even when API balance isn't available.
const DEPOSIT_BASE_KEY = "pnl_deposit_base_v1";
function loadDepositBaseMap(){
  try{
    const raw = localStorage.getItem(DEPOSIT_BASE_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return {
      ALL: Number(obj.ALL ?? 0) || 0,
      KRAKEN: Number(obj.KRAKEN ?? 0) || 0,
      BLOFIN: Number(obj.BLOFIN ?? 0) || 0,
    };
  }catch{
    return { ALL:0, KRAKEN:0, BLOFIN:0 };
  }
}
function saveDepositBaseMap(map){
  try{ localStorage.setItem(DEPOSIT_BASE_KEY, JSON.stringify(map)); }catch{}
}
function getDepositBaseUsdForFilter(exchangeFilter){
  const m = loadDepositBaseMap();
  if (exchangeFilter === "KRAKEN") return m.KRAKEN;
  if (exchangeFilter === "BLOFIN") return m.BLOFIN;
  return m.ALL;
}

async function fetchFxUsdToEur(){
  // cache for 6 hours
  try{
    const cachedRaw = localStorage.getItem(FX_CACHE_KEY);
    if (cachedRaw){
      const cached = JSON.parse(cachedRaw);
      const age = Date.now() - cached.ts;
      if (age < 6*60*60*1000 && cached.rate){
        return { rate: cached.rate, asof: cached.asof || null };
      }
    }
  }catch{}

  // Try multiple free endpoints; keep it simple + robust
  const urls = [
    "https://api.exchangerate.host/latest?base=USD&symbols=EUR",
    "https://open.er-api.com/v6/latest/USD"
  ];

  for (const url of urls){
    try{
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) continue;
      const j = await r.json();
      let rate = null;
      let asof = null;

      if (j?.rates?.EUR) { rate = j.rates.EUR; asof = j.date || null; }
      if (j?.result === "success" && j?.rates?.EUR) { rate = j.rates.EUR; asof = j.time_last_update_utc || null; }
      if (j?.rates?.EUR && !asof) asof = new Date().toISOString();

      rate = safeNum(rate);
      if (rate > 0){
        try{
          localStorage.setItem(FX_CACHE_KEY, JSON.stringify({ ts: Date.now(), rate, asof }));
        }catch{}
        return { rate, asof };
      }
    }catch{}
  }
  return { rate: null, asof: null };
}

function setFxBadge(){
  if (!els.fxBadge) return;
  const fx = safeNum(state.fx?.usdToEur);
  if (fx > 0){
    els.fxBadge.textContent = `FX: 1 USD = ${fx.toFixed(4)} EUR`;
  } else {
    els.fxBadge.textContent = "FX: offline";
  }
}

function setDbBadge(text){
  if (!els.dbBadge) return;
  els.dbBadge.textContent = text;
}

function normalizeExchange(x){
  if (!x) return "UNKNOWN";
  const s = String(x).toUpperCase();
  if (s.includes("KRAKEN")) return "KRAKEN";
  if (s.includes("BLOFIN")) return "BLOFIN";
  return s;
}

function normalizeMarketType(x){
  if (!x) return "UNKNOWN";
  const s = String(x).toUpperCase();
  if (s.includes("FUT")) return "FUTURES";
  if (s.includes("SPOT")) return "SPOT";
  return s;
}

function parseDateMs(dt){
  // dt can be ISO string or Date
  try{
    const t = new Date(dt).getTime();
    return Number.isFinite(t) ? t : null;
  }catch{
    return null;
  }
}

function withinRangeMs(ms, range){
  if (!ms) return false;
  const now = Date.now();
  if (range === "24h") return ms >= now - 24*60*60*1000;
  if (range === "1w") return ms >= now - 7*24*60*60*1000;
  if (range === "1m") return ms >= now - 30*24*60*60*1000;
  if (range === "3m") return ms >= now - 90*24*60*60*1000;
  if (range === "6m") return ms >= now - 180*24*60*60*1000;
  if (range === "1y") return ms >= now - 365*24*60*60*1000;
  return true;
}

function formatMoney(v, label){
  const n = safeNum(v);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  // Dutch formatting
  const formatted = abs.toLocaleString("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}${label === "EUR" ? "€" : "US$"} ${formatted}`;
}

function formatPct(v){
  const n = safeNum(v);
  const formatted = n.toLocaleString("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${formatted}%`;
}

function aggregateKPIs(trades){
  let net=0, fees=0, wins=0, losses=0;
  for (const t of trades){
    const n = safeNum(t.netPnlUsd);
    net += n;
    fees += safeNum(t.feesUsd);
    if (n > 0) wins++;
    else if (n < 0) losses++;
  }
  const count = trades.length;
  const decided = wins + losses;
  const winrate = decided ? (wins/decided)*100 : 0;
  return { count, net, fees, wins, losses, winrate };
}

function buildEquitySeries(tradesAsc){
  // Cumulative netPnL series in USD
  let cum=0;
  const pts=[];
  for (const t of tradesAsc){
    const ms = parseDateMs(t.datetime);
    if (!ms) continue;
    cum += safeNum(t.netPnlUsd);
    pts.push({ x: ms, y: cum });
  }
  return pts;
}

function drawGrid(ctx, W, H){
  const lines = 6;
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  for (let i=0;i<=lines;i++){
    const y = (H/lines)*i;
    ctx.beginPath();
    ctx.moveTo(0,y);
    ctx.lineTo(W,y);
    ctx.stroke();
  }
  const vlines = 6;
  for (let i=0;i<=vlines;i++){
    const x = (W/vlines)*i;
    ctx.beginPath();
    ctx.moveTo(x,0);
    ctx.lineTo(x,H);
    ctx.stroke();
  }
}

function drawLineChart(canvas, points, opts={}){
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0,0,W,H);

  // background (transparent) — grid drawn below
  const pad = 26;
  const innerW = W - pad*2;
  const innerH = H - pad*2;

  // Empty state
  if (!points || points.length < 2){
    // grid + "No data"
    ctx.save();
    ctx.translate(pad,pad);
    drawGrid(ctx, innerW, innerH);
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.font = "14px system-ui, -apple-system, Segoe UI, Roboto, Arial";
    ctx.textAlign = "center";
    ctx.fillText("No data", innerW/2, innerH/2);
    ctx.restore();
    return { xToPx: ()=>0, yToPx: ()=>0, invX: ()=>0 };
  }

  const mode = opts.mode || "pnl"; // "pnl" | "total"
  const yLabel = opts.yLabel || "";
  const xLabel = opts.xLabel || "";
  const lineW = opts.lineWidth ?? 5; // thicker default

  // Compute bounds
  const xs = points.map(p=>p.x);
  const ys = points.map(p=>p.y);
  let xMin = Math.min(...xs), xMax = Math.max(...xs);
  let yMin = Math.min(...ys), yMax = Math.max(...ys);
  if (xMax === xMin) xMax = xMin + 1;
  if (yMax === yMin) { yMax = yMin + 1; yMin = yMin - 1; }

  // Add breathing room
  const yPad = (yMax - yMin) * 0.08;
  yMax += yPad;
  yMin -= yPad;

  const xToPx = (x) => pad + ((x - xMin) / (xMax - xMin)) * innerW;
  const yToPx = (y) => pad + (1 - ((y - yMin) / (yMax - yMin))) * innerH;
  const invX = (px) => xMin + ((px - pad) / innerW) * (xMax - xMin);

  // Draw
  ctx.save();
  ctx.translate(0,0);

  // Grid
  ctx.save();
  ctx.translate(pad,pad);
  drawGrid(ctx, innerW, innerH);
  ctx.restore();

  // Path
  const path = new Path2D();
  path.moveTo(xToPx(points[0].x), yToPx(points[0].y));
  for (let i=1;i<points.length;i++){
    path.lineTo(xToPx(points[i].x), yToPx(points[i].y));
  }

  // Area fill (Kraken-like "voorbeeld"): always filled under the line
  ctx.save();
  const fillPath = new Path2D(path);
  fillPath.lineTo(xToPx(points[points.length-1].x), yToPx(yMin));
  fillPath.lineTo(xToPx(points[0].x), yToPx(yMin));
  fillPath.closePath();

  // Gradient fill (top -> bottom)
  const grad = ctx.createLinearGradient(0, pad, 0, pad + innerH);
  if (mode === "total"){
    grad.addColorStop(0, "rgba(80, 200, 255, 0.22)");
    grad.addColorStop(1, "rgba(80, 200, 255, 0.02)");
  } else {
    grad.addColorStop(0, "rgba(0, 255, 140, 0.20)");
    grad.addColorStop(1, "rgba(0, 255, 140, 0.02)");
  }
  ctx.fillStyle = grad;
  ctx.fill(fillPath);
  ctx.restore();

  // Line (single color)
  ctx.save();
  ctx.lineWidth = lineW;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = (mode === "total") ? "rgba(80, 200, 255, 0.95)" : "rgba(0, 255, 140, 0.95)";
  ctx.stroke(path);
  ctx.restore();

  // Axes labels (minimal)
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  if (yLabel){
    ctx.textAlign = "left";
    ctx.fillText(yLabel, pad, pad-8);
  }
  if (xLabel){
    ctx.textAlign = "right";
    ctx.fillText(xLabel, W-pad, H-8);
  }
  ctx.restore();

  ctx.restore();
  return { xToPx, yToPx, invX, xMin, xMax, yMin, yMax };
}

function setupInteractiveLineChart(){
  if (!els.equityCanvas || !els.equityWrap) return;
  const canvas = els.equityCanvas;
  const wrap = els.equityWrap;

  // one tooltip for both desktop and mobile
  let tip = document.getElementById("chartTip");
  if (!tip){
    tip = document.createElement("div");
    tip.id = "chartTip";
    tip.className = "chartTip";
    tip.innerHTML = `<div class="t1"></div><div class="t2"></div>`;
    wrap.style.position = "relative";
    wrap.appendChild(tip);
  }

  // an overlay canvas for crosshair + dot
  let overlay = document.getElementById("chartOverlay");
  if (!overlay){
    overlay = document.createElement("canvas");
    overlay.id = "chartOverlay";
    overlay.className = "chartOverlay";
    overlay.style.position = "absolute";
    overlay.style.left = "0";
    overlay.style.top = "0";
    overlay.style.pointerEvents = "none";
    wrap.appendChild(overlay);
  }

  function syncOverlaySize(){
    const rect = canvas.getBoundingClientRect();
    overlay.width = canvas.width;
    overlay.height = canvas.height;
    overlay.style.width = rect.width + "px";
    overlay.style.height = rect.height + "px";
  }
  syncOverlaySize();
  window.addEventListener("resize", syncOverlaySize);

  function clearOverlay(){
    const ctx = overlay.getContext("2d");
    ctx.clearRect(0,0,overlay.width, overlay.height);
  }

  function drawCrosshair(px, py, text1, text2){
    const ctx = overlay.getContext("2d");
    ctx.clearRect(0,0,overlay.width, overlay.height);

    // Vertical line
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, overlay.height);
    ctx.stroke();

    // Dot
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.beginPath();
    ctx.arc(px, py, 3.5, 0, Math.PI*2);
    ctx.fill();

    // Tooltip
    tip.style.display = "block";
    tip.querySelector(".t1").textContent = text1;
    tip.querySelector(".t2").textContent = text2 || "";

    // keep inside container
    const rect = wrap.getBoundingClientRect();
    const left = Math.min(Math.max(px + 8, 8), rect.width - 160);
    const top = Math.min(Math.max(py - 30, 8), rect.height - 52);
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }

  let lastPts = [];
  let lastMap = null;

  function setData(pts, map){
    lastPts = pts || [];
    lastMap = map || null;
  }

  function nearestPoint(pts, targetX){
    if (!pts.length) return null;
    let lo = 0, hi = pts.length - 1;
    while (lo < hi){
      const mid = (lo + hi) >> 1;
      if (pts[mid].x < targetX) lo = mid + 1;
      else hi = mid;
    }
    const a = pts[Math.max(0, lo-1)];
    const b = pts[lo];
    if (!a) return b;
    if (!b) return a;
    return (Math.abs(a.x-targetX) <= Math.abs(b.x-targetX)) ? a : b;
  }

  function onMove(clientX, clientY){
    if (!lastMap || !lastPts.length) return;
    const rect = canvas.getBoundingClientRect();
    const px = (clientX - rect.left) * (canvas.width / rect.width);
    const targetX = lastMap.invX(px);
    const p = nearestPoint(lastPts, targetX);
    if (!p) return;

    const xPx = lastMap.xToPx(p.x);
    const yPx = lastMap.yToPx(p.y);

    const d = new Date(p.x);
    const dateTxt = d.toLocaleString("nl-NL", { day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit" });
    const vTxt = formatMoney(p.y, convertedLabel());
    drawCrosshair(xPx, yPx, vTxt, dateTxt);
  }

  function hide(){
    clearOverlay();
    tip.style.display = "none";
  }

  // Pointer events
  canvas.addEventListener("mousemove", (e)=>onMove(e.clientX, e.clientY));
  canvas.addEventListener("mouseleave", hide);
  canvas.addEventListener("touchstart", (e)=>{
    if (!e.touches?.length) return;
    onMove(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive:true });
  canvas.addEventListener("touchmove", (e)=>{
    if (!e.touches?.length) return;
    onMove(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive:true });
  canvas.addEventListener("touchend", hide);

  // expose setter
  setupInteractiveLineChart.setData = setData;
}

async function loadRemoteJson(){
  try{
    const r = await fetch(DATA_URL, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP "+r.status);
    return await r.json();
  }catch(e){
    return null;
  }
}

function normalizeRowsFromJson(j){
  if (!j) return [];
  if (Array.isArray(j.rows)) return j.rows;
  if (Array.isArray(j.closed_trades)) return j.closed_trades;
  return [];
}

function normalizeTradeRow(raw){
  const dt = raw.datetime || raw.dateTime || raw.time || raw.ts;
  const exchange = normalizeExchange(raw.exchange || raw.exch || raw.venue);
  const marketType = normalizeMarketType(raw.marketType || raw.market || raw.type);
  const symbol = raw.symbol || raw.pair || raw.contract || "";
  const side = raw.side || raw.action || raw.orderType || "";

  const realizedPnlUsd = safeNum(raw.realizedPnlUsd ?? raw.realized_pnl_usd ?? raw.realizedPnl ?? raw.realized_pnl);
  const feesUsd = safeNum(raw.feesUsd ?? raw.feeUsd ?? raw.fee ?? raw.fees);
  const fundingUsd = safeNum(raw.fundingUsd ?? raw.realizedFundingUsd ?? raw.realized_funding ?? raw.funding);
  const netPnlUsd = safeNum(raw.netPnlUsd ?? (realizedPnlUsd - feesUsd + fundingUsd));

  const tradeKey = raw.tradeKey || raw.uid || `${exchange}|${symbol}|${dt}|${side}|${netPnlUsd}`;

  return {
    tradeKey,
    datetime: dt,
    exchange,
    marketType,
    symbol,
    side,
    qty: safeNum(raw.qty ?? raw.contract ?? raw.size ?? 0),
    price: safeNum(raw.price ?? raw.tradePrice ?? 0),
    realizedPnlUsd,
    feesUsd,
    fundingUsd,
    netPnlUsd,
    notes: raw.notes || ""
  };
}

async function upsertTrades(trades){
  if (!trades?.length) return 0;
  await db.trades.bulkPut(trades.map(t=>({
    tradeKey: t.tradeKey,
    datetime: t.datetime,
    exchange: t.exchange,
    marketType: t.marketType,
    symbol: t.symbol,
    side: t.side,
    qty: t.qty,
    price: t.price,
    realizedPnlUsd: t.realizedPnlUsd,
    feesUsd: t.feesUsd,
    fundingUsd: t.fundingUsd,
    netPnlUsd: t.netPnlUsd,
    notes: t.notes
  })));
  return trades.length;
}

async function getAllTrades(){
  return await db.trades.toArray();
}

async function getFilteredTrades(){
  const all = await getAllTrades();
  const out = [];
  for (const t of all){
    if (state.exchangeFilter !== "ALL" && t.exchange !== state.exchangeFilter) continue;
    if (state.marketType !== "ALL" && t.marketType !== state.marketType) continue;

    const ms = parseDateMs(t.datetime);
    if (!withinRangeMs(ms, state.range)) continue;

    if (state.search){
      const s = state.search.toLowerCase();
      const hay = `${t.exchange} ${t.marketType} ${t.symbol} ${t.side} ${t.notes}`.toLowerCase();
      if (!hay.includes(s)) continue;
    }
    out.push(t);
  }
  return out;
}

function setKpi(el, valueText, goodBad=null, subText=null){
  if (!el) return;
  el.classList.remove("good","bad");
  if (goodBad==="good") el.classList.add("good");
  if (goodBad==="bad") el.classList.add("bad");
  el.querySelector(".value").textContent = valueText;
  if (subText!==null) el.querySelector(".sub").textContent = subText;
}

async function renderAll(){
  const trades = await getFilteredTrades();
  const k = aggregateKPIs(trades);

  if (els.summaryLine){
    els.summaryLine.textContent = `${k.count} trades • ${state.exchangeFilter}/${state.marketType} • ${state.range}`;
  }

  const netc = convertUsdToSelected(k.net);
  const feec = convertUsdToSelected(k.fees);

  if (els.kpiNet) setKpi(els.kpiNet, formatMoney(netc, convertedLabel()), netc>=0?"good":"bad", "PnL - fees + funding");
  if (els.kpiFees) setKpi(els.kpiFees, formatMoney(feec, convertedLabel()));
  if (els.kpiWinrate) setKpi(els.kpiWinrate, formatPct(k.winrate), null, `${k.wins} wins / ${k.losses} losses`);

  // Equity / charts
  const tradesAsc = [...trades].sort((a,b)=>(a.datetime>b.datetime?1:-1));
  const pnlSeriesUsd = buildEquitySeries(tradesAsc); // cumulative net PnL in USD

  // "Total chart" = (manual base) + cumulative PnL
  const baseUsd = getDepositBaseUsdForFilter(state.exchangeFilter);
  const seriesUsd = (state.chartMode === "total")
    ? pnlSeriesUsd.map(p => ({ x: p.x, y: (baseUsd || 0) + p.y }))
    : pnlSeriesUsd;

  const pts = seriesUsd.map(p => ({ x: p.x, y: convertUsdToSelected(p.y) }));

  const yLabel = (state.chartMode === "total")
    ? `Totale waarde (${convertedLabel()})`
    : `Cumulatief (${convertedLabel()})`;

  drawLineChart(els.equityCanvas, pts, { yLabel, mode: state.chartMode, lineWidth: 5 });

  // Hook crosshair data
  if (typeof setupInteractiveLineChart.setData === "function"){
    // Need mapping from the last draw; redraw to get mapping returned
    const map = drawLineChart(els.equityCanvas, pts, { yLabel, mode: state.chartMode, lineWidth: 5 });
    setupInteractiveLineChart.setData(pts, map);
  }
}

function setTab(tab){
  const pages = [
    ["dashboard", els.pageDashboard, els.tabDashboard],
    ["trades", els.pageTrades, els.tabTrades],
    ["import", els.pageImport, els.tabImport],
    ["calculator", els.pageCalculator, els.tabCalculator],
    ["analyse", els.pageAnalyse, els.tabAnalyse],
  ];
  for (const [name, page, btn] of pages){
    const on = (name === tab);
    if (page) page.style.display = on ? "block" : "none";
    if (btn) btn.classList.toggle("active", on);
  }
}

// Chart toggle buttons (PnL chart / Total chart)
// - Supports new IDs: btnChartPnl, btnChartTotal
// - Falls back to old IDs: btnChartArea ("voorbeeld") and btnChartZero ("nul-lijn")
const btnChartPnl = document.getElementById("btnChartPnl") || document.getElementById("btnChartArea");
const btnChartTotal = document.getElementById("btnChartTotal") || document.getElementById("btnChartZero");

function setChartMode(mode){
  state.chartMode = mode; // "pnl" | "total"
  btnChartPnl?.classList.toggle("active", mode === "pnl");
  btnChartTotal?.classList.toggle("active", mode === "total");
  // Persist
  try{ localStorage.setItem("pnl_chart_mode_v1", mode); }catch{}
}
btnChartPnl?.addEventListener("click", async()=>{ setChartMode("pnl"); await renderAll(); });
btnChartTotal?.addEventListener("click", async()=>{ setChartMode("total"); await renderAll(); });

// Default = PnL chart
try{
  const saved = localStorage.getItem("pnl_chart_mode_v1");
  if (saved === "total" || saved === "pnl") setChartMode(saved);
  else setChartMode("pnl");
}catch{
  setChartMode("pnl");
}

els.importBtn?.addEventListener("click", ()=>{
  // existing import flow in your HTML (file input) remains; this button can stay.
});

els.exportBtn?.addEventListener("click", async()=>{
  const trades = await getFilteredTrades();
  const rows = trades.map(t=>({
    datetime: t.datetime,
    exchange: t.exchange,
    marketType: t.marketType,
    symbol: t.symbol,
    side: t.side,
    netPnlUsd: t.netPnlUsd,
    feesUsd: t.feesUsd,
    fundingUsd: t.fundingUsd,
    notes: t.notes
  }));
  const header = Object.keys(rows[0]||{});
  const csv = [
    header.join(","),
    ...rows.map(r=>header.map(k=>JSON.stringify(r[k]??"")).join(","))
  ].join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pnl_export_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

els.resetBtn?.addEventListener("click", async()=>{
  if (!confirm("Weet je zeker dat je alle lokale data wilt wissen?")) return;
  await db.trades.clear();
  setDbBadge("Reset gedaan");
  await renderAll();
});

els.tabDashboard?.addEventListener("click", ()=>setTab("dashboard"));
els.tabTrades?.addEventListener("click", ()=>setTab("trades"));
els.tabImport?.addEventListener("click", ()=>setTab("import"));
els.tabCalculator?.addEventListener("click", ()=>setTab("calculator"));
els.tabAnalyse?.addEventListener("click", ()=>setTab("analyse"));

els.currency?.addEventListener("change", async(e)=>{
  state.currency = e.target.value;
  await renderAll();
});
els.exchange?.addEventListener("change", async(e)=>{
  state.exchangeFilter = e.target.value;
  await renderAll();
});
els.marketType?.addEventListener("change", async(e)=>{
  state.marketType = e.target.value;
  await renderAll();
});
els.range?.addEventListener("change", async(e)=>{
  state.range = e.target.value;
  await renderAll();
});

async function init(){
  // FX
  const fx = await fetchFxUsdToEur();
  state.fx.usdToEur = fx.rate;
  state.fx.asof = fx.asof;
  setFxBadge();

  // Load remote json and persist to IndexedDB (merge)
  const remote = await loadRemoteJson();
  const rows = normalizeRowsFromJson(remote);
  const normalized = rows.map(normalizeTradeRow);

  if (normalized.length){
    await upsertTrades(normalized);
    setDbBadge(`Sync OK (+${normalized.length}) • totaal ${await db.trades.count()}`);
  } else {
    setDbBadge(`Sync OK (+0) • totaal ${await db.trades.count()}`);
  }

  // Setup chart interactivity
  setupInteractiveLineChart();

  // Default tab
  setTab("dashboard");

  await renderAll();

  // auto refresh
  setInterval(async()=>{
    const fx2 = await fetchFxUsdToEur();
    if (fx2.rate){
      state.fx.usdToEur = fx2.rate;
      state.fx.asof = fx2.asof;
      setFxBadge();
    }
  }, REFRESH_MS);
}

init();