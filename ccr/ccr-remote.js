// ccr-remote.js — gated mode manager for Claude Code remote support.
// Turns (mode, sessionId) into the correct, SAFE action using cc-session-detect's verdict.
//   node ccr-remote.js load    <sessionId|jsonl>
//   node ccr-remote.js mirror  <sessionId>
//   node ccr-remote.js connect <sessionId> [--go]     (default: dry-run, prints the gated plan)
//   node ccr-remote.js plan-test '<verdictJSON>'      (validate the gate branches deterministically)
// connect ENFORCES the no-double-writer rule: it only ever creates a new tmux `claude --resume`
// when the verdict says storage is unowned; if a live non-tmux process owns it, it REFUSES.
const cp=require('child_process'),path=require('path');
const DIR=__dirname, DETECT=path.join(DIR,'cc-session-detect.js');
const CA=process.env.NODE_EXTRA_CA_CERTS?`NODE_EXTRA_CA_CERTS=${process.env.NODE_EXTRA_CA_CERTS} `:'';

function verdict(sid){return JSON.parse(cp.execSync(`node ${DETECT} ${sid}`,{encoding:'utf8'}));}
function short(sid){return sid.slice(0,8);}

// Pure: verdict -> {action, safe, cmds:[], note}. No side effects.
function planConnect(v){
  if(v.connectStrategy==='attach-existing')
    return {action:'attach-existing', safe:true, cmds:[
      `${CA}node ${path.join(DIR,'ccr-bridge.js')} ${v.tmuxSession} ${v.jsonl} twoway`],
      note:`attach existing tmux '${v.tmuxSession}' pane ${v.pane} (pid ${v.owner.pid}); downstream via /terminal/tmux/${v.tmuxSession}/send-keys. NO new tmux created.`};
  if(v.connectStrategy==='create-tmux'){
    const t=`ccr-${short(v.sessionId)}`;
    return {action:'create-tmux', safe:true, cmds:[
      `tmux new-session -d -s ${t} 'claude --resume ${v.sessionId}'`,
      `${CA}node ${path.join(DIR,'ccr-bridge.js')} ${t} ${v.jsonl} twoway`],
      note:`storage unowned -> create tmux '${t}' running 'claude --resume' as the SOLE writer, then bridge two-way. (Use --fork-session for guaranteed-safe new id.)`};
  }
  if(v.connectStrategy==='refuse')
    return {action:'refuse', safe:false, cmds:[],
      note:`REFUSED: ${v.reason} -> fall back to: node ccr-remote.js mirror ${v.sessionId}`};
  return {action:'none', safe:false, cmds:[], note:v.reason};
}

const [,,mode,arg,...rest]=process.argv;
const go=rest.includes('--go');
function run(cmds){for(const c of cmds){console.log('$ '+c);console.log(cp.execSync(c,{encoding:'utf8',stdio:'pipe'}));}}

if(mode==='plan-test'){console.log(JSON.stringify(planConnect(JSON.parse(arg)),null,2));process.exit(0);}
if(!mode||!arg){console.error('usage: ccr-remote.js <load|mirror|connect> <sessionId|jsonl> [--go]');process.exit(1);}

if(mode==='connect'){
  const v=verdict(arg); const p=planConnect(v);
  console.log(JSON.stringify({sessionId:arg,strategy:v.connectStrategy,safeToCreateTmux:v.safeToCreateTmux,plan:p},null,2));
  if(!p.safe){process.exit(p.action==='refuse'?2:3);}
  if(go){run(p.cmds);}else{console.log('\n[dry-run] add --go to execute the above.');}
}else if(mode==='load'){
  const jsonl=arg.endsWith('.jsonl')?arg:(verdict(arg).jsonl);
  if(!jsonl){console.error('no transcript for '+arg);process.exit(1);}
  const cmd=`${CA}node ${path.join(DIR,'ccr-load-session.js')} ${jsonl} loaded-${short(arg)}`;
  console.log('plan:',cmd); if(go)run([cmd]); else console.log('[dry-run] add --go');
}else if(mode==='mirror'){
  const v=verdict(arg); if(!v.jsonl){console.error('no transcript for '+arg);process.exit(1);}
  const cmd=`${CA}node ${path.join(DIR,'ccr-oneway-mirror.js')} ${v.jsonl}`;
  console.log('plan:',cmd,'\nnote: one-way live mirror (no downstream).'); if(go)run([cmd]); else console.log('[dry-run] add --go');
}else{console.error('unknown mode '+mode);process.exit(1);}
