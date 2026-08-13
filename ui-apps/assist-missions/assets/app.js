/* assist-missions — mission control (the mission list, the Mission Controller and every
 * mission's DETAIL view) as a scoped pane. Plain JS, no build, no deps. Every data call
 * goes through the injected SDK helper (lmui.call), which carries the view token and
 * re-mints it on 401/403. Cross-pane links go through lmui.goto — a pane never builds a
 * URL to a sibling pane by hand.
 *
 * ── EVERY call this file makes, the function that makes it, and the grant rule that covers it ──
 * Every rule in lmui.config.json is `"exact": true` (a LEAF: same segment count as the rule),
 * and one wildcard segment is written `*` there. Below it is written `{*}` ONLY because the
 * literal two characters `*` + `/` would close this comment block — the config has a bare `*`.
 * The list IS the audit: one row per lmui.call, and no rule exists that no row uses. Verified
 * against the real matcher (core/src/ui-pages/local-tier/grants.ts) and curled live on :3200.
 *
 *   caller                  call                                  rule                          why it is needed
 *   loadMissions()          GET   /mission                        /mission [GET]                the mission list
 *   submitCreate()          POST  /mission                        /mission [POST]               "New mission" form
 *   loadDetail()            GET   /mission/:id                    /mission/{*} [GET]            mission detail view
 *   patchMission()          PATCH /mission/:id                    /mission/{*} [PATCH]          Save, status actions, binding:null
 *   loadDetailSessions()    GET   /mission/:id/sessions           /mission/{*}/sessions [GET]   the detail's Sessions list
 *   loadAllSessions()       GET   /mission/sessions               /mission/{*} [GET]            "All sessions" panel
 *   loadController()        GET   /mission/controller             /mission/{*} [GET]            leader badge + chat mount
 *   loadTrace()             GET   /mission/controller/trace       …/controller/trace [GET]      the Trace panel
 *   checkSession()          GET   /mission/session/:sid/status    …/session/{*}/status [GET]    liveness before showing a chat
 *   chatRead()              POST  /mission/session/:sid/read      …/session/{*}/read [POST]     the transcript (a POST route!)
 *   chatSend()              POST  /mission/session/:sid/drive     …/session/{*}/drive [POST]    the composer
 *   chatAnswer()            POST  /mission/session/:sid/answer    …/session/{*}/answer [POST]   answer a pending question
 *   ctlControl/sessControl  POST  /mission/session/:sid/control   …/session/{*}/control [POST]  interrupt / stop / restart
 *   resumeSession()         POST  /mission/session/:sid/resume    …/session/{*}/resume [POST]   resume a closed session
 *   runTick()               POST  /scheduler/jobs/mission-controller/run  (that leaf) [POST]    the "Tick" button, that job ONLY
 *   loadRepos()             GET   /ccr/cloud/repos                /ccr/cloud/repos [GET]        create-form repo picker
 *   loadBranches()          GET   /ccr/cloud/branches?repo=       /ccr/cloud/branches [GET]     create-form branch picker
 *   lookupBridgeUrl()       GET   /ccr/remote                     /ccr/remote [GET]             "Claude app" link fallback
 *
 * Not a grant: `fetch('/auth/me')` is same-origin on the serving tier (the signed-in badge).
 * A query string is NOT part of the grant check — the tier splits it off before matching — so
 * `?node=`/`?repo=` need no rule of their own.
 *
 * Envelope shapes mirror core/src/routes/core/mission.routes.ts, scheduler.routes.ts and
 * ccr.routes.ts (read at build time, then curled live on :3200):
 *   GET   /mission                    → data is a ***BARE ARRAY*** of missions. NOT {missions}.
 *   GET   /mission/:id                → data = the mission object DIRECTLY (no {mission} key)
 *   POST  /mission                    → data = the created mission DIRECTLY
 *   PATCH /mission/:id                → data = the patched mission DIRECTLY
 *   GET   /mission/:id/sessions       → data = { sessions:[{sid,kind,role,lastContact}] }
 *   GET   /mission/sessions           → data = { sessions:[{sid,missionId,role,transport}] }
 *   GET   /mission/controller         → data = { election, job, controllerSession, leader }
 *   GET   /mission/controller/trace   → data = { election, record, live, lineage[], journal[] }
 *   GET   /mission/session/:sid/status?node= → data = { transport, alive }
 *   POST  /mission/session/:sid/read   {lastN,node} → data = { messages[], pendingQuestion, historyComplete }
 *   POST  /mission/session/:sid/drive  {text,node}  → data = { delivered, cmdId? }
 *   POST  /mission/session/:sid/control{action,node,force} → data = { action, … }
 *   POST  /mission/session/:sid/answer {answer,toolUseId,requestId,node}
 *   POST  /mission/session/:sid/resume {missionId,node} → data = { resumed, reason?:'gone'|'conflict', autoCloseAt? }
 *   POST  /scheduler/jobs/mission-controller/run → {success:true,data:job} | {success:false,error:{code}}
 *   GET   /ccr/cloud/repos            → data = { repos:[{repo,…}] }  (objects, not strings)
 *   GET   /ccr/cloud/branches?repo=   → data = { branches:[string] }
 *   GET   /ccr/remote                 → data = { remotes:[{sessionId,webUrl,…}], …report }
 *
 * 🔴 Two traps this file is written around:
 *  1. GET /mission is a BARE ARRAY — the Array.isArray() hedge in loadMissions() is
 *     load-bearing; drop it and the list renders empty.
 *  2. A missing mission answers HTTP **400** (not 404) with {success:false,error:{code:'NOT_FOUND'}}.
 *     Never branch on the HTTP status; branch on r.ok / r.error.code. */
