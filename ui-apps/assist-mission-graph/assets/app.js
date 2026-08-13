/* assist-mission-graph — the mission dependency/parent graph as a scoped pane. Plain JS, no
 * build, no deps, no charting library: the canvas is absolutely-positioned cards over an
 * inline <svg> edge layer inside one transformed stage (pan/zoom = a CSS transform).
 * Every data call goes through the injected SDK helper (lmui.call), which carries the view
 * token and re-mints it on 401/403.
 *
 * Paths + envelope shapes mirror core/src/routes/core/mission.routes.ts and the node
 * projection in core/src/mission/mission-traverse.ts (read, then curl-verified on :3200):
 *   GET  /mission/views              → data = { views:[...] }        (WRAPPER)
 *   GET  /mission/views/:id/graph    → data = { view, nodes, edges }  (view alongside, not nested)
 *   POST /mission/graph  {filter?,expand?} → data = { nodes, edges }
 *   POST /mission/schedule  {}       → data = { ready, blocked, serializeGroups, epicRollups, containers }
 *   GET  /mission/sessions           → data = { sessions:[{sid,missionId,role,transport}] }
 *   GET  /mission/:id                → data = the mission object BARE (no wrapper key)
 *   GET  /mission/:id/sessions       → data = { sessions:[...] }
 *   POST /mission/views {name,query,display} → data = the view object BARE (no {view} key)
 *
 * 🔴 /mission/graph and /mission/schedule are POST-ONLY READS. A GET does not 404 cleanly —
 * it falls through to GET /mission/:id, which treats the literal word as a mission id and
 * answers {success:false,error:{code:'NOT_FOUND',message:'no mission graph'}}. That reads
 * like "you have no missions" rather than "you used the wrong verb". Verified live.
 *
 * 🔴 Graph nodes carry only {id,title,status,tags,parentId} plus progressPercent ONLY when the
 * mission actually has progress.percent — toNode() emits undefined otherwise and JSON drops
 * the key. A card with no progress data shows an em-dash, never a fake 0%.
 *
 * The ONE write is POST /mission/views (save-as-view): additive, always creates a new named
 * view (no id is ever sent, so it can never overwrite one). Everything else is read-only. */
