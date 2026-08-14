/* assist-backlog — the backlog registry as a scoped pane. Plain JS, no build, no deps.
 * Every data call goes through the injected SDK helper (lmui.call), which carries the
 * view token and re-mints it on 401/403. The declared grant is three exact leaf rules
 * (see README + lmui.config.json) covering list, detail, graph, create, update, discuss.
 *
 * Enums, paths and envelope shapes mirror core/src/routes/core/backlog.routes.ts and
 * core/src/mcp-server/registry/backlog-model.ts — kept in sync by hand (see verify test). */
(function () {
  'use strict';

  // Enum vocabularies (backlog-model.ts). Order matches the model's arrays.
  var TYPES = ['idea', 'feature', 'issue', 'bug', 'task'];
  var STATUSES = ['open', 'discussing', 'accepted', 'deferred', 'rejected', 'planned', 'implemented'];
  var PRIORITIES = ['low', 'med', 'high', 'critical'];

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

  function ago(ms) {
    var m = Math.floor((Date.now() - ms) / 60000);
    if (!isFinite(m) || m < 0 || !ms) return ms ? new Date(ms).toISOString() : '—';
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    if (m < 1440) return Math.floor(m / 60) + 'h ago';
    return Math.floor(m / 1440) + 'd ago';
  }

  // ── state ───────────────────────────────────────────────────────────────
  var state = {
    items: [],                                   // toListRow[] from GET /backlog
    selected: null,                              // full item (toApiItem) from GET /backlog/:id
    editing: null,                               // id being edited, or null = create mode
    filter: { status: '', type: '', text: '' },  // client-side; '' = all
    showRemoved: false,
  };

  function say(msg, isErr) {
    var out = $('out');
    out.textContent = typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2);
    out.classList.toggle('err', !!isErr);
  }

  // A hard failure of the primary data call: cover the screen with the server's own text.
  function fatal(message) {
    var old = $('fatal-layer');
    if (old) old.remove();
    var d = document.createElement('div');
    d.className = 'fatal';
    d.id = 'fatal-layer';
    d.innerHTML = '<div class="fatal-card"><div class="fatal-h">Backlog could not be loaded</div>'
      + '<pre class="fatal-msg"></pre><button class="primary" id="fatal-retry">Retry</button></div>';
    d.querySelector('.fatal-msg').textContent = message;
    document.body.appendChild(d);
    $('fatal-retry').onclick = function () { d.remove(); loadList(); };
    reportHeight();
  }

  // ── filter chips (values are model constants, not user data) ──────────────
  function paintChips() {
    var s = ['<span class="fchip' + (state.filter.status ? '' : ' on') + '" data-fs="">all</span>'];
    STATUSES.forEach(function (v) { s.push('<span class="fchip' + (state.filter.status === v ? ' on' : '') + '" data-fs="' + v + '">' + v + '</span>'); });
    $('chips-status').innerHTML = s.join('');
    var t = ['<span class="fchip' + (state.filter.type ? '' : ' on') + '" data-ft="">all</span>'];
    TYPES.forEach(function (v) { t.push('<span class="fchip' + (state.filter.type === v ? ' on' : '') + '" data-ft="' + v + '">' + v + '</span>'); });
    $('chips-type').innerHTML = t.join('');
  }

  // ── list ────────────────────────────────────────────────────────────────
  function visibleItems() {
    var f = state.filter, q = f.text.trim().toLowerCase();
    return state.items.filter(function (it) {
      if (f.status && it.status !== f.status) return false;
      if (f.type && it.type !== f.type) return false;
      if (q) {
        var hay = (it.title + ' ' + it.id + ' ' + (it.tags || []).join(' ')).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
  }

  function rowHtml(it) {
    var sel = state.selected && state.selected.id === it.id ? ' sel' : '';
    var rm = it.removed ? ' rm' : '';
    var c = it.counts || {};
    var meta = '<span class="pill ty">' + esc(it.type) + '</span>'
      + '<span class="pill st-' + esc(it.status) + '">' + esc(it.status) + '</span>'
      + '<span class="pill pr-' + esc(it.priority) + '">' + esc(it.priority) + '</span>'
      + '<span class="rid">' + esc(it.id) + '</span>';
    if (c.edges) meta += '<span class="rid">·' + c.edges + ' edge' + (c.edges === 1 ? '' : 's') + '</span>';
    if (c.discussion) meta += '<span class="rid">·' + c.discussion + ' note' + (c.discussion === 1 ? '' : 's') + '</span>';
    return '<div class="row' + sel + rm + '" data-id="' + esc(it.id) + '">'
      + '<div class="rt">' + esc(it.title) + '</div>'
      + '<div class="rmeta">' + meta + '</div></div>';
  }

  function paintList() {
    var vis = visibleItems();
    $('list').innerHTML = vis.length
      ? vis.map(rowHtml).join('')
      : '<div class="empty-list">No items match the current filter.</div>';
  }

  function loadList() {
    var qs = state.showRemoved ? '?includeRemoved=true' : '';
    return api('node', '/backlog' + qs).then(function (r) {
      if (!r.ok) { fatal(r.error.code + ': ' + r.error.message); return; }
      var data = r.data || {};
      state.items = data.items || [];
      paintChips();
      paintList();
      var c = data.counts || {};
      $('counts').textContent = 'showing ' + visibleItems().length + ' of ' + (c.total != null ? c.total : state.items.length)
        + ' item' + (state.items.length === 1 ? '' : 's') + (c.removed ? ' · ' + c.removed + ' removed' : '');
      reportHeight();
    });
  }

  // ── detail ────────────────────────────────────────────────────────────────
  function openItem(id) {
    return api('node', '/backlog/' + encodeURIComponent(id)).then(function (r) {
      if (!r.ok) { say(r.error.code + ': ' + r.error.message, true); return; }
      state.selected = (r.data && r.data.item) || null;
      paintDetail();
      paintList();                                 // re-highlight the selected row
      $('note-target').textContent = state.selected ? 'on ' + state.selected.id : 'no item selected';
      reportHeight();
    });
  }

  function listBlock(cls, title, rows) {
    if (!rows.length) return '';
    return '<div class="d-sect"><h3>' + esc(title) + ' (' + rows.length + ')</h3>' + rows.join('') + '</div>';
  }

  function paintDetail() {
    var it = state.selected;
    var el = $('detail');
    if (!it) { el.className = 'detail empty'; el.textContent = 'Select an item on the left, or fill the form to create one.'; return; }
    el.className = 'detail';
    var edges = (it.edges || []).map(function (e) {
      return '<div class="edge" data-open="' + esc(e.to) + '"><span class="pill kind">' + esc(e.kind) + '</span><span class="to">' + esc(e.to) + ' ↗</span></div>';
    });
    var disc = (it.discussion || []).slice().reverse().map(function (d) {
      return '<div class="disc"><div class="meta"><span class="pill kind">' + esc(d.sessionKind) + '</span>'
        + '<span>' + esc(d.label || d.sessionId) + '</span><span>' + esc(ago(d.at)) + '</span></div>'
        + '<div class="note">' + esc(d.note) + '</div></div>';
    });
    var revs = (it.reviews || []).slice().reverse().map(function (v) {
      return '<div class="rev"><div class="meta"><span class="pill vd-' + esc(v.verdict) + '">' + esc(v.verdict) + '</span>'
        + '<span>' + esc(v.by) + '</span><span>' + esc(ago(v.at)) + '</span></div>'
        + (v.note ? '<div class="note">' + esc(v.note) + '</div>' : '') + '</div>';
    });
    var histN = (it.history || []).length;
    var tags = (it.tags || []).map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('');
    var descNone = !it.description;
    el.innerHTML =
      '<h2 class="d-title">' + esc(it.title) + '</h2>'
      + '<div class="d-idrow"><span class="d-id">' + esc(it.id) + ' · rev ' + esc(it.rev) + '</span>'
      + '<button class="ghost" id="d-edit">edit</button></div>'
      + '<div class="d-pills"><span class="pill ty">' + esc(it.type) + '</span>'
      + '<span class="pill st-' + esc(it.status) + '">' + esc(it.status) + '</span>'
      + '<span class="pill pr-' + esc(it.priority) + '">' + esc(it.priority) + '</span>'
      + (it.removed ? '<span class="pill vd-reject">removed</span>' : '') + '</div>'
      + (tags ? '<div style="margin-bottom:.6rem">' + tags + '</div>' : '')
      // Description is markdown but rendered as PLAIN TEXT, pre-wrap — no md library.
      + '<pre class="desc' + (descNone ? ' none' : '') + '">' + esc(descNone ? '(no description)' : it.description) + '</pre>'
      + '<div class="d-counts"><b>' + (it.edges || []).length + '</b> edges · <b>' + (it.discussion || []).length
      + '</b> discussion · <b>' + (it.reviews || []).length + '</b> reviews · <b>' + histN + '</b> history'
      + ' · updated ' + esc(ago(it.updatedAt)) + '</div>'
      + listBlock('edge', 'Edges', edges)
      + listBlock('disc', 'Discussion', disc)
      + listBlock('rev', 'Reviews', revs);
    $('d-edit').onclick = function () { fillForm(it); };
  }

  // ── form (create / edit) ────────────────────────────────────────────────
  function fillSelect(sel, values, current) {
    sel.innerHTML = values.map(function (v) {
      return '<option value="' + esc(v) + '"' + (v === current ? ' selected' : '') + '>' + esc(v) + '</option>';
    }).join('');
  }

  function resetForm() {
    state.editing = null;
    $('form-title').textContent = 'New item';
    $('f-title').value = '';
    $('f-desc').value = '';
    fillSelect($('f-type'), TYPES, 'idea');
    fillSelect($('f-priority'), PRIORITIES, 'med');
    fillSelect($('f-status'), STATUSES, 'open');
    $('f-submit').textContent = 'Create';
    $('form-new').hidden = true;
    reportHeight();
  }

  function fillForm(it) {
    state.editing = it.id;
    $('form-title').textContent = 'Edit ' + it.id;
    $('f-title').value = it.title || '';
    $('f-desc').value = it.description || '';
    fillSelect($('f-type'), TYPES, it.type);
    fillSelect($('f-priority'), PRIORITIES, it.priority);
    fillSelect($('f-status'), STATUSES, it.status);
    $('f-submit').textContent = 'Save changes';
    $('form-new').hidden = false;
    reportHeight();
  }

  function submitForm() {
    var title = $('f-title').value.trim();
    if (!title) { say('title is required', true); return; }
    var body = {
      title: title,
      description: $('f-desc').value,
      type: $('f-type').value,
      priority: $('f-priority').value,
      status: $('f-status').value,
    };
    var editing = state.editing;
    var path = editing ? '/backlog/' + encodeURIComponent(editing) : '/backlog';
    $('f-submit').disabled = true;
    api('node', path, { method: 'POST', body: body }).then(function (r) {
      $('f-submit').disabled = false;
      if (!r.ok) { say((editing ? 'update' : 'create') + ' failed — ' + r.error.code + ': ' + r.error.message, true); return; }
      var item = r.data && r.data.item;
      var changed = r.data && r.data.changed;
      say((editing ? 'saved ' : 'created ') + (item ? item.id : '') + (changed === false ? ' (no change)' : ''));
      G.loaded = false;                          // graph refetches on next view
      if (!editing) resetForm();
      loadList().then(function () { if (item) openItem(item.id); });
    });
  }

  function addNote() {
    if (!state.selected) { say('select an item before adding a note', true); return; }
    var note = $('n-note').value.trim();
    if (!note) { say('note is empty', true); return; }
    var id = state.selected.id;
    $('n-add').disabled = true;
    // Attribute the note to the web pane (SESSION_KINDS includes 'web'); the route accepts
    // an explicit session and otherwise attributes it to a coarse 'api' actor.
    api('node', '/backlog/' + encodeURIComponent(id) + '/discuss', {
      method: 'POST', body: { note: note, session: { id: 'assist-backlog', kind: 'web', label: 'Backlog pane' } },
    }).then(function (r) {
      $('n-add').disabled = false;
      if (!r.ok) { say('note failed — ' + r.error.code + ': ' + r.error.message, true); return; }
      $('n-note').value = '';
      say('note added to ' + id);
      G.loaded = false;                          // note count shows on the graph card
      openItem(id);
      loadList();
    });
  }

  // ── graph view (GET /backlog/graph → deterministic layout → card/edge stage) ──
  // House pattern: layout math + the cards-over-an-SVG-edge-layer stage are ported from
  // assist-mission-graph (itself ported from web/src/lib/mission-layout.ts), so every
  // graph pane lays out and feels the same. Pan/zoom is a CSS transform on ONE stage.
  // Backlog-specific: typed edges (kind → color/dash, directed kinds get a per-kind
  // arrow marker) and status-accented cards sized NODE_W×NODE_H.
  var NODE_W = 200, NODE_H = 66, GAP = 28, NODE_GAP = 24, LAYER_GAP = 80;
  var MIN_ZOOM = 0.05, MAX_ZOOM = 3;
  var G = {
    nodes: [], edges: [], byId: {},
    loaded: false, includeRemoved: false, sel: null,
    strategy: 'hubs',                  // hubs = radial per component; clusters = layered flow
    layout: null, pan: { x: 0, y: 0 }, zoom: 1, seq: 0,
  };
  var STATUS_COLOR = {
    open: '#94a3b8', discussing: '#94a3b8', accepted: '#60a5fa', planned: '#3b82f6',
    implemented: '#4ade80', deferred: '#fbbf24', rejected: '#f87171',
  };
  // Edge palette: pastels for the dark canvas, 600-series for light (thin lines need the
  // contrast; card accents above are 4px and read fine on both). Markers + legend share it.
  var KIND_COLOR = THEME === 'light'
    ? { 'depends-on': '#2563eb', 'blocks': '#b91c1c', 'parent-of': '#475569', 'relates-to': '#64748b', 'duplicate-of': '#b45309', 'spawned-mission': '#7c3aed' }
    : { 'depends-on': '#60a5fa', 'blocks': '#f87171', 'parent-of': '#94a3b8', 'relates-to': '#64748b', 'duplicate-of': '#fbbf24', 'spawned-mission': '#c084fc' };
  var KIND_DASH = { 'relates-to': '5 4', 'duplicate-of': '2 3', 'spawned-mission': '6 3' };
  var DIRECTED = { 'depends-on': 1, 'blocks': 1, 'parent-of': 1, 'spawned-mission': 1 };
  // Own-property lookup only: status/kind are server data — a bare MAP[k] returns
  // Object.prototype members for k='constructor' etc., and these feed attribute markup.
  function own(map, k, dflt) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : dflt; }

  function gMsg(text, isErr, retry) {
    var m = $('g-msg');
    if (text == null) { m.hidden = true; return; }
    m.hidden = false;
    m.className = 'g-msg' + (isErr ? ' err' : '');
    m.innerHTML = '<div></div>' + (retry ? '<button class="primary" id="g-retry" type="button">Retry</button>' : '');
    m.firstChild.textContent = text;
    if (retry) $('g-retry').onclick = function () { loadGraph(); };
  }

  function loadGraph() {
    gMsg('loading graph…');
    var seq = G.seq = (G.seq || 0) + 1;         // latest-wins: a stale response must not paint
    var qs = G.includeRemoved ? '?includeRemoved=true' : '';
    return api('node', '/backlog/graph' + qs).then(function (r) {
      if (seq !== G.seq) return;
      if (!r.ok) { gMsg(r.error.code + ': ' + r.error.message, true, true); return; }
      G.nodes = (r.data && r.data.nodes) || [];
      G.edges = (r.data && r.data.edges) || [];
      G.byId = {};
      G.nodes.forEach(function (nd) { G.byId[nd.id] = nd; });
      G.loaded = true;
      gDrag.on = false; gDrag.moved = false; gPinch = null;  // a live drag must not pan from pre-reload origins
      if (G.sel && !G.byId[G.sel]) { G.sel = null; $('g-card').hidden = true; }
      paintGraph();
      if (G.sel) showGraphCard(G.sel);           // refresh a surviving open card
      fitToView();
      gMsg(G.nodes.length ? null : 'backlog is empty — nothing to draw yet');
    }).catch(function (e) {                      // api() never rejects — this catches render throws
      if (seq === G.seq) gMsg('graph render failed — ' + String(e && e.message || e), true, true);
    });
  }

  // ── layout math (ported from assist-mission-graph → web/src/lib/mission-layout.ts) ──
  /** Union-find connected components over the UNDIRECTED edge set. */
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
      var pgrid = grid[i - 1];
      starts.push(starts[i - 1] + pgrid.subCols * NODE_W + (pgrid.subCols - 1) * NODE_GAP + LAYER_GAP);
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

  /** Radial: centerId in the middle, others on concentric rings by hop distance. A crowded
   *  ring is pushed out far enough that its circumference fits every card. */
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

  /** Pack standalone items into a sqrt-ish grid. */
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

  function computeLayout(nodes, edges, strategy) {
    var ids = nodes.map(function (n) { return n.id; });
    if (!ids.length) return { positions: new Map(), width: 0, height: 0 };
    var comps = components(ids, edges);
    var multi = comps.filter(function (c) { return c.length > 1; });
    var singles = comps.filter(function (c) { return c.length === 1; }).map(function (c) { return c[0]; });
    var blocks = multi.map(function (comp) {
      var b = strategy === 'clusters' ? layoutFlow(comp, edges) : layoutRadial(comp, edges, highestDegree(comp, edges));
      b.ids = comp;
      return b;
    });
    blocks.sort(function (a, b) { return b.ids.length - a.ids.length; });
    if (singles.length) blocks.push(layoutSingletons(singles));
    var packed = packBlocks(blocks);
    var pad = 20, out = new Map();
    packed.positions.forEach(function (p, id) { out.set(id, { x: p.x + pad, y: p.y + pad }); });
    return { positions: out, width: packed.width + pad * 2, height: packed.height + pad * 2 };
  }

  /** Point on a card's border toward (tx,ty), so edges meet card edges, not centers. */
  function borderPoint(x, y, tx, ty) {
    var cx = x + NODE_W / 2, cy = y + NODE_H / 2, dx = tx - cx, dy = ty - cy;
    if (dx === 0 && dy === 0) return { x: cx, y: cy };
    var sx = dx !== 0 ? (NODE_W / 2) / Math.abs(dx) : Infinity;
    var sy = dy !== 0 ? (NODE_H / 2) / Math.abs(dy) : Infinity;
    var s = Math.min(sx, sy);
    return { x: cx + dx * s, y: cy + dy * s };
  }

  // ── stage rendering ───────────────────────────────────────────────────────
  function neighborhood(sel) {
    if (!sel) return null;
    var set = new Set([sel]);
    G.edges.forEach(function (e) {
      if (e.from === sel) set.add(e.to);
      if (e.to === sel) set.add(e.from);
    });
    return set;
  }

  function nodeCardHtml(nd, p, deg, connected) {
    var accent = own(STATUS_COLOR, nd.status, '#94a3b8');
    var dim = connected && !connected.has(nd.id);
    var sel = nd.id === G.sel;
    var c = nd.counts || {};
    var bits = [];
    if (deg) bits.push('⛓' + deg);
    if (c.discussion) bits.push(c.discussion + ' note' + (c.discussion === 1 ? '' : 's'));
    if (c.reviews) bits.push(c.reviews + ' review' + (c.reviews === 1 ? '' : 's'));
    return '<div class="g-node-card' + (sel ? ' sel' : '') + (dim ? ' dim' : '') + (nd.removed ? ' removed' : '')
      + '" data-nid="' + esc(nd.id) + '" title="' + esc(nd.title + ' — ' + nd.id) + '"'
      + ' style="left:' + Math.round(p.x) + 'px;top:' + Math.round(p.y) + 'px;width:' + NODE_W + 'px;height:' + NODE_H + 'px;border-left-color:' + accent + '">'
      + '<div class="gc-title">' + esc(nd.title) + '</div>'
      + '<div class="gc-meta"><span class="pill ty">' + esc(nd.type) + '</span>'
      + '<span class="pill st-' + esc(nd.status) + '">' + esc(nd.status) + '</span>'
      + '<span class="pill pr-' + esc(nd.priority) + '">' + esc(nd.priority) + '</span></div>'
      + (bits.length ? '<div class="gc-rel">' + esc(bits.join(' · ')) + '</div>' : '')
      + '</div>';
  }

  function paintGraph() {
    G.layout = computeLayout(G.nodes, G.edges, G.strategy);
    var pos = G.layout.positions;

    // One arrow marker per DIRECTED kind, colored from the shared palette (our constants,
    // not user data — user strings never reach the defs markup).
    $('g-defs').innerHTML = Object.keys(DIRECTED).map(function (k) {
      return '<marker id="bk-arrow-' + k + '" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto">'
        + '<polygon points="0 0, 9 3.5, 0 7" fill="' + (KIND_COLOR[k] || '#64748b') + '"></polygon></marker>';
    }).join('');

    var connected = neighborhood(G.sel);
    $('g-edge-g').innerHTML = G.edges.map(function (e) {
      var a = pos.get(e.from), b = pos.get(e.to);
      if (!a || !b) return '';
      var p1 = borderPoint(a.x, a.y, b.x + NODE_W / 2, b.y + NODE_H / 2);
      var p2 = borderPoint(b.x, b.y, a.x + NODE_W / 2, a.y + NODE_H / 2);
      var hot = !!G.sel && (e.from === G.sel || e.to === G.sel);
      var dash = own(KIND_DASH, e.kind, '');
      return '<line x1="' + p1.x.toFixed(1) + '" y1="' + p1.y.toFixed(1) + '" x2="' + p2.x.toFixed(1) + '" y2="' + p2.y.toFixed(1) + '"'
        + ' stroke="' + own(KIND_COLOR, e.kind, '#64748b') + '" stroke-width="' + (hot ? 2.2 : 1.4) + '"'
        + (dash ? ' stroke-dasharray="' + dash + '"' : '')
        + ' stroke-opacity="' + (hot ? 0.95 : (G.sel ? 0.15 : 0.65)) + '"'
        + (own(DIRECTED, e.kind, 0) ? ' marker-end="url(#bk-arrow-' + e.kind + ')"' : '')
        + '></line>';
    }).join('');
    var svg = $('g-edges');
    svg.setAttribute('width', String(Math.ceil(G.layout.width)));
    svg.setAttribute('height', String(Math.ceil(G.layout.height)));

    var degs = new Map();
    G.edges.forEach(function (e) {
      degs.set(e.from, (degs.get(e.from) || 0) + 1);
      degs.set(e.to, (degs.get(e.to) || 0) + 1);
    });
    $('g-cards').innerHTML = G.nodes.map(function (nd) {
      var p = pos.get(nd.id);
      return p ? nodeCardHtml(nd, p, degs.get(nd.id) || 0, connected) : '';
    }).join('');

    var stage = $('g-stage');
    stage.style.width = Math.ceil(G.layout.width) + 'px';
    stage.style.height = Math.ceil(G.layout.height) + 'px';
    applyTransform();
    $('g-stats').textContent = G.nodes.length + ' item' + (G.nodes.length === 1 ? '' : 's')
      + ' · ' + G.edges.length + ' link' + (G.edges.length === 1 ? '' : 's');
    paintLegend();
    reportHeight();
  }

  function paintLegend() {
    var st = [['open / discussing', '#94a3b8'], ['accepted / planned', '#3b82f6'], ['implemented', '#4ade80'], ['deferred', '#fbbf24'], ['rejected', '#f87171']];
    $('g-legend').innerHTML =
      '<div class="lg-row">' + st.map(function (s) { return '<span class="lg"><span class="sw" style="background:' + s[1] + '"></span>' + s[0] + '</span>'; }).join('') + '</div>'
      + '<div class="lg-row">' + Object.keys(KIND_COLOR).map(function (k) { return '<span class="lg"><span class="ln" style="border-color:' + KIND_COLOR[k] + '"></span>' + k + '</span>'; }).join('') + '</div>';
  }

  // ── pan / zoom / select (transform on the stage, per the house pattern) ──
  function applyTransform() {
    $('g-stage').style.transform = 'translate(' + G.pan.x + 'px,' + G.pan.y + 'px) scale(' + G.zoom + ')';
    $('g-zoom-pct').textContent = Math.round(G.zoom * 100) + '%';
  }

  function fitToView() {
    if (!G.layout || !G.layout.width) return;
    var r = $('g-canvas').getBoundingClientRect();
    // Hidden pane → 0×0 rect. Remember the skipped fit; switchView consumes it on entry.
    if (!r.width || !r.height) { G.pendingFit = true; return; }
    G.pendingFit = false;
    // Fit never zooms IN past 100% — a 1-item graph at MAX_ZOOM is a blurry wall of card.
    var z = Math.min(Math.max(Math.min((r.width - 20) / G.layout.width, (r.height - 20) / G.layout.height), MIN_ZOOM), 1);
    G.zoom = z;
    G.pan = {
      x: Math.max(0, (r.width - G.layout.width * z) / 2),
      y: Math.max(0, (r.height - G.layout.height * z) / 2)
    };
    applyTransform();
  }

  function zoomAt(factor, fx, fy) {
    var nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, G.zoom * factor));
    var ratio = nz / G.zoom;
    G.pan = { x: fx - (fx - G.pan.x) * ratio, y: fy - (fy - G.pan.y) * ratio };
    G.zoom = nz;
    applyTransform();
  }

  function selectNode(id) {
    G.sel = id;
    paintGraph();                                // deterministic layout → same positions, new dim/sel state
    if (id) showGraphCard(id);
    else { $('g-card').hidden = true; }
  }

  function showGraphCard(id) {
    var nd = G.byId[id];
    if (!nd) return;
    var card = $('g-card');
    var tags = (nd.tags || []).map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('');
    card.innerHTML = '<div class="g-card-t">' + esc(nd.title) + '</div>'
      + '<div class="d-idrow"><span class="d-id">' + esc(nd.id) + '</span></div>'
      + '<div class="d-pills"><span class="pill ty">' + esc(nd.type) + '</span>'
      + '<span class="pill st-' + esc(nd.status) + '">' + esc(nd.status) + '</span>'
      + '<span class="pill pr-' + esc(nd.priority) + '">' + esc(nd.priority) + '</span>'
      + (nd.removed ? '<span class="pill vd-reject">removed</span>' : '') + '</div>'
      + (tags ? '<div>' + tags + '</div>' : '')
      + '<div class="d-counts">' + (nd.counts && nd.counts.discussion || 0) + ' notes · '
      + (nd.counts && nd.counts.reviews || 0) + ' reviews · updated ' + esc(ago(nd.updatedAt)) + '</div>'
      + '<div class="actions"><button class="primary" id="g-open" type="button">open details</button>'
      + '<button class="ghost" id="g-close" type="button">close</button></div>';
    card.hidden = false;
    $('g-open').onclick = function () { switchView('list'); openItem(id); };
    $('g-close').onclick = function () { selectNode(null); };
  }

  var gDrag = { on: false, moved: false };
  var gPinch = null;
  function wireGraph() {
    var cv = $('g-canvas');
    // The info card and msg overlay float INSIDE the canvas — a press on their buttons
    // must not start a pan, and a wheel/dblclick over them must not move the viewport.
    function onOverlay(t) { return !!(t && t.closest && t.closest('.g-card, .g-msg')); }
    $('g-cards').addEventListener('click', function (e) {
      if (gDrag.moved) return;
      var card = e.target.closest ? e.target.closest('.g-node-card') : null;
      if (!card || !card.dataset.nid) return;
      selectNode(card.dataset.nid === G.sel ? null : card.dataset.nid);
    });
    cv.addEventListener('mousedown', function (e) {
      if (e.button !== 0 || onOverlay(e.target)) return;
      gDrag = { on: true, moved: false, x: e.clientX, y: e.clientY, px: G.pan.x, py: G.pan.y };
    });
    cv.addEventListener('mousemove', function (e) {
      if (!gDrag.on) return;
      var dx = e.clientX - gDrag.x, dy = e.clientY - gDrag.y;
      if (!gDrag.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) gDrag.moved = true;
      G.pan = { x: gDrag.px + dx, y: gDrag.py + dy };
      applyTransform();
    });
    function endDrag() { gDrag.on = false; setTimeout(function () { gDrag.moved = false; }, 0); }
    cv.addEventListener('mouseup', endDrag);
    cv.addEventListener('mouseleave', endDrag);
    cv.addEventListener('dblclick', function (e) {
      // Double-click on a CARD is a natural "open this" gesture — it must not refit the
      // viewport (click #2 lands after click #1's re-render already toggled selection).
      if (onOverlay(e.target) || (e.target.closest && e.target.closest('.g-node-card'))) return;
      fitToView();
    });
    cv.addEventListener('wheel', function (e) {
      if (onOverlay(e.target)) return;
      e.preventDefault();
      var r = cv.getBoundingClientRect();
      zoomAt(e.deltaY > 0 ? 0.9 : 1.1, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    function touchDist(t) { return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY); }
    cv.addEventListener('touchstart', function (e) {
      var r = cv.getBoundingClientRect();
      if (e.touches.length === 2) {
        gDrag.on = false;
        gPinch = {
          dist: touchDist(e.touches), zoom: G.zoom,
          cx: (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left,
          cy: (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top
        };
      } else if (e.touches.length === 1) {
        if (onOverlay(e.target)) return;
        gDrag = { on: true, moved: false, x: e.touches[0].clientX, y: e.touches[0].clientY, px: G.pan.x, py: G.pan.y };
      }
    }, { passive: false });
    cv.addEventListener('touchmove', function (e) {
      if (e.touches.length === 2 && gPinch && gPinch.dist) {
        e.preventDefault();
        var nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, gPinch.zoom * (touchDist(e.touches) / gPinch.dist)));
        var ratio = nz / G.zoom;
        G.pan = { x: gPinch.cx - (gPinch.cx - G.pan.x) * ratio, y: gPinch.cy - (gPinch.cy - G.pan.y) * ratio };
        G.zoom = nz;
        applyTransform();
      } else if (e.touches.length === 1 && gDrag.on) {
        e.preventDefault();
        var dx = e.touches[0].clientX - gDrag.x, dy = e.touches[0].clientY - gDrag.y;
        if (!gDrag.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) gDrag.moved = true;
        G.pan = { x: gDrag.px + dx, y: gDrag.py + dy };
        applyTransform();
      }
    }, { passive: false });
    cv.addEventListener('touchend', function (e) {
      if (e.touches.length < 2) gPinch = null;
      // Pinch tail: one finger lifted, one still down — re-arm the pan from the survivor
      // (no touchstart fires for it). moved:true so the tail can't read as a card tap.
      if (e.touches.length === 1) {
        gDrag = { on: true, moved: true, x: e.touches[0].clientX, y: e.touches[0].clientY, px: G.pan.x, py: G.pan.y };
      }
      if (e.touches.length === 0) endDrag();
    }, { passive: false });

    $('g-zoom-in').addEventListener('click', function () { var r = cv.getBoundingClientRect(); zoomAt(1.2, r.width / 2, r.height / 2); });
    $('g-zoom-out').addEventListener('click', function () { var r = cv.getBoundingClientRect(); zoomAt(0.8, r.width / 2, r.height / 2); });
  }

  // ── view switch (List | Graph) ────────────────────────────────────────────
  function switchView(v) {
    var graphMode = v === 'graph';
    $('tab-list').classList.toggle('on', !graphMode);
    $('tab-graph').classList.toggle('on', graphMode);
    $('graph-pane').hidden = !graphMode;
    document.querySelector('.pane-list').hidden = graphMode;
    document.querySelector('.pane-detail').hidden = graphMode;
    document.querySelector('.pane-form').hidden = graphMode;
    document.querySelector('main').classList.toggle('graph-mode', graphMode);
    if (graphMode && !G.loaded) loadGraph();
    else if (graphMode && G.pendingFit) requestAnimationFrame(fitToView);  // fit skipped while hidden
    reportHeight();
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  $('tab-list').addEventListener('click', function () { switchView('list'); });
  $('tab-graph').addEventListener('click', function () { switchView('graph'); });
  $('g-removed').addEventListener('change', function (e) { G.includeRemoved = e.target.checked; loadGraph(); });
  $('g-strategy').addEventListener('change', function (e) {
    G.strategy = e.target.value === 'clusters' ? 'clusters' : 'hubs';
    if (G.loaded) { paintGraph(); fitToView(); }
  });
  $('g-fit').addEventListener('click', fitToView);
  $('g-refresh').addEventListener('click', loadGraph);
  wireGraph();
  paintLegend();                                 // static content — else an empty styled box shows pre-load
  $('list').addEventListener('click', function (e) {
    var row = e.target.closest ? e.target.closest('.row') : null;
    if (row && row.dataset.id) openItem(row.dataset.id);
  });
  $('detail').addEventListener('click', function (e) {
    var edge = e.target.closest ? e.target.closest('.edge') : null;
    if (edge && edge.dataset.open) openItem(edge.dataset.open);
  });
  $('chips-status').addEventListener('click', function (e) {
    if (e.target.dataset.fs === undefined) return;
    state.filter.status = e.target.dataset.fs;
    paintChips(); paintList(); refreshCount();
  });
  $('chips-type').addEventListener('click', function (e) {
    if (e.target.dataset.ft === undefined) return;
    state.filter.type = e.target.dataset.ft;
    paintChips(); paintList(); refreshCount();
  });
  $('q').addEventListener('input', function (e) { state.filter.text = e.target.value; paintList(); refreshCount(); });
  $('show-removed').addEventListener('change', function (e) { state.showRemoved = e.target.checked; loadList(); });
  $('form').addEventListener('submit', function (e) { e.preventDefault(); submitForm(); });
  $('form-new').addEventListener('click', resetForm);
  $('n-add').addEventListener('click', addNote);

  function refreshCount() {
    var el = $('counts'), txt = el.textContent;
    var m = txt.match(/of\s+\d+.*/);
    el.textContent = 'showing ' + visibleItems().length + ' ' + (m ? m[0] : 'items');
    reportHeight();
  }

  // Who is signed in (identity rides the session, not the view token).
  fetch('/auth/me', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
    $('who-name').textContent = (d.claims && (d.claims.name || d.claims.email)) || d.userId || 'signed in';
  }).catch(function () { $('who-name').textContent = 'signed in'; });

  // ── boot ────────────────────────────────────────────────────────────────
  resetForm();
  loadList();
})();
