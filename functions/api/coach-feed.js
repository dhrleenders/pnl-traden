export async function onRequestGet({ env }) {
return new Response(JSON.stringify({
ok:true,
events:[
{ts:Date.now(),symbol:"BTC-PERP",pnl:12.4},
{ts:Date.now()-60000,symbol:"ETH-PERP",pnl:-4.1}
]
}),{headers:{"Content-Type":"application/json"}});
};