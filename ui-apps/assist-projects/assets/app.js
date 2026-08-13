/* assist-projects — the lm-assist "projects" page WITH the process dashboard folded in,
 * as one scoped pane. Plain JS, no build, no deps. Every data call goes through the injected
 * SDK helper (lmui.call), which carries the view token and re-mints it on 401/403. Single-node
 * form: the source pages fanned out per machine, this pane only ever shows THIS node.
 *
 * Declared grants (lmui.config.json) — the hard ceiling; anything else 403s:
 *   node:/projects              [GET]   list projects (+ ?force=true to bypass the cache)
 *   node:/ttyd/processes        [GET]   the process snapshot (+ ?hash= delta, ?forceCheck=true)
 *   node:/ttyd/process          [POST]  /identify and /<pid>/kill — and nothing else
 *   node:/sessions/batch-check  [GET]   session enrichment (the GET twin of the POST route)
 *   node:/health                [GET]   hostname / platform / version for the header
 * `/ttyd/session` is deliberately NOT granted: that prefix would also carry /start, /stop and
 * /input — i.e. spawning terminals and TYPING into them. Killing a session is reproduced by
 * killing its PIDs through /ttyd/process/<pid>/kill, which is the same effect, narrower reach.
 *
 * Paths + envelope shapes mirror core/src/routes/core/session-projects.routes.ts,
 * ttyd.routes.ts and sessions.routes.ts, each verified against the live dev API:
 *   GET  /projects                → data = { projects:[...], total }   (WRAPPER, not a bare array)
 *        a project row is { path, encodedPath, sessionCount, lastActivity, storageSize,
 *        hasClaudeMd, isGitProject, git, lastUserMessage, totalCost } — there is NO projectName
 *        and NO machine/managedBy/taskCounts field; the web app synthesised those client-side.
 *   GET  /ttyd/processes          → { success, hash, data:{ managed, allClaudeProcesses, summary,
 *        processStatus, systemStats } }.  🔴 `hash` is a SIBLING of `data`, not inside it — and
 *        GET ?hash=<h> returns { success, unchanged:true, hash } with NO `data` key at all. The
 *        web client read `hash` off the unwrapped data, so its delta poll never armed and every
 *        tick refetched; api() below hands the whole envelope back so this pane can do it right.
 *   POST /ttyd/process/identify   → data = { processes:[ {pid, sessionId, role, screenTurn,
 *        sessionStats, ...} ] }   (max 20 pids per call — chunked here)
 *   POST /ttyd/process/<pid>/kill → data = { message, pid, alreadyDead }; on failure the envelope
 *        carries a BARE STRING `error`, which is why api() keeps the string-error clause.
 *   GET  /sessions/batch-check?sessions=[{sessionId}]        → data = { sessions:{ id:{fileSize,
 *        agentIds, lastModified, ...} } }                     — cheap, always on
 *   GET  /sessions/batch-check?listCheck.projectPath=<p>     → data = { listStatus:{ totalSessions,
 *        latestModified, changed, sessions?:[ {numTurns, userPromptCount, taskCount, teamName,
 *        lastUserMessage, ...} ] } }                          — RICH but returns EVERY session in
 *        the project (832 KB for lm-assist here), so it is opt-in and conditional.
 *   GET  /tasks/all               → data = { tasks:[ {id, subject, status, sessionId, projectPath,
 *        projectName, ...} ], total }   — every task on the node in ONE call (measured: 470 tasks,
 *        288 KB, 0.48 s). This is what rebuilds the per-project task-count row; see taskKey() for
 *        why the join is on the MANGLED path and not on `path`.
 *        🔴 The per-project twin, GET /projects/<key>/tasks, is the "obvious" route and is
 *        UNUSABLE from a UI: it calls getProjectSessions(), which parses every session file in the
 *        project. Measured against `-home-ubuntu-lm-assist` on :3200 it had still not answered
 *        after 120 s, for ONE project — 85 of them is not a page load. /tasks/all costs one
 *        directory walk and covers every project at once. */
