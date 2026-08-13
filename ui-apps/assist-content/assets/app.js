/* assist-content — the assist-content registry (the bootstrap/guide prose the MCP
 * connector serves, overridable fleet-wide with no deploy) PLUS assist-resources (the
 * ~/.lm-assist file + log browser). Two tabs, one pane: they are sibling surfaces over
 * the same node — one edits what the connector SAYS, the other reads what it WROTE.
 * Plain JS, no build, no deps. Every data call goes through the injected SDK helper
 * (lmui.call), which carries the view token and re-mints it on 401/403.
 *
 * Two declared grants:
 *   node:/assist-resources [GET]        — read-only, prefix-covers files/file/file-stat/log
 *   node:/assist-content   [GET,POST]   — the only writes this pane can make
 * The view token's grant is the hard ceiling; nothing else is reachable.
 *
 * Paths + envelope shapes mirror the handlers, read AND curled at build time:
 *   GET  /assist-content            → {units[],orphanDocs[],groups[],counts{}}   (WRAPPER)
 *   GET  /assist-content/:id        → FLAT unit row + {knownUnit,defaultBody,defaultBlurb,
 *                                     doc,effectiveBody,effectiveBlurb} — NOT {unit:…}
 *   POST /assist-content/:id        → {doc,changed,knownUnit}; body {contentOverride?,
 *                                     blurbOverride?} — null clears, undefined leaves alone
 *   POST /assist-content/:id/rollback {toRev} → {doc}
 *   GET  /assist-resources/files?depth=N     → {root{…children[]},extras[],totalFiles,
 *                                               totalSize,lastActivity}  (RECURSIVE tree)
 *   GET  /assist-resources/file?path=ABS&limit → {format,size,modified,content|entries,…}
 *   GET  /assist-resources/file-stat?path=ABS  → {path,size,modified}
 *   GET  /assist-resources/log?file=KEY&limit&search → {file,format,entries[],totalLines,
 *                                                       matchCount}
 * Content bodies are markdown, rendered as PLAIN TEXT pre-wrap — no md library. The one
 * exception is the [label](#doc:id) cross-unit link, linkified AFTER escaping. */
