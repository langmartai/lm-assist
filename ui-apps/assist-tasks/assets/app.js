/* assist-tasks — the Claude Code session task lists of THIS node as a scoped pane. Plain JS,
 * no build, no deps. Every data call goes through the injected SDK helper (lmui.call), which
 * carries the view token and re-mints it on 401/403. This pane is 100% read-only.
 *
 * Declared grants (lmui.config.json) — the hard ceiling; anything else 403s:
 *   node:/tasks/all [GET] exact   every task from every list on THIS node
 *   node:/health    [GET] exact   the node's own name/platform/version, for the scope banner
 * `/tasks/all` is deliberately the leaf, not the `/tasks` prefix: a `/tasks` grant would also
 * cover POST /tasks/:listId and PUT/DELETE /tasks/:listId/:taskId, i.e. real task mutation.
 *
 * Path + envelope shape mirror core/src/routes/core/tasks.routes.ts and getAllTasksFlat() in
 * core/src/tasks-service.ts (verified against the live dev API at build time):
 *   GET /tasks/all → data = { tasks:[...], total }   (WRAPPER, not a bare array)
 *   row = { id, subject, description, activeForm?, status, blocks[], blockedBy[],
 *           sessionId, projectPath?, projectName?, owner?, metadata? }
 *   GET /health    → data = { status, uptime, projectPath, version, runningFrom, hostname,
 *                             platform, localIp, eventLoop }   (core/src/routes/core/health.routes.ts)
 * Do NOT call GET /tasks — that is a DIFFERENT route returning { taskLists, total, tasksDir },
 * per-session summaries rather than tasks (3461 rows here vs 470).
 *
 * 🔴 `id` is only unique WITHIN a task list: 470 tasks carry 72 distinct ids ("1" appears 36×).
 * Identity is therefore the (sessionId, id) pair — see taskKey() — and blockedBy/blocks ids are
 * resolved inside the OWNING session's list, never globally.
 *
 * 🔴 SCOPE: THIS NODE ONLY — and that is a REDUCTION from the page this replaces, not a
 * restatement of it. Do not describe it as "degenerate (one machine)": the fleet has many, and
 * web/src/hooks/useTasks.ts really did aggregate across them — it fanned
 * `apiClient.getTaskStoreAll(machineId)` over every online machine with Promise.allSettled,
 * filtered on `machineId`, and offered `groupBy:'machine'`. A pane is served BY one node and
 * `/tasks/all` reads that node's own ~/.claude/tasks, so this pane shows one host's tasks and
 * queries no other. True multi-node aggregation is a separate, blocked backlog item; it is NOT
 * implemented here and nothing in this file may imply that it is.
 *
 * That is why the node is NAMED in the UI, not just in the README, and why the scope banner and
 * the "showing N of M" line both carry it: an unqualified "showing 470 of 470 tasks" is exactly
 * how a fleet operator reads a single node's numbers as the fleet's. The banner's "this node
 * only" text is static — it is a property of the grant, so it must not vanish when a fetch
 * fails; only the node's NAME is fetched, and it degrades to "this node". */
