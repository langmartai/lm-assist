const fs=require('fs'),crypto=require('crypto');
const BASE='https://api.anthropic.com';
const ORG=JSON.parse(fs.readFileSync(process.env.HOME+'/.claude.json','utf8')).oauthAccount.organizationUuid;
function tok(){const d=JSON.parse(fs.readFileSync(process.env.HOME+'/.claude/.credentials.json','utf8'));const f=o=>{if(o&&typeof o==='object'){for(const k of Object.keys(o)){if(/^access_?token$/i.test(k)&&typeof o[k]==='string')return o[k];const r=f(o[k]);if(r)return r;}}return null;};return f(d);}
const OAUTH={Authorization:`Bearer ${tok()}`,'anthropic-version':'2023-06-01','anthropic-beta':'ccr-byoc-2025-07-29','x-organization-uuid':ORG,'content-type':'application/json'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const c=await(await fetch(`${BASE}/v1/code/sessions`,{method:'POST',headers:OAUTH,body:JSON.stringify({title:"one-way-mirror",bridge:{},tags:["remote-control-repl"],config:{cwd:"/tmp",model:"claude-opus-4-8[1m]"}})})).json();
  const cse=c.session.id; console.log("session",cse);
  const b=await(await fetch(`${BASE}/v1/code/sessions/${cse}/bridge`,{method:"POST",headers:OAUTH,body:"{}"})).json();
  const epoch=Number(b.worker_epoch);
  const W={Authorization:`Bearer ${b.worker_jwt}`,"anthropic-version":"2023-06-01","content-type":"application/json","anthropic-client-platform":"claude_code_cli"};
  const ac=new AbortController();
  fetch(`${BASE}/v1/code/sessions/${cse}/worker/events/stream`,{headers:W,signal:ac.signal}).then(r=>console.log("stream",r.status)).catch(()=>{});
  await sleep(1200);
  // try PUT /worker register with enum variants
  for(const sv of ["WORKER_STATUS_RUNNING","running"]){
    const r=await fetch(`${BASE}/v1/code/sessions/${cse}/worker`,{method:"PUT",headers:W,body:JSON.stringify({worker_epoch:epoch,worker_status:sv})});
    console.log("PUT /worker",sv,"->",r.status, r.status>=400?(await r.text()).slice(0,150):"");
    if(r.status===200) break;
  }
  const lines=fs.readFileSync(process.argv[2],"utf8").split("\n").filter(Boolean);
  const events=[];for(const ln of lines){let r;try{r=JSON.parse(ln)}catch{continue}if((r.type==="user"||r.type==="assistant")&&r.message)events.push({payload:{type:r.type,message:r.message,session_id:cse,uuid:r.uuid||crypto.randomUUID(),parent_tool_use_id:null}});}
  const pr=await fetch(`${BASE}/v1/code/sessions/${cse}/worker/events`,{method:"POST",headers:W,body:JSON.stringify({worker_epoch:epoch,events})});
  console.log("POST",events.length,"events ->",pr.status);
  await sleep(2500);
  console.log("== read endpoint probe ==");
  for(const ep of ["teleport-events","events","messages","transcript","worker/events"]){
    try{const r=await fetch(`${BASE}/v1/code/sessions/${cse}/${ep}`,{headers:OAUTH});const txt=await r.text();let n="";try{const j=JSON.parse(txt);n="keys="+Object.keys(j)+" len="+((j.data||j.events||j.messages||[]).length)}catch{n="(non-json "+txt.length+"b)"}console.log(`GET ${ep} -> ${r.status} ${n}`);}catch(e){console.log(`GET ${ep} ERR`,e.message);}
  }
  ac.abort();
  console.log("URL https://claude.ai/code/"+cse.replace(/^cse_/,"session_"));
  console.log("CLEANUP_ID",cse);
})().catch(e=>{console.error("ERR",e.message);process.exit(1)});
