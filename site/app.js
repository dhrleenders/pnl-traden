const app={
tabs:document.getElementById("tabs"),
views:{
dash:document.getElementById("view-dash"),
analyse:document.getElementById("view-analyse"),
trades:document.getElementById("view-trades"),
calc:document.getElementById("view-calc"),
import:document.getElementById("view-import"),
coach:document.getElementById("view-coach"),
}
};

function showView(name){
Object.values(app.views).forEach(v=>v.style.display="none");
if(app.views[name]) app.views[name].style.display="block";
}

app.tabs.addEventListener("click",e=>{
const t=e.target.closest(".tab");
if(t) showView(t.dataset.view);
});

showView("dash");

document.getElementById("btnCoachUpdate").onclick=async()=>{
const s=document.getElementById("coachStatus");
const p=document.getElementById("coachPreview");
try{
s.textContent="Laden...";
await window.CoachFeed.fetchCoachFeed();
const e=await window.CoachFeed.getCoachEvents();
s.textContent=`OK • ${e.length} events`;
p.textContent=JSON.stringify(e,null,2);
}catch(err){
s.textContent="Fout";
p.textContent=String(err);
}
};
