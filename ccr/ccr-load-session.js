// Load an EXISTING Claude Code session transcript into a fresh CCR session so claude.ai/code
// renders the full prior conversation. Read-only. Size-aware batching for large histories.
//   NODE_EXTRA_CA_CERTS=/home/yi/lm-proxy/ca/ca.crt node ccr-load-session.js <transcript.jsonl>
const fs=require('fs'),crypto=require('crypto');
const BASE='https://api.anthropic.com';
const ORG=JSON.parse(fs.readFileSync(process.env.HOME+'/.claude.json','utf8')).oauthAccount.organizationUuid;
function tok(){const d=JSON.parse(fs.readFileSync(process.env.HOME+'/.claude/.credentials.json','utf8'));const f=o=>{if(o&&typeof o==='object'){for(const k of Object.keys(o)){if(/^access_?token$/i.test(k)&&typeof o[k]==='string')return o[k];const r=f(o[k]);if(r)return r;}}return null;};return f(d);}
const OAUTH={Authorization:`Bearer ${tok()}`,'anthropic-version':'2023-06-01','anthropic-beta':'ccr-byoc-2025-07-29','x-organization-uuid':ORG,'content-type':'application/json'};
const RC_BETA='claude-code-20250219,oauth-2025-04-20,context-1m-2025-08-07,interleaved-thinking-2025-05-14';
const BUDGET=60000; // bytes per /worker/events POST
(async()=>{
  const JSONL=process.argv[2];
  const title='loaded: '+(process.argv[3]||JSONL.split('/').pop().slice(0,8));
  const c=await(await fetch(`${BASE}/v1/code/sessions`,{method:'POST',headers:OAUTH,body:JSON.stringify({title,bridge:{},tags:['remote-control-repl'],config:{cwd:'/tmp',model:'claude-opus-4-8[1m]'}})})).json();
  const cse=c.session.id;
  const b=await(await fetch(`${BASE}/v1/code/sessions/${cse}/bridge`,{method:'POST',headers:OAUTH,body:'{}'})).json();
  const epoch=Number(b.worker_epoch), W={Authorization:`Bearer ${b.worker_jwt}`,'anthropic-version':'2023-06-01','anthropic-beta':RC_BETA,'content-type':'application/json'};
  const setStatus=s=>fetch(`${BASE}/v1/code/sessions/${cse}/worker`,{method:'PUT',headers:W,body:JSON.stringify({worker_epoch:epoch,worker_status:s})}).catch(()=>{});
  await setStatus('running');
  const lines=fs.readFileSync(JSONL,'utf8').split('\n').filter(Boolean);
  const ev=[];
  for(const ln of lines){let r;try{r=JSON.parse(ln)}catch{continue}
    if((r.type==='user'||r.type==='assistant')&&r.message&&!r.isSidechain)
      ev.push({payload:{type:r.type,message:r.message,session_id:cse,uuid:r.uuid||crypto.randomUUID(),parent_tool_use_id:null}});}
  console.log('history messages:',ev.length);
  // size-aware batching
  const batches=[]; let cur=[],sz=0;
  for(const e of ev){const eb=JSON.stringify(e).length;
    if(eb>BUDGET){if(cur.length){batches.push(cur);cur=[];sz=0;} batches.push([e]); continue;}
    if(sz+eb>BUDGET&&cur.length){batches.push(cur);cur=[];sz=0;}
    cur.push(e);sz+=eb;}
  if(cur.length)batches.push(cur);
  console.log('batches:',batches.length);
  let ok=0,fail=0;
  for(let i=0;i<batches.length;i++){
    const r=await fetch(`${BASE}/v1/code/sessions/${cse}/worker/events`,{method:'POST',headers:W,body:JSON.stringify({worker_epoch:epoch,events:batches[i]})});
    if(r.status===200)ok+=batches[i].length; else {fail+=batches[i].length; if(fail<=20)console.log('batch',i,'->',r.status,(await r.text()).slice(0,100));}
    if(i%50===0)process.stdout.write(`  ..${i}/${batches.length} (ok ${ok})\n`);
  }
  await setStatus('idle');
  console.log('posted ok:',ok,'failed:',fail);
  console.log('URL https://claude.ai/code/'+cse.replace(/^cse_/,'session_'));
})().catch(e=>console.log('ERR',e.message));
