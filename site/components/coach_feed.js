window.CoachFeed=(function(){
let cache=[];
async function fetchCoachFeed(){
const r=await fetch("/api/coach-feed");
if(!r.ok) throw new Error("API error");
const d=await r.json();
cache=d.events||[];
}
function getCoachEvents(){return cache;}
return{fetchCoachFeed,getCoachEvents};
})();