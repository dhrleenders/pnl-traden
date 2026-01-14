
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
function renderAnalyseCalendar(tradesAll){
  if(!els.calMonth || !els.calGrid) return;

  const months=getMonthOptions(tradesAll);
  if(months.length===0){
    els.calMonth.innerHTML='';
    els.calGrid.innerHTML='';
    if(els.calTotalPnl) els.calTotalPnl.textContent='—';
    if(els.calTotalPct) els.calTotalPct.textContent='—';
    if(els.calWinDays) els.calWinDays.textContent='—';
    if(els.calLoseDays) els.calLoseDays.textContent='—';
    if(els.calBeDays) els.calBeDays.textContent='—';
    return;
  }

  // build select once / keep current selection
  if(!state.calMonth || !months.includes(state.calMonth)) state.calMonth = months[0];
  if(els.calMonth.options.length !== months.length){
    els.calMonth.innerHTML = months.map(ym=>`<option value="${ym}">${ym}</option>`).join('');
  }
  els.calMonth.value = state.calMonth;

  const {y, m}=parseYM(state.calMonth);
  const first = new Date(Date.UTC(y, m-1, 1));
  const nextMonth = new Date(Date.UTC(y, m, 1));
  const daysInMonth = Math.round((nextMonth-first)/(24*3600*1000));

  // aggregate daily pnl in USD (already netPnlUsd)
  const daily = new Map();
  for(const t of tradesAll){
    if(!t.datetime) continue;
    const d=new Date(t.datetime);
    if(isNaN(d)) continue;
    const ym=fmtYM(d);
    if(ym !== state.calMonth) continue;
    const k=dateKeyUTC(d);
    const v = Number(t.netPnlUsd||0);
    daily.set(k, (daily.get(k)||0) + (isFinite(v)?v:0));
  }

  // calendar starts Monday (Mon=0..Sun=6)
  const dow = (first.getUTCDay()+6)%7; // Sun->6, Mon->0
  const cells = [];
  const totalCells = dow + daysInMonth;
  const padAfter = (7 - (totalCells%7))%7;

  for(let i=0;i<dow;i++) cells.push({blank:true});
  for(let day=1; day<=daysInMonth; day++){
    const d=new Date(Date.UTC(y, m-1, day));
    const k=dateKeyUTC(d);
    const pnlUsd = daily.get(k) || 0;
    cells.push({blank:false, day, pnlUsd});
  }
  for(let i=0;i<padAfter;i++) cells.push({blank:true});

  const pnlConv = (usd)=> convertUsdToSelected(usd);
  const eps = 0.0000001;
  let totalPnlUsd=0, win=0, lose=0, be=0;

  const html = cells.map(c=>{
    if(c.blank) return `<div class="calDay blank"></div>`;
    totalPnlUsd += c.pnlUsd;
    if(c.pnlUsd > eps) win++; else if(c.pnlUsd < -eps) lose++; else be++;

    const cls = c.pnlUsd > eps ? 'gain' : (c.pnlUsd < -eps ? 'loss' : 'flat');
    const val = pnlConv(c.pnlUsd);
    const show = Math.abs(val) < 0.005 ? '0.00' : val.toFixed(2);
    return `<div class="calDay ${cls}" data-day="${c.day}">
      <div class="n">${c.day}</div>
      <div class="v">${c.pnlUsd===0?'' : (c.pnlUsd>0?'+':'')}${show}</div>
    </div>`;
  }).join('');

  els.calGrid.innerHTML = html;

  // summary
  const totalPnl = pnlConv(totalPnlUsd);
  if(els.calTotalPnl) els.calTotalPnl.textContent = formatMoney(totalPnl, convertedLabel());

  // pct based on deposits base (per exchange filter), NOT affected by range
  const baseUsd = depositsForExchange(state.exchangeFilter) || 0;
  const pct = baseUsd ? (totalPnlUsd / baseUsd) * 100 : null;
  if(els.calTotalPct) els.calTotalPct.textContent = (pct===null ? '—' : `${pct.toFixed(2)}%`);

  if(els.calWinDays) els.calWinDays.textContent = String(win);
  if(els.calLoseDays) els.calLoseDays.textContent = String(lose);
  if(els.calBeDays) els.calBeDays.textContent = String(be);
}
