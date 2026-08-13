/* assist-data — the node's generic data service (datasets / access keys / cross-node sync)
 * as a scoped pane. Plain JS, no build, no deps. Every data call goes through the injected
 * SDK helper (lmui.call), which carries the view token and re-mints it on 401/403.
 *
 * Six narrow grants — deliberately NOT a bare node:/data, because segment-boundary prefix
 * matching would make that one rule cover the ENTIRE data plane (records PUT/DELETE, /query,
 * /sql, /admin, /export). Declared: /data/catalog [GET] · /data/keys [GET] · /data/datasets
 * [POST,DELETE] · /data/access [DELETE] · /data/sync/status [GET] · /data/sync [POST]. The
 * sync GET is pinned to /status, not /data/sync, so it cannot also reach /data/sync/manifest.
 *
 * Paths + envelope shapes mirror core/src/routes/core/data.routes.ts, each CONFIRMED against
 * the live dev API (:3200):
 *   GET    /data/catalog        → data = { you:{principal,canManage}, datasets:[…] }  (the
 *          ONLY read the page needs: /data/datasets carries the same rows but NO `you`.)
 *   GET    /data/keys           → data = { keys:[…] }        (WRAPPER, not a bare array)
 *   GET    /data/sync/status    → data = SyncStatus          (BARE object, no `status` key)
 *   POST   /data/sync           → data = SyncStatus          (same bare shape as the GET)
 *   POST   /data/datasets       → data = { dataset:{…} }
 *   DELETE /data/datasets/:id   → data = { dropped:boolean }
 *   DELETE /data/access/:keyId  → data = { revoked:boolean }
 * The last two are the trap: both answer success:true with a FALSE flag when nothing was
 * dropped/revoked (verified — DELETE of an unknown keyId returns {revoked:false}, HTTP 200),
 * so this pane reports the flag rather than the transport.
 *
 * Management (create/drop/keys/sync) is LOCAL-principal only in Core. On the node-local tier
 * the proxy calls 127.0.0.1 with the node api-token, so the pane resolves as `local` and the
 * writes work; behind the hub relay the same document resolves as `cloud`, Core answers
 * FORBIDDEN, and the pane never issues the call at all — see paintLocalOnly(). */