(function () {
  'use strict';

  // Vocabularies — order mirrors the source page's pickers (web/src/components/missions/dashboard/*).
  var STATUSES = ['active', 'waiting', 'paused', 'blocked', 'done', 'failed'];
  var DIRECTIONS = ['none', 'dependencies', 'dependents', 'children', 'parents', 'all'];
  var LAYOUTS = [
    ['clusters', 'Clusters', 'Related missions grouped; standalone in a grid'],
    ['hubs', 'Hubs', 'Most-connected mission centered in each group'],
    ['focus', 'Focus', 'Radial around the selected mission'],
    ['recent', 'Recent', 'Live/active missions surfaced first']
  ];
  var STATUS_COLOR = {
    active: '#34d399', waiting: '#fbbf24', paused: '#9ca3af', blocked: '#f87171',
    done: '#60a5fa', failed: '#ef4444', draft: '#6b7280'
  };
  var PALETTE = ['#60a5fa', '#f87171', '#34d399', '#fbbf24', '#a78bfa', '#fb923c',
    '#22d3ee', '#f472b6', '#a3e635', '#e879f9', '#2dd4bf', '#facc15'];
  var EDGE_DIM = '#475569', EDGE_HOT = '#3b82f6';

  // ── embedding + theme contract (identical to sibling panes) ───────────────
  var EMBEDDED = /[?&]embed=1\b/.test(location.search);
  if (EMBEDDED) document.body.classList.add('embed');
  var THEME = /[?&]theme=light/.test(location.search) ? 'light' : 'dark';
  if (THEME === 'light') document.body.classList.add('theme-light');

  // ── inbound deep link — the PINNED cross-pane param vocabulary ────────────
  // The entity's singular noun, unqualified: `mission` = a mission id. Plus the one generic
  // modifier this pane can honour: `q` = a prefill for its search box. (`tab` is not read —
  // this pane has no named sub-views; Views and Layout are user controls, not tabs.)
  //
  // 🔴 assist-missions' "Graph" button has ALWAYS sent lmui.goto('assist-mission-graph',
  // {mission:<id>}) — this file used to parse location.search for embed/theme only, so the
  // param arrived and was silently dropped and the button landed on an unfiltered graph every
  // time. A param that no target reads is a broken button, not a no-op.
  //
  // Clamped at the same 512-char ceiling lmui.goto enforces on the EMIT side, so a hand-typed
  // URL cannot push an unbounded string into the status line or the search box.
  function inboundParam(name) {
    try {
      var v = new URLSearchParams(location.search).get(name);
      return v == null ? '' : String(v).trim().slice(0, 512);
    } catch (e) { return ''; }          // no URLSearchParams / opaque origin → no deep link
  }
  var DEEP_MISSION = inboundParam('mission');
  var DEEP_Q = inboundParam('q');

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

  /** One rendering of a failed api() result, used everywhere a failure is shown. */
  function errText(r) { return r.error.code + ': ' + r.error.message; }

  // ── formatters ────────────────────────────────────────────────────────────
  // Epoch-ms only (mission history/timestamps are numbers). A FUTURE timestamp falls back to
  // the absolute date rather than reading "just now".
  function ago(ms) {
    var m = Math.floor((Date.now() - ms) / 60000);
    if (!isFinite(m) || m < 0 || !ms) return ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '—';
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    if (m < 1440) return Math.floor(m / 60) + 'h ago';
    return Math.floor(m / 1440) + 'd ago';
  }
  // A mission with NO progress data shows an em-dash, never a fake "0%" (a genuine 0 renders "0%").
  function fmtPct(p) { return p == null ? '—' : p + '%'; }
  // Own-property lookup only: `status` is server data, and a bare STATUS_COLOR[status] would
  // return Object.prototype members for a status literally named "constructor"/"toString".
  function statusColor(s) {
    return Object.prototype.hasOwnProperty.call(STATUS_COLOR, s) ? STATUS_COLOR[s] : '#6b7280';
  }

  // ── state ─────────────────────────────────────────────────────────────────
  var state = {
    views: [],                     // MissionView[] from GET /mission/views → data.views
    activeViewId: null,            // a saved view's id, or null = ad-hoc
    view: null,                    // the view object returned ALONGSIDE a view-sourced graph
    nodes: [],                     // data.nodes — {id,title,status,tags,parentId,progressPercent?}
    edges: [],                     // data.edges — {from,to,type:'parent'|'dependsOn'}
    schedule: null,                // POST /mission/schedule → ready/blocked/serializeGroups/epicRollups
    liveIds: new Set(),            // missionIds with a live session (GET /mission/sessions)
    selected: null,                // selected node id
    mission: null,                 // GET /mission/:id → the mission BARE
    sessions: [],                  // GET /mission/:id/sessions → data.sessions
    // tags is a null-prototype map: dimension names come from the server, and a dimension
    // literally named "__proto__" on a plain {} would not become an own key.
    filter: { statuses: [], tags: Object.create(null), q: '' },   // client-side chips + search
    expand: { direction: 'none', depth: 1 },     // server-side expansion
    strategy: 'clusters',
    layout: null,                  // last computed layout (positions + bounds)
    vis: [],                       // visible nodes after filter+search
    visEdges: [],
    zoom: 1,
    pan: { x: 0, y: 0 },
    // 🔴 Per-source LOAD OUTCOME, kept next to the data it describes. Without these, every
    // "empty" render is ambiguous: an empty views list, a graph with no nodes and a detail
    // panel with no fields all look identical whether the server answered "nothing here" or
    // "you may not read this". A denial is NOT an empty collection — each renderer below
    // consults its own flag and says which one it is.
    viewsState: 'loading',         // 'loading' | 'ok' | 'error'
    viewsError: null,
    liveError: null,               // GET /mission/sessions failed → live dots are UNKNOWN, not absent
    scheduleError: null,           // POST /mission/schedule failed → ready/blocked is UNKNOWN
    graphError: null,              // the primary graph call failed → the canvas has no data to show
    missionError: null,            // GET /mission/:id failed for the SELECTED mission
    sessionsError: null            // GET /mission/:id/sessions failed for the SELECTED mission
  };

  // ── status line ───────────────────────────────────────────────────────────
  // 🔴 The status line used to be ONE overwrite target, and loadAll() fires loadViews +
  // loadSessions + loadSchedule and THEN loadGraph — so a views 403 was deterministically
  // erased milliseconds later by "loaded 19 missions, 24 edges". An error a SIBLING call's
  // success can delete is an error nobody ever reads. So failures are now held per SOURCE and
  // survive until that same source loads cleanly; say() only rewrites the transient
  // last-action line printed beneath them.
  var status = { line: 'ready', lineErr: false, lineTag: null, problems: [] };   // problems: [{src,msg}]

  function renderStatus() {
    var out = $('out');
    if (!out) return;
    var lines = status.problems.map(function (p) { return '⚠ ' + p.msg; });
    lines.push(status.line);
    out.textContent = lines.join('\n');
    out.classList.toggle('err', status.lineErr || status.problems.length > 0);
    reportHeight();
  }
  function problemIndex(src) {
    for (var i = 0; i < status.problems.length; i++) if (status.problems[i].src === src) return i;
    return -1;
  }
  /** Record a durable failure for one data source. Cleared ONLY by clearProblem(src). */
  function problem(src, msg) {
    var i = problemIndex(src);
    if (i === -1) status.problems.push({ src: src, msg: msg });
    else status.problems[i].msg = msg;
    renderStatus();
  }
  function clearProblem(src) {
    var i = problemIndex(src);
    if (i !== -1) { status.problems.splice(i, 1); renderStatus(); }
  }
  /** The transient line: what the last action did. Never erases a recorded problem.
   *  `tag` identifies who wrote it, so a later success can replace ITS OWN stale error line
   *  without stepping on an unrelated message (a deep-link notice, say). */
  function say(msg, isErr, tag) {
    status.line = typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2);
    status.lineErr = !!isErr;
    status.lineTag = tag || null;
    renderStatus();
  }

  // A hard failure of the primary data call: cover the screen with the server's own text.
  function fatal(message) {
    var old = $('fatal-layer');
    if (old) old.remove();
    var d = document.createElement('div');
    d.className = 'fatal';
    d.id = 'fatal-layer';
    d.innerHTML = '<div class="fatal-card"><div class="fatal-h">Mission graph could not be loaded</div>'
      + '<pre class="fatal-msg"></pre><button class="primary" id="fatal-retry">Retry</button></div>';
    d.querySelector('.fatal-msg').textContent = message;   // textContent — server text is NOT trusted HTML
    document.body.appendChild(d);
    $('fatal-retry').onclick = function () { d.remove(); loadGraph(); };
    reportHeight();
  }
  function clearFatal() { var o = $('fatal-layer'); if (o) o.remove(); }

  // ── graph math (ported from web/src/lib/mission-layout.ts + mission-graph-adapter.ts) ──
  var NODE_W = 200, NODE_H = 76, GAP = 28, NODE_GAP = 24, LAYER_GAP = 80;
  var MIN_ZOOM = 0.05, MAX_ZOOM = 3;
  // The zoom a deep-link landing will not go BELOW. Fitting the whole graph is not landing:
  // at ~20 nodes the fitted zoom is well under 0.5, where a 200px card is an unreadable speck.
  var FOCUS_ZOOM = 0.9;

  /** Deterministic color for a groupBy tag value. */
  function colorForGroup(value) {
    var h = 0;
    for (var i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  /** Union-find connected components over the UNDIRECTED edge set. Singletons = size-1 groups. */
  function components(ids, edges) {
    var parent = new Map(), i;
    for (i = 0; i < ids.length; i++) parent.set(ids[i], ids[i]);
    function find(x) {
      var r = x;
      while (parent.get(r) !== r) r = parent.get(r);
      while (parent.get(x) !== r) { var n = parent.get(x); parent.set(x, r); x = n; }
      return r;
    }
    for (i = 0; i < edges.length; i++) {
      var e = edges[i];
      if (!parent.has(e.from) || !parent.has(e.to)) continue;
      var ra = find(e.from), rb = find(e.to);
      if (ra !== rb) parent.set(ra, rb);
    }
    var groups = new Map();
    for (i = 0; i < ids.length; i++) {
      var r = find(ids[i]);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(ids[i]);
    }
    var out = [];
    groups.forEach(function (g) { out.push(g); });
    return out;
  }

  function highestDegree(ids, edges) {
    var idSet = new Set(ids), deg = new Map();
    ids.forEach(function (id) { deg.set(id, 0); });
    edges.forEach(function (e) {
      if (!idSet.has(e.from) || !idSet.has(e.to)) return;
      deg.set(e.from, deg.get(e.from) + 1);
      deg.set(e.to, deg.get(e.to) + 1);
    });
    var best = ids[0], bd = -1;
    ids.forEach(function (id) { var d = deg.get(id); if (d > bd) { bd = d; best = id; } });
    return best;
  }

  /** Left→right layered flow: BFS layering by in-degree, wide layers wrapped into sub-columns.
   *  Cycles and unreachable nodes land in a final catch-all layer (never dropped). */
  function layoutFlow(ids, edges) {
    var idSet = new Set(ids), indeg = new Map(), adj = new Map();
    ids.forEach(function (id) { indeg.set(id, 0); adj.set(id, []); });
    edges.forEach(function (e) {
      if (!idSet.has(e.from) || !idSet.has(e.to)) return;
      adj.get(e.from).push(e.to);
      indeg.set(e.to, indeg.get(e.to) + 1);
    });
    var layers = [], visited = new Set();
    var queue = ids.filter(function (id) { return indeg.get(id) === 0; });
    while (queue.length) {
      layers.push(queue.slice());
      queue.forEach(function (id) { visited.add(id); });
      var next = [];
      queue.forEach(function (id) {
        adj.get(id).forEach(function (c) {
          if (visited.has(c)) return;
          var rem = indeg.get(c) - 1;
          indeg.set(c, rem);
          if (rem <= 0 && next.indexOf(c) === -1) next.push(c);
        });
      });
      queue = next;
    }
    var left = ids.filter(function (id) { return !visited.has(id); });
    if (left.length) layers.push(left);

    var maxLayer = 1;
    layers.forEach(function (l) { maxLayer = Math.max(maxLayer, l.length); });
    var perCol = maxLayer <= 6 ? maxLayer : Math.max(4, Math.ceil(Math.sqrt(maxLayer * 1.5)));
    var grid = layers.map(function (l) {
      return l.length <= perCol
        ? { subCols: 1, rows: l.length }
        : { subCols: Math.ceil(l.length / perCol), rows: Math.min(l.length, perCol) };
    });
    var starts = [0], i;
    for (i = 1; i < layers.length; i++) {
      var p = grid[i - 1];
      starts.push(starts[i - 1] + p.subCols * NODE_W + (p.subCols - 1) * NODE_GAP + LAYER_GAP);
    }
    var maxRows = 1;
    grid.forEach(function (g) { maxRows = Math.max(maxRows, g.rows); });
    var crossAll = maxRows * NODE_H + (maxRows - 1) * NODE_GAP;

    var pos = new Map();
    layers.forEach(function (layer, li) {
      var g = grid[li];
      var size = g.rows * NODE_H + (g.rows - 1) * NODE_GAP;
      var crossStart = Math.max(0, (crossAll - size) / 2);
      layer.forEach(function (id, ni) {
        pos.set(id, {
          x: starts[li] + Math.floor(ni / perCol) * (NODE_W + NODE_GAP),
          y: crossStart + (ni % perCol) * (NODE_H + NODE_GAP)
        });
      });
    });
    var last = grid[grid.length - 1];
    return {
      pos: pos,
      w: starts[starts.length - 1] + last.subCols * NODE_W + (last.subCols - 1) * NODE_GAP,
      h: crossAll
    };
  }

  /** Radial: centerId in the middle, others on concentric rings by hop distance. */
  function layoutRadial(ids, edges, centerId) {
    var idSet = new Set(ids), adj = new Map();
    ids.forEach(function (id) { adj.set(id, []); });
    edges.forEach(function (e) {
      if (!idSet.has(e.from) || !idSet.has(e.to)) return;
      adj.get(e.from).push(e.to);
      adj.get(e.to).push(e.from);
    });
    var ring = new Map([[centerId, 0]]);
    var frontier = [centerId], seen = new Set([centerId]);
    while (frontier.length) {
      var next = [];
      frontier.forEach(function (u) {
        adj.get(u).forEach(function (v) {
          if (seen.has(v)) return;
          seen.add(v); ring.set(v, ring.get(u) + 1); next.push(v);
        });
      });
      frontier = next;
    }
    var maxRing = 0;
    ring.forEach(function (r) { maxRing = Math.max(maxRing, r); });
    ids.forEach(function (id) { if (!ring.has(id)) ring.set(id, maxRing + 1); }); // disconnected guard
    maxRing = 0;
    ring.forEach(function (r) { maxRing = Math.max(maxRing, r); });

    var byRing = new Map();
    ids.forEach(function (id) {
      var r = ring.get(id);
      if (!byRing.has(r)) byRing.set(r, []);
      byRing.get(r).push(id);
    });
    // Ring radii grow by at least `step`, but a CROWDED ring is pushed out far enough that its
    // circumference fits every card. The source page used a flat r*step, so a hub with ~10+
    // neighbours drew them on top of each other (reproduced on live data: 3 overlapping pairs).
    var step = Math.max(NODE_W, NODE_H) + GAP + 40;
    var radii = [0], r2;
    for (r2 = 1; r2 <= maxRing; r2++) {
      var n = (byRing.get(r2) || []).length;
      radii[r2] = Math.max(radii[r2 - 1] + step, n > 1 ? (n * (NODE_W + GAP)) / (2 * Math.PI) : 0);
    }
    var c = radii[maxRing] + Math.max(NODE_W, NODE_H);
    var pos = new Map();
    byRing.forEach(function (members, r) {
      if (r === 0) { pos.set(members[0], { x: c - NODE_W / 2, y: c - NODE_H / 2 }); return; }
      var radius = radii[r];
      members.forEach(function (id, i) {
        var ang = (2 * Math.PI * i) / members.length - Math.PI / 2;
        pos.set(id, { x: c + radius * Math.cos(ang) - NODE_W / 2, y: c + radius * Math.sin(ang) - NODE_H / 2 });
      });
    });
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pos.forEach(function (p) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + NODE_W); maxY = Math.max(maxY, p.y + NODE_H);
    });
    pos.forEach(function (p) { p.x -= minX; p.y -= minY; });
    return { pos: pos, w: maxX - minX, h: maxY - minY };
  }

  /** Pack standalone missions into a sqrt-ish grid. */
  function layoutSingletons(ids) {
    var cols = Math.max(1, Math.ceil(Math.sqrt(ids.length)));
    var pos = new Map();
    ids.forEach(function (id, i) {
      pos.set(id, { x: (i % cols) * (NODE_W + GAP), y: Math.floor(i / cols) * (NODE_H + GAP) });
    });
    var rows = Math.ceil(ids.length / cols);
    return { pos: pos, w: cols * NODE_W + (cols - 1) * GAP, h: rows * NODE_H + (rows - 1) * GAP };
  }

  /** Shelf bin-pack blocks left→right, wrapping at a target width derived from total area. */
  function packBlocks(blocks) {
    var total = 0;
    blocks.forEach(function (b) { total += b.w * b.h; });
    var targetW = Math.max(800, Math.sqrt(total * 1.6));
    var positions = new Map();
    var x = 0, y = 0, rowH = 0, maxW = 0;
    blocks.forEach(function (b) {
      if (x > 0 && x + b.w > targetW) { x = 0; y += rowH + GAP * 2; rowH = 0; }
      var bx = x, by = y;
      b.pos.forEach(function (p, id) { positions.set(id, { x: bx + p.x, y: by + p.y }); });
      x += b.w + GAP * 2;
      rowH = Math.max(rowH, b.h);
      maxW = Math.max(maxW, x - GAP * 2);
    });
    return { positions: positions, width: maxW, height: y + rowH };
  }

  function computeLayout(nodes, edges, strategy, selectedId, liveIds) {
    var ids = nodes.map(function (n) { return n.id; });
    if (!ids.length) return { positions: new Map(), width: 0, height: 0, dimmed: null };
    var comps = components(ids, edges);
    var multi = comps.filter(function (c) { return c.length > 1; });
    var singles = comps.filter(function (c) { return c.length === 1; }).map(function (c) { return c[0]; });
    var dimmed = new Set();

    var focusComp = null;
    if (strategy === 'focus' && selectedId) {
      for (var i = 0; i < multi.length; i++) if (multi[i].indexOf(selectedId) !== -1) { focusComp = multi[i]; break; }
      if (!focusComp && singles.indexOf(selectedId) !== -1) focusComp = [selectedId];
    }

    var blocks = multi.map(function (comp) {
      var b;
      if (strategy === 'hubs') b = layoutRadial(comp, edges, highestDegree(comp, edges));
      else if (focusComp && comp === focusComp) b = layoutRadial(comp, edges, selectedId);
      else b = layoutFlow(comp, edges);
      var live = 0;
      comp.forEach(function (id) { if (liveIds.has(id)) live += 1; });
      b.ids = comp; b.live = live;
      return b;
    });

    // ordering: clusters = size desc, focus = focused first, recent = live-then-size
    if (focusComp) {
      blocks.sort(function (a, b) {
        return (b.ids === focusComp ? 1 : 0) - (a.ids === focusComp ? 1 : 0) || b.ids.length - a.ids.length;
      });
    } else if (strategy === 'recent') {
      blocks.sort(function (a, b) {
        return (b.live > 0 ? 1 : 0) - (a.live > 0 ? 1 : 0) || b.live - a.live || b.ids.length - a.ids.length;
      });
    } else {
      blocks.sort(function (a, b) { return b.ids.length - a.ids.length; });
    }

    if (focusComp) {
      var fs = new Set(focusComp);
      ids.forEach(function (id) { if (!fs.has(id)) dimmed.add(id); });
    }
    var ordered = blocks.slice();
    if (singles.length) ordered.push(layoutSingletons(singles));

    var packed = packBlocks(ordered);
    var pad = 20, out = new Map();
    packed.positions.forEach(function (p, id) { out.set(id, { x: p.x + pad, y: p.y + pad }); });
    return {
      positions: out,
      width: packed.width + pad * 2,
      height: packed.height + pad * 2,
      dimmed: dimmed.size ? dimmed : null
    };
  }

  /** Given matching ids, return them plus every node in the same connected component. */
  function expandToComponents(ids, edges, matchIds) {
    var out = new Set();
    components(ids, edges).forEach(function (comp) {
      for (var i = 0; i < comp.length; i++) {
        if (matchIds.has(comp[i])) { comp.forEach(function (id) { out.add(id); }); return; }
      }
    });
    return out;
  }

  /** Space-separated terms ANDed; each matches case-insensitively over title/id/status/tag values. */
  function matchesSearch(n, query) {
    var q = query.trim().toLowerCase();
    if (!q) return true;
    var vals = [];
    Object.keys(n.tags || {}).forEach(function (d) { vals = vals.concat(n.tags[d] || []); });
    var hay = ((n.title || '') + ' ' + n.id + ' ' + (n.status || '') + ' ' + vals.join(' ')).toLowerCase();
    return q.split(/\s+/).every(function (t) { return hay.indexOf(t) !== -1; });
  }

  function passChips(n) {
    var f = state.filter;
    if (f.statuses.length && f.statuses.indexOf(n.status) === -1) return false;
    var dims = Object.keys(f.tags), i;
    for (i = 0; i < dims.length; i++) {
      var want = f.tags[dims[i]];
      if (!want.length) continue;
      var have = (n.tags || {})[dims[i]] || [];
      var hit = want.some(function (v) { return have.indexOf(v) !== -1; });
      if (!hit) return false;
    }
    return true;
  }

  /** A subset of the server ops, for a saved view's display.highlight. */
  function matchesHighlight(n, filter) {
    return filter.every(function (f) {
      var v = f.field.indexOf('tags.') === 0 ? (n.tags || {})[f.field.slice(5)] : n[f.field];
      var isArr = Array.isArray(v);
      switch (f.op) {
        case 'eq': return v === f.value;
        case 'ne': return v !== f.value;
        case 'exists': return (isArr ? v.length > 0 : v != null) === Boolean(f.value);
        case 'contains': return isArr ? v.indexOf(f.value) !== -1
          : (typeof v === 'string' && typeof f.value === 'string' && v.toLowerCase().indexOf(f.value.toLowerCase()) !== -1);
        case 'in': return Array.isArray(f.value) && (isArr ? v.some(function (x) { return f.value.indexOf(x) !== -1; }) : f.value.indexOf(v) !== -1);
        default: return true;   // unknown op → don't exclude
      }
    });
  }

  /** Friendly chip state → the server's MissionFilter[] + expand. */
  function buildFilter() {
    var filter = [];
    if (state.filter.statuses.length) filter.push({ field: 'status', op: 'in', value: state.filter.statuses.slice() });
    Object.keys(state.filter.tags).forEach(function (dim) {
      if (state.filter.tags[dim].length) filter.push({ field: 'tags.' + dim, op: 'in', value: state.filter.tags[dim].slice() });
    });
    var dir = state.expand.direction;
    return { filter: filter, expand: dir && dir !== 'none' ? { direction: dir, depth: state.expand.depth } : undefined };
  }

  // ── sidebar rendering ─────────────────────────────────────────────────────
  function paintViews() {
    var html = '<div class="vrow' + (state.activeViewId === null ? ' on' : '') + '" data-vid="">All missions (ad-hoc)</div>';
    html += state.views.map(function (v) {
      return '<div class="vrow' + (state.activeViewId === v.id ? ' on' : '') + '" data-vid="' + esc(v.id) + '" title="' + esc(v.id) + '">' + esc(v.name || v.id) + '</div>';
    }).join('');
    // 🔴 Three distinct outcomes, three distinct renders. "No saved views yet" is a claim about
    // the SERVER'S data and may only be made when the server actually answered.
    if (state.viewsState === 'error') {
      html += '<div class="load-err">Saved views could not be loaded — ' + esc(state.viewsError || 'unknown error')
        + '<button id="views-retry" class="ghost sm">Retry</button></div>';
    } else if (state.viewsState === 'loading') {
      html += '<div class="hint">loading…</div>';
    } else if (!state.views.length) {
      html += '<div class="hint">No saved views yet — filter the graph, then “Save as view”.</div>';
    }
    $('views').innerHTML = html;
    var retry = $('views-retry');
    if (retry) retry.onclick = function (e) {
      e.stopPropagation();                       // the row-click delegate must not read this as a view pick
      state.viewsState = 'loading';
      paintViews();
      loadViews();
    };
  }

  function paintChips() {
    var present = new Set();
    state.nodes.forEach(function (n) { present.add(n.status); });
    // "no missions" is a statement about loaded data — with no loaded graph it would be a guess.
    var noChips = state.graphError
      ? '<span class="warn">graph not loaded — status filters unavailable</span>'
      : '<span class="hint">no missions</span>';
    $('chips-status').innerHTML = STATUSES.filter(function (s) { return present.has(s); }).map(function (s) {
      return '<span class="fchip' + (state.filter.statuses.indexOf(s) !== -1 ? ' on' : '') + '" data-fs="' + esc(s) + '">' + esc(s) + '</span>';
    }).join('') || noChips;

    var dims = new Map();
    state.nodes.forEach(function (n) {
      Object.keys(n.tags || {}).forEach(function (dim) {
        if (!dims.has(dim)) dims.set(dim, new Set());
        (n.tags[dim] || []).forEach(function (v) { dims.get(dim).add(v); });
      });
    });
    var rows = [];
    Array.from(dims.keys()).sort().forEach(function (dim) {
      var vals = Array.from(dims.get(dim)).sort();
      var on = state.filter.tags[dim] || [];
      rows.push('<div class="chip-row"><span class="chip-lbl">' + esc(dim) + '</span><span class="chips">'
        + vals.map(function (v) {
          return '<span class="fchip' + (on.indexOf(v) !== -1 ? ' on' : '') + '" data-fd="' + esc(dim) + '" data-fv="' + esc(v) + '">' + esc(v) + '</span>';
        }).join('') + '</span></div>');
    });
    $('tagdims').innerHTML = rows.join('');
  }

  function paintPickers() {
    // A saved view carries its OWN query.expand, so the server source is the view and these
    // controls would be dead. Disable them rather than let them look wired-up (the source page
    // silently ignored them here — same precedence, made visible).
    var viewActive = !!state.activeViewId;
    $('x-dir').disabled = viewActive;
    $('x-depth').disabled = viewActive;
    $('x-note').hidden = !viewActive;
    $('x-dir').innerHTML = DIRECTIONS.map(function (d) {
      return '<option value="' + esc(d) + '"' + (state.expand.direction === d ? ' selected' : '') + '>' + esc(d) + '</option>';
    }).join('');
    var dep = $('x-depth');
    dep.hidden = state.expand.direction === 'none';
    dep.innerHTML = [1, 2, 3].map(function (d) {
      return '<option value="' + d + '"' + (state.expand.depth === d ? ' selected' : '') + '>depth ' + d + '</option>';
    }).join('');
    $('lay').innerHTML = LAYOUTS.map(function (o) {
      return '<option value="' + esc(o[0]) + '"' + (state.strategy === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
    }).join('');
    var active = LAYOUTS.filter(function (o) { return o[0] === state.strategy; })[0];
    $('lay-hint').textContent = active ? active[2] : '';
    $('lay-warn').hidden = !(state.strategy === 'focus' && !state.selected);
  }

  // ── canvas ────────────────────────────────────────────────────────────────
  /** Point on a card's border toward (tx,ty), so edges meet card edges, not centers. */
  function borderPoint(x, y, tx, ty) {
    var cx = x + NODE_W / 2, cy = y + NODE_H / 2, dx = tx - cx, dy = ty - cy;
    if (dx === 0 && dy === 0) return { x: cx, y: cy };
    var sx = dx !== 0 ? (NODE_W / 2) / Math.abs(dx) : Infinity;
    var sy = dy !== 0 ? (NODE_H / 2) / Math.abs(dy) : Infinity;
    var s = Math.min(sx, sy);
    return { x: cx + dx * s, y: cy + dy * s };
  }

  function relCounts() {
    var m = new Map();
    function get(id) {
      if (!m.has(id)) m.set(id, { deps: 0, children: 0, dependents: 0 });
      return m.get(id);
    }
    state.visEdges.forEach(function (e) {
      if (e.type === 'parent') get(e.from).children += 1;
      else { get(e.from).deps += 1; get(e.to).dependents += 1; }
    });
    return m;
  }

  function cardHtml(n, p, rels, connected, display) {
    var t = n.tags || {};
    var groupBy = display && display.groupBy;
    var majorTag;
    if (groupBy) majorTag = (t[groupBy] || [])[0];
    else {
      var dim = Object.keys(t).filter(function (d) { return d.indexOf('ctl:') !== 0; })[0];
      majorTag = dim ? (t[dim] || [])[0] : undefined;
    }
    var accent = (groupBy ? colorForGroup((t[groupBy] || [])[0] || '∅') : null) || statusColor(n.status);
    var dim2 = (state.layout.dimmed && state.layout.dimmed.has(n.id))
      || (connected && !connected.has(n.id))
      || (display && display.highlight && display.highlight.length ? !matchesHighlight(n, display.highlight) : false);
    var sel = n.id === state.selected;

    var fields = (display && display.nodeFields && display.nodeFields.length) ? display.nodeFields : ['status', 'progress'];
    var meta = fields.map(function (f) {
      var v = f === 'status' ? n.status : f === 'progress' ? fmtPct(n.progressPercent) : (n[f] == null ? '' : String(n[f]));
      return '<span>' + esc(v) + '</span>';
    }).join('');
    if (majorTag) meta += '<span class="c-tag">' + esc(majorTag) + '</span>';

    var parts = [];
    if (n.parentId) parts.push('↑parent');
    if (rels.deps) parts.push('⛓' + rels.deps);
    if (rels.children) parts.push('▽' + rels.children);
    if (rels.dependents) parts.push(rels.dependents + 'blk');

    return '<div class="card' + (sel ? ' sel' : '') + (dim2 ? ' dim' : '') + '" data-nid="' + esc(n.id) + '"'
      + ' title="' + esc((n.title || n.id) + ' — ' + n.id) + '"'
      + ' style="left:' + Math.round(p.x) + 'px;top:' + Math.round(p.y) + 'px;width:' + NODE_W + 'px;height:' + NODE_H + 'px;'
      + 'border-color:' + (sel ? '#ffffff' : esc(accent)) + ';border-left-color:' + esc(accent) + '">'
      + '<div class="c-top">' + (state.liveIds.has(n.id) ? '<span class="live"></span>' : '') + '<span class="c-title">' + esc(n.title || n.id) + '</span></div>'
      + '<div class="c-meta">' + meta + '</div>'
      + (parts.length ? '<div class="c-rel">' + esc(parts.join(' · ')) + '</div>' : '')
      + '</div>';
  }

  function paintCanvas() {
    var msg = $('cv-msg');
    if (!state.vis.length) {
      $('cards').innerHTML = '';
      $('edge-g').innerHTML = '';
      state.layout = null;             // so a queued fitToView cannot fit a layout that is gone
      msg.hidden = false;
      // A failed graph call must never render as "No missions on this node yet" — that is the
      // pane inventing an answer the server refused to give.
      msg.textContent = state.graphError
        ? 'Graph could not be loaded — ' + state.graphError
        : (state.nodes.length ? 'No missions match this view.' : 'No missions on this node yet.');
      paintCounts();
      reportHeight();
      return;
    }
    msg.hidden = true;

    state.layout = computeLayout(state.vis, state.visEdges, state.strategy, state.selected, state.liveIds);
    var pos = state.layout.positions;

    // 1-hop neighborhood of the selection — click-to-isolate dimming + edge emphasis.
    var connected = null;
    if (state.selected) {
      connected = new Set([state.selected]);
      state.visEdges.forEach(function (e) {
        if (e.from === state.selected) connected.add(e.to);
        if (e.to === state.selected) connected.add(e.from);
      });
    }

    var display = state.view && state.view.display ? state.view.display : null;
    var rels = relCounts();
    var lines = state.visEdges.map(function (e) {
      var a = pos.get(e.from), b = pos.get(e.to);
      if (!a || !b) return '';
      var p1 = borderPoint(a.x, a.y, b.x + NODE_W / 2, b.y + NODE_H / 2);
      var p2 = borderPoint(b.x, b.y, a.x + NODE_W / 2, a.y + NODE_H / 2);
      var hot = !!state.selected && (e.from === state.selected || e.to === state.selected);
      return '<line x1="' + p1.x.toFixed(1) + '" y1="' + p1.y.toFixed(1) + '" x2="' + p2.x.toFixed(1) + '" y2="' + p2.y.toFixed(1) + '"'
        + ' stroke="' + (hot ? EDGE_HOT : EDGE_DIM) + '" stroke-width="' + (hot ? 2 : 1.2) + '"'
        + ' stroke-opacity="' + (hot ? 0.95 : (state.selected ? 0.12 : 0.5)) + '"'
        + ' marker-end="url(#mg-arrow)"></line>';
    }).join('');

    var svg = $('edges');
    svg.setAttribute('width', String(Math.ceil(state.layout.width)));
    svg.setAttribute('height', String(Math.ceil(state.layout.height)));
    $('edge-g').innerHTML = lines;

    $('cards').innerHTML = state.vis.map(function (n) {
      var p = pos.get(n.id);
      return p ? cardHtml(n, p, rels.get(n.id) || { deps: 0, children: 0, dependents: 0 }, connected, display) : '';
    }).join('');

    var stage = $('stage');
    stage.style.width = Math.ceil(state.layout.width) + 'px';
    stage.style.height = Math.ceil(state.layout.height) + 'px';
    applyTransform();
    paintCounts();
    reportHeight();
  }

  function applyTransform() {
    $('stage').style.transform = 'translate(' + state.pan.x + 'px,' + state.pan.y + 'px) scale(' + state.zoom + ')';
    $('zoom-pct').textContent = Math.round(state.zoom * 100) + '%';
  }

  function fitToView() {
    var el = $('canvas');
    if (!state.layout || !state.layout.width) return;
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    var z = Math.min(Math.max(Math.min((r.width - 20) / state.layout.width, (r.height - 20) / state.layout.height), MIN_ZOOM), MAX_ZOOM);
    state.zoom = z;
    state.pan = {
      x: Math.max(0, (r.width - state.layout.width * z) / 2),
      y: Math.max(0, (r.height - state.layout.height * z) / 2)
    };
    applyTransform();
  }

  /** Put ONE mission's card in the middle of the viewport — how a deep link actually "lands".
   *  Returns false when the id has no position, i.e. the current search/filter excludes it,
   *  so the caller can say so instead of leaving the viewport somewhere arbitrary. */
  function centerOn(id) {
    if (!state.layout || !state.layout.positions) return false;
    var p = state.layout.positions.get(id);
    if (!p) return false;
    var r = $('canvas').getBoundingClientRect();
    if (!r.width || !r.height) return false;
    // Never zoom OUT to land: keep whatever the fit chose when it is already legible.
    var z = Math.min(MAX_ZOOM, Math.max(state.zoom, FOCUS_ZOOM));
    state.zoom = z;
    state.pan = {
      x: r.width / 2 - (p.x + NODE_W / 2) * z,
      y: r.height / 2 - (p.y + NODE_H / 2) * z
    };
    applyTransform();
    return true;
  }

  function zoomAt(factor, fx, fy) {
    var nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, state.zoom * factor));
    var ratio = nz / state.zoom;
    state.pan = { x: fx - (fx - state.pan.x) * ratio, y: fy - (fy - state.pan.y) * ratio };
    state.zoom = nz;
    applyTransform();
  }

  function paintCounts() {
    var bits = state.graphError
      ? 'graph not loaded'
      : state.vis.length + ' shown / ' + state.nodes.length + ' total';
    var v = state.views.filter(function (x) { return x.id === state.activeViewId; })[0];
    bits += ' · ' + (v ? (v.name || v.id) : 'ad-hoc filter');
    if (state.view && state.view.display && state.view.display.groupBy) bits += ' · grouped by ' + state.view.display.groupBy;
    if (state.expand.direction !== 'none') bits += ' · expand ' + state.expand.direction + ' d' + state.expand.depth;
    // No green dot can mean "nothing live" OR "the live-session call was refused" — say which.
    if (state.liveError) bits += ' · live sessions unknown';
    $('counts').textContent = bits;
  }

  // ── selection + detail ────────────────────────────────────────────────────
  /** True when the SERVER already applied the status/tag narrowing, so the chips must not be
   *  re-applied on the client. A saved view is always server-sourced by its own query. */
  function serverFiltered() { return !state.activeViewId && state.expand.direction !== 'none'; }

  function recompute() {
    var base = serverFiltered() ? state.nodes : state.nodes.filter(passChips);
    var matched = base.filter(function (n) { return matchesSearch(n, state.filter.q); });
    if (!state.filter.q.trim()) {
      state.vis = matched;
    } else {
      // search active → reveal each match's whole connected group (over the FULL edge set)
      var ids = state.nodes.map(function (n) { return n.id; });
      var reveal = expandToComponents(ids, state.edges, new Set(matched.map(function (n) { return n.id; })));
      state.vis = state.nodes.filter(function (n) { return reveal.has(n.id); });
    }
    var visible = new Set(state.vis.map(function (n) { return n.id; }));
    state.visEdges = state.edges.filter(function (e) { return visible.has(e.from) && visible.has(e.to); });
    paintCanvas();
  }

  function metaRow(label, value) {
    return value ? '<div><span class="k">' + esc(label) + ':</span> ' + esc(value) + '</div>' : '';
  }
  function chipBtn(id) {
    return '<button class="idchip" data-goto="' + esc(id) + '" title="' + esc(id) + '">' + esc(id) + '</button>';
  }
  function section(title, body) {
    return body ? '<div class="d-sect"><h3>' + esc(title) + '</h3>' + body + '</div>' : '';
  }

  function scheduleLine(id) {
    var s = state.schedule;
    if (!s) return '';
    var blocked = (s.blocked || []).filter(function (b) { return b.id === id; })[0];
    if (blocked) {
      return 'Blocked: ' + blocked.reason + (blocked.waitOn && blocked.waitOn.length ? ' (waiting on ' + blocked.waitOn.join(', ') + ')' : '');
    }
    if ((s.ready || []).indexOf(id) !== -1) return 'Ready';
    var epic = (s.epicRollups || []).filter(function (r) { return r.parentId === id; })[0];
    if (epic) return 'Epic: ' + epic.doneCount + '/' + epic.childCount + ' done';
    var serial = (s.serializeGroups || []).filter(function (g) { return (g.missionIds || []).indexOf(id) !== -1; })[0];
    if (serial) return 'Serialized in "' + serial.group + '"' + (serial.running && serial.running !== id ? ' (queued)' : '');
    return '';
  }

  function paintDetail() {
    var el = $('detail');
    if (!state.selected) {
      el.className = 'detail empty';
      el.textContent = 'Select a mission in the graph to see its objective, plan, tags, relationships and recent changes.';
      reportHeight();
      return;
    }
    el.className = 'detail';
    var id = state.selected;
    var m = state.mission;
    var node = state.nodes.filter(function (n) { return n.id === id; })[0];
    var status = (m && m.status) || (node && node.status) || '…';
    var color = statusColor(status);

    // relationships: children/dependents from the loaded edges, parent/dependsOn from the mission
    var children = [], dependents = [];
    state.edges.forEach(function (e) {
      if (e.type === 'parent' && e.from === id) children.push(e.to);
      if (e.type === 'dependsOn' && e.to === id) dependents.push(e.from);
    });
    var parentId = m ? m.parentId : (node ? node.parentId : null);
    var dependsOn = (m && m.dependsOn) || [];

    var relBody = '';
    if (parentId) relBody += '<div class="rel-row"><span class="k">parent:</span> ' + chipBtn(parentId) + '</div>';
    if (dependsOn.length) relBody += '<div class="rel-row"><span class="k">depends on:</span> ' + dependsOn.map(chipBtn).join('') + '</div>';
    if (dependents.length) relBody += '<div class="rel-row"><span class="k">blocks:</span> ' + dependents.map(chipBtn).join('') + '</div>';
    if (children.length) relBody += '<div class="rel-row"><span class="k">children:</span> ' + children.map(chipBtn).join('') + '</div>';

    var tags = (m && m.tags) || (node && node.tags) || {};
    var tagBody = Object.keys(tags).map(function (dim) {
      var ctl = dim.indexOf('ctl:') === 0;
      return '<div class="rel-row"><span class="' + (ctl ? 'k ctl' : 'k') + '">' + esc(dim) + (ctl ? ' (controller)' : '') + ':</span> '
        + (tags[dim] || []).map(function (v) { return '<span class="tagv">' + esc(v) + '</span>'; }).join('') + '</div>';
    }).join('');

    var hist = (m && m.history) || [];
    var histBody = hist.slice(-5).reverse().map(function (h) {
      var who = (h.actor && (h.actor.label || h.actor.kind)) || 'unknown';
      return '<div>r' + esc(h.rev) + ' · ' + esc(who) + ' · ' + esc(ago(h.at)) + ' · ' + esc(Object.keys(h.changes || {}).join(', ')) + '</div>';
    }).join('');

    var sessBody = state.sessions.map(function (s) {
      return '<div>' + esc(String(s.sid || '').slice(0, 12)) + ' · ' + esc(s.kind || s.role || '') + '</div>';
    }).join('');
    // An empty Sessions section reads as "no sessions"; when the call was refused, say so.
    var sessSection = state.sessionsError
      ? '<div class="load-err">Sessions could not be loaded — ' + esc(state.sessionsError) + '</div>'
      : (sessBody ? '<div class="d-hist">' + sessBody + '</div>' : '');

    var pct = m && m.progress && m.progress.percent != null ? m.progress.percent : (node ? node.progressPercent : null);
    var sched = scheduleLine(id);

    el.innerHTML =
      '<div class="d-head"><h2 class="d-title">' + esc((m && m.title) || (node && node.title) || id) + '</h2>'
      + '<button id="d-close" class="ghost sm" title="Clear selection">✕</button></div>'
      + '<div class="d-idrow"><span class="d-id">' + esc(id) + '</span></div>'
      + '<div class="d-pills"><span class="pill" style="color:' + color + ';border-color:' + color + '">' + esc(status) + '</span>'
      + (pct != null ? '<span class="pill">' + esc(fmtPct(pct)) + '</span>' : '')
      + (sched ? '<span class="pill sched">' + esc(sched) + '</span>' : '')
      + (state.scheduleError && !sched ? '<span class="pill bad" title="' + esc(state.scheduleError) + '">schedule unknown</span>' : '')
      + (state.liveIds.has(id) ? '<span class="pill live-pill">live session</span>' : '')
      + (state.liveError ? '<span class="pill bad" title="' + esc(state.liveError) + '">live state unknown</span>' : '')
      + '</div>'
      // 🔴 The three states of the mission fetch are now distinct. Before, the error branch of
      // select() only wrote the status line and returned — it never repainted — so a refused
      // GET /mission/:id left this panel on "loading…" for as long as the pane stayed open.
      // A failed load renders an error with a Retry, never a permanent spinner.
      + (state.missionError
        ? '<div class="load-err">Details could not be loaded — ' + esc(state.missionError)
          + '<button id="d-retry" class="ghost sm">Retry</button></div>'
        : (!m ? '<div class="hint">loading…</div>' : ''))
      + section('Objective', m && m.objective ? '<div class="d-desc">' + esc(m.objective) + '</div>' : '')
      + section('Plan', m && m.plan ? '<pre class="mono">' + esc(m.plan) + '</pre>' : '')
      + section('Next steps', m && m.nextSteps && m.nextSteps.length
        ? '<ul class="steps">' + m.nextSteps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>' : '')
      + section('Tags', tagBody)
      + section('Relationships', relBody)
      + section('Recent changes', histBody ? '<div class="d-hist">' + histBody + '</div>' : '')
      + section('Sessions', sessSection)
      + '<button id="d-open" class="link blue open-link">Open in Missions →</button>';

    $('d-close').onclick = function () { select(null); };
    // Cross-pane nav goes through the shim — a pane never builds another pane's URL.
    $('d-open').onclick = function () { lmui.goto('assist-missions', { mission: id }); };
    var retry = $('d-retry');
    if (retry) retry.onclick = function () {
      state.missionError = null;
      state.sessionsError = null;
      paintDetail();                       // back to "loading…" for the duration of the retry
      loadMissionDetail(id);
      loadMissionSessions(id);
    };
    reportHeight();
  }

  /** Keep the address bar naming what the pane is showing, so a reload — or a link copied out
   *  of it — lands back on the same mission. It REWRITES only the two params this pane owns and
   *  preserves every other one verbatim: `embed`/`theme` are the serving contract, and `lt`/
   *  `code`/`token`/`returnTo` are reserved by the serving tier (see NAV_RESERVED in lmui.js).
   *  Rebuilding the query from a whitelist would drop them. */
  function syncUrl() {
    try {
      var p = new URLSearchParams(location.search);
      if (state.selected) p.set('mission', state.selected); else p.delete('mission');
      var q = state.filter.q.trim();
      if (q) p.set('q', q); else p.delete('q');
      var s = p.toString();
      history.replaceState(null, '', location.pathname + (s ? '?' + s : ''));
    } catch (e) { /* sandboxed frame / opaque origin — state.selected stays the source of truth */ }
  }

  /** GET /mission/:id → the detail panel's body. EVERY outcome repaints. */
  function loadMissionDetail(id) {
    return api('node', '/mission/' + encodeURIComponent(id)).then(function (r) {
      if (state.selected !== id) return;                 // a newer click already superseded this
      if (!r.ok) {
        state.mission = null;
        state.missionError = errText(r);
        problem('mission', 'mission ' + id + ' failed to load — ' + state.missionError);
        say('open ' + id + ' failed — ' + state.missionError, true, 'mission:' + id);
        paintDetail();                                   // ← the repaint the old error branch skipped
        return;
      }
      state.mission = r.data || null;                    // data is the mission BARE
      state.missionError = null;
      clearProblem('mission');
      // Retry succeeded → drop the stale "open … failed" line this same load wrote. Tag-matched
      // so it can only ever replace its OWN message.
      if (status.lineTag === 'mission:' + id) say('mission ' + id + ' loaded', false, 'mission:' + id);
      paintDetail();
    });
  }

  /** GET /mission/:id/sessions → the Sessions section. A refusal is shown IN that section. */
  function loadMissionSessions(id) {
    return api('node', '/mission/' + encodeURIComponent(id) + '/sessions').then(function (r) {
      if (state.selected !== id) return;
      if (!r.ok) {
        state.sessions = [];
        state.sessionsError = errText(r);
        paintDetail();
        return;
      }
      state.sessions = Array.isArray(r.data) ? r.data : ((r.data && r.data.sessions) || []);
      state.sessionsError = null;
      paintDetail();
    });
  }

  function select(id) {
    state.selected = id;
    state.mission = null;
    state.sessions = [];
    // The previous selection's failures describe a mission we are no longer showing.
    state.missionError = null;
    state.sessionsError = null;
    clearProblem('mission');
    syncUrl();
    paintPickers();       // the focus-layout warning depends on having a selection
    paintCanvas();
    // Only "focus" re-lays-out around the selection, so only it needs a re-fit; re-fitting on
    // every click (what the source page's memo did) yanks the viewport out from under you.
    if (state.strategy === 'focus') requestAnimationFrame(fitToView);
    paintDetail();
    if (!id) return;
    loadMissionDetail(id);
    loadMissionSessions(id);
  }

  /** Land on the inbound `?mission=<id>`: select it (detail panel + 1-hop emphasis) and bring
   *  its card into view. Every outcome is REPORTED — a deep link that quietly does nothing is
   *  the exact defect this reads the param to fix. The layout strategy is deliberately NOT
   *  switched to "focus": that re-arranges the whole graph, and a user control is not something
   *  an inbound link should flip under the user. */
  function focusMission(id) {
    if (!state.nodes.some(function (n) { return n.id === id; })) {
      say('deep link: mission ' + id + ' is not in this graph', true);
      return;
    }
    select(id);
    // loadGraph queues its auto-fit with requestAnimationFrame, and select() queues one too
    // under the "focus" strategy. Queueing the centering HERE puts it last in the same frame's
    // callback list, so neither fit re-frames the viewport on top of the landing.
    requestAnimationFrame(function () {
      if (centerOn(id)) say('deep link: focused mission ' + id);
      else say('deep link: mission ' + id + ' is selected but hidden by the current search — clear it to see the card', true);
    });
  }

  // ── loaders ───────────────────────────────────────────────────────────────
  function loadViews() {
    return api('node', '/mission/views').then(function (r) {
      if (!r.ok) {
        // 🔴 A DENIAL is not an empty list. Record it so paintViews renders "could not be
        // loaded" instead of the friendly "No saved views yet" — which is what a 403 used to
        // look like, i.e. the pane telling the user a lie about their own data.
        state.views = [];
        state.viewsState = 'error';
        state.viewsError = errText(r);
        problem('views', 'saved views failed to load — ' + state.viewsError);
      } else {
        state.views = (r.data && Array.isArray(r.data.views)) ? r.data.views : [];   // WRAPPER {views}
        state.viewsState = 'ok';
        state.viewsError = null;
        clearProblem('views');
      }
      paintViews();
    });
  }

  // Live-session badges. Decoration, but a failure means the live dots are UNKNOWN — which is
  // not the same as "nothing is live", so it is recorded rather than swallowed.
  function loadSessions() {
    return api('node', '/mission/sessions').then(function (r) {
      if (!r.ok) {
        state.liveIds = new Set();
        state.liveError = errText(r);
        problem('sessions', 'live sessions unknown — ' + state.liveError);
        return;
      }
      var ids = new Set();
      if (r.data && Array.isArray(r.data.sessions)) {
        r.data.sessions.forEach(function (s) { if (s.missionId) ids.add(s.missionId); });
      }
      state.liveIds = ids;
      state.liveError = null;
      clearProblem('sessions');
    });
  }

  // POST, not GET — see the header note. Decorates the detail panel; a failure means the
  // ready/blocked line is unknown, so it is recorded rather than rendered as "not blocked".
  function loadSchedule() {
    return api('node', '/mission/schedule', { method: 'POST', body: {} }).then(function (r) {
      if (!r.ok) {
        state.schedule = null;
        state.scheduleError = errText(r);
        problem('schedule', 'schedule unknown — ' + state.scheduleError);
        return;
      }
      state.schedule = r.data || null;
      state.scheduleError = null;
      clearProblem('schedule');
    });
  }

  function loadGraph() {
    clearFatal();
    $('cv-msg').hidden = false;
    $('cv-msg').textContent = 'loading…';
    var req;
    if (state.activeViewId) {
      req = api('node', '/mission/views/' + encodeURIComponent(state.activeViewId) + '/graph');
    } else {
      var b = buildFilter();
      // Ad-hoc with no server expansion → ask for everything and narrow on the client.
      var body = state.expand.direction !== 'none' ? { filter: b.filter, expand: b.expand } : {};
      req = api('node', '/mission/graph', { method: 'POST', body: body });
    }
    return req.then(function (r) {
      // Resolves false on failure so a queued deep-link landing does not report "not in this
      // graph" — which would be a lie — over a graph that never loaded at all.
      if (!r.ok) {
        state.graphError = errText(r);
        problem('graph', 'graph failed to load — ' + state.graphError);
        // The canvas must not sit on "loading…" behind the overlay (nor, once the overlay is
        // dismissed by Retry, claim "No missions on this node yet" — that is a denial dressed
        // up as an empty node).
        var m = $('cv-msg');
        m.hidden = false;
        m.textContent = 'Graph could not be loaded — ' + state.graphError;
        paintChips();
        paintCounts();
        fatal(errText(r));
        return false;
      }
      state.graphError = null;
      clearProblem('graph');
      var d = r.data || {};
      state.view = d.view || null;                       // present ONLY on the view-sourced route
      state.nodes = Array.isArray(d.nodes) ? d.nodes : [];
      state.edges = Array.isArray(d.edges) ? d.edges : [];
      if (state.selected && !state.nodes.some(function (n) { return n.id === state.selected; })) {
        state.selected = null; state.mission = null; state.sessions = [];
        paintDetail();
      }
      paintChips();
      recompute();
      requestAnimationFrame(fitToView);                  // auto-fit whenever the graph changes
      say('loaded ' + state.nodes.length + ' mission' + (state.nodes.length === 1 ? '' : 's')
        + ', ' + state.edges.length + ' edge' + (state.edges.length === 1 ? '' : 's'));
      return true;
    });
  }

  function loadAll() {
    return Promise.all([loadViews(), loadSessions(), loadSchedule()]).then(loadGraph);
  }

  // ── the one write: save the current filter as a named view ────────────────
  function saveView() {
    var name = $('save-name').value.trim();
    if (!name) { say('view name is required', true); $('save-name').focus(); return; }
    var b = buildFilter();
    var body = {
      name: name,
      query: { filter: b.filter, expand: b.expand },
      display: (state.view && state.view.display) || {}
    };
    // No `id` is ever sent — this always CREATES; it can never overwrite an existing view.
    $('save-go').disabled = true;
    clearProblem('save');                                // this attempt supersedes the last one
    say('saving view "' + name + '"…');
    api('node', '/mission/views', { method: 'POST', body: body }).then(function (r) {
      $('save-go').disabled = false;
      if (!r.ok) {
        // This route is leader-anchored and fails CLOSED — an unreachable leader is a hard error.
        // Sticky: a WRITE that did not happen must not be erased by the next background reload.
        problem('save', 'save view "' + name + '" failed — ' + errText(r));
        say('save view failed — ' + errText(r), true);
        return;
      }
      var v = r.data || {};                              // data is the view object BARE
      $('save-box').hidden = true;
      $('save-name').value = '';
      say('saved view "' + (v.name || name) + '" (' + (v.id || '?') + ')');
      loadViews();
    });
  }

  /** Clear the local narrowing (chips, search, expand). Shared by Reset and view selection. */
  function clearLocalFilter() {
    state.filter = { statuses: [], tags: Object.create(null), q: '' };
    state.expand = { direction: 'none', depth: 1 };
    $('q').value = '';
  }

  function resetFilter() {
    state.activeViewId = null;
    state.view = null;
    clearLocalFilter();
    paintViews();
    paintChips();
    paintPickers();
    loadGraph();
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  $('views').addEventListener('click', function (e) {
    var row = e.target.closest ? e.target.closest('.vrow') : null;
    if (!row || row.dataset.vid === undefined) return;
    var id = row.dataset.vid || null;
    // Selecting a view resets the local narrowing, exactly like the source page.
    state.activeViewId = id;
    state.view = null;
    state.selected = null; state.mission = null; state.sessions = [];
    clearLocalFilter();
    paintViews(); paintPickers(); paintDetail();
    loadGraph();
  });
  $('views-refresh').addEventListener('click', function () { loadAll(); });
  $('refresh').addEventListener('click', function () { loadAll(); });

  $('q').addEventListener('input', function (e) { state.filter.q = e.target.value; syncUrl(); recompute(); });

  $('chips-status').addEventListener('click', function (e) {
    var s = e.target.dataset ? e.target.dataset.fs : undefined;
    if (s === undefined) return;
    var i = state.filter.statuses.indexOf(s);
    if (i === -1) state.filter.statuses.push(s); else state.filter.statuses.splice(i, 1);
    paintChips();
    if (serverFiltered()) loadGraph(); else recompute();   // server-side expansion → re-query
  });
  $('tagdims').addEventListener('click', function (e) {
    var d = e.target.dataset ? e.target.dataset.fd : undefined;
    if (d === undefined) return;
    var v = e.target.dataset.fv;
    var cur = state.filter.tags[d] || [];
    var i = cur.indexOf(v);
    if (i === -1) cur.push(v); else cur.splice(i, 1);
    if (cur.length) state.filter.tags[d] = cur; else delete state.filter.tags[d];
    paintChips();
    if (serverFiltered()) loadGraph(); else recompute();
  });
  $('f-reset').addEventListener('click', resetFilter);
  $('f-save').addEventListener('click', function () {
    var box = $('save-box');
    box.hidden = !box.hidden;
    if (!box.hidden) $('save-name').focus();
    reportHeight();
  });
  $('save-go').addEventListener('click', saveView);
  $('save-cancel').addEventListener('click', function () { $('save-box').hidden = true; reportHeight(); });
  $('save-name').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); saveView(); } });

  $('x-dir').addEventListener('change', function (e) {
    state.expand.direction = e.target.value;
    paintPickers();
    loadGraph();
  });
  $('x-depth').addEventListener('change', function (e) {
    state.expand.depth = Number(e.target.value) || 1;
    loadGraph();
  });
  $('lay').addEventListener('change', function (e) {
    state.strategy = e.target.value;
    paintPickers();
    paintCanvas();
    requestAnimationFrame(fitToView);
  });

  // Canvas: click to select (a drag must not count as a click), pan, zoom, fit.
  var drag = { on: false, moved: false, x: 0, y: 0, px: 0, py: 0 };
  var pinch = null;

  $('cards').addEventListener('click', function (e) {
    if (drag.moved) return;
    var card = e.target.closest ? e.target.closest('.card') : null;
    if (!card || !card.dataset.nid) return;
    select(card.dataset.nid === state.selected ? null : card.dataset.nid);
  });
  $('detail').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-goto]') : null;
    if (!b) return;
    select(b.dataset.goto);
  });

  var cv = $('canvas');
  cv.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    drag = { on: true, moved: false, x: e.clientX, y: e.clientY, px: state.pan.x, py: state.pan.y };
  });
  cv.addEventListener('mousemove', function (e) {
    if (!drag.on) return;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) drag.moved = true;
    state.pan = { x: drag.px + dx, y: drag.py + dy };
    applyTransform();
  });
  function endDrag() { drag.on = false; setTimeout(function () { drag.moved = false; }, 0); }
  cv.addEventListener('mouseup', endDrag);
  cv.addEventListener('mouseleave', endDrag);
  cv.addEventListener('dblclick', fitToView);
  cv.addEventListener('wheel', function (e) {
    e.preventDefault();
    var r = cv.getBoundingClientRect();
    zoomAt(e.deltaY > 0 ? 0.9 : 1.1, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  function touchDist(t) { return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY); }
  cv.addEventListener('touchstart', function (e) {
    var r = cv.getBoundingClientRect();
    if (e.touches.length === 2) {
      drag.on = false;
      pinch = {
        dist: touchDist(e.touches), zoom: state.zoom,
        cx: (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left,
        cy: (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top
      };
    } else if (e.touches.length === 1) {
      drag = { on: true, moved: false, x: e.touches[0].clientX, y: e.touches[0].clientY, px: state.pan.x, py: state.pan.y };
    }
  }, { passive: false });
  cv.addEventListener('touchmove', function (e) {
    if (e.touches.length === 2 && pinch && pinch.dist) {
      e.preventDefault();
      var nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pinch.zoom * (touchDist(e.touches) / pinch.dist)));
      var ratio = nz / state.zoom;
      state.pan = { x: pinch.cx - (pinch.cx - state.pan.x) * ratio, y: pinch.cy - (pinch.cy - state.pan.y) * ratio };
      state.zoom = nz;
      applyTransform();
    } else if (e.touches.length === 1 && drag.on) {
      e.preventDefault();
      var dx = e.touches[0].clientX - drag.x, dy = e.touches[0].clientY - drag.y;
      if (!drag.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) drag.moved = true;
      state.pan = { x: drag.px + dx, y: drag.py + dy };
      applyTransform();
    }
  }, { passive: false });
  cv.addEventListener('touchend', function (e) {
    if (e.touches.length < 2) pinch = null;
    if (e.touches.length === 0) endDrag();
  }, { passive: false });

  $('zoom-in').addEventListener('click', function () { var r = cv.getBoundingClientRect(); zoomAt(1.2, r.width / 2, r.height / 2); });
  $('zoom-out').addEventListener('click', function () { var r = cv.getBoundingClientRect(); zoomAt(0.8, r.width / 2, r.height / 2); });
  $('zoom-fit').addEventListener('click', fitToView);

  // Who is signed in (identity rides the session, not the view token).
  fetch('/auth/me', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
    $('who-name').textContent = (d.claims && (d.claims.name || d.claims.email)) || d.userId || 'signed in';
  }).catch(function () { $('who-name').textContent = 'signed in'; });

  // ── boot ──────────────────────────────────────────────────────────────────
  // `?q=` is applied BEFORE the first load, so the very first paint already honours it rather
  // than painting the whole graph and then narrowing it.
  if (DEEP_Q) { state.filter.q = DEEP_Q; $('q').value = DEEP_Q; }
  paintPickers();
  // `?mission=` needs the graph in hand — it can only be selected once the nodes exist, and the
  // landing must run after loadGraph's auto-fit rather than be erased by it.
  loadAll().then(function (loaded) {
    if (loaded && DEEP_MISSION) focusMission(DEEP_MISSION);
  });
})();
