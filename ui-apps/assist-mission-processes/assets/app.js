/* assist-mission-processes — the mission WORKFLOW REGISTRY as a scoped pane: the playbooks
 * Mission Control actually reads (controller / onboard / drive / wrapup / recover / observe)
 * plus the case.* learned-case library. Plain JS, no build, no deps. Every data call goes
 * through the injected SDK helper (lmui.call), which carries the view token and re-mints it
 * on 401/403. Cross-pane links go through lmui.goto — a pane never builds a sibling URL.
 *
 * ── AUTHORITY ────────────────────────────────────────────────────────────────────────────
 * This pane EDITS the docs that steer Mission Control, so its grant is written as three
 * separate rules rather than one convenient subtree (lmui.config.json):
 *
 *   node:/mission/workflows            [GET]                    list + one doc + its history
 *   node:/mission/workflows/*          [POST] exact:true         save one doc
 *   node:/mission/workflows/*\/rollback [POST] exact:true        restore one revision
 *
 * `exact:true` = LEAF match (same segment count as the rule), `*` = exactly one segment. So the
 * write rules reach `POST /mission/workflows/<id>` and `POST /mission/workflows/<id>/rollback`
 * and NOTHING else — not `POST /mission` (create), not `POST /mission/<id>` (patch), not a
 * deeper path under a doc. A plain `pathPrefix:"/mission/workflows" [POST]` would have been one
 * line, and would have handed this pane every future POST anyone adds under that subtree; see
 * core/src/ui-pages/local-tier/grants.ts for why the rule form exists. Verified against Core's
 * own matcher (readDeclaredGrant + grantAllows), allow-and-deny both.
 *
 * Two things stay refused ON PURPOSE even though a write grant now exists:
 *   • a `human-only` doc is not editable here (the server only refuses CONTROLLER writes on
 *     that policy — a REST write is attributed `user`, so the ceiling is ours, not the API's);
 *   • editPolicy itself is never sent, so this pane can never flip a doc open/human-only.
 *
 * Paths + envelope shapes mirror core/src/routes/core/mission.routes.ts (handleWorkflowList /
 * Get / History / Set / Rollback) and core/src/mission/workflow-store.ts, curled against the
 * live dev API:
 *   GET /mission/workflows        → data = { workflows:[...], defaults:[id,…] }   (a WRAPPER)
 *       `workflows` carries the FULL doc — id, title, body, editPolicy, rev, inline history,
 *       createdBy/lastUpdatedBy, createdAt/updatedAt. `defaults` is the ids of BUILT-IN docs
 *       that have never been stored: they are real, openable docs that are NOT in `workflows`,
 *       so rendering only `workflows` makes every un-seeded built-in vanish from the list.
 *       (On a seeded node `defaults` is [] — do not conclude the field is unused.)
 *   GET /mission/workflows/:id    → data = { doc|null, defaultBody|null, rendered }
 *       `doc` is null for an un-stored default (fall back to defaultBody). `rendered` is the
 *       body with the immutable ⟦INVARIANTS⟧…⟦/INVARIANTS⟧ preamble prepended — the text the
 *       controller is actually handed. An id that is neither stored nor built-in comes back as
 *       {success:false,error:{code:'NOT_FOUND'}} (verified), not as an empty doc.
 *   GET /mission/workflows/:id/history?limit=&beforeRev= → data = { snapshots:[…] }
 *       Each row STRIPS the body and substitutes bodyBytes:number, so a revision can never be
 *       previewed or diffed from here — only its rev, actor, time, title and size. NEWEST-FIRST,
 *       and `beforeRev` pages OLDER (rev < beforeRev), so the pane pages instead of hard-capping.
 *       Curled: `?beforeRev=2` → [1], `?beforeRev=1` → [] — an exhausted page is empty, not an
 *       error, which is what "Load older" reads to stop.
 *   POST /mission/workflows/:id {title, body} → data = { doc, changed }
 *       `changed:false` when the write was byte-identical: putWorkflow no-ops and the rev does
 *       NOT advance. Treat that as success-with-nothing-done, never as a failed save.
 *   POST /mission/workflows/:id/rollback {toRev} → data = { doc }
 *       Restoring rev N re-SAVES N's title/body as a NEW rev — it does not delete anything and
 *       it does not renumber. Missing snapshot → {code:'NOT_FOUND', message:'no snapshot id:N'};
 *       missing/NaN toRev → {code:'INVALID_INPUT'} (both curled).
 * Every one of these is leader-anchored (reads) or origin-anchored (writes) in Core and may be
 * served by a peer node — which is exactly why a save applies the doc the WRITE returned rather
 * than re-GETting a possibly-lagging local replica and making a landed save look dropped.
 *
 * Text handling mirrors web/src/lib/mission-process.ts (grouping, case.index cue parsing,
 * preamble split, doc-id linkification) — ported, not re-invented. Doc bodies are markdown but
 * render as PLAIN TEXT pre-wrap: there is no markdown or mermaid library in any pane and adding
 * one would break the self-hosted/CSP rule, so a ```mermaid fence is shown as its source. */
