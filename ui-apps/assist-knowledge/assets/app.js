/* assist-knowledge — the knowledge base as a scoped pane. Plain JS, no build, no deps.
 * Every data call goes through the injected SDK helper (lmui.call), which carries the
 * view token and re-mints it on 401/403. The one declared grant is node:/knowledge
 * [GET,POST], which prefix-covers list, search, detail, review status and review trigger.
 *
 * Enums, paths and envelope shapes mirror core/src/routes/core/knowledge.routes.ts and
 * core/src/knowledge/types.ts (read at build time). GET /knowledge returns data as a BARE
 * ARRAY of index rows; GET /knowledge/:id returns the full document; GET /knowledge/search
 * returns PART-LEVEL scored hits. Read-only except the one bounded review trigger. */
(function () {
  'use strict';

  // Enum vocabularies (knowledge/types.ts). KNOWLEDGE_TYPES order + the status set.
  var TYPES = ['algorithm', 'contract', 'schema', 'wiring', 'invariant', 'flow'];
  var STATUSES = ['active', 'outdated', 'archived', 'excluded'];
  var ORIGINS = ['local', 'remote'];

  // ── inbound deep link — the PINNED cross-pane param vocabulary ────────────
  // The entity's singular noun, unqualified: `unit` = a knowledge unit id. Read on load from
  // location.search and LANDED ON — a param a target never reads is a silently broken button
  // in the caller, not a no-op. assist-content linkifies `[K12]` / `[K12.3]` inside content
  // bodies and jumps here with it.
  //
  // A unit is addressed at either grain: `K12` is the document, `K12.3` one of its parts.
  // The detail route only takes the document (`/^\/knowledge\/(?<id>K\d+)$/` in
  // knowledge.routes.ts — `K12.3` does not match it and would come back as a router-level
  // "Route not found"), so the suffix is split off and reused as the part to highlight, which
  // is exactly the channel a clicked search hit already uses.
  //
  // Clamped at the same 512-char ceiling lmui.goto enforces on the EMIT side, so a hand-typed
  // URL cannot push an unbounded string into the pane.
  function inboundParam(name) {
    try {
      var v = new URLSearchParams(location.search).get(name);
      return v == null ? '' : String(v).trim().slice(0, 512);
    } catch (e) { return ''; }          // no URLSearchParams / opaque origin → no deep link
  }
  var UNIT_RE = /^K\d+(?:\.\d+)?$/;
  var DEEP_UNIT = inboundParam('unit');

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
  // unchanged under BOTH tiers, then normalize to {ok,status,data,error}. A failure
  // (grant denial, non-JSON, {success:false,error}) surfaces its real text — nothing swallowed.
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

  function agoISO(iso) {
    var t = new Date(iso).getTime();
    var m = Math.floor((Date.now() - t) / 60000);
    if (!isFinite(m) || m < 0) return iso ? String(iso).slice(0, 16).replace('T', ' ') : '—';
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    if (m < 1440) return Math.floor(m / 60) + 'h ago';
    return Math.floor(m / 1440) + 'd ago';
  }

  // ── state ───────────────────────────────────────────────────────────────
  var state = {
    mode: 'list',                                 // 'list' | 'search'
    list: [],                                     // rows from GET /knowledge?status=all (bare array)
    results: [],                                  // hits from GET /knowledge/search
    selected: null,                               // full document from GET /knowledge/:id
    selScore: null,                               // score carried from a clicked search hit
    selHitPart: null,                             // partId that matched, to highlight in detail
    filter: { type: '', status: '', origin: '' }, // client-side; '' = all
    query: '',
  };
  var searchTimer = null;

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
    d.innerHTML = '<div class="fatal-card"><div class="fatal-h">Knowledge could not be loaded</div>'
      + '<pre class="fatal-msg"></pre><button class="primary" id="fatal-retry">Retry</button></div>';
    d.querySelector('.fatal-msg').textContent = message;
    document.body.appendChild(d);
    // Retry goes through the boot path, not loadList alone: a deep link that never got its
    // list is still pending, and it must land once the list finally arrives.
    $('fatal-retry').onclick = function () { d.remove(); bootList(); };
    reportHeight();
  }

  // ── filter chips (values are model constants, not user data) ──────────────
  function chipset(el, values, current, attr) {
    var s = ['<span class="fchip' + (current ? '' : ' on') + '" ' + attr + '="">all</span>'];
    values.forEach(function (v) {
      s.push('<span class="fchip' + (current === v ? ' on' : '') + '" ' + attr + '="' + v + '">' + v + '</span>');
    });
    el.innerHTML = s.join('');
  }
  function paintChips() {
    chipset($('chips-type'), TYPES, state.filter.type, 'data-ft');
    chipset($('chips-status'), STATUSES, state.filter.status, 'data-fs');
    chipset($('chips-origin'), ORIGINS, state.filter.origin, 'data-fo');
  }

  // ── shared filter (list rows carry type/status/origin; search rows carry
  //    knowledgeType/origin but no status — the search route already drops
  //    bad-reviewed + excluded, so the status chip is a no-op there). ─────────
  function passFilters(row) {
    var f = state.filter;
    var ty = row.type || row.knowledgeType;
    if (f.type && ty !== f.type) return false;
    if (f.status && row.status && row.status !== f.status) return false;
    var org = row.origin || 'local';
    if (f.origin && org !== f.origin) return false;
    return true;
  }
  function visibleRows() {
    return (state.mode === 'search' ? state.results : state.list).filter(passFilters);
  }

  // ── list / search rows ────────────────────────────────────────────────────
  function pills(type, status, origin, rating, extra) {
    var h = '<span class="pill ty">' + esc(type || '?') + '</span>';
    if (status) h += '<span class="pill st-' + esc(status) + '">' + esc(status) + '</span>';
    if (rating) h += '<span class="pill rr-' + esc(rating) + '">' + esc(rating) + '</span>';
    if (origin === 'remote') h += '<span class="pill og-remote">remote</span>';
    return h + (extra || '');
  }

  function listRowHtml(it) {
    var selId = state.selected && state.selected.id;
    var sel = selId === it.id ? ' sel' : '';
    var cmt = it.unaddressedComments > 0
      ? '<span class="pill cmt">' + it.unaddressedComments + ' comment' + (it.unaddressedComments === 1 ? '' : 's') + '</span>' : '';
    var meta = pills(it.type, it.status, it.origin, it.reviewRating, cmt)
      + '<span class="rid">' + esc(it.id) + ' · ' + (it.partCount || (it.parts ? it.parts.length : 0)) + 'p</span>';
    return '<div class="row' + sel + '" data-kid="' + esc(it.id) + '"' + (it.machineId ? ' data-mid="' + esc(it.machineId) + '"' : '') + '>'
      + '<div class="rt">' + esc(it.title) + '</div>'
      + '<div class="rmeta">' + meta + '</div>'
      + (it.project ? '<div class="rproj">' + esc(it.project) + '</div>' : '') + '</div>';
  }

  function searchRowHtml(r) {
    var kid = r.knowledgeId || (r.id || '').split('.')[0];
    var selId = state.selected && state.selected.id;
    var sel = selId === kid ? ' sel' : '';
    var title = r.knowledgeTitle || kid;
    var sub = r.partTitle && r.partTitle !== title ? '<div class="p-summary">' + esc(r.partTitle) + '</div>' : '';
    var score = typeof r.score === 'number' ? '<span class="pill score">' + r.score.toFixed(3) + '</span>' : '';
    var meta = pills(r.knowledgeType, null, r.origin, null, score)
      + '<span class="rid">' + esc(r.partId || kid) + '</span>';
    return '<div class="row' + sel + '" data-kid="' + esc(kid) + '"' + (r.machineId ? ' data-mid="' + esc(r.machineId) + '"' : '')
      + ' data-part="' + esc(r.partId || '') + '" data-score="' + (typeof r.score === 'number' ? r.score : '') + '">'
      + '<div class="rt">' + esc(title) + '</div>' + sub
      + '<div class="rmeta">' + meta + '</div>'
      + (r.projectPath ? '<div class="rproj">' + esc(r.projectPath) + '</div>' : '') + '</div>';
  }

  function paintList() {
    var vis = visibleRows();
    var render = state.mode === 'search' ? searchRowHtml : listRowHtml;
    $('list').innerHTML = vis.length
      ? vis.map(render).join('')
      : '<div class="empty-list">' + (state.mode === 'search' ? 'No knowledge matched this search.' : 'No entries match the current filter.') + '</div>';
    var total = state.mode === 'search' ? state.results.length : state.list.length;
    $('counts').textContent = 'showing ' + vis.length + ' of ' + total
      + (state.mode === 'search' ? ' search hit' + (total === 1 ? '' : 's') : ' entr' + (total === 1 ? 'y' : 'ies'));
    reportHeight();
  }

  // ── list load (status=all so the status chip can filter client-side) ──────
  function loadList() {
    return api('node', '/knowledge?status=all').then(function (r) {
      if (!r.ok) { fatal(r.error.code + ': ' + r.error.message); return false; }
      state.list = Array.isArray(r.data) ? r.data : [];
      paintChips();
      paintList();
      paintReviewStatus();                         // list carries unaddressedComments → pending count
      return true;
    });
  }

  // ── search (server-side hybrid) ───────────────────────────────────────────
  function runSearch() {
    var q = state.query.trim();
    if (!q) { state.mode = 'list'; state.results = []; paintList(); return; }
    state.mode = 'search';
    api('node', '/knowledge/search?q=' + encodeURIComponent(q)).then(function (r) {
      if (state.query.trim() !== q) return;        // a newer keystroke already superseded this
      if (!r.ok) {
        state.results = [];
        $('list').innerHTML = '<div class="empty-list">search failed — ' + esc(r.error.code + ': ' + r.error.message) + '</div>';
        $('counts').textContent = '';
        reportHeight();
        return;
      }
      state.results = Array.isArray(r.data) ? r.data : [];
      paintList();
    });
  }

  // ── detail ────────────────────────────────────────────────────────────────
  function openDoc(kid, machineId, score, hitPart) {
    var path = '/knowledge/' + encodeURIComponent(kid) + (machineId ? '?machineId=' + encodeURIComponent(machineId) : '');
    return api('node', path).then(function (r) {
      // Resolves to whether the document opened, so a deep link can report its own miss
      // where the reader is looking; existing callers ignore the value.
      if (!r.ok) { say('open ' + kid + ' failed — ' + r.error.code + ': ' + r.error.message, true); return { ok: false, error: r.error }; }
      state.selected = r.data || null;
      state.selScore = (typeof score === 'number' && isFinite(score)) ? score : null;
      state.selHitPart = hitPart || null;
      paintDetail();
      paintList();                                 // re-highlight the selected row
      reportHeight();
      return { ok: true };
    });
  }

  function metaRow(label, value) {
    return value ? '<div><span class="k">' + esc(label) + ':</span> ' + esc(value) + '</div>' : '';
  }

  function paintDetail() {
    var k = state.selected;
    var el = $('detail');
    if (!k) { el.className = 'detail empty'; el.textContent = 'Select an entry on the left to read its full content and metadata.'; return; }
    el.className = 'detail';

    var parts = (k.parts || []).map(function (p) {
      var hit = state.selHitPart && p.partId === state.selHitPart ? ' hit' : '';
      var noBody = !p.content;
      var summary = p.summary && p.summary !== p.content ? '<div class="p-summary">' + esc(p.summary) + '</div>' : '';
      return '<div class="part' + hit + '">'
        + '<div class="p-head"><span class="p-title">' + esc(p.title || p.partId) + '</span><span class="p-id">' + esc(p.partId) + '</span></div>'
        + summary
        // Content is markdown, rendered as PLAIN TEXT pre-wrap — no md library.
        + '<pre class="content' + (noBody ? ' none' : '') + '">' + esc(noBody ? '(no content)' : p.content) + '</pre>'
        + '</div>';
    }).join('');

    var revBits = '';
    if (k.reviewRating || k.reviewedAt) {
      revBits = metaRow('reviewed', k.reviewedAt ? agoISO(k.reviewedAt) + (k.reviewModel ? ' by ' + k.reviewModel : '') : k.reviewModel || '')
        + (k.reviewReason ? '<div class="rev-reason">“' + esc(k.reviewReason) + '”</div>' : '');
    }
    var machine = k.origin === 'remote' && (k.machineHostname || k.machineOS)
      ? (k.machineHostname || '') + (k.machineOS ? ' (' + k.machineOS + ')' : '') : '';

    el.innerHTML =
      '<h2 class="d-title">' + esc(k.title) + '</h2>'
      + '<div class="d-idrow"><span class="d-id">' + esc(k.id) + ' · ' + (k.parts ? k.parts.length : 0) + ' part'
      + ((k.parts && k.parts.length === 1) ? '' : 's') + '</span></div>'
      + '<div class="d-pills">' + pills(k.type, k.status, k.origin, k.reviewRating,
        state.selScore != null ? '<span class="pill score">score ' + state.selScore.toFixed(3) + '</span>' : '') + '</div>'
      + '<div class="d-meta">'
      + metaRow('project', k.project)
      + metaRow('created', agoISO(k.createdAt))
      + metaRow('updated', agoISO(k.updatedAt))
      + metaRow('source session', k.sourceSessionId)
      + (machine ? metaRow('machine', machine) : '')
      + revBits
      + '</div>'
      + '<div class="d-sect"><h3>Content (' + (k.parts ? k.parts.length : 0) + ')</h3>' + (parts || '<div class="empty-list">(no parts)</div>') + '</div>';
  }

  // ── review pane (GET status = read; POST review = the one bounded write) ───
  function paintReviewStatus(live) {
    var el = $('rev-status');
    // Pending signal computed from the list: documents that still carry unaddressed comments.
    var pendingDocs = 0, pendingComments = 0;
    state.list.forEach(function (it) {
      if (it.unaddressedComments > 0) { pendingDocs++; pendingComments += it.unaddressedComments; }
    });
    var html = '<div><span class="big">' + pendingDocs + '</span> doc' + (pendingDocs === 1 ? '' : 's')
      + ' with unaddressed comments' + (pendingComments ? ' (' + pendingComments + ' total)' : '') + '</div>';
    if (live) {
      var s = live.status || 'unknown';
      el.classList.toggle('processing', s === 'processing');
      html += '<div><span class="k">status:</span> ' + esc(s) + '</div>';
      if (live.status !== 'not_initialized') {
        html += '<div><span class="k">last run:</span> reviewed ' + (live.documentsReviewed || 0) + '/' + (live.documentsToReview || 0)
          + ', addressed ' + (live.commentsAddressed || 0) + (live.errors ? ', ' + live.errors + ' err' : '') + '</div>';
        if (live.lastReviewedAt) html += '<div><span class="k">at:</span> ' + esc(agoISO(live.lastReviewedAt)) + '</div>';
      }
    }
    el.innerHTML = html;
    reportHeight();
  }

  function loadReviewStatus() {
    return api('node', '/knowledge/review/status').then(function (r) {
      paintReviewStatus(r.ok ? r.data : { status: 'unavailable' });
    });
  }

  function runReview() {
    var btn = $('rev-run');
    btn.disabled = true;
    say('reviewing… (server-side LLM pass; this can take a while for many documents)');
    // POST /knowledge/review takes NO body (see knowledge.routes.ts) — it is concurrency-safe
    // server-side (a `processing` flag no-ops re-entry) and only touches docs with comments.
    api('node', '/knowledge/review', { method: 'POST', body: {} }).then(function (r) {
      btn.disabled = false;
      if (!r.ok) { say('review failed — ' + r.error.code + ': ' + r.error.message, true); return; }
      var d = r.data || {};
      say('review ' + (d.status || 'done') + ' — reviewed ' + (d.documentsReviewed || 0) + '/' + (d.documentsToReview || 0)
        + ', addressed ' + (d.commentsAddressed || 0) + (d.errors ? ', ' + d.errors + ' error(s)' : ''));
      paintReviewStatus(d);
      loadList();                                  // unaddressed counts may have changed
    });
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  $('list').addEventListener('click', function (e) {
    var row = e.target.closest ? e.target.closest('.row') : null;
    if (!row || !row.dataset.kid) return;
    var score = row.dataset.score !== undefined && row.dataset.score !== '' ? parseFloat(row.dataset.score) : null;
    openDoc(row.dataset.kid, row.dataset.mid || '', score, row.dataset.part || null);
  });
  $('chips-type').addEventListener('click', function (e) {
    if (e.target.dataset.ft === undefined) return;
    state.filter.type = e.target.dataset.ft; paintChips(); paintList();
  });
  $('chips-status').addEventListener('click', function (e) {
    if (e.target.dataset.fs === undefined) return;
    state.filter.status = e.target.dataset.fs; paintChips(); paintList();
  });
  $('chips-origin').addEventListener('click', function (e) {
    if (e.target.dataset.fo === undefined) return;
    state.filter.origin = e.target.dataset.fo; paintChips(); paintList();
  });
  $('q').addEventListener('input', function (e) {
    state.query = e.target.value;
    if (searchTimer) clearTimeout(searchTimer);
    if (!state.query.trim()) { runSearch(); return; }  // switch back to list immediately
    searchTimer = setTimeout(runSearch, 300);
  });
  $('rev-run').addEventListener('click', runReview);

  // Who is signed in (identity rides the session, not the view token).
  fetch('/auth/me', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
    $('who-name').textContent = (d.claims && (d.claims.name || d.claims.email)) || d.userId || 'signed in';
  }).catch(function () { $('who-name').textContent = 'signed in'; });

  // ── inbound `unit` — select and scroll to the named knowledge unit ────────
  // Rows are matched in JS rather than through a `[data-kid="…"]` attribute selector: the
  // value arrives from the URL, and a selector built by interpolation is a defect waiting
  // for the first quote character.
  function scrollRowIntoView(docId) {
    var rows = $('list').querySelectorAll('.row');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].dataset.kid !== docId) continue;
      // 'nearest' scrolls the .list box (max-height + overflow:auto) and leaves the page
      // alone when the row is already on screen — a framed pane cannot scroll the shell.
      if (rows[i].scrollIntoView) {
        try { rows[i].scrollIntoView({ block: 'nearest' }); } catch (e) { rows[i].scrollIntoView(); }
      }
      return true;
    }
    return false;                                  // filtered out, or not on this node
  }

  // The one place the deep link speaks: the detail pane, where the reader is looking.
  // textContent, not innerHTML — the value came off the URL.
  function unitMiss(raw, why) {
    var el = $('detail');
    el.className = 'detail empty';
    el.textContent = 'Knowledge unit "' + raw + '" could not be opened — ' + why;
    reportHeight();
  }

  function landOnUnit(raw) {
    if (!UNIT_RE.test(raw)) { unitMiss(raw, 'not a knowledge unit id (expected K12 or K12.3).'); return; }
    var dot = raw.indexOf('.');
    var docId = dot > 0 ? raw.slice(0, dot) : raw;
    var hitPart = dot > 0 ? raw : null;             // K12.3 → highlight that part in the detail

    // Resolve the row first: a REMOTE document is only readable with its machineId, and ids
    // are per-machine so the same K12 can exist twice. Prefer the local one deterministically
    // rather than whichever the index happened to yield first.
    var row = null;
    state.list.forEach(function (it) {
      if (it.id !== docId) return;
      if (!row || (row.origin === 'remote' && it.origin !== 'remote')) row = it;
    });

    return openDoc(docId, (row && row.machineId) || '', null, hitPart).then(function (res) {
      if (!res || !res.ok) {
        unitMiss(raw, (res && res.error ? res.error.code + ': ' + res.error.message : 'the request failed.'));
        return;
      }
      scrollRowIntoView(docId);
      // Standalone only: when EMBEDDED the shell owns the scroll position and a cross-origin
      // frame cannot move it, so this would be pure jank against the row scroll above.
      if (!EMBEDDED && hitPart) {
        var hit = document.querySelector('.part.hit');
        if (hit && hit.scrollIntoView) { try { hit.scrollIntoView({ block: 'nearest' }); } catch (e) {} }
      }
    });
  }

  // Consumed once: a later fatal-retry must not yank the reader off a row they picked by hand.
  var deepPending = DEEP_UNIT;
  function bootList() {
    return loadList().then(function (ok) {
      if (!ok || !deepPending) return;             // list failed → the link is still pending
      var raw = deepPending;
      deepPending = '';
      return landOnUnit(raw);
    });
  }

  // ── boot ────────────────────────────────────────────────────────────────
  bootList();
  loadReviewStatus();
})();
