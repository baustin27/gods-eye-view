import WebSocket from 'ws';
const page=(await (await fetch('http://127.0.0.1:9333/json/list')).json()).find(t=>t.type==='page');
const ws=new WebSocket(page.webSocketDebuggerUrl);
let id=0;const pend=new Map();const errs=[];
const send=(m,p={},s)=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p,...(s?{sessionId:s}:{})}))});
ws.on('message',m=>{const d=JSON.parse(m);
 if(d.id&&pend.has(d.id)){pend.get(d.id)(d);pend.delete(d.id)}
 if(d.method==='Runtime.consoleAPICalled'&&d.params.type==='error') errs.push(d.params.args.map(a=>a.value??a.description??'').join(' ').replace(/\s+/g,' ').slice(0,200));
 if(d.method==='Runtime.exceptionThrown') errs.push('[throw] '+String(d.params.exceptionDetails.exception?.description||'').replace(/\s+/g,' ').slice(0,220));
});
await new Promise(r=>ws.on('open',r));
await send('Runtime.enable');
const t=await send('Target.getTargets');
const oopif=(t.result?.targetInfos||[]).find(x=>x.url.includes('42003'));
const att=await send('Target.attachToTarget',{targetId:oopif.targetId,flatten:true});
const sid=att.result?.sessionId||att.sessionId;
const ev=async(e)=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true},sid);
  return r.result?.result?.value ?? String(r.result?.exceptionDetails?.exception?.description||'(none)');};
console.log('  voice runner available:', await ev("typeof window.__gevVoiceCommands?.runner"));
for (const layer of ['storm-observed','storm-expected']) {
  const r=await ev(`(async()=>{try{const res=await window.__gevVoiceCommands.runner('set_layer_visibility',{layerId:'${layer}',enabled:true});return JSON.stringify(res).slice(0,200)}catch(e){return 'ERR '+e.message}})()`);
  console.log(`  enable ${layer}:`, r);
  await new Promise(x=>setTimeout(x,4000));
}
console.log('  --- screen ---');
console.log('  error text?  ', await ev("/Error:/.test(document.body.innerText)?'YES':'no'"));
console.log('  enabled ids: ', await ev("(()=>{try{return String(localStorage.getItem('gev:layer-state:v2')||localStorage.getItem('gev:layers:v1')||'(unset)').slice(0,220)}catch(e){return 'err'}})()"));
console.log('  --- console errors ---');
console.log(errs.length? [...new Set(errs)].slice(0,8).map(e=>'   '+e).join('\n') : '  (none)');
ws.close();
