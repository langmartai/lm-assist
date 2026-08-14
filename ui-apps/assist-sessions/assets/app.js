/* assist-sessions — the Claude Code session browser as a scoped pane. Plain JS, no build, no deps.
 * Ported from web/src/components/sessions/{SessionBrowser,SessionSidebar,SessionDetail}.tsx.
 *
 * Every data call goes through the injected SDK helper (lmui.call), which carries the view
 * token and re-mints it on 401/403. Four GET-only leaf rules, and nothing else it can reach
 * (see lmui.config.json — the wildcard segment is spelled "<*>" here only because a literal
 * star-slash would close this comment):
 *   node:/projects                  [GET] exact  project list (filter dropdown + path→key map)
 *   node:/projects/sessions         [GET] exact  session list across all projects (process-enriched)
 *   node:/projects/<*>/sessions     [GET] exact  complete session list for ONE project
 *   node:/sessions/<*>              [GET] exact  one session's detail
 *
 * 🔴 NOT ported: the Console tab and every live-stream surface (ttyd/WebSocket, the SSE-backed
 * batch poll loop). Streaming across the pane data plane is a separate, still-blocked backlog
 * item — see README. Refresh here is a manual GET, never a socket.
 *
 * Shapes are read off core/src/routes/core/{sessions,session-projects}.routes.ts and were
 * confirmed against a live :3200 before this file was written — bare array vs wrapper object
 * varies per route (all four of these wrap in {success,data,meta}).                          */