(function () {
  'use strict';

  // Server-side caps (mcp-server/registry/content-model.ts) — mirrored so the editor can
  // refuse locally instead of round-tripping to a rejection.
  var MAX_CONTENT_BYTES = 16384;
  var MAX_BLURB_BYTES = 300;
  // The `file` param of /assist-resources/log is a KEY into a server-side map, NOT a path.
  // Anything else is ASSIST_RESOURCES_UNKNOWN_LOG, so the viewer must branch on this list.
  var KNOWN_LOGS = ['context-inject-hook.log', 'mcp-calls.jsonl'];
  // The deepest walk the Tree depth control offers. The server caps at 6, but the select only
  // lists 1–4, so offering a re-walk past 4 would leave the visible control blank — and past 4
  // the payload is already ~26 MB. Beyond it the honest answer is "this is as deep as it goes".
  var MAX_TREE_DEPTH = 4;

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

  // ── formatters ────────────────────────────────────────────────────────────
  // Accepts epoch ms OR an ISO string: /assist-content dates are numbers, every
  // /assist-resources date is an ISO string, and both land in the same rows.
  function ago(v) {
    if (v == null || v === '') return '—';
    var ms = typeof v === 'number' ? v : Date.parse(v);
    var m = Math.floor((Date.now() - ms) / 60000);
    if (!isFinite(m) || m < 0) return isFinite(ms) ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '—';
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    if (m < 1440) return Math.floor(m / 60) + 'h ago';
    return Math.floor(m / 1440) + 'd ago';
  }
  function fmtBytes(n) {
    if (n == null || !isFinite(n)) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  var TE = window.TextEncoder ? new TextEncoder() : null;
  function utf8Bytes(s) { return TE ? TE.encode(s).length : new Blob([String(s)]).size; }

  // ── state ───────────────────────────────────────────────────────────────
  var state = {
    tab: 'content',                  // 'content' | 'resources'
    filter: '',                      // client-side text filter (per-tab, reset on switch)
    // content registry
    units: [],                       // unit rows from GET /assist-content .units
    orphans: [],                     // .orphanDocs — valid docs this build emits no unit for
    groups: ['overview', 'bootstrap', 'guide'],   // .groups, server-declared render order
    counts: null,                    // .counts {units,overridden,orphans}
    sel: null,                       // the FLAT detail payload of GET /assist-content/:id
    sub: 'view',                     // detail sub-tab: 'view' | 'edit' | 'history'
    showDefault: false,              // view sub-tab: show code default instead of override
    loadedRev: 0,                    // optimistic-concurrency anchor (0 = not stored yet)
    draftBody: '', baseBody: '', draftBlurb: '', baseBlurb: '',
    conflict: null,                  // {freshRev, byKind} when a save was refused
    busy: false,                     // a write is in flight
    seq: 0,                          // drops the response of a superseded unit open
    // resources
    root: null,                      // FileInfo tree root (recursive .children)
    extras: [],                      // allow-listed files outside the data dir
    resStats: null,                  // {totalFiles,totalSize,lastActivity}
    depth: 2,
    expanded: {},                    // path -> true
    file: null,                      // the selected FileInfo
    body: null,                      // the /file or /log payload for state.file
    logSearch: '',                   // search term for the content viewer
    watch: true,                     // poll file-stat and reload on mtime change
    changed: false,                  // the watcher saw the file move
  };
  var watchTimer = null, searchTimer = null, watchedMtime = null;

  function say(msg, isErr) {
    var out = $('out');
    if (!out) return;
    out.textContent = typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2);
    out.classList.toggle('err', !!isErr);
    reportHeight();
  }

  // A hard failure of the active tab's primary call: cover the screen with the server's text.
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

  /** 🔴 #list-hint and #counts are SHARED by both tabs, and only a tab's own paint ever writes
   *  them — so for the whole multi-second Resources walk the header still read the CONTENT
   *  tab's blurb and "showing 30 of 30 units": a precise, confident, WRONG description of what
   *  is on screen, which is worse than a blank one. A load must therefore claim the header
   *  SYNCHRONOUSLY (before the await), and the paint that lands the real data clears the mark.
   *  Both directions matter — Content is the stale one when you switch the other way. */
  function headerLoading(hint) {
    var h = $('list-hint'), c = $('counts');
    if (h) { h.textContent = hint; h.classList.add('loading'); }
    if (c) { c.textContent = 'counting…'; c.classList.add('loading'); }
  }
  function headerReady(hint, counts) {
    var h = $('list-hint'), c = $('counts');
    if (h) { h.textContent = hint; h.classList.remove('loading'); }
    if (c) { c.textContent = counts; c.classList.remove('loading'); }
  }

  // ── tabs ────────────────────────────────────────────────────────────────
  function switchTab(t) {
    if (t === state.tab) return;
    state.tab = t;
    state.filter = '';
    $('q').value = '';
    clearFatal();
    stopWatch();
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.classList.toggle('on', b.dataset.tab === t);
    });
    // `hidden`, not an inline display — app.css makes [hidden] win over the .fld display rule.
    $('depth-wrap').hidden = t !== 'resources';
    if (t === 'content') {
      $('q').placeholder = 'filter unit id / title / group…';
      paintDetail();
      if (state.units.length) paintList(); else loadUnits();
    } else {
      $('q').placeholder = 'filter files…';
      paintDetail();
      if (state.root) paintList(); else loadFiles();
      startWatch();                       // resume polling the file we were on before the switch
    }
    reportHeight();
  }
  function reloadActive() { if (state.tab === 'content') loadUnits(); else loadFiles(); }
  function paintList() { if (state.tab === 'content') paintUnitList(); else paintTree(); }
  function paintDetail() { if (state.tab === 'content') paintUnitDetail(); else paintFileDetail(); }

  // ═══ CONTENT REGISTRY TAB ═════════════════════════════════════════════════
  /** `quiet` refreshes the list badges after a write WITHOUT stealing the selection,
   *  the sub-tab or the scroll position — and without a hard fatal if that refresh alone
   *  fails, since the write it follows already succeeded. */
  function loadUnits(quiet) {
    if (!quiet) {
      $('list').innerHTML = 'loading…';
      headerLoading('Loading the content registry…');
    }
    return api('node', '/assist-content').then(function (r) {
      // The tab guard is the same one every paint below carries: a failure that resolves after
      // the user has moved on must not pin a fatal over the tab they are now looking at.
      if (!r.ok) { if (!quiet && state.tab === 'content') fatal(r.error.code + ': ' + r.error.message); return; }
      var d = r.data || {};
      state.units = d.units || [];
      state.orphans = d.orphanDocs || [];
      if (d.groups && d.groups.length) state.groups = d.groups;
      state.counts = d.counts || null;
      paintUnitList();
      // bootstrap/overview leads the output — it is the natural entry point.
      if (!quiet && !state.sel && state.units.length) openUnit(state.units[0].id);
    });
  }

  function unitMatch(u) {
    var q = state.filter.trim().toLowerCase();
    if (!q) return true;
    return ((u.id || '') + ' ' + (u.title || '') + ' ' + (u.group || '') + ' ' + (u.key || '')).toLowerCase().indexOf(q) >= 0;
  }

  function unitRowHtml(u) {
    var sel = state.sel && state.sel.id === u.id ? ' sel' : '';
    var pills = (u.rev != null
      ? '<span class="pill rev mono">rev ' + esc(u.rev) + '</span>'
      : '<span class="pill">default</span>')
      + (u.hasOverride ? '<span class="pill ovr">override</span>' : '')
      + (u.hasBlurbOverride ? '<span class="pill ovr">blurb</span>' : '')
      + (u.renderedIn || []).map(function (t) { return '<span class="pill rin">§' + esc(t) + '</span>'; }).join('')
      + '<span class="pill">' + fmtBytes(u.overrideBytes != null ? u.overrideBytes : u.defaultBytes) + '</span>';
    var who = u.rev != null
      ? '<div class="rsub dim">' + esc((u.lastUpdatedBy && u.lastUpdatedBy.kind) || 'unknown') + ' · ' + esc(ago(u.updatedAt)) + '</div>'
      : '';
    return '<div class="row' + sel + '" data-uid="' + esc(u.id) + '">'
      + '<div class="rt">' + esc(u.id) + '</div>'
      + '<div class="rsub">' + esc(u.title || '') + '</div>' + who
      + '<div class="rmeta">' + pills + '</div></div>';
  }

  function orphanRowHtml(o) {
    var sel = state.sel && state.sel.id === o.name ? ' sel' : '';
    return '<div class="row' + sel + '" data-uid="' + esc(o.name) + '">'
      + '<div class="rt">' + esc(o.name) + '</div>'
      + '<div class="rmeta"><span class="pill rev mono">rev ' + esc(o.rev) + '</span>'
      + '<span class="pill warn">orphan</span>'
      + '<span class="pill">' + esc(ago(o.updatedAt)) + '</span></div></div>';
  }

  /** 🔴 Both tabs render into the SAME #list / #detail (index.html has one of each), so every
   *  paint reached from a PROMISE must re-check the tab it belongs to: the tab can change
   *  between the request and its response. Without this, clicking a unit and then the
   *  Resources tab before the open resolves paints unit rows into the file tree. state.seq
   *  does not cover it — it only supersedes one open by a newer open, not by a tab switch.
   *  The file-stat watcher already guards this way (`state.tab !== 'resources'`); these are
   *  the same guard on the other async paths. Synchronous callers (a row click, switchTab
   *  itself, which sets state.tab BEFORE it paints) pass it unchanged. */
  function paintUnitList() {
    if (state.tab !== 'content') return;
    var vis = state.units.filter(unitMatch);
    var html = [], n = 0;
    state.groups.concat(['(other)']).forEach(function (g) {
      var rows = vis.filter(function (u) {
        return g === '(other)' ? state.groups.indexOf(u.group) < 0 : u.group === g;
      });
      if (!rows.length) return;
      n += rows.length;
      html.push('<div class="grp">' + esc(g) + ' <span class="dim">(' + rows.length + ')</span></div>');
      html.push(rows.map(unitRowHtml).join(''));
    });
    var orph = state.orphans.filter(function (o) {
      var q = state.filter.trim().toLowerCase();
      return !q || String(o.name).toLowerCase().indexOf(q) >= 0;
    });
    if (orph.length) {
      n += orph.length;
      html.push('<div class="grp">orphans <span class="dim">(' + orph.length + ')</span></div>');
      html.push(orph.map(orphanRowHtml).join(''));
    }
    $('list').innerHTML = n
      ? html.join('')
      : '<div class="empty-list">' + (state.units.length ? 'No units match the filter.' : 'No content units on this node.') + '</div>';
    var c = state.counts;
    headerReady(
      'The prose bootstrap()/guide() serve. An override applies fleet-wide, live, with no deploy.',
      'showing ' + n + ' of ' + (state.units.length + state.orphans.length) + ' unit'
        + (state.units.length + state.orphans.length === 1 ? '' : 's')
        + (c ? ' · ' + c.overridden + ' overridden' + (c.orphans ? ' · ' + c.orphans + ' orphan' : '') : ''));
    reportHeight();
  }

  /** Load one unit. `effectiveBody` is what actually renders — loading `defaultBody`
   *  into the editor would silently discard an existing override on the next save. */
  function applyUnit(d) {
    state.sel = d;
    state.baseBody = d.effectiveBody || '';
    state.draftBody = state.baseBody;
    state.baseBlurb = d.effectiveBlurb || '';
    state.draftBlurb = state.baseBlurb;
    state.loadedRev = (d.doc && d.doc.rev) || 0;
    state.conflict = null;
    state.showDefault = false;
  }

  function openUnit(id) {
    var seq = ++state.seq;
    return api('node', '/assist-content/' + encodeURIComponent(id)).then(function (r) {
      if (seq !== state.seq) return;                 // a newer open already superseded this
      if (!r.ok) {
        state.sel = { errId: id, errMsg: r.error.code + ': ' + r.error.message };
        paintUnitDetail(); return;
      }
      applyUnit(r.data || {});
      state.sub = 'view';
      paintUnitDetail();
      paintUnitList();                               // re-highlight the selected row
    });
  }

  function metaRow(label, value) {
    return value ? '<div><span class="k">' + esc(label) + ':</span> ' + esc(value) + '</div>' : '';
  }

  /** Body text with [label](#doc:id) turned into a clickable sibling-unit chip. The
   *  linkify runs AFTER esc(), so every capture is already-escaped text and the only
   *  markup in the result is ours. This is the one markdown construct we honour — it is
   *  navigation (the overview map is 29 of these), not decoration. */
  var DOCLINK_RE = /\[([^\]\n]{0,160})\]\(#doc:([a-z0-9][a-z0-9.-]{0,88})\)/g;
  function withDocLinks(text) {
    return esc(text).replace(DOCLINK_RE, function (m, label, id) {
      return '<button class="doclink" data-doc="' + esc(id) + '" title="Open ' + esc(id) + '">'
        + (label.replace(/`/g, '') || esc(id)) + '</button>';
    });
  }

  function paintUnitDetail() {
    if (state.tab !== 'content') return;      // shared #detail — see paintUnitList
    var el = $('detail'), d = state.sel;
    if (!d) {
      el.className = 'detail empty';
      el.textContent = 'Select a content unit on the left to read, edit or roll it back.';
      return;
    }
    el.className = 'detail';
    if (d.errId) {
      el.innerHTML = '<h2 class="d-title">' + esc(d.errId) + '</h2><pre class="mono"></pre>';
      el.querySelector('.mono').textContent = d.errMsg;
      reportHeight(); return;
    }
    var doc = d.doc || null;
    var pills = (doc ? '<span class="pill rev mono">rev ' + esc(doc.rev) + '</span>'
      : '<span class="pill">default — not stored yet</span>')
      + (doc && doc.contentOverride != null ? '<span class="pill ovr">override</span>' : '')
      + (doc && doc.blurbOverride != null ? '<span class="pill ovr">blurb</span>' : '')
      + (d.knownUnit === false ? '<span class="pill warn">orphan</span>' : '')
      + (d.renderedIn || []).map(function (t) {
        return '<span class="pill rin" title="This unit\'s body renders in the ' + esc(t) + ' tool output">§' + esc(t) + '</span>';
      }).join('');
    el.innerHTML =
      '<h2 class="d-title">' + esc(d.id) + '</h2>'
      + '<div class="d-idrow"><span class="d-id">' + esc(d.title || (d.knownUnit === false ? '(orphan doc — no code unit)' : '')) + '</span></div>'
      + '<div class="d-pills">' + pills + '</div>'
      + '<div class="d-meta">'
      + metaRow('group', d.group)
      + metaRow('default size', d.defaultBytes != null ? fmtBytes(d.defaultBytes) : '')
      + metaRow('last edit', doc ? ((doc.lastUpdatedBy && doc.lastUpdatedBy.kind) || 'unknown') + ' · ' + ago(doc.updatedAt) : '')
      + '</div>'
      + '<div class="subtabs">'
      + ['view', 'edit', 'history'].map(function (t) {
        return '<button class="stab' + (state.sub === t ? ' on' : '') + '" data-sub="' + t + '">' + t + '</button>';
      }).join('')
      + '</div>'
      + '<div id="dbody"></div><div id="out" class="out">ready</div>';
    paintUnitBody();
  }

  function paintUnitBody() {
    var d = state.sel, doc = d.doc || null, el = $('dbody');
    if (!el) return;
    if (state.sub === 'view') {
      var overridden = !!(doc && doc.contentOverride != null);
      var showingDefault = state.showDefault && overridden;
      var text = showingDefault ? (d.defaultBody || '') : (d.effectiveBody || '');
      el.innerHTML =
        (d.knownUnit === false
          ? '<div class="warnbar">Orphan doc — this build emits no such unit, so it NEVER renders in bootstrap/guide.</div>' : '')
        + (d.knownUnit !== false && d.key === 'index' && d.group === 'guide'
          ? '<div class="notebar">The <code>## Topics</code> list that follows this preamble in the live guide output is GENERATED from the topic catalog (edit a topic\'s one-liner on its own doc; the list itself stays code-owned).</div>' : '')
        + (d.hasBlurb
          ? '<div class="blurb"><span class="k">index one-liner:</span> ' + esc(d.effectiveBlurb || '(none)')
            + (doc && doc.blurbOverride != null ? '<span class="pill ovr">override</span>' : '') + '</div>' : '')
        + (overridden
          ? '<div class="d-sect"><button class="ghost" id="tgl-default">'
            + (showingDefault ? 'Show the override (rev ' + esc(doc.rev) + ')' : 'Show the code default (' + fmtBytes(d.defaultBytes) + ')')
            + '</button>' + (showingDefault ? ' <span class="dim">showing the CODE DEFAULT — not what renders</span>' : '') + '</div>' : '')
        // Markdown rendered as PLAIN TEXT pre-wrap — no md library; only #doc: links are live.
        + '<pre class="mono' + (text ? '' : ' none') + '">' + (text ? withDocLinks(text) : '(empty)') + '</pre>';
      if ($('tgl-default')) $('tgl-default').onclick = function () { state.showDefault = !state.showDefault; paintUnitBody(); };
    } else if (state.sub === 'edit') {
      var dirty = state.draftBody !== state.baseBody || (d.hasBlurb && state.draftBlurb !== state.baseBlurb);
      var over = utf8Bytes(state.draftBody) > MAX_CONTENT_BYTES;
      el.innerHTML =
        (state.conflict
          ? '<div class="warnbar">Doc changed since you loaded it (rev ' + esc(state.loadedRev) + ' → ' + esc(state.conflict.freshRev)
            + (state.conflict.byKind ? ', by ' + esc(state.conflict.byKind) : '')
            + '). Save refused — your draft stays in the editor until you reload. '
            + '<button class="ghost" id="e-reload">Reload (discard draft)</button></div>' : '')
        + (d.knownUnit === false
          ? '<div class="warnbar">Orphan doc — edits persist (history/rollback work) but never render anywhere.</div>' : '')
        + (d.hasBlurb
          ? '<label class="fld">index one-liner <span class="hint" id="e-bbytes"></span>'
            + '<input id="e-blurb" class="q" type="text" placeholder="(empty = restore the code default)">'
            + '</label>' : '')
        + '<label class="fld">body <span class="hint" id="e-bytes"></span>'
        + '<textarea id="e-body" rows="18" spellcheck="false"></textarea></label>'
        + '<div class="actions">'
        + (doc && doc.contentOverride != null ? '<button class="ghost" id="e-restore">Restore default</button>' : '')
        + '<button class="ghost" id="e-revert"' + (dirty ? '' : ' disabled') + '>Revert</button>'
        + '<button class="primary" id="e-save"' + (dirty && !over ? '' : ' disabled') + '>Save (rev '
        + esc(state.loadedRev) + ' → ' + esc(state.loadedRev + 1) + ')</button></div>';
      $('e-body').value = state.draftBody;
      if ($('e-blurb')) $('e-blurb').value = state.draftBlurb;
      refreshEditMeters();
      $('e-body').addEventListener('input', function (e) { state.draftBody = e.target.value; refreshEditMeters(); });
      if ($('e-blurb')) $('e-blurb').addEventListener('input', function (e) { state.draftBlurb = e.target.value; refreshEditMeters(); });
      if ($('e-reload')) $('e-reload').onclick = function () { openUnit(d.id); };
      if ($('e-restore')) $('e-restore').onclick = function () { confirmThen(this, 'Really restore the code default?', restoreDefault); };
      $('e-revert').onclick = function () {
        state.draftBody = state.baseBody; state.draftBlurb = state.baseBlurb; state.conflict = null; paintUnitBody();
      };
      $('e-save').onclick = saveUnit;
    } else {
      var hist = (doc && doc.history) ? doc.history.slice().reverse() : [];
      el.innerHTML = hist.length
        ? '<table class="hist"><thead><tr><th>rev</th><th>when</th><th>actor</th><th>override</th><th>blurb</th><th></th></tr></thead><tbody>'
          + hist.map(function (h) {
            var st = h.state || {};
            var bl = st.blurbOverride == null ? '—' : '"' + String(st.blurbOverride).slice(0, 40) + (String(st.blurbOverride).length > 40 ? '…' : '') + '"';
            return '<tr><td class="mono-c">' + esc(h.rev) + (h.rev === doc.rev ? ' <span class="pill cur">current</span>' : '') + '</td>'
              + '<td title="' + esc(new Date(h.at).toISOString()) + '">' + esc(ago(h.at)) + '</td>'
              + '<td>' + esc((h.actor && h.actor.kind) || 'unknown') + '</td>'
              + '<td class="mono-c">' + esc(st.contentOverride == null ? '— default' : fmtBytes(utf8Bytes(st.contentOverride))) + '</td>'
              + '<td class="mono-c">' + esc(bl) + '</td>'
              + '<td>' + (h.rev !== doc.rev ? '<button class="ghost" data-roll="' + esc(h.rev) + '">Rollback</button>' : '') + '</td></tr>';
          }).join('') + '</tbody></table>'
        : '<div class="empty-list">No revisions yet — the doc has never been written (defaults have no history).</div>';
    }
    reportHeight();
  }

  function refreshEditMeters() {
    var n = utf8Bytes(state.draftBody), over = n > MAX_CONTENT_BYTES;
    var m = $('e-bytes');
    if (m) { m.textContent = fmtBytes(n) + ' / ' + fmtBytes(MAX_CONTENT_BYTES) + (over ? ' — over the cap, save is blocked' : ''); m.classList.toggle('bad', over); }
    var bm = $('e-bbytes');
    if (bm) {
      var bn = utf8Bytes(state.draftBlurb), bad = bn > MAX_BLURB_BYTES || /[\r\n]/.test(state.draftBlurb);
      bm.textContent = bn + ' / ' + MAX_BLURB_BYTES + ' B, single line' + (bad ? ' — the server will refuse this' : '');
      bm.classList.toggle('bad', bad);
    }
    var d = state.sel;
    var dirty = state.draftBody !== state.baseBody || (d.hasBlurb && state.draftBlurb !== state.baseBlurb);
    if ($('e-save')) $('e-save').disabled = !dirty || over || state.busy;
    if ($('e-revert')) $('e-revert').disabled = !dirty || state.busy;
  }

  /** A two-click confirm, standing in for the app's ConfirmButton. */
  function confirmThen(btn, label, run) {
    if (btn.dataset.armed === '1') { run(); return; }
    var old = btn.textContent;
    btn.dataset.armed = '1';
    btn.textContent = label;
    btn.classList.add('danger');
    setTimeout(function () {
      if (btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.textContent = old; btn.classList.remove('danger'); }
    }, 4000);
  }

  /** Every registry write lands here. The response carries the ORIGIN's fresh doc — apply
   *  it in place rather than re-GETting a possibly-lagging local replica, which would make
   *  a successful save look dropped. */
  function writeUnit(body, opts) {
    var d = state.sel, id = d.id;
    if (state.busy) return;
    state.busy = true;
    say('saving…');
    var pre = (opts && opts.skipConflictCheck)
      ? Promise.resolve(null)
      : api('node', '/assist-content/' + encodeURIComponent(id)).then(function (r) {
        if (!r.ok) return { hard: r.error };
        var freshRev = (r.data && r.data.doc && r.data.doc.rev) || 0;
        if (freshRev !== state.loadedRev) {
          return { conflict: { freshRev: freshRev, byKind: r.data.doc && r.data.doc.lastUpdatedBy && r.data.doc.lastUpdatedBy.kind } };
        }
        return null;
      });
    pre.then(function (pre2) {
      if (pre2 && pre2.hard) { state.busy = false; say('pre-check failed — ' + pre2.hard.code + ': ' + pre2.hard.message, true); return; }
      if (pre2 && pre2.conflict) {
        state.busy = false; state.conflict = pre2.conflict; paintUnitBody();
        say('save refused — the doc moved to rev ' + pre2.conflict.freshRev + ' while you were editing', true);
        return;
      }
      return api('node', '/assist-content/' + encodeURIComponent(id), { method: 'POST', body: body }).then(function (r) {
        state.busy = false;
        if (!r.ok) { say('save failed — ' + r.error.code + ': ' + r.error.message, true); return; }
        var doc = r.data && r.data.doc;
        applyUnit({
          id: d.id, group: d.group, key: d.key, title: d.title, renderedIn: d.renderedIn,
          hasBlurb: d.hasBlurb, defaultBytes: d.defaultBytes, knownUnit: d.knownUnit,
          defaultBody: d.defaultBody, defaultBlurb: d.defaultBlurb, doc: doc || null,
          effectiveBody: (doc && doc.contentOverride != null) ? doc.contentOverride : d.defaultBody,
          effectiveBlurb: (doc && doc.blurbOverride != null) ? doc.blurbOverride : d.defaultBlurb,
        });
        paintUnitDetail();
        // AFTER the repaint: paintUnitDetail rebuilds #out, so an earlier say() is wiped.
        say('saved ' + id + (doc ? ' → rev ' + doc.rev : '') + (r.data && r.data.changed === false ? ' (no change)' : ''));
        loadUnits(true);
      });
    });
  }

  function saveUnit() {
    var d = state.sel;
    var body = { contentOverride: state.draftBody };
    // An emptied blurb field means "back to the code default" (null), not an empty string.
    if (d.hasBlurb && state.draftBlurb !== state.baseBlurb) {
      body.blurbOverride = state.draftBlurb.trim() === '' ? null : state.draftBlurb;
    }
    writeUnit(body);
  }
  function restoreDefault() {
    var d = state.sel;
    var body = { contentOverride: null };
    if (d.hasBlurb) body.blurbOverride = null;
    writeUnit(body, { skipConflictCheck: true });
  }
  function rollbackUnit(toRev) {
    var d = state.sel;
    if (state.busy) return;
    state.busy = true;
    say('rolling back to rev ' + toRev + '…');
    api('node', '/assist-content/' + encodeURIComponent(d.id) + '/rollback', { method: 'POST', body: { toRev: toRev } })
      .then(function (r) {
        state.busy = false;
        if (!r.ok) { say('rollback failed — ' + r.error.code + ': ' + r.error.message, true); return; }
        openUnit(d.id).then(function () {
          say('rolled back ' + d.id + ' to rev ' + toRev);   // after the repaint, which rebuilds #out
          return loadUnits(true);
        });
      });
  }

  // ═══ RESOURCES TAB ════════════════════════════════════════════════════════
  function loadFiles() {
    $('list').innerHTML = 'loading… (walking ~/.lm-assist at depth ' + state.depth + ')';
    // Claimed BEFORE the request: this walk takes seconds to tens of seconds, and that whole
    // window is when the header is read.
    headerLoading('Walking ~/.lm-assist at depth ' + state.depth + '… (a deeper walk takes longer)');
    return api('node', '/assist-resources/files?depth=' + encodeURIComponent(state.depth)).then(function (r) {
      if (!r.ok) { if (state.tab === 'resources') fatal(r.error.code + ': ' + r.error.message); return; }
      var d = r.data || {};
      state.root = d.root || null;
      state.extras = d.extras || [];
      state.resStats = { totalFiles: d.totalFiles, totalSize: d.totalSize, lastActivity: d.lastActivity };
      if (state.root && state.root.path) state.expanded[state.root.path] = true;
      paintTree();
    });
  }

  function subtreeMatches(node, q) {
    if (!q) return true;
    if (String(node.name).toLowerCase().indexOf(q) >= 0) return true;
    var kids = node.children || [];
    for (var i = 0; i < kids.length; i++) if (subtreeMatches(kids[i], q)) return true;
    return false;
  }

  function padStyle(depth) { return 'style="padding-left:' + (0.35 + depth * 0.85) + 'rem"'; }
  function noteRow(depth, html) { return '<div class="tnote" ' + padStyle(depth) + '>' + html + '</div>'; }

  /** 🔴 The server walks ~/.lm-assist EAGERLY to a fixed depth and sends the whole tree in one
   *  response — there is no per-directory listing route, so a directory the walk never entered
   *  arrives with NO `children` key at all (only a `fileCount` from its own readdir). It still
   *  rendered as expandable, so clicking it flipped the twisty and rendered nothing: a silent
   *  no-op on every directory below the depth budget, which at the default depth=2 is most of
   *  the tree. `children == null` and `children == []` are DIFFERENT facts and must not collapse
   *  into one falsy branch — one means "not fetched", the other means "genuinely empty".
   *  Neither can be fixed by a lazy fetch here, so the expansion states why, and offers the one
   *  control that actually loads it: a deeper re-walk. */
  function unwalkedNote(node, depth) {
    if (node.fileCount == null) return noteRow(depth, 'This directory could not be listed by the server (permissions?).');
    // fileCount comes from the directory's OWN readdir, which the server ran even where it did
    // not recurse — so 0 is authoritative and has nothing to do with the depth budget. Offering
    // a re-walk here would send a user off to re-fetch 4 MB to be shown the same empty folder.
    if (node.fileCount === 0) return noteRow(depth, 'Empty directory.');
    var n = node.fileCount;
    var msg = esc(n) + ' entr' + (n === 1 ? 'y' : 'ies') + ' not loaded — the server walked only '
      + esc(state.depth) + ' level' + (state.depth === 1 ? '' : 's') + ' into ~/.lm-assist, so this '
      + 'directory\'s contents were never sent. ';
    msg += state.depth < MAX_TREE_DEPTH
      ? '<button class="ghost" data-deepen="' + (state.depth + 1) + '">Re-walk at depth ' + (state.depth + 1) + '</button>'
      : 'Tree depth is already at its maximum (' + MAX_TREE_DEPTH + ').';
    return noteRow(depth, msg);
  }

  function treeRows(node, depth, q, out) {
    var pad = padStyle(depth);
    if (node.isDirectory) {
      var open = !!state.expanded[node.path];
      var walked = !!node.children && typeof node.children.length === 'number';
      out.push('<div class="trow dir' + (walked ? '' : ' unwalked') + '" data-dir="' + esc(node.path) + '" ' + pad
        + (walked ? '' : ' title="Not walked at depth ' + esc(state.depth) + ' — expand for why"') + '>'
        + '<span class="tw">' + (open ? '▾' : '▸') + '</span>'
        + '<span class="tn">' + esc(node.name) + '</span>'
        + '<span class="tm">' + esc(node.fileCount != null ? node.fileCount : (node.children || []).length) + ' · ' + fmtBytes(node.size) + '</span></div>');
      if (open) {
        if (!walked) { out.push(unwalkedNote(node, depth + 1)); return; }
        var kids = node.children.filter(function (c) { return subtreeMatches(c, q); });
        kids.forEach(function (c) { treeRows(c, depth + 1, q, out); });
        // An expand that yields no row is the same silent no-op whatever the cause — a filter
        // that hides every child reads exactly like a broken twisty. Say which it is.
        if (!kids.length) {
          out.push(noteRow(depth + 1, node.children.length
            ? esc(node.children.length) + ' entr' + (node.children.length === 1 ? 'y' : 'ies') + ', none matching the filter.'
            : 'Empty directory.'));
        }
      }
      return;
    }
    var sel = state.file && state.file.path === node.path ? ' sel' : '';
    out.push('<div class="trow file' + sel + '" data-file="' + esc(node.path) + '" ' + pad + '>'
      + '<span class="tw"></span><span class="tn">' + esc(node.name) + '</span>'
      + '<span class="tm">' + fmtBytes(node.size) + ' · ' + esc(ago(node.modified)) + '</span></div>');
  }

  function paintTree() {
    if (state.tab !== 'resources') return;    // shared #list — see paintUnitList
    var s = state.resStats;
    var hint = s
      ? (s.totalFiles + ' files · ' + fmtBytes(s.totalSize) + (s.lastActivity ? ' · active ' + ago(s.lastActivity) : ''))
      : '';
    if (!state.root) {
      $('list').innerHTML = '<div class="empty-list">No assist files found.</div>';
      headerReady(hint, ''); reportHeight(); return;
    }
    var q = state.filter.trim().toLowerCase(), out = [];
    (state.root.children || []).forEach(function (c) { if (subtreeMatches(c, q)) treeRows(c, 0, q, out); });
    if (state.extras.length) {
      var ex = state.extras.filter(function (f) { return subtreeMatches(f, q); });
      if (ex.length) {
        out.push('<div class="grp">external files <span class="dim">(' + ex.length + ')</span></div>');
        ex.forEach(function (f) { treeRows(f, 0, q, out); });
      }
    }
    // Count FILE/DIR rows only — `out` now also carries group headers and the "why this expand
    // is empty" notes, and counting those would report rows the user cannot click.
    var shown = out.filter(function (h) { return h.indexOf('<div class="trow') === 0; }).length;
    $('list').innerHTML = shown ? out.join('') : '<div class="empty-list">No files match the filter.</div>';
    headerReady(hint, 'showing ' + shown + ' row' + (shown === 1 ? '' : 's') + ' at depth ' + state.depth
      + ' · deeper directories need a higher depth');
    reportHeight();
  }

  function isKnownLog(f) { return KNOWN_LOGS.indexOf(f.name) >= 0; }

  function openFile(node) {
    state.file = node;
    state.body = null;
    state.logSearch = '';
    state.changed = false;
    // Block expansion is keyed by INDEX, so it must not carry over to a different file.
    Object.keys(state.expanded).forEach(function (k) { if (k.indexOf('blk') === 0) delete state.expanded[k]; });
    watchedMtime = node.modified;
    paintFileDetail();
    paintTree();
    loadFileBody();
    startWatch();
  }

  /** Two DIFFERENT routes reach the same tree selection: /log takes a KEY from a
   *  server-side map (anything else is UNKNOWN_LOG), /file takes an ABSOLUTE path from
   *  the allow-list. Branch on the node, or half the tree 400s. */
  function loadFileBody(quiet) {
    var f = state.file;
    if (!f) return Promise.resolve();
    var known = isKnownLog(f);
    var path = known
      ? '/assist-resources/log?file=' + encodeURIComponent(f.name) + '&limit=1000'
        + (state.logSearch ? '&search=' + encodeURIComponent(state.logSearch) : '')
      : '/assist-resources/file?path=' + encodeURIComponent(f.path) + '&limit=500';
    if (!quiet) setBody('<div class="empty-list">loading…</div>');
    return api('node', path).then(function (r) {
      if (!state.file || state.file.path !== f.path) return;    // superseded by a newer pick
      if (!r.ok) {
        state.body = { err: r.error.code + ': ' + r.error.message };
      } else {
        state.body = r.data || {};
        if (state.body.modified) watchedMtime = state.body.modified;
      }
      paintFileBody();
      updateStats();
    });
  }

  function setBody(html) { var el = $('dbody'); if (el) el.innerHTML = html; reportHeight(); }

  function paintFileDetail() {
    if (state.tab !== 'resources') return;    // shared #detail — see paintUnitList
    var el = $('detail'), f = state.file;
    if (!f) {
      el.className = 'detail empty';
      el.textContent = 'Select a file on the left to read it. Logs get a searchable, parsed view.';
      return;
    }
    el.className = 'detail';
    el.innerHTML =
      '<h2 class="d-title">' + esc(f.name) + '</h2>'
      + '<div class="d-idrow"><span class="d-id">' + esc(f.path) + '</span></div>'
      + '<div class="d-pills"><span class="pill">' + fmtBytes(f.size) + '</span>'
      + '<span class="pill">' + esc(ago(f.modified)) + '</span>'
      + (isKnownLog(f) ? '<span class="pill rin">known log</span>' : '')
      + '<span class="pill" id="f-stats"></span>'
      + '<span class="pill warn" id="f-changed" hidden>updated on disk</span></div>'
      + '<div class="toolbar">'
      + '<input id="f-search" class="q" type="text" placeholder="search lines / entries…" autocomplete="off">'
      + '<label class="chk"><input type="checkbox" id="f-watch"' + (state.watch ? ' checked' : '') + '> watch</label>'
      + '<button class="ghost" id="f-refresh">Refresh</button></div>'
      + '<div id="dbody"></div>';
    $('f-search').value = state.logSearch;
    $('f-search').addEventListener('input', onSearchInput);
    $('f-watch').addEventListener('change', function (e) {
      state.watch = e.target.checked;
      if (state.watch) startWatch(); else stopWatch();
    });
    $('f-refresh').onclick = function () { state.changed = false; updateChangedBadge(); loadFileBody(); };
    paintFileBody();
  }

  /** Known logs search SERVER-side (the tail is 1000 lines of a much longer file, so a
   *  client filter would only ever see the tail). Everything else filters client-side. */
  function onSearchInput(e) {
    state.logSearch = e.target.value;
    if (searchTimer) clearTimeout(searchTimer);
    var f = state.file;
    if (f && isKnownLog(f)) {
      var mine = state.logSearch;
      searchTimer = setTimeout(function () {
        if (state.logSearch !== mine) return;         // a newer keystroke already superseded this
        loadFileBody(true);
      }, 300);
    } else {
      paintFileBody(); updateStats();
    }
  }

  function updateChangedBadge() {
    var b = $('f-changed');
    if (b) b.hidden = !state.changed;      // [hidden] beats .pill{display:inline-block} — see app.css
  }
  function updateStats() {
    var el = $('f-stats'), b = state.body;
    if (!el) return;
    if (!b || b.err) { el.textContent = '—'; return; }
    if (b.matchCount != null) el.textContent = b.matchCount + ' match' + (b.matchCount === 1 ? '' : 'es') + ' / ' + b.totalLines + ' lines';
    else if (b.totalLines != null) el.textContent = b.totalLines + ' lines';
    else el.textContent = String(b.format || '');
    updateChangedBadge();
  }

  // ── log / file renderers ─────────────────────────────────────────────────
  // Knowledge ids and session ids inside injected context are navigable in the app; the
  // knowledge one becomes a sibling-pane jump, the session id stays an inert chip (no
  // sessions pane exists to jump to). Runs AFTER esc(), so all captures are escaped text.
  var KID_RE = /\[(K\d+(?:\.\d+)?)\]/g;
  var SID_RE = /\[([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?::(\d+))?\]/g;
  function linkifyLog(text) {
    return esc(text)
      .replace(KID_RE, function (m, k) { return '<button class="klink" data-kid="' + k + '">[' + k + ']</button>'; })
      .replace(SID_RE, function (m, sid, ln) {
        return '<span class="slink" title="session ' + sid + '">[' + sid.slice(0, 8) + '…' + (ln ? ':' + ln : '') + ']</span>';
      });
  }

  var START_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] START session=([a-f0-9-]+) port=(\d+) prompt="([\s\S]*)"/;
  var END_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] END session=([a-f0-9-]+) (.+)/;
  /** context-inject-hook.log is START…context…END blocks, not independent lines — the
   *  whole value of the view is seeing WHAT got injected for WHICH prompt. */
  function parseHookBlocks(lines) {
    var blocks = [], orphans = [], cur = null;
    lines.forEach(function (line) {
      var s = START_RE.exec(line);
      if (s) { if (cur) blocks.push(cur); cur = { ts: s[1], session: s[2], port: s[3], prompt: s[4], ctx: [] }; return; }
      var e = END_RE.exec(line);
      if (e && cur) { cur.endStats = e[3]; blocks.push(cur); cur = null; return; }
      if (cur) cur.ctx.push(line);
      else if (String(line).trim()) orphans.push(line);
    });
    if (cur) blocks.push(cur);
    return { blocks: blocks, orphans: orphans };
  }

  function hookBlockHtml(b, i, isLast) {
    var m = /durationMs=(\d+)\s+sources=(\d+)\s+tokens=(\d+)/.exec(b.endStats || '');
    var open = state.expanded['blk' + i] !== undefined ? state.expanded['blk' + i] : isLast;
    var nonEmpty = b.ctx.filter(function (l) { return String(l).trim(); }).length;
    return '<div class="hb"><div class="hb-h" data-blk="' + i + '" data-open="' + (open ? '1' : '0') + '">'
      + '<span class="hb-ts">' + esc(b.ts) + '</span>'
      + '<span class="slink" title="session ' + esc(b.session) + '">' + esc(b.session.slice(0, 8)) + '…</span>'
      + '<span class="dim">:' + esc(b.port) + '</span>'
      + (m ? '<span class="pill ok">' + m[2] + ' sources</span><span class="pill">' + m[3] + ' tok</span><span class="pill">' + m[1] + 'ms</span>' : '')
      + '<span class="hb-x">' + (open ? '▲' : '▼') + ' ' + nonEmpty + '</span>'
      + '<div class="hb-p' + (open ? '' : ' clip') + '">' + esc(b.prompt) + '</div></div>'
      + (open && b.ctx.length ? '<pre class="hb-c">' + linkifyLog(b.ctx.join('\n')) + '</pre>' : '')
      + '</div>';
  }

  var TOOL_KEYS = ['query', 'id', 'content', 'topic', 'name', 'path'];
  function mcpCardHtml(e) {
    if (!e || typeof e !== 'object') return '<pre class="mono">' + esc(String(e)) + '</pre>';
    var isErr = !!(e.isError || e.error);
    var tool = e.tool || e.name || e.method || 'unknown';
    var args = e.args || {}, q = '';
    for (var i = 0; i < TOOL_KEYS.length && !q; i++) if (args[TOOL_KEYS[i]]) q = String(args[TOOL_KEYS[i]]);
    if (!q && Object.keys(args).length) q = JSON.stringify(args).slice(0, 200);
    var res = e.result || e.responsePreview || (isErr ? e.error : '') || '';
    if (typeof res !== 'string') res = JSON.stringify(res, null, 2);
    return '<div class="mc' + (isErr ? ' err' : '') + '">'
      + '<div class="mc-h"><span class="mc-t">' + esc(tool) + '</span>' + esc(q || '(no input)')
      + '<span class="mc-m">' + (e.durationMs != null ? esc(e.durationMs) + 'ms · ' : '')
      + (e.resultBytes != null ? fmtBytes(e.resultBytes) : '') + (e.ts ? ' · ' + esc(ago(e.ts)) : '') + '</span></div>'
      + (res ? '<pre class="mc-r">' + esc(res.slice(0, 8000)) + (res.length > 8000 ? '\n… (' + fmtBytes(res.length) + ' total)' : '') + '</pre>' : '')
      + '</div>';
  }

  function clientFilter(arr, q, toText) {
    if (!q) return arr;
    var lq = q.toLowerCase();
    return arr.filter(function (x) { return toText(x).toLowerCase().indexOf(lq) >= 0; });
  }

  function paintFileBody() {
    var b = state.body, f = state.file, el = $('dbody');
    if (!el || !f) return;
    if (!b) { el.innerHTML = '<div class="empty-list">loading…</div>'; reportHeight(); return; }
    if (b.err) { el.innerHTML = '<pre class="mono"></pre>'; el.querySelector('.mono').textContent = b.err; reportHeight(); return; }
    var q = state.logSearch, known = isKnownLog(f), html;

    if (b.format === 'binary') {
      html = '<div class="empty-list">' + esc(b.message || 'Binary file — cannot display contents') + ' · ' + fmtBytes(b.size) + '</div>';
    } else if (b.format === 'jsonl') {
      // Both routes can produce jsonl: /log returns server-filtered entries, /file does not.
      var ents = known ? (b.entries || []) : clientFilter(b.entries || [], q, function (x) { return JSON.stringify(x); });
      html = ents.length
        ? ents.map(mcpCardHtml).join('')
        : '<div class="empty-list">' + (q ? 'No entries match the search.' : 'No entries.') + '</div>';
    } else if (b.entries) {
      // Plain-text log via /log — entries are raw lines.
      var lines = known ? b.entries.map(String) : clientFilter(b.entries.map(String), q, function (x) { return x; });
      if (f.name === 'context-inject-hook.log') {
        var p = parseHookBlocks(lines);
        html = (p.blocks.length || p.orphans.length)
          ? p.orphans.map(function (l) { return '<div class="oline">' + linkifyLog(l) + '</div>'; }).join('')
            + p.blocks.map(function (bl, i) { return hookBlockHtml(bl, i, i === p.blocks.length - 1); }).join('')
          : '<div class="empty-list">No entries found.</div>';
      } else {
        html = lines.length
          ? '<pre class="mono">' + linkifyLog(lines.join('\n')) + '</pre>'
          : '<div class="empty-list">' + (q ? 'No lines match the search.' : 'No entries.') + '</div>';
      }
    } else if (b.format === 'json') {
      var txt = JSON.stringify(b.content, null, 2);
      if (q) {
        var keep = txt.split('\n').filter(function (l) { return l.toLowerCase().indexOf(q.toLowerCase()) >= 0; });
        txt = keep.length ? keep.join('\n') : '(no lines match the search)';
      }
      html = '<pre class="mono">' + esc(txt) + '</pre>';
    } else {
      // markdown / text — PLAIN TEXT pre-wrap, no md library.
      var body = String(b.content == null ? '' : b.content);
      if (q) {
        var kept = body.split('\n').filter(function (l) { return l.toLowerCase().indexOf(q.toLowerCase()) >= 0; });
        body = kept.length ? kept.join('\n') : '(no lines match the search)';
      }
      html = '<pre class="mono' + (body ? '' : ' none') + '">' + (body ? linkifyLog(body) : '(empty file)') + '</pre>';
    }
    if (b.truncated) html += '<div class="notebar">Server truncated the read at 1 MB (file is ' + fmtBytes(b.size) + ') — you are seeing the tail.</div>';
    el.innerHTML = html;
    reportHeight();
  }

  // ── watcher: poll file-stat, reload the body when the mtime moves ─────────
  function stopWatch() { if (watchTimer) { clearInterval(watchTimer); watchTimer = null; } }
  function startWatch() {
    stopWatch();
    if (!state.watch || !state.file || state.file.isDirectory) return;
    watchTimer = setInterval(function () {
      var f = state.file;
      if (!f || state.tab !== 'resources') return;
      api('node', '/assist-resources/file-stat?path=' + encodeURIComponent(f.path)).then(function (r) {
        if (!r.ok || !state.file || state.file.path !== f.path) return;   // poll errors stay silent
        var mod = r.data && r.data.modified;
        if (!watchedMtime) { watchedMtime = mod; return; }
        if (mod && mod !== watchedMtime) {
          watchedMtime = mod;
          state.changed = true;
          updateChangedBadge();
          loadFileBody(true);
        }
      });
    }, 2000);
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  $('tabs').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('.tab') : null;
    if (b && b.dataset.tab) switchTab(b.dataset.tab);
  });
  $('q').addEventListener('input', function (e) { state.filter = e.target.value; paintList(); });
  $('depth').addEventListener('change', function (e) {
    var n = parseInt(e.target.value, 10);
    state.depth = (isFinite(n) && n > 0) ? Math.min(n, 6) : 2;   // never send a NaN depth: the server would walk the WHOLE tree
    state.expanded = {};
    loadFiles();
  });
  /** The re-walk offered by an unwalked directory's note. It KEEPS state.expanded (unlike the
   *  depth <select>, which clears it) — the whole point is that the directory you just tried to
   *  open is still open when the deeper tree lands, so it finally shows its contents. Assigning
   *  select.value fires no change event, so this does not re-enter the handler above. */
  function deepenTo(n) {
    if (!isFinite(n) || n <= state.depth) return;
    state.depth = Math.min(n, MAX_TREE_DEPTH);
    var sel = $('depth');
    if (sel) sel.value = String(state.depth);
    loadFiles();
  }
  $('list').addEventListener('click', function (e) {
    var t = e.target.closest ? e.target : null;
    if (!t) return;
    // Checked FIRST: the note lives outside any .trow, but a stray future wrapper must never
    // turn this button into a collapse of the directory it belongs to.
    if (t.dataset && t.dataset.deepen) { deepenTo(parseInt(t.dataset.deepen, 10)); return; }
    var unit = t.closest('.row');
    if (unit && unit.dataset.uid) { openUnit(unit.dataset.uid); return; }
    var dir = t.closest('.trow.dir');
    if (dir && dir.dataset.dir) {
      state.expanded[dir.dataset.dir] = !state.expanded[dir.dataset.dir];
      paintTree(); return;
    }
    var file = t.closest('.trow.file');
    if (file && file.dataset.file) {
      var node = findNode(state.root, file.dataset.file)
        || state.extras.filter(function (x) { return x.path === file.dataset.file; })[0];
      if (node) openFile(node);
    }
  });
  $('detail').addEventListener('click', function (e) {
    var t = e.target;
    if (t.dataset && t.dataset.sub) { state.sub = t.dataset.sub; paintUnitDetail(); return; }
    if (t.dataset && t.dataset.doc) { openUnit(t.dataset.doc); return; }
    if (t.dataset && t.dataset.roll) {
      var rev = parseInt(t.dataset.roll, 10);
      confirmThen(t, 'Roll back to rev ' + rev + '?', function () { rollbackUnit(rev); });
      return;
    }
    // The param is `unit` — the pinned cross-pane name for a knowledge/content unit id.
    // It was `highlight`, which assist-knowledge never read, so this button did nothing.
    //
    // Sent at FULL grain, suffix and all. KID_RE captures either `K12` (the document) or
    // `K12.3` (one part of it). Core's document route is /^\/knowledge\/(?<id>K\d+)$/ — no
    // dot — so the dotted form is NOT a document address, but the split belongs to the
    // TARGET, not here: assist-knowledge's landOnUnit() slices the base id off for the fetch
    // and reuses the `.N` suffix to highlight that part. Normalizing to the base id here
    // would silently throw away the part precision it is written to consume.
    if (t.dataset && t.dataset.kid) { lmui.goto('assist-knowledge', { unit: t.dataset.kid }); return; }
    var hb = t.closest ? t.closest('.hb-h') : null;
    if (hb && hb.dataset.blk) {
      // The rendered open state is stamped on the node, so the toggle can't disagree with
      // the render's isLast default (reading it back out of the ▲/▼ glyph could).
      state.expanded['blk' + hb.dataset.blk] = hb.dataset.open !== '1';
      paintFileBody();
    }
  });

  function findNode(node, path) {
    if (!node) return null;
    if (node.path === path) return node;
    var kids = node.children || [];
    for (var i = 0; i < kids.length; i++) {
      var f = findNode(kids[i], path);
      if (f) return f;
    }
    return null;
  }

  // Who is signed in (identity rides the session, not the view token).
  fetch('/auth/me', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
    $('who-name').textContent = (d.claims && (d.claims.name || d.claims.email)) || d.userId || 'signed in';
  }).catch(function () { $('who-name').textContent = 'signed in'; });

  // ── boot ────────────────────────────────────────────────────────────────
  // Deep link: ?unit=<id> and/or ?tab=content|resources (what lmui.goto carries into a pane).
  //
  // 🔴 These two are NOT independent, and running them as two independent ifs was a bug:
  // `?tab=resources&unit=X` switched to Resources (depth selector, 'filter files…',
  // loadFiles + startWatch) and THEN loaded the unit into the same shared #list/#detail,
  // so the pane showed resources chrome wrapped around content rows, whichever of the two
  // fetches happened to resolve last. `unit` names an entity only the CONTENT tab can
  // render, so it decides the tab; `tab` decides on its own only when no `unit` is given.
  // Landing on Resources while quietly opening the unit behind it is the other consistent
  // reading, but it makes a deep link do nothing visible — including hiding the unknown-id
  // error state this pane promises to show.
  var qp = new URLSearchParams(location.search);
  var deepUnit = (qp.get('unit') || '').trim();     // a hand-typed '?unit=' or '?unit=%20' is no deep link
  // No switchTab('content') is needed to land the unit, only the SUPPRESSED switch below:
  // state.tab is initialised to 'content' and switchTab (its only writer) has not run yet,
  // so the content tab is already the one on screen. Were that ever to change, the tab
  // guards on the paints above degrade this to "the unit opens off-screen" — not to a
  // resources tab with content painted into it.
  if (!deepUnit && qp.get('tab') === 'resources') switchTab('resources');
  if (deepUnit) loadUnits().then(function () { openUnit(deepUnit); });
  else if (state.tab === 'content') loadUnits();
})();
