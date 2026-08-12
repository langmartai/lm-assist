/* assist-scheduler — lm-assist's internal job scheduler as a scoped pane. Plain JS, no
 * build, no deps. Every data call goes through the injected SDK helper (lmui.call), which
 * carries the view token and re-mints it on 401/403. The one declared grant is
 * node:/scheduler [GET,POST], which prefix-covers the list, per-job detail, logs and the
 * (test-only) run trigger.
 *
 * Paths + envelope shapes mirror core/src/routes/core/scheduler.routes.ts and the Job type
 * in core/src/scheduler/scheduled-jobs.ts (read at build time):
 *   GET  /scheduler/jobs          → data = { jobs:[...], count }   (WRAPPER, not a bare array)
 *   GET  /scheduler/jobs/:id       → data = job                     (bare ScheduledJobView)
 *   GET  /scheduler/jobs/:id/logs  → data = { id, logs:[...], count } (newest first)
 *   POST /scheduler/jobs/:id/run {test:true} → data = job with lastRun (the captured test run;
 *        `test` mode does NOT advance the schedule clock or run count — it's verification only).
 * The test run is the ONLY write this pane makes; every other call is read-only. */
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

  function agoISO(iso) {
    var t = new Date(iso).getTime();
    var m = Math.floor((Date.now() - t) / 60000);
    if (!isFinite(m)) return iso ? String(iso).slice(0, 16).replace('T', ' ') : '—';
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    if (m < 1440) return Math.floor(m / 60) + 'h ago';
    return Math.floor(m / 1440) + 'd ago';
  }
  function untilISO(iso) {
    if (!iso) return '—';
    var m = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
    if (!isFinite(m)) return String(iso).slice(0, 16).replace('T', ' ');
    if (m <= 0) return 'due now';
    if (m < 60) return 'in ' + m + 'm';
    if (m < 1440) return 'in ' + Math.floor(m / 60) + 'h';
    return 'in ' + Math.floor(m / 1440) + 'd';
  }
  function fmtInterval(min) {
    var n = Number(min);
    if (!isFinite(n) || n <= 0) return 'paused';
    if (n % 1440 === 0) return 'every ' + (n / 1440) + 'd';
    if (n % 60 === 0) return 'every ' + (n / 60) + 'h';
    return 'every ' + n + 'm';
  }
  function fmtDur(ms) {
    var n = Number(ms);
    if (!isFinite(n) || n < 0) return '';
    if (n < 1000) return n + 'ms';
    if (n < 60000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 's';
    return Math.floor(n / 60000) + 'm' + Math.round((n % 60000) / 1000) + 's';
  }

  // ── state ───────────────────────────────────────────────────────────────
  var state = {
    jobs: [],                                  // ScheduledJobView[] from GET /scheduler/jobs
    selected: null,                            // full job (GET :id, or the run response)
    filter: { q: '', enabled: '' },            // client-side; enabled '' = all | 'on' | 'off'
    logs: [],                                  // run history for the selected job
    logsOpen: false,                           // Logs view toggled on?
    lastWasTest: false,                        // did we just capture a test run into `selected`?
  };
  var ENABLED_CHIPS = [['', 'all'], ['on', 'enabled'], ['off', 'disabled']];

  function say(msg, isErr) {
    var out = $('out');
    if (!out) return;
    out.textContent = typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2);
    out.classList.toggle('err', !!isErr);
    reportHeight();
  }

  // A hard failure of the primary data call: cover the screen with the server's own text.
  function fatal(message) {
    var old = $('fatal-layer');
    if (old) old.remove();
    var d = document.createElement('div');
    d.className = 'fatal';
    d.id = 'fatal-layer';
    d.innerHTML = '<div class="fatal-card"><div class="fatal-h">Scheduler could not be loaded</div>'
      + '<pre class="fatal-msg"></pre><button class="primary" id="fatal-retry">Retry</button></div>';
    d.querySelector('.fatal-msg').textContent = message;
    document.body.appendChild(d);
    $('fatal-retry').onclick = function () { d.remove(); loadList(); };
    reportHeight();
  }

  // ── filters ───────────────────────────────────────────────────────────────
  function paintChips() {
    var el = $('chips-enabled');
    el.innerHTML = ENABLED_CHIPS.map(function (c) {
      return '<span class="fchip' + (state.filter.enabled === c[0] ? ' on' : '') + '" data-fe="' + c[0] + '">' + c[1] + '</span>';
    }).join('');
  }
  function passFilters(j) {
    var f = state.filter;
    if (f.enabled === 'on' && !j.enabled) return false;
    if (f.enabled === 'off' && j.enabled) return false;
    var q = f.q.trim().toLowerCase();
    if (q) {
      var hay = ((j.name || '') + ' ' + j.id + ' ' + (j.type || '') + ' ' + (j.description || '')).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  }

  // ── list rows ───────────────────────────────────────────────────────────
  function statusPill(status) {
    if (!status) return '';
    return '<span class="pill st-' + esc(status) + '">' + esc(status) + '</span>';
  }
  function lastRunSummary(j) {
    if (!j.lastRunAt && !j.lastStatus) return 'never run';
    var ex = j.lastRun && (j.lastRun.exitCode !== undefined && j.lastRun.exitCode !== null)
      ? ' · exit ' + j.lastRun.exitCode : '';
    var dur = j.lastRun && j.lastRun.durationMs != null ? ' · ' + fmtDur(j.lastRun.durationMs) : '';
    return (j.lastStatus || '?') + ex + dur + ' · ' + agoISO(j.lastRunAt);
  }

  function listRowHtml(j) {
    var sel = state.selected && state.selected.id === j.id ? ' sel' : '';
    var pills = '<span class="pill ' + (j.enabled ? 'en' : 'dis') + '">' + (j.enabled ? 'enabled' : 'disabled') + '</span>';
    if (j.isRunning) pills += '<span class="pill run">running</span>';
    pills += '<span class="pill ' + (j.builtin ? 'builtin">built-in' : 'custom">custom') + '</span>';
    return '<div class="row' + sel + '" data-jid="' + esc(j.id) + '">'
      + '<div class="rt">' + esc(j.name || j.id) + '</div>'
      + '<div class="rmeta">' + pills + '<span class="pill ivl">' + esc(fmtInterval(j.intervalMinutes)) + '</span></div>'
      + '<div class="rsub"><span class="k">last:</span> ' + esc(lastRunSummary(j))
      + ' · <span class="k">next:</span> ' + esc(j.enabled ? untilISO(j.nextRunAt) : '—') + '</div>'
      + '<div class="rid">' + esc(j.id) + '</div></div>';
  }

  function paintList() {
    var vis = state.jobs.filter(passFilters);
    $('list').innerHTML = vis.length
      ? vis.map(listRowHtml).join('')
      : '<div class="empty-list">' + (state.jobs.length ? 'No jobs match the current filter.' : 'No scheduled jobs.') + '</div>';
    $('counts').textContent = 'showing ' + vis.length + ' of ' + state.jobs.length
      + ' job' + (state.jobs.length === 1 ? '' : 's');
    reportHeight();
  }

  function loadList() {
    return api('node', '/scheduler/jobs').then(function (r) {
      if (!r.ok) { fatal(r.error.code + ': ' + r.error.message); return; }
      // data is the WRAPPER { jobs, count } — never a bare array.
      state.jobs = (r.data && Array.isArray(r.data.jobs)) ? r.data.jobs : [];
      paintChips();
      paintList();
    });
  }

  // ── detail ────────────────────────────────────────────────────────────────
  function openJob(id) {
    return api('node', '/scheduler/jobs/' + encodeURIComponent(id)).then(function (r) {
      if (!r.ok) { say('open ' + id + ' failed — ' + r.error.code + ': ' + r.error.message, true); return; }
      state.selected = r.data || null;
      state.logs = [];
      state.logsOpen = false;
      state.lastWasTest = false;
      paintDetail();
      paintList();                               // re-highlight the selected row
    });
  }

  function metaRow(label, value) {
    return value ? '<div><span class="k">' + esc(label) + ':</span> ' + esc(value) + '</div>' : '';
  }

  // Render one run record (used for last-run AND each history entry).
  function runHtml(rec, opts) {
    opts = opts || {};
    if (!rec) return '<div class="run"><div class="run-result">(no run captured yet)</div></div>';
    var head = statusPill(rec.status)
      + '<span class="pill kind">' + esc(rec.trigger || 'run') + '</span>'
      + (rec.exitCode !== undefined && rec.exitCode !== null ? '<span class="pill">exit ' + esc(rec.exitCode) + '</span>' : '')
      + (rec.durationMs != null ? '<span class="pill">' + esc(fmtDur(rec.durationMs)) + '</span>' : '')
      + '<span class="run-when">' + esc(agoISO(rec.at)) + '</span>';
    var streams = '';
    if (rec.stdout) streams += '<div class="stream-lbl">stdout</div><pre class="stream">' + esc(rec.stdout) + '</pre>';
    if (rec.stderr) streams += '<div class="stream-lbl">stderr</div><pre class="stream stderr">' + esc(rec.stderr) + '</pre>';
    return '<div class="run' + (opts.test ? ' test' : '') + '">'
      + '<div class="run-head">' + head + '</div>'
      + (rec.result ? '<div class="run-result">' + esc(rec.result) + '</div>' : '')
      + (rec.condition ? '<div class="run-cond">' + esc(rec.condition) + '</div>' : '')
      + streams + '</div>';
  }

  function logsHtml() {
    if (!state.logsOpen) return '';
    var body = state.logs.length
      ? state.logs.map(function (rec) { return runHtml(rec); }).join('')
      : '<div class="empty-list">No run history yet.</div>';
    return '<div class="d-sect"><h3>Run history (' + state.logs.length + ', newest first)</h3>' + body + '</div>';
  }

  function paintDetail() {
    var j = state.selected;
    var el = $('detail');
    if (!j) { el.className = 'detail empty'; el.textContent = 'Select a job on the left to see its config, last run and history.'; return; }
    el.className = 'detail';

    var pills = '<span class="pill ' + (j.enabled ? 'en' : 'dis') + '">' + (j.enabled ? 'enabled' : 'disabled') + '</span>'
      + (j.isRunning ? '<span class="pill run">running</span>' : '')
      + '<span class="pill ' + (j.builtin ? 'builtin">built-in' : 'custom">custom') + '</span>'
      + '<span class="pill kind">' + esc(j.type || '?') + '</span>'
      + '<span class="pill ivl">' + esc(fmtInterval(j.intervalMinutes)) + '</span>';

    var configStr = '';
    try { configStr = JSON.stringify(j.config || {}, null, 2); } catch (e) { configStr = String(j.config); }
    var configEmpty = configStr === '{}' || !configStr;

    var lastLbl = state.lastWasTest ? 'Test run result (verification — did NOT advance the schedule)' : 'Last run';

    el.innerHTML =
      '<h2 class="d-title">' + esc(j.name || j.id) + '</h2>'
      + '<div class="d-idrow"><span class="d-id">' + esc(j.id) + '</span></div>'
      + '<div class="d-pills">' + pills + '</div>'
      + (j.description ? '<div class="d-desc">' + esc(j.description) + '</div>' : '')
      + '<div class="d-meta">'
      + metaRow('interval', fmtInterval(j.intervalMinutes))
      + metaRow('next run', j.enabled ? untilISO(j.nextRunAt) + (j.nextRunAt ? ' (' + String(j.nextRunAt).slice(0, 16).replace('T', ' ') + ')' : '') : 'disabled')
      + metaRow(state.lastWasTest ? 'last scheduled run' : 'last run', j.lastRunAt ? agoISO(j.lastRunAt) + (j.lastStatus ? ' · ' + j.lastStatus : '') : 'never')
      + metaRow('run count', j.runCount != null ? String(j.runCount) : '')
      + metaRow('created', agoISO(j.createdAt))
      + metaRow('updated', agoISO(j.updatedAt))
      + '</div>'
      + '<div class="d-sect"><h3>Config</h3><pre class="mono' + (configEmpty ? ' none' : '') + '">' + esc(configEmpty ? '(no config)' : configStr) + '</pre></div>'
      + '<div class="d-sect"><h3>' + esc(lastLbl) + '</h3>' + runHtml(j.lastRun, { test: state.lastWasTest }) + '</div>'
      + '<div class="d-sect"><div class="actions">'
      + '<button id="btn-test" class="primary">Test run</button>'
      + '<button id="btn-logs" class="ghost' + (state.logsOpen ? ' on' : '') + '">' + (state.logsOpen ? 'Hide logs' : 'Logs') + '</button>'
      + '<button id="btn-refresh" class="ghost">Refresh</button>'
      + '</div>'
      + '<div class="test-hint">Test run executes the job now and captures its full output, but does NOT advance the schedule or run count (POST /scheduler/jobs/:id/run {test:true}). It is the only write this pane makes.</div>'
      + '<div id="out" class="out">ready</div>'
      + logsHtml()
      + '</div>';

    $('btn-test').onclick = testRun;
    $('btn-logs').onclick = toggleLogs;
    $('btn-refresh').onclick = function () { if (state.selected) openJob(state.selected.id); };
    reportHeight();
  }

  // ── logs (GET history) ─────────────────────────────────────────────────────
  function toggleLogs() {
    if (!state.selected) return;
    if (state.logsOpen) { state.logsOpen = false; paintDetail(); return; }
    var id = state.selected.id;
    say('loading run history…');
    api('node', '/scheduler/jobs/' + encodeURIComponent(id) + '/logs').then(function (r) {
      if (!r.ok) { say('logs failed — ' + r.error.code + ': ' + r.error.message, true); return; }
      // data is the WRAPPER { id, logs, count }; logs is newest-first.
      state.logs = (r.data && Array.isArray(r.data.logs)) ? r.data.logs : [];
      state.logsOpen = true;
      paintDetail();
      say('showing ' + state.logs.length + ' run' + (state.logs.length === 1 ? '' : 's'));
    });
  }

  // ── the one write: a TEST run (captures output, never advances the schedule) ──
  function testRun() {
    if (!state.selected) return;
    var id = state.selected.id;
    var btn = $('btn-test');
    btn.disabled = true;
    say('test-running "' + id + '"… (captures output; does not advance the schedule)');
    api('node', '/scheduler/jobs/' + encodeURIComponent(id) + '/run', { method: 'POST', body: { test: true } }).then(function (r) {
      if (!r.ok) { if ($('btn-test')) $('btn-test').disabled = false; say('test run failed — ' + r.error.code + ': ' + r.error.message, true); return; }
      // Response is the full job view with `lastRun` set to the captured test record.
      state.selected = r.data || state.selected;
      state.lastWasTest = true;
      var rec = state.selected.lastRun;
      if (state.logsOpen) {                       // the test record is prepended to runLog
        state.logs = (state.selected.runLog && Array.isArray(state.selected.runLog)) ? state.selected.runLog : state.logs;
      }
      // reflect the possibly-changed lastStatus/lastRun in the list row too
      var idx = state.jobs.findIndex(function (x) { return x.id === id; });
      if (idx >= 0) state.jobs[idx] = state.selected;
      paintDetail();
      paintList();
      say('test run complete — ' + (rec ? (rec.status || 'done') + (rec.result ? ': ' + rec.result : '') : 'no record returned'));
    });
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  $('list').addEventListener('click', function (e) {
    var row = e.target.closest ? e.target.closest('.row') : null;
    if (!row || !row.dataset.jid) return;
    openJob(row.dataset.jid);
  });
  $('chips-enabled').addEventListener('click', function (e) {
    if (e.target.dataset.fe === undefined) return;
    state.filter.enabled = e.target.dataset.fe; paintChips(); paintList();
  });
  $('q').addEventListener('input', function (e) { state.filter.q = e.target.value; paintList(); });

  // Who is signed in (identity rides the session, not the view token).
  fetch('/auth/me', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
    $('who-name').textContent = (d.claims && (d.claims.name || d.claims.email)) || d.userId || 'signed in';
  }).catch(function () { $('who-name').textContent = 'signed in'; });

  // ── boot ────────────────────────────────────────────────────────────────
  loadList();
})();