(function () {
  'use strict';

  // Namespaces in display order; anything else lands in 'other' (always last).
  // Mirrors NAMESPACE_ORDER in web/src/lib/mission-process.ts.
  var NAMESPACE_ORDER = ['process', 'controller', 'onboard', 'drive', 'wrapup', 'recover', 'observe', 'case', 'other'];
  var OVERVIEW_ID = 'process.overview';          // the map of the control flow — pinned + default-selected
  var PREAMBLE_END = '⟦/INVARIANTS⟧';            // renderWorkflowText's end-of-invariants marker
  // Doc-id pattern for link navigation. Greedy over dots/hyphens — trailing `.`/`-` are trimmed
  // against the registry before a match is accepted (the pattern swallows sentence dots).
  var DOC_ID_RE = /(?:controller|onboard|drive|case|wrapup|recover|observe|process)\.[a-z0-9][a-z0-9.-]*/g;
  var FENCE_RE = /^\s*(?:```|~~~)/;
  var CASE_ROW_RE = /^\s*(case\.[a-z0-9][a-z0-9.-]*)\s+(?:—|–|--|-)\s+(.+?)\s*$/;
  var TABS = [['rendered', 'Rendered'], ['raw', 'Raw'], ['edit', 'Edit'], ['history', 'History']];
  // MAX_WORKFLOW_BODY_BYTES in core/src/mission/workflow-model.ts. Mirrored so the editor can
  // refuse a body the server would reject with BODY_TOO_LARGE after the user typed 64 KiB of it.
  var MAX_BODY_BYTES = 65536;
  // History page size. The route's own default is 50 with no upper bound, but Core PRUNES to
  // SNAPSHOT_RETENTION (20) snapshots per doc on every write, so a page bigger than that is
  // theatre — 25 pages the realistic maximum in one call and still proves the pager on a doc
  // that somehow holds more.
  var HIST_PAGE = 25;

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
  // Timestamps here are epoch MILLIS (updatedAt / createdAt / snapshot.at).
  function ago(ms) {
    var n = Number(ms);
    if (!n || !isFinite(n)) return '—';
    var m = Math.floor((Date.now() - n) / 60000);
    if (m < 0) return absTime(n);                 // a future stamp is not "just now"
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    if (m < 1440) return Math.floor(m / 60) + 'h ago';
    return Math.floor(m / 1440) + 'd ago';
  }
  function absTime(ms) {
    var n = Number(ms);
    if (!n || !isFinite(n)) return '';
    try { return new Date(n).toLocaleString(); }
    catch (e) { return new Date(n).toISOString().slice(0, 16).replace('T', ' '); }
  }
  function fmtBytes(n) {
    var v = Number(n);
    if (!isFinite(v)) return '';
    return v < 1024 ? v + ' B' : (v / 1024).toFixed(1) + ' KB';
  }
  // The server's cap is BYTES, not chars — a body of ⟦…⟧ box-drawing and em dashes is ~3× its
  // length. Measure what the server measures or the meter lies exactly where it matters.
  var TE = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  function utf8Bytes(s) { return TE ? TE.encode(String(s)).length : new Blob([String(s)]).size; }
  function nsOf(id) {
    var dot = String(id || '').indexOf('.');
    var prefix = dot > 0 ? id.slice(0, dot) : '';
    return NAMESPACE_ORDER.indexOf(prefix) >= 0 && prefix !== 'other' ? prefix : 'other';
  }

  // ── ported pure helpers (web/src/lib/mission-process.ts) ──────────────────
  /** One `case.<slug> <dash> <cue>` row per line; em/en dash, `--`, or `-` separators. */
  function parseCaseIndex(body) {
    var out = {};
    if (!body) return out;
    var lines = String(body).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var m = CASE_ROW_RE.exec(lines[i]);
      if (m) out[m[1]] = m[2];                    // later duplicates win
    }
    return out;
  }

  /** Split rendered text into the immutable invariant preamble (marker included) and the body. */
  function splitRenderedPreamble(rendered) {
    var text = String(rendered == null ? '' : rendered);
    var i = text.indexOf(PREAMBLE_END);
    if (i < 0) return { preamble: '', body: text };
    var end = i + PREAMBLE_END.length;
    return { preamble: text.slice(0, end), body: text.slice(end).replace(/^\n+/, '') };
  }

  /** Escape one line and turn every KNOWN doc id in it into a click-to-open chip. */
  function linkLine(text, known) {
    DOC_ID_RE.lastIndex = 0;
    var out = '', last = 0, m;
    while ((m = DOC_ID_RE.exec(text))) {
      var start = m.index;
      // left boundary: never link a substring of a longer token (e.g. supercase.index)
      var prev = start > 0 ? text.charAt(start - 1) : '';
      var bounded = !prev || !/[a-z0-9._-]/i.test(prev);
      // the greedy pattern swallows sentence dots — trim `.`/`-` until the registry knows the id
      var cand = m[0], tail = '';
      while (cand && !known[cand] && /[.-]$/.test(cand)) { tail = cand.slice(-1) + tail; cand = cand.slice(0, -1); }
      if (bounded && known[cand]) {
        out += esc(text.slice(last, start))
          + '<a class="doclink" data-doc="' + esc(cand) + '" title="Open ' + esc(cand) + '">' + esc(cand) + '</a>'
          + esc(tail);
        last = start + m[0].length;
      }
    }
    return out + esc(text.slice(last));
  }

  /** Escape a whole doc body, linkifying known ids OUTSIDE fenced blocks only (a mermaid
   *  fence's node labels are full of doc ids and must stay byte-identical). Returns HTML. */
  function linkifyHtml(text, known) {
    var lines = String(text == null ? '' : text).split('\n');
    var out = [], inFence = false;
    for (var i = 0; i < lines.length; i++) {
      if (FENCE_RE.test(lines[i])) { inFence = !inFence; out.push(esc(lines[i])); }
      else if (inFence) out.push(esc(lines[i]));
      else out.push(linkLine(lines[i], known));
    }
    return out.join('\n');
  }

  // ── state ─────────────────────────────────────────────────────────────────
  var state = {
    docs: [],                     // data.workflows — FULL stored docs (body + inline history)
    defaults: [],                 // data.defaults — built-in ids with no stored doc yet
    known: Object.create(null),   // every id in the registry (stored ∪ defaults): the linkifier's gate
    cues: {},                     // case.<slug> → RECOGNIZE cue, parsed out of the case.index body
    selectedId: null,
    detail: null,                 // { doc, defaultBody, rendered } from GET :id
    detailErr: null,
    detailMissing: false,         // the server said NOT_FOUND — this id does not exist (≠ a transport error)
    detailLoading: false,
    tab: 'rendered',
    hist: null,                   // snapshots for selectedId (null = not fetched for this doc yet)
    histErr: null,
    histLoading: false,
    histMore: false,              // the last page came back FULL — there may be older revisions
    histPaging: false,            // a "load older" fetch is in flight (the first page is histLoading)
    rollbackArm: null,            // rev awaiting confirmation — a rollback NEVER fires on one click
    filter: { q: '', ns: '' },    // client-side; ns '' = all
    seq: 0,                       // drops the response of a superseded doc click (fast switching)
    // ── editor ────────────────────────────────────────────────────────────
    // loadedRev is the optimistic-concurrency anchor: the rev this draft was based on (0 = an
    // un-stored default). Save re-GETs and refuses if it moved. base* is what was loaded, draft*
    // is what is typed; dirty = they differ.
    draftTitle: '', draftBody: '', baseTitle: '', baseBody: '', loadedRev: 0,
    busy: false,                  // a write is in flight — save/revert/rollback all disable
    conflict: null,               // {freshRev, byKind} when a save was refused by the rev guard
    msg: null,                    // {text, bad} — the write status line, survives a repaint
  };

  // A hard failure of the primary data call: cover the screen with the server's own text.
  function fatal(message) {
    var old = $('fatal-layer');
    if (old) old.remove();
    var d = document.createElement('div');
    d.className = 'fatal';
    d.id = 'fatal-layer';
    d.innerHTML = '<div class="fatal-card"><div class="fatal-h">Mission processes could not be loaded</div>'
      + '<pre class="fatal-msg"></pre><button class="primary" id="fatal-retry">Retry</button></div>';
    d.querySelector('.fatal-msg').textContent = message;   // textContent — server text is NOT trusted HTML
    document.body.appendChild(d);
    $('fatal-retry').onclick = function () { d.remove(); loadList(); };
    reportHeight();
  }

  // ── filters ───────────────────────────────────────────────────────────────
  function chipset(el, values, current, attr) {
    el.innerHTML = values.map(function (v) {
      return '<span class="fchip' + (current === v[0] ? ' on' : '') + '" data-' + attr + '="' + esc(v[0]) + '">'
        + esc(v[1]) + '</span>';
    }).join('');
  }
  function paintChips() {
    var present = {};
    allRows().forEach(function (r) { present[nsOf(r.id)] = true; });
    var vals = [['', 'all']];
    NAMESPACE_ORDER.forEach(function (ns) { if (present[ns]) vals.push([ns, ns]); });
    chipset($('chips-ns'), vals, state.filter.ns, 'fns');
  }

  /** Every doc in the registry as a row: a stored doc wins over a same-id `defaults` entry. */
  function allRows() {
    var rows = [], stored = Object.create(null);
    state.docs.forEach(function (d) { stored[d.id] = true; rows.push({ id: d.id, kind: 'stored', doc: d }); });
    state.defaults.forEach(function (id) { if (!stored[id]) rows.push({ id: id, kind: 'default' }); });
    return rows;
  }
  function passFilters(row) {
    var f = state.filter;
    if (f.ns && nsOf(row.id) !== f.ns) return false;
    var q = f.q.trim().toLowerCase();
    if (q) {
      var hay = (row.id + ' ' + ((row.doc && row.doc.title) || '') + ' ' + (state.cues[row.id] || '')).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  }
  /** Visible rows grouped by namespace, groups in NAMESPACE_ORDER, rows sorted by id. */
  function visibleGroups() {
    var byNs = {};
    allRows().filter(passFilters).forEach(function (r) {
      if (r.id === OVERVIEW_ID) return;           // pinned separately, above the groups
      var ns = nsOf(r.id);
      (byNs[ns] = byNs[ns] || []).push(r);
    });
    var out = [];
    NAMESPACE_ORDER.forEach(function (ns) {
      if (!byNs[ns]) return;
      byNs[ns].sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
      out.push({ ns: ns, rows: byNs[ns] });
    });
    return out;
  }

  // ── list rows ─────────────────────────────────────────────────────────────
  function rowPills(row) {
    var p = row.kind === 'default'
      ? '<span class="pill def">default</span>'
      : '<span class="pill rev">rev ' + esc(row.doc.rev) + '</span>';
    if (row.doc && row.doc.editPolicy === 'human-only') p += '<span class="pill human">human-only</span>';
    return p;
  }
  function rowHtml(row, opts) {
    opts = opts || {};
    var sel = state.selectedId === row.id ? ' sel' : '';
    var cue = nsOf(row.id) === 'case' ? state.cues[row.id] : null;
    var who = row.doc ? ((row.doc.lastUpdatedBy && row.doc.lastUpdatedBy.kind) || 'unknown') : '';
    var when = row.doc && row.doc.updatedAt ? ' · ' + ago(row.doc.updatedAt) : '';
    return '<div class="row' + sel + (opts.pin ? ' pin' : '') + '" data-doc="' + esc(row.id) + '">'
      + '<div class="rt"><span class="rid">' + esc(row.id) + '</span>' + rowPills(row) + '</div>'
      + (row.doc ? '<div class="rtitle">' + esc(row.doc.title) + '</div>' : '<div class="rtitle dim">built-in default — not stored yet</div>')
      + (row.doc ? '<div class="rsub">' + esc(who + when) + '</div>' : '')
      + (opts.pin ? '<div class="rsub">The map of the control flow — start here.</div>' : '')
      + (cue ? '<div class="rcue" title="' + esc(cue) + '">' + esc(cue) + '</div>' : '')
      + '</div>';
  }

  function paintList() {
    var groups = visibleGroups();
    var pinned = allRows().filter(function (r) { return r.id === OVERVIEW_ID && passFilters(r); });
    var shown = pinned.length;
    var html = pinned.map(function (r) { return rowHtml(r, { pin: true }); }).join('');
    groups.forEach(function (g) {
      shown += g.rows.length;
      html += '<div class="grp">' + esc(g.ns) + ' <span class="grp-n">(' + g.rows.length + ')</span></div>'
        + g.rows.map(function (r) { return rowHtml(r); }).join('');
    });
    var total = allRows().length;
    $('list').innerHTML = html || '<div class="empty-list">'
      + (total ? 'No process docs match the current filter.' : 'No process docs in the registry.') + '</div>';
    $('counts').textContent = 'showing ' + shown + ' of ' + total + ' doc' + (total === 1 ? '' : 's')
      + ' · ' + state.docs.length + ' stored · ' + state.defaults.length + ' default';
    reportHeight();
  }

  // ── load: the registry list (the primary call) ────────────────────────────
  /** opts.soft: this is the REFRESH after a landed write, not the page's primary load. A failure
   *  here means the list is stale — it does NOT mean the save failed, so it must not raise the
   *  full-screen fatal that would tell the user exactly the wrong thing. */
  function loadList(opts) {
    var soft = !!(opts && opts.soft);
    return api('node', '/mission/workflows').then(function (r) {
      if (!r.ok) {
        if (soft) { say('the write landed, but refreshing the list failed — ' + r.error.code + ': ' + r.error.message, true); return; }
        fatal(r.error.code + ': ' + r.error.message); return;
      }
      // data is the WRAPPER { workflows, defaults } — never a bare array.
      state.docs = (r.data && Array.isArray(r.data.workflows)) ? r.data.workflows : [];
      state.defaults = (r.data && Array.isArray(r.data.defaults)) ? r.data.defaults : [];
      state.known = Object.create(null);
      allRows().forEach(function (row) { state.known[row.id] = true; });
      return loadCues().then(function () {
        paintChips();
        paintList();
        // Land somewhere useful: an inbound deep link wins, else the overview map.
        // 🔴 An inbound id is ALWAYS asked about — known to this registry or not. Gating the
        // open on `state.known[want]` made an unknown `?doc=` a total no-op: no request, no
        // message, and the address bar still claiming a doc nobody ever opened. Two reasons the
        // gate was wrong. (1) `known` comes from the LIST read, which is leader-anchored and may
        // be answered by a replica that has not caught up — refusing locally asserts something
        // this pane cannot know, and the doc route is the only thing that can settle it.
        // (2) Even when the id really is bogus, that is a fact worth SAYING; silently landing on
        // the overview is exactly the swallow this pane promises not to do. The server's
        // NOT_FOUND becomes the explicit "no such document" state in paintDetail().
        if (!state.selectedId) {
          var want = deepLinkDoc();
          if (want) openDoc(want);
          else if (state.known[OVERVIEW_ID]) openDoc(OVERVIEW_ID);
          // 🔴 Neither: paint the neutral state EXPLICITLY. This branch is reachable — measured,
          // `process.overview` is not in this node's registry at all — and without this call the
          // detail column keeps index.html's STATIC "Select a process doc to view it.", which is
          // how a rejected off-vocabulary param went unreported: the note lives in paintDetail
          // and paintDetail was never invoked on the one path that needs it.
          else paintDetail();
        } else {
          paintDetail();
        }
      });
    });
  }

  /** case.index cues are decorative — best-effort, never fail the page on them. The stored
   *  doc already carries its body in the list, so only an UN-STORED default needs a fetch. */
  function loadCues() {
    if (!state.known['case.index']) { state.cues = {}; return Promise.resolve(); }
    var stored = null;
    state.docs.forEach(function (d) { if (d.id === 'case.index') stored = d; });
    if (stored) { state.cues = parseCaseIndex(stored.body); return Promise.resolve(); }
    return api('node', '/mission/workflows/case.index').then(function (r) {
      state.cues = r.ok && r.data ? parseCaseIndex(r.data.doc ? r.data.doc.body : r.data.defaultBody) : {};
    });
  }

  // ── detail ────────────────────────────────────────────────────────────────
  /** Adopt a doc as the editor's base: draft = base = what is stored, and loadedRev becomes the
   *  concurrency anchor. Called on load AND after every landed write — a rollback moves the doc
   *  under the editor, so leaving a stale base there would make the NEXT save conflict-check
   *  against a rev that no longer exists. An un-stored default has no doc: base is defaultBody
   *  at rev 0, which is exactly what a first save should be diffed against. */
  function adoptDoc(d) {
    var doc = d && d.doc ? d.doc : null;
    state.baseBody = (doc ? doc.body : (d && d.defaultBody)) || '';
    state.baseTitle = (doc ? doc.title : '') || state.selectedId || '';
    state.draftBody = state.baseBody;
    state.draftTitle = state.baseTitle;
    state.loadedRev = doc && typeof doc.rev === 'number' ? doc.rev : 0;
    state.conflict = null;
  }

  function openDoc(id) {
    if (!id) return Promise.resolve();
    var seq = ++state.seq;
    state.selectedId = id;
    state.detail = null;
    state.detailErr = null;
    state.detailMissing = false;
    state.detailLoading = true;
    state.tab = 'rendered';
    state.hist = null;
    state.histErr = null;
    state.histLoading = false;
    state.histMore = false;
    state.histPaging = false;
    state.rollbackArm = null;
    state.busy = false;
    state.msg = null;
    adoptDoc(null);                                // drop the previous doc's draft immediately
    syncUrl();
    paintList();                                   // re-highlight the selected row
    paintDetail();
    return api('node', '/mission/workflows/' + encodeURIComponent(id)).then(function (r) {
      if (seq !== state.seq) return;               // a newer click already superseded this one
      state.detailLoading = false;
      if (!r.ok) {
        state.detailErr = r.error.code + ': ' + r.error.message;
        // NOT_FOUND is a FACT about the id, not a failure of the call — the route answers it
        // (HTTP 400 + {code:'NOT_FOUND'}) for an id that is neither stored nor built-in. It gets
        // its own state because "retry, it may work" is the wrong thing to say about it.
        state.detailMissing = r.error.code === 'NOT_FOUND';
        state.detail = null;
      } else { state.detail = r.data || null; state.detailErr = null; state.detailMissing = false; adoptDoc(state.detail); }
      paintDetail();
    });
  }

  /** Ids from THIS node's registry that a mistyped/stale `id` plausibly meant. RANKED, because
   *  the cheap version was worse than useless: a `case.*` typo matched all 17 case docs on the
   *  namespace alone and the slice cut off before the one id the user actually meant. Prefix
   *  beats substring beats "the typed id contains a real one" beats bare namespace. Suggestion
   *  only — never auto-opened. */
  function nearIds(id) {
    var q = String(id || '').toLowerCase();
    if (!q) return [];
    var dot = q.indexOf('.');
    var ns = dot > 0 ? q.slice(0, dot + 1) : '';
    var scored = [];
    allRows().forEach(function (r) {
      var lx = r.id.toLowerCase();
      if (lx === q) return;
      var rank = lx.indexOf(q) === 0 ? 0            // case.captur → case.capture
        : lx.indexOf(q) > 0 ? 1                     // the typed id is embedded in a real one
        : q.indexOf(lx) >= 0 ? 2                    // the typed id has a real one inside it
        : (ns && lx.indexOf(ns) === 0) ? 3          // right namespace, wrong leaf
        : -1;
      if (rank >= 0) scored.push({ id: r.id, rank: rank });
    });
    scored.sort(function (a, b) { return a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    return scored.slice(0, 8).map(function (x) { return x.id; });
  }

  /** The id does not exist here. Say so explicitly, name it, quote the server verbatim, and leave
   *  `?doc=` in the address bar pointing at it — the URL and the screen must agree, which is the
   *  half of this that a silent fallback to the overview got wrong. Same shape as the way
   *  assist-sessions surfaces an inbound session id its node does not have. */
  function missingHtml(id) {
    var near = nearIds(id);
    var total = allRows().length;
    return '<div class="d-idrow"><span class="d-id">' + esc(id) + '</span>'
      + '<span class="pill missing">no such document</span></div>'
      + '<div class="err-box"><strong>No process doc with this id on this node.</strong><br>'
      + 'The link asked for <code>' + esc(id) + '</code>. It is neither a stored doc nor a built-in default '
      + 'here, and the server said <code>' + esc(state.detailErr) + '</code>. Nothing was opened in its place '
      + 'and nothing was written; the address bar still carries <code>doc=' + esc(id) + '</code> so it matches '
      + 'what you are looking at. This registry holds ' + esc(total) + ' doc' + (total === 1 ? '' : 's')
      + ' — they are listed on the left. A link from another node, or from before a doc was renamed, lands here.'
      + '</div>'
      + (near.length
        ? '<div class="note">Closest ids in this registry: '
          + near.map(function (x) {
            return '<a class="doclink" data-doc="' + esc(x) + '" title="Open ' + esc(x) + '">' + esc(x) + '</a>';
          }).join(' · ')
          + '</div>'
        : '')
      + '<div class="actions">'
      + '<button class="ghost sm" id="d-clear">Clear the link</button>'
      + '<button class="ghost sm" id="d-retry">Check again</button></div>';
  }

  function metaRow(label, value) {
    return value ? '<div><span class="k">' + esc(label) + ':</span> ' + esc(value) + '</div>' : '';
  }

  function tabsHtml() {
    return TABS.map(function (t) {
      return '<button class="tab' + (state.tab === t[0] ? ' on' : '') + '" data-tab="' + t[0] + '">' + esc(t[1]) + '</button>';
    }).join('');
  }

  function renderedHtml() {
    var d = state.detail;
    var split = splitRenderedPreamble(d.rendered || '');
    var body = split.body || (d.doc ? d.doc.body : d.defaultBody) || '';
    var html = '';
    if (split.preamble) {
      html += '<div class="invariants">'
        + '<div class="inv-h">🔒 INVARIANT PREAMBLE — immutable; prepended to every doc, not editable by anyone</div>'
        + '<pre class="inv-body">' + esc(split.preamble) + '</pre></div>';
    }
    if (/```mermaid/.test(body)) {
      html += '<div class="note">This doc contains a mermaid diagram. A pane ships no diagram library '
        + '(self-hosted assets only), so the fence is shown as its source below.</div>';
    }
    // Doc bodies are markdown, rendered as PLAIN TEXT pre-wrap — no md library. Known doc ids
    // become click-to-open chips (the same navigation the web page's #doc: links give you).
    html += '<pre class="content">' + linkifyHtml(body, state.known) + '</pre>';
    return html;
  }

  function rawHtml() {
    var d = state.detail;
    var raw = (d.doc ? d.doc.body : d.defaultBody) || '';
    return '<div class="note">'
      + (d.doc ? 'The stored body, exactly as saved — no invariant preamble, no linkification.'
               : 'The BUILT-IN default body (this doc has never been stored).')
      + ' ' + esc(String(raw.length)) + ' chars.</div>'
      + '<pre class="content">' + esc(raw) + '</pre>';
  }

  // ── edit tab ──────────────────────────────────────────────────────────────
  function isDirty() {
    return state.draftBody !== state.baseBody || state.draftTitle !== state.baseTitle;
  }
  /** Everything that blocks a save, as the reason it blocks — so the button can SAY why it is
   *  disabled instead of being mysteriously grey. Empty body and over-cap are the server's own
   *  two INVALID_INPUT/BODY_TOO_LARGE rules (workflow-model.ts validateWorkflowBody). */
  function saveBlocker() {
    if (state.busy) return 'a write is already in flight';
    if (!isDirty()) return 'nothing changed yet';
    if (!state.draftBody) return 'the body cannot be empty — the server refuses it';
    if (utf8Bytes(state.draftBody) > MAX_BODY_BYTES) return 'the body is over the ' + fmtBytes(MAX_BODY_BYTES) + ' cap';
    if (!state.draftTitle.trim()) return 'the title cannot be empty';
    return '';
  }

  function editHtml() {
    var d = state.detail;
    var doc = d.doc || null;
    if (doc && doc.editPolicy === 'human-only') {
      return '<div class="notebar"><strong>🔒 Read-only here: this doc is <code>human-only</code>.</strong><br>'
        + 'The controller may never change it, and this pane keeps that ceiling: it never sends '
        + '<code>editPolicy</code> and never edits a doc carrying this one. Core would in fact ACCEPT the write '
        + '(a pane write is attributed <code>user</code>, not <code>controller</code>) — which is exactly why the '
        + 'refusal is here. Change it deliberately with the <code>mission_workflow_set</code> tool. '
        + 'History and Rollback stay available on the next tab.</div>';
    }
    var blocker = saveBlocker();
    var html = '';
    if (state.conflict) {
      html += '<div class="warnbar"><strong>Save refused — the doc moved while you were editing.</strong><br>'
        + 'It went from rev ' + esc(state.loadedRev) + ' to rev ' + esc(state.conflict.freshRev)
        + (state.conflict.byKind ? ' (by ' + esc(state.conflict.byKind) + ')' : '')
        + '. Nothing was written, and your draft is untouched below — copy anything you need, then reload to '
        + 'edit on top of the new revision. '
        + '<button class="ghost sm" id="e-reload">Reload (discards this draft)</button></div>';
    }
    if (!doc) {
      html += '<div class="notebar">This doc has never been stored — it is the BUILT-IN default. Saving creates '
        + 'rev 1 as an override; the built-in stays in the code and reappears only if the stored doc is removed.</div>';
    }
    html += '<div class="notebar">Editing this text changes what Mission Control is handed on its next pass. '
      + 'The invariant preamble is NOT part of the body and cannot be edited here or anywhere.</div>'
      + '<label class="fld">title<input id="e-title" class="q" type="text" spellcheck="false"></label>'
      + '<label class="fld">body <span class="hint" id="e-bytes"></span>'
      + '<textarea id="e-body" rows="20" spellcheck="false"></textarea></label>'
      + '<div class="actions">'
      + '<span class="hint" id="e-why">' + esc(blocker) + '</span>'
      + '<button class="ghost" id="e-revert"' + (isDirty() && !state.busy ? '' : ' disabled') + '>Revert</button>'
      + '<button class="primary" id="e-save"' + (blocker ? ' disabled' : '') + '>'
      + esc(state.busy ? 'Saving…' : 'Save (rev ' + state.loadedRev + ' → ' + (state.loadedRev + 1) + ')')
      + '</button></div>';
    return html;
  }

  /** Meters + button state only — NEVER a repaint. paintDetail() replaces the whole detail
   *  subtree, so repainting on keystroke would destroy the textarea the user is typing in. */
  function refreshEditMeters() {
    var n = utf8Bytes(state.draftBody), over = n > MAX_BODY_BYTES;
    var m = $('e-bytes');
    if (m) {
      m.textContent = fmtBytes(n) + ' / ' + fmtBytes(MAX_BODY_BYTES)
        + (over ? ' — over the cap, the server would refuse this' : '') + ' · markdown, stored verbatim';
      m.className = 'hint' + (over ? ' bad' : '');
    }
    var blocker = saveBlocker();
    if ($('e-why')) $('e-why').textContent = blocker;
    if ($('e-save')) $('e-save').disabled = !!blocker;
    if ($('e-revert')) $('e-revert').disabled = !isDirty() || state.busy;
  }

  // ── history tab ───────────────────────────────────────────────────────────
  function rollbackBarHtml() {
    var rev = state.rollbackArm;
    var s = null;
    (state.hist || []).forEach(function (x) { if (x.rev === rev) s = x; });
    if (!s) return '';
    var cur = state.detail && state.detail.doc ? state.detail.doc.rev : 0;
    return '<div class="warnbar"><strong>Restore revision ' + esc(s.rev) + '?</strong><br>'
      + 'Saved ' + esc(ago(s.at)) + ' (' + esc(absTime(s.at)) + ') by '
      + esc((s.actor && s.actor.kind) || 'unknown')
      + (s.actor && s.actor.label ? ' (' + esc(s.actor.label) + ')' : '')
      + ' · ' + esc(fmtBytes(s.bodyBytes)) + ' · policy ' + esc(s.editPolicy || '—') + '<br>'
      + 'title: “' + esc(s.title || '') + '”<br>'
      + 'This re-saves rev ' + esc(s.rev) + '’s title and body as a NEW rev ' + esc(cur + 1)
      + ' — nothing is deleted and rev ' + esc(cur) + ' stays in this list. Mission Control picks the '
      + 'restored text up on its next pass, and any unsaved draft in the Edit tab is dropped.'
      + '<div class="actions">'
      + '<button class="ghost sm" id="rb-cancel">Cancel</button>'
      + '<button class="danger sm" id="rb-go"' + (state.busy ? ' disabled' : '') + '>'
      + esc(state.busy ? 'Restoring…' : 'Yes, restore rev ' + s.rev) + '</button></div></div>';
  }

  function historyHtml() {
    if (state.histLoading) return '<div class="note">loading…</div>';
    if (state.histErr) return '<div class="err-box">' + esc(state.histErr)
      + ' <button class="ghost sm" id="hist-retry">Retry</button></div>';
    if (!state.hist) return '<div class="note">loading…</div>';
    // The cap disclosure belongs on the EMPTY state too: "no snapshots" and "snapshots pruned
    // away" look identical from here, and only one of them means "nothing ever happened".
    var cap = '<div class="note">Snapshots carry no body — the history route substitutes a byte count, so a '
      + 'revision cannot be previewed or diffed from here, only restored whole. Loaded ' + esc(HIST_PAGE)
      + ' at a time, newest first. Core keeps only the 20 most recent snapshots per doc (it prunes on every '
      + 'write), so anything older is gone from the server, not merely unloaded.</div>';
    if (!state.hist.length) {
      return cap + '<div class="empty-list">No snapshots for this doc — it has never been written '
        + '(a built-in default has no history until you save it).</div>';
    }
    var cur = state.detail && state.detail.doc ? state.detail.doc.rev : null;
    var rows = state.hist.map(function (s) {
      var isCur = cur != null && s.rev === cur;
      return '<tr><td class="mono">' + esc(s.rev)
        + (isCur ? '<span class="pill cur">current</span>' : '') + '</td>'
        + '<td title="' + esc(absTime(s.at)) + '">' + esc(ago(s.at)) + '</td>'
        + '<td>' + esc((s.actor && s.actor.kind) || 'unknown')
        + (s.actor && s.actor.label ? ' <span class="dim">(' + esc(s.actor.label) + ')</span>' : '') + '</td>'
        + '<td class="ttl">' + esc(s.title || '') + '</td>'
        + '<td class="mono">' + esc(fmtBytes(s.bodyBytes)) + '</td>'
        + '<td class="mono">' + esc(s.editPolicy || '') + '</td>'
        + '<td>' + (isCur ? '<span class="dim">—</span>'
          : '<button class="ghost sm" data-roll="' + esc(s.rev) + '"'
            + (state.busy ? ' disabled' : '') + '>Restore…</button>') + '</td></tr>';
    }).join('');
    return cap
      + (state.rollbackArm != null ? rollbackBarHtml() : '')
      + '<div class="tablewrap"><table class="hist"><thead><tr>'
      + '<th>rev</th><th>when</th><th>actor</th><th>title</th><th>size</th><th>policy</th><th></th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table></div>'
      + '<div class="pager">'
      + '<span class="dim">' + esc(state.hist.length) + ' revision' + (state.hist.length === 1 ? '' : 's')
      + ' loaded (rev ' + esc(state.hist[state.hist.length - 1].rev) + '–' + esc(state.hist[0].rev) + ')</span>'
      + (state.histMore
        ? '<button class="ghost sm" id="hist-more"' + (state.histPaging ? ' disabled' : '') + '>'
          + esc(state.histPaging ? 'loading…' : 'Load older revisions') + '</button>'
        : '<span class="dim">· nothing older on the server</span>')
      + '</div>';
  }

  function paintDetail() {
    var el = $('detail');
    var id = state.selectedId;
    if (!id) {
      el.className = 'detail empty';
      // A caller that sent a param this pane cannot honour gets told so HERE, on the very view
      // its link landed on. Landing silently on the neutral state is what made the old
      // "Processes ↗" button look like a working deep link while doing nothing at all.
      var bad = unhonouredParam();
      el.textContent = bad === 'mission'
        ? 'This link carried "?mission=", which this pane cannot act on: the workflow registry '
          + 'is fleet-wide and its documents are addressed by doc id — no document belongs to a '
          + 'mission. Pick a process doc from the list, or ask the linking pane to resolve the '
          + 'mission on its side and send "?doc=<id>".'
        : bad === 'id'
        ? 'This link carried "?id=", which is not a cross-pane parameter name. This pane opens a '
          + 'document with "?doc=<id>". Pick a process doc from the list, or ask the linking pane '
          + 'to send "?doc=" instead.'
        : 'Select a process doc to view it.';
      reportHeight();
      return;
    }
    el.className = 'detail';
    if (state.detailLoading && !state.detail) {
      el.innerHTML = '<div class="d-idrow"><span class="d-id">' + esc(id) + '</span></div><div class="note">loading…</div>';
      reportHeight();
      return;
    }
    if (state.detailErr) {
      el.innerHTML = state.detailMissing
        ? missingHtml(id)
        : '<div class="d-idrow"><span class="d-id">' + esc(id) + '</span></div>'
          + '<div class="err-box">' + esc(state.detailErr) + ' <button class="ghost sm" id="d-retry">Retry</button></div>';
      // "Check again" is not theatre on the missing state: the doc route is leader-anchored, so
      // an id created a moment ago (or on a replica that had not caught up) can start answering.
      $('d-retry').onclick = function () { openDoc(id); };
      // Drop the dead `?doc=` and go back to the neutral state, rather than leaving a URL that a
      // reload would land on again.
      if ($('d-clear')) $('d-clear').onclick = function () {
        state.selectedId = null; state.detail = null; state.detailErr = null; state.detailMissing = false;
        syncUrl(); paintList(); paintDetail();
      };
      reportHeight();
      return;
    }
    var d = state.detail;
    if (!d) { el.innerHTML = '<div class="note">no data</div>'; reportHeight(); return; }
    var doc = d.doc || null;
    var pills = doc
      ? '<span class="pill rev">rev ' + esc(doc.rev) + '</span>'
        + '<span class="pill ' + (doc.editPolicy === 'human-only' ? 'human' : 'open') + '">' + esc(doc.editPolicy) + '</span>'
      : '<span class="pill def">default — not stored yet</span>';

    var lastEdit = doc && doc.lastUpdatedBy
      ? ((doc.lastUpdatedBy.kind || 'unknown') + (doc.lastUpdatedBy.label ? ' (' + doc.lastUpdatedBy.label + ')' : '')
        + (doc.updatedAt ? ' · ' + ago(doc.updatedAt) : ''))
      : '';

    el.innerHTML =
      '<h2 class="d-title">' + esc(doc ? doc.title : '(default doc)') + '</h2>'
      + '<div class="d-idrow"><span class="d-id">' + esc(id) + '</span>' + pills + '</div>'
      + '<div class="d-meta">'
      + metaRow('last edit', lastEdit)
      + metaRow('updated', doc && doc.updatedAt ? absTime(doc.updatedAt) : '')
      + metaRow('created', doc ? ((doc.createdBy && doc.createdBy.kind ? doc.createdBy.kind + ' · ' : '') + absTime(doc.createdAt)) : '')
      + '</div>'
      + '<div class="tabs">' + tabsHtml() + '</div>'
      + '<div class="tabbody">'
      + (state.tab === 'rendered' ? renderedHtml()
        : state.tab === 'raw' ? rawHtml()
        : state.tab === 'edit' ? editHtml()
        : historyHtml())
      + '</div>'
      + '<div id="d-out" class="out' + (state.msg && state.msg.bad ? ' err' : '') + '"></div>'
      + '<div class="ro">This pane can READ every workflow doc and WRITE exactly two things: '
      + '<code>POST /mission/workflows/&lt;id&gt;</code> (save) and '
      + '<code>POST /mission/workflows/&lt;id&gt;/rollback</code> (restore a revision). Both grants are leaf rules — '
      + 'no other mission route is reachable from here, including mission create/patch. It never sends '
      + '<code>editPolicy</code>, so it can neither set nor clear <code>human-only</code>; use '
      + '<code>mission_workflow_set</code> for that.</div>';

    // The status line is written straight into the DOM by say() so a keystroke never repaints,
    // but it must also survive the repaints that DO happen (tab switch, save, rollback).
    if (state.msg) $('d-out').textContent = state.msg.text;

    if (state.tab === 'history' && !state.hist && !state.histLoading && !state.histErr) loadHistory(id);
    if ($('hist-retry')) $('hist-retry').onclick = function () { state.histErr = null; loadHistory(id); };
    if ($('hist-more')) $('hist-more').onclick = function () { loadHistory(id, { older: true }); };
    if ($('rb-cancel')) $('rb-cancel').onclick = function () { state.rollbackArm = null; paintDetail(); };
    if ($('rb-go')) $('rb-go').onclick = function () { rollbackDoc(state.rollbackArm); };
    if ($('e-reload')) $('e-reload').onclick = function () { openDoc(id); };
    if ($('e-revert')) $('e-revert').onclick = function () {
      state.draftBody = state.baseBody; state.draftTitle = state.baseTitle; state.conflict = null;
      paintDetail(); say('reverted to the loaded rev ' + state.loadedRev + ' — nothing was written');
    };
    if ($('e-save')) $('e-save').onclick = saveDoc;
    if ($('e-body')) {
      // .value, not an HTML attribute: a body full of </textarea> or &amp; must round-trip
      // byte-for-byte, and the parser would eat it out of markup.
      $('e-body').value = state.draftBody;
      $('e-body').addEventListener('input', function (e) { state.draftBody = e.target.value; refreshEditMeters(); });
      $('e-title').value = state.draftTitle;
      $('e-title').addEventListener('input', function (e) { state.draftTitle = e.target.value; refreshEditMeters(); });
      refreshEditMeters();
    }
    reportHeight();
  }

  /** Write status. Updates the live node when it exists so an in-progress edit is never
   *  repainted out from under the caret; state.msg keeps it across the repaints that follow. */
  function say(text, bad) {
    state.msg = text ? { text: text, bad: !!bad } : null;
    var el = $('d-out');
    if (el) { el.textContent = text || ''; el.className = 'out' + (bad ? ' err' : ''); reportHeight(); }
    else if (state.selectedId) paintDetail();
  }

  // ── history (lazy, paged with beforeRev — the route is newest-first) ───────
  function loadHistory(id, opts) {
    var older = !!(opts && opts.older);
    if (older && (state.histPaging || !state.hist || !state.hist.length)) return Promise.resolve();
    if (older) state.histPaging = true; else { state.histLoading = true; state.hist = null; state.histMore = false; }
    state.histErr = null;
    paintDetail();
    var seq = state.seq;
    var qs = '?limit=' + HIST_PAGE
      + (older ? '&beforeRev=' + encodeURIComponent(state.hist[state.hist.length - 1].rev) : '');
    return api('node', '/mission/workflows/' + encodeURIComponent(id) + '/history' + qs).then(function (r) {
      if (seq !== state.seq) return;               // the user moved to another doc meanwhile
      state.histLoading = false;
      state.histPaging = false;
      if (!r.ok) {
        state.histErr = r.error.code + ': ' + r.error.message;
        if (!older) state.hist = null;             // a failed PAGE must not erase what is loaded
      } else {
        var page = (r.data && Array.isArray(r.data.snapshots)) ? r.data.snapshots : [];
        // A full page means "there may be more", never "there is more" — the next fetch settles
        // it by coming back empty, which is what the route does past the oldest rev (curled).
        state.histMore = page.length === HIST_PAGE;
        state.hist = older ? state.hist.concat(page) : page;
        state.histErr = null;
        if (older && !page.length) say('no older revisions on the server');
      }
      paintDetail();
    });
  }

  // ── writes (the two granted POSTs) ────────────────────────────────────────
  /** Adopt the doc a write RETURNED. `rendered` is recomputed from the preamble the server last
   *  sent plus the new body rather than re-GETting: the read routes are leader-anchored and the
   *  write is origin-anchored, so an immediate re-GET can legitimately answer with the PREVIOUS
   *  rev and make a landed save look dropped. The preamble is never taken from a constant here —
   *  it is server-owned text and a copy in this file would silently rot. */
  function applyWrittenDoc(doc) {
    if (!doc) return;
    var split = splitRenderedPreamble((state.detail && state.detail.rendered) || '');
    state.detail = state.detail || { doc: null, defaultBody: null, rendered: '' };
    state.detail.doc = doc;
    state.detail.rendered = split.preamble ? split.preamble + '\n' + doc.body : doc.body;
    adoptDoc(state.detail);
    state.hist = null;                             // a new snapshot exists — force a refetch
    state.histMore = false;
    state.rollbackArm = null;
    // Keep the list row's rev/title/updatedAt honest without a round trip; loadList() below is
    // authoritative but may be answered by a replica that has not caught up yet.
    var found = false;
    state.docs.forEach(function (x, i) { if (x.id === doc.id) { state.docs[i] = doc; found = true; } });
    if (!found) {
      state.docs.push(doc);
      state.defaults = state.defaults.filter(function (x) { return x !== doc.id; });
      state.known[doc.id] = true;
    }
    paintChips();
    paintList();          // the row's rev/actor/timestamp updates even if the soft refresh fails
  }

  function saveDoc() {
    var id = state.selectedId;
    var blocked = saveBlocker();
    if (blocked) { say('save not sent — ' + blocked, true); return; }
    state.busy = true;
    state.conflict = null;
    say('checking for a concurrent edit…');
    refreshEditMeters();
    var seq = state.seq;
    // Rev-conflict guard: re-GET and refuse if the doc moved since this draft was loaded. It is
    // advisory, not a transaction — the server has no compare-and-set — but it is what turns
    // "silently clobbered someone" into "told you, kept your draft".
    api('node', '/mission/workflows/' + encodeURIComponent(id)).then(function (pre) {
      if (seq !== state.seq) return;
      if (!pre.ok) {
        state.busy = false; refreshEditMeters();
        say('save not sent — the pre-save check failed: ' + pre.error.code + ': ' + pre.error.message, true);
        return;
      }
      var freshDoc = pre.data && pre.data.doc;
      var freshRev = (freshDoc && freshDoc.rev) || 0;
      if (freshRev !== state.loadedRev) {
        state.busy = false;
        state.conflict = { freshRev: freshRev, byKind: freshDoc && freshDoc.lastUpdatedBy && freshDoc.lastUpdatedBy.kind };
        paintDetail();
        say('SAVE REFUSED — ' + id + ' moved from rev ' + state.loadedRev + ' to rev ' + freshRev
          + ' while you were editing. Nothing was written; your draft is still in the editor.', true);
        return;
      }
      say('saving ' + id + '…');
      // editPolicy is deliberately absent: omitted, the server keeps the doc's existing policy.
      return api('node', '/mission/workflows/' + encodeURIComponent(id),
        { method: 'POST', body: { title: state.draftTitle, body: state.draftBody } }
      ).then(function (r) {
        if (seq !== state.seq) return;
        state.busy = false;
        if (!r.ok) {
          paintDetail();
          say('save failed — ' + r.error.code + ': ' + r.error.message + ' (nothing was written)', true);
          return;
        }
        var doc = r.data && r.data.doc;
        var changed = !(r.data && r.data.changed === false);
        applyWrittenDoc(doc);
        paintDetail();
        say(changed
          ? 'saved ' + id + ' → rev ' + (doc ? doc.rev : '?') + '. Mission Control reads the new text on its next pass.'
          : 'no change — the body and title were byte-identical, so the server kept rev ' + (doc ? doc.rev : '?') + '.');
        return loadList({ soft: true });
      });
    });
  }

  function rollbackDoc(toRev) {
    var id = state.selectedId;
    if (state.busy || toRev == null) return;
    state.busy = true;
    paintDetail();
    say('restoring rev ' + toRev + ' of ' + id + '…');
    var seq = state.seq;
    api('node', '/mission/workflows/' + encodeURIComponent(id) + '/rollback',
      { method: 'POST', body: { toRev: toRev } }
    ).then(function (r) {
      if (seq !== state.seq) return;
      state.busy = false;
      if (!r.ok) {
        paintDetail();
        say('rollback failed — ' + r.error.code + ': ' + r.error.message + ' (nothing was written)', true);
        return;
      }
      var doc = r.data && r.data.doc;
      applyWrittenDoc(doc);
      paintDetail();
      // rev N restored to rev N+1 — unless the content was already identical, in which case the
      // server no-ops and the rev does not move. Report what actually happened, not the intent.
      say(doc && doc.rev === toRev
        ? 'rev ' + toRev + ' was already the current content — nothing changed.'
        : 'restored rev ' + toRev + ' as rev ' + (doc ? doc.rev : '?') + ' of ' + id + '.');
      // applyWrittenDoc nulled state.hist, and paintDetail re-fetches it whenever the History
      // tab is the one on screen — fetching it again here would just double the request.
      return loadList({ soft: true });
    });
  }

  // ── routing — the INBOUND half of the PINNED cross-pane param vocabulary ──────────────────
  // The vocabulary (see the block comment in ui-apps/assist-missions/assets/app.js) is:
  //   session · project · mission · task · cluster · tool · dataset · skill · unit · doc
  // plus the two generic modifiers `tab` and `q`. A pane READS the names that name entities it
  // can actually display. This pane displays exactly one entity — a workflow DOC — so `doc` is
  // the only name it reads.
  //
  // 🔴 It used to read `/[?&](?:doc|id)=/`. `id` is on the vocabulary's explicit BANNED list
  // ("not sessionId, not id, not missionId, not highlight") and no pane emits it, so it is gone
  // — an off-vocabulary alias that is also dead code is pure invitation for the next caller to
  // spell it wrong and get away with it here but nowhere else.
  //
  // 🔴 `mission` is deliberately NOT read, and NOT silently swallowed either. This registry is
  // fleet-wide: its docs are keyed by doc id (controller.pass, drive.feature, case.index, …),
  // a Mission carries no workflow reference (core/src/mission/mission-model.ts), and this
  // pane's grant reaches `/mission/workflows` ONLY — it could not resolve a mission id even if
  // it wanted to, and widening that grant to make a deep link work would trade this pane's
  // whole security posture for a convenience. So an inbound `?mission=` cannot be honoured, and
  // the pane SAYS SO on screen (see the boot block) instead of quietly opening the default view
  // and letting the caller believe the link worked. The caller's job is to resolve the mission
  // to a doc on its side, where the mission is already loaded and already readable, and send
  // `doc=` — which is exactly what assist-missions' "Process doc ↗" button now does.
  //
  // An id this node does not have is NOT ignored: it is fetched like any other, and the route's
  // NOT_FOUND becomes the "no such document" state, with `?doc=` left in place so the URL says
  // the same thing the screen does.
  function deepLinkDoc() {
    var m = /[?&]doc=([^&]*)/.exec(location.search);
    try { return m ? decodeURIComponent(m[1]) : ''; } catch (e) { return m ? m[1] : ''; }
  }
  /** An inbound param this pane cannot act on. Returns its NAME (for the on-screen note), or ''. */
  function unhonouredParam() {
    return /[?&]mission=[^&]/.test(location.search) ? 'mission'
      : /[?&]id=[^&]/.test(location.search) ? 'id' : '';
  }
  function syncUrl() {
    try {
      var qs = [];
      if (EMBEDDED) qs.push('embed=1');
      if (THEME === 'light') qs.push('theme=light');
      if (state.selectedId) qs.push('doc=' + encodeURIComponent(state.selectedId));
      history.replaceState(null, '', location.pathname + (qs.length ? '?' + qs.join('&') : ''));
    } catch (e) { /* sandboxed frame — the selection lives in `state` regardless */ }
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  $('list').addEventListener('click', function (e) {
    var row = e.target.closest ? e.target.closest('.row') : null;
    if (!row || !row.dataset.doc) return;
    openDoc(row.dataset.doc);
  });
  $('chips-ns').addEventListener('click', function (e) {
    if (e.target.dataset.fns === undefined) return;
    state.filter.ns = e.target.dataset.fns; paintChips(); paintList();
  });
  $('q').addEventListener('input', function (e) { state.filter.q = e.target.value; paintList(); });
  $('btn-refresh').onclick = function () {
    $('list').innerHTML = 'loading…';
    var id = state.selectedId;                     // re-open the same doc against the fresh registry
    var keepDraft = isDirty();                     // …unless that would throw away typed-but-unsaved text
    loadList().then(function () {
      if (!id) return;
      if (keepDraft) {
        paintList();
        say('registry refreshed. ' + id + ' was NOT reloaded because you have unsaved changes — '
          + 'save them, or use Reload in the Edit tab to discard them and pick up the stored version.'
          + (state.known[id] ? '' : ' (It is also no longer listed in the registry.)'));
        return;
      }
      // Re-open it whether or not the refreshed list still lists it. The old code blanked the
      // detail pane when the id vanished from the list — same swallow as the deep link: an empty
      // pane, no message, and `?doc=<id>` still in the address bar. The doc route settles it, and
      // an id that really is gone now lands on the explicit "no such document" state.
      openDoc(id);
    });
  };
  // Delegated on the container because paintDetail replaces its children wholesale.
  $('detail').addEventListener('click', function (e) {
    var t = e.target;
    if (t.dataset && t.dataset.tab) {
      // Leaving Edit with unsaved text is a real loss — the draft lives only in `state`, and a
      // reload or a doc switch drops it. Confirm rather than lose it silently.
      if (state.tab === 'edit' && t.dataset.tab !== 'edit' && isDirty()) {
        say('you have unsaved changes in the Edit tab — they are kept while you look around, '
          + 'but Reload, Refresh registry, or opening another doc will discard them');
      }
      state.tab = t.dataset.tab;
      paintDetail();
      return;
    }
    // Arm a rollback — it NEVER fires from this click; the confirm bar's own button does it.
    if (t.dataset && t.dataset.roll !== undefined) {
      var rev = parseInt(t.dataset.roll, 10);
      if (!isNaN(rev)) { state.rollbackArm = rev; paintDetail(); }
      return;
    }
    var link = t.closest ? t.closest('a.doclink') : null;
    if (link && link.dataset.doc) { e.preventDefault(); openDoc(link.dataset.doc); }
  });

  // Who is signed in (identity rides the session, not the view token).
  fetch('/auth/me', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
    $('who-name').textContent = (d.claims && (d.claims.name || d.claims.email)) || d.userId || 'signed in';
  }).catch(function () { $('who-name').textContent = 'signed in'; });

  // ── boot ──────────────────────────────────────────────────────────────────
  loadList();
})();
