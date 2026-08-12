/* assist-backlog — the backlog registry as a scoped pane. Plain JS, no build, no deps.
 * Every data call goes through the injected SDK helper (lmui.call), which carries the
 * view token and re-mints it on 401/403. The one declared grant is node:/backlog
 * [GET,POST], which prefix-covers list, detail, history, create, update and discuss.
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
      openItem(id);
      loadList();
    });
  }

  // ── wiring ────────────────────────────────────────────────────────────────
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
