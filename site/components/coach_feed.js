/**
 * components/coach_feed.js
 * Fetch Kraken Futures fills via Cloudflare Pages Function (/api/coach-feed)
 * and store/retrieve them for Coach tab.
 *
 * Attaches to window.CoachFeed.
 */
(function(){
  function safeJson(res){ return res.json().catch(()=>null); }

  async function fetchCoachFeed(opts){
    const lastFillTime = opts && opts.lastFillTime ? String(opts.lastFillTime) : "";
    const url = lastFillTime ? `/api/coach-feed?lastFillTime=${encodeURIComponent(lastFillTime)}` : `/api/coach-feed`;
    const res = await fetch(url, { method: "GET", headers: { "Accept": "application/json" }});
    const data = await safeJson(res);
    if(!res.ok){
      const msg = (data && (data.error || data.message)) ? (data.error || data.message) : `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data || { events: [] };
  }

  window.CoachFeed = {
    fetchCoachFeed
  };
})();