// Claude Code session ownership detection — the SAFETY-CRITICAL primitive for remote support.
//
// Decides, for a local Claude Code session, whether its transcript storage is currently
// OWNED by a live process, and if so whether that process is attachable via tmux. This gates
// whether it is safe to spin a NEW `claude --resume <sid>` tmux (two writers on one append-only
// .jsonl => corruption — Claude Code does NOT lock the file and has no double-resume guard).
//
// Sources combined:
//   (A) ~/.claude/sessions/<pid>.json  — Claude's own concurrent-session registry (authoritative
//       liveness: sessionId, pid, cwd, kind, entrypoint, status). Stale pid files are ignored.
//   (B) tmux panes — climb the owner pid's ppid chain; if a tmux pane_pid is an ancestor, the
//       session is running INSIDE that pane (attachable). Otherwise it's a non-tmux process.
//   (C) ~/.claude/projects/*/<sid>.jsonl — the transcript file (for load/mirror).
//
// Verdict.connectStrategy:  'attach-existing' | 'create-tmux' | 'refuse' | 'none'
//   attach-existing : live & in tmux  -> two-way by attaching that pane (NEVER create a new tmux)
//   create-tmux     : not live        -> safe to create a fresh tmux `claude --resume` (sole writer)
//   refuse          : live & NOT tmux -> creating a tmux resume would double-write -> corruption
//   none            : no transcript, nothing to do
const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');
const SESS_DIR=path.join(os.homedir(),'.claude','sessions');
const PROJ_DIR=path.join(os.homedir(),'.claude','projects');

function alive(pid){try{process.kill(pid,0);return true}catch(e){return e.code==='EPERM'}}
function ppidOf(pid){try{const s=fs.readFileSync(`/proc/${pid}/stat`,'utf8');const rp=s.lastIndexOf(')');return parseInt(s.slice(rp+2).split(' ')[1],10)||0}catch{return 0}}
function procStartOf(pid){try{const s=fs.readFileSync(`/proc/${pid}/stat`,'utf8');return s.slice(s.lastIndexOf(')')+2).split(' ')[19]||null}catch{return null}} // field 22 = starttime
function ancestors(pid){const a=[];let p=pid,g=0;while(p>1&&g++<40){p=ppidOf(p);if(p>0)a.push(p)}return a}
function liveRegistry(){const out={};let files=[];try{files=fs.readdirSync(SESS_DIR)}catch{}
  for(const f of files){if(!f.endsWith('.json'))continue;let r;try{r=JSON.parse(fs.readFileSync(path.join(SESS_DIR,f),'utf8'))}catch{continue}
    if(!r.sessionId||!r.pid||!alive(r.pid))continue;
    if(r.procStart){const ps=procStartOf(r.pid);if(ps&&String(ps)!==String(r.procStart))continue} // pid-reuse guard
    out[r.sessionId]={pid:r.pid,cwd:r.cwd,kind:r.kind,entrypoint:r.entrypoint,status:r.status,updatedAt:r.updatedAt,version:r.version}}
  return out}
function tmuxPanes(){try{const o=cp.execSync("tmux list-panes -a -F '#{session_name}|#{window_index}.#{pane_index}|#{pane_pid}|#{pane_current_command}' 2>/dev/null",{encoding:'utf8'});
  return o.split('\n').filter(Boolean).map(l=>{const[session,pane,pid,cmd]=l.split('|');return{session,pane,pid:+pid,cmd}})}catch{return[]}}
function paneForPid(pid,panes){const anc=new Set([pid,...ancestors(pid)]);return panes.find(p=>anc.has(p.pid))||null}
function jsonlFor(sid){try{for(const d of fs.readdirSync(PROJ_DIR)){const fp=path.join(PROJ_DIR,d,sid+'.jsonl');if(fs.existsSync(fp))return fp}}catch{}return null}

function verdict(sid){
  const reg=liveRegistry(), panes=tmuxPanes(), o=reg[sid], jsonl=jsonlFor(sid);
  if(!o) return {sessionId:sid,jsonl,live:false,owner:null,inTmux:false,tmuxSession:null,
    allowedModes: jsonl?['load','connect']:['none'], connectStrategy: jsonl?'create-tmux':'none',
    safeToCreateTmux: !!jsonl,
    reason: jsonl?'storage unowned by any live process — safe to create a tmux `claude --resume` as sole writer':'no live process and no transcript on this host'};
  const pane=paneForPid(o.pid,panes);
  if(pane) return {sessionId:sid,jsonl,live:true,owner:o,inTmux:true,tmuxSession:pane.session,pane:pane.pane,
    allowedModes:['load','mirror','connect'], connectStrategy:'attach-existing', safeToCreateTmux:false,
    reason:`live in tmux '${pane.session}' pane ${pane.pane} (pid ${o.pid}) — attach this pane for two-way; do NOT create a new tmux`};
  return {sessionId:sid,jsonl,live:true,owner:o,inTmux:false,tmuxSession:null,
    allowedModes:['load','mirror'], connectStrategy:'refuse', safeToCreateTmux:false,
    reason:`live but NOT in tmux (pid ${o.pid}, entrypoint=${o.entrypoint}, kind=${o.kind}). A new \`claude --resume\` would double-write ${jsonl} -> corruption. Use 'mirror' (one-way) instead.`};
}

const arg=process.argv[2];
if(arg){console.log(JSON.stringify(verdict(arg),null,2))}
else{const reg=liveRegistry();const list=Object.keys(reg).map(verdict);
  console.log(JSON.stringify({host:os.hostname(),liveCount:list.length,liveSessions:list},null,2))}