(function () {
  'use strict';

  // Enum vocabularies for the create form (core/src/data/types.ts). The create route defaults
  // backend to 'cache' and config to { kind:'cache' }; we always send both explicitly.
  var BACKENDS = ['cache', 'vector', 'sql'];
  var VISIBILITIES = ['local-only', 'synced', 'cross-node-readable'];
  var SYNC_MODES = ['none', 'full', 'partial'];
  var KEY_STATES = ['active', 'expired', 'revoked'];
  // The server's own dataset-id rule, echoed here so a typo fails before the round trip.
  var ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

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
  function fmtWhen(iso) {
    if (!iso) return '—';
    var s = String(iso);
    return s.length >= 16 ? s.slice(0, 16).replace('T', ' ') : s;
  }
  // Past-tense. The m<0 guard matters here: access keys carry FUTURE expiresAt, and without
  // it a future timestamp renders as "just now".
  function agoISO(iso) {
    if (!iso) return 'never';
    var m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (!isFinite(m) || m < 0) return fmtWhen(iso);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    if (m < 1440) return Math.floor(m / 60) + 'h ago';
    return Math.floor(m / 1440) + 'd ago';
  }
  function untilISO(iso) {
    if (!iso) return '—';
    var m = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
    if (!isFinite(m)) return fmtWhen(iso);
    if (m <= 0) return 'expired ' + agoISO(iso);
    if (m < 60) return 'in ' + m + 'm';
    if (m < 1440) return 'in ' + Math.floor(m / 60) + 'h';
    return 'in ' + Math.floor(m / 1440) + 'd';
  }
  function keyState(k) {
    if (k.revoked) return 'revoked';
    return new Date(k.expiresAt).getTime() < Date.now() ? 'expired' : 'active';
  }

  // ── state ───────────────────────────────────────────────────────────────
  var state = {
    tab: 'datasets',                  // 'datasets' | 'keys' | 'sync'
    principal: '',                    // catalog.you.principal — 'local' | 'cloud'
    canManage: false,                 // catalog.you.canManage — local principal only
    datasets: [],                     // catalog.datasets: {id,backend,visibility,readOnly,actions[]}
    keys: null,                       // {keys} rows, or null = not yet loaded
    sync: null,                       // bare SyncStatus, or null = not yet loaded
    filter: '',                       // client-side text filter (per-tab, reset on switch)
    fBackend: '',                     // datasets chip: '' = all
    fKeyState: '',                    // keys chip: '' = all (nothing is hidden by default)
    confirm: null,                    // { kind:'drop'|'revoke', id } — the two-step guard
    busy: false,                      // a write is in flight
  };

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
    d.innerHTML = '<div class="fatal-card"><div class="fatal-h">Data service could not be loaded</div>'
      + '<pre class="fatal-msg"></pre><button class="primary" id="fatal-retry">Retry</button></div>';
    d.querySelector('.fatal-msg').textContent = message;   // textContent — server text is NOT trusted HTML
    document.body.appendChild(d);
    $('fatal-retry').onclick = function () { d.remove(); reloadActive(); };
    reportHeight();
  }
  // Mandatory for a tabbed pane: without it a fatal raised by tab A stays pinned over tab B.
  function clearFatal() { var o = $('fatal-layer'); if (o) o.remove(); }

  // ── the read-only (non-local principal) view of a management tab ──────────
  // A hub-relayed caller resolves as `cloud`: Core answers FORBIDDEN for every management
  // call, so this pane never issues one and state.keys / state.sync stay null. EVERY entry
  // point into the keys/sync views must land here — the loaders are NOT the only one. A
  // keystroke in #q and a click on #chips call paintKeys()/paintSync() DIRECTLY, and a
  // painter that read `state.keys || []` / `state.sync || {}` would answer with FABRICATED
  // node state: "No access keys issued." about a node holding 124 of them, and a zeroed
  // "Last run: never · 0 peers · 0 records" panel that was never fetched. Invented state
  // read as fact is worse than no state, so this message is the ONLY thing these two views
  // may render when the data was never retrieved. It also CLEARS #stats rather than just
  // hiding it, so tiles from an earlier local session cannot survive a principal change.
  function paintLocalOnly(what) {
    $('stats').hidden = true;
    $('stats').innerHTML = '';
    $('list').innerHTML = '<div class="empty-list">' + esc(what) + ' is local-only — this session is '
      + esc(state.principal || 'not local') + '.</div>';
    $('counts').textContent = '';
    reportHeight();
  }

  // ── chips ─────────────────────────────────────────────────────────────────
  function chipset(el, values, current, attr) {
    var s = ['<span class="fchip' + (current ? '' : ' on') + '" ' + attr + '="">all</span>'];
    values.forEach(function (v) {
      s.push('<span class="fchip' + (current === v ? ' on' : '') + '" ' + attr + '="' + esc(v) + '">' + esc(v) + '</span>');
    });
    el.innerHTML = s.join('');
  }
  function paintChips() {
    if (state.tab === 'datasets') {
      $('chip-lbl').textContent = 'backend';
      // Derived from the loaded rows, not a fixed enum — a backend kind this build does not
      // know about still gets a working filter chip.
      var backends = [];
      state.datasets.forEach(function (d) { if (backends.indexOf(d.backend) < 0) backends.push(d.backend); });
      backends.sort();
      chipset($('chips'), backends, state.fBackend, 'data-fb');
      $('chip-row').hidden = false;
    } else if (state.tab === 'keys') {
      $('chip-lbl').textContent = 'state';
      chipset($('chips'), KEY_STATES, state.fKeyState, 'data-fk');
      $('chip-row').hidden = false;
    } else {
      $('chip-row').hidden = true;
    }
  }

  // ── header badge + capability banner ──────────────────────────────────────
  function paintPrincipal() {
    var el = $('principal');
    if (!state.principal) { el.textContent = '…'; el.className = 'pill prin'; return; }
    el.textContent = state.canManage ? state.principal + ' · can manage' : state.principal + ' · read-only';
    el.className = 'pill prin' + (state.canManage ? ' ok' : ' ro');
    var cap = $('cap');
    if (state.canManage) { cap.hidden = true; cap.textContent = ''; return; }
    cap.hidden = false;
    cap.textContent = 'This session is remote (' + state.principal + '). Data management — creating and'
      + ' dropping datasets, listing and revoking access keys, and triggering sync — is local-only.'
      + ' Open this pane from the data-service host itself to manage it.';
  }

  // ── toolbar (per tab) ─────────────────────────────────────────────────────
  function paintToolbar() {
    var el = $('toolbar'), html = '';
    if (state.tab === 'datasets') {
      html = '<button id="b-new" class="primary"' + (state.canManage ? '' : ' disabled title="local-only"') + '>+ New dataset</button>'
        + '<button id="b-refresh" class="ghost">Refresh</button>';
    } else if (state.tab === 'keys') {
      html = '<button id="b-refresh" class="ghost"' + (state.canManage ? '' : ' disabled title="local-only"') + '>Refresh</button>';
    } else {
      html = '<button id="b-sync" class="primary"' + (state.canManage ? '' : ' disabled title="local-only"') + '>Reconcile now</button>'
        + '<button id="b-refresh" class="ghost"' + (state.canManage ? '' : ' disabled title="local-only"') + '>Refresh</button>';
    }
    el.innerHTML = html;
    if ($('b-new')) $('b-new').onclick = toggleForm;
    if ($('b-sync')) $('b-sync').onclick = runSync;
    if ($('b-refresh')) $('b-refresh').onclick = function () { reloadActive(true); };
  }

  // ── tabs ──────────────────────────────────────────────────────────────────
  function switchTab(t) {
    if (t === state.tab) return;
    state.tab = t;
    state.filter = '';
    // The chip filters are per-tab too, so they reset with the text filter. Leaving one set
    // hides rows in a tab whose visible filter box is empty — a silent, unexplained "no rows".
    state.fBackend = '';
    state.fKeyState = '';
    state.confirm = null;
    $('q').value = '';
    $('q').placeholder = t === 'datasets' ? 'filter id / backend / visibility…'
      : t === 'keys' ? 'filter key id / label / node / dataset…' : 'filter sync errors…';
    clearFatal();
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.classList.toggle('on', b.dataset.tab === t);
    });
    $('form').hidden = true;
    $('stats').hidden = t !== 'sync';
    say('ready');
    paintChips();
    paintToolbar();
    if (t === 'datasets') paintDatasets();
    else if (t === 'keys') loadKeys();
    else loadSync();
    reportHeight();
  }
  function reloadActive(force) {
    if (state.tab === 'datasets') loadCatalog();
    else if (state.tab === 'keys') loadKeys(force !== false);
    else loadSync(force !== false);
  }

  // ═══ DATASETS TAB ═════════════════════════════════════════════════════════
  function loadCatalog() {
    // Same loading state the other two tabs use — without it a Refresh leaves the previous
    // rows on screen, indistinguishable from a refresh that returned the identical list.
    if (state.tab === 'datasets') $('list').innerHTML = 'loading…';
    return api('node', '/data/catalog').then(function (r) {
      if (!r.ok) { fatal(r.error.code + ': ' + r.error.message); return; }
      var d = r.data || {};
      state.datasets = Array.isArray(d.datasets) ? d.datasets : [];
      state.principal = (d.you && d.you.principal) || '';
      state.canManage = !!(d.you && d.you.canManage);
      paintPrincipal();
      paintToolbar();
      if (state.tab === 'datasets') { paintChips(); paintDatasets(); }
    });
  }

  function dsMatch(d) {
    if (state.fBackend && d.backend !== state.fBackend) return false;
    var q = state.filter.trim().toLowerCase();
    if (!q) return true;
    return ((d.id || '') + ' ' + (d.backend || '') + ' ' + (d.visibility || '') + ' '
      + (d.actions || []).join(' ')).toLowerCase().indexOf(q) >= 0;
  }

  function dsRowHtml(d) {
    var confirming = state.confirm && state.confirm.kind === 'drop' && state.confirm.id === d.id;
    var act = !state.canManage ? ''
      : confirming
        ? '<button class="danger" data-act="drop-go" data-ds="' + esc(d.id) + '">Confirm drop</button>'
          + '<button class="ghost" data-act="cancel">Cancel</button>'
        : '<button class="ghost" data-act="drop" data-ds="' + esc(d.id) + '">Drop</button>';
    return '<div class="row' + (confirming ? ' warn' : '') + '">'
      + '<div class="rt">' + esc(d.id) + '</div>'
      + '<div class="rmeta"><span class="pill bk-' + esc(d.backend) + '">' + esc(d.backend) + '</span>'
      + '<span class="pill vis">' + esc(d.visibility) + '</span>'
      + (d.readOnly ? '<span class="pill ro">read-only</span>' : '') + '</div>'
      + '<div class="rsub"><span class="k">actions:</span> ' + esc((d.actions || []).join(' · ') || '(none)') + '</div>'
      + (act ? '<div class="ract">' + act + '</div>' : '')
      + '</div>';
  }

  function paintDatasets() {
    if (state.tab !== 'datasets') return;
    var vis = state.datasets.filter(dsMatch);
    $('list').innerHTML = vis.length
      ? vis.map(dsRowHtml).join('')
      : '<div class="empty-list">' + (state.datasets.length ? 'No datasets match the current filter.' : 'No datasets on this node.') + '</div>';
    $('counts').textContent = 'showing ' + vis.length + ' of ' + state.datasets.length
      + ' dataset' + (state.datasets.length === 1 ? '' : 's');
    reportHeight();
  }

  function toggleForm() {
    if (!state.canManage) return;
    var f = $('form');
    f.hidden = !f.hidden;
    if (!f.hidden) $('f-id').focus();
    reportHeight();
  }

  function fillSelect(sel, values, current) {
    sel.innerHTML = values.map(function (v) {
      return '<option value="' + esc(v) + '"' + (v === current ? ' selected' : '') + '>' + esc(v) + '</option>';
    }).join('');
  }

  function createDataset() {
    if (!state.canManage || state.busy) return;
    var id = $('f-id').value.trim();
    if (!ID_RE.test(id)) { say('invalid dataset id "' + id + '" — must match ^[a-z0-9][a-z0-9_-]{0,63}$', true); return; }
    var backend = $('f-backend').value;
    state.busy = true;
    $('f-create').disabled = true;
    say('creating "' + id + '"…');
    // Body mirrors the old page exactly; `config.kind` follows the chosen backend.
    api('node', '/data/datasets', {
      method: 'POST',
      body: { id: id, backend: backend, visibility: $('f-visibility').value, syncMode: $('f-syncmode').value, config: { kind: backend } },
    }).then(function (r) {
      state.busy = false;
      $('f-create').disabled = false;
      if (!r.ok) { say('create failed — ' + r.error.code + ': ' + r.error.message, true); return; }
      var made = (r.data && r.data.dataset) || null;
      $('f-id').value = '';
      $('form').hidden = true;
      say('created "' + (made && made.id ? made.id : id) + '"');
      loadCatalog();
    });
  }

  function dropDataset(id) {
    if (!state.canManage || state.busy) return;
    state.busy = true;
    say('dropping "' + id + '"…');
    api('node', '/data/datasets/' + encodeURIComponent(id), { method: 'DELETE' }).then(function (r) {
      state.busy = false;
      state.confirm = null;
      if (!r.ok) { say('drop failed — ' + r.error.code + ': ' + r.error.message, true); paintDatasets(); return; }
      // success:true does NOT mean it went: {dropped:false} is a real, silent no-op answer.
      if (r.data && r.data.dropped === false) { say('drop had no effect — "' + id + '" was not removed', true); }
      else { say('dropped "' + id + '" and its storage'); }
      loadCatalog();
    });
  }

  // ═══ ACCESS KEYS TAB ══════════════════════════════════════════════════════
  function loadKeys(force) {
    if (!state.canManage) { state.keys = null; paintLocalOnly('Access-key management'); return Promise.resolve(); }
    if (state.keys && !force) { paintKeys(); return Promise.resolve(); }
    $('list').innerHTML = 'loading…';
    return api('node', '/data/keys').then(function (r) {
      if (!r.ok) { fatal(r.error.code + ': ' + r.error.message); return; }
      // data is the WRAPPER { keys } — never a bare array.
      var keys = (r.data && Array.isArray(r.data.keys)) ? r.data.keys : [];
      // Newest first: an issued-key list is read as an audit trail.
      keys.sort(function (a, b) { return String(b.issuedAt || '').localeCompare(String(a.issuedAt || '')); });
      state.keys = keys;
      paintKeys();
    });
  }

  function keyMatch(k) {
    if (state.fKeyState && keyState(k) !== state.fKeyState) return false;
    var q = state.filter.trim().toLowerCase();
    if (!q) return true;
    var grants = (k.grants || []).map(function (g) { return g.dataset + ' ' + (g.actions || []).join(' '); }).join(' ');
    return ((k.keyId || '') + ' ' + (k.label || '') + ' ' + (k.node || '') + ' '
      + (k.principalType || '') + ' ' + (k.principalId || '') + ' ' + grants).toLowerCase().indexOf(q) >= 0;
  }

  function keyRowHtml(k) {
    var st = keyState(k);
    var confirming = state.confirm && state.confirm.kind === 'revoke' && state.confirm.id === k.keyId;
    var act = k.revoked ? ''
      : confirming
        ? '<button class="danger" data-act="revoke-go" data-key="' + esc(k.keyId) + '">Confirm revoke</button>'
          + '<button class="ghost" data-act="cancel">Cancel</button>'
        : '<button class="ghost" data-act="revoke" data-key="' + esc(k.keyId) + '">Revoke</button>';
    var grants = (k.grants || []).map(function (g) {
      return '<span class="pill gr">' + esc(g.dataset) + '[' + esc((g.actions || []).join(',')) + ']</span>';
    }).join('');
    return '<div class="row' + (confirming ? ' warn' : '') + (st === 'active' ? '' : ' inert') + '">'
      + '<div class="rt mono">' + esc(k.keyId) + '</div>'
      + '<div class="rmeta"><span class="pill ks-' + esc(st) + '">' + esc(st) + '</span>'
      + '<span class="pill pt">' + esc(k.principalType) + (k.principalId ? ':' + esc(k.principalId) : '') + '</span>'
      + '<span class="pill node mono">' + esc(k.node) + '</span></div>'
      + (k.label ? '<div class="rsub">' + esc(k.label) + '</div>' : '')
      + (grants ? '<div class="rmeta">' + grants + '</div>' : '<div class="rsub">(no grants)</div>')
      + '<div class="rsub"><span class="k">issued:</span> ' + esc(fmtWhen(k.issuedAt)) + ' (' + esc(agoISO(k.issuedAt)) + ')'
      + ' · <span class="k">expires:</span> ' + esc(fmtWhen(k.expiresAt)) + ' (' + esc(untilISO(k.expiresAt)) + ')</div>'
      + (act ? '<div class="ract">' + act + '</div>' : '')
      + '</div>';
  }

  function paintKeys() {
    if (state.tab !== 'keys') return;
    // Reached directly by the #q and #chips handlers, which never pass through loadKeys().
    if (!state.canManage) { paintLocalOnly('Access-key management'); return; }
    var all = state.keys || [];
    var vis = all.filter(keyMatch);
    $('list').innerHTML = vis.length
      ? vis.map(keyRowHtml).join('')
      : '<div class="empty-list">' + (all.length ? 'No keys match the current filter.' : 'No access keys issued.') + '</div>';
    var live = all.filter(function (k) { return keyState(k) === 'active'; }).length;
    $('counts').textContent = 'showing ' + vis.length + ' of ' + all.length + ' key' + (all.length === 1 ? '' : 's')
      + ' · ' + live + ' active';
    reportHeight();
  }

  function revokeKey(keyId) {
    if (!state.canManage || state.busy) return;
    state.busy = true;
    say('revoking ' + keyId + '…');
    api('node', '/data/access/' + encodeURIComponent(keyId), { method: 'DELETE' }).then(function (r) {
      state.busy = false;
      state.confirm = null;
      if (!r.ok) { say('revoke failed — ' + r.error.code + ': ' + r.error.message, true); paintKeys(); return; }
      // Verified against the live API: an unknown/unrevokable keyId still answers HTTP 200
      // success:true with {revoked:false}. Report the flag, not the transport.
      if (r.data && r.data.revoked === false) { say('revoke had no effect — ' + keyId + ' was not revoked', true); }
      else { say('revoked ' + keyId); }
      loadKeys(true);
    });
  }

  // ═══ SYNC TAB ═════════════════════════════════════════════════════════════
  function loadSync(force) {
    if (!state.canManage) { state.sync = null; paintLocalOnly('Cross-node sync'); return Promise.resolve(); }
    if (state.sync && !force) { paintSync(); return Promise.resolve(); }
    $('list').innerHTML = 'loading…';
    return api('node', '/data/sync/status').then(function (r) {
      if (!r.ok) { fatal(r.error.code + ': ' + r.error.message); return; }
      state.sync = r.data || null;             // BARE SyncStatus — not wrapped under `status`
      paintSync();
    });
  }

  function statTile(label, value) {
    return '<div class="stat"><div class="s-k">' + esc(label) + '</div><div class="s-v">' + esc(value) + '</div></div>';
  }

  function paintSync() {
    if (state.tab !== 'sync') return;
    // Reached directly by the #q handler, which never passes through loadSync(). Without this
    // one keystroke un-hides #stats and paints a wholly invented status panel.
    if (!state.canManage) { paintLocalOnly('Cross-node sync'); return; }
    var s = state.sync || {};
    $('stats').hidden = false;
    $('stats').innerHTML =
      '<div class="lastrun"><span class="k">Last run:</span> ' + esc(s.lastRun ? fmtWhen(s.lastRun) + ' (' + agoISO(s.lastRun) + ')' : 'never') + '</div>'
      + '<div class="tiles">'
      + statTile('Peers checked', s.peersChecked != null ? s.peersChecked : 0)
      + statTile('Datasets', s.datasetsReplicated != null ? s.datasetsReplicated : 0)
      + statTile('Records applied', s.recordsApplied != null ? s.recordsApplied : 0)
      + statTile('Records skipped', s.recordsSkipped != null ? s.recordsSkipped : 0)
      // Optional on statuses from older builds — only tiled when the field is actually present.
      + (s.tombstonesPurged != null ? statTile('Tombstones purged', s.tombstonesPurged) : '')
      + '</div>';
    var errs = Array.isArray(s.errors) ? s.errors : [];
    var q = state.filter.trim().toLowerCase();
    var vis = q ? errs.filter(function (e) { return String(e).toLowerCase().indexOf(q) >= 0; }) : errs;
    $('list').innerHTML = vis.length
      ? '<div class="errs"><div class="errs-h">Errors from the last run</div>'
        + vis.map(function (e) { return '<div class="err-row">' + esc(e) + '</div>'; }).join('') + '</div>'
      : '<div class="empty-list">' + (errs.length ? 'No errors match the current filter.' : 'No errors in the last run.') + '</div>';
    $('counts').textContent = errs.length
      ? 'showing ' + vis.length + ' of ' + errs.length + ' error' + (errs.length === 1 ? '' : 's')
      : '';
    reportHeight();
  }

  function runSync() {
    if (!state.canManage || state.busy) return;
    state.busy = true;
    if ($('b-sync')) $('b-sync').disabled = true;
    say('reconciling against all peers… (this can take a while)');
    api('node', '/data/sync', { method: 'POST' }).then(function (r) {
      state.busy = false;
      if ($('b-sync')) $('b-sync').disabled = false;
      if (!r.ok) { say('sync failed — ' + r.error.code + ': ' + r.error.message, true); return; }
      state.sync = r.data || state.sync;       // POST answers the same bare SyncStatus
      paintSync();
      var s = state.sync || {};
      var n = (s.errors || []).length;
      say('reconcile complete — ' + (s.peersChecked || 0) + ' peer(s), ' + (s.datasetsReplicated || 0)
        + ' dataset(s), ' + (s.recordsApplied || 0) + ' applied, ' + (s.recordsSkipped || 0) + ' skipped'
        + (n ? ' · ' + n + ' error(s)' : ''), !!n);
    });
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  $('tabs').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('.tab') : null;
    if (b && b.dataset.tab) switchTab(b.dataset.tab);
  });
  $('chips').addEventListener('click', function (e) {
    if (e.target.dataset.fb !== undefined) { state.fBackend = e.target.dataset.fb; paintChips(); paintDatasets(); }
    else if (e.target.dataset.fk !== undefined) { state.fKeyState = e.target.dataset.fk; paintChips(); paintKeys(); }
  });
  $('q').addEventListener('input', function (e) {
    state.filter = e.target.value;
    if (state.tab === 'datasets') paintDatasets();
    else if (state.tab === 'keys') paintKeys();
    else paintSync();
  });
  $('form').addEventListener('submit', function (e) { e.preventDefault(); createDataset(); });
  // Delegated row actions — the two-step confirm is state, so every branch repaints from state.
  $('list').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-act]') : null;
    if (!b) return;
    var act = b.dataset.act;
    if (act === 'cancel') { state.confirm = null; }
    else if (act === 'drop') { state.confirm = { kind: 'drop', id: b.dataset.ds }; }
    else if (act === 'revoke') { state.confirm = { kind: 'revoke', id: b.dataset.key }; }
    else if (act === 'drop-go') { dropDataset(b.dataset.ds); return; }
    else if (act === 'revoke-go') { revokeKey(b.dataset.key); return; }
    if (state.tab === 'datasets') paintDatasets(); else paintKeys();
  });

  // Who is signed in (identity rides the session, not the view token).
  fetch('/auth/me', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
    $('who-name').textContent = (d.claims && (d.claims.name || d.claims.email)) || d.userId || 'signed in';
  }).catch(function () { $('who-name').textContent = 'signed in'; });

  // ── boot ────────────────────────────────────────────────────────────────
  fillSelect($('f-backend'), BACKENDS, 'cache');
  fillSelect($('f-visibility'), VISIBILITIES, 'local-only');
  fillSelect($('f-syncmode'), SYNC_MODES, 'none');
  paintToolbar();
  loadCatalog();
})();
