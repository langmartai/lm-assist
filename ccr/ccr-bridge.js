const fs=require('fs'),crypto=require('crypto');
const BASE='https://api.anthropic.com', LM='http://127.0.0.1:3100';
const ORG=JSON.parse(fs.readFileSync(process.env.HOME+'/.claude.json','utf8')).oauthAccount.organizationUuid;
function tok(){const d=JSON.parse(fs.readFileSync(process.env.HOME+'/.claude/.credentials.json','utf8'));const f=o=>{if(o&&typeof o==='object'){for(const k of Object.keys(o)){if(/^access_?token$/i.test(k)&&typeof o[k]==='string')return o[k];const r=f(o[k]);if(r)return r;}}return null;};return f(d);}
const RC_BETA='claude-code-20250219,oauth-2025-04-20,context-1m-2025-08-07,interleaved-thinking-2025-05-14';
const OAUTH={Authorization:`Bearer ${tok()}`,'anthropic-version':'2023-06-01','anthropic-beta':'ccr-byoc-2025-07-29','x-organization-uuid':ORG,'content-type':'application/json'};
const TMUX=process.argv[2], JSONL=process.argv[3], MODE=process.argv[4]||'twoway';
const LOG='/tmp/ccr-bridge.log'; const log=s=>{try{fs.appendFileSync(LOG,new Date().toISOString().slice(11,19)+' '+s+'\n')}catch{}};
const seenUp=new Set(), seenDown=new Set(), injected=new Set();
const txtOf=m=>typeof m?.content==='string'?m.content:Array.isArray(m?.content)?m.content.map(b=>b.text||'').join(' '):'';
function newMsgs(cse){const out=[];let lines;try{lines=fs.readFileSync(JSONL,'utf8').split('\n').filter(Boolean)}catch{return out;}
  for(const ln of lines){let r;try{r=JSON.parse(ln)}catch{continue}
    if((r.type==='user'||r.type==='assistant')&&r.message){const u=r.uuid||JSON.stringify(r.message).slice(0,60);
      if(seenUp.has(u))continue; seenUp.add(u);
      if(r.type==='user'&&injected.has(txtOf(r.message).trim()))continue;
      out.push({payload:{type:r.type,message:r.message,session_id:cse,uuid:r.uuid||crypto.randomUUID(),parent_tool_use_id:null}});
      if(r.type==='assistant'&&r.message.stop_reason)out.push({payload:{type:'result',subtype:'success',is_error:false,stop_reason:r.message.stop_reason,num_turns:1,duration_ms:0,duration_api_ms:0,total_cost_usd:0,usage:r.message.usage||{},session_id:cse,uuid:crypto.randomUUID()}});
    }}
  return out;}
(async()=>{
  fs.writeFileSync(LOG,'');
  const c=await(await fetch(`${BASE}/v1/code/sessions`,{method:'POST',headers:OAUTH,body:JSON.stringify({title:'two-way-bridge ('+TMUX+')',bridge:{},tags:['remote-control-repl'],config:{cwd:'/tmp',model:'claude-opus-4-8[1m]'}})})).json();
  const cse=c.session.id;
  const b=await(await fetch(`${BASE}/v1/code/sessions/${cse}/bridge`,{method:'POST',headers:OAUTH,body:'{}'})).json();
  const epoch=Number(b.worker_epoch), W={Authorization:`Bearer ${b.worker_jwt}`,'anthropic-version':'2023-06-01','anthropic-beta':RC_BETA,'content-type':'application/json','anthropic-client-platform':'claude_code_cli'};
  const setStatus=s=>fetch(`${BASE}/v1/code/sessions/${cse}/worker`,{method:'PUT',headers:W,body:JSON.stringify({worker_epoch:epoch,worker_status:s})}).then(()=>log('status='+s)).catch(()=>{});
  await setStatus('idle');
  const post=async ev=>{if(!ev.length)return;const types=ev.map(e=>e.payload.type);
    if(types.some(t=>t==='user'||t==='assistant'))await setStatus('running');
    await fetch(`${BASE}/v1/code/sessions/${cse}/worker/events`,{method:'POST',headers:W,body:JSON.stringify({worker_epoch:epoch,events:ev})}).catch(e=>log('posterr '+e.message));
    if(types.includes('result'))await setStatus('idle');};
  await post(newMsgs(cse));
  log('MODE '+MODE+' TMUX '+TMUX); {const _u='https://claude.ai/code/'+cse.replace(/^cse_/,'session_');log('URL '+_u);console.log('URL '+_u);}
  setInterval(async()=>{const nm=newMsgs(cse);if(nm.length){log('UP '+nm.map(e=>e.payload.type).join(','));await post(nm);}},1200);
  setInterval(()=>fetch(`${BASE}/v1/code/sessions/${cse}/worker/heartbeat`,{method:'POST',headers:W,body:JSON.stringify({worker_epoch:epoch})}).catch(()=>{}),15000);
  const res=await fetch(`${BASE}/v1/code/sessions/${cse}/worker/events/stream`,{headers:W}); log('SSE '+res.status);
  const reader=res.body.getReader(),dec=new TextDecoder();let buf='';
  while(true){const {done,value}=await reader.read();if(done){log('SSE CLOSED');break;}buf+=dec.decode(value,{stream:true});let i;
    while((i=buf.indexOf("\n\n"))>=0){const f=buf.slice(0,i);buf=buf.slice(i+2);const m=f.match(/data: (\{[\s\S]*\})/);if(!m)continue;let d;try{d=JSON.parse(m[1])}catch{continue}const p=d.payload||{};
      if(d.event_type==='control_request'){const rid=p.request_id||(p.request&&p.request.request_id);const sub=(p.request&&p.request.subtype)||p.subtype;let resp;
        if(sub==='initialize')resp={subtype:'success',request_id:rid,response:{commands:[],output_style:'normal',available_output_styles:['normal'],models:[],account:{},pid:process.pid}};
        else if(['set_model','set_max_thinking_tokens','interrupt','set_permission_mode'].includes(sub))resp={subtype:'success',request_id:rid};
        else resp={subtype:'error',request_id:rid,error:'unsupported: '+sub};
        await fetch(`${BASE}/v1/code/sessions/${cse}/worker/events`,{method:'POST',headers:W,body:JSON.stringify({worker_epoch:epoch,events:[{payload:{type:'control_response',response:resp,session_id:cse,uuid:crypto.randomUUID()}}]})}).catch(()=>{});log('CTRL '+sub);}
      else if(d.event_type==='user'&&(d.source==='client'||p.client_platform==='web_claude_ai')){const u=p.uuid||d.event_id;if(seenDown.has(u))continue;seenDown.add(u);const text=txtOf(p.message).trim();if(!text)continue;
        if(MODE==='twoway'){injected.add(text);await setStatus('running');log('DOWN inject: '+text.slice(0,50));await fetch(`${LM}/terminal/tmux/${TMUX}/send-keys`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({keys:text,literal:true,enter:true})}).catch(e=>log('injecterr '+e.message));}}
    }}
})().catch(e=>log('ERR '+e.message));