(function () {
  'use strict';

  // Process categories (core/src/types + ttyd process-status-store). Order = display order.
  var CATEGORY_ORDER = ['ttyd', 'ttyd-tmux', 'ttyd-shell', 'unmanaged-tmux', 'wrapper', 'unmanaged-terminal', 'unknown'];
  var CATEGORY_LABEL = {
    'ttyd': 'Managed (ttyd)',
    'ttyd-tmux': 'Managed (ttyd+tmux)',
    'ttyd-shell': 'Shell terminal',
    'wrapper': 'External',
    'unmanaged-terminal': 'External terminal',
    'unmanaged-tmux': 'External tmux',
    'unknown': 'Unknown',
  };
  var MANAGED_CATS = { 'ttyd': 1, 'ttyd-tmux': 1 };
  var UNMANAGED_CATS = { 'unmanaged-terminal': 1, 'unmanaged-tmux': 1 };
  // A sessionId Core could not resolve; the source page treated these as "no session".
  function realSid(s) { return s && s !== 'unknown' && s !== 'chrome-session' ? s : null; }

  // ── embedding + theme contract (identical to sibling panes) ───────────────
  var EMBEDDED = /[?&]embed=1\b/.test(location.search);
  if (EMBEDDED) document.body.classList.add('embed');
  var THEME = /[?&]theme=light/.test(location.search) ? 'light' : 'dark';
  if (THEME === 'light') document.body.classList.add('theme-light');

  // A cross-origin frame cannot size itself: report height, the shell resizes the iframe.
  function reportHeight() {
    if (!EMBEDDED || !window.parent || window.parent === window) return;
    var h = Math.ceil(document.body.scrollHeight + 8);
    try { window.parent.postMessage({ type: 'lmui:height', uiId: (window.__UI_ID__ || ''), height: h }, '*'); } catch (e) {}
  }
  if (EMBEDDED) {
    window.addEventListener('load', reportHeight);
    if (window.ResizeObserver) new ResizeObserver(reportHeight).observe(document.body);
    setInterval(reportHeight, 1500);
  }

  // ── the one control this pane cannot honour ───────────────────────────────
  // There is no `assist-console` pane. Every "open a terminal" affordance the source pages had
  // (project → + New session, process → Open/Connect) pointed at it, and lmui.goto would happily
  // emit /go/assist-console — which the serving tier answers with a pane chooser / 404. A button
  // that 404s is worse than an absent one, so these render VISIBLY DISABLED and the reason is
  // printed next to them, not hidden in a title attribute.
  var CONSOLE_WHY = 'Opening a terminal is disabled: there is no assist-console pane. '
    + 'Attaching to a live console is a WebSocket stream, and the pane data plane carries request/response only.';

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ── data plane ────────────────────────────────────────────────────────────
  // lmui.call returns the raw fetch Response. The hub relay wraps the node's own
  // {success,data,meta} envelope in an outer {status,data}; the local tier passes the node
  // envelope through directly. Strip the outer layer when present so this pane runs unchanged
  // under BOTH tiers, then normalize to {ok,status,data,error}. A failure (grant denial,
  // non-JSON, {success:false,error}) surfaces its real text — nothing is swallowed.
  // `env` is the node envelope itself: /ttyd/processes hangs `hash` and `unchanged` off it as
  // SIBLINGS of `data`, so a caller that only ever sees `data` cannot do a conditional fetch.
  function api(service, path, opts) {
    return lmui.call(service, path, opts).then(function (r) {
      return r.text().then(function (txt) {
        var b = null;
        try { b = txt ? JSON.parse(txt) : null; } catch (e) { b = null; }
        var relayed = b && b.data !== undefined && b.status !== undefined;
        var env = relayed ? b.data : b;
        var status = relayed ? b.status : r.status;
        if (env && env.success === true) return { ok: true, status: status, data: env.data, env: env };
        var msg = (env && env.error && env.error.message) || (env && typeof env.error === 'string' ? env.error : '')
          || (env && env.message) || (txt ? txt.slice(0, 600) : ('HTTP ' + status));
        var code = (env && env.error && env.error.code) || ('HTTP_' + status);
        return { ok: false, status: status, error: { code: code, message: msg } };
      });
    }).catch(function (e) {
      return { ok: false, status: 0, error: { code: 'NETWORK', message: String(e && e.message || e) } };
    });
  }

  // ── formatters ────────────────────────────────────────────────────────────
  // Accepts epoch ms OR an ISO string. A FUTURE timestamp prints the date, never "just now" —
  // clock skew between a session file and this browser is normal and must not read as fresh.
  function ago(v) {
    if (v == null || v === '') return '—';
    var t = typeof v === 'number' ? v : new Date(v).getTime();
    var m = Math.floor((Date.now() - t) / 60000);
    if (!isFinite(m)) return '—';
    if (m < 0) return new Date(t).toISOString().slice(0, 16).replace('T', ' ');
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    if (m < 1440) return Math.floor(m / 60) + 'h ago';
    return Math.floor(m / 1440) + 'd ago';
  }
  function uptime(iso) {
    if (!iso) return '—';
    var d = Date.now() - new Date(iso).getTime();
    if (!isFinite(d) || d < 0) return '—';
    var mins = Math.floor(d / 60000);
    if (mins < 60) return mins + 'm';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h' + (mins % 60) + 'm';
    return Math.floor(hrs / 24) + 'd' + (hrs % 24) + 'h';
  }
  function fmtBytes(n) {
    var b = Number(n);
    if (!isFinite(b) || b < 0) return '—';
    if (b < 1024) return b + 'B';
    if (b < 1048576) return (b / 1024).toFixed(0) + 'K';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + 'M';
    return (b / 1073741824).toFixed(2) + 'G';
  }
  function fmtKb(kb) {
    var n = Number(kb);
    if (!isFinite(n) || n <= 0) return '—';
    var mb = n / 1024;
    if (mb < 1) return Math.round(n) + 'K';
    if (mb < 1024) return mb.toFixed(0) + 'M';
    return (mb / 1024).toFixed(1) + 'G';
  }
  function fmtCpu(p) { var n = Number(p); return isFinite(n) ? n.toFixed(1) + '%' : '—'; }
  // A server-supplied count is both RENDERED and COMPARED, so it gets coerced to a finite number
  // before either: a non-numeric value can then neither carry markup into innerHTML nor defeat a
  // strict `=== 1` pluralisation (the string '1' would otherwise print "1 sessions"). Core computes
  // sessionCount as a number today — this is the guard for the day some other producer does not.
  function safeCount(n) { var v = Number(n); return isFinite(v) ? v : 0; }
  function fmtCost(c) { var n = Number(c); return isFinite(n) && n > 0 ? '$' + n.toFixed(n < 10 ? 2 : 0) : ''; }
  function projName(p) {
    if (!p) return '—';
    var parts = String(p).replace(/[\/\\]$/, '').split(/[\/\\]/);
    return parts[parts.length - 1] || String(p);
  }
  function shortSid(s) { return realSid(s) ? String(s).slice(0, 8) : '—'; }

  // ── the /projects ⇄ /tasks/all join key ───────────────────────────────────
  // GET /tasks/all stamps every task with a projectPath that Core derives from the SESSION
  // STORAGE DIRECTORY NAME by a naive dash→slash substitution (tasks-service.ts findSessionById:
  // `'/' + dir.replace(/^-/,'').replace(/-/g,'/')`). So a hyphenated project comes back MANGLED:
  // `-home-ubuntu-lm-assist` → `/home/ubuntu/lm/assist`. Joining that against a project's real
  // `path` silently misses every project whose name contains a dash — which is most of them here
  // (measured on this node: 239 tasks filed under `/home/ubuntu/lm/unified/trade` and 85 under
  // `/home/ubuntu/lm/assist`, i.e. 324 of 329 attributable tasks would have vanished).
  // 🔴 So do NOT try to un-mangle it. Apply the SAME transform to the project's `encodedPath` —
  // which IS that directory name — and both sides become the same function of the same string,
  // making the join exact by construction rather than by string luck. Measured: 2/2 hyphenated
  // keys joined, 0 collisions across all 85 project rows.
  function taskKey(encodedPath) {
    return '/' + String(encodedPath == null ? '' : encodedPath).replace(/^-/, '').replace(/-/g, '/');
  }

  // `managedBy` is a REAL field of GET /projects — projects-service.ts sets it to
  // 'lm-assist:knowledge-pipeline' when a project's path IS the lm-assist data dir, and leaves it
  // undefined otherwise, so JSON.stringify drops the key on every other row. It is read straight
  // off the wire here, never synthesised. Label rule copied from the source page.
  function managedLabel(m) { return m === 'lm-assist:knowledge-pipeline' ? 'Knowledge Pipeline' : 'Managed'; }
  function ptsNum(tty) { var m = /pts\/(\d+)/.exec(tty || ''); return m ? 'pts/' + m[1] : '—'; }
  function level(pct) { return pct > 80 ? 'red' : pct > 50 ? 'amber' : 'green'; }

  // A git remote URL is CONFIG, not something we control: only rebuild a link when the host and
  // path match a strict charset, and drop any embedded user:password (https remotes can carry a
  // PAT). Anything else renders as inert text — never as an href.
  // The fallback below prints the URL it could not parse, so it must not print a secret. The
  // parsed branches drop userinfo by construction; an UNPARSEABLE remote does not — and the
  // commonest reason https parsing fails is exactly the dangerous one: a PAT containing '/',
  // which breaks the `(?:[^@/\s]+@)?` userinfo group. So redact on the raw string instead of
  // relying on the authority ending at the first '/'. Anchor on the LAST '@' that is followed by
  // a host-shaped token AND a '/', which is the real userinfo/host boundary even when the
  // credential itself contains slashes or '@'. Requiring the trailing '/' is what stops a benign
  // path-side '@' (https://host/o/repo@v1.git) from being mistaken for credentials.
  function redactCreds(u) {
    return String(u == null ? '' : u)
      .replace(/^([A-Za-z][A-Za-z0-9+.\-]*:\/\/)(.*)@([A-Za-z0-9.\-]+(?::\d+)?\/)/, '$1***@$3');
  }
  function remoteInfo(url) {
    var raw = String(url || '');
    var ssh = /^[^@\s/]+@([A-Za-z0-9.\-]+):([^\s]+?)(?:\.git)?\/?$/.exec(raw);
    if (ssh && /^[A-Za-z0-9._\-/]+$/.test(ssh[2])) return { display: ssh[2], web: 'https://' + ssh[1] + '/' + ssh[2] };
    var http = /^(https?):\/\/(?:[^@/\s]+@)?([A-Za-z0-9.\-]+(?::\d+)?)\/([^\s]+?)(?:\.git)?\/?$/.exec(raw);
    if (http && /^[A-Za-z0-9._\-/]+$/.test(http[3])) return { display: http[3], web: http[1] + '://' + http[2] + '/' + http[3] };
    return { display: redactCreds(raw), web: null };
  }
  function primaryRemote(git) {
    var rs = (git && git.remotes) || [];
    var i;
    for (i = 0; i < rs.length; i++) if (rs[i].name === 'origin' && rs[i].type === 'fetch') return rs[i];
    for (i = 0; i < rs.length; i++) if (rs[i].type === 'fetch') return rs[i];
    return rs[0] || null;
  }

  // ── state ───────────────────────────────────────────────────────────────
  var state = {
    tab: 'projects',                     // 'projects' | 'processes'
    health: null,                        // GET /health data (hostname / platform / version)

    projects: [],                        // project rows from GET /projects (data.projects)
    projLoaded: false,                   // guards the boot race: both loads run concurrently
    selected: null,                      // the selected row (the list carries the full record)
    pf: { q: '', git: 'git' },           // 'git' = git repos only (the source page's default)
    sort: 'activity',

    tasks: {},                           // taskKey(...) -> {pending,inProgress,completed,other,total}
    tasksLoaded: false,
    tasksError: null,                    // {code,message} when GET /tasks/all failed or was denied
    tasksUnattributed: 0,                // tasks whose list id is not a session id → no project at all
    tasksTotal: 0,

    navTab: null, navProject: null,      // {text,warn} notes about how this pane was ENTERED
    landedProject: false,

    managed: [],                         // data.managed[] — live ttyd instances
    all: [],                             // data.allClaudeProcesses[]
    stats: null,                         // data.systemStats
    pstatus: null,                       // data.processStatus
    procLoaded: false,
    procInFlight: 0,                     // >0 while a /ttyd/processes call is outstanding
    hash: null,                          // last /ttyd/processes hash — the conditional poll key
    unchanged: 0,                        // how many polls the delta answered for free
    identify: {},                        // pid -> IdentifiedProcess (POST /ttyd/process/identify)
    enrich: {},                          // sessionId -> cheap batch-check record
    rich: {},                            // sessionId -> rich listStatus row (opt-in)
    listKnown: {},                       // projectPath -> {count, latest} for the conditional list
    richOn: false,
    procQ: '',
    auto: true,
    arm: null, armTimer: null,           // two-step kill confirmation (see armKill)
    killing: {},                         // pid -> true while its kill is in flight
  };

  // ── inbound deep links: the PINNED cross-pane vocabulary ──────────────────
  // The entity's singular noun, unqualified. This pane displays PROJECTS (Projects tab) and, via
  // the process snapshot, the SESSIONS running on this node (Processes tab), so it reads exactly:
  //   project  a project path (a bare project NAME is also accepted — see landProject)
  //   session  a session id
  //   tab      'projects' | 'processes'
  //   q        a search prefill
  // Anything else in the query string is ignored. A param this pane cannot honour is REPORTED in
  // the note strip rather than dropped — an inbound link that lands nowhere is the same defect as
  // an outbound button that 404s, just seen from the other end.
  function param(name) {
    // `name` is always one of the four literals above, so it needs no regex escaping — but keep
    // the match anchored on a real separator so `?project=x` and `?tab=y&project=x` both work and
    // `?myproject=x` does not.
    var m = new RegExp('[?&]' + name + '=([^&]*)').exec(location.search);
    if (!m) return '';
    try { return decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch (e) { return m[1]; }
  }
  var IN = { project: param('project'), session: param('session'), tab: param('tab'), q: param('q') };

  // Derived on every paint, never latched: identify can reveal a sessionId the raw snapshot did
  // not carry, so a "nothing is running it" verdict has to be able to change back.
  function sessionIsRunning(want) {
    var all = enriched();
    for (var i = 0; i < all.length; i++) {
      var id = state.identify[all[i].pid];
      var sid = realSid(all[i].sessionId) || (id && id.sessionId) || null;
      if (sid === want) return true;
    }
    return false;
  }
  function sessionNote() {
    if (!IN.session) return null;
    if (!state.procLoaded) return { text: 'Opened by link — looking for a process running session ' + IN.session + '…' };
    if (sessionIsRunning(IN.session)) return { text: 'Opened by link — the process list is filtered to session ' + IN.session + '.' };
    return { text: 'Opened by link with session=' + IN.session + ' — no process on this node is running it. '
      + 'The filter is set anyway; clear it to see every process.', warn: true };
  }
  function paintNav() {
    var el = $('nav-note');
    if (!el) return;
    var items = [];
    if (state.navTab) items.push(state.navTab);
    if (state.navProject) items.push(state.navProject);
    var s = sessionNote();
    if (s) items.push(s);
    if (!items.length) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.className = 'navnote' + (items.some(function (i) { return i.warn; }) ? ' warn' : '');
    el.textContent = items.map(function (i) { return i.text; }).join('   ');
    reportHeight();
  }

  function say(msg, isErr) {
    var out = $('out');
    if (!out) return;
    out.textContent = typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2);
    out.classList.toggle('err', !!isErr);
    reportHeight();
  }

  // A hard failure of the active tab's primary data call: cover the screen with the server's text.
  function fatal(message) {
    var old = $('fatal-layer');
    if (old) old.remove();
    var d = document.createElement('div');
    d.className = 'fatal';
    d.id = 'fatal-layer';
    d.innerHTML = '<div class="fatal-card"><div class="fatal-h">Could not be loaded</div>'
      + '<pre class="fatal-msg"></pre><button class="primary" id="fatal-retry">Retry</button></div>';
    d.querySelector('.fatal-msg').textContent = message;   // textContent — server text is NOT trusted HTML
    document.body.appendChild(d);
    $('fatal-retry').onclick = function () { d.remove(); reloadActive(); };
    reportHeight();
  }
  // Mandatory on a tabbed pane: without it a fatal raised by tab A stays pinned over tab B.
  function clearFatal() { var o = $('fatal-layer'); if (o) o.remove(); }

  function reloadActive() {
    if (state.tab === 'projects') loadProjects();
    else loadProcesses({ force: true });
  }

  // ── tabs ────────────────────────────────────────────────────────────────
  function switchTab(t) {
    if (t === state.tab) return;
    state.tab = t;
    disarm();
    clearFatal();
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.classList.toggle('on', b.dataset.tab === t);
    });
    $('view-projects').hidden = t !== 'projects';
    $('view-processes').hidden = t !== 'processes';
    say('ready');
    if (t === 'projects') { paintProjects(); paintProjectDetail(); }
    else {
      // Boot loads the snapshot for the projects tab's live-session counts, so procLoaded is
      // usually already true and painting here is what keeps the view off "loading…". But it must
      // be CONDITIONAL: clicking Processes while that boot call is still in flight would otherwise
      // paint an empty snapshot as "No Claude processes running" — a false negative — and then
      // fire a SECOND concurrent /ttyd/processes behind the first. With no data yet, leave the
      // markup's "loading…" alone and let the outstanding call do the painting when it lands.
      if (state.procLoaded) paintProcesses();
      else if (!state.procInFlight) loadProcesses({ force: true });
      loadIdentify();
      loadEnrichment();
    }
    reportHeight();
  }

  // ═══ PROJECTS TAB ═════════════════════════════════════════════════════════
  var GIT_CHIPS = [['git', 'git repos'], ['', 'all']];

  function paintChips() {
    $('chips-git').innerHTML = GIT_CHIPS.map(function (c) {
      return '<span class="fchip' + (state.pf.git === c[0] ? ' on' : '') + '" data-fg="' + esc(c[0]) + '">' + esc(c[1]) + '</span>';
    }).join('');
  }

  // Running sessions per project, derived from the process snapshot — Core's /projects rows
  // have no such field, and the web client hard-defaulted it to 0.
  function runningByProject() {
    var m = {};
    for (var i = 0; i < state.all.length; i++) {
      var p = state.all[i];
      var sid = realSid(p.sessionId);
      if (!sid || !p.projectPath) continue;
      if (!m[p.projectPath]) m[p.projectPath] = {};
      m[p.projectPath][sid] = 1;
    }
    var out = {};
    for (var k in m) if (Object.prototype.hasOwnProperty.call(m, k)) out[k] = Object.keys(m[k]).length;
    return out;
  }

  function passProject(p) {
    // The source page hid non-git directories ("Only git root projects are shown") but KEPT the
    // lm-assist-managed ones — they live under the data dir and are deliberately not git repos,
    // so a plain isGitProject test is exactly what would hide the rows the badge exists for
    // (`projects.filter(p => p.isGitProject !== false || p.managedBy)`).
    if (state.pf.git === 'git' && p.isGitProject === false && !p.managedBy) return false;
    var q = state.pf.q.trim().toLowerCase();
    if (!q) return true;
    var g = p.git || {};
    var rem = primaryRemote(g);
    var hay = (projName(p.path) + ' ' + (p.path || '') + ' ' + (g.branch || '') + ' ' + (rem ? rem.url : '')
      + ' ' + (p.managedBy || '')).toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  function sortProjects(rows) {
    var s = state.sort;
    return rows.slice().sort(function (a, b) {
      // safeCount here too: a non-numeric sessionCount would make this comparator return NaN,
      // which is not a crash but IS an inconsistent ordering.
      if (s === 'sessions') return safeCount(b.sessionCount) - safeCount(a.sessionCount);
      if (s === 'cost') return (b.totalCost || 0) - (a.totalCost || 0);
      if (s === 'size') return (b.storageSize || 0) - (a.storageSize || 0);
      if (s === 'name') return projName(a.path).localeCompare(projName(b.path));
      return new Date(b.lastActivity || 0).getTime() - new Date(a.lastActivity || 0).getTime();
    });
  }

  function gitPills(git) {
    if (!git || !git.initialized) return '<span class="pill">no git</span>';
    var out = '';
    if (git.branch) out += '<span class="pill br">⑂ ' + esc(git.branch) + '</span>';
    else if (git.headCommit) out += '<span class="pill det">#' + esc(git.headCommit) + ' detached</span>';
    if (git.branch && git.headCommit) out += '<span class="pill sha">#' + esc(git.headCommit) + '</span>';
    if (git.isWorktree) out += '<span class="pill wt">worktree</span>';
    else if ((git.worktrees || []).length > 1) out += '<span class="pill wt">' + (git.worktrees.length) + ' trees</span>';
    if (git.isBare) out += '<span class="pill">bare</span>';
    return out;
  }

  // The per-project task counts, restored from the source card. Only the POSITIVE case renders on
  // the row: on 85 rows a repeated "loading…"/"unavailable" is noise, so the not-loaded and failed
  // states are stated ONCE in the counts line (taskSummary) and per-project in the detail panel.
  // What must never happen is a row that is silently blank because the fetch died — hence both.
  function taskLineHtml(p) {
    if (!state.tasksLoaded || state.tasksError) return '';
    var t = state.tasks[taskKey(p.encodedPath)];
    if (!t || !t.total) return '';
    return '<div class="tasks">Tasks: ' + esc(t.pending) + ' pending · ' + esc(t.inProgress) + ' active · '
      + esc(t.completed) + ' done' + (t.other ? ' · ' + esc(t.other) + ' other' : '') + '</div>';
  }

  function taskSummary() {
    if (state.tasksError) return 'task counts unavailable — ' + state.tasksError.code + ': ' + state.tasksError.message;
    if (!state.tasksLoaded) return 'task counts loading…';
    if (!state.tasksTotal) return 'no tasks recorded on this node';
    // Three populations, all named: attributable to a project ON THIS LIST, attributable to a
    // storage key with no project row (a project Core no longer lists), and not attributable at
    // all (the task list id is not a session id, so there is no session and no project to join).
    var mine = 0, projs = 0, foreign = 0, k;
    var known = {};
    for (var i = 0; i < state.projects.length; i++) known[taskKey(state.projects[i].encodedPath)] = 1;
    for (k in state.tasks) {
      if (!Object.prototype.hasOwnProperty.call(state.tasks, k)) continue;
      if (known[k]) { mine += state.tasks[k].total; projs++; } else { foreign += state.tasks[k].total; }
    }
    return mine + ' task' + (mine === 1 ? '' : 's') + ' in ' + projs + ' project' + (projs === 1 ? '' : 's')
      + (foreign ? ' · ' + foreign + ' in projects not listed here' : '')
      + (state.tasksUnattributed ? ' · ' + state.tasksUnattributed + ' not attributable to any project' : '');
  }

  function projectRowHtml(p, running) {
    var sel = state.selected && state.selected.path === p.path ? ' sel' : '';
    var run = running[p.path] || 0;
    var cost = fmtCost(p.totalCost);
    var meta = gitPills(p.git);
    // esc() + safeCount(): sessionCount is server data landing in innerHTML like every other field
    // on this row, and it drives the plural too — neither may trust the wire type.
    var sessions = safeCount(p.sessionCount);
    var sub = '<span class="k">' + esc(sessions) + '</span> session' + (sessions === 1 ? '' : 's')
      + (run ? ' <span class="run">(' + run + ' live)</span>' : '')
      + (cost ? ' · ' + esc(cost) : '')
      + (p.storageSize ? ' · ' + esc(fmtBytes(p.storageSize)) : '')
      + ' · ' + esc(ago(p.lastActivity));
    var mg = p.managedBy
      ? '<span class="tag mg" title="Managed by lm-assist — ' + esc(p.managedBy) + '">' + esc(managedLabel(p.managedBy)) + '</span>'
      : '';
    return '<div class="row' + sel + '" data-path="' + esc(p.path) + '">'
      + '<div class="rt">' + esc(projName(p.path)) + (p.hasClaudeMd ? '<span class="tag">CLAUDE.md</span>' : '') + mg + '</div>'
      + '<div class="rmeta">' + meta + '</div>'
      + '<div class="rsub">' + sub + '</div>'
      + taskLineHtml(p)
      + '<div class="rid">' + esc(p.path) + '</div></div>';
  }

  function paintProjects() {
    var running = runningByProject();
    var vis = sortProjects(state.projects.filter(passProject));
    var el = $('list');
    // .list is a scroller (max-height + overflow:auto) and this repaints on the process poll now,
    // not just on user input — restore the scroll position or a live-count refresh yanks the list
    // back to the top under whoever is reading it.
    var keepScroll = el.scrollTop;
    el.innerHTML = vis.length
      ? vis.map(function (p) { return projectRowHtml(p, running); }).join('')
      : '<div class="empty-list">' + (state.projects.length ? 'No projects match the current filter.' : 'No projects found.') + '</div>';
    if (keepScroll) el.scrollTop = keepScroll;
    var managedN = 0;
    for (var i = 0; i < vis.length; i++) if (vis[i].managedBy) managedN++;
    $('counts').textContent = 'showing ' + vis.length + ' of ' + state.projects.length
      + ' project' + (state.projects.length === 1 ? '' : 's')
      + (state.pf.git === 'git' ? ' · non-git directories hidden (lm-assist-managed ones kept)' : '')
      + (managedN ? ' · ' + managedN + ' lm-assist-managed' : '')
      + ' · ' + taskSummary();
    paintNav();
    reportHeight();
  }

  function loadProjects(force) {
    $('list').innerHTML = 'loading…';
    return api('node', '/projects' + (force ? '?force=true' : '')).then(function (r) {
      if (!r.ok) { fatal(r.error.code + ': ' + r.error.message); return; }
      // data is the WRAPPER { projects, total } — never a bare array.
      state.projects = (r.data && Array.isArray(r.data.projects)) ? r.data.projects : [];
      state.projLoaded = true;
      // Keep the selection alive across a refresh (rows are re-created objects).
      if (state.selected) {
        var keep = null;
        for (var i = 0; i < state.projects.length; i++) if (state.projects[i].path === state.selected.path) keep = state.projects[i];
        state.selected = keep;
      }
      clearFatal();
      paintChips();
      paintProjects();
      paintProjectDetail();
      landProject();                                  // once; guarded by state.landedProject
      if (force) say('reloaded ' + state.projects.length + ' projects (cache bypassed)');
    });
  }

  // Land an inbound ?project= on a real row. assist-sessions emits the absolute path
  // (`{ project: d.projectPath }`), which is the pinned form, but a bare project NAME is accepted
  // too so a caller that has only the basename still lands rather than dead-ending.
  function landProject() {
    if (!IN.project || state.landedProject || !state.projLoaded) return;
    state.landedProject = true;
    var want = IN.project, base = projName(want), hit = null, i;
    for (i = 0; i < state.projects.length; i++) if (state.projects[i].path === want) { hit = state.projects[i]; break; }
    if (!hit) for (i = 0; i < state.projects.length; i++) if (projName(state.projects[i].path) === base) { hit = state.projects[i]; break; }
    if (!hit) {
      state.navProject = { text: 'Opened by link with project=' + want + ' — no project with that path or name is on this node. '
        + 'Showing the full list.', warn: true };
      paintNav();
      return;
    }
    // A deep link has to actually LAND. The default "git repos only" chip is a DISPLAY default,
    // not the caller's intent, so relax it rather than select a row the user cannot see. A `q`
    // the caller explicitly sent is their intent, so that one is kept — and said out loud.
    if (state.pf.git === 'git' && !passProject(hit)) { state.pf.git = ''; paintChips(); }
    var hidden = !passProject(hit);
    state.selected = hit;
    state.navProject = { text: 'Opened by link — showing ' + hit.path + '.'
      + (hidden ? ' (the q=' + state.pf.q + ' filter hides its row; the detail is shown anyway)' : ''), warn: hidden };
    paintProjects();
    paintProjectDetail();
    var row = $('list').querySelector('.row.sel');
    if (row && row.scrollIntoView) { try { row.scrollIntoView({ block: 'nearest' }); } catch (e) { row.scrollIntoView(); } }
  }

  // Per-project task counts for EVERY project in one call. Fails soft and LOUDLY: the row keeps
  // its other fields, and both the counts line and the detail say why the numbers are missing.
  function loadTasks() {
    return api('node', '/tasks/all').then(function (r) {
      if (!r.ok) {
        state.tasksError = r.error;
        state.tasksLoaded = false;
        if (state.tab === 'projects' && state.projLoaded) { paintProjects(); paintProjectDetail(); }
        return;
      }
      var list = (r.data && Array.isArray(r.data.tasks)) ? r.data.tasks : [];
      var map = {}, unattributed = 0;
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        // No projectPath = the task list id is not a session id, so Core could not resolve a
        // session and therefore no project. 141 of 470 here — real, and counted, not dropped.
        if (!t.projectPath) { unattributed++; continue; }
        var k = String(t.projectPath);
        var b = map[k] || (map[k] = { pending: 0, inProgress: 0, completed: 0, other: 0, total: 0 });
        var s = String(t.status == null ? '' : t.status).toLowerCase().replace(/[-_\s]/g, '');
        if (s === 'pending') b.pending++;
        else if (s === 'inprogress') b.inProgress++;
        else if (s === 'completed') b.completed++;
        else b.other++;                                // an unknown status still counts in total
        b.total++;
      }
      state.tasks = map;
      state.tasksUnattributed = unattributed;
      state.tasksTotal = list.length;
      state.tasksError = null;
      state.tasksLoaded = true;
      // 🔴 Guarded on projLoaded for the same reason loadProcesses is: /tasks/all is the FASTER
      // call (0.5 s vs 1.9 s), so it routinely lands first, and painting then would replace the
      // list's "loading…" with "No projects found." before /projects has even answered.
      if (state.tab === 'projects' && state.projLoaded) { paintProjects(); paintProjectDetail(); }
    });
  }

  function openProject(path) {
    var found = null;
    for (var i = 0; i < state.projects.length; i++) if (state.projects[i].path === path) found = state.projects[i];
    state.selected = found;
    paintProjectDetail();
    paintProjects();                                  // re-highlight the selected row
  }

  function metaRow(label, value) {
    return value ? '<div><span class="k">' + esc(label) + ':</span> ' + esc(value) + '</div>' : '';
  }

  function worktreesHtml(git) {
    var ws = (git && git.worktrees) || [];
    if (ws.length < 2 && !git.isWorktree) return '';
    var rows = ws.map(function (w) {
      return '<div class="wtrow' + (w.isCurrent ? ' cur' : '') + '">'
        + '<span class="pill ' + (w.branch ? 'br' : 'det') + '">' + esc(w.branch || ('#' + (w.head || '?'))) + '</span>'
        + '<span class="wtp">' + esc(w.path) + '</span>'
        + (w.isCurrent ? '<span class="pill cur">current</span>' : '') + '</div>';
    }).join('');
    return '<div class="d-sect"><h3>Worktrees (' + ws.length + ')</h3>' + rows
      + (git.mainWorktreePath ? '<div class="hint">main worktree: ' + esc(git.mainWorktreePath) + '</div>' : '')
      + '</div>';
  }

  function remotesHtml(git) {
    var rs = (git && git.remotes) || [];
    if (!rs.length) return '';
    var rows = rs.map(function (rm) {
      var info = remoteInfo(rm.url);
      var link = info.web
        ? '<a href="' + esc(info.web) + '" target="_blank" rel="noopener noreferrer">' + esc(info.display) + ' ↗</a>'
        : '<span class="wtp">' + esc(info.display) + '</span>';
      return '<div class="wtrow"><span class="pill sha">' + esc(rm.name) + '/' + esc(rm.type) + '</span>' + link + '</div>';
    }).join('');
    return '<div class="d-sect"><h3>Remotes (' + rs.length + ')</h3>' + rows + '</div>';
  }

  function paintProjectDetail() {
    var p = state.selected;
    var el = $('detail');
    if (!p) {
      el.className = 'detail empty';
      el.textContent = 'Select a project on the left to see its git state, worktrees, remotes, storage and last prompt.';
      reportHeight();
      return;
    }
    el.className = 'detail';
    var git = p.git || {};
    var running = runningByProject()[p.path] || 0;
    var msgNone = !p.lastUserMessage;
    el.innerHTML =
      '<h2 class="d-title">' + esc(projName(p.path)) + '</h2>'
      + '<div class="d-idrow"><span class="d-id">' + esc(p.path) + '</span></div>'
      + '<div class="d-pills">' + gitPills(p.git)
      + (p.hasClaudeMd ? '<span class="pill ok">CLAUDE.md</span>' : '')
      + (p.managedBy ? '<span class="pill mg">' + esc(managedLabel(p.managedBy)) + '</span>' : '')
      + (running ? '<span class="pill run">' + running + ' live session' + (running === 1 ? '' : 's') + '</span>' : '')
      + '</div>'
      + '<div class="d-meta">'
      + metaRow('sessions', String(safeCount(p.sessionCount)))
      + metaRow('last activity', p.lastActivity ? ago(p.lastActivity) + ' (' + String(p.lastActivity).slice(0, 16).replace('T', ' ') + ')' : '')
      + metaRow('total cost', fmtCost(p.totalCost))
      + metaRow('storage', p.storageSize ? fmtBytes(p.storageSize) : '')
      + metaRow('encoded', p.encodedPath)
      + metaRow('git', git.initialized ? 'initialized' : (p.isGitProject === false ? 'not a git project' : 'unknown'))
      + metaRow('managed by', p.managedBy)
      + '</div>'
      + '<div class="actions">'
      + '<button class="primary" id="d-sessions">Sessions →</button>'
      + '<button class="ghost" id="d-new" disabled title="' + esc(CONSOLE_WHY) + '">+ New session</button>'
      + '</div>'
      + '<div class="hint">Sessions → opens the assist-sessions pane through the shell — this pane never builds another pane\'s URL.</div>'
      + '<div class="why">+ New session: ' + esc(CONSOLE_WHY) + '</div>'
      + taskSectionHtml(p)
      // The last prompt is arbitrary user text — PLAIN TEXT pre-wrap, no md library.
      + '<div class="d-sect"><h3>Last user prompt</h3><pre class="mono' + (msgNone ? ' none' : '') + '">'
      + esc(msgNone ? '(no prompt recorded)' : p.lastUserMessage) + '</pre></div>'
      + worktreesHtml(git)
      + remotesHtml(git);
    // PINNED vocabulary: `project` is a project PATH. The old call emitted the basename, which
    // assist-sessions only resolves because it deliberately accepts both forms.
    $('d-sessions').onclick = function () { lmui.goto('assist-sessions', { project: p.path }); };
    paintNav();
    reportHeight();
  }

  // The detail-side task state — this one DOES spell out all four cases, because it is one panel
  // for one project rather than a line repeated down a list.
  function taskSectionHtml(p) {
    var body, hint;
    if (state.tasksError) {
      body = 'unavailable — ' + state.tasksError.code + ': ' + state.tasksError.message;
      hint = 'The counts come from GET /tasks/all. Nothing is being hidden: that call failed, so this pane does not know.';
    } else if (!state.tasksLoaded) {
      body = 'loading…';
      hint = 'Counted from GET /tasks/all.';
    } else {
      var t = state.tasks[taskKey(p.encodedPath)];
      body = (t && t.total)
        ? t.total + ' task' + (t.total === 1 ? '' : 's') + ' — ' + t.pending + ' pending · '
          + t.inProgress + ' active · ' + t.completed + ' done' + (t.other ? ' · ' + t.other + ' other' : '')
        : 'no tasks recorded for this project';
      hint = 'Counted from GET /tasks/all, joined on the session-storage key ' + taskKey(p.encodedPath) + '.';
    }
    return '<div class="d-sect"><h3>Tasks</h3><div class="d-meta">' + esc(body) + '</div>'
      + '<div class="hint">' + esc(hint) + '</div></div>';
  }

  // ═══ PROCESSES TAB ════════════════════════════════════════════════════════

  // Apply the source page's two corrections to the raw snapshot:
  //  1. a process whose sessionId has a live ttyd instance is really "managed (ttyd)";
  //  2. a managed ttyd instance with no matching process still deserves a row.
  function enriched() {
    var managedIds = {}, i, m;
    for (i = 0; i < state.managed.length; i++) if (state.managed[i].sessionId) managedIds[state.managed[i].sessionId] = 1;
    var matchedIds = {}, matchedPorts = {};
    var out = state.all.map(function (p) {
      if (p.sessionId && managedIds[p.sessionId]) {
        matchedIds[p.sessionId] = 1;
        if (p.managedBy !== 'wrapper') {
          var c = {}; for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k)) c[k] = p[k];
          c.managedBy = 'ttyd';
          return c;
        }
      }
      if (p.externalTtydPort && (p.managedBy === 'ttyd-tmux' || p.managedBy === 'ttyd')) matchedPorts[p.externalTtydPort] = 1;
      return p;
    });
    for (i = 0; i < state.managed.length; i++) {
      m = state.managed[i];
      if (m.sessionId && !matchedIds[m.sessionId] && !matchedPorts[m.port]) {
        out.push({ pid: m.pid, sessionId: m.sessionId, projectPath: m.projectPath, managedBy: 'ttyd',
          source: 'console-tab', startedAt: m.startedAt, externalTtydPort: m.port });
      }
    }
    return out;
  }

  // Several PIDs usually share one sessionId (bash launcher + the real claude runtime).
  // Keep the biggest RSS per managedBy:sessionId — that is the runtime, not the launcher.
  function deduped(list) {
    var best = {}, none = [], i;
    for (i = 0; i < list.length; i++) {
      var p = list[i], sid = realSid(p.sessionId);
      if (!sid) { none.push(p); continue; }
      var key = (p.managedBy || 'unknown') + ':' + sid;
      if (!best[key] || (p.memoryRssKb || 0) > (best[key].memoryRssKb || 0)) best[key] = p;
    }
    var out = [];
    for (var k in best) if (Object.prototype.hasOwnProperty.call(best, k)) out.push(best[k]);
    return out.concat(none);
  }

  function passProc(p) {
    var q = state.procQ.trim().toLowerCase();
    if (!q) return true;
    var id = state.identify[p.pid] || {};
    var hay = (p.pid + ' ' + (p.sessionId || '') + ' ' + (p.projectPath || '') + ' ' + (p.tmuxSessionName || id.tmuxSessionName || '')
      + ' ' + (p.managedBy || '') + ' ' + (p.cmdline || '')).toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  // Group by session the way the source page did: identify's sessionId is the fallback when the
  // raw process record has none, and helper processes (MCP servers, daemons) are dropped.
  function grouped(list) {
    var map = {}, order = [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i], id = state.identify[p.pid];
      if (id && id.managedBy === 'unknown' && !id.tmuxSessionName) continue;
      var key = realSid(p.sessionId) || (id && id.sessionId) || 'unidentified';
      if (!map[key]) { map[key] = []; order.push(key); }
      map[key].push(p);
    }
    return order.map(function (k) { return { key: k, procs: map[k] }; }).sort(function (a, b) {
      var ai = a.key !== 'unidentified', bi = b.key !== 'unidentified';
      if (ai !== bi) return ai ? -1 : 1;
      return b.procs.length - a.procs.length;
    });
  }

  // Once identify has spoken for ANY pid in a group, the un-identified siblings are child/helper
  // processes — the source page hid them. One definition, used by the rows, the count and the kill.
  function visibleProcs(procs) {
    var anyId = procs.some(function (p) { return !!state.identify[p.pid]; });
    return anyId ? procs.filter(function (p) { return !!state.identify[p.pid]; }) : procs;
  }

  function statCard(label, value, sub, cls) {
    return '<div class="stat ' + esc(cls || '') + '"><div class="s-lbl">' + esc(label) + '</div>'
      + '<div class="s-val">' + esc(value) + '</div>'
      + (sub ? '<div class="s-sub">' + esc(sub) + '</div>' : '') + '</div>';
  }

  function paintStats(dedup) {
    var s = state.stats, i;
    var managed = 0, unman = 0, cpu = 0, memKb = 0;
    for (i = 0; i < dedup.length; i++) {
      if (MANAGED_CATS[dedup[i].managedBy]) managed++;
      if (UNMANAGED_CATS[dedup[i].managedBy]) unman++;
      cpu += dedup[i].cpuPercent || 0;
      memKb += dedup[i].memoryRssKb || 0;
    }
    var html = statCard('Total', String(dedup.length), 'claude processes', 'green')
      + statCard('Managed', String(managed), 'ttyd / ttyd+tmux', 'blue')
      + statCard('Unmanaged', String(unman), 'external terminals', 'amber');
    if (s) {
      html += statCard('CPU', s.cpuUsagePercent + '%', s.cpuCount + ' cores · load ' + s.loadAvg1 + ' · claude ' + cpu.toFixed(0) + '%', level(s.cpuUsagePercent));
      html += statCard('Memory', s.memoryUsagePercent + '%',
        (s.usedMemoryMb / 1024).toFixed(0) + 'G / ' + (s.totalMemoryMb / 1024).toFixed(0) + 'G · claude ' + fmtKb(memKb), level(s.memoryUsagePercent));
      if (s.totalDiskGb > 0) {
        html += statCard('Disk', s.diskUsagePercent + '%', s.usedDiskGb + 'G / ' + s.totalDiskGb + 'G · ' + s.freeDiskGb + 'G free', level(s.diskUsagePercent));
      }
    }
    $('p-stats').innerHTML = html;
  }

  function paintProcMeta() {
    var st = state.pstatus || {};
    var bits = [];
    if (st.lastRefreshedAt) bits.push('scan ' + ago(st.lastRefreshedAt) + (st.lastDurationMs != null ? ' in ' + st.lastDurationMs + 'ms' : ''));
    if (st.intervalMs) bits.push('node rescans every ' + Math.round(st.intervalMs / 1000) + 's');
    if (state.hash) bits.push('hash ' + state.hash + ' · ' + state.unchanged + ' poll' + (state.unchanged === 1 ? '' : 's') + ' answered unchanged');
    if (!state.richOn) bits.push('rich detail off — turns come from identify, prompts/tasks need the toggle');
    $('p-meta').textContent = bits.join('  ·  ');
    // The one-line reason for the disabled Open/Connect buttons, stated where it is READ.
    // Guarded like paintNav: a browser holding a cached older index.html has no such element,
    // and a missing explanation must not take the whole process list down with it.
    var why = $('p-why');
    if (why) why.textContent = CONSOLE_WHY + ' The session link on each row opens it in assist-sessions instead.';
  }

  function turnBar(id) {
    if (!id) return '';
    var st = id.screenTurn;
    if (!st) return '<span class="tno">TUI (no capture)</span>';
    if (st.lastReadTurnIndex === null || st.lastReadTurnIndex === undefined) return '<span class="tno">no turn match</span>';
    var last = (id.sessionStats && id.sessionStats.lastTurnIndex != null) ? id.sessionStats.lastTurnIndex : st.lastReadTurnIndex;
    var read = st.lastReadTurnIndex;
    var live = read >= last;
    var pct = last > 0 ? Math.max(0, Math.min(100, Math.round((read / last) * 100))) : 100;
    return '<span class="turn" title="' + esc((st.matchedText || '').slice(0, 200)) + '">'
      + '<span class="bar"><span class="fill ' + (live ? 'live' : 'stale') + '" style="width:' + pct + '%"></span></span>'
      + '<span class="tlbl">T' + esc(read) + '/' + esc(last) + '</span>'
      + '<span class="pill ' + (live ? 'ok' : 'warn') + '">' + (live ? 'Live' : 'Stale -' + (last - read)) + '</span></span>';
  }

  function iconStats(sid) {
    var e = state.enrich[sid] || {}, r = state.rich[sid] || {}, out = '';
    var turns = r.numTurns;
    if (turns == null) {
      // identify carries sessionStats for the session, so turns survive without the rich fetch.
      for (var pid in state.identify) {
        if (state.identify[pid].sessionId === sid && state.identify[pid].sessionStats) { turns = state.identify[pid].sessionStats.numTurns; break; }
      }
    }
    if (turns != null) out += '<span class="ist" title="conversation turns">↺ ' + esc(turns) + '</span>';
    if (r.userPromptCount != null) out += '<span class="ist" title="user prompts">☺ ' + esc(r.userPromptCount) + '</span>';
    var agents = r.agentCount != null ? r.agentCount : (e.agentIds ? e.agentIds.length : null);
    if (agents) out += '<span class="ist" title="subagents">⚙ ' + esc(agents) + '</span>';
    if (r.taskCount) out += '<span class="ist" title="tasks">✓ ' + esc(r.taskCount) + '</span>';
    if (r.model) out += '<span class="ist" title="model">' + esc(r.model) + '</span>';
    if (r.teamName) out += '<span class="pill team" title="' + esc((r.allTeams || [r.teamName]).join(', ')) + '">' + esc(r.teamName) + '</span>';
    return out;
  }

  // Two-step confirmation instead of confirm(): the app shell's iframe sandbox does NOT grant
  // allow-modals, so window.confirm() is silently ignored there and would kill without asking.
  function armKill(key, label) {
    if (state.armTimer) clearTimeout(state.armTimer);
    state.arm = key;
    state.armTimer = setTimeout(function () { state.arm = null; paintProcesses(); }, 6000);
    say(label + ' — click again within 6s to confirm.', true);
    paintProcesses();
  }
  function disarm() { if (state.armTimer) clearTimeout(state.armTimer); state.armTimer = null; state.arm = null; }

  function killBtn(key, armedLabel, idleLabel, attr) {
    var armed = state.arm === key;
    return '<button class="ghost sm danger' + (armed ? ' armed' : '') + '" ' + attr + '>'
      + esc(armed ? armedLabel : idleLabel) + '</button>';
  }

  function procRowHtml(p) {
    var id = state.identify[p.pid];
    var sid = realSid(p.sessionId) || (id && id.sessionId) || null;
    var e = (sid && state.enrich[sid]) || {};
    var r = (sid && state.rich[sid]) || {};
    var connectable = sid && MANAGED_CATS[p.managedBy];
    var tmuxable = p.managedBy === 'unmanaged-tmux' || (p.managedBy === 'ttyd-tmux' && !sid);
    var busy = state.killing[p.pid];
    // Open ↗ / Connect ↗ used to lmui.goto('assist-console', …). That pane does not exist, so both
    // are rendered DISABLED — the button still says which kind of attach this process would take,
    // because that is real information about the process, and the reason is printed once above the
    // list (paintProcMeta) rather than only in a title nobody hovers.
    var action = connectable
      ? '<button class="ghost sm ok" disabled title="' + esc(CONSOLE_WHY) + '">Open ↗</button>'
      : tmuxable
        ? '<button class="ghost sm warn" disabled title="' + esc(CONSOLE_WHY) + '">' + (p.managedBy === 'ttyd-tmux' ? 'Open ↗' : 'Connect ↗') + '</button>'
        : '<span class="pill">external</span>';
    var size = e.fileSize != null ? fmtBytes(e.fileSize) : '—';
    var detail = r.lastUserMessage
      ? '<div class="pdet"><span class="msg">' + esc(r.lastUserMessage.slice(0, 300)) + '</span>'
        + (e.lastModified ? '<span class="upd">updated ' + esc(ago(e.lastModified)) + '</span>' : '') + '</div>'
      : (e.lastModified ? '<div class="pdet"><span class="upd">updated ' + esc(ago(e.lastModified)) + '</span></div>'
        : (p.cmdline ? '<div class="pdet"><span class="cmd">' + esc(p.cmdline) + '</span></div>' : ''));

    return '<div class="prow' + (busy ? ' busy' : '') + '">'
      + '<span class="c pid">PID ' + esc(p.pid) + '</span>'
      + (id && id.role ? '<span class="pill role-' + esc(id.role) + '">' + esc(id.role) + '</span>' : '')
      + turnBar(id)
      + '<span class="c sid">' + (sid
        ? '<a data-goto-session="' + esc(sid) + '" data-goto-project="' + esc(p.projectPath || '') + '" href="#">'
          + esc(shortSid(sid)) + '</a>'
        : '—') + '</span>'
      + '<span class="c proj" title="' + esc(p.projectPath || '') + '">' + esc(projName(p.projectPath)) + '</span>'
      + '<span class="c num" title="uptime">' + esc(uptime(p.startedAt)) + '</span>'
      + '<span class="c num ' + level(p.cpuPercent || 0) + '" title="cpu">' + esc(fmtCpu(p.cpuPercent)) + '</span>'
      + '<span class="c num ' + level((p.memoryRssKb || 0) / 1024 / 14) + '" title="resident memory">' + esc(fmtKb(p.memoryRssKb)) + '</span>'
      + '<span class="c num" title="session file size">' + esc(size) + '</span>'
      + '<span class="c num" title="' + esc(p.tty || '') + '">' + esc(ptsNum(p.tty)) + '</span>'
      + (p.tmuxSessionName || (id && id.tmuxSessionName) ? '<span class="c tmux">' + esc(p.tmuxSessionName || id.tmuxSessionName) + '</span>' : '')
      + '<span class="c grow">' + (sid ? iconStats(sid) : '') + '</span>'
      + '<span class="c act">' + action
      + killBtn('pid:' + p.pid, 'Confirm kill?', 'Kill', 'data-kill="' + esc(p.pid) + '"' + (busy ? ' disabled' : ''))
      + '</span>'
      + detail + '</div>';
  }

  function groupHtml(g) {
    var visible = visibleProcs(g.procs);
    var first = visible[0] ? state.identify[visible[0].pid] : null;
    var stats = first && first.sessionStats;
    var unident = g.key === 'unidentified';
    // Every process in a group shares a sessionId, so they share a project too — take it from the
    // first that has one so the outbound link can carry the pinned `project` alongside `session`.
    var gproj = '';
    for (var v = 0; v < visible.length && !gproj; v++) gproj = visible[v].projectPath || '';
    var head = unident
      ? '<span class="gk dim">Unidentified</span>'
      : '<span class="gk"><a data-goto-session="' + esc(g.key) + '" data-goto-project="' + esc(gproj) + '" href="#">'
        + esc(String(g.key).slice(0, 12)) + '… ↗</a></span>';
    var right = '<span class="pill">' + visible.length + ' process' + (visible.length === 1 ? '' : 'es') + '</span>'
      + (stats ? '<span class="gs">' + esc(stats.numTurns) + ' turns'
        + (stats.lastTimestamp ? ' · ' + esc(ago(stats.lastTimestamp)) : '') + '</span>' : '')
      + (visible.length > 1
        ? killBtn('grp:' + g.key, 'Confirm ' + visible.length + '?', 'Close all', 'data-killgroup="' + esc(g.key) + '"')
        : '');
    return '<div class="grp"><div class="ghead">' + head + '<span class="gright">' + right + '</span></div>'
      + visible.map(procRowHtml).join('') + '</div>';
  }

  function paintProcesses() {
    var all = enriched();
    var dedup = deduped(all);
    paintStats(dedup);
    var vis = all.filter(passProc);
    var groups = grouped(vis);
    $('p-list').innerHTML = groups.length
      ? groups.map(groupHtml).join('')
      : '<div class="empty-list">' + (state.all.length
        ? 'No processes match the current filter.'
        : 'No Claude processes running — start a Claude Code session to see it here. (Process scanning is POSIX-only; on Windows this list is always empty.)') + '</div>';
    var shown = 0;
    for (var i = 0; i < groups.length; i++) shown += visibleProcs(groups[i].procs).length;
    // Denominator = the ENRICHED total, not state.all.length. enriched() synthesises a row for a
    // managed ttyd instance that has no matching process in allClaudeProcesses, and the numerator
    // counts enriched rows — against the raw length those synthesised rows can print "showing 17
    // of 16". Both sides now come from the same list, and the surplus is named rather than hidden.
    var total = all.length;
    var synth = total - state.all.length;
    $('p-counts').textContent = 'showing ' + shown + ' of ' + total + ' process'
      + (total === 1 ? '' : 'es')
      + (synth > 0 ? ' (incl. ' + synth + ' managed instance' + (synth === 1 ? '' : 's') + ' with no live process)' : '')
      + ' in ' + groups.length + ' group' + (groups.length === 1 ? '' : 's')
      + ' · ' + dedup.length + ' after de-duplication';
    paintNav();
    var ka = $('btn-killall');
    if (ka) {
      var armed = state.arm === 'all';
      ka.textContent = armed ? 'Confirm ' + dedup.length + '?' : 'Close all';
      ka.classList.toggle('armed', armed);
      ka.disabled = dedup.length === 0;
    }
    paintProcMeta();
    reportHeight();
  }

  // ── loads ─────────────────────────────────────────────────────────────────
  function loadProcesses(opts) {
    opts = opts || {};
    var qs = [];
    if (opts.force) qs.push('forceCheck=true');
    else if (state.hash) qs.push('hash=' + encodeURIComponent(state.hash));
    state.procInFlight++;                 // switchTab reads this to avoid a duplicate boot fetch
    return api('node', '/ttyd/processes' + (qs.length ? '?' + qs.join('&') : '')).then(function (r) {
      state.procInFlight--;
      if (!r.ok) {
        if (!state.procLoaded && state.tab === 'processes') fatal(r.error.code + ': ' + r.error.message);
        else say('process refresh failed — ' + r.error.code + ': ' + r.error.message, true);
        return;
      }
      var env = r.env || {};
      if (env.hash) state.hash = env.hash;
      // The delta path answers with NO `data` key at all — reading r.data here would blank the list.
      if (env.unchanged) { state.unchanged++; paintProcMeta(); return; }
      var d = r.data || {};
      state.managed = d.managed || [];
      state.all = d.allClaudeProcesses || [];
      state.stats = d.systemStats || null;
      state.pstatus = d.processStatus || null;
      state.procLoaded = true;
      clearFatal();
      if (state.tab === 'processes') paintProcesses();
      // Repaint the project rows AND the detail pill so their live-session counts move — but never
      // while /projects is still in flight, or this overwrites "loading…" with "No projects found".
      else if (state.projLoaded) { paintProjects(); paintProjectDetail(); }
    });
  }

  // identify is capped at 20 pids per call server-side — chunk and merge.
  function loadIdentify() {
    var pids = state.all.map(function (p) { return p.pid; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
    if (!pids.length) { state.identify = {}; return Promise.resolve(); }
    var chunks = [];
    for (var i = 0; i < pids.length; i += 20) chunks.push(pids.slice(i, i + 20));
    return Promise.all(chunks.map(function (c) {
      return api('node', '/ttyd/process/identify', { method: 'POST', body: { pids: c } });
    })).then(function (rs) {
      var map = {}, any = false;
      for (var j = 0; j < rs.length; j++) {
        if (!rs[j].ok) continue;
        any = true;
        var list = (rs[j].data && rs[j].data.processes) || [];
        for (var k = 0; k < list.length; k++) map[list[k].pid] = list[k];
      }
      if (!any) return;                                 // keep the previous map on a total failure
      state.identify = map;
      if (state.tab === 'processes') paintProcesses();
    });
  }

  // Cheap enrichment: file size / agent ids / mtime for exactly the sessions on screen.
  // Rich enrichment (prompts, tasks, team, model, last message) needs listCheck, which returns
  // EVERY session in the project — opt-in, and conditional so a repeat poll costs ~200 bytes.
  function loadEnrichment() {
    var sids = {}, paths = {}, i;
    for (i = 0; i < state.all.length; i++) {
      var sid = realSid(state.all[i].sessionId);
      if (!sid) continue;
      sids[sid] = 1;
      if (state.all[i].projectPath) paths[state.all[i].projectPath] = 1;
    }
    var ids = Object.keys(sids);
    if (!ids.length) { state.enrich = {}; state.rich = {}; return Promise.resolve(); }
    var q = 'sessions=' + encodeURIComponent(JSON.stringify(ids.map(function (s) { return { sessionId: s }; })));
    var jobs = [api('node', '/sessions/batch-check?' + q).then(function (r) {
      if (!r.ok) { say('session enrichment failed — ' + r.error.code + ': ' + r.error.message, true); return; }
      state.enrich = (r.data && r.data.sessions) || {};
    })];
    if (state.richOn) {
      Object.keys(paths).forEach(function (p) {
        var known = state.listKnown[p];
        var qs = 'listCheck.projectPath=' + encodeURIComponent(p);
        if (known) qs += '&listCheck.knownSessionCount=' + encodeURIComponent(known.count)
          + '&listCheck.knownLatestModified=' + encodeURIComponent(known.latest);
        jobs.push(api('node', '/sessions/batch-check?' + qs).then(function (r) {
          if (!r.ok) { say('rich detail failed — ' + r.error.code + ': ' + r.error.message, true); return; }
          var ls = (r.data && r.data.listStatus) || {};
          state.listKnown[p] = { count: ls.totalSessions, latest: ls.latestModified };
          if (!ls.changed || !Array.isArray(ls.sessions)) return;   // unchanged → keep what we have
          for (var n = 0; n < ls.sessions.length; n++) {
            if (sids[ls.sessions[n].sessionId]) state.rich[ls.sessions[n].sessionId] = ls.sessions[n];
          }
        }));
      });
    }
    return Promise.all(jobs).then(function () { if (state.tab === 'processes') paintProcesses(); });
  }

  // ── the writes: kill by PID (never by session — see the grant note at the top) ──
  function killPids(pids, label) {
    if (!pids.length) return;
    pids.forEach(function (p) { state.killing[p] = true; });
    disarm();
    paintProcesses();
    say('killing ' + label + '…');
    Promise.all(pids.map(function (pid) {
      return api('node', '/ttyd/process/' + encodeURIComponent(pid) + '/kill', { method: 'POST' });
    })).then(function (rs) {
      var ok = 0, dead = 0, errs = [];
      for (var i = 0; i < rs.length; i++) {
        if (rs[i].ok) { ok++; if (rs[i].data && rs[i].data.alreadyDead) dead++; }
        else errs.push(pids[i] + ': ' + rs[i].error.code + ' ' + rs[i].error.message);
      }
      pids.forEach(function (p) { delete state.killing[p]; });
      say('killed ' + ok + '/' + pids.length + (dead ? ' (' + dead + ' already dead)' : '')
        + (errs.length ? ' — ' + errs.join(' | ') : ''), errs.length > 0);
      setTimeout(function () { loadProcesses({ force: true }).then(loadIdentify); }, 600);
    });
  }

  function groupPids(key) {
    var g = grouped(enriched().filter(passProc));
    for (var i = 0; i < g.length; i++) {
      if (g[i].key !== key) continue;
      return visibleProcs(g[i].procs).map(function (p) { return p.pid; });
    }
    return [];
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  $('tabs').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('.tab') : null;
    if (b && b.dataset.tab) switchTab(b.dataset.tab);
  });

  $('list').addEventListener('click', function (e) {
    var row = e.target.closest ? e.target.closest('.row') : null;
    if (!row || !row.dataset.path) return;
    openProject(row.dataset.path);
  });
  $('chips-git').addEventListener('click', function (e) {
    if (e.target.dataset.fg === undefined) return;
    state.pf.git = e.target.dataset.fg; paintChips(); paintProjects();
  });
  $('q').addEventListener('input', function (e) { state.pf.q = e.target.value; paintProjects(); });
  $('sort').addEventListener('change', function (e) { state.sort = e.target.value; paintProjects(); });
  $('btn-reload').addEventListener('click', function () { loadProjects(true); loadTasks(); });

  $('pq').addEventListener('input', function (e) { state.procQ = e.target.value; paintProcesses(); });
  $('auto').addEventListener('change', function (e) { state.auto = e.target.checked; paintProcMeta(); });
  $('rich').addEventListener('change', function (e) {
    state.richOn = e.target.checked;
    if (!state.richOn) { state.rich = {}; state.listKnown = {}; paintProcesses(); return; }
    say('fetching rich session detail — this pulls the whole session list for each project…');
    loadEnrichment();
  });
  $('btn-proc-refresh').addEventListener('click', function () {
    loadProcesses({ force: true }).then(loadIdentify).then(loadEnrichment);
  });
  $('btn-killall').addEventListener('click', function () {
    var pids = deduped(enriched()).map(function (p) { return p.pid; });
    if (!pids.length) return;
    if (state.arm !== 'all') { armKill('all', 'About to kill ' + pids.length + ' process' + (pids.length === 1 ? '' : 'es')); return; }
    killPids(pids, pids.length + ' process' + (pids.length === 1 ? '' : 'es'));
  });

  $('p-list').addEventListener('click', function (e) {
    var t = e.target;
    var a = t.closest ? t.closest('[data-goto-session]') : null;
    if (a) {
      e.preventDefault();
      // PINNED vocabulary only: `session` (a session id) and `project` (a project path). Both are
      // read by assist-sessions — `session` opens the detail, `project` scopes its list — so this
      // link lands on the entity instead of merely arriving at the pane.
      var params = { session: a.dataset.gotoSession };
      if (a.dataset.gotoProject) params.project = a.dataset.gotoProject;
      lmui.goto('assist-sessions', params);
      return;
    }
    var btn = t.closest ? t.closest('button') : null;
    if (!btn) return;
    // No data-open / data-tmux branches: those buttons targeted assist-console, which does not
    // exist, and are now rendered disabled (procRowHtml). Nothing here can emit that uiId.
    if (btn.dataset.kill) {
      var pid = Number(btn.dataset.kill);
      if (state.arm !== 'pid:' + pid) { armKill('pid:' + pid, 'About to kill PID ' + pid); return; }
      killPids([pid], 'PID ' + pid);
      return;
    }
    if (btn.dataset.killgroup) {
      var key = btn.dataset.killgroup;
      var pids2 = groupPids(key);
      if (!pids2.length) return;
      if (state.arm !== 'grp:' + key) { armKill('grp:' + key, 'About to kill ' + pids2.length + ' processes in this session'); return; }
      killPids(pids2, pids2.length + ' processes');
    }
  });

  // One timer drives all three cadences the source pages used: 5s snapshot, 10s identify,
  // 15s enrichment, while the Processes tab is open and auto-refresh is on.
  // The Projects tab also consumes that snapshot — it is the ONLY source of the per-project
  // "(N live)" counts — so it polls too, at 15s and snapshot-only: no identify, no enrichment,
  // and never forced, so an unchanged snapshot answers `{unchanged:true}` in ~200 bytes and
  // repaints nothing. Without this the live counts sat frozen at their boot value until the user
  // switched tabs or hit Refresh.
  var tick = 0;
  setInterval(function () {
    if (!state.auto || $('fatal-layer')) return;
    tick++;
    if (state.tab === 'processes') {
      loadProcesses();
      if (tick % 2 === 0) loadIdentify();
      if (tick % 3 === 0) loadEnrichment();
    } else if (tick % 3 === 0) {
      loadProcesses();
    }
  }, 5000);

  // Node identity for the header (single-node pane: this is always THIS host).
  api('node', '/health').then(function (r) {
    if (!r.ok || !r.data) return;
    state.health = r.data;
    $('node').textContent = (r.data.hostname || '') + ' · ' + (r.data.platform || '') + ' · v' + (r.data.version || '');
  });

  // Who is signed in (identity rides the session, not the view token).
  fetch('/auth/me', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
    $('who-name').textContent = (d.claims && (d.claims.name || d.claims.email)) || d.userId || 'signed in';
  }).catch(function () { $('who-name').textContent = 'signed in'; });

  // ── boot ────────────────────────────────────────────────────────────────
  paintChips();
  loadProjects();
  loadProcesses({ force: true });          // also feeds the projects tab's live-session counts
  loadTasks();                             // per-project task counts, one call for all projects

  // Inbound params are applied AFTER the loads are in flight on purpose: switchTab() starts a
  // /ttyd/processes fetch of its own unless one is already outstanding, so applying `tab` first
  // would double-fetch the snapshot at boot.
  (function applyInbound() {
    var known = { projects: 1, processes: 1 };
    var want = IN.tab, bad = '';
    if (want && !known[want]) { bad = want; want = ''; }
    if (!want) want = IN.session ? 'processes' : 'projects';
    // `session` names the entity, so it wins the process filter box; `q` is only a search
    // prefill. When both target the same box, say which one was applied instead of silently
    // dropping the other.
    var qDropped = '';
    if (want === 'processes') {
      if (IN.session) { state.procQ = IN.session; $('pq').value = IN.session; if (IN.q) qDropped = IN.q; }
      else if (IN.q) { state.procQ = IN.q; $('pq').value = IN.q; }
    } else if (IN.q) {
      state.pf.q = IN.q; $('q').value = IN.q;
    }
    if (bad) {
      state.navTab = { text: 'Opened by link with tab=' + bad + ', which this pane does not have — '
        + 'showing ' + want + '. (This pane has: projects, processes.)', warn: true };
    } else if (qDropped) {
      state.navTab = { text: 'Both session= and q= were sent; the process filter is set to the session. '
        + 'q=' + qDropped + ' was not applied.', warn: true };
    }
    if (want !== state.tab) switchTab(want);
    paintNav();
  })();
})();
