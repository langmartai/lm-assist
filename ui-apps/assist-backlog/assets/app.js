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
    if (!isFinite(m) || m < 0) return new Date(ms).toISOString();
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

  // ── graph view (GET /backlog/graph → force layout → hand-rolled SVG) ──────
  // No chart library: pane CSP forbids external hosts, so layout + render are local.
  // Nodes are colored by STATUS, sized by PRIORITY; edges are typed (kind → CSS class,
  // directed kinds get a computed arrowhead polygon — SVG markers can't take per-kind
  // CSS color reliably). Isolated items go to a grid strip under the force-laid graph.
  var G = {
    nodes: [], edges: [], byId: {}, pos: {},
    loaded: false, includeRemoved: false, sel: null,
    W: 1200, H: 700, vb: { x: 0, y: 0, w: 1200, h: 700 },
    els: {}, edgeEls: [],
  };
  var NODE_R = { low: 6, med: 7, high: 9, critical: 11 };
  var DIRECTED = { 'depends-on': 1, 'blocks': 1, 'parent-of': 1, 'spawned-mission': 1 };

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
      gDrag = null;                              // a live drag would act on rebuilt elements
      $('g-svg').classList.remove('panning');
      if (G.sel && !G.byId[G.sel]) { G.sel = null; $('g-card').hidden = true; }
      layoutGraph();
      renderGraph();
      if (G.sel) showGraphCard(G.sel);           // refresh a surviving open card
      fitGraph();
      gMsg(G.nodes.length ? null : 'backlog is empty — nothing to draw yet');
    }).catch(function (e) {                      // api() never rejects — this catches render throws
      if (seq === G.seq) gMsg('graph render failed — ' + String(e && e.message || e), true, true);
    });
  }

  // Fruchterman–Reingold on the linked subgraph; degree-0 items in a bottom strip.
  function layoutGraph() {
    G.pos = {};
    if (!G.nodes.length) return;
    var deg = {};
    G.nodes.forEach(function (nd) { deg[nd.id] = 0; });
    G.edges.forEach(function (e) { deg[e.from]++; deg[e.to]++; });
    var linked = G.nodes.filter(function (nd) { return deg[nd.id] > 0; });
    var loose = G.nodes.filter(function (nd) { return deg[nd.id] === 0; });

    var perRow = Math.max(1, Math.floor((G.W - 100) / 160));
    var stripRows = Math.ceil(loose.length / perRow);
    var stripH = loose.length ? stripRows * 56 + 30 : 0;
    var H = Math.max(260, G.H - stripH - 30);   // linked-band height (clamped)
    // The strip must stay BELOW the band even when its height clamps — a big strip
    // otherwise climbs INTO the graph; fitGraph absorbs the overflow past G.H.
    var stripTop = Math.max(H + 30, G.H - stripH + 30);
    loose.forEach(function (nd, i) {
      G.pos[nd.id] = {
        x: 100 + (i % perRow) * 160 + (Math.floor(i / perRow) % 2) * 45,
        y: stripTop + Math.floor(i / perRow) * 56,
      };
    });

    var m = linked.length;
    if (!m) return;
    var W = G.W;
    linked.forEach(function (nd, i) {           // deterministic start: circle by index
      var a = (i / m) * Math.PI * 2;
      G.pos[nd.id] = { x: W / 2 + Math.cos(a) * W / 4 + (i % 7) * 5, y: H / 2 + Math.sin(a) * H / 4 + (i % 5) * 5 };
    });
    var k = Math.sqrt((W * H) / m) * 0.95;
    var t = W / 10;
    var iters = Math.max(40, Math.min(260, Math.floor(30000 / m))); // O(m²)/iter — scale the budget down
    for (var iter = 0; iter < iters; iter++) {
      var disp = {};
      linked.forEach(function (nd) { disp[nd.id] = { x: 0, y: 0 }; });
      for (var i = 0; i < m; i++) {
        for (var j = i + 1; j < m; j++) {
          var pa = G.pos[linked[i].id], pb = G.pos[linked[j].id];
          var dx = pa.x - pb.x, dy = pa.y - pb.y;
          var d = Math.sqrt(dx * dx + dy * dy) || 0.01;
          var f = (k * k) / d / d;
          disp[linked[i].id].x += dx * f; disp[linked[i].id].y += dy * f;
          disp[linked[j].id].x -= dx * f; disp[linked[j].id].y -= dy * f;
        }
      }
      G.edges.forEach(function (e) {
        var da = disp[e.from], db = disp[e.to];
        if (!da || !db) return;
        var pa = G.pos[e.from], pb = G.pos[e.to];
        var dx = pa.x - pb.x, dy = pa.y - pb.y;
        var d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        var f = d / k;
        da.x -= dx * f; da.y -= dy * f;
        db.x += dx * f; db.y += dy * f;
      });
      linked.forEach(function (nd) {
        var dv = disp[nd.id];
        var d = Math.sqrt(dv.x * dv.x + dv.y * dv.y) || 0.01;
        var p = G.pos[nd.id];
        p.x = Math.max(70, Math.min(W - 70, p.x + (dv.x / d) * Math.min(d, t)));
        p.y = Math.max(45, Math.min(H - 40, p.y + (dv.y / d) * Math.min(d, t)));
      });
      t = Math.max(1.5, t * 0.96);
    }
  }

  function arrowPoints(a, b, toId) {
    var r = (NODE_R[(G.byId[toId] || {}).priority] || 7) + 2;
    var dx = b.x - a.x, dy = b.y - a.y;
    var d = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / d, uy = dy / d;
    var tx = b.x - ux * r, ty = b.y - uy * r;
    var bx = tx - ux * 7, by = ty - uy * 7;
    return tx.toFixed(1) + ',' + ty.toFixed(1)
      + ' ' + (bx - uy * 3.5).toFixed(1) + ',' + (by + ux * 3.5).toFixed(1)
      + ' ' + (bx + uy * 3.5).toFixed(1) + ',' + (by - ux * 3.5).toFixed(1);
  }

  function renderGraph() {
    var svg = $('g-svg');
    var parts = ['<g id="g-edges">'];
    G.edges.forEach(function (e, i) {
      var a = G.pos[e.from], b = G.pos[e.to];
      if (!a || !b) return;
      parts.push('<g class="g-edge k-' + esc(e.kind) + '" data-i="' + i + '">'
        + '<line x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) + '"></line>'
        + (DIRECTED[e.kind] ? '<polygon points="' + arrowPoints(a, b, e.to) + '"></polygon>' : '')
        + '<title>' + esc(e.from + ' —' + e.kind + '→ ' + e.to) + '</title></g>');
    });
    parts.push('</g><g id="g-nodes">');
    G.nodes.forEach(function (nd) {
      var p = G.pos[nd.id];
      if (!p) return;
      var r = NODE_R[nd.priority] || 7;
      var label = nd.title;
      if (label.length > 26) {
        var cut = 25;
        var cc = label.charCodeAt(cut - 1);
        if (cc >= 0xD800 && cc <= 0xDBFF) cut--;  // don't split a surrogate pair
        label = label.slice(0, cut) + '…';
      }
      parts.push('<g class="g-node st-' + esc(nd.status) + (nd.removed ? ' removed' : '') + (G.sel === nd.id ? ' sel' : '')
        + '" data-id="' + esc(nd.id) + '" transform="translate(' + p.x.toFixed(1) + ',' + p.y.toFixed(1) + ')">'
        + '<circle r="' + r + '"></circle>'
        + '<text y="' + (r + 12) + '" text-anchor="middle">' + esc(label) + '</text>'
        + '<title>' + esc(nd.title + '\n' + nd.id + ' · ' + nd.type + ' · ' + nd.status + ' · ' + nd.priority) + '</title></g>');
    });
    parts.push('</g>');
    svg.innerHTML = parts.join('');
    G.els = {};
    G.edgeEls = [];
    var nodeEls = svg.querySelectorAll('.g-node');
    for (var i = 0; i < nodeEls.length; i++) G.els[nodeEls[i].getAttribute('data-id')] = nodeEls[i];
    var edgeEls = svg.querySelectorAll('.g-edge');
    for (var j = 0; j < edgeEls.length; j++) {
      var e = G.edges[Number(edgeEls[j].getAttribute('data-i'))];
      if (e) G.edgeEls.push({ el: edgeEls[j], from: e.from, to: e.to, kind: e.kind });
    }
    $('g-stats').textContent = G.nodes.length + ' item' + (G.nodes.length === 1 ? '' : 's')
      + ' · ' + G.edges.length + ' link' + (G.edges.length === 1 ? '' : 's');
    paintLegend();
  }

  function paintLegend() {
    // node fills are dark saturated hues that read on both themes; edge colors are
    // pastels tuned for the dark canvas, so light theme swaps in 600-series hues
    // (must match the body.theme-light .g-edge overrides in app.css)
    var st = [['open / discussing', '#475569'], ['accepted / planned', '#1d4ed8'], ['implemented', '#15803d'], ['deferred', '#92400e'], ['rejected', '#991b1b']];
    var kn = THEME === 'light'
      ? [['depends-on', '#2563eb'], ['blocks', '#b91c1c'], ['parent-of', '#475569'], ['relates-to', '#64748b'], ['duplicate-of', '#b45309'], ['spawned-mission', '#7c3aed']]
      : [['depends-on', '#60a5fa'], ['blocks', '#f87171'], ['parent-of', '#94a3b8'], ['relates-to', '#64748b'], ['duplicate-of', '#fbbf24'], ['spawned-mission', '#c084fc']];
    $('g-legend').innerHTML =
      '<div class="lg-row">' + st.map(function (s) { return '<span class="lg"><span class="sw" style="background:' + s[1] + '"></span>' + s[0] + '</span>'; }).join('') + '</div>'
      + '<div class="lg-row">' + kn.map(function (s) { return '<span class="lg"><span class="ln" style="border-color:' + s[1] + '"></span>' + s[0] + '</span>'; }).join('') + '</div>';
  }

  function applyVB() {
    $('g-svg').setAttribute('viewBox', G.vb.x.toFixed(1) + ' ' + G.vb.y.toFixed(1) + ' ' + G.vb.w.toFixed(1) + ' ' + G.vb.h.toFixed(1));
  }

  function fitGraph() {
    var xs = [], ys = [];
    G.nodes.forEach(function (nd) { var p = G.pos[nd.id]; if (p) { xs.push(p.x); ys.push(p.y); } });
    if (!xs.length) { G.vb = { x: 0, y: 0, w: G.W, h: G.H }; applyVB(); return; }
    var minX = Math.min.apply(null, xs) - 90, maxX = Math.max.apply(null, xs) + 90;
    var minY = Math.min.apply(null, ys) - 50, maxY = Math.max.apply(null, ys) + 60;
    G.vb = { x: minX, y: minY, w: Math.max(240, maxX - minX), h: Math.max(180, maxY - minY) };
    applyVB();
  }

  // client px → viewBox coords (uniform scale + letterbox offsets of xMidYMid meet)
  function svgPoint(clientX, clientY) {
    var rect = $('g-svg').getBoundingClientRect();
    var s = Math.min(rect.width / G.vb.w, rect.height / G.vb.h) || 1;
    var ox = (rect.width - G.vb.w * s) / 2, oy = (rect.height - G.vb.h * s) / 2;
    return { x: G.vb.x + (clientX - rect.left - ox) / s, y: G.vb.y + (clientY - rect.top - oy) / s };
  }

  function moveNode(id, x, y) {
    G.pos[id] = { x: x, y: y };
    var el = G.els[id];
    if (el) el.setAttribute('transform', 'translate(' + x.toFixed(1) + ',' + y.toFixed(1) + ')');
    G.edgeEls.forEach(function (ee) {
      if (ee.from !== id && ee.to !== id) return;
      var a = G.pos[ee.from], b = G.pos[ee.to];
      if (!a || !b) return;
      var ln = ee.el.querySelector('line');
      ln.setAttribute('x1', a.x.toFixed(1)); ln.setAttribute('y1', a.y.toFixed(1));
      ln.setAttribute('x2', b.x.toFixed(1)); ln.setAttribute('y2', b.y.toFixed(1));
      var poly = ee.el.querySelector('polygon');
      if (poly) poly.setAttribute('points', arrowPoints(a, b, ee.to));
    });
  }

  function paintGraphSel() {
    Object.keys(G.els).forEach(function (id) { G.els[id].classList.toggle('sel', id === G.sel); });
  }

  function showGraphCard(id) {
    var nd = G.byId[id];
    if (!nd) return;
    G.sel = id;
    paintGraphSel();
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
    $('g-close').onclick = function () { card.hidden = true; G.sel = null; paintGraphSel(); };
  }

  function hoverGraph(id, on) {
    var svg = $('g-svg');
    // clear FIRST, every time — node→node moves with no background in between
    // would otherwise accumulate .hl until half the graph is "highlighted"
    svg.querySelectorAll('.hl').forEach(function (el) { el.classList.remove('hl'); });
    if (!on) { svg.classList.remove('hovering'); return; }
    svg.classList.add('hovering');
    var keep = {}; keep[id] = 1;
    G.edgeEls.forEach(function (ee) {
      if (ee.from === id || ee.to === id) { ee.el.classList.add('hl'); keep[ee.from] = 1; keep[ee.to] = 1; }
    });
    Object.keys(keep).forEach(function (nid) { if (G.els[nid]) G.els[nid].classList.add('hl'); });
  }

  // drag a node / pan the background / wheel-zoom — one pointer state machine.
  // One gesture at a time, keyed by pointerId: a second finger is inert (no pinch,
  // but no viewport thrash either), and pointercancel/lostpointercapture end the
  // gesture like pointerup does — minus the tap action.
  var gDrag = null;
  function wireGraph() {
    var svg = $('g-svg');
    svg.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || gDrag) return;       // primary button only (touch/pen report 0)
      var node = e.target.closest ? e.target.closest('.g-node') : null;
      if (node) {
        var id = node.getAttribute('data-id');
        var p = svgPoint(e.clientX, e.clientY);
        gDrag = { pid: e.pointerId, id: id, ox: p.x - G.pos[id].x, oy: p.y - G.pos[id].y, sx: e.clientX, sy: e.clientY, moved: false };
      } else {
        gDrag = { pid: e.pointerId, pan: true, sx: e.clientX, sy: e.clientY, vb0: { x: G.vb.x, y: G.vb.y }, moved: false };
        svg.classList.add('panning');
      }
      svg.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    svg.addEventListener('pointermove', function (e) {
      if (!gDrag) {
        var node = e.target.closest ? e.target.closest('.g-node') : null;
        hoverGraph(node ? node.getAttribute('data-id') : null, !!node);
        return;
      }
      if (e.pointerId !== gDrag.pid) return;
      // 3px slop before a press counts as a drag — a touch tap always rolls 1-2px,
      // and without this the tap-opens-card path (checked on pointerup) never fires
      if (!gDrag.moved && Math.abs(e.clientX - gDrag.sx) + Math.abs(e.clientY - gDrag.sy) <= 3) return;
      gDrag.moved = true;
      if (gDrag.pan) {
        var rect = svg.getBoundingClientRect();
        var s = Math.min(rect.width / G.vb.w, rect.height / G.vb.h) || 1;
        G.vb.x = gDrag.vb0.x - (e.clientX - gDrag.sx) / s;
        G.vb.y = gDrag.vb0.y - (e.clientY - gDrag.sy) / s;
        applyVB();
      } else {
        var p = svgPoint(e.clientX, e.clientY);
        moveNode(gDrag.id, p.x - gDrag.ox, p.y - gDrag.oy);
      }
    });
    function endDrag(e, isTapEligible) {
      if (!gDrag || e.pointerId !== gDrag.pid) return;
      svg.classList.remove('panning');
      if (isTapEligible && !gDrag.moved && gDrag.id) showGraphCard(gDrag.id);
      gDrag = null;
    }
    svg.addEventListener('pointerup', function (e) { endDrag(e, true); });
    svg.addEventListener('pointercancel', function (e) { endDrag(e, false); });
    svg.addEventListener('lostpointercapture', function (e) { endDrag(e, false); });
    svg.addEventListener('pointerleave', function () { if (!gDrag) hoverGraph(null, false); });
    svg.addEventListener('wheel', function (e) {
      e.preventDefault();
      var f = e.deltaY < 0 ? 0.85 : 1 / 0.85;
      var w = Math.max(G.W / 8, Math.min(G.W * 5, G.vb.w * f));
      f = w / G.vb.w;
      var p = svgPoint(e.clientX, e.clientY);
      G.vb = { x: p.x - (p.x - G.vb.x) * f, y: p.y - (p.y - G.vb.y) * f, w: G.vb.w * f, h: G.vb.h * f };
      applyVB();
    }, { passive: false });
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
    reportHeight();
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  $('tab-list').addEventListener('click', function () { switchView('list'); });
  $('tab-graph').addEventListener('click', function () { switchView('graph'); });
  $('g-removed').addEventListener('change', function (e) { G.includeRemoved = e.target.checked; loadGraph(); });
  $('g-fit').addEventListener('click', fitGraph);
  $('g-relayout').addEventListener('click', function () { layoutGraph(); renderGraph(); fitGraph(); });
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
