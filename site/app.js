
async function fetchUsdEurRate(){
 const r=await fetch("https://api.frankfurter.app/latest?from=USD&to=EUR");
 const j=await r.json();
 return j.rates.EUR;
}
async function ensureFx(){
 try{
  const rate=await fetchUsdEurRate();
  document.getElementById("fxBadge").textContent="FX: "+rate.toFixed(4);
 }catch{
  document.getElementById("fxBadge").textContent="FX: offline";
 }
}
function initCollapsibleTopbar(){
 const tb=document.getElementById("topbar");
 const btn=document.getElementById("collapseBtn");
 btn.onclick=()=>tb.classList.toggle("collapsed");
}
ensureFx();initCollapsibleTopbar();
