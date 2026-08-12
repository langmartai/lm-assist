/* assist-memory — Claude Code MEMORY + RULES as a scoped, read-only pane. Plain JS,
 * no build, no deps. Every data call goes through the injected SDK helper (lmui.call),
 * which carries the view token and re-mints it on 401/403. Two declared grants,
 * both GET-only: node:/memory and node:/rules — the view token's grant is the hard
 * ceiling, so this pane can never write.
 *
 * Paths + envelope shapes mirror the handlers read at build time:
 *   MEMORY  core/src/routes/core/memory.routes.ts + core/src/api/memory-api.ts
 *     GET /memory/projects                          → BARE ARRAY of MemoryProjectSummary
 *     GET /memory/by-project/:projectId             → MemoryProjectListing {files[],index?}
 *     GET /memory/by-project/:projectId/file/:name  → MemoryFileResponse {body,frontmatter,…}
 *   RULES   core/src/routes/core/rule-files.routes.ts
 *     GET /rules/list                               → {rules:[{filename,source,os,…}]}
 *     GET /rules/file/:filename                     → {filename,source,content,hash}
 * Content is rendered as PLAIN TEXT pre-wrap — no markdown library. */
(function () {
  'use strict';

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

  function ago(ms) {
    var m = Math.floor((Date.now() - ms) / 60000);
    if (!isFinite(m) || m < 0 || !ms) return ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '—';
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    if (m < 1440) return Math.floor(m / 60) + 'h ago';
    return Math.floor(m / 1440) + 'd ago';
  }
  function fmtBytes(n) {
    if (n == null || !isFinite(n)) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  // ── state ───────────────────────────────────────────────────────────────
  var state = {
    tab: 'memory',                       // 'memory' | 'rules'
    // memory
    projects: [],                        // MemoryProjectSummary[] (bare array)
    projectId: null,                     // selected slug (MemoryProjectSummary.projectId)
    memFiles: [],                        // list rows: MemoryListEntry[] (+ synthetic MEMORY.md)
    // rules
    rules: null,                         // rule rows, or null = not yet loaded
    // shared
    filter: '',                          // client-side text filter (per-tab, reset on switch)
    selected: null,                      // { kind:'memory'|'rule', ...fileResponse }
  };

  // A hard failure of the active tab's primary call: cover the screen with the server's text.
  function fatal(message) {
    var old = $('fatal-layer');
    if (old) old.remove();
    var d = document.createElement('div');
    d.className = 'fatal';
    d.id = 'fatal-layer';
    d.innerHTML = '<div class="fatal-card"><div class="fatal-h">Could not be loaded</div>'
      + '<pre class="fatal-msg"></pre><button class="primary" id="fatal-retry">Retry</button></div>';
    d.querySelector('.fatal-msg').textContent = message;
    document.body.appendChild(d);
    $('fatal-retry').onclick = function () { d.remove(); reloadActive(); };
    reportHeight();
  }
  function clearFatal() { var o = $('fatal-layer'); if (o) o.remove(); }

  // ── tabs ────────────────────────────────────────────────────────────────
  function switchTab(t) {
    if (t === state.tab) return;
    state.tab = t;
    state.filter = '';
    state.selected = null;
    $('q').value = '';
    clearFatal();
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.classList.toggle('on', b.dataset.tab === t);
    });
    $('proj-wrap').style.display = t === 'memory' ? '' : 'none';
    paintDetail();
    if (t === 'memory') { $('q').placeholder = 'filter memory files…'; renderMemoryList(); }
    else { $('q').placeholder = 'filter rules…'; loadRules(); }
    reportHeight();
  }
  function reloadActive() {
    if (state.tab === 'memory') loadProjects();
    else loadRules(true);
  }

  // ═══ MEMORY TAB ═══════════════════════════════════════════════════════════
  function loadProjects() {
    return api('node', '/memory/projects').then(function (r) {
      if (!r.ok) { fatal(r.error.code + ': ' + r.error.message); return; }
      state.projects = Array.isArray(r.data) ? r.data : [];
      var sel = $('proj');
      if (!state.projects.length) {
        sel.innerHTML = '<option value="">(no projects with memory)</option>';
        state.projectId = null;
        state.memFiles = [];
        renderMemoryList();
        return;
      }
      sel.innerHTML = state.projects.map(function (p) {
        var name = (p.projectPath || p.projectId || '').split('/').filter(Boolean).pop() || p.projectId;
        var label = name + '  ·  ' + (p.fileCount || 0) + 'f' + (p.hasRepo ? ' · ' + p.hostCount + 'h' : '');
        return '<option value="' + esc(p.projectId) + '">' + esc(label) + '</option>';
      }).join('');
      // Keep prior selection if it still exists, else the first (most-recently-touched).
      var keep = state.projects.some(function (p) { return p.projectId === state.projectId; });
      state.projectId = keep ? state.projectId : state.projects[0].projectId;
      sel.value = state.projectId;
      loadProjectFiles(state.projectId);
    });
  }

  function loadProjectFiles(projectId) {
    state.selected = null; paintDetail();
    $('list').innerHTML = 'loading…';
    return api('node', '/memory/by-project/' + encodeURIComponent(projectId)).then(function (r) {
      if (!r.ok) { fatal(r.error.code + ': ' + r.error.message); return; }
      var d = r.data || {};
      var files = Array.isArray(d.files) ? d.files.slice() : [];
      // The cache excludes MEMORY.md from `files`; when an index is present, surface it as a
      // synthetic top entry (the file route's live disk-fallback reads MEMORY.md by basename).
      if (d.index && typeof d.index.raw === 'string' && d.index.raw.length) {
        files.unshift({ filename: 'MEMORY.md', source: 'live', sizeBytes: d.index.raw.length,
          mtimeMs: d.lastParsedMs || 0, frontmatter: {}, isIndex: true,
          bodyPreview: (d.index.entries || []).length + ' indexed topic(s)' });
      }
      state.memFiles = files;
      renderMemoryList();
    });
  }

  function memMatch(f) {
    var q = state.filter.trim().toLowerCase();
    if (!q) return true;
    var fm = f.frontmatter || {};
    var hay = (f.filename + ' ' + (fm.name || '') + ' ' + (fm.description || '') + ' ' + (f.bodyPreview || '')).toLowerCase();
    return hay.indexOf(q) >= 0;
  }

  function memRowHtml(f) {
    var sel = state.selected && state.selected.kind === 'memory' && state.selected.filename === f.filename
      && state.selected.source === f.source ? ' sel' : '';
    var fm = f.frontmatter || {};
    var src = f.source === 'live' ? '<span class="pill live">live</span>'
      : '<span class="pill repo mono">' + esc(f.source) + '</span>';
    var meta = src + '<span class="pill sz">' + fmtBytes(f.sizeBytes) + '</span>'
      + (f.isIndex ? '<span class="pill idx">index</span>' : '')
      + (f.shareability ? '<span class="pill sh-' + esc(f.shareability) + '">' + esc(f.shareability) + '</span>' : '');
    var sub = fm.name && fm.name !== f.filename ? '<div class="rsub">' + esc(fm.name) + '</div>' : '';
    return '<div class="row' + sel + '" data-kind="memory" data-file="' + esc(f.filename) + '" data-src="' + esc(f.source) + '">'
      + '<div class="rt">' + esc(f.filename) + '</div>' + sub
      + '<div class="rmeta">' + meta + '</div></div>';
  }

  function renderMemoryList() {
    if (state.tab !== 'memory') return;
    $('list-hint').textContent = state.projectId
      ? 'Live auto-memory + in-repo per-host mirrors for the selected project.'
      : '';
    if (!state.projectId) {
      $('list').innerHTML = '<div class="empty-list">No projects with memory on this node.</div>';
      $('counts').textContent = '';
      reportHeight(); return;
    }
    var vis = state.memFiles.filter(memMatch);
    $('list').innerHTML = vis.length
      ? vis.map(memRowHtml).join('')
      : '<div class="empty-list">' + (state.memFiles.length ? 'No files match the filter.' : 'This project has no memory files.') + '</div>';
    $('counts').textContent = 'showing ' + vis.length + ' of ' + state.memFiles.length + ' file' + (state.memFiles.length === 1 ? '' : 's');
    reportHeight();
  }

  function openMemFile(filename, source) {
    var pid = state.projectId;
    var path = '/memory/by-project/' + encodeURIComponent(pid) + '/file/' + encodeURIComponent(filename)
      + (source && source !== 'live' ? '?source=' + encodeURIComponent(source) : '');
    return api('node', path).then(function (r) {
      if (!r.ok) { state.selected = { kind: 'error', title: filename, msg: r.error.code + ': ' + r.error.message }; paintDetail(); return; }
      var d = r.data || {};
      state.selected = { kind: 'memory', filename: filename, source: source,
        body: d.body || '', frontmatter: d.frontmatter || {}, mtimeMs: d.mtimeMs,
        sizeBytes: d.sizeBytes, filePath: d.filePath, hash: d.hash };
      paintDetail();
      renderMemoryList();                              // re-highlight
      reportHeight();
    });
  }

  // ═══ RULES TAB ════════════════════════════════════════════════════════════
  function loadRules(force) {
    if (state.rules && !force) { renderRulesList(); return Promise.resolve(); }
    $('list').innerHTML = 'loading…';
    return api('node', '/rules/list').then(function (r) {
      if (!r.ok) { fatal(r.error.code + ': ' + r.error.message); return; }
      var rules = (r.data && Array.isArray(r.data.rules)) ? r.data.rules : [];
      // Own/active rules first, then synced/mirror copies; stable by filename within a group.
      rules.sort(function (a, b) {
        var ae = a.editable ? 0 : 1, be = b.editable ? 0 : 1;
        if (ae !== be) return ae - be;
        return String(a.filename).localeCompare(String(b.filename));
      });
      state.rules = rules;
      renderRulesList();
    });
  }

  function ruleMatch(r) {
    var q = state.filter.trim().toLowerCase();
    if (!q) return true;
    var hay = (r.filename + ' ' + (r.title || '') + ' ' + (r.source || '') + ' ' + (r.syncedFrom || '')).toLowerCase();
    return hay.indexOf(q) >= 0;
  }

  function ruleRowHtml(r) {
    var sel = state.selected && state.selected.kind === 'rule' && state.selected.filename === r.filename
      && state.selected.source === r.source ? ' sel' : '';
    var inert = r.active ? '' : ' inert';
    var src = r.source === 'live' ? '<span class="pill live">live</span>'
      : '<span class="pill mirror mono">' + esc(r.source) + '</span>';
    var os = (r.os && r.os.length) ? r.os.map(function (o) { return '<span class="pill os">' + esc(o) + '</span>'; }).join('') : '';
    var flags = (r.syncedFrom ? '<span class="pill mirror mono">synced:' + esc(r.syncedFrom) + '</span>' : '')
      + (r.active ? '<span class="pill on">active</span>' : '<span class="pill off">inactive</span>');
    var meta = src + '<span class="pill sz">' + fmtBytes(r.size) + '</span>' + os + flags;
    var sub = r.title ? '<div class="rsub">' + esc(r.title) + '</div>' : '';
    return '<div class="row' + sel + inert + '" data-kind="rule" data-file="' + esc(r.filename) + '" data-src="' + esc(r.source) + '">'
      + '<div class="rt">' + esc(r.filename) + '</div>' + sub
      + '<div class="rmeta">' + meta + '</div></div>';
  }

  function renderRulesList() {
    if (state.tab !== 'rules') return;
    var all = state.rules || [];
    $('list-hint').textContent = 'User rules under ~/.claude/rules — own + synced + per-host mirror copies (all read-only here).';
    var vis = all.filter(ruleMatch);
    $('list').innerHTML = vis.length
      ? vis.map(ruleRowHtml).join('')
      : '<div class="empty-list">' + (all.length ? 'No rules match the filter.' : 'No rule files found on this node.') + '</div>';
    $('counts').textContent = 'showing ' + vis.length + ' of ' + all.length + ' rule' + (all.length === 1 ? '' : 's');
    reportHeight();
  }

  function openRule(filename, source) {
    var path = '/rules/file/' + encodeURIComponent(filename)
      + (source && source !== 'live' ? '?source=' + encodeURIComponent(source) : '');
    return api('node', path).then(function (r) {
      if (!r.ok) { state.selected = { kind: 'error', title: filename, msg: r.error.code + ': ' + r.error.message }; paintDetail(); return; }
      var d = r.data || {};
      var meta = (state.rules || []).find(function (x) { return x.filename === filename && x.source === source; }) || {};
      state.selected = { kind: 'rule', filename: filename, source: source, content: d.content || '',
        hash: d.hash, meta: meta };
      paintDetail();
      renderRulesList();
      reportHeight();
    });
  }

  // ═══ DETAIL (shared) ══════════════════════════════════════════════════════
  function metaRow(label, value) {
    return (value !== undefined && value !== null && value !== '')
      ? '<div><span class="k">' + esc(label) + ':</span> ' + esc(value) + '</div>' : '';
  }
  function fmRow(label, value, cls) {
    return (value !== undefined && value !== null && value !== '')
      ? '<div><span class="k">' + esc(label) + ':</span> <span class="' + (cls || '') + '">' + esc(value) + '</span></div>' : '';
  }

  function paintDetail() {
    var s = state.selected, el = $('detail');
    if (!s) {
      el.className = 'detail empty';
      el.textContent = state.tab === 'memory'
        ? 'Select a memory file on the left to read its content and metadata.'
        : 'Select a rule file on the left to read its content and metadata.';
      return;
    }
    if (s.kind === 'error') {
      el.className = 'detail';
      el.innerHTML = '<h2 class="d-title">' + esc(s.title) + '</h2>'
        + '<pre class="content">' + esc(s.msg) + '</pre>';
      return;
    }
    el.className = 'detail';

    if (s.kind === 'memory') {
      var fm = s.frontmatter || {};
      var noBody = !s.body;
      el.innerHTML =
        '<h2 class="d-title">' + esc(s.filename) + '</h2>'
        + '<div class="d-idrow"><span class="d-id">' + esc(s.filePath || s.filename) + '</span></div>'
        + '<div class="d-pills">'
        + (s.source === 'live' ? '<span class="pill live">live</span>' : '<span class="pill repo mono">' + esc(s.source) + '</span>')
        + '<span class="pill sz">' + fmtBytes(s.sizeBytes) + '</span></div>'
        + '<div class="d-meta">'
        + fmRow('name', fm.name)
        + fmRow('description', fm.description, 'desc-fm')
        + metaRow('type', fm.type)
        + metaRow('category', fm.category)
        + metaRow('validity', fm.validity)
        + metaRow('validation', fm.validationTier)
        + metaRow('origin session', fm.originSessionId)
        + metaRow('updated', ago(s.mtimeMs))
        + '</div>'
        + '<div class="d-sect"><h3>Content</h3>'
        + '<pre class="content' + (noBody ? ' none' : '') + '">' + esc(noBody ? '(empty file)' : s.body) + '</pre></div>';
      return;
    }

    // rule
    var m = s.meta || {};
    var noContent = !s.content;
    el.innerHTML =
      '<h2 class="d-title">' + esc(s.filename) + '</h2>'
      + (m.title ? '<div class="d-idrow"><span class="d-id">' + esc(m.title) + '</span></div>' : '')
      + '<div class="d-pills">'
      + (s.source === 'live' ? '<span class="pill live">live</span>' : '<span class="pill mirror mono">' + esc(s.source) + '</span>')
      + '<span class="pill sz">' + fmtBytes(m.size) + '</span>'
      + ((m.os && m.os.length) ? m.os.map(function (o) { return '<span class="pill os">' + esc(o) + '</span>'; }).join('') : '')
      + (m.active ? '<span class="pill on">active</span>' : '<span class="pill off">inactive</span>')
      + (m.syncedFrom ? '<span class="pill mirror mono">synced:' + esc(m.syncedFrom) + '</span>' : '')
      + '</div>'
      + '<div class="d-meta">'
      + metaRow('applies to', (m.os && m.os.length) ? m.os.join(', ') : 'all OSes')
      + metaRow('editable at origin', m.editable === false ? 'no (sync artifact — edit at source node)' : (m.editable ? 'yes' : ''))
      + metaRow('updated', ago(m.mtimeMs))
      + '</div>'
      + '<div class="d-sect"><h3>Content</h3>'
      + '<pre class="content' + (noContent ? ' none' : '') + '">' + esc(noContent ? '(empty file)' : s.content) + '</pre></div>';
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  $('tabs').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('.tab') : null;
    if (b && b.dataset.tab) switchTab(b.dataset.tab);
  });
  $('proj').addEventListener('change', function (e) {
    state.projectId = e.target.value;
    loadProjectFiles(state.projectId);
  });
  $('q').addEventListener('input', function (e) {
    state.filter = e.target.value;
    if (state.tab === 'memory') renderMemoryList(); else renderRulesList();
  });
  $('list').addEventListener('click', function (e) {
    var row = e.target.closest ? e.target.closest('.row') : null;
    if (!row || !row.dataset.file) return;
    if (row.dataset.kind === 'memory') openMemFile(row.dataset.file, row.dataset.src);
    else openRule(row.dataset.file, row.dataset.src);
  });

  // Who is signed in (identity rides the session, not the view token).
  fetch('/auth/me', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
    $('who-name').textContent = (d.claims && (d.claims.name || d.claims.email)) || d.userId || 'signed in';
  }).catch(function () { $('who-name').textContent = 'signed in'; });

  // ── boot ────────────────────────────────────────────────────────────────
  $('q').placeholder = 'filter memory files…';
  loadProjects();
})();