(function () {
  'use strict';

  // ── caps (every one of these is surfaced in the UI, never applied silently) ──
  var FETCH_PAGE = 300;    // server-side `limit` on the all-projects list; grows by this step
  var ROW_PAGE = 50;       // rows painted at once; grows by 100 like the source page
  var DEFAULT_PROMPTS = 25; // `lastNUserPrompts` on the detail fetch (route default is 50)
  var PROMPT_STEPS = [10, 25, 50, 100, 200];
  var JSON_CAP = 240000;   // chars of pretty-printed detail the JSON tab will paint

  var TABS = [
    ['chat', 'Chat'], ['thinking', 'Thinking'], ['tools', 'Tools'], ['files', 'Files'],
    ['git', 'Git'], ['db', 'DB'], ['tasks', 'Tasks'], ['agents', 'Agents'],
    ['team', 'Team'], ['meta', 'Meta'], ['json', 'JSON'],
  ];

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
  // Server-data-keyed lookups must not fall through to Object.prototype.
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ── data plane ────────────────────────────────────────────────────────────
  // lmui.call returns the raw fetch Response. The hub relay wraps the node's own
  // {success,data,meta} envelope in an outer {status,data}; the local tier passes the
  // node envelope through directly. Strip the outer layer when present so this pane runs
  // unchanged under BOTH tiers, then normalize to {ok,status,data,error}. A non-node
  // failure (grant denial, non-JSON) surfaces its real text — nothing is swallowed.
  function api(service, path, opts) {
    return lmui.call(service, path, opts).then(function (r) {
      return r.text().then(function (txt) {
        var b = null;
        try { b = txt ? JSON.parse(txt) : null; } catch (e) { b = null; }
        var relayed = b && b.data !== undefined && b.status !== undefined;
        var env = relayed ? b.data : b;
        var status = relayed ? b.status : r.status;
        if (env && env.success === true) return { ok: true, status: status, data: env.data };
        var msg = (env && env.error && env.error.message) || (env && env.message)
          || (txt ? txt.slice(0, 600) : ('HTTP ' + status));
        var code = (env && env.error && env.error.code) || ('HTTP_' + status);
        return { ok: false, status: status, error: { code: code, message: msg } };
      });
    }).catch(function (e) {
      return { ok: false, status: 0, error: { code: 'NETWORK', message: String(e && e.message || e) } };
    });
  }

  // ── formatting (mirrors web/src/lib/utils.ts + types.ts) ──────────────────
  function ago(t) {
    var then = new Date(t).getTime();
    if (!isFinite(then)) return '—';
    var s = Math.floor((Date.now() - then) / 1000);
    if (s < 0) return 'just now';
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
    var d = Math.floor(h / 24); if (d < 30) return d + 'd ago';
    return new Date(t).toLocaleDateString();
  }
  function fmtBytes(b) {
    if (!b) return '0 B';
    var k = 1024, u = ['B', 'KB', 'MB', 'GB'], i = Math.floor(Math.log(b) / Math.log(k));
    i = Math.max(0, Math.min(i, u.length - 1));
    return parseFloat((b / Math.pow(k, i)).toFixed(1)) + ' ' + u[i];
  }
  function fmtCost(c) { return '$' + Number(c || 0).toFixed(2); }
  function fmtNum(n) { return String(n == null ? 0 : n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function modelShort(model) {
    if (!model) return 'claude';
    var m = String(model).toLowerCase();
    if (m.indexOf('opus-4-5') >= 0) return 'Opus 4.5';
    if (m.indexOf('opus-4') >= 0) return 'Opus 4';
    if (m.indexOf('sonnet-4') >= 0) return 'Sonnet 4';
    if (m.indexOf('sonnet-3-5') >= 0 || m.indexOf('sonnet-3.5') >= 0) return 'Sonnet 3.5';
    if (m.indexOf('sonnet') >= 0) return 'Sonnet';
    if (m.indexOf('haiku-3-5') >= 0 || m.indexOf('haiku-3.5') >= 0) return 'Haiku 3.5';
    if (m.indexOf('haiku') >= 0) return 'Haiku';
    if (m.indexOf('opus') >= 0) return 'Opus';
    return String(model).replace(/[-_]\d{8}$/, '').replace(/^claude-/, '');
  }
  function shortSid(id) { return String(id || '').slice(0, 8); }
  // customTitle > displayName > slug (getSessionDisplayName); XML tags stripped from forks.
  function displayName(s) {
    if (!s) return null;
    if (s.customTitle) {
      var c = String(s.customTitle).replace(/<[^>]+>/g, '').replace(/\s*\(Fork\)\s*$/, '').trim();
      return c || null;
    }
    if (s.displayName) return s.displayName;
    return s.slug || null;
  }
  function isManaged(by) { return by === 'ttyd' || by === 'ttyd-tmux' || by === 'wrapper'; }
  function managedLabel(by) {
    return by === 'ttyd' ? 'ttyd' : by === 'ttyd-tmux' ? 'tmux' : by === 'wrapper' ? 'managed'
      : by === 'unmanaged-terminal' ? 'terminal' : by === 'unmanaged-tmux' ? 'ext-tmux' : 'external';
  }
  function baseName(p) {
    if (!p) return '';
    var parts = String(p).replace(/[\/\\]+$/, '').split(/[\/\\]/);
    return parts[parts.length - 1] || String(p);
  }
  function looksLikePath(v) { return /[\/\\]/.test(String(v || '')); }
  // A command-only session (isCommandSession in web/src/hooks/useSessions.ts — keep the two
  // in step; this pane is a port of that hook, and the bug below shipped in BOTH).
  //
  // 🔴 The predicate used to anchor on '<command-message>' and could therefore never match.
  // Claude Code writes a slash-command turn as a THREE-tag envelope and '<command-name>' is
  // always the FIRST tag:
  //     <command-name>/model</command-name>
  //     <command-message>model</command-message>
  //     <command-args>opus</command-args>
  // Measured over this node's COMPLETE list (GET /projects/sessions, 6584 of 6584 sessions,
  // no truncation): startsWith('<command-message>') → 0 matches; startsWith('<command-name>')
  // → 6; contains-either → 6, and all 6 contain BOTH tags. There is not one session in the
  // corpus where '<command-message>' comes first, so the old chip toggled its class and
  // changed the list by exactly nothing.
  //
  // Anchored at the start rather than a contains-check on purpose: a contains-check would
  // also match a human message that merely QUOTES the envelope (a bug report pasting these
  // very tags is the obvious case), and "command-only session" is a claim about the shape of
  // the whole message, not about a substring appearing somewhere in it. On this corpus both
  // forms return the same 6 rows, so the anchor costs no recall and removes the false
  // positive.
  function isCommandSession(s) {
    return !!s.lastUserMessage && String(s.lastUserMessage).replace(/^\s+/, '').indexOf('<command-name>') === 0;
  }

  // ── inbound params — the PINNED cross-pane vocabulary ─────────────────────
  // Read on load from location.search and landed on. `id` is a legacy alias for `session`
  // that assist-skills still emits; `parent` is a non-pinned hint the same caller sends.
  var QP = new URLSearchParams(location.search);
  var IN = {
    session: QP.get('session') || QP.get('id') || '',
    project: QP.get('project') || '',
    parent: QP.get('parent') || '',
    tab: QP.get('tab') || '',
    q: QP.get('q') || '',
  };

  // ── state ────────────────────────────────────────────────────────────────
  var state = {
    sessions: [],          // rows currently loaded (global slice OR one project's full list)
    total: 0,              // total on the node for the current source
    fetched: 0,            // how many the last fetch returned
    source: 'all',         // 'all' | 'project'
    projectKey: '',        // encodedPath when source==='project'
    projectPath: '',       // human path when source==='project'
    limit: FETCH_PAGE,     // server-side limit in 'all' mode; 0 = unlimited
    projects: [],          // GET /projects
    projectsState: 'loading', // loading | ready | error
    rows: ROW_PAGE,
    filter: { q: IN.q, project: '', time: 'all', running: false, cmds: true },
    selected: null,        // full detail object
    selectedId: IN.session || '',
    detailState: 'idle',   // idle | loading | error | ready
    detailError: '',
    notInList: false,      // the open session is not in the loaded list (deep link / agent)
    prompts: DEFAULT_PROMPTS,
    tab: '',
    listState: 'loading',  // loading | ready | error
    listError: '',
    pendingProject: IN.project, // resolved once GET /projects lands
  };
  state.tab = (function () {
    for (var i = 0; i < TABS.length; i++) if (TABS[i][0] === IN.tab) return IN.tab;
    return 'chat';
  })();
  if (IN.q) $('q').value = IN.q;

  function note(msg, kind) {
    var el = $('load-note');
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.className = 'load-note' + (kind ? ' ' + kind : '');
    el.textContent = msg;
  }

  // ── list: filtering (mirrors useSessions.ts filteredSessions) ─────────────
  function visible() {
    var f = state.filter, q = f.q.trim().toLowerCase();
    var cutoff = 0;
    if (f.time !== 'all') {
      var days = f.time === 'today' ? 1 : f.time === 'week' ? 7 : 30;
      cutoff = Date.now() - days * 86400000;
    }
    return state.sessions.filter(function (s) {
      if (f.running && !(s.isRunning || s.running || s.isActive)) return false;
      if (!f.cmds && isCommandSession(s)) return false;
      // In 'project' mode the server already scoped the list; this covers 'all' mode and
      // the ambiguous-basename fallback.
      if (f.project && state.source !== 'project') {
        var want = f.project;
        if (looksLikePath(want) ? s.projectPath !== want : baseName(s.projectPath) !== want) return false;
      }
      if (cutoff && new Date(s.lastModified).getTime() < cutoff) return false;
      if (q) {
        var hay = (s.sessionId + ' ' + (s.projectPath || '') + ' ' + (displayName(s) || '') + ' '
          + (s.sessionSummary || '') + ' ' + (s.lastUserMessage || '')).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
  }

  function rowHtml(s) {
    var sel = state.selectedId === s.sessionId ? ' sel' : '';
    var name = displayName(s);
    var run = s.running || null;
    var head = '';
    if (s.isRunning || s.isActive) head += '<span class="dot-run"></span>';
    if (run) {
      head += '<span class="pill ' + (isManaged(run.managedBy) ? 'run-ok' : 'run-ext') + '">'
        + esc(managedLabel(run.managedBy)) + '</span>';
    }
    head += '<span class="rt">' + esc(name || baseName(s.projectPath) || s.sessionId) + '</span>';
    head += name
      ? '<span class="rid">' + esc(baseName(s.projectPath)) + '</span>'
      : '<span class="rid">' + esc(shortSid(s.sessionId)) + '</span>';

    var prev = s.sessionSummary || s.lastUserMessage || '';
    var meta = '<span class="rid">' + esc(ago(s.lastModified)) + '</span>';
    if (s.model) meta += '<span class="pill">' + esc(modelShort(s.model)) + '</span>';
    if (s.numTurns != null) meta += '<span class="rid">T:' + esc(s.numTurns) + '</span>';
    if (s.userPromptCount) meta += '<span class="rid">' + esc(s.userPromptCount) + 'p</span>';
    if (s.taskCount) meta += '<span class="rid">' + esc(s.taskCount) + ' tasks</span>';
    if (s.agentCount) meta += '<span class="rid">' + esc(s.agentCount) + ' agents</span>';
    if (s.fileSize || s.size) meta += '<span class="rid">' + esc(fmtBytes(s.fileSize || s.size)) + '</span>';
    if (s.totalCostUsd) meta += '<span class="cost">' + esc(fmtCost(s.totalCostUsd)) + '</span>';

    return '<div class="row' + sel + '" data-sid="' + esc(s.sessionId) + '">'
      + '<div class="rhead">' + head + '</div>'
      + (prev ? '<div class="rprev">' + esc(prev) + '</div>' : '')
      + '<div class="rmeta">' + meta + '</div></div>';
  }

  function paintList() {
    var el = $('list');
    if (state.listState === 'loading') { el.innerHTML = '<div class="empty-list">loading sessions…</div>'; paintCounts(); return; }
    if (state.listState === 'error') {
      el.innerHTML = '<div class="empty-list err">' + esc(state.listError) + '</div>';
      paintCounts(); return;
    }
    var vis = visible();
    var shown = vis.slice(0, state.rows);
    el.innerHTML = shown.length
      ? shown.map(rowHtml).join('')
      : '<div class="empty-list">' + (state.sessions.length
        ? 'No loaded session matches the current filter.'
        : 'No sessions on this node.') + '</div>';
    paintCounts(vis.length);
    reportHeight();
  }

  function paintCounts(visN) {
    if (visN === undefined) visN = visible().length;
    var el = $('counts');
    if (state.listState === 'loading') { el.textContent = 'loading…'; return; }
    var shown = Math.min(visN, state.rows);
    var txt;
    if (state.source === 'project') {
      txt = 'showing ' + fmtNum(shown) + ' of ' + fmtNum(visN) + ' matching · loaded ALL '
        + fmtNum(state.sessions.length) + ' session' + (state.sessions.length === 1 ? '' : 's')
        + ' in ' + baseName(state.projectPath);
    } else {
      var capped = state.limit > 0 && state.total > state.sessions.length;
      txt = 'showing ' + fmtNum(shown) + ' of ' + fmtNum(visN) + ' matching · loaded '
        + (capped ? 'newest ' : 'ALL ') + fmtNum(state.sessions.length)
        + ' of ' + fmtNum(state.total) + ' on this node';
      if (capped) txt += ' — CAPPED, older sessions are not loaded';
    }
    el.textContent = txt;
    $('btn-more-rows').hidden = visN <= state.rows;
    $('btn-more-rows').textContent = 'show +100 rows (' + fmtNum(visN - shown) + ' hidden)';
    var canFetchMore = state.source === 'all' && state.limit > 0 && state.total > state.sessions.length;
    $('btn-fetch-more').hidden = !canFetchMore;
    $('btn-fetch-more').textContent = 'fetch ' + FETCH_PAGE + ' more';
    $('btn-fetch-all').hidden = !canFetchMore;
    $('btn-fetch-all').textContent = 'fetch all ' + fmtNum(state.total);
  }

  // ── list: loading ────────────────────────────────────────────────────────
  function loadList() {
    state.listState = 'loading';
    paintList();
    var path;
    if (state.source === 'project' && state.projectKey) {
      // The per-project route takes no `limit` — it returns that project's COMPLETE list.
      path = '/projects/' + encodeURIComponent(state.projectKey) + '/sessions';
    } else {
      path = '/projects/sessions' + (state.limit > 0 ? '?limit=' + state.limit : '');
    }
    return api('node', path).then(function (r) {
      if (!r.ok) {
        state.listState = 'error';
        state.listError = r.error.code + ': ' + r.error.message;
        paintList();
        return;
      }
      var d = r.data || {};
      state.sessions = d.sessions || [];
      state.fetched = state.sessions.length;
      state.total = d.total != null ? d.total : state.sessions.length;
      state.listState = 'ready';
      if (state.source === 'project') {
        state.projectPath = d.projectPath || state.projectPath;
        // 🔴 Honest gap: /projects/:key/sessions is NOT process-enriched (no `running`
        // object, no isRunning) — only /projects/sessions is. Say so rather than showing
        // an empty badge column that reads as "nothing is running".
        note('Project view: live process badges (pid / ttyd / tmux) are unavailable here — the '
          + 'per-project route is not process-enriched. The activity dot still reflects isActive.', 'warn');
      } else {
        note('');
      }
      // A deep-linked session that is not in this slice still opens; flag it in the detail.
      state.notInList = !!state.selectedId && !state.sessions.some(function (s) { return s.sessionId === state.selectedId; });
      state.rows = ROW_PAGE;
      paintList();
      if (state.selected) paintDetail();
    });
  }

  function loadProjects() {
    return api('node', '/projects').then(function (r) {
      if (!r.ok) {
        state.projectsState = 'error';
        var o = $('f-project');
        o.innerHTML = '<option value="">All projects (list unavailable: ' + esc(r.error.code) + ')</option>';
        resolvePendingProject();
        return;
      }
      var d = r.data || {};
      state.projects = (d.projects || []).slice().sort(function (a, b) {
        return (b.sessionCount || 0) - (a.sessionCount || 0);
      });
      state.projectsState = 'ready';
      paintProjectSelect();
      resolvePendingProject();
    });
  }

  function paintProjectSelect() {
    var cur = state.filter.project;
    var html = ['<option value="">All projects (' + state.projects.length + ')</option>'];
    state.projects.forEach(function (p) {
      var path = p.path || '';
      html.push('<option value="' + esc(path) + '"' + (path === cur ? ' selected' : '') + '>'
        + esc(baseName(path)) + ' · ' + esc(p.sessionCount || 0) + '</option>');
    });
    $('f-project').innerHTML = html.join('');
  }

  // Resolve an inbound `project` (pinned: a project PATH; today's assist-projects still
  // sends a basename, so accept both) against the loaded project list, then switch the
  // list source to that project's complete session list.
  function resolvePendingProject() {
    var want = state.pendingProject;
    state.pendingProject = '';
    if (!want) return;
    var norm = String(want).replace(/[\/\\]+$/, '');
    var matches = state.projects.filter(function (p) {
      return looksLikePath(norm) ? (p.path || '').replace(/[\/\\]+$/, '') === norm
        : baseName(p.path) === norm;
    });
    if (matches.length === 1) {
      selectProject(matches[0].path, matches[0].encodedPath);
      return;
    }
    // Ambiguous or unknown: keep the all-projects list and filter client-side, and SAY so —
    // a filter that silently matched nothing would look like an empty node.
    state.filter.project = norm;
    paintProjectSelect();
    if (matches.length === 0) {
      note('Inbound project "' + norm + '" matched no project on this node — showing all projects, '
        + 'filtered client-side (it may simply have no sessions).', 'warn');
    } else {
      note('Inbound project "' + norm + '" matched ' + matches.length + ' projects — showing the '
        + 'all-projects list filtered by name instead of one project’s complete list.', 'warn');
    }
    paintList();
  }

  function selectProject(path, key) {
    if (!path) {
      state.source = 'all'; state.projectKey = ''; state.projectPath = '';
      state.filter.project = ''; state.limit = FETCH_PAGE;
    } else {
      if (!key) {
        var hit = state.projects.filter(function (p) { return p.path === path; })[0];
        key = hit && hit.encodedPath;
      }
      if (!key) { // no encoded key → fall back to client-side filtering on the global list
        state.source = 'all'; state.projectKey = ''; state.filter.project = path;
        paintProjectSelect(); paintList(); return;
      }
      state.source = 'project'; state.projectKey = key; state.projectPath = path;
      state.filter.project = path;
    }
    paintProjectSelect();
    loadList();
  }

  // ── detail ───────────────────────────────────────────────────────────────
  function openSession(sid) {
    if (!sid) return Promise.resolve();
    state.selectedId = sid;
    state.detailState = 'loading';
    paintList();
    paintDetail();
    // includeToolResults/includeSystemMessages are the COMPACT chat extras (server-capped,
    // window-filtered): measured 748KB vs 7.8MB for includeRawMessages on a 2707-turn
    // session at the default window. Never switch this to includeRawMessages.
    return api('node', '/sessions/' + encodeURIComponent(sid) + '?lastNUserPrompts=' + state.prompts
      + '&includeToolResults=true&includeSystemMessages=true')
      .then(function (r) {
        if (state.selectedId !== sid) return;           // a newer click won
        if (!r.ok) {
          state.detailState = 'error';
          state.detailError = r.error.code + ': ' + r.error.message;
          state.selected = null;
          paintDetail();
          return;
        }
        state.selected = r.data || null;
        state.detailState = 'ready';
        state.notInList = !state.sessions.some(function (s) { return s.sessionId === sid; });
        paintDetail();
        paintList();
      });
  }

  function statusBadge(d) {
    if (!d) return '';
    if (d.isActive) return '<span class="pill st-run">Running</span>';
    if (d.status === 'error') return '<span class="pill st-err">Error</span>';
    if (d.status === 'interrupted') return '<span class="pill st-warn">Interrupted</span>';
    if (d.status === 'completed') return '<span class="pill st-ok">Completed</span>';
    return d.status ? '<span class="pill">' + esc(d.status) + '</span>' : '';
  }

  function sect(title, n, body) {
    if (!body) return '';
    return '<div class="d-sect"><h3>' + esc(title) + (n != null ? ' (' + fmtNum(n) + ')' : '') + '</h3>' + body + '</div>';
  }
  function emptyTab(what) { return '<div class="empty-list">No ' + esc(what) + ' in the loaded window.</div>'; }
  function pre(text, cls) { return '<pre class="blk' + (cls ? ' ' + cls : '') + '">' + esc(text) + '</pre>'; }
  function tcut(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }

  // ── markdown (ported from the original sessions page, which renders user/
  //    assistant/system bodies as GFM) ─────────────────────────────────────
  // Safe by construction: the WHOLE source is esc()'d first, then structure is
  // recognized on the escaped text — no input character can open a tag; only
  // this renderer's own literals become HTML. Escaping introduces no '|', '*',
  // '`', '#' or newlines, so the block/inline grammar sees the original shape.
  function mdInline(s) {
    // s is already escaped. Code spans are cut out FIRST and their content is
    // emitted untouched — emphasis/link passes only ever see non-code segments.
    function emphasized(seg) {
      seg = seg.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      seg = seg.replace(/(^|[\s(])\*([^*\s](?:[^*]*[^*\s])?)\*/g, '$1<em>$2</em>');
      seg = seg.replace(/~~([^~]+)~~/g, '<del>$1</del>');
      // Links: [text](http…) only, scheme-checked; quotes are already escaped so
      // the attribute cannot be broken out of.
      seg = seg.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
      return seg;
    }
    // Code spans pair by GFM's rule: a run of N backticks closes with the next
    // run of EXACTLY N (so `` `x` `` nests a literal backtick). Unpaired runs
    // stay literal backticks.
    var toks = s.split(/(`+)/);
    var acc = '', k = 0;
    while (k < toks.length) {
      var tok = toks[k];
      if (tok.charAt(0) !== '`') { acc += emphasized(tok); k++; continue; }
      var close = -1;
      for (var c = k + 2; c < toks.length; c += 2) {
        if (toks[c] === tok) { close = c; break; }
      }
      if (close < 0) { acc += tok; k++; continue; }
      var code = toks.slice(k + 1, close).join('');
      // GFM strips ONE leading+trailing space when both are present and content remains
      if (code.length > 2 && code.charAt(0) === ' ' && code.charAt(code.length - 1) === ' ') code = code.slice(1, -1);
      acc += '<code>' + code + '</code>';
      k = close + 1;
    }
    return acc;
  }
  // Block-level renderer over ESCAPED lines; blockquotes recurse (depth-capped).
  function mdBlocks(lines, depth) {
    var out = [], i = 0, m;
    var pbuf = [];
    function inlineJoined(arr) {
      // Inline over the JOINED text so emphasis/code spans cross soft breaks,
      // then soft breaks become <br>.
      return mdInline(arr.join('\n')).replace(/\n/g, '<br>');
    }
    function para() {
      if (pbuf.length) out.push('<p>' + inlineJoined(pbuf) + '</p>');
      pbuf.length = 0;
    }
    while (i < lines.length) {
      var ln = lines[i];
      // fenced code block: 3+ backticks, up to 3 leading spaces (lists indent
      // their fences); closes on a same-or-longer run
      if ((m = ln.match(/^ {0,3}(`{3,})(\S*)\s*$/))) {
        para();
        var fenceLen = m[1].length;
        var lang = m[2];
        var body = [];
        i++;
        var closeRe = /^ {0,3}(`{3,})\s*$/;
        var cm;
        while (i < lines.length && !((cm = lines[i].match(closeRe)) && cm[1].length >= fenceLen)) {
          body.push(lines[i]); i++;
        }
        i++; // past the closing fence (or EOF)
        out.push('<pre class="md-code"' + (lang ? ' data-lang="' + lang + '"' : '') + '><code>'
          + body.join('\n') + '</code></pre>');
        continue;
      }
      // blank line = paragraph break
      if (!ln.trim()) { para(); i++; continue; }
      // heading
      if ((m = ln.match(/^(#{1,6})\s+(.*)$/))) {
        para();
        out.push('<div class="md-h md-h' + m[1].length + '">' + mdInline(m[2]) + '</div>');
        i++; continue;
      }
      // hr
      if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(ln)) { para(); out.push('<hr>'); i++; continue; }
      // blockquote run — strip the markers and RECURSE so quoted lists/fences render
      if (/^\s*&gt;/.test(ln)) {
        para();
        var q = [];
        while (i < lines.length && /^\s*&gt;/.test(lines[i])) {
          q.push(lines[i].replace(/^\s*&gt;\s?/, ''));
          i++;
        }
        out.push('<blockquote>' + (depth < 4
          ? mdBlocks(q, depth + 1)
          : '<p>' + inlineJoined(q) + '</p>') + '</blockquote>');
        continue;
      }
      // table: a |-row whose next line is the separator row
      if (ln.indexOf('|') >= 0 && i + 1 < lines.length
          && /^[\s|:-]+$/.test(lines[i + 1]) && lines[i + 1].indexOf('-') >= 0
          && lines[i + 1].indexOf('|') >= 0) {
        para();
        var cells = function (row) {
          // \| is an escaped pipe inside a cell (GFM) — hide it from the split
          // behind \x01 (esc() never emits control chars) and restore afterwards
          return row.replace(/\\\|/g, '\x01').replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|')
            .map(function (c) { return mdInline(c.trim()).replace(/\x01/g, '|'); });
        };
        var t = '<div class="md-tblwrap"><table><thead><tr>'
          + cells(ln).map(function (c) { return '<th>' + c + '</th>'; }).join('') + '</tr></thead><tbody>';
        i += 2;
        while (i < lines.length && lines[i].indexOf('|') >= 0 && lines[i].trim()) {
          t += '<tr>' + cells(lines[i]).map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>';
          i++;
        }
        out.push(t + '</tbody></table></div>');
        continue;
      }
      // list run (one nesting level: 2+ spaces of indent). The consuming match IS
      // the loop condition, so a line the guard liked but the consumer rejects can
      // never spin — it falls through to the paragraph fallback below.
      if (/^(\s*)([-*+]|\d{1,9}\.)\s+/.test(ln)) {
        para();
        var items = [];
        while (i < lines.length && (m = lines[i].match(/^(\s*)([-*+]|\d{1,9}\.)\s+(.*)$/))) {
          items.push({ deep: m[1].length >= 2, num: parseInt(m[2], 10), text: mdInline(m[3]) });
          i++;
        }
        if (items.length) {
          var top = !isNaN(items[0].num);
          // "released in\n2024. It…" is an ordered item in GFM too — keep the
          // number via start= so the text's meaning survives (digits only, safe).
          var h = top ? '<ol' + (items[0].num !== 1 ? ' start="' + items[0].num + '"' : '') + '>' : '<ul>';
          var j = 0;
          while (j < items.length) {
            h += '<li>' + items[j].text; // an orphan deep first item just flattens
            j++;
            if (j < items.length && items[j].deep) {
              var sub = !isNaN(items[j].num);
              h += (sub ? '<ol' + (items[j].num !== 1 ? ' start="' + items[j].num + '"' : '') + '>' : '<ul>');
              while (j < items.length && items[j].deep) { h += '<li>' + items[j].text + '</li>'; j++; }
              h += (sub ? '</ol>' : '</ul>');
            }
            h += '</li>';
          }
          out.push(h + (top ? '</ol>' : '</ul>'));
          continue;
        }
      }
      pbuf.push(ln);
      i++;
    }
    para();
    return out.join('');
  }
  function md(src) {
    // Normalize exotic line endings FIRST: a stray \r once made a guard regex
    // match a line its consuming regex then rejected — an infinite loop that
    // hard-froze the pane.
    var text = String(src == null ? '' : src)
      .replace(/\r\n?/g, '\n').replace(/[\u2028\u2029]/g, '\n');
    return '<div class="md">' + mdBlocks(esc(text).split('\n'), 0) + '</div>';
  }

  // ── tool display (ported from the original page's formatToolCall +
  //    ToolCallDetail + ToolResultBlock) ───────────────────────────────────
  function fmtTool(name, input) {
    var inp = input || {};
    switch (name) {
      case 'Read': return { name: 'Read', args: String(inp.file_path || inp.path || '') };
      case 'Edit': return { name: 'Update', args: String(inp.file_path || inp.path || '') };
      case 'Write': return { name: 'Write', args: String(inp.file_path || inp.path || '') };
      case 'NotebookEdit': return { name: 'NotebookEdit', args: String(inp.notebook_path || '') };
      case 'Bash': return { name: 'Bash', args: tcut(inp.command || inp.cmd || '', 120) };
      case 'Grep': return { name: 'Grep', args: 'pattern="' + (inp.pattern || '') + '"' + (inp.path ? ', path=' + inp.path : '') };
      case 'Glob': return { name: 'Glob', args: String(inp.pattern || '') + (inp.path ? ', path=' + inp.path : '') };
      case 'Task': return { name: 'Task[' + (inp.subagent_type || 'agent') + ']', args: String(inp.description || '') };
      case 'TaskCreate': return { name: 'TaskCreate', args: String(inp.subject || '') };
      case 'TaskUpdate': return { name: 'TaskUpdate', args: '#' + (inp.taskId || '') + (inp.status ? ', status=' + inp.status : '') };
      case 'TaskList': return { name: 'TaskList', args: '' };
      case 'TaskGet': return { name: 'TaskGet', args: '#' + (inp.taskId || '') };
      case 'TodoWrite': return { name: 'TodoWrite', args: (inp.todos && inp.todos.length ? inp.todos.length + ' todos' : '') };
      case 'WebFetch': return { name: 'WebFetch', args: tcut(inp.url || '', 70) };
      case 'WebSearch': return { name: 'WebSearch', args: '"' + (inp.query || '') + '"' };
      case 'Skill': return { name: 'Skill', args: String(inp.skill || inp.command || '') };
      case 'AskUserQuestion': return { name: 'AskUser', args: '' };
      case 'EnterPlanMode': return { name: 'EnterPlan', args: '' };
      case 'ExitPlanMode': return { name: 'ExitPlan', args: String(inp.planTitle || '') };
      case 'Teammate': return { name: 'Team.' + (inp.operation || 'spawnTeam'), args: String(inp.team_name || '') };
      case 'SendMessage': return {
        name: 'Team.' + (inp.type || 'message'),
        args: ((inp.recipient ? '→' + inp.recipient + ' ' : '') + tcut(inp.summary || inp.content || '', 60)).replace(/\s+$/, ''),
      };
    }
    if (name && name.indexOf('mcp__') === 0) {
      return { name: name.replace('mcp__', '').split('__').join('.'), args: '' };
    }
    // Generic fallback: surface the most likely primary argument instead of raw JSON.
    var keys = ['command', 'path', 'file_path', 'url', 'query', 'pattern', 'prompt', 'description', 'subject', 'id'];
    for (var i = 0; i < keys.length; i++) {
      if (inp[keys[i]] != null && typeof inp[keys[i]] !== 'object') return { name: name || '?', args: tcut(inp[keys[i]], 90) };
    }
    return { name: name || '?', args: '' };
  }

  function diffLines(text, cls, sign) {
    var ls = String(text).split('\n');
    var extra = ls.length > 5 ? ls.length - 5 : 0;
    var h = ls.slice(0, 5).map(function (l) {
      return '<div class="diff-line ' + cls + '">' + sign + ' ' + esc(l) + '</div>';
    }).join('');
    if (extra) h += '<div class="diff-line tool-note">… ' + extra + ' more line' + (extra === 1 ? '' : 's') + '</div>';
    return h;
  }

  // Structured input detail for the tools whose shape earns more than the one-liner.
  function toolDetailHtml(name, inp) {
    inp = inp || {};
    if (name === 'Edit') {
      return '<div class="tool-detail">'
        + (inp.old_string ? diffLines(inp.old_string, 'diff-remove', '-') : '')
        + (inp.new_string ? diffLines(inp.new_string, 'diff-add', '+') : '') + '</div>';
    }
    if (name === 'Write') {
      var n = String(inp.content || '').split('\n').length;
      return '<div class="tool-detail"><span class="tool-note">' + fmtNum(n) + ' line' + (n === 1 ? '' : 's') + ' written</span></div>';
    }
    if (name === 'Bash' && (String(inp.command || '').length > 120 || inp.description)) {
      return '<div class="tool-detail">'
        + (String(inp.command || '').length > 120 ? '<div class="tool-cmd">' + esc(tcut(inp.command, 600)) + '</div>' : '')
        + (inp.description ? '<div class="tool-note">' + esc(inp.description) + '</div>' : '') + '</div>';
    }
    if (name === 'Task' && inp.prompt) {
      return '<div class="tool-detail"><div class="tool-note">' + esc(tcut(inp.prompt, 400)) + '</div></div>';
    }
    if (name === 'ExitPlanMode' && (inp.planSummary || inp.planTitle)) {
      return '<div class="tool-detail">'
        + (inp.planTitle ? '<div><strong>' + esc(inp.planTitle) + '</strong></div>' : '')
        + (inp.planSummary ? '<div class="tool-note">' + esc(tcut(inp.planSummary, 300)) + '</div>' : '') + '</div>';
    }
    if (name === 'TodoWrite' && inp.todos && inp.todos.length) {
      return '<div class="tool-detail">' + inp.todos.map(function (t) {
        t = t || {};
        var mark = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○';
        return '<div class="todo-line tk-' + esc(t.status || 'pending') + '">' + mark + ' ' + esc(t.content || '') + '</div>';
      }).join('') + '</div>';
    }
    return '';
  }

  // The paired tool_result (from the compact toolResults array — the server caps
  // each entry, this only renders what arrived and SAYS when it was capped).
  function toolResultHtml(name, tr) {
    if (!tr) return '';
    var txt = String(tr.content || '').replace(/\s+$/, '');
    if (!txt || txt === '{}' || txt === 'null') return '';
    var shownLen = txt.length;
    if ((txt.charAt(0) === '{' || txt.charAt(0) === '[') && !tr.truncated) {
      try { txt = JSON.stringify(JSON.parse(txt), null, 2); } catch (e) { /* not JSON — show as-is */ }
    }
    var cls = tr.isError ? 'err' : name === 'Bash' ? 'bash' : name === 'Read' ? 'read'
      : (name === 'Grep' || name === 'Glob') ? 'search' : '';
    var cap = tr.truncated
      ? '<div class="tres-cap">server-capped — showing ' + esc(fmtNum(shownLen)) + ' of ' + esc(fmtNum(tr.fullLength || shownLen)) + ' chars</div>'
      : '';
    return '<div class="tres' + (cls ? ' ' + cls : '') + '">'
      + (tr.isError ? '<div class="tres-cap err-lbl">tool returned an error</div>' : '')
      + '<pre>' + esc(txt) + '</pre>' + cap + '</div>';
  }

  function tabBody(d) {
    var t = state.tab, i, out;
    if (t === 'chat') {
      // Merge the pre-parsed arrays into one timeline on lineIndex, with the compact
      // chat extras: tool results pair onto their tool_use by id, system rows get
      // their own thin entries. The raw message stream is still NOT requested.
      var resFor = Object.create(null); // server-keyed lookup — no prototype to collide with
      (d.toolResults || []).forEach(function (r) { if (r && r.toolUseId) resFor[r.toolUseId] = r; });
      var ev = [];
      (d.userPrompts || []).forEach(function (p) { ev.push({ i: p.lineIndex, k: 'user', turn: p.turnIndex, text: p.text, ts: p.timestamp, pt: p.promptType }); });
      (d.responses || []).forEach(function (p) { ev.push({ i: p.lineIndex, k: 'asst', turn: p.turnIndex, text: p.text, err: p.isApiError }); });
      (d.thinkingBlocks || []).forEach(function (p) { ev.push({ i: p.lineIndex, k: 'think', turn: p.turnIndex, text: p.thinking }); });
      (d.toolUses || []).forEach(function (p) { ev.push({ i: p.lineIndex, k: 'tool', turn: p.turnIndex, name: p.name, input: p.input, res: resFor[p.id] }); });
      (d.systemMessages || []).forEach(function (m) { ev.push({ i: m.lineIndex, k: 'sys', sub: m.subtype || m.type, text: m.content, ts: m.timestamp }); });
      ev.sort(function (a, b) { return (a.i || 0) - (b.i || 0); });
      if (!ev.length) return emptyTab('messages');
      // Housekeeping subtypes render as one thin line, real system content as a full row.
      var SYS_THIN = { turn_duration: 1, stop_hook_summary: 1, init: 1 };
      out = ev.map(function (e) {
        if (e.k === 'tool') {
          var f = fmtTool(e.name, e.input);
          return '<div class="msg tool"><div class="mhead"><span class="tcall"><span class="tname">' + esc(f.name)
            + '</span><span class="targs">(' + esc(f.args) + ')</span></span>'
            + '<span class="rid">turn ' + esc(e.turn) + ' · line ' + esc(e.i) + '</span></div>'
            + toolDetailHtml(e.name, e.input) + toolResultHtml(e.name, e.res) + '</div>';
        }
        if (e.k === 'sys') {
          if (own(SYS_THIN, e.sub)) {
            return '<div class="msg sys thin"><span class="mwho">sys</span>'
              + '<span class="pill pt-sys">' + esc(e.sub) + '</span>'
              + '<span class="sys-txt">' + esc(e.text || '') + '</span>'
              + '<span class="rid">line ' + esc(e.i) + '</span></div>';
          }
          return '<div class="msg sys"><div class="mhead"><span class="mwho">system</span>'
            + (e.sub ? '<span class="pill pt-sys">' + esc(e.sub) + '</span>' : '')
            + '<span class="rid">line ' + esc(e.i) + (e.ts ? ' · ' + esc(ago(e.ts)) : '') + '</span></div>'
            + md(e.text) + '</div>';
        }
        var label = e.k === 'user' ? 'user' : e.k === 'asst' ? 'assistant' : 'thinking';
        var badge = '';
        var text = e.text || '';
        if (e.k === 'user' && e.pt && e.pt !== 'user') {
          badge = '<span class="pill pt-command">' + esc(e.pt) + '</span>';
          if (e.pt === 'command') {
            // Slash-command envelope → the command the user actually typed.
            // Lazy bodies: args may themselves contain '<' (e.g. "/ask what does <T> mean")
            var cn = /<command-name>([\s\S]*?)<\/command-name>/.exec(text);
            var ca = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
            if (cn) text = cn[1].trim() + (ca && ca[1].trim() ? ' ' + ca[1].trim() : '');
          }
        }
        if (e.k === 'asst' && e.err) badge = '<span class="pill st-err">api error</span>';
        return '<div class="msg ' + e.k + '"><div class="mhead"><span class="mwho">' + esc(label) + '</span>' + badge
          + '<span class="rid">turn ' + esc(e.turn) + ' · line ' + esc(e.i) + (e.ts ? ' · ' + esc(ago(e.ts)) : '') + '</span></div>'
          + md(text) + '</div>';
      }).join('');
      return out;
    }
    if (t === 'thinking') {
      var th = d.thinkingBlocks || [];
      if (!th.length) return emptyTab('thinking blocks');
      return th.map(function (b) {
        return '<div class="msg think"><div class="mhead"><span class="rid">turn ' + esc(b.turnIndex)
          + ' · line ' + esc(b.lineIndex) + '</span></div>' + md(b.thinking || '') + '</div>';
      }).join('');
    }
    if (t === 'tools') {
      var tu = d.toolUses || [];
      if (!tu.length) return emptyTab('tool uses');
      var resFor2 = Object.create(null);
      (d.toolResults || []).forEach(function (r) { if (r && r.toolUseId) resFor2[r.toolUseId] = r; });
      var byName = {};
      tu.forEach(function (u) { byName[u.name] = (byName[u.name] || 0) + 1; });
      var tally = Object.keys(byName).sort(function (a, b) { return byName[b] - byName[a]; })
        .map(function (n) { return '<span class="pill">' + esc(n) + ' ×' + esc(byName[n]) + '</span>'; }).join('');
      return '<div class="d-pills">' + tally + '</div>' + tu.map(function (u) {
        var f = fmtTool(u.name, u.input);
        return '<div class="itm"><div class="ihead"><span class="tcall"><span class="tname">' + esc(f.name)
          + '</span><span class="targs">(' + esc(f.args) + ')</span></span>'
          + '<span class="rid">turn ' + esc(u.turnIndex) + ' · line ' + esc(u.lineIndex) + '</span></div>'
          + toolDetailHtml(u.name, u.input) + toolResultHtml(u.name, resFor2[u.id]) + '</div>';
      }).join('');
    }
    if (t === 'files') {
      var fc = d.fileChanges || [];
      var fs = d.fileSummary || {};
      var head = '<div class="d-pills"><span class="pill st-ok">created ' + esc(fs.created || 0) + '</span>'
        + '<span class="pill">updated ' + esc(fs.updated || 0) + '</span>'
        + '<span class="pill st-err">deleted ' + esc(fs.deleted || 0) + '</span></div>';
      if (!fc.length) return head + emptyTab('file changes');
      return head + fc.map(function (f) {
        return '<div class="itm row-line"><span class="pill act-' + esc(f.action) + '">' + esc(f.action) + '</span>'
          + '<span class="mono flex1">' + esc(f.path) + '</span>'
          + '<span class="rid">' + esc(f.toolName || '') + ' · line ' + esc(f.lineIndex) + '</span></div>';
      }).join('');
    }
    if (t === 'git' || t === 'db') {
      var ops = (t === 'git' ? d.gitOperations : d.dbOperations) || [];
      if (!ops.length) return emptyTab(t === 'git' ? 'git operations' : 'database operations');
      return ops.map(function (o) {
        return '<div class="itm"><div class="ihead"><span class="pill kind">' + esc(o.type) + '</span>'
          + '<span class="rid">turn ' + esc(o.turnIndex) + ' · line ' + esc(o.lineIndex) + '</span></div>'
          + '<pre class="mbody mono">' + esc(o.command) + '</pre></div>';
      }).join('');
    }
    if (t === 'tasks') {
      var tasks = d.tasks || [], todos = d.todos || [];
      if (!tasks.length && !todos.length) return emptyTab('tasks or todos');
      var tb = tasks.map(function (k) {
        return '<div class="itm row-line"><span class="pill tk-' + esc(k.status) + '">' + esc(k.status) + '</span>'
          + '<span class="flex1">' + esc(k.subject) + '</span><span class="rid">' + esc(k.id) + '</span></div>';
      }).join('');
      var db2 = todos.map(function (k) {
        return '<div class="itm row-line"><span class="pill tk-' + esc(k.status) + '">' + esc(k.status) + '</span>'
          + '<span class="flex1">' + esc(k.content) + '</span><span class="rid">line ' + esc(k.lineIndex) + '</span></div>';
      }).join('');
      return sect('Tasks', tasks.length, tb) + sect('Todos', todos.length, db2);
    }
    if (t === 'agents') {
      var ag = d.subagents || [];
      if (!ag.length) return emptyTab('subagents');
      return ag.map(function (a) {
        // agentId is EMPTY on some sessions — only offer the open button when there is one.
        var openable = a.agentId ? '<button class="ghost sm" data-agent="' + esc(a.agentId) + '">open →</button>' : '';
        return '<div class="itm"><div class="ihead"><span class="pill kind">' + esc(a.type || 'agent') + '</span>'
          + '<span class="pill tk-' + esc(a.status) + '">' + esc(a.status || '?') + '</span>'
          + '<span class="flex1">' + esc(a.description || a.agentId || '') + '</span>'
          + '<span class="rid">' + esc(a.agentId ? shortSid(a.agentId) : 'no id') + '</span>' + openable + '</div>'
          + (a.prompt ? '<pre class="mbody">' + esc(a.prompt) + '</pre>' : '')
          + (a.result ? '<pre class="mbody dim">' + esc(a.result) + '</pre>' : '') + '</div>';
      }).join('');
    }
    if (t === 'team') {
      var tm = d.teamMessages || [];
      var subj = d.taskSubjects || {};
      var sk = Object.keys(subj);
      var head2 = (d.allTeams && d.allTeams.length ? d.allTeams : (d.teamName ? [d.teamName] : []))
        .map(function (x) { return '<span class="pill kind">' + esc(x) + '</span>'; }).join('');
      var sb = sk.map(function (k) {
        return '<div class="itm row-line"><span class="rid">' + esc(k) + '</span><span class="flex1">' + esc(subj[k]) + '</span></div>';
      }).join('');
      if (!tm.length && !sk.length && !head2) return emptyTab('team activity');
      var mb = tm.map(function (m) {
        return '<div class="itm"><div class="ihead"><span class="pill kind">' + esc(m.messageType) + '</span>'
          + '<span class="rid">→ ' + esc(m.recipient || '—') + ' · turn ' + esc(m.turnIndex) + '</span></div>'
          + '<pre class="mbody">' + esc(m.content || m.summary || '') + '</pre></div>';
      }).join('');
      return (head2 ? '<div class="d-pills">' + head2 + '</div>' : '')
        + sect('Messages', tm.length, mb) + sect('Task subjects', sk.length, sb);
    }
    if (t === 'meta') {
      var kv = [];
      function add(k, v) { if (v !== undefined && v !== null && v !== '') kv.push([k, String(v)]); }
      add('sessionId', d.sessionId); add('projectPath', d.projectPath); add('cwd', d.cwd);
      add('model', d.model); add('claudeCodeVersion', d.claudeCodeVersion);
      add('permissionMode', d.permissionMode); add('status', d.status);
      add('isActive', String(!!d.isActive)); add('numTurns', d.numTurns); add('totalTurns', d.totalTurns);
      add('totalUserPrompts', d.totalUserPrompts); add('totalSubagents', d.totalSubagents);
      add('skillInvocationCount', d.skillInvocationCount); add('commandInvocationCount', d.commandInvocationCount);
      add('lastLineIndex', d.lastLineIndex); add('lastTurnIndex', d.lastTurnIndex);
      add('hasMore', String(!!d.hasMore)); add('durationMs', d.durationMs); add('durationApiMs', d.durationApiMs);
      add('lastModified', d.lastModified); add('lastActivityAt', d.lastActivityAt);
      add('totalCostUsd', d.totalCostUsd);
      if (d.running) {
        add('running.pid', d.running.pid); add('running.managedBy', d.running.managedBy);
        add('running.source', d.running.source); add('running.tmuxSessionName', d.running.tmuxSessionName);
      }
      var u = d.usage || {};
      add('usage.input', fmtNum(u.inputTokens)); add('usage.output', fmtNum(u.outputTokens));
      add('usage.cacheCreate', fmtNum(u.cacheCreationInputTokens)); add('usage.cacheRead', fmtNum(u.cacheReadInputTokens));
      var rows = kv.map(function (p) {
        return '<div class="kv"><span class="kvk">' + esc(p[0]) + '</span><span class="kvv">' + esc(p[1]) + '</span></div>';
      }).join('');
      var mu = d.modelUsage || {};
      var muRows = Object.keys(mu).map(function (m) {
        var x = mu[m];
        return '<div class="kv"><span class="kvk">' + esc(m) + '</span><span class="kvv">'
          + esc(fmtNum(x.messageCount) + ' msgs · ' + fmtCost(x.costUsd) + ' · in ' + fmtNum(x.inputTokens)
            + ' / out ' + fmtNum(x.outputTokens)) + '</span></div>';
      }).join('');
      var toolsList = (d.tools || []).map(function (x) { return '<span class="pill">' + esc(x) + '</span>'; }).join('');
      var mcpList = (d.mcpServers || []).map(function (x) {
        return '<span class="pill kind">' + esc(typeof x === 'string' ? x : (x && x.name) || JSON.stringify(x)) + '</span>';
      }).join('');
      return sect('Fields', null, rows)
        + sect('Model usage', Object.keys(mu).length, muRows)
        + sect('Tools', (d.tools || []).length, toolsList ? '<div class="d-pills">' + toolsList + '</div>' : '')
        + sect('MCP servers', (d.mcpServers || []).length, mcpList ? '<div class="d-pills">' + mcpList + '</div>' : '');
    }
    if (t === 'json') {
      var txt;
      try { txt = JSON.stringify(d, null, 2); } catch (e) { txt = String(e); }
      var over = txt.length > JSON_CAP;
      return (over ? '<div class="load-note warn">Truncated to ' + fmtNum(JSON_CAP) + ' of '
        + fmtNum(txt.length) + ' characters.</div>' : '')
        + pre(over ? txt.slice(0, JSON_CAP) : txt, 'mono');
    }
    return '';
  }

  function paintDetail() {
    var el = $('detail');
    if (state.detailState === 'loading' && !state.selected) {
      el.className = 'detail empty'; el.textContent = 'loading session ' + shortSid(state.selectedId) + '…';
      reportHeight(); return;
    }
    if (state.detailState === 'error') {
      el.className = 'detail';
      el.innerHTML = '<div class="d-err"><div class="d-err-h">Session could not be loaded</div>'
        + '<pre class="blk">' + esc(state.detailError) + '</pre>'
        + '<button class="primary" id="d-retry">Retry</button></div>';
      $('d-retry').onclick = function () { openSession(state.selectedId); };
      reportHeight(); return;
    }
    var d = state.selected;
    if (!d) {
      el.className = 'detail empty';
      el.textContent = 'Select a session on the left.';
      reportHeight(); return;
    }
    el.className = 'detail';
    var name = displayName(d) || baseName(d.projectPath) || 'Session';
    var tabs = TABS.map(function (t) {
      var n = tabCount(d, t[0]);
      return '<span class="tab' + (state.tab === t[0] ? ' on' : '') + '" data-tab="' + t[0] + '">' + esc(t[1])
        + (n ? '<span class="tbadge">' + fmtNum(n) + '</span>' : '') + '</span>';
    }).join('');
    var promptSel = PROMPT_STEPS.map(function (n) {
      return '<option value="' + n + '"' + (n === state.prompts ? ' selected' : '') + '>last ' + n + ' prompts</option>';
    }).join('');

    var banners = '';
    if (state.notInList) {
      banners += '<div class="load-note warn">Opened by link — this session is not in the loaded list '
        + '(a subagent session, or older than the loaded slice).</div>';
    }
    if (IN.parent && IN.parent !== d.sessionId) {
      banners += '<div class="load-note">Parent session <code>' + esc(shortSid(IN.parent)) + '</code> — '
        + '<a href="#" id="d-parent">open it</a></div>';
    }
    if (d.hasMore) {
      banners += '<div class="load-note warn">This is the last ' + state.prompts + ' user prompts of '
        + esc(fmtNum(d.totalUserPrompts)) + ' — earlier turns are NOT loaded.</div>';
    }

    var head = '<div class="d-head"><h2 class="d-title">' + esc(name) + '</h2>'
      + '<button class="ghost sm" id="d-refresh">refresh</button></div>'
      + '<div class="d-idrow"><span class="d-id">' + esc(d.sessionId) + '</span>'
      + (d.projectPath ? '<button class="ghost sm" id="d-proj" title="Open this project in the Projects pane">'
        + esc(baseName(d.projectPath)) + ' →</button>' : '') + '</div>'
      + '<div class="d-pills">' + statusBadge(d)
      + (d.running ? '<span class="pill ' + (isManaged(d.running.managedBy) ? 'run-ok' : 'run-ext') + '">PID '
        + esc(d.running.pid) + ' · ' + esc(managedLabel(d.running.managedBy)) + '</span>' : '')
      + (d.model ? '<span class="pill">' + esc(modelShort(d.model)) + '</span>' : '')
      + '<span class="pill">T:' + esc(d.numTurns || 0) + '</span>'
      + (d.totalCostUsd ? '<span class="pill cost">' + esc(fmtCost(d.totalCostUsd)) + '</span>' : '')
      + '<span class="pill">' + esc(fmtNum(d.totalUserPrompts || (d.userPrompts || []).length)) + ' prompts</span>'
      + '<span class="rid">' + esc(ago(d.lastModified)) + '</span></div>'
      + (d.projectPath ? '<div class="d-path mono">' + esc(d.projectPath) + '</div>' : '')
      + (d.sessionSummary ? '<div class="d-sum">' + esc(d.sessionSummary) + '</div>' : '');

    el.innerHTML = head + banners
      + '<div class="tabbar">' + tabs + '<select id="d-prompts" class="sel sm">' + promptSel + '</select></div>'
      + '<div class="tabbody">' + tabBody(d) + '</div>';

    $('d-refresh').onclick = function () { openSession(d.sessionId); };
    if ($('d-proj')) $('d-proj').onclick = function () { lmui.goto('assist-projects', { project: d.projectPath }); };
    if ($('d-parent')) $('d-parent').onclick = function (e) { e.preventDefault(); openSession(IN.parent); };
    $('d-prompts').onchange = function (e) { state.prompts = Number(e.target.value); openSession(d.sessionId); };
    reportHeight();
  }

  function tabCount(d, t) {
    switch (t) {
      case 'chat': return (d.userPrompts || []).length + (d.responses || []).length;
      case 'thinking': return (d.thinkingBlocks || []).length;
      case 'tools': return (d.toolUses || []).length;
      case 'files': return (d.fileChanges || []).length;
      case 'git': return (d.gitOperations || []).length;
      case 'db': return (d.dbOperations || []).length;
      case 'tasks': return (d.tasks || []).length + (d.todos || []).length;
      case 'agents': return (d.subagents || []).length;
      case 'team': return (d.teamMessages || []).length;
      default: return 0;
    }
  }

  // ── wiring ───────────────────────────────────────────────────────────────
  $('list').addEventListener('click', function (e) {
    var row = e.target.closest ? e.target.closest('.row') : null;
    if (row && row.dataset.sid) openSession(row.dataset.sid);
  });
  $('detail').addEventListener('click', function (e) {
    var tab = e.target.closest ? e.target.closest('.tab') : null;
    if (tab && tab.dataset.tab) { state.tab = tab.dataset.tab; paintDetail(); return; }
    var ag = e.target.closest ? e.target.closest('[data-agent]') : null;
    if (ag && ag.dataset.agent) openSession(ag.dataset.agent);
  });
  $('q').addEventListener('input', function (e) {
    state.filter.q = e.target.value; state.rows = ROW_PAGE; paintList();
  });
  $('f-project').addEventListener('change', function (e) { selectProject(e.target.value, null); });
  $('f-time').addEventListener('change', function (e) {
    state.filter.time = e.target.value; state.rows = ROW_PAGE; paintList();
  });
  $('t-running').addEventListener('click', function (e) {
    state.filter.running = !state.filter.running;
    e.target.classList.toggle('on', state.filter.running);
    state.rows = ROW_PAGE; paintList();
  });
  $('t-cmds').addEventListener('click', function (e) {
    state.filter.cmds = !state.filter.cmds;
    e.target.classList.toggle('on', state.filter.cmds);
    state.rows = ROW_PAGE; paintList();
  });
  $('btn-refresh').addEventListener('click', function () { loadList(); });
  $('btn-more-rows').addEventListener('click', function () { state.rows += 100; paintList(); });
  $('btn-fetch-more').addEventListener('click', function () { state.limit += FETCH_PAGE; loadList(); });
  $('btn-fetch-all').addEventListener('click', function () {
    note('Fetching all ' + fmtNum(state.total) + ' sessions — on a busy node this response is '
      + 'several MB and takes a moment.');
    state.limit = 0; loadList();
  });

  // Who is signed in (identity rides the session, not the view token).
  fetch('/auth/me', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
    $('who-name').textContent = (d.claims && (d.claims.name || d.claims.email)) || d.userId || 'signed in';
  }).catch(function () { $('who-name').textContent = 'signed in'; });

  // ── boot ─────────────────────────────────────────────────────────────────
  // Three independent calls, deliberately NOT serialized: /projects takes ~1.7s on a node
  // with 85 projects and must never gate the list's first paint, and a deep-linked session
  // must open even when it is not in the list at all.
  loadList();
  loadProjects();
  if (state.selectedId) openSession(state.selectedId);
})();