(function () {
  'use strict';

  // Status vocabulary (Task.status in core/src/tasks-service.ts, minus 'deleted' which
  // getAllTasksFlat filters out server-side). Order = the kanban column order.
  var STATUSES = ['pending', 'in_progress', 'completed'];
  var STATUS_LABEL = { pending: 'Pending', in_progress: 'In Progress', completed: 'Completed' };
  var STATUS_CHIPS = [['', 'all'], ['pending', 'pending'], ['in_progress', 'in progress'], ['completed', 'completed']];
  var GROUP_CHIPS = [['project', 'project'], ['session', 'session'], ['none', 'flat']];
  var VIEW_CHIPS = [['kanban', 'kanban'], ['list', 'list']];
  var REFRESH_MS = 10000;     // the old page polled getTaskStoreAll on this interval
  var TICK_MS = 5000;

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

  // ── formatters ────────────────────────────────────────────────────────────
  function agoMs(t) {
    if (!t) return 'never';
    var s = Math.floor((Date.now() - t) / 1000);
    if (!isFinite(s) || s < 5) return 'just now';   // s<0 (clock skew) reads "just now", not a date
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    if (m < 1440) return Math.floor(m / 60) + 'h ago';
    return Math.floor(m / 1440) + 'd ago';
  }
  function statusLabel(s) { return STATUS_LABEL[s] || s || 'unknown'; }
  function shortSid(s) { return s ? String(s).slice(0, 8) : 'unknown'; }
  // Identity: `id` repeats across task lists, so a task is only addressable as (sessionId, id).
  function taskKey(t) { return String(t.sessionId || '') + '' + String(t.id || ''); }

  // ── state ───────────────────────────────────────────────────────────────
  var state = {
    tasks: [],                                    // data.tasks from GET /tasks/all (flat, all lists)
    selectedKey: null,                            // taskKey() of the open task, re-resolved each paint
    filter: { q: '', status: '', project: '' },   // client-side; '' = all
    groupBy: 'project',                           // project | session | none  (old page's Group by,
                                                  //   minus 'machine' — see the scope note above)
    view: 'kanban',                               // kanban | list             (old page's View)
    auto: true,                                   // poll every REFRESH_MS, like the old page
    loadedAt: 0,                                  // when the last successful load landed
    loaded: false,                                // has any load succeeded? (drives fatal vs soft error)
    inflight: false,                              // don't stack overlapping refreshes
    fatalMsg: null,                               // last fatal text, so the layer can be re-painted
                                                  //   once the node's name lands (see fatal())
    // Node identity — the NAME only. Its four states are explicit because "no node shown" is
    // the failure this pane exists to prevent: loading → unnamed/error still say "this node".
    node: { phase: 'loading', hostname: '', platform: '', version: '', localIp: '', error: '' },
    nodeInflight: false,
  };

  // The node this pane reads, for inline prose ("… on <x>"). Never empty, never a guess: when
  // the name is unknown it is still truthfully "this node" — one host, just an unnamed one.
  function nodeName() {
    return (state.node.phase === 'ok' && state.node.hostname) ? state.node.hostname : 'this node';
  }
  // ONE source for the source-of-these-numbers phrase, so the counts line and the summary box
  // can never drift into saying different things about the same figures.
  function onNodePhrase() {
    return (state.node.phase === 'ok' && state.node.hostname)
      ? ('on ' + state.node.hostname + ' — this node only')
      : 'on this node only';
  }

  function say(msg, isErr) {
    var out = $('out');
    if (!out) return;
    out.textContent = typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2);
    out.classList.toggle('err', !!isErr);
    reportHeight();
  }

  // A hard failure of the primary data call: cover the screen with the server's own text.
  // Names the host even here — "Tasks could not be loaded" alone reads like a fleet outage.
  //
  // 🔴 The message is REMEMBERED (state.fatalMsg) because this layer names the node and the two
  // boot calls race: /tasks/all can fail before /health answers, which painted the heading as
  // "…from this node" and then never corrected it once the name arrived. loadNode() re-paints
  // this layer when it lands. Caught by the FAIL_TASKS e2e scenario, which was flaky until then
  // — it passed or failed purely on which response won.
  function fatal(message) {
    state.fatalMsg = message;
    var old = $('fatal-layer');
    if (old) old.remove();
    var d = document.createElement('div');
    d.className = 'fatal';
    d.id = 'fatal-layer';
    d.innerHTML = '<div class="fatal-card"><div class="fatal-h">Tasks could not be loaded from '
      + esc(nodeName()) + '</div><div class="fatal-sub">This pane reads that one node; no other host was queried.</div>'
      + '<pre class="fatal-msg"></pre><button class="primary" id="fatal-retry">Retry</button></div>';
    d.querySelector('.fatal-msg').textContent = message;   // textContent — server text is NOT trusted HTML
    document.body.appendChild(d);
    // clearFatal(), not d.remove(): dropping the node alone would leave state.fatalMsg set, and
    // a /health landing after the click would RESURRECT a layer the user just dismissed.
    $('fatal-retry').onclick = function () { clearFatal(); loadNode(); loadList(); };
    reportHeight();
  }
  function clearFatal() { state.fatalMsg = null; var o = $('fatal-layer'); if (o) o.remove(); }

  // ── filters ───────────────────────────────────────────────────────────────
  function chipset(el, pairs, current, attr) {
    el.innerHTML = pairs.map(function (p) {
      return '<span class="fchip' + (current === p[0] ? ' on' : '') + '" ' + attr + '="' + esc(p[0]) + '">'
        + esc(p[1]) + '</span>';
    }).join('');
  }
  function paintChips() {
    chipset($('chips-status'), STATUS_CHIPS, state.filter.status, 'data-fs');
    chipset($('chips-group'), GROUP_CHIPS, state.groupBy, 'data-fg');
    chipset($('chips-view'), VIEW_CHIPS, state.view, 'data-fv');
  }

  // ── node identity ─────────────────────────────────────────────────────────
  // Paints the WHICH-HOST half of the scope banner. The "this node only" half is static markup
  // in index.html and is never touched here — a failed /health must not be able to erase the
  // scope statement, only the host's name. Values go in via textContent (no markup path at all),
  // and the innerHTML paints elsewhere esc() the same strings.
  function paintNode() {
    var n = state.node, txt, tip;
    if (n.phase === 'ok' && n.hostname) {
      txt = n.hostname;
      tip = [n.platform, n.localIp, n.version ? 'v' + n.version : ''].filter(Boolean).join(' · ');
    } else if (n.phase === 'loading') {
      txt = 'identifying this node…'; tip = '';
    } else if (n.phase === 'unnamed') {
      txt = 'this node (the host reported no name)'; tip = '';
    } else {
      txt = 'this node (name unavailable)'; tip = n.error || '';
    }
    var box = $('scope');
    if (box) box.setAttribute('data-state', n.phase);
    var el = $('scope-node');
    if (el) { el.textContent = txt; el.title = tip; }
    var hdr = $('hdr-node');
    if (hdr) { hdr.textContent = 'node ' + txt; hdr.title = tip; }
    // A pinned tab should name the host it is showing, not just say "Tasks".
    document.title = (n.phase === 'ok' && n.hostname) ? ('Tasks — ' + n.hostname) : 'Assist — Tasks (this node)';
    reportHeight();
  }

  // Fetched once at boot, again on every manual Refresh, and retried on the background tick ONLY
  // while it is failing — a transient 403 (a re-minted token that predates the /health grant) or
  // a network blip must not leave the pane permanently unable to name its own host.
  function loadNode() {
    if (state.nodeInflight) return Promise.resolve();
    state.nodeInflight = true;
    if (state.node.phase !== 'ok') { state.node.phase = 'loading'; paintNode(); }
    return api('node', '/health').then(function (r) {
      state.nodeInflight = false;
      if (!r.ok) {
        state.node.phase = 'error';
        state.node.error = r.error.code + ': ' + r.error.message;
      } else if (!r.data || !r.data.hostname) {
        state.node.phase = 'unnamed';
        state.node.error = '';
      } else {
        state.node.phase = 'ok';
        state.node.hostname = String(r.data.hostname);
        state.node.platform = r.data.platform ? String(r.data.platform) : '';
        state.node.version = r.data.version ? String(r.data.version) : '';
        state.node.localIp = r.data.localIp ? String(r.data.localIp) : '';
        state.node.error = '';
      }
      paintNode();
      if (state.loaded) { paintBoard(); paintDetail(); }   // both name the node in their text
      // The fatal layer names the node too, and may have been painted before this call landed.
      if (state.fatalMsg) fatal(state.fatalMsg);
    });
  }

  // Project options are rebuilt on every load; the current choice survives if it still exists.
  function paintProjects() {
    var seen = Object.create(null), names = [];
    state.tasks.forEach(function (t) {
      var n = t.projectName;
      if (n && !seen[n]) { seen[n] = 1; names.push(n); }
    });
    names.sort();
    if (state.filter.project && names.indexOf(state.filter.project) === -1) state.filter.project = '';
    var cur = state.filter.project;
    $('f-project').innerHTML = '<option value=""' + (cur ? '' : ' selected') + '>All projects</option>'
      + names.map(function (n) {
        return '<option value="' + esc(n) + '"' + (n === cur ? ' selected' : '') + '>' + esc(n) + '</option>';
      }).join('');
  }

  function passFilters(t) {
    var f = state.filter;
    if (f.status && t.status !== f.status) return false;
    if (f.project && (t.projectName || '') !== f.project) return false;
    var q = f.q.trim().toLowerCase();
    if (q) {
      var hay = ((t.subject || '') + ' ' + (t.id || '') + ' ' + (t.description || '') + ' '
        + (t.projectName || '') + ' ' + (t.sessionId || '')).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  }
  function visibleTasks() { return state.tasks.filter(passFilters); }

  // ── grouping (Object.create(null): a projectName like "__proto__" must not poison the map) ──
  function groupsOf(list) {
    if (state.groupBy === 'none') return [{ key: 'all', label: 'All Tasks', sublabel: '', tasks: list }];
    var map = Object.create(null), order = [];
    list.forEach(function (t) {
      var key, label, sub;
      if (state.groupBy === 'project') {
        key = t.projectName || 'Unknown Project';
        label = key;
        sub = t.projectPath || '';
      } else {
        key = t.sessionId || 'unknown';
        label = t.sessionId ? shortSid(t.sessionId) : 'Unknown Session';
        sub = t.projectName || '';
      }
      if (!map[key]) { map[key] = { key: key, label: label, sublabel: sub, tasks: [] }; order.push(key); }
      map[key].tasks.push(t);
    });
    return order.map(function (k) { return map[k]; });
  }

  // ── task lookups ──────────────────────────────────────────────────────────
  function findByKey(k) {
    if (!k) return null;
    for (var i = 0; i < state.tasks.length; i++) if (taskKey(state.tasks[i]) === k) return state.tasks[i];
    return null;
  }
  // A dependency id is list-local: resolve it inside the owning session, never across sessions.
  function depTask(owner, depId) {
    for (var i = 0; i < state.tasks.length; i++) {
      var t = state.tasks[i];
      if (t.sessionId === owner.sessionId && String(t.id) === String(depId)) return t;
    }
    return null;
  }
  function isBlocked(t) { return !!(t.blockedBy && t.blockedBy.length && t.status !== 'completed'); }

  // ── board: kanban cards + list rows ───────────────────────────────────────
  function depBadges(t) {
    var by = (t.blockedBy || []).length, bl = (t.blocks || []).length;
    if (!by && !bl) return '';
    return '<div class="cdeps">'
      + (by ? '<span class="dep-by" title="blocked by ' + by + '">&#8592; ' + by + '</span>' : '')
      + (bl ? '<span class="dep-blk" title="blocks ' + bl + '">&#8594; ' + bl + '</span>' : '')
      + '</div>';
  }

  function cardHtml(t) {
    var k = taskKey(t);
    var cls = 'card st-' + esc(t.status) + (isBlocked(t) ? ' blocked' : '') + (state.selectedKey === k ? ' sel' : '');
    return '<div class="' + cls + '" data-tk="' + esc(k) + '">'
      + '<div class="chead"><span class="cid">#' + esc(t.id) + '</span>'
      + (t.projectName ? '<span class="pill proj">' + esc(t.projectName) + '</span>' : '') + '</div>'
      + '<div class="csub">' + esc(t.subject) + '</div>'
      + depBadges(t) + '</div>';
  }

  function listRowHtml(t) {
    var k = taskKey(t);
    var cls = 'row st-' + esc(t.status) + (isBlocked(t) ? ' blocked' : '') + (state.selectedKey === k ? ' sel' : '');
    return '<div class="' + cls + '" data-tk="' + esc(k) + '">'
      + '<span class="rid">#' + esc(t.id) + '</span>'
      + '<span class="rt">' + esc(t.subject) + '</span>'
      + '<span class="pill st-' + esc(t.status) + '">' + esc(statusLabel(t.status)) + '</span>'
      + '<span class="rproj">' + esc(t.projectName || '—') + '</span></div>';
  }

  function kanbanHtml(tasks) {
    var cols = STATUSES.map(function (s) {
      return { status: s, label: statusLabel(s), items: tasks.filter(function (t) { return t.status === s; }) };
    });
    // Never silently swallow a status the server grows later — give it its own column.
    var rest = tasks.filter(function (t) { return STATUSES.indexOf(t.status) === -1; });
    if (rest.length) cols.push({ status: 'other', label: 'Other', items: rest });
    return '<div class="kanban">' + cols.map(function (c) {
      var body = c.items.length
        ? c.items.map(cardHtml).join('')
        : '<div class="kempty">No tasks</div>';
      return '<div class="kcol"><div class="khead st-' + esc(c.status) + '"><span class="kdot"></span>'
        + '<span class="klbl">' + esc(c.label) + '</span>'
        + '<span class="pill st-' + esc(c.status) + '">' + c.items.length + '</span></div>'
        + '<div class="kbody">' + body + '</div></div>';
    }).join('') + '</div>';
  }

  function groupHtml(g) {
    var head = state.groupBy === 'none' ? '' : '<div class="ghead">'
      + '<span class="glbl">' + esc(g.label) + '</span>'
      + (g.sublabel ? '<span class="gsub">' + esc(g.sublabel) + '</span>' : '')
      + '<span class="gcount">' + g.tasks.length + ' task' + (g.tasks.length === 1 ? '' : 's') + '</span></div>';
    var body = state.view === 'kanban'
      ? kanbanHtml(g.tasks)
      : '<div class="list">' + g.tasks.map(listRowHtml).join('') + '</div>';
    return '<div class="group">' + head + body + '</div>';
  }

  function paintBoard() {
    var vis = visibleTasks();
    var el = $('board');
    if (!vis.length) {
      el.innerHTML = '<div class="empty-list">' + (state.tasks.length
        ? 'No matching tasks on ' + esc(nodeName()) + '. Try adjusting your filters.'
        : 'No tasks found on ' + esc(nodeName()) + '. Other hosts are not queried by this pane.')
        + '</div>';
    } else {
      el.innerHTML = groupsOf(vis).map(groupHtml).join('');
    }
    paintSummary(vis);
    // 🔴 The node is part of this sentence, not an optional decoration. "showing 470 of 470
    // tasks" with no host named is precisely how one node's numbers get read as the fleet's.
    $('counts').textContent = 'showing ' + vis.length + ' of ' + state.tasks.length
      + ' task' + (state.tasks.length === 1 ? '' : 's') + ' ' + onNodePhrase();
    reportHeight();
  }

  // The old page's summary box: counts over the FILTERED set (all numbers computed locally) —
  // and every one of them is one node's, so the box says whose.
  function paintSummary(vis) {
    var n = { pending: 0, in_progress: 0, completed: 0, other: 0 };
    vis.forEach(function (t) { if (n[t.status] === undefined) n.other++; else n[t.status]++; });
    $('summary').innerHTML = '<div class="s-total">' + vis.length + ' total tasks</div>'
      + '<div class="s-pending">' + n.pending + ' pending</div>'
      + '<div class="s-progress">' + n.in_progress + ' in progress</div>'
      + '<div class="s-done">' + n.completed + ' completed</div>'
      + (n.other ? '<div class="s-other">' + n.other + ' other</div>' : '')
      + '<div class="s-node">' + esc(onNodePhrase()) + '</div>';
  }

  // ── detail ────────────────────────────────────────────────────────────────
  function metaRow(label, value) {
    return value ? '<div><span class="k">' + esc(label) + ':</span> ' + esc(value) + '</div>' : '';
  }

  function depRowHtml(owner, depId, dir) {
    var d = depTask(owner, depId);
    var arrow = dir === 'by' ? '&#8592;' : '&#8594;';
    var cls = 'dep ' + (dir === 'by' ? 'dep-by' : 'dep-blk');
    if (!d) {
      return '<div class="' + cls + '"><span class="arw">' + arrow + '</span>'
        + '<span class="did">#' + esc(depId) + '</span>'
        + '<span class="dmiss">not in this session&#39;s list</span></div>';
    }
    return '<div class="' + cls + ' open" data-tk="' + esc(taskKey(d)) + '"><span class="arw">' + arrow + '</span>'
      + '<span class="did">#' + esc(d.id) + '</span>'
      + '<span class="dsub">' + esc(d.subject) + '</span>'
      + '<span class="pill st-' + esc(d.status) + '">' + esc(statusLabel(d.status)) + '</span></div>';
  }

  function depBlock(owner, ids, dir, title) {
    if (!ids || !ids.length) return '';
    return '<div class="d-sect"><h3>' + esc(title) + ' (' + ids.length + ')</h3>'
      + ids.map(function (id) { return depRowHtml(owner, id, dir); }).join('') + '</div>';
  }

  function paintDetail() {
    var el = $('detail');
    var t = findByKey(state.selectedKey);
    if (!t) {
      if (state.selectedKey) { state.selectedKey = null; }
      el.className = 'detail empty';
      el.textContent = 'Select a task to see its description, dependencies and context.';
      reportHeight();
      return;
    }
    el.className = 'detail';
    var noDesc = !t.description;
    el.innerHTML =
      '<h2 class="d-title">' + esc(t.subject) + '</h2>'
      + '<div class="d-idrow"><span class="d-id">#' + esc(t.id) + '</span>'
      + '<span class="pill st-' + esc(t.status) + '">' + esc(statusLabel(t.status)) + '</span>'
      + (isBlocked(t) ? '<span class="pill blockedpill">blocked</span>' : '') + '</div>'
      // Description is free text from the session, rendered as PLAIN TEXT pre-wrap — no md library.
      + '<pre class="desc' + (noDesc ? ' none' : '') + '">' + esc(noDesc ? '(no description)' : t.description) + '</pre>'
      + depBlock(t, t.blockedBy, 'by', 'Blocked By')
      + depBlock(t, t.blocks, 'blocks', 'Blocks')
      // The node row is NOT dropped: every task here belongs to one named host, and a reader
      // who opened a task deep in the board has scrolled the scope banner out of sight.
      + '<div class="d-sect"><h3>Context</h3><div class="d-meta">'
      + metaRow('node', nodeName())
      + metaRow('project', t.projectName)
      + metaRow('path', t.projectPath)
      + metaRow('session', t.sessionId)
      + metaRow('active form', t.activeForm)
      + metaRow('owner', t.owner)
      + '</div></div>';
    reportHeight();
  }

  function selectTask(k) {
    state.selectedKey = k;
    paintDetail();
    paintBoard();                                 // re-highlight the selected card/row
  }

  // ── load ──────────────────────────────────────────────────────────────────
  // First load failure is FATAL (there is nothing to show). A background refresh failure is
  // soft: the last good data stays on screen and the reason goes to the status line.
  function loadList(opts) {
    opts = opts || {};
    if (state.inflight) return Promise.resolve();
    state.inflight = true;
    if (!opts.background) $('board').innerHTML = 'loading…';
    return api('node', '/tasks/all').then(function (r) {
      state.inflight = false;
      if (!r.ok) {
        var m = r.error.code + ': ' + r.error.message;
        if (!state.loaded) { fatal(m); return; }
        say('refresh failed — ' + m + ' (showing data from ' + agoMs(state.loadedAt) + ')', true);
        return;
      }
      // data is the WRAPPER { tasks, total } — never a bare array.
      state.tasks = (r.data && Array.isArray(r.data.tasks)) ? r.data.tasks : [];
      state.loaded = true;
      state.loadedAt = Date.now();
      clearFatal();
      paintProjects();
      paintChips();
      paintBoard();
      paintDetail();                              // the open task may have changed or vanished
      paintUpdated();
      if (!opts.background) {
        say(state.tasks.length + ' task' + (state.tasks.length === 1 ? '' : 's')
          + ' loaded from ' + nodeName() + ' (this node only)');
      } else if ($('out') && $('out').classList.contains('err')) {
        say('refreshed — ' + state.tasks.length + ' tasks on ' + nodeName());
      }
    });
  }

  function paintUpdated() {
    $('updated').textContent = state.loadedAt ? 'updated ' + agoMs(state.loadedAt) : '';
  }

  // One ticker drives both the freshness label and the poll, so refreshes can never stack.
  setInterval(function () {
    paintUpdated();
    if (!state.auto || state.inflight) return;
    if (document.hidden) return;                  // a hidden pane does not poll
    if (Date.now() - state.loadedAt < REFRESH_MS) return;
    // Still unable to name the host? Retry that too — an unnamed pane is the misreading risk.
    if (state.node.phase !== 'ok') loadNode();
    loadList({ background: true });
  }, TICK_MS);

  // ── wiring (delegated: rows and cards are re-rendered wholesale on every paint) ──────────
  $('board').addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-tk]') : null;
    if (!el || !el.dataset.tk) return;
    selectTask(el.dataset.tk);
  });
  $('detail').addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('.dep.open') : null;
    if (!el || !el.dataset.tk) return;
    selectTask(el.dataset.tk);
  });
  $('chips-status').addEventListener('click', function (e) {
    if (e.target.dataset.fs === undefined) return;
    state.filter.status = e.target.dataset.fs; paintChips(); paintBoard();
  });
  $('chips-group').addEventListener('click', function (e) {
    if (e.target.dataset.fg === undefined) return;
    state.groupBy = e.target.dataset.fg; paintChips(); paintBoard();
  });
  $('chips-view').addEventListener('click', function (e) {
    if (e.target.dataset.fv === undefined) return;
    state.view = e.target.dataset.fv; paintChips(); paintBoard();
  });
  $('q').addEventListener('input', function (e) { state.filter.q = e.target.value; paintBoard(); });
  $('f-project').addEventListener('change', function (e) { state.filter.project = e.target.value; paintBoard(); });
  $('chk-auto').addEventListener('change', function (e) {
    state.auto = e.target.checked;
    say(state.auto ? 'auto-refresh on (every ' + (REFRESH_MS / 1000) + 's)' : 'auto-refresh off');
  });
  $('btn-refresh').addEventListener('click', function () { loadNode(); loadList(); });

  // Who is signed in (identity rides the session, not the view token).
  fetch('/auth/me', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
    $('who-name').textContent = (d.claims && (d.claims.name || d.claims.email)) || d.userId || 'signed in';
  }).catch(function () { $('who-name').textContent = 'signed in'; });

  // ── boot ────────────────────────────────────────────────────────────────
  paintChips();
  paintNode();          // paint the "identifying…" state before the fetch, never a blank scope
  loadNode();           // independent of loadList: neither blocks or fails the other
  loadList();
})();