(function () {
  'use strict';

  // Enum vocabularies. Order mirrors MissionStatus / Isolation in
  // core/src/mission/mission-store.ts (and the old page's own selects).
  var STATUS_OPTIONS = [['', 'All status'], ['active', 'active'], ['waiting', 'waiting'], ['paused', 'paused'],
    ['blocked', 'blocked'], ['done', 'done'], ['failed', 'failed'], ['draft', 'draft']];
  var TRANSPORT_OPTIONS = [['', 'All type'], ['cloud', 'cloud'], ['native', 'native']];
  var RECENCY_OPTIONS = [['', 'Any time'], ['1d', '1 day'], ['3d', '3 days'], ['7d', '7 days']];
  var ISOLATIONS = ['cloud', 'worktree', 'shared'];
  var PAGE_SIZE = 50;
  var AUDIT_PAGE = 25;                  // mission-detail audit trail, paged (see auditHtml)
  // History paging for a chat, matching MissionSessionChat.tsx exactly.
  var DEPTH_INITIAL = 120, DEPTH_STEP = 400, DEPTH_MAX = 2000;
  var LIVE_WINDOW_MS = 2 * 60 * 1000;   // a session is "live" if it reported contact within ~2 min

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
  function api(service, path, opts) {
    return lmui.call(service, path, opts).then(function (r) {
      return r.text().then(function (txt) {
        var b = null;
        try { b = txt ? JSON.parse(txt) : null; } catch (e) { b = null; }
        var relayed = b && b.data !== undefined && b.status !== undefined;
        var env = relayed ? b.data : b;
        var status = relayed ? b.status : r.status;
        if (env && env.success === true) return { ok: true, status: status, data: env.data };
        var msg = (env && env.error && env.error.message) || (env && typeof env.error === 'string' ? env.error : '')
          || (env && env.message) || (txt ? txt.slice(0, 600) : ('HTTP ' + status));
        var code = (env && env.error && env.error.code) || ('HTTP_' + status);
        return { ok: false, status: status, error: { code: code, message: msg } };
      });
    }).catch(function (e) {
      return { ok: false, status: 0, error: { code: 'NETWORK', message: String(e && e.message || e) } };
    });
  }
  function fail(r) { return r.error.code + ': ' + r.error.message; }

  // ── formatters ────────────────────────────────────────────────────────────
  // Accepts an epoch-ms number OR an ISO string. Future timestamps fall back to the
  // absolute date rather than reading "just now" (assist-scheduler's agoISO lost that guard).
  function ago(v) {
    if (v == null || v === '') return '—';
    var t = typeof v === 'number' ? v : new Date(v).getTime();
    var m = Math.floor((Date.now() - t) / 60000);
    if (!isFinite(m) || m < 0) return new Date(t).toISOString().slice(0, 16).replace('T', ' ');
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    if (m < 1440) return Math.floor(m / 60) + 'h ago';
    return Math.floor(m / 1440) + 'd ago';
  }
  function fmtTime(v) {
    if (!v) return '—';
    var t = typeof v === 'number' ? v : new Date(v).getTime();
    if (!isFinite(t)) return String(v);
    return new Date(t).toISOString().slice(0, 16).replace('T', ' ');
  }
  function shortId(id) { return !id ? '—' : (id.length > 12 ? id.slice(0, 8) + '…' : id); }
  function isCloudSid(sid) { return /^(session_|cse_)/.test(String(sid || '')); }
  function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }

  // ── state ─────────────────────────────────────────────────────────────────
  var state = {
    missions: [],                      // BARE ARRAY from GET /mission
    controller: null,                  // { election, job, controllerSession, leader } from GET /mission/controller
    bridgeWebUrl: null,                // /ccr/remote fallback for the "Claude app" deep link
    loadedOnce: false,
    filter: { q: '', status: '', transport: '', recency: '' },
    page: PAGE_SIZE,
    objDraft: {},                      // missionId -> in-progress objective text (list rows)
    sideOpen: true,
    // ── internal routing: the pane's own views, no separate pane, no page reload ──
    view: { kind: 'controller', id: null },   // kind: 'controller' | 'mission' | 'session'
    tabs: [],                          // [{kind:'mission'|'session', id, title, node, missionId, transport}]
    detail: null,                      // GET /mission/:id for the open mission tab
    detailSessions: [],                // GET /mission/:id/sessions
    auditShown: AUDIT_PAGE,            // how many audit rows the detail view is showing
    draft: null,                       // {title,objective,plan,nextSteps} being edited
    baseline: null,                    // the same, as last loaded — dirty = draft !== baseline
    savedAt: 0,
    sessState: {},                     // sid -> {alive:'checking'|'alive'|…, notice}
    allSessions: [], allSessionsOpen: false,
    trace: null, traceOpen: false,
    repos: [], branches: [], createOpen: false,
    chat: null,                        // {sid,node,missionTag,prefix,depth,messages,pq,pqId,reachedStart,hideInjected,toolOpen,timer}
    poller: null,
  };

  function say(msg, isErr) {
    var out = $('out');
    if (!out) return;
    out.textContent = typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2);
    out.classList.toggle('err', !!isErr);
    reportHeight();
  }

  // A hard failure of the primary data call: cover the screen with the server's own text.
  function fatal(message) {
    var old = $('fatal-layer');
    if (old) old.remove();
    var d = document.createElement('div');
    d.className = 'fatal';
    d.id = 'fatal-layer';
    d.innerHTML = '<div class="fatal-card"><div class="fatal-h">Missions could not be loaded</div>'
      + '<pre class="fatal-msg"></pre><button class="primary" id="fatal-retry">Retry</button></div>';
    d.querySelector('.fatal-msg').textContent = message;   // textContent — server text is NOT trusted HTML
    document.body.appendChild(d);
    $('fatal-retry').onclick = function () { d.remove(); refreshAll(); };
    reportHeight();
  }
  // Mandatory for a multi-view pane: a fatal raised by one view must not stay pinned over another.
  function clearFatal() { var o = $('fatal-layer'); if (o) o.remove(); }

  // A repaint must never wipe what the user is typing. Every periodic refresh checks this
  // before rewriting a region that contains an editable control.
  function focusInside(el) {
    var a = document.activeElement;
    return !!(a && el && el !== a && el.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
  }

  // ── cross-pane navigation (the fixed contract — never build a sibling URL by hand) ──
  //
  // 🔴 THE PINNED PARAM VOCABULARY. A param name is the entity's SINGULAR NOUN, UNQUALIFIED:
  //   session · project · mission · task · cluster · tool · dataset · skill · unit · doc
  // plus exactly two generic modifiers: `tab` (a named sub-view) and `q` (a search prefill).
  // Nothing else — not `sessionId`, not `id`, not `missionId`, not `highlight`. The batch that
  // built these panes shipped four spellings of the same idea, and a param the target does not
  // read is not a broken URL, it is a SILENTLY broken button: the link opens, the pane loads,
  // and it simply ignores what you asked for. So the rule has two halves and both are load-
  // bearing — EMIT only these names (below), and READ the ones naming entities this pane can
  // display (`mission`, `session` — plus `q` and `tab`; see the boot block at the bottom).
  //
  // `embed`/`theme` are NOT part of this vocabulary: they are the shell's embedding contract
  // and lmui.goto REFUSES them (NAV_RESERVED), because the serving tier sets them itself.
  function gotoGraph(missionId) { lmui.goto('assist-mission-graph', missionId ? { mission: missionId } : undefined); }
  function gotoProcesses(missionId) { lmui.goto('assist-mission-processes', missionId ? { mission: missionId } : undefined); }

  // ── internal routing ──────────────────────────────────────────────────────
  // The mission DETAIL is a view of THIS pane, not a sibling pane. `?mission=<id>` is the
  // inbound deep link (the Mission Graph pane sends it via lmui.goto) and is kept in the
  // address bar as the user navigates, so a reload lands back on the same view.
  // The names written here are the same pinned ones this pane accepts on the way IN — an
  // address bar that a sibling could not have produced is a vocabulary drift waiting to happen.
  function syncUrl() {
    try {
      var qs = [];
      if (EMBEDDED) qs.push('embed=1');
      if (THEME === 'light') qs.push('theme=light');
      if (state.view.kind === 'mission') qs.push('mission=' + encodeURIComponent(state.view.id));
      else if (state.view.kind === 'session') qs.push('session=' + encodeURIComponent(state.view.id));
      // Keep the active search in the URL so a reload (or a copied link) reproduces the list
      // the user is actually looking at, under the same name a sibling would send it with.
      if (state.filter.q) qs.push('q=' + encodeURIComponent(state.filter.q));
      history.replaceState(null, '', location.pathname + (qs.length ? '?' + qs.join('&') : ''));
    } catch (e) { /* sandboxed frame — the view state lives in `state.view` regardless */ }
  }

  function setView(kind, id) {
    if (state.view.kind === kind && state.view.id === id) return;
    stopChat();
    clearFatal();
    state.view = { kind: kind, id: id || null };
    // A fresh mission gets a fresh audit page — carrying "showing 300" onto a mission with 4
    // rows would be harmless, but carrying it onto one with 5000 is not.
    if (kind === 'mission') {
      state.detail = null; state.detailSessions = []; state.draft = null; state.baseline = null;
      state.auditShown = AUDIT_PAGE;
    }
    syncUrl();
    paintTabs();
    renderStage();
    if (kind === 'mission') { loadDetail(); loadDetailSessions(); }
    if (kind === 'session') checkSession(tabFor(id));
  }

  function tabFor(id) {
    for (var i = 0; i < state.tabs.length; i++) if (state.tabs[i].id === id) return state.tabs[i];
    return null;
  }
  function openMissionTab(id, title) {
    if (!tabFor(id)) state.tabs.push({ kind: 'mission', id: id, title: title || id });
    setView('mission', id);
  }
  function openSessionTab(sid, title, node, missionId) {
    var t = tabFor(sid);
    if (!t) {
      t = { kind: 'session', id: sid, title: title || shortId(sid), node: node || null,
            missionId: missionId || null, transport: isCloudSid(sid) ? 'cloud' : 'native' };
      state.tabs.push(t);
      state.sessState[sid] = { alive: 'checking' };
    }
    setView('session', sid);
  }
  function closeTab(id) {
    state.tabs = state.tabs.filter(function (t) { return t.id !== id; });
    delete state.sessState[id];
    if (state.view.id === id) setView('controller', null);
    else { paintTabs(); }
  }

  function paintTabs() {
    var h = ['<button class="tab' + (state.view.kind === 'controller' ? ' on' : '') + '" data-tab="">Mission Controller'
      + (state.controller && state.controller.controllerSession ? '<span class="live-dot"></span>' : '') + '</button>'];
    state.tabs.forEach(function (t) {
      var on = state.view.id === t.id ? ' on' : '';
      var icon = t.kind === 'mission' ? '☰' : (t.transport === 'cloud' ? '☁' : '▣');
      var st = t.kind === 'session' ? (state.sessState[t.id] || {}).alive : null;
      var dot = st ? '<span class="sdot ' + esc(st) + '"></span>' : '';
      h.push('<span class="tabwrap' + on + '"><button class="tab' + on + '" data-tab="' + esc(t.id) + '">'
        + icon + ' ' + esc(clip(t.title, 22)) + dot + '</button>'
        + '<button class="tabx" data-close="' + esc(t.id) + '" title="Close tab">✕</button></span>');
    });
    $('tabs').innerHTML = h.join('');
    reportHeight();
  }

  // ── controller helpers (derived exactly as the old page derived them) ─────
  function ctlSession() { return (state.controller && state.controller.controllerSession) || null; }
  function ctlLeader() { return (state.controller && state.controller.leader) || null; }
  // Prefer the NATIVE session uuid (its .jsonl holds the full transcript) over the cse
  // (cloud handle, sparse client-events): reading via the cse shows "No turns yet".
  function ctlSid() { var cs = ctlSession(); return cs ? (cs.sessionId || cs.cse) : null; }
  function ctlNode() { var l = ctlLeader(); return (l && l.node) || (ctlSession() && ctlSession().node) || null; }
  function ctlCloudSid() {
    var cs = ctlSession(); if (!cs) return null;
    var sid = ctlSid();
    if (sid && isCloudSid(sid)) return sid;
    return cs.cse ? String(cs.cse).replace(/^cse_/, 'session_') : null;
  }
  function ctlAppUrl() {
    var c = ctlCloudSid();
    return c ? 'https://claude.ai/code/' + encodeURIComponent(c) : state.bridgeWebUrl;
  }
  function leaderLabel() {
    var l = ctlLeader();
    if (l) return l.host || l.node || 'unknown';
    var e = state.controller && state.controller.election;
    return e && e.monitorNodeId ? shortId(e.monitorNodeId) : null;
  }
  // controllerSession is STALE when it belongs to a different node than the elected leader —
  // the ~1-min window after an election flip, before the new leader launches its controller.
  function isFailingOver() {
    if (!state.controller) return false;
    var elected = (state.controller.leader && state.controller.leader.node) || state.controller.election.monitorNodeId || null;
    if (!elected) return false;
    var cs = ctlSession();
    if (cs && cs.node !== elected) return true;
    return !cs;
  }

  function paintLeaderBadge() {
    var el = $('leader');
    var lbl = leaderLabel();
    if (!state.controller || !lbl) { el.innerHTML = '<span class="dim">controller status unavailable</span>'; return; }
    var live = !!ctlSession();
    el.innerHTML = '<span class="ldot' + (live ? ' on' : '') + '"></span>Leader: <b>' + esc(lbl) + '</b>'
      + (live ? '' : ' <span class="dim">(no controller)</span>');
  }

  // ── mission list: filter → sort by recency → page ────────────────────────
  function transportOf(m) {
    var sid = m.binding && m.binding.sessionId;
    return sid ? (isCloudSid(sid) ? 'cloud' : 'native') : null;
  }
  function recencyMs(v) {
    return v === '1d' ? 86400000 : v === '3d' ? 3 * 86400000 : v === '7d' ? 7 * 86400000 : 0;
  }
  function filteredMissions() {
    var f = state.filter;
    // Keyword search: space-separated terms are ANDed across title/objective/id/status/tags.
    var terms = f.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    var win = recencyMs(f.recency);
    return state.missions.filter(function (m) {
      if (f.status && m.status !== f.status) return false;
      if (f.transport && transportOf(m) !== f.transport) return false;
      if (win && Date.now() - (m.updatedAt || m.createdAt || 0) > win) return false;
      if (terms.length) {
        var tagv = [];
        var tags = m.tags || {};
        for (var k in tags) if (Object.prototype.hasOwnProperty.call(tags, k)) tagv = tagv.concat(tags[k] || []);
        var hay = (m.title + ' ' + m.objective + ' ' + m.id + ' ' + m.status + ' ' + tagv.join(' ')).toLowerCase();
        for (var i = 0; i < terms.length; i++) if (hay.indexOf(terms[i]) === -1) return false;
      }
      return true;
    }).sort(function (a, b) { return (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0); });
  }

  function tagChips(m) {
    var out = [], tags = m.tags || {};
    for (var dim in tags) {
      if (!Object.prototype.hasOwnProperty.call(tags, dim)) continue;
      (tags[dim] || []).forEach(function (v) {
        var ctl = dim.indexOf('ctl:') === 0;
        out.push('<span class="tag' + (ctl ? ' ctl' : '') + '" title="' + esc(dim) + '">'
          + esc(dim.replace(/^ctl:/, '')) + ': ' + esc(v) + '</span>');
      });
    }
    if (m.parentId) out.push('<span class="tag" title="parent ' + esc(m.parentId) + '">↑ parent</span>');
    if ((m.dependsOn || []).length) out.push('<span class="tag" title="' + esc((m.dependsOn || []).join(', ')) + '">⛓ '
      + m.dependsOn.length + ' dep</span>');
    return out.join('');
  }

  function manageBadges(m) {
    var h = '';
    if (m.origin === 'onboarded') h += '<span class="pill" title="Existing session onboarded into mission control">onboarded</span>';
    if (m.manageMode) {
      var manual = m.manageMode === 'standby';
      h += '<span class="pill ' + (manual ? 'manual' : 'st-active') + '" title="'
        + esc(manual ? 'a human is running this session — Mission Control will not write to it'
                     : 'mission control drives this session') + '">'
        + (manual ? 'MANUAL' : 'handoff') + '</span>';
    }
    return h;
  }

  function missionRow(m) {
    var sel = state.view.kind === 'mission' && state.view.id === m.id ? ' sel' : '';
    var bind = m.binding
      ? '<span class="pill" title="Session: ' + esc(m.binding.sessionId || '—') + ' on ' + esc(m.binding.node || '—') + '">'
        + esc(m.binding.kind || 'bound') + ' · ' + esc(shortId(m.binding.sessionId)) + '</span>'
      : '<span class="pill">unbound</span>';
    var prog = '';
    if (m.progress) {
      var pc = Math.max(0, Math.min(100, Number(m.progress.percent) || 0));
      prog = '<div class="prog"><div class="bar"><i class="st-' + esc(m.status) + '" style="width:' + pc + '%"></i></div>'
        + '<span class="pcent">' + pc + '%</span></div>'
        + (m.progress.summary ? '<div class="psum">' + esc(m.progress.summary) + '</div>' : '');
    }
    var interim = (m.status === 'active' && m.interim && m.interim.text)
      ? '<div class="interim">⏳ working — ' + esc(clip(m.interim.text, 120)) + '</div>' : '';
    var objVal = state.objDraft[m.id] !== undefined ? state.objDraft[m.id] : (m.objective || '');
    var objDirty = state.objDraft[m.id] !== undefined && state.objDraft[m.id] !== (m.objective || '');
    var by = m.createdBy
      ? '<div class="prov">by ' + esc(m.createdBy.label || m.createdBy.id || m.createdBy.kind)
        + (m.createdBy.node ? ' <span class="dim">@' + esc(m.createdBy.node) + '</span>' : '')
        + ' <span class="dim">via ' + esc(m.createdBy.channel) + '</span></div>' : '';
    var acts = '';
    if (m.status === 'active') acts += '<button class="ghost xs" data-act="paused" data-mid="' + esc(m.id) + '">Pause</button>';
    if (m.status === 'paused' || m.status === 'blocked' || m.status === 'waiting')
      acts += '<button class="primary xs" data-act="active" data-mid="' + esc(m.id) + '">Resume</button>';
    if (m.status !== 'done' && m.status !== 'failed')
      acts += '<button class="ghost xs" data-act="done" data-mid="' + esc(m.id) + '">Done</button>';
    acts += '<button class="ghost xs" data-open="' + esc(m.id) + '">Open ▸</button>';
    acts += '<button class="ghost xs" data-graph="' + esc(m.id) + '" title="Show this mission in the Mission Graph pane">Graph ↗</button>';

    return '<div class="row' + sel + '" data-mid="' + esc(m.id) + '">'
      + '<div class="rhead"><span class="rt" data-open="' + esc(m.id) + '" title="Open the mission detail view">' + esc(m.title) + ' ☰</span>'
      + '<span class="pill st-' + esc(m.status) + '">' + esc(m.status) + '</span>' + manageBadges(m) + bind + '</div>'
      + interim
      + '<textarea class="objedit" rows="2" data-obj="' + esc(m.id) + '" title="Edit the objective — Save writes it back">' + esc(objVal) + '</textarea>'
      + (objDirty ? '<div class="objacts"><button class="primary xs" data-objsave="' + esc(m.id) + '">Save</button>'
          + '<button class="ghost xs" data-objdrop="' + esc(m.id) + '">Discard</button></div>' : '')
      + prog
      + '<div class="rmeta"><span class="mono">' + esc(m.env ? m.env.isolation : '?')
      + (m.env && m.env.repo ? ' · ' + esc(m.env.repo) : '') + '</span>'
      + '<span class="rid">' + esc(m.id) + '</span>'
      + (m.control && m.control.waitReason ? '<span class="warn">waiting: ' + esc(m.control.waitReason) + '</span>' : '')
      + '<span class="dim">' + esc(ago(m.updatedAt || m.createdAt)) + '</span></div>'
      + (tagChips(m) ? '<div class="tags">' + tagChips(m) + '</div>' : '')
      + by
      + '<div class="racts">' + acts + '</div></div>';
  }

  function paintList() {
    var el = $('list');
    // Never rewrite the list while an inline objective textarea in it holds focus.
    if (focusInside(el)) return;
    var vis = filteredMissions();
    var shown = vis.slice(0, state.page);
    el.innerHTML = shown.length
      ? shown.map(missionRow).join('')
      : '<div class="empty-list">' + (state.missions.length
          ? 'No missions match the current filter.'
          : (state.loadedOnce ? 'No missions yet.' : 'loading…')) + '</div>';
    $('counts').textContent = 'showing ' + shown.length + ' of ' + state.missions.length
      + ' mission' + (state.missions.length === 1 ? '' : 's')
      + (vis.length !== state.missions.length ? ' · ' + vis.length + ' match' : '');
    var more = $('more');
    more.hidden = vis.length <= shown.length;
    more.textContent = 'Load ' + Math.min(PAGE_SIZE, vis.length - shown.length) + ' more ('
      + shown.length + '/' + vis.length + ')';
    reportHeight();
  }

  // ── loads ─────────────────────────────────────────────────────────────────
  function loadMissions() {
    return api('node', '/mission').then(function (r) {
      if (!r.ok) {
        if (!state.loadedOnce) fatal(fail(r)); else say('mission list refresh failed — ' + fail(r), true);
        return;
      }
      // 🔴 data is a BARE ARRAY. The hedge is load-bearing — some tiers/relays have
      // historically wrapped it, and dropping it renders an empty list.
      var raw = r.data;
      state.missions = Array.isArray(raw) ? raw : ((raw && (raw.missions || raw.data)) || []);
      state.loadedOnce = true;
      clearFatal();
      paintList();
    });
  }

  function loadController() {
    return api('node', '/mission/controller').then(function (r) {
      if (!r.ok) { state.controller = null; paintLeaderBadge(); return; }
      state.controller = r.data || null;
      paintLeaderBadge();
      paintTabs();
      if (state.view.kind === 'controller') refreshControllerView();
      lookupBridgeUrl();
    });
  }

  // A resumed/adopted controller can run with `cse` still undiscovered while its live bridge
  // ALREADY has a claude.ai URL — resolve it so "Claude app" never silently vanishes.
  function lookupBridgeUrl() {
    var sid = ctlSid();
    if (!sid || ctlCloudSid()) { state.bridgeWebUrl = null; return; }
    if (state.bridgeWebUrl) return;
    api('node', '/ccr/remote').then(function (r) {
      if (!r.ok) return;
      var rows = (r.data && r.data.remotes) || [];
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].sessionId === sid && rows[i].webUrl) { state.bridgeWebUrl = rows[i].webUrl; break; }
      }
    });
  }

  function refreshAll() {
    clearFatal();
    loadMissions();
    loadController();
    if (state.view.kind === 'mission') { loadDetail(); loadDetailSessions(); }
    if (state.allSessionsOpen) loadAllSessions();
  }

  // ── mission writes ────────────────────────────────────────────────────────
  /** The ONE mutating call this pane makes against a mission.
   *  🔴 PATCH, not POST, and that is a GRANT decision, not a style one. `/mission/*` is one
   *  wildcard segment, so a POST rule for `POST /mission/:id` cannot help also admitting its
   *  one-segment literal siblings — `POST /mission/query|graph|schedule|changes|views|onboard`
   *  — because a path parameter and a literal occupy the same position and the rule language
   *  (correctly) has no way to tell them apart. `PATCH /mission/:id` is routed to the SAME
   *  handler (`handlePatch`, mission.routes.ts) and is the ONLY PATCH route under /mission on
   *  the node, so `PATCH /mission/*` grants exactly this call and nothing else.
   *  If you ever move this back to POST, widen the grant in the same commit — or the button
   *  silently 403s. */
  function patchMission(id, body, note) {
    say((note || 'saving') + ' ' + id + '…');
    return api('node', '/mission/' + encodeURIComponent(id), { method: 'PATCH', body: body }).then(function (r) {
      if (!r.ok) { say((note || 'update') + ' failed — ' + fail(r), true); return null; }
      // PATCH /mission/:id returns the updated mission DIRECTLY (no {mission} key).
      var m = r.data;
      if (m && m.id) {
        for (var i = 0; i < state.missions.length; i++) if (state.missions[i].id === m.id) state.missions[i] = m;
        if (state.detail && state.detail.id === m.id) state.detail = m;
      }
      say((note || 'saved') + ' ' + id + ' ok');
      paintList();
      return m;
    });
  }

  // ── create form ───────────────────────────────────────────────────────────
  function fillSelect(sel, pairs, current) {
    sel.innerHTML = pairs.map(function (p) {
      return '<option value="' + esc(p[0]) + '"' + (p[0] === current ? ' selected' : '') + '>' + esc(p[1]) + '</option>';
    }).join('');
  }
  function loadRepos() {
    fillSelect($('c-repo'), [['', 'loading…']], '');
    api('node', '/ccr/cloud/repos').then(function (r) {
      // data = { repos:[{repo,isPrivate,pushedAt}] } — OBJECTS, not strings.
      var list = ((r.ok && r.data && r.data.repos) || []).map(function (x) {
        return typeof x === 'string' ? x : (x.repo || x.slug || x.full_name || '');
      }).filter(Boolean);
      state.repos = list;
      var opts = [['', '— none —']].concat(list.map(function (s) { return [s, s]; }));
      opts.push(['__custom__', '— type it —']);
      fillSelect($('c-repo'), opts, '');
      if (!r.ok) say('repo list unavailable (' + fail(r) + ') — type the repo instead', true);
      if (r.ok && !list.length) { $('c-repo-text-wrap').hidden = false; }
    });
  }
  function loadBranches(repo) {
    if (!repo) { fillSelect($('c-branch'), [['', '— none —'], ['__custom__', '— type it —']], ''); return; }
    fillSelect($('c-branch'), [['', 'loading…']], '');
    api('node', '/ccr/cloud/branches?repo=' + encodeURIComponent(repo)).then(function (r) {
      var list = (r.ok && r.data && r.data.branches) || [];
      state.branches = list;
      var opts = [['', '— none —']].concat(list.map(function (s) { return [s, s]; }));
      opts.push(['__custom__', '— type it —']);
      fillSelect($('c-branch'), opts, '');
      if (!r.ok) { $('c-branch-text-wrap').hidden = false; say('branch list unavailable (' + fail(r) + ')', true); }
    });
  }
  function submitCreate() {
    var title = $('c-title').value.trim(), objective = $('c-objective').value.trim();
    if (!title || !objective) { say('title and objective are both required', true); return; }
    var repo = $('c-repo').value === '__custom__' || $('c-repo-text-wrap').hidden === false
      ? $('c-repo-text').value.trim() : $('c-repo').value;
    var branch = $('c-branch').value === '__custom__' || $('c-branch-text-wrap').hidden === false
      ? $('c-branch-text').value.trim() : $('c-branch').value;
    var env = { isolation: $('c-isolation').value };
    if (repo) env.repo = repo;
    if (branch) env.branch = branch;
    var body = { title: title, objective: objective, env: env };
    var projects = $('c-projects').value.trim();
    if (projects) body.projects = projects.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var deps = $('c-depends').value.trim();
    if (deps) body.dependsOn = deps.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    $('c-submit').disabled = true;
    say('creating mission…');
    api('node', '/mission', { method: 'POST', body: body }).then(function (r) {
      $('c-submit').disabled = false;
      if (!r.ok) { say('create failed — ' + fail(r), true); return; }
      var m = r.data;                                  // the created mission, DIRECTLY
      say('created ' + (m && m.id ? m.id : 'mission'));
      $('c-title').value = ''; $('c-objective').value = '';
      $('c-projects').value = ''; $('c-depends').value = '';
      $('create').hidden = true; state.createOpen = false;
      $('create-toggle').textContent = '+ New mission';
      loadMissions().then(function () { if (m && m.id) openMissionTab(m.id, m.title); });
    });
  }

  // ── chat (shared by the controller view, the mission detail view and session views) ──
  // One chat is visible at a time, so a single `state.chat` slot is enough. The 4 s poll
  // rewrites ONLY the transcript (and the pending-question block when its identity changes) —
  // the composer element is never re-rendered, so typing is never interrupted.

  function msgText(m) {
    if (typeof m.text === 'string') return m.text;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content.map(function (c) { return (c && typeof c === 'object' && c.type === 'text') ? c.text : ''; })
        .filter(Boolean).join('\n');
    }
    return '';
  }
  // The bare "[N tool call(s)]" placeholder counts as no text (it is rendered as a tool line).
  function meaningfulText(m) {
    var t = msgText(m).trim();
    return /^\[\d+ tool call\(s\)\]$/.test(t) ? '' : msgText(m);
  }
  function shortTool(t) { return String(t).replace(/^mcp__.*?__/, ''); }

  // Mirrors web/src/lib/injected-message.ts — lm-assist scaffolding the user never typed.
  // ⟦ ⟧ are U+27E6 / U+27E7 and are reserved for lm-assist banners.
  function isInjectedText(text) {
    var t = (text || '').trim();
    if (!t) return false;
    if (t.indexOf('[mission ') === 0) return false;            // a genuine mission-tagged user turn
    if (t.indexOf('[lm-assist bootstrap]') === 0) return true;
    if (t.indexOf('Run a controller pass now') === 0) return true;
    if (t.indexOf('⟦') === 0) return true;
    return t.indexOf('⟦WORKER-STATUS⟧') >= 0 || t.indexOf('⟦HEARTBEAT⟧') >= 0
      || t.indexOf('⟦lm-assist') >= 0 || t.indexOf('⟦BOOTSTRAP') >= 0 || t.indexOf('⟦CLUSTER') >= 0;
  }
  // Span-aware: an injected USER directive opens a hidden span that also swallows the
  // assistant turns answering it, until the next genuine user turn closes the span.
  function filterInjected(msgs) {
    var out = [], hiding = false;
    msgs.forEach(function (m) {
      var role = m.role || m.type || '';
      var inj = isInjectedText(msgText(m));
      if (role === 'user') {
        if (inj) { hiding = true; return; }
        hiding = false; out.push(m);
      } else if (!hiding && !inj) out.push(m);
    });
    return out;
  }

  function chatGroups(msgs) {
    var groups = [], pending = [];
    function flush() { if (pending.length) { groups.push({ kind: 'tools', tools: pending }); pending = []; } }
    msgs.forEach(function (m) {
      var t = meaningfulText(m);
      var tools = Array.isArray(m.tools) ? m.tools : [];
      if (!t && tools.length) { pending = pending.concat(tools); return; }
      flush();
      groups.push({ kind: 'msg', msg: m, text: t });
      if (tools.length) pending = pending.concat(tools);
    });
    flush();
    return groups;
  }

  function chatLogHtml() {
    var c = state.chat;
    var nonEmpty = c.messages.filter(function (m) {
      return msgText(m).trim().length > 0 || (Array.isArray(m.tools) && m.tools.length > 0);
    });
    var vis = c.hideInjected ? filterInjected(nonEmpty) : nonEmpty;
    var hidden = nonEmpty.length - vis.length;
    var h = [];
    if (!c.reachedStart && c.messages.length > 0 && c.depth < DEPTH_MAX) {
      h.push('<button class="ghost xs earlier" data-earlier="1" title="Showing the last '
        + c.messages.length + ' messages — load ' + DEPTH_STEP + ' earlier">↑ Load earlier messages</button>');
    } else if (c.reachedStart && c.messages.length > 0) {
      h.push('<div class="startmark">· start of available history ·</div>');
    }
    if (!vis.length) {
      h.push('<div class="empty-list center">' + (hidden > 0
        ? 'Session is running idle background passes — send a message to give it work.'
        : (c.loaded ? 'No messages yet' : 'loading…')) + '</div>');
    }
    chatGroups(vis).forEach(function (g, i) {
      if (g.kind === 'tools') {
        var key = 'tg' + i + ':' + g.tools.length;
        var open = !!c.toolOpen[key];
        var names = g.tools.map(shortTool);
        var preview = names.slice(0, 4).join(', ') + (names.length > 4 ? ' +' + (names.length - 4) : '');
        h.push('<div class="toolline" data-tk="' + esc(key) + '" title="click to '
          + (open ? 'collapse' : 'expand') + '">' + (open ? '▾' : '▸') + ' 🔧 '
          + esc(open ? (g.tools.length + ' tool call' + (g.tools.length > 1 ? 's' : '')) : preview) + '</div>'
          + (open ? '<div class="toolbadges">' + names.map(function (n) {
              return '<span class="pill kind">🔧 ' + esc(n) + '</span>'; }).join('') + '</div>' : ''));
        return;
      }
      var role = g.msg.role || g.msg.type || 'msg';
      var who = role === 'user' ? 'you' : role === 'assistant' ? 'assistant' : role;
      // Message text is markdown, rendered as PLAIN TEXT pre-wrap — no md library (CSP: self-hosted only).
      h.push('<div class="bub ' + (role === 'user' ? 'me' : 'them') + '">'
        + '<span class="bwho">' + esc(who) + '</span>'
        + '<pre class="btext">' + esc(g.text || '(no text)') + '</pre></div>');
    });
    if (hidden > 0) h.push('<div class="startmark">· ' + hidden + ' injected message'
      + (hidden === 1 ? '' : 's') + ' hidden ·</div>');
    return h.join('');
  }

  function paintChatLog() {
    var c = state.chat; if (!c) return;
    var log = $(c.prefix + '-log'); if (!log) return;
    // Stick to the bottom ONLY if the reader is already there — a 4 s poll must never yank
    // someone who scrolled up to read history back down.
    var atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    var prevT = log.scrollTop;
    log.innerHTML = chatLogHtml();
    if (c.anchor) { log.scrollTop = log.scrollHeight - c.anchor.h + c.anchor.t; c.anchor = null; }
    else if (atBottom || c.first) { log.scrollTop = log.scrollHeight; c.first = false; }
    else log.scrollTop = prevT;
    reportHeight();
  }

  function paintPending() {
    var c = state.chat; if (!c) return;
    var box = $(c.prefix + '-pending'); if (!box) return;
    var pq = c.pq;
    var id = pq ? (pq.toolUseId || pq.requestId || 'pq') : null;
    if (id === c.pqId) return;          // identity unchanged → do NOT rewrite (would wipe a typed answer)
    c.pqId = id;
    if (!pq || !pq.questions || !pq.questions[0]) { box.innerHTML = ''; box.hidden = true; return; }
    var q = pq.questions[0];
    box.hidden = false;
    box.innerHTML = '<div class="qhead">❓ ' + esc(q.header || 'Question') + ' — session is waiting on you</div>'
      + (q.question ? '<div class="qbody">' + esc(q.question) + '</div>' : '')
      + (q.options || []).map(function (o) {
          return '<button class="ghost qopt" data-answer="' + esc(o.label) + '"><b>' + esc(o.label) + '</b>'
            + (o.description ? '<span class="dim"> — ' + esc(o.description) + '</span>' : '') + '</button>';
        }).join('')
      + '<div class="qrow"><input class="q" id="' + esc(c.prefix) + '-qcustom" type="text" placeholder="…or type your own answer">'
      + '<button class="primary xs" data-answercustom="1">Send</button></div>';
    reportHeight();
  }

  function chatRead() {
    var c = state.chat; if (!c || c.inFlight) return;
    c.inFlight = true;
    var body = { lastN: c.depth };
    if (c.node) body.node = c.node;
    api('node', '/mission/session/' + encodeURIComponent(c.sid) + '/read', { method: 'POST', body: body })
      .then(function (r) {
        c.inFlight = false;
        if (!state.chat || state.chat !== c) return;       // the view changed under us
        if (!r.ok) { chatErr('read failed — ' + fail(r)); return; }
        chatErr('');
        var d = r.data || {};
        c.messages = Array.isArray(d.messages) ? d.messages : [];
        c.pq = d.pendingQuestion || null;
        // The server states whether older history exists; fall back to fewer-than-asked.
        c.reachedStart = d.historyComplete === true || (d.historyComplete === undefined && c.messages.length < c.depth);
        c.loaded = true;
        paintChatLog();
        paintPending();
      });
  }
  function chatErr(msg) {
    var c = state.chat; if (!c) return;
    var e = $(c.prefix + '-err'); if (!e) return;
    e.textContent = msg || '';
    e.hidden = !msg;
  }

  function chatSend() {
    var c = state.chat; if (!c) return;
    var ta = $(c.prefix + '-draft');
    var text = (ta.value || '').trim();
    if (!text) return;
    var btn = $(c.prefix + '-send');
    btn.disabled = true;
    var body = { text: (c.missionTag || '') + text };
    if (c.node) body.node = c.node;
    api('node', '/mission/session/' + encodeURIComponent(c.sid) + '/drive', { method: 'POST', body: body })
      .then(function (r) {
        btn.disabled = false;
        if (!r.ok) { chatErr('send failed — ' + fail(r) + ' (session may be busy — retry)'); return; }
        chatErr('');
        ta.value = '';
        say('sent to ' + shortId(c.sid));
        setTimeout(chatRead, 600);
      });
  }

  function chatAnswer(text) {
    var c = state.chat; if (!c || !c.pq) return;
    var a = String(text || '').trim();
    if (!a) return;
    var body = { answer: a, toolUseId: c.pq.toolUseId, requestId: c.pq.requestId };
    if (c.node) body.node = c.node;
    api('node', '/mission/session/' + encodeURIComponent(c.sid) + '/answer', { method: 'POST', body: body })
      .then(function (r) {
        if (!r.ok) { chatErr('answer failed — ' + fail(r)); return; }
        chatErr('');
        c.pq = null; c.pqId = null;
        paintPending();
        say('answer sent');
        setTimeout(chatRead, 600);
      });
  }

  /** Chat markup. `prefix` namespaces the ids so a view can host exactly one chat. */
  function chatHtml(prefix, placeholder) {
    return '<div class="chat" id="' + esc(prefix) + '-chat">'
      + '<div class="chattools"><button class="ghost xs" id="' + esc(prefix) + '-hide" title="Hide lm-assist-injected scaffolding (heartbeats, the standing controller directive) and the replies to it">👁 Only user ↔ assistant</button></div>'
      + '<div class="chatlog" id="' + esc(prefix) + '-log">loading…</div>'
      + '<div class="pending" id="' + esc(prefix) + '-pending" hidden></div>'
      + '<div class="composer">'
      + '<textarea id="' + esc(prefix) + '-draft" rows="3" placeholder="' + esc(placeholder || 'Type a message… (Enter to send, Shift+Enter for newline)') + '"></textarea>'
      + '<button class="primary" id="' + esc(prefix) + '-send">Send</button></div>'
      + '<div class="cherr" id="' + esc(prefix) + '-err" hidden></div></div>';
  }

  /** Start (or restart) the single live chat. Call AFTER the host markup is in the DOM. */
  function startChat(prefix, sid, node, missionTag) {
    stopChat();
    state.chat = {
      prefix: prefix, sid: sid, node: node || null, missionTag: missionTag || '',
      depth: DEPTH_INITIAL, messages: [], pq: null, pqId: undefined, reachedStart: false,
      hideInjected: true, toolOpen: {}, first: true, loaded: false, inFlight: false, anchor: null, timer: null,
    };
    var box = $(prefix + '-chat');
    if (box) {
      box.addEventListener('click', onChatClick);
      var ta = $(prefix + '-draft');
      ta.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatSend(); }
      });
      $(prefix + '-send').onclick = chatSend;
      $(prefix + '-hide').onclick = function () {
        state.chat.hideInjected = !state.chat.hideInjected;
        this.classList.toggle('on', state.chat.hideInjected);
        paintChatLog();
      };
      $(prefix + '-hide').classList.add('on');
    }
    chatRead();
    state.chat.timer = setInterval(chatRead, 4000);
  }
  function stopChat() {
    if (state.chat && state.chat.timer) clearInterval(state.chat.timer);
    state.chat = null;
  }
  function onChatClick(e) {
    var t = e.target, c = state.chat;
    if (!c) return;
    var tl = t.closest ? t.closest('[data-tk]') : null;
    if (tl) { c.toolOpen[tl.dataset.tk] = !c.toolOpen[tl.dataset.tk]; paintChatLog(); return; }
    if (t.dataset && t.dataset.earlier) {
      var log = $(c.prefix + '-log');
      if (log) c.anchor = { h: log.scrollHeight, t: log.scrollTop };
      c.depth = Math.min(c.depth + DEPTH_STEP, DEPTH_MAX);
      chatRead();
      return;
    }
    var opt = t.closest ? t.closest('[data-answer]') : null;
    if (opt) { chatAnswer(opt.dataset.answer); return; }
    if (t.dataset && t.dataset.answercustom) {
      var inp = $(c.prefix + '-qcustom');
      chatAnswer(inp ? inp.value : '');
    }
  }

  // ── stage: skeleton built ONCE per view change; the poll refreshes sub-regions only ──
  function renderStage() {
    var s = $('stage');
    if (state.view.kind === 'mission') s.innerHTML = missionViewHtml();
    else if (state.view.kind === 'session') s.innerHTML = sessionViewHtml();
    else s.innerHTML = controllerViewHtml();
    bindStage();
    reportHeight();
  }

  // ── view 1: Mission Controller ────────────────────────────────────────────
  function controllerViewHtml() {
    return '<div class="vhead">'
      + '<span class="vtitle">Mission Controller</span>'
      + '<span id="ctl-badges"></span>'
      + '<span class="spacer"></span>'
      + '<button class="ghost xs" id="btn-tick" title="Run a controller tick now (POST /scheduler/jobs/mission-controller/run)">▶ Tick</button>'
      + '<button class="ghost xs" id="btn-trace" title="What the control loop has been doing and why: health, decisions, and which session is the controller">Trace</button>'
      + '<span id="ctl-app"></span>'
      + '<select id="ctl-action" class="sel xs" title="Controller session actions">'
      + '<option value="">Actions…</option><option value="interrupt">Interrupt</option>'
      + '<option value="stop">Stop</option><option value="restart">Restart</option></select>'
      + '</div>'
      + '<div id="tickout" class="tickout" hidden></div>'
      + '<div id="trace" class="trace" hidden></div>'
      + '<div id="ctl-body">' + chatHtml('ctl', 'Message the Mission Controller… (Enter to send)') + '</div>';
  }

  /** Refresh the controller view's dynamic regions (badges, banners, chat mount). */
  function refreshControllerView() {
    if (state.view.kind !== 'controller') return;
    var b = $('ctl-badges'); if (!b) return;
    var cs = ctlSession(), job = (state.controller && state.controller.job) || null;
    var h = cs ? '<span class="pill st-active">live</span>' : '<span class="pill">offline</span>';
    if (cs) h += '<span class="mono dim"> ' + esc(cs.node) + ' · ' + esc(shortId(ctlSid())) + '</span>';
    if (job) h += '<span class="pill ' + (job.enabled ? 'st-active' : '') + '">'
      + (job.enabled ? 'every ' + esc(job.intervalMinutes) + 'm' : 'disabled') + '</span>';
    if (job && job.lastStatus) h += '<span class="pill st-' + (job.lastStatus === 'ok' ? 'done' : 'failed') + '" title="'
      + esc(clip(job.lastResult || '', 300)) + '">last ' + esc(job.lastStatus) + ' ' + esc(ago(job.lastRunAt)) + '</span>';
    b.innerHTML = h;

    var appEl = $('ctl-app');
    var url = ctlAppUrl();
    appEl.innerHTML = url
      ? '<a class="ghost xs btnlink" href="' + esc(url) + '" target="_blank" rel="noreferrer" '
        + 'title="Open this controller session in the Claude app (desktop / mobile / iPad)">↗ Claude app</a>' : '';
    $('ctl-action').disabled = !ctlSid();

    // The chat mounts only when a controller session exists AND we are not mid-failover;
    // otherwise the body carries the state banner the old page showed in its place.
    var body = $('ctl-body');
    var sid = ctlSid(), failing = isFailingOver();
    var want = (sid && !failing) ? ('chat:' + sid) : (failing ? 'failover' : 'offline');
    if (body.dataset.mode === want) return;
    body.dataset.mode = want;
    stopChat();
    if (want.indexOf('chat:') === 0) {
      body.innerHTML = chatHtml('ctl', 'Message the Mission Controller… (Enter to send)');
      startChat('ctl', sid, ctlNode(), '');
    } else if (want === 'failover') {
      body.innerHTML = '<div class="banner warnb"><div class="bt">Failing over — electing controller</div>'
        + '<div>New leader: <b>' + esc(leaderLabel() || 'unknown') + '</b><br>'
        + 'The supervisor will launch the controller on its next tick (~1 min).</div>'
        + '<button class="primary" id="b-tick2">▶ Force tick now</button></div>';
      $('b-tick2').onclick = runTick;
    } else {
      body.innerHTML = '<div class="banner"><div class="bt">No mission controller running</div>'
        + '<div>' + (state.controller ? 'The supervisor will launch the controller on the next tick.'
                                      : 'Loading controller status…') + '</div>'
        + (state.controller ? '<button class="primary" id="b-tick2">▶ Run tick now</button>' : '') + '</div>';
      if ($('b-tick2')) $('b-tick2').onclick = runTick;
    }
    reportHeight();
  }

  function runTick() {
    var el = $('tickout');
    if (el) { el.hidden = false; el.textContent = 'running controller tick…'; }
    say('running controller tick…');
    api('node', '/scheduler/jobs/mission-controller/run', { method: 'POST', body: {} }).then(function (r) {
      // This route hand-builds its own envelope: a refusal is {success:false,error:{code:'ENV_DISABLED'|'NOT_FOUND'}}
      // and looks nothing like the other error paths — surface its text verbatim.
      if (!r.ok) { if (el) el.textContent = 'tick refused — ' + fail(r); say('tick refused — ' + fail(r), true); return; }
      var job = r.data || {};
      var txt = 'tick ' + (job.lastStatus || 'ok') + ': ' + clip(job.lastResult || '(no result text)', 400);
      if (el) el.textContent = txt;
      say(txt);
      setTimeout(refreshAll, 1000);
    });
  }

  function ctlControl(action) {
    var sid = ctlSid();
    if (!sid || !action) return;
    say(action + ' controller ' + shortId(sid) + '…');
    var body = { action: action };
    var n = ctlNode(); if (n) body.node = n;
    api('node', '/mission/session/' + encodeURIComponent(sid) + '/control', { method: 'POST', body: body })
      .then(function (r) {
        if (!r.ok) { say(action + ' failed — ' + fail(r), true); return; }
        say(action + ' sent to ' + shortId(sid));
        setTimeout(loadController, 1500);
      });
  }

  // ── trace panel (the tractability cockpit, plain-language) ────────────────
  var TONE = { good: 'good', warn: 'warn', bad: 'bad', info: 'info' };
  function describeJournal(e) {
    var sid = String(e.sid || e.record || e.sessionId || '').slice(0, 8);
    if (e.kind === 'drive') {
      var via = e.transport === 'cloud' ? 'via its claude.ai bridge' : 'into its terminal';
      var what = e.source === 'user' ? 'your command' : 'its work directive';
      var cmd = e.cmdId ? ' [' + e.cmdId + ']' : '';
      return e.ok
        ? { label: e.source === 'user' ? 'Command delivered' : 'Pass delivered', detail: 'sent ' + what + ' ' + via + cmd + ' — awaiting its verifiable ⟦RESULT⟧', tone: TONE.good }
        : { label: e.source === 'user' ? 'Command FAILED' : 'Pass FAILED', detail: "couldn't deliver " + what + ' ' + via + cmd + (e.error ? ' — ' + clip(e.error, 70) : '') + ' (3 in a row triggers auto-relaunch)', tone: TONE.bad };
    }
    if (e.kind === 'ack') {
      var tasks = Array.isArray(e.tasks) ? e.tasks : [];
      var done = tasks.filter(function (t) { return /:\s*done/i.test(t); }).length;
      var blocked = tasks.filter(function (t) { return /:\s*blocked/i.test(t); }).length;
      return { label: 'Result verified', tone: blocked ? TONE.warn : TONE.good,
        detail: '[' + e.cmdId + '] controller reported ' + tasks.length + ' task' + (tasks.length === 1 ? '' : 's')
          + (tasks.length ? ' (' + done + ' done' + (blocked ? ', ' + blocked + ' blocked' : '') + ') — ' + clip(tasks[0], 60) : '') };
    }
    if (e.kind === 'ack-missing') return { label: 'No result yet', detail: '[' + e.cmdId + '] the controller has not answered with its ⟦RESULT⟧ block — check its reply or resend', tone: TONE.warn };
    if (e.kind === 'boot') return { label: 'Core started', tone: TONE.info,
      detail: e.record ? ('found controller ' + sid + ' ' + (e.live ? 'running' : 'not running') + '; this node ' + (e.isMonitor ? 'is' : 'is not') + ' the leader') : 'no controller on record yet' };
    if (e.kind === 'lifecycle') {
      if (e.event === 'resumed') return { label: 'Controller resumed', detail: 'continued the SAME session ' + sid + ' from its history — context preserved', tone: TONE.good };
      if (e.event === 'launched') return { label: 'New controller started', detail: 'fresh session ' + sid + ' (no usable history to resume)', tone: TONE.warn };
      return { label: 'Controller stopped', detail: 'session ' + sid + ' torn down', tone: TONE.warn };
    }
    if (e.kind === 'election') return e.isMonitor
      ? { label: 'Became leader', detail: 'this node now runs the controller', tone: TONE.good }
      : { label: 'Lost leadership', detail: 'another node (' + String(e.monitorNodeId || '?').slice(0, 12) + '…) is the leader now', tone: TONE.warn };
    var a = String(e.action || 'tick');
    if (a === 'churn-backoff') return { label: 'Held a relaunch', detail: e.launchesInWindow + ' launches in 10 min — pausing so a crash cycle can\'t run away', tone: TONE.warn };
    if (a === 'launch') return { label: 'Relaunching controller', detail: String(e.reason || 'no live session found — will resume from history if possible'), tone: TONE.warn };
    if (a === 'teardown') return { label: 'Tearing down', detail: 'confirmed not the leader for ' + (e.notMonitorStreak || 2) + '+ checks — cleaning up', tone: TONE.bad };
    if (a === 'drive') return { label: 'Work pass due', detail: 'sending the controller its periodic directive', tone: TONE.info };
    var flags = [e.indeterminate ? 'election could not be determined (holding safely)' : null,
                 e.stale ? 'using last known election result' : null].filter(Boolean).join('; ');
    return { label: a, detail: flags || ('leader=' + String(e.isMonitor)), tone: TONE.info };
  }
  function describeLineage(e) {
    var sid = String(e.sessionId || '').slice(0, 8);
    switch (e.event) {
      case 'resumed': return { label: 'Resumed', detail: 'same session ' + sid + ' continued in ' + (e.tmux || 'a new terminal') + ' — nothing lost', tone: TONE.good };
      case 'launched': return { label: 'Started fresh', detail: 'new session ' + sid + (e.tmux ? ' in ' + e.tmux : ''), tone: TONE.warn };
      case 'adopted': return { label: 'Adopted', detail: sid + ' put in charge' + (e.reason ? ' — ' + clip(e.reason, 60) : ''), tone: TONE.good };
      case 'teardown': return { label: 'Torn down', detail: sid + ' stopped' + (e.reason ? ' — ' + clip(e.reason, 60) : '') + ' (resumable later)', tone: TONE.bad };
      case 'resume-failed': return { label: 'Resume failed', detail: sid + ' could not be continued — skipped as a candidate', tone: TONE.bad };
      default: return { label: String(e.event), detail: sid, tone: TONE.info };
    }
  }
  function healthSummary(d) {
    var el = d.election;
    if (!el) return { text: 'Election state unavailable.', tone: TONE.warn };
    if (el.indeterminate) return { text: 'Cannot determine leadership right now (hub/cluster data unavailable) — holding safely, no destructive action will be taken.', tone: TONE.warn };
    if (!el.isMonitor) return { text: 'This node is not the leader — the controller runs on ' + String(el.monitorNodeId || 'another node').slice(0, 16) + '.', tone: TONE.info };
    if (!d.record) return { text: 'Leader confirmed, but no controller on record — one will be started (resuming history if available) on the next check.', tone: TONE.warn };
    if (!d.live) return { text: 'Controller session is not running — it will be relaunched on the next check, resuming the same session from history.', tone: TONE.warn };
    var lastDrive = null;
    for (var i = d.journal.length - 1; i >= 0; i--) if (d.journal[i].kind === 'drive') { lastDrive = d.journal[i]; break; }
    if (lastDrive && lastDrive.ok === false) return { text: 'Controller is live but the last work pass FAILED to deliver — after 3 consecutive failures it will be auto-relaunched (losslessly).', tone: TONE.bad };
    return { text: 'Healthy — leader confirmed, controller session live'
      + (lastDrive ? ', last work pass delivered ' + ago(lastDrive.at) : '')
      + (el.stale ? ' (election served from last known result)' : '') + '.', tone: TONE.good };
  }
  function paintTrace() {
    var el = $('trace'); if (!el) return;
    el.hidden = !state.traceOpen;
    if (!state.traceOpen) return;
    var d = state.trace;
    if (!d) { el.innerHTML = '<div class="dim pad">loading trace…</div>'; return; }
    var h = healthSummary(d);
    el.innerHTML = '<div class="health"><span class="hdot ' + esc(h.tone) + '"></span>'
      + '<span title="' + esc(h.text) + '">' + esc(h.text) + '</span>'
      + (d.record && d.record.sessionId ? '<span class="spacer"></span><span class="mono dim">'
          + esc(String(d.record.sessionId).slice(0, 8)) + ' · ' + esc(d.record.tmux || '') + '</span>' : '')
      + '</div>'
      + '<div class="tracecols"><div class="tracecol"><h3>What the control loop did</h3>'
      + (d.journal.length ? d.journal.slice().reverse().map(function (e) {
          var x = describeJournal(e);
          return '<div class="trow"><span class="tw">' + esc(ago(e.at)) + '</span>'
            + '<span class="tl ' + esc(x.tone) + '">' + esc(x.label) + '</span>'
            + '<span class="td">' + esc(x.detail) + '</span></div>';
        }).join('') : '<div class="dim">Nothing recorded yet — entries appear as the loop makes decisions.</div>')
      + '</div><div class="tracecol"><h3>Controller identity history</h3>'
      + (d.lineage.length ? d.lineage.slice().reverse().map(function (e) {
          var x = describeLineage(e);
          return '<div class="trow"><span class="tw">' + esc(ago(e.at)) + '</span>'
            + '<span class="tl ' + esc(x.tone) + '">' + esc(x.label) + '</span>'
            + '<span class="td">' + esc(x.detail) + '</span></div>';
        }).join('') : '<div class="dim">No identity events yet.</div>')
      + '</div></div>';
    reportHeight();
  }
  function loadTrace() {
    api('node', '/mission/controller/trace').then(function (r) {
      if (!r.ok) { say('trace failed — ' + fail(r), true); return; }
      var d = r.data || {};
      d.journal = Array.isArray(d.journal) ? d.journal : [];
      d.lineage = Array.isArray(d.lineage) ? d.lineage : [];
      state.trace = d;
      paintTrace();
    });
  }

  // ── view 2: MISSION DETAIL — an INTERNAL route of this pane, not a sibling pane ──
  function missionViewHtml() {
    return '<div class="vhead"><span class="vtitle" id="md-title">…</span><span id="md-badges"></span>'
      + '<span class="spacer"></span>'
      + '<button class="ghost xs" id="md-graph" title="Show this mission in the Mission Graph pane">Graph ↗</button>'
      + '<button class="ghost xs" id="md-procs" title="Show this mission in the Mission Processes pane">Processes ↗</button>'
      + '<button class="ghost xs" id="md-back">◂ Controller</button></div>'
      + '<div id="md-err" class="cherr" hidden></div>'
      + '<div class="mdfields">'
      + '<label class="fld">Title<input id="md-f-title" type="text" maxlength="300"></label>'
      + '<label class="fld">Objective<textarea id="md-f-objective" rows="3"></textarea></label>'
      + '<label class="fld">Plan <span class="hint">markdown, stored verbatim</span><textarea id="md-f-plan" class="mono" rows="5" placeholder="Mission plan…"></textarea></label>'
      + '<label class="fld">Next steps <span class="hint">one per line</span><textarea id="md-f-next" rows="3" placeholder="First step&#10;Second step"></textarea></label>'
      + '<div id="md-rel" class="mdrel"></div>'
      + '<div class="actions"><button class="primary" id="md-save" disabled>Save</button>'
      + '<span id="md-saved" class="ok" hidden>saved</span><span class="spacer"></span>'
      + '<span id="md-status-acts"></span></div>'
      + '<div id="md-note" class="mdnote"></div>'
      + '</div>'
      + '<div class="mdsect"><h3>Sessions <span id="md-scount" class="dim"></span></h3><div id="md-sessions">loading…</div></div>'
      + '<div class="mdsect grow"><h3>Mission chat <span class="dim">→ Mission Controller</span></h3>'
      + '<div id="md-chat-host"></div></div>';
  }

  function draftFrom(m) {
    return { title: m.title || '', objective: m.objective || '', plan: m.plan || '',
             nextSteps: (m.nextSteps || []).join('\n') };
  }
  function draftsEqual(a, b) {
    return !!a && !!b && a.title === b.title && a.objective === b.objective
      && a.plan === b.plan && a.nextSteps === b.nextSteps;
  }
  function isDirty() { return !!(state.draft && state.baseline && !draftsEqual(state.draft, state.baseline)); }

  function readDraftFromDom() {
    if (state.view.kind !== 'mission' || !$('md-f-title')) return;
    state.draft = { title: $('md-f-title').value, objective: $('md-f-objective').value,
                    plan: $('md-f-plan').value, nextSteps: $('md-f-next').value };
    $('md-save').disabled = !isDirty();
  }

  function loadDetail() {
    var id = state.view.id;
    return api('node', '/mission/' + encodeURIComponent(id)).then(function (r) {
      if (state.view.kind !== 'mission' || state.view.id !== id) return;
      if (!r.ok) {
        // A missing mission answers HTTP 400 with error.code NOT_FOUND — branch on the CODE.
        var e = $('md-err');
        if (e) { e.hidden = false; e.textContent = (r.error.code === 'NOT_FOUND' ? 'Mission not found — ' : '') + fail(r); }
        return;
      }
      if ($('md-err')) $('md-err').hidden = true;
      state.detail = r.data || null;                    // the mission object DIRECTLY
      paintDetail();
    });
  }
  function loadDetailSessions() {
    var id = state.view.id;
    return api('node', '/mission/' + encodeURIComponent(id) + '/sessions').then(function (r) {
      if (state.view.kind !== 'mission' || state.view.id !== id) return;
      state.detailSessions = (r.ok && r.data && Array.isArray(r.data.sessions)) ? r.data.sessions : [];
      paintDetailSessions();
    });
  }

  /** The mission's audit trail (`adjustments`), newest first, PAGED.
   *
   *  🔴 This used to render `.reverse().slice(0, 25)` under a header that printed the TRUE
   *  total — so a mission with 200 adjustments said "audit (200)" and showed 25, with nothing
   *  on screen admitting the other 175 existed or any way to reach them. A cap that contradicts
   *  its own header is worse than no cap: the reader has no reason to doubt the count, so the
   *  missing rows are not "hidden", they are DENIED. Nothing on the server pages this either —
   *  `recordAdjustment()` in core/src/mission/mission-store.ts pushes without a cap, so the
   *  array really can grow to thousands on a long-running mission and rendering all of it in
   *  one go is a real hazard. Hence: page it, and always state the count actually shown.
   *
   *  There is deliberately no "Show all" — that just moves the blow-up to one click. */
  function auditHtml(m) {
    var all = m.adjustments || [];
    var n = all.length;
    if (!n) return '<div><span class="k">audit:</span> <span class="dim">no changes recorded yet</span></div>';
    var shown = Math.min(state.auditShown || AUDIT_PAGE, n);
    var rows = all.slice().reverse().slice(0, shown).map(function (a) {
      return '<span class="mono dim">[' + esc(fmtTime(a.at)) + ']</span> ' + esc(a.by) + ' · '
        + esc(a.trigger) + ' → ' + esc(a.change);
    }).join('<br>');
    var head = shown < n ? ('audit — showing ' + shown + ' of ' + n + ', newest first:')
                         : ('audit (' + n + (n > AUDIT_PAGE ? ', all shown' : '') + '):');
    var more = shown < n
      ? '<button class="ghost xs" data-auditmore="1">Show ' + Math.min(AUDIT_PAGE, n - shown)
        + ' more (' + shown + '/' + n + ')</button>' : '';
    var less = shown > AUDIT_PAGE ? '<button class="ghost xs" data-auditless="1">Show fewer</button>' : '';
    return '<div><span class="k">' + head + '</span><br>' + rows
      + (more || less ? '<div class="auditacts">' + more + less + '</div>' : '') + '</div>';
  }

  function paintDetail() {
    var m = state.detail; if (!m || state.view.kind !== 'mission') return;
    $('md-title').textContent = m.title || m.id;
    $('md-badges').innerHTML = '<span class="pill st-' + esc(m.status) + '">' + esc(m.status) + '</span>'
      + manageBadges(m) + '<span class="mono dim"> ' + esc(m.id) + '</span>';

    // Reset the editors to the server's values ONLY when the user is not mid-edit — a 5 s
    // poll must never clobber typing (and `dirty` must survive it).
    var fresh = draftFrom(m);
    var editing = focusInside($('stage')) || isDirty();
    if (!editing) {
      state.draft = fresh;
      state.baseline = fresh;
      $('md-f-title').value = fresh.title;
      $('md-f-objective').value = fresh.objective;
      $('md-f-plan').value = fresh.plan;
      $('md-f-next').value = fresh.nextSteps;
    } else {
      state.baseline = fresh;                            // re-baseline so "dirty" stays truthful
    }
    $('md-save').disabled = !isDirty();
    $('md-saved').hidden = Date.now() - state.savedAt > 2500;

    var rel = [];
    var tags = m.tags || {};
    for (var dim in tags) if (Object.prototype.hasOwnProperty.call(tags, dim)) {
      rel.push('<div><span class="k' + (dim.indexOf('ctl:') === 0 ? ' ctl' : '') + '">' + esc(dim) + ':</span> '
        + esc((tags[dim] || []).join(', ')) + '</div>');
    }
    if (m.parentId) rel.push('<div><span class="k">parent:</span> ' + esc(m.parentId) + '</div>');
    if ((m.dependsOn || []).length) rel.push('<div><span class="k">depends on:</span> ' + esc(m.dependsOn.join(', ')) + '</div>');
    if (m.env) rel.push('<div><span class="k">env:</span> ' + esc(m.env.isolation)
      + (m.env.repo ? ' · ' + esc(m.env.repo) : '') + (m.env.branch ? ' @ ' + esc(m.env.branch) : '')
      + (m.env.host ? ' · ' + esc(m.env.host) : '') + '</div>');
    if (m.binding) rel.push('<div><span class="k">executor:</span> ' + esc(m.binding.kind || 'bound') + ' '
      + esc(m.binding.sessionId || '—') + ' on ' + esc(m.binding.node || '—') + '</div>');
    if (m.progress) rel.push('<div><span class="k">progress:</span> ' + (Number(m.progress.percent) || 0) + '% '
      + esc(m.progress.summary || '') + '</div>');
    if ((m.results || []).length) rel.push('<div><span class="k">results:</span> '
      + m.results.map(function (x) { return esc(fmtTime(x.at) + ' · ' + x.ref + (x.summary ? ' — ' + x.summary : '')); }).join('<br>') + '</div>');
    rel.push(auditHtml(m));
    rel.push('<div><span class="k">updated:</span> ' + esc(ago(m.updatedAt)) + ' · <span class="k">rev</span> '
      + esc(m.rev) + ' · <span class="k">owner</span> ' + esc(m.ownerNode || '—') + '</div>');
    // `.mdrel` is a SCROLLING box (max-height) and this runs on the 5 s poll, so writing
    // innerHTML naively yanks the reader back to the top every five seconds. Barely noticeable
    // when the audit trail was capped at 25 rows; unusable once it pages to hundreds. Same rule
    // as the chat log: restore where they were.
    var relEl = $('md-rel');
    var relTop = relEl.scrollTop;
    relEl.innerHTML = rel.join('');
    relEl.scrollTop = relTop;

    var acts = '';
    if (m.status === 'active') acts += '<button class="ghost" data-mdstatus="paused">Pause</button>';
    if (m.status === 'paused' || m.status === 'blocked' || m.status === 'waiting')
      acts += '<button class="primary" data-mdstatus="active">Resume</button>';
    if (m.status !== 'done' && m.status !== 'failed') acts += '<button class="ghost" data-mdstatus="done">Done</button>';
    $('md-status-acts').innerHTML = acts;

    var note = '';
    if (m.status === 'active' && m.interim && m.interim.text) note += '<div class="interim">⏳ working — ' + esc(clip(m.interim.text, 160)) + '</div>';
    if (m.control && m.control.waitReason) note += '<div class="warn">waiting: ' + esc(m.control.waitReason) + '</div>';
    $('md-note').innerHTML = note;

    // The mission chat talks to the CONTROLLER, tagged so it knows which mission this is about.
    var host = $('md-chat-host');
    var sid = ctlSid();
    var want = sid ? 'chat:' + sid : 'none';
    if (host.dataset.mode !== want) {
      host.dataset.mode = want;
      stopChat();
      if (sid) {
        host.innerHTML = chatHtml('md', 'Ask the Mission Controller about this mission… (Enter to send)');
        startChat('md', sid, ctlNode(), '[mission ' + m.id + ' "' + (m.title || '') + '"] ');
      } else {
        host.innerHTML = '<div class="dim pad">No controller running — start the Mission Controller to chat about this mission.</div>';
      }
    }
    reportHeight();
  }

  function paintDetailSessions() {
    var el = $('md-sessions'); if (!el) return;
    var m = state.detail || {};
    var rows = state.detailSessions;
    $('md-scount').textContent = rows.length ? '(' + rows.length + ')' : '';
    if (!rows.length) { el.innerHTML = '<div class="empty-list">No sessions yet.</div>'; return; }
    el.innerHTML = rows.map(function (s) {
      var cloud = isCloudSid(s.sid);
      var live = typeof s.lastContact === 'number' && (Date.now() - s.lastContact) < LIVE_WINDOW_MS;
      var roleLabel = s.kind === 'orchestrator' ? 'orchestrator' : (s.kind || 'worker');
      var isExec = !!(m.binding && m.binding.sessionId) && s.sid === m.binding.sessionId;
      return '<div class="srow">'
        + '<button class="ghost srowbtn" data-sess="' + esc(s.sid) + '" title="Open this session in a tab">'
        + '<span class="sdot ' + (live ? 'alive' : '') + '" title="' + (live ? 'live' : 'idle') + '"></span>'
        + (cloud ? '☁' : '▣') + ' <span class="pill kind">' + esc(roleLabel) + (s.role === 'sub' ? ' · sub' : '') + '</span>'
        + (isExec ? '<span class="pill st-active">executor</span>' : '')
        + '<span class="mono grow1">' + esc(s.sid.slice(0, 12)) + '</span>'
        + '<span class="dim">' + (cloud ? 'cloud' : 'native') + '</span></button>'
        + (cloud ? '<a class="ghost btnlink" href="https://claude.ai/code/' + encodeURIComponent(s.sid)
            + '" target="_blank" rel="noreferrer" title="Open in Claude app">↗</a>' : '')
        + '</div>';
    }).join('');
    reportHeight();
  }

  function saveDetail() {
    readDraftFromDom();
    var m = state.detail; if (!m || !state.draft) return;
    var next = state.draft.nextSteps.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    $('md-save').disabled = true;
    patchMission(m.id, { title: state.draft.title, objective: state.draft.objective,
                         plan: state.draft.plan, nextSteps: next }, 'saving').then(function (updated) {
      if (updated) {
        state.baseline = { title: state.draft.title, objective: state.draft.objective,
                           plan: state.draft.plan, nextSteps: state.draft.nextSteps };
        state.savedAt = Date.now();
        $('md-saved').hidden = false;
        setTimeout(function () { if ($('md-saved')) $('md-saved').hidden = true; }, 2500);
      }
      if ($('md-save')) $('md-save').disabled = !isDirty();
      loadDetail();
    });
  }

  // ── view 3: a SESSION (liveness → resume → chat), same state machine as the old tabs ──
  function sessionViewHtml() {
    var t = tabFor(state.view.id) || { id: state.view.id, transport: 'native' };
    return '<div class="vhead"><span class="vtitle">Session</span>'
      + '<span class="pill">' + esc(t.transport) + '</span>'
      + '<span class="mono dim">' + esc(t.id) + '</span><span class="spacer"></span>'
      + (isCloudSid(t.id) ? '<a class="ghost xs btnlink" href="https://claude.ai/code/' + encodeURIComponent(t.id)
          + '" target="_blank" rel="noreferrer" title="Open in Claude app">↗ Claude app</a>' : '')
      + '<select id="sv-action" class="sel xs" title="Session actions"><option value="">Actions…</option>'
      + '<option value="interrupt">Interrupt</option><option value="stop">Stop</option>'
      + '<option value="restart">Restart</option></select>'
      + '<button class="ghost xs" id="sv-close">✕ Close tab</button></div>'
      + '<div id="sv-body" class="svbody"></div>';
  }

  function paintSessionView() {
    if (state.view.kind !== 'session') return;
    var body = $('sv-body'); if (!body) return;
    var sid = state.view.id, t = tabFor(sid) || {};
    var st = state.sessState[sid] || { alive: 'checking' };
    var want = st.alive === 'alive' ? 'chat' : st.alive;
    if (body.dataset.mode === want && want === 'chat') return;
    body.dataset.mode = want;
    if (want === 'chat') {
      stopChat();
      body.innerHTML = (st.notice ? '<div class="notice">⏱ ' + esc(st.notice) + '</div>' : '')
        + chatHtml('sv', 'Type a message to this session… (Enter to send)');
      startChat('sv', sid, t.node, '');
      paintTabs();
      return;
    }
    stopChat();
    if (want === 'checking' || want === 'resuming') {
      body.innerHTML = '<div class="banner"><div class="bt">'
        + (want === 'resuming' ? 'Resuming session…' : 'Checking session status…') + '</div></div>';
    } else if (want === 'confirm-resume') {
      body.innerHTML = '<div class="banner warnb"><div class="bt">This session is closed.</div>'
        + '<div>Resume it? It will auto-close after 30 min idle.</div>'
        + '<div class="actions"><button class="primary" id="sv-resume">▶ Resume</button>'
        + '<button class="ghost" id="sv-cancel">Cancel</button></div></div>';
      $('sv-resume').onclick = function () { resumeSession(tabFor(sid)); };
      $('sv-cancel').onclick = function () { closeTab(sid); };
    } else if (want === 'resume-gone') {
      body.innerHTML = '<div class="banner"><div class="bt">' + esc(st.notice || "Can't resume — this worker is gone.") + '</div>'
        + '<div class="actions">'
        + (t.missionId ? '<button class="primary" id="sv-fresh" title="Clear the mission binding so the controller spawns a fresh worker">↻ Start fresh worker</button>' : '')
        + '<button class="ghost" id="sv-close2">✕ Close tab</button></div></div>';
      if ($('sv-fresh')) $('sv-fresh').onclick = function () {
        patchMission(t.missionId, { binding: null }, 'clearing binding of').then(function () { closeTab(sid); });
      };
      $('sv-close2').onclick = function () { closeTab(sid); };
    } else if (want === 'resume-conflict') {
      body.innerHTML = '<div class="banner warnb"><div class="bt">'
        + esc(st.notice || "This session is live elsewhere and can't be safely resumed.") + '</div>'
        + '<div class="actions"><button class="ghost" id="sv-close2">✕ Close tab</button></div></div>';
      $('sv-close2').onclick = function () { closeTab(sid); };
    } else {
      body.innerHTML = '<div class="banner"><div class="bt">' + esc(st.notice || 'Session ended — cannot resume.') + '</div>'
        + '<div class="actions"><button class="ghost" id="sv-close2">✕ Close tab</button></div></div>';
      $('sv-close2').onclick = function () { closeTab(sid); };
    }
    paintTabs();
    reportHeight();
  }

  function setSess(sid, st) { state.sessState[sid] = st; if (state.view.id === sid) paintSessionView(); else paintTabs(); }

  /** Liveness check → cloud auto-resume / native confirm-resume, exactly as the old page. */
  function checkSession(t) {
    if (!t) return;
    var sid = t.id;
    setSess(sid, { alive: 'checking' });
    var qs = t.node ? '?node=' + encodeURIComponent(t.node) : '';
    api('node', '/mission/session/' + encodeURIComponent(sid) + '/status' + qs).then(function (r) {
      // If the status check itself fails, assume alive rather than blocking the user.
      if (!r.ok) { setSess(sid, { alive: 'alive', notice: 'status check failed (' + fail(r) + ') — showing the transcript anyway' }); return; }
      var d = r.data || {};
      var transport = d.transport || t.transport;
      t.transport = transport;
      if (d.alive) { setSess(sid, { alive: 'alive' }); return; }
      if (transport === 'cloud') { resumeSession(t); return; }   // cloud auto-resumes
      setSess(sid, { alive: 'confirm-resume' });                 // native asks first
    });
  }

  function resumeSession(t) {
    var sid = t.id;
    setSess(sid, { alive: 'resuming' });
    var body = {};
    if (t.missionId) body.missionId = t.missionId;
    if (t.node) body.node = t.node;
    api('node', '/mission/session/' + encodeURIComponent(sid) + '/resume', { method: 'POST', body: body })
      .then(function (r) {
        if (!r.ok) { setSess(sid, { alive: 'gone', notice: 'Resume failed — ' + fail(r) }); return; }
        var d = r.data || {};
        if (d.reason === 'gone') setSess(sid, { alive: 'resume-gone', notice: "Can't resume — this worker is gone." });
        else if (d.reason === 'conflict') setSess(sid, { alive: 'resume-conflict', notice: "This session is live elsewhere and can't be safely resumed." });
        else if (d.resumed) setSess(sid, { alive: 'alive',
          notice: d.autoCloseAt ? 'Session resumed — auto-closes after 30 min idle.' : null });
        else setSess(sid, { alive: 'gone', notice: 'Session ended — cannot resume.' });
      });
  }

  /** Session control. `stop` on the user's OWN onboarded session is refused server-side with
   *  ONBOARDED_PROTECTED unless force:true comes from a human — confirm and retry rather than
   *  silently dropping the click (the old page's I4(b) fix). */
  function sessControl(sid, node, action, force) {
    var body = { action: action };
    if (node) body.node = node;
    if (force) body.force = true;
    say(action + ' ' + shortId(sid) + '…');
    api('node', '/mission/session/' + encodeURIComponent(sid) + '/control', { method: 'POST', body: body })
      .then(function (r) {
        if (!r.ok) {
          if (action === 'stop' && !force && /ONBOARDED_PROTECTED/.test(r.error.code + ' ' + r.error.message)) {
            if (window.confirm("This is the user's own onboarded session. Force stop?")) sessControl(sid, node, action, true);
            else say('stop cancelled');
            return;
          }
          say(action + ' failed — ' + fail(r), true);
          return;
        }
        say(action + ' sent to ' + shortId(sid));
        if (state.view.kind === 'session' && state.view.id === sid) setTimeout(function () { checkSession(tabFor(sid)); }, 1500);
      });
  }

  // ── all sessions (fleet operability) ──────────────────────────────────────
  function loadAllSessions() {
    return api('node', '/mission/sessions').then(function (r) {
      state.allSessions = (r.ok && r.data && Array.isArray(r.data.sessions)) ? r.data.sessions : [];
      if (!r.ok) say('session list failed — ' + fail(r), true);
      paintAllSessions();
    });
  }
  function paintAllSessions() {
    var el = $('allsess'); if (!el) return;
    el.hidden = !state.allSessionsOpen;
    if (!state.allSessionsOpen) return;
    var rows = state.allSessions;
    el.innerHTML = '<div class="asbar"><b>' + rows.length + '</b> operable session'
      + (rows.length === 1 ? '' : 's') + '<span class="spacer"></span>'
      + '<button class="ghost xs" id="as-refresh">Refresh</button></div>'
      + (rows.length ? rows.map(function (s) {
          return '<div class="asrow">'
            + '<button class="ghost srowbtn" data-sess="' + esc(s.sid) + '" data-missionid="' + esc(s.missionId || '')
            + '" title="Open this session in a tab">'
            + (s.transport === 'cloud' ? '☁' : '▣')
            + ' <span class="pill ' + (s.role === 'controller' ? 'st-active' : 'kind') + '">' + esc(s.role) + '</span>'
            + '<span class="mono grow1">' + esc(shortId(s.sid)) + '</span>'
            + '<span class="dim">' + esc(s.transport) + (s.status ? ' · ' + esc(s.status) : '') + '</span></button>'
            + '<button class="ghost xs" data-sctl="interrupt" data-sid="' + esc(s.sid) + '" title="Interrupt the current action (session stays live)">⏸</button>'
            + '<button class="ghost xs" data-sctl="stop" data-sid="' + esc(s.sid) + '" title="Stop this session">■</button>'
            + (s.role === 'controller' ? '<button class="ghost xs" data-sctl="restart" data-sid="' + esc(s.sid)
                + '" title="Restart — the supervisor relaunches (resumes the same session)">↻</button>' : '')
            + '</div>';
        }).join('') : '<div class="empty-list">No active sessions.</div>');
    $('as-refresh').onclick = loadAllSessions;
    reportHeight();
  }

  // ── stage bindings (rebound after every renderStage) ──────────────────────
  function bindStage() {
    if (state.view.kind === 'controller') {
      $('btn-tick').onclick = runTick;
      $('btn-trace').onclick = function () {
        state.traceOpen = !state.traceOpen;
        this.classList.toggle('on', state.traceOpen);
        paintTrace();
        if (state.traceOpen) loadTrace();
      };
      $('ctl-action').onchange = function () { var v = this.value; this.value = ''; ctlControl(v); };
      $('ctl-body').dataset.mode = '';
      refreshControllerView();
      paintTrace();
    } else if (state.view.kind === 'mission') {
      $('md-back').onclick = function () { setView('controller', null); };
      $('md-graph').onclick = function () { gotoGraph(state.view.id); };
      $('md-procs').onclick = function () { gotoProcesses(state.view.id); };
      $('md-save').onclick = saveDetail;
      // These inputs are re-created by renderStage, so binding them here is not cumulative.
      // (The delegated #stage listener is attached ONCE at boot — #stage itself is never
      // replaced, so binding it here would stack a new handler on every visit to this view.)
      ['md-f-title', 'md-f-objective', 'md-f-plan', 'md-f-next'].forEach(function (id) {
        $(id).addEventListener('input', readDraftFromDom);
      });
      if (state.detail) paintDetail();
      paintDetailSessions();
    } else if (state.view.kind === 'session') {
      $('sv-close').onclick = function () { closeTab(state.view.id); };
      $('sv-action').onchange = function () {
        var v = this.value; this.value = '';
        var t = tabFor(state.view.id) || {};
        if (v) sessControl(state.view.id, t.node, v);
      };
      $('sv-body').dataset.mode = '';
      paintSessionView();
    }
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  // #stage is a PERSISTENT element (renderStage only replaces its innerHTML), so its
  // delegated listener is attached exactly once here and dispatches on the current view.
  $('stage').addEventListener('click', function (e) {
    if (state.view.kind !== 'mission') return;
    var b = e.target.closest ? e.target.closest('[data-mdstatus]') : null;
    if (b) { patchMission(state.view.id, { status: b.dataset.mdstatus }, 'set status of').then(loadDetail); return; }
    // Audit paging is pure view state — repaint from what is already loaded, no refetch.
    if (e.target.closest && e.target.closest('[data-auditmore]')) {
      state.auditShown = (state.auditShown || AUDIT_PAGE) + AUDIT_PAGE; paintDetail(); return;
    }
    if (e.target.closest && e.target.closest('[data-auditless]')) {
      state.auditShown = AUDIT_PAGE; paintDetail(); return;
    }
    var s = e.target.closest ? e.target.closest('[data-sess]') : null;
    if (s) {
      var m = state.detail || {};
      openSessionTab(s.dataset.sess, shortId(s.dataset.sess),
        (m.binding && m.binding.node) || m.ownerNode || null, m.id || null);
    }
  });

  $('tabs').addEventListener('click', function (e) {
    var x = e.target.closest ? e.target.closest('[data-close]') : null;
    if (x) { closeTab(x.dataset.close); return; }
    var b = e.target.closest ? e.target.closest('[data-tab]') : null;
    if (!b) return;
    var id = b.dataset.tab;
    if (!id) { setView('controller', null); return; }
    var t = tabFor(id);
    if (t) setView(t.kind, id);
  });

  $('list').addEventListener('click', function (e) {
    var t = e.target;
    var open = t.closest ? t.closest('[data-open]') : null;
    if (open) {
      var mid = open.dataset.open;
      var m = state.missions.filter(function (x) { return x.id === mid; })[0];
      openMissionTab(mid, m ? m.title : mid);
      return;
    }
    var g = t.closest ? t.closest('[data-graph]') : null;
    if (g) { gotoGraph(g.dataset.graph); return; }
    var act = t.closest ? t.closest('[data-act]') : null;
    if (act) { patchMission(act.dataset.mid, { status: act.dataset.act }, 'set status of'); return; }
    var sv = t.closest ? t.closest('[data-objsave]') : null;
    if (sv) {
      var id = sv.dataset.objsave, val = state.objDraft[id];
      patchMission(id, { objective: val }, 'saving objective of').then(function () { clearObjRow(id); });
      return;
    }
    var dr = t.closest ? t.closest('[data-objdrop]') : null;
    if (dr) clearObjRow(dr.dataset.objdrop);
  });

  /** Drop a row's objective draft and put the row back in sync with the server value.
   *  Done by direct DOM edit, NOT by paintList alone: the repaint is suppressed while a
   *  textarea in the list holds focus, and Save/Discard must take effect regardless.
   *  Rows are matched by comparing dataset (never an attribute selector built from an id). */
  function clearObjRow(id) {
    delete state.objDraft[id];
    var m = state.missions.filter(function (x) { return x.id === id; })[0];
    var tas = $('list').querySelectorAll('[data-obj]');
    for (var i = 0; i < tas.length; i++) {
      if (tas[i].dataset.obj !== id) continue;
      if (m) tas[i].value = m.objective || '';
      var acts = tas[i].parentElement && tas[i].parentElement.querySelector('.objacts');
      if (acts) acts.remove();
    }
    paintList();
  }
  $('list').addEventListener('input', function (e) {
    if (!e.target.dataset || !e.target.dataset.obj) return;
    state.objDraft[e.target.dataset.obj] = e.target.value;
    var row = e.target.closest('.row');
    // Show/hide Save+Discard without repainting the textarea the user is typing in.
    var m = state.missions.filter(function (x) { return x.id === e.target.dataset.obj; })[0];
    var dirty = m && e.target.value !== (m.objective || '');
    var acts = row.querySelector('.objacts');
    if (dirty && !acts) {
      var d = document.createElement('div');
      d.className = 'objacts';
      d.innerHTML = '<button class="primary xs" data-objsave="' + esc(e.target.dataset.obj) + '">Save</button>'
        + '<button class="ghost xs" data-objdrop="' + esc(e.target.dataset.obj) + '">Discard</button>';
      e.target.insertAdjacentElement('afterend', d);
    } else if (!dirty && acts) acts.remove();
  });

  $('allsess').addEventListener('click', function (e) {
    var c = e.target.closest ? e.target.closest('[data-sctl]') : null;
    if (c) { sessControl(c.dataset.sid, null, c.dataset.sctl); return; }
    var s = e.target.closest ? e.target.closest('[data-sess]') : null;
    if (s) openSessionTab(s.dataset.sess, shortId(s.dataset.sess), null, s.dataset.missionid || null);
  });

  $('q').addEventListener('input', function (e) { state.filter.q = e.target.value; state.page = PAGE_SIZE; paintList(); });
  $('f-status').addEventListener('change', function (e) { state.filter.status = e.target.value; state.page = PAGE_SIZE; paintList(); });
  $('f-transport').addEventListener('change', function (e) { state.filter.transport = e.target.value; state.page = PAGE_SIZE; paintList(); });
  $('f-recency').addEventListener('change', function (e) { state.filter.recency = e.target.value; state.page = PAGE_SIZE; paintList(); });
  $('more').addEventListener('click', function () { state.page += PAGE_SIZE; paintList(); });

  $('btn-refresh').onclick = refreshAll;
  $('btn-graph').onclick = function () { gotoGraph(state.view.kind === 'mission' ? state.view.id : null); };
  $('btn-procs').onclick = function () { gotoProcesses(state.view.kind === 'mission' ? state.view.id : null); };
  $('btn-side').onclick = function () {
    state.sideOpen = !state.sideOpen;
    $('side').hidden = !state.sideOpen;
    this.textContent = state.sideOpen ? 'Missions ▸' : 'Missions ◂';
    reportHeight();
  };
  $('allsess-toggle').onclick = function () {
    state.allSessionsOpen = !state.allSessionsOpen;
    this.textContent = (state.allSessionsOpen ? '▾' : '▸') + ' All sessions';
    paintAllSessions();
    if (state.allSessionsOpen) loadAllSessions();
  };
  $('create-toggle').onclick = function () {
    state.createOpen = !state.createOpen;
    $('create').hidden = !state.createOpen;
    this.textContent = state.createOpen ? '✕ Cancel new mission' : '+ New mission';
    if (state.createOpen && !state.repos.length) loadRepos();
    reportHeight();
  };
  $('c-submit').onclick = submitCreate;
  $('c-repo').addEventListener('change', function () {
    var v = this.value;
    $('c-repo-text-wrap').hidden = v !== '__custom__';
    if (v === '__custom__') { loadBranches(''); return; }
    loadBranches(v);
  });
  $('c-branch').addEventListener('change', function () { $('c-branch-text-wrap').hidden = this.value !== '__custom__'; });

  // Who is signed in (identity rides the session, not the view token).
  fetch('/auth/me', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
    $('who-name').textContent = (d.claims && (d.claims.name || d.claims.email)) || d.userId || 'signed in';
  }).catch(function () { $('who-name').textContent = 'signed in'; });

  // ── boot ──────────────────────────────────────────────────────────────────
  fillSelect($('f-status'), STATUS_OPTIONS, '');
  fillSelect($('f-transport'), TRANSPORT_OPTIONS, '');
  fillSelect($('f-recency'), RECENCY_OPTIONS, '');
  fillSelect($('c-isolation'), ISOLATIONS.map(function (v) { return [v, v]; }), 'cloud');
  fillSelect($('c-repo'), [['', '— none —'], ['__custom__', '— type it —']], '');
  fillSelect($('c-branch'), [['', '— none —'], ['__custom__', '— type it —']], '');
  paintTabs();
  renderStage();

  // ── INBOUND params — the read half of the pinned vocabulary ────────────────────────────
  // This pane accepts exactly four, and lands on each one:
  //   mission=<id>   open that mission's DETAIL view (a tab of this pane, no page reload)
  //   session=<sid>  open that session's view (liveness → resume → chat)
  //   q=<text>       prefill the sidebar search box, applied to the very first paint
  //   tab=controller the only named sub-view that is not already addressed by an entity param
  // Precedence: an entity param wins over `tab` — `mission=` names something concrete to show,
  // `tab=` only names where to look. `q` is orthogonal and applies in every case.
  // Anything else is IGNORED ON PURPOSE (no guessing at a sibling's private spelling): a param
  // that is not in the vocabulary is a bug in the CALLER, and silently honouring an off-list
  // name is how the four-spellings mess happened.
  var params = new URLSearchParams(location.search);
  var deepMission = params.get('mission');
  var deepSession = params.get('session');
  var deepTab = params.get('tab');
  var deepQ = params.get('q');

  // Applied BEFORE the first load so the opening paint is already the filtered list — setting
  // it afterwards would flash the full list and then reflow.
  if (deepQ) { state.filter.q = deepQ; $('q').value = deepQ; }

  loadMissions().then(function () {
    if (deepMission) {
      var m = state.missions.filter(function (x) { return x.id === deepMission; })[0];
      openMissionTab(deepMission, m ? m.title : deepMission);
    } else if (deepSession) {
      openSessionTab(deepSession, shortId(deepSession), null, null);
    } else if (deepTab === 'controller') {
      setView('controller', null);      // already the default view; explicit for a caller that says so
    }
  });
  loadController();
  // One poller for the whole pane: the mission list, the controller and the active view.
  // (The chat has its own 4 s poller; the trace refreshes on its own 10 s cadence.)
  state.poller = setInterval(function () {
    loadMissions();
    loadController();
    if (state.view.kind === 'mission') { loadDetail(); loadDetailSessions(); }
    if (state.allSessionsOpen) loadAllSessions();
  }, 5000);
  setInterval(function () { if (state.traceOpen) loadTrace(); }, 10000);
})();
