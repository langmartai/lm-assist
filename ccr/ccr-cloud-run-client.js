// Standalone CCR client — drives Claude Code Remote purely over HTTP from JS.
const fs=require('fs'); const {execSync}=require('child_process'); const crypto=require('crypto');
const BASE='https://api.anthropic.com';
const ORG=JSON.parse(fs.readFileSync(process.env.HOME+'/.claude.json','utf8')).oauthAccount.organizationUuid;
function tok(){const d=JSON.parse(fs.readFileSync(process.env.HOME+'/.claude/.credentials.json','utf8'));
  const f=o=>{if(o&&typeof o==='object'){for(const k of Object.keys(o)){if(/^access_?token$/i.test(k)&&typeof o[k]==='string')return o[k];const r=f(o[k]);if(r)return r;}}return null;};return f(d);}
const TOK=tok();
const H={'Authorization':`Bearer ${TOK}`,'anthropic-version':'2023-06-01','anthropic-beta':'ccr-byoc-2025-07-29','x-organization-uuid':ORG};
const j=r=>r.json();
async function main(){
  // 1) scratch repo -> git bundle
  const dir='/tmp/ccr-js-repo';
  execSync(`rm -rf ${dir}&&mkdir -p ${dir}&&cd ${dir}&&git init -q&&git config user.email j@j.co&&git config user.name j&&echo hi>README.md&&git add -A&&git commit -qm init&&git bundle create /tmp/ccr-js.bundle --all`);
  const bundle=fs.readFileSync('/tmp/ccr-js.bundle');
  // 2) upload bundle -> file_id
  const fd=new FormData();
  fd.append('file',new Blob([bundle],{type:"application/octet-stream"}),'_source_seed.bundle');
  fd.append('purpose','user_data');
  const fj=await fetch(`${BASE}/v1/files`,{method:'POST',headers:{...H,'anthropic-beta':'files-api-2025-04-14,oauth-2025-04-20'},body:fd}).then(j);
  console.log('1) bundle uploaded:',fj.id,fj.size_bytes+'b');
  // 3) environment
  const ej=await fetch(`${BASE}/v1/environment_providers`,{headers:H}).then(j);
  const env=ej.environments[0].environment_id; console.log('2) env:',env);
  // 4) create session with initial user turn
  const body={title:'JS-direct CCR',events:[{type:'event',data:{uuid:crypto.randomUUID(),session_id:'',type:'user',parent_tool_use_id:null,message:{role:'user',content:'Reply with exactly this token and nothing else: JSDIRECT-OK'}}}],session_context:{sources:[],seed_bundle_file_id:fj.id,outcomes:[],model:'claude-opus-4-8[1m]'},environment_id:env};
  const sj=await fetch(`${BASE}/v1/sessions`,{method:'POST',headers:{...H,'content-type':'application/json'},body:JSON.stringify(body)}).then(j);
  const sid=sj.id; console.log('3) session created:',sid,sj.session_status);
  // helper: read transcript assistant texts
  const readAsst=async()=>{const t=await fetch(`${BASE}/v1/code/sessions/${sid}/teleport-events`,{headers:H}).then(j);
    return (t.data||[]).filter(e=>e.event_type==='assistant').map(e=>{const c=e.payload?.message?.content;return Array.isArray(c)?c.map(b=>b.text||'').join(''):String(c);});};
  // 5) poll for initial cloud reply
  const wait=async(mark)=>{for(let i=0;i<12;i++){await new Promise(r=>setTimeout(r,6000));const a=await readAsst();
    console.log(`   poll ${i}: assistant turns=${a.length}`,a.length?`last=${JSON.stringify(a[a.length-1]).slice(0,50)}`:'');
    if(a.some(t=>t.includes(mark)))return a;}return null;};
  console.log('4) waiting for cloud initial turn...');
  let a=await wait('JSDIRECT-OK'); if(!a){console.log('   no initial reply');return;}
  console.log('   -> initial cloud reply OK');
  // 6) drive a follow-up turn purely via POST events
  const ev={uuid:crypto.randomUUID(),session_id:sid,type:'user',parent_tool_use_id:null,message:{role:'user',content:'Now reply with exactly: JSDIRECT-FOLLOWUP'}};
  const r2=await fetch(`${BASE}/v1/sessions/${sid}/events`,{method:'POST',headers:{...H,'content-type':'application/json'},body:JSON.stringify({events:[ev]})});
  console.log('5) follow-up POST events ->',r2.status);
  console.log('6) waiting for cloud follow-up turn...');
  a=await wait('JSDIRECT-FOLLOWUP');
  console.log(a?('   >>> FULL JS-DIRECT CCR LIFECYCLE CONFIRMED (create+drive+read), session '+sid):'   follow-up not seen');
}
main().catch(e=>{console.error('ERR',e);process.exit(1);});
