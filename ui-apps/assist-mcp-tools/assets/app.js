/* assist-mcp-tools — the MCP tool registry as a scoped pane. Plain JS, no build, no
 * deps. Every data call goes through the injected SDK helper (lmui.call), which carries
 * the view token and re-mints it on 401/403.
 *
 * GRANT — twelve rules. Every WRITE is a LEAF rule naming exactly one route, never a
 * subtree, so no future sibling route can inherit this pane's authority:
 *   node:/mcp-tools                    [GET]       list + detail + history + overlay + rev
 *   node:/mcp-tools/{id}               [POST] leaf description override, enable/disable
 *   node:/mcp-tools/{id}/rollback      [POST] leaf roll a tool doc back to an earlier rev
 *   node:/mcp-plugins                  [GET]       third-party plugin review + audit tail
 *   node:/mcp/access                   [GET]       admin-gate state
 *   node:/mcp/access/tool-gate         [PUT]  leaf turn one tool's approval gate on/off
 *   node:/mcp/pending                  [GET]       parked admin calls
 *   node:/mcp/pending/{id}/confirm     [POST] leaf release ONE parked call
 *   node:/mcp/pending/{id}/deny        [POST] leaf drop ONE parked call
 *   node:/health                       [GET]       \
 *   node:/hub/status                   [GET]        > the Status view's four probes
 *   node:/claude-ai/mcp/servers        [GET]       /
 * ({id} above is written as a literal `*` segment in lmui.config.json; it is spelled out
 * here only because a `*` followed by a slash would end this comment block.)
 *
 * `*` is ONE path-parameter segment and `exact:true` pins the segment COUNT, so the
 * confirm rule reaches `/mcp/pending/<id>/confirm` and nothing else — in
 * particular it does NOT carry `/mcp/pending` itself, `/mcp/pending/<id>`, or a deeper
 * path. Both evaluators implement this identically (`core/src/ui-pages/local-tier/
 * grants.ts` and `LangMartDesign/ui-gateway/src/viewtoken/grant.ts`); a stale evaluator
 * that did not know `*` treats it as a literal segment and DENIES — fail-closed.
 *
 * A grant prefix stops at a SEGMENT boundary, so `/mcp` would cover /mcp/access and
 * /mcp/pending but NOT /mcp-tools or /mcp-plugins (next char is '-', not '/'). Hence the
 * separate rules. `/hub/status` is used rather than `/hub` because /hub/api-key and
 * /hub/config sit next to it, and `/claude-ai/mcp/servers` rather than `/claude-ai` for
 * the same reason — GET-only there also denies the sibling tool-access/auto-approve POSTs.
 *
 * WHAT IS NOT HELD, and why it is not a README footnote: three actions of the source page
 * (`POST /mcp-plugins/sync-connector`, `/:name/enable`, `/:name/disable`) are declared in
 * WITHHELD below and rendered INSIDE the pane, from every tab. The reason is measured, not
 * assumed: those three routes are loopback-only server-side (`requireLoopback` in
 * core/src/routes/core/mcp-plugins.routes.ts), and BOTH serving tiers reach Core over a
 * LOOPBACK socket — the local tier proxies with `http.request({host:'127.0.0.1'})` and the
 * hub relay's makeLocalRequest does the same. Measured on this node: the same POST answers
 * NOT_FOUND from 127.0.0.1 (guard passed) and FORBIDDEN from the LAN IP (guard blocked).
 * So a grant here would not be "the pane calling a route" — it would silently convert an
 * owner-at-the-console action into one that any holder of a 15-minute view token in a LAN
 * browser can fire. Confirm/deny and the gate toggle have NO such server-side locality
 * control (the shipped web page performs them over the hub relay today), so granting them
 * defeats nothing and restores parity. That is the whole line: grant where no server-side
 * locality control exists, withhold where one does — and SAY SO on the page.
 *
 * Paths + envelope shapes mirror core/src/routes/core/mcp-tools.routes.ts,
 * mcp-plugins.routes.ts and mcp-api.routes.ts, and were curl-verified against the live
 * dev Core (:3200) before this file was written. Four different wrapper conventions on
 * one page — do not guess any of them:
 *   GET  /mcp-tools               → data = { tools:[…], orphanDocs:[…], categories:[…], counts:{…} }
 *   GET  /mcp-tools/:name         → data = the row FLAT + { knownTool, def, doc, implementation }
 *                                   (NOT {tool:…}; an orphan doc returns ONLY name/knownTool/doc/def/implementation)
 *   GET  /mcp-tools/:name/history → data = { history:[…] }   (already newest-first)
 *   POST /mcp-tools/:name         → data = { doc, changed, knownTool }
 *   POST /mcp-tools/:name/rollback→ data = { doc }
 *   GET  /mcp/access              → data = { tools:[{ tool, scope, adminGate, description }] }
 *                                   ⚠ the key is `tool`, NOT `name` — joining on `name` silently yields nothing
 *   GET  /mcp/pending             → data = { pending:[{ id, tool, summary, createdAt, expiresAt }] }
 *   GET  /mcp-plugins             → data = { subsystemEnabled, plugins:[…], counts:{…} }
 *   GET  /mcp-plugins/:name/audit → data = { entries:[…] }   (oldest-first; we reverse)
 *   GET  /health · /hub/status · /claude-ai/mcp/servers → data = the bare status objects
 */
(function () {
  'use strict';

  // Vocabularies. SCOPES mirrors the ToolScope union in core/src/mcp-server/registry
  // (surfaced per-row as `scope`); the state chips are this pane's own view filters.
  var SCOPE_CHIPS = [['', 'all'], ['read', 'read'], ['write', 'write'], ['admin', 'admin']];
  var STATE_CHIPS = [['', 'all'], ['on', 'enabled'], ['off', 'disabled'], ['ovr', 'overridden'], ['gate', 'gated'], ['prot', 'protected']];
  var DTABS = ['description', 'implementation', 'settings', 'history'];

  // ── the capability ledger, rendered IN the pane ───────────────────────────
  // The source page (web/src/components/mcp-tools/McpToolsPage.tsx + ToolDetail +
  // PluginsPanel) performs eight writes. This list names all eight and states, on the page
  // itself, which ones this pane can fire and which it cannot — because a capability gap a
  // reader has to find in a README is a gap they discover the moment they needed it.
  var HELD = [
    ['Confirm a parked call', 'POST /mcp/pending/{id}/confirm', 'Releases ONE parked admin call and runs it now.'],
    ['Deny a parked call', 'POST /mcp/pending/{id}/deny', 'Drops ONE parked call without running it.'],
    ['Admin approval gate', 'PUT /mcp/access/tool-gate', 'Turns one tool’s extra approval requirement on or off.'],
    ['Description override', 'POST /mcp-tools/{name}', 'Edits the served description; every write is actored and revved.'],
    ['Enable / disable a tool', 'POST /mcp-tools/{name}', 'Live on both MCP surfaces; protected tools refuse.'],
    ['Roll a tool doc back', 'POST /mcp-tools/{name}/rollback', 'Restores an earlier rev from the History tab.'],
  ];
  var WITHHELD = [
    {
      label: 'Sync connector',
      route: 'POST /mcp-plugins/sync-connector',
      what: 'Pushes this node’s current plugin tool set to the claude.ai connector without a restart '
        + '(clear cache → refetch bootstrap → tool access → auto-approve).',
      why: 'The route is loopback-only server-side, and this pane’s calls arrive at Core FROM loopback on both '
        + 'tiers (the local tier proxies from 127.0.0.1; the hub relay does the same), so the server could not tell a '
        + 'browser from the console. Granting it would hand an owner-at-the-console action to anything holding a '
        + '15-minute view token on the LAN. It also mutates the claude.ai ACCOUNT (cached tool list, per-tool access, '
        + 'auto-approve) — state no grant written here can scope.',
      where: 'Run it at the console on this host: the Sync button on the full /mcp-tools web page, or POST the route '
        + 'from a shell on this machine.',
    },
    {
      label: 'Enable a plugin',
      route: 'POST /mcp-plugins/{name}/enable',
      what: 'Approves a third-party plugin, pins its payload checksum, and lets its subprocess start on first call.',
      why: 'Same defeated guard as above, and the action itself authorises third-party CODE EXECUTION on this host. '
        + 'That is not a decision a page reached over a network should be able to make on the owner’s behalf.',
      where: 'At the console on this host, after reviewing the payload checksum shown on the Plugins tab.',
    },
    {
      label: 'Disable a plugin',
      route: 'POST /mcp-plugins/{name}/disable',
      what: 'Stops a plugin and kills its running subprocess immediately.',
      why: 'This is the SAFE direction — it only ever stops code — but it is the same loopback-only owner '
        + 'route, and with enable withheld it would be one-way from here: a plugin stopped from this pane could not '
        + 'be started again from it.',
      where: 'At the console on this host.',
    },
  ];

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
  // One helper for BOTH stamp flavours this page serves: registry/plugin times are epoch
  // ms numbers, the plugin audit tail is an ISO string. A future stamp shows the date
  // rather than reading "just now" (clock skew across a fleet is normal).
  function ago(v) {
    if (v == null || v === '') return '—';
    var t = typeof v === 'number' ? v : Date.parse(v);
    if (!isFinite(t)) return String(v).slice(0, 16).replace('T', ' ');
    var m = Math.floor((Date.now() - t) / 60000);
    if (m < 0) return new Date(t).toISOString().slice(0, 16).replace('T', ' ');
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    if (m < 1440) return Math.floor(m / 60) + 'h ago';
    return Math.floor(m / 1440) + 'd ago';
  }
  function until(v) {
    if (v == null || v === '') return '—';
    var t = typeof v === 'number' ? v : Date.parse(v);
    if (!isFinite(t)) return String(v);
    var m = Math.round((t - Date.now()) / 60000);
    return m <= 0 ? 'expired' : ('expires in ' + m + 'm');
  }
  // Collapse to one line and hard-cap. Cuts on CODE POINTS so an astral char (emoji, and
  // several tool descriptions carry them) never splits into a lone surrogate.
  function oneLine(s, max) {
    var t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    if (t.length <= max) return t;
    return (Array.from ? Array.from(t) : t.split('')).slice(0, max).join('') + '…';
  }
  function pretty(v) {
    try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
  }

  // ── state ─────────────────────────────────────────────────────────────────
  var state = {
    tab: 'tools',                     // tools | plugins | status
    tools: [],                        // rows from GET /mcp-tools → data.tools
    orphans: [],                      // data.orphanDocs — registry docs this build does not advertise
    categories: [],                   // data.categories (server-declared display order)
    counts: null,                     // data.counts { tools, overridden, disabled, orphans }
    gates: {},                        // name → adminGate, folded from GET /mcp/access rows keyed `tool`
    gatesKnown: false,                // false ⇒ /mcp/access unreachable; we SAY so, never render "not gated"
    gateNames: {},                    // names the gate route will ACCEPT (its catalog is TOOL_SCOPES)
    gateBusy: false,                  // a PUT /mcp/access/tool-gate is in flight
    pending: [],                      // GET /mcp/pending → data.pending
    pendState: 'loading',             // loading | ok | error — the strip renders all three
    pendError: '',                    // the server's own text when the poll fails
    pendArmed: null,                  // 'confirm:<id>' | 'deny:<id>' — two-click arming, kept
                                      // separate from state.armed so a detail-pane repaint
                                      // cannot disarm a parked call the operator is releasing
    pendBusy: false,                  // a confirm/deny is in flight (also pauses the poll repaint)
    pendMsg: null,                    // { text, err } — the OUTCOME of the last confirm/deny
    withheldOpen: false,              // the capability ledger is expanded
    filter: { q: '', scope: '', st: '', cat: '' },
    selected: null,                   // selected tool NAME
    detail: null,                     // GET /mcp-tools/:name → data (flat)
    dtab: 'description',
    draft: '', base: '', loadedRev: 0, // override editor + optimistic-concurrency baseline
    conflict: null,                   // rev-conflict message, if any
    busy: false,                      // a write is in flight
    armed: null,                      // two-click confirm: the armed action key
    plugins: null,                    // GET /mcp-plugins → data
    pluginOpen: null,                 // expanded plugin name
    audit: [],                        // GET /mcp-plugins/:name/audit → data.entries
    status: null,                     // { core, plugins, hub, connector } — each may hold {error}
    seq: 0,                           // drops a stale detail response for a previously-selected tool
  };

  function say(msg, isErr) {
    var out = $('out');
    if (!out) return;
    out.textContent = typeof msg === 'string' ? msg : pretty(msg);
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
    d.innerHTML = '<div class="fatal-card"><div class="fatal-h">MCP Tools could not be loaded</div>'
      + '<pre class="fatal-msg"></pre><button class="primary" id="fatal-retry">Retry</button></div>';
    d.querySelector('.fatal-msg').textContent = message;   // textContent — server text is NOT trusted HTML
    document.body.appendChild(d);
    $('fatal-retry').onclick = function () { d.remove(); reloadActive(); };
    reportHeight();
  }
  // Mandatory on a tabbed pane: a fatal raised by one tab would otherwise stay pinned
  // over every other tab forever.
  function clearFatal() { var o = $('fatal-layer'); if (o) o.remove(); }

  // ── chips + filters ───────────────────────────────────────────────────────
  function chipset(el, values, current, attr) {
    el.innerHTML = values.map(function (c) {
      return '<span class="fchip' + (current === c[0] ? ' on' : '') + '" data-' + attr + '="' + esc(c[0]) + '">' + esc(c[1]) + '</span>';
    }).join('');
  }
  function paintChips() {
    chipset($('chips-scope'), SCOPE_CHIPS, state.filter.scope, 'fs');
    chipset($('chips-state'), STATE_CHIPS, state.filter.st, 'fst');
    var cats = state.categories.slice();
    state.tools.forEach(function (t) { if (t.category && cats.indexOf(t.category) === -1) cats.push(t.category); });
    $('cat').innerHTML = '<option value="">all categories</option>' + cats.map(function (c) {
      return '<option value="' + esc(c) + '"' + (state.filter.cat === c ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
  }
  function passFilters(t) {
    var f = state.filter;
    if (f.scope && t.scope !== f.scope) return false;
    if (f.cat && t.category !== f.cat) return false;
    if (f.st === 'on' && !t.enabled) return false;
    if (f.st === 'off' && t.enabled) return false;
    if (f.st === 'ovr' && !t.hasOverride) return false;
    if (f.st === 'prot' && !t.protected) return false;
    if (f.st === 'gate' && !state.gates[t.name]) return false;
    var q = f.q.trim().toLowerCase();
    if (q) {
      var hay = (t.name + ' ' + (t.category || '') + ' ' + (t.module || '') + ' ' + (t.effectiveDescription || '')).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  }

  // ── list ──────────────────────────────────────────────────────────────────
  // Group by category in the SERVER's declared order; a category the server did not
  // name (build drift) sorts last; tools alphabetical inside a group.
  function groupTools(rows) {
    var by = {}, order = [];
    rows.forEach(function (r) {
      var c = r.category || 'other';
      if (!by[c]) { by[c] = []; order.push(c); }
      by[c].push(r);
    });
    var rank = {};
    state.categories.forEach(function (c, i) { rank[c] = i; });
    order.sort(function (a, b) {
      var ra = rank[a] === undefined ? 1e9 : rank[a], rb = rank[b] === undefined ? 1e9 : rank[b];
      return ra !== rb ? ra - rb : (a < b ? -1 : a > b ? 1 : 0);
    });
    return order.map(function (c) {
      return { category: c, tools: by[c].sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; }) };
    });
  }

  function toolRowHtml(t) {
    var sel = state.selected === t.name ? ' sel' : '';
    var pills = '<span class="pill sc-' + esc(t.scope) + '">' + esc(t.scope || '?') + '</span>';
    if (!t.enabled) pills += '<span class="pill off">off</span>';
    if (t.hasOverride) pills += '<span class="pill ovr">override</span>';
    if (t.protected) pills += '<span class="pill prot">protected</span>';
    if (state.gates[t.name]) pills += '<span class="pill gate">gated</span>';
    if (t.rev !== undefined && !t.hasOverride && t.enabled) pills += '<span class="pill">rev ' + esc(t.rev) + '</span>';
    return '<div class="row' + sel + (t.enabled ? '' : ' dim') + '" data-tname="' + esc(t.name) + '">'
      + '<div class="rt">' + esc(t.name) + '</div>'
      + '<div class="rmeta">' + pills + '</div>'
      + '<div class="rsub">' + esc(oneLine(t.effectiveDescription, 120)) + '</div></div>';
  }
  function orphanRowHtml(d) {
    var sel = state.selected === d.name ? ' sel' : '';
    return '<div class="row' + sel + '" data-tname="' + esc(d.name) + '">'
      + '<div class="rt">' + esc(d.name) + '</div>'
      + '<div class="rmeta"><span class="pill off">not advertised</span><span class="pill">rev ' + esc(d.rev) + '</span></div></div>';
  }

  function paintList() {
    var vis = state.tools.filter(passFilters);
    var html = groupTools(vis).map(function (g) {
      return '<div class="grp"><div class="grp-h">' + esc(g.category) + ' <span class="grp-n">(' + g.tools.length + ')</span></div>'
        + g.tools.map(toolRowHtml).join('') + '</div>';
    }).join('');
    // Orphans only make sense unfiltered-by-category; they carry no scope/category at all.
    if (state.orphans.length && !state.filter.cat && !state.filter.scope) {
      html += '<div class="grp"><div class="grp-h" title="Registry docs whose tool name is not advertised by this build '
        + '(other-build tools or e2e scratch docs)">unregistered docs <span class="grp-n">(' + state.orphans.length + ')</span></div>'
        + state.orphans.map(orphanRowHtml).join('') + '</div>';
    }
    $('list').innerHTML = html || '<div class="empty-list">'
      + (state.tools.length ? 'No tools match the current filter.' : 'No tools advertised by this Core.') + '</div>';
    $('counts').textContent = 'showing ' + vis.length + ' of ' + state.tools.length + ' tool'
      + (state.tools.length === 1 ? '' : 's')
      + (state.counts ? ' · ' + state.counts.overridden + ' overridden · ' + state.counts.disabled + ' disabled' : '')
      + (state.gatesKnown ? '' : ' · admin-gate state UNAVAILABLE');
    reportHeight();
  }

  /** Fold GET /mcp/access (and the identical body PUT tool-gate returns) into the gate map.
   *  ⚠ each row keys the tool as `tool`, NOT `name` — joining on `name` silently yields
   *  nothing. Also records WHICH names the gate route will accept: its catalog is TOOL_SCOPES,
   *  so a tool absent from it would 400 MCP_ACCESS_BAD and must not be offered a toggle. */
  function foldGates(d) {
    if (!d || !Array.isArray(d.tools)) return false;
    state.gates = {};
    state.gateNames = {};
    d.tools.forEach(function (row) {
      if (!row || !row.tool) return;
      state.gates[row.tool] = !!row.adminGate;
      state.gateNames[row.tool] = true;
    });
    state.gatesKnown = true;
    return true;
  }

  // The list is the primary call — its failure is fatal. Gates and pending are
  // best-effort: a dead /mcp/access must not blank the registry, but rendering every
  // tool as "not gated" would misreport the security posture, so we say it is unknown.
  function loadList() {
    $('list').innerHTML = 'loading…';
    return api('node', '/mcp-tools').then(function (r) {
      if (!r.ok) { fatal(r.error.code + ': ' + r.error.message); return; }
      var d = r.data || {};
      state.tools = Array.isArray(d.tools) ? d.tools : [];
      state.orphans = Array.isArray(d.orphanDocs) ? d.orphanDocs : [];
      state.categories = Array.isArray(d.categories) ? d.categories : [];
      state.counts = d.counts || null;
      clearFatal();
      return api('node', '/mcp/access').then(function (g) {
        if (!foldGates(g.ok ? g.data : null)) state.gatesKnown = false;  // keep last-known, flag stale
        paintChips();
        paintList();
      });
    });
  }

  // ── pending admin confirmations (Confirm / Deny — the headline write) ─────
  // A parked call EXPIRES 10 MINUTES after it was made, so this strip is rendered in ALL
  // states, including empty. Hiding it when the list is empty makes "nothing is parked"
  // and "the poll has been failing for ten minutes" look identical on screen — and under
  // that ambiguity a real parked call dies while the operator watches a clean-looking pane.
  function pendExpired(p) {
    var t = typeof p.expiresAt === 'number' ? p.expiresAt : Date.parse(p.expiresAt);
    return isFinite(t) && t <= Date.now();
  }
  function pbtn(act, id, label, cls) {
    return '<button class="' + cls + ' sm" data-pact="' + esc(act) + '" data-pid="' + esc(id) + '"'
      + (state.pendBusy ? ' disabled' : '') + '>' + esc(label) + '</button>';
  }
  // Two-click on BOTH: confirm EXECUTES an admin tool, deny destroys a call that cannot be
  // re-parked. The armed label names the tool, so a mis-aimed second click is still readable.
  function pendActionsHtml(p) {
    if (pendExpired(p)) {
      return '<span class="pend-gone">expired — the caller already got a failure; it cannot be run from here</span>';
    }
    if (state.pendArmed === 'confirm:' + p.id) {
      return pbtn('confirm', p.id, 'Really RUN ' + oneLine(p.tool, 40) + ' now?', 'danger')
        + pbtn('cancel', p.id, 'Cancel', 'ghost');
    }
    if (state.pendArmed === 'deny:' + p.id) {
      return pbtn('deny', p.id, 'Really drop ' + oneLine(p.tool, 40) + '?', 'danger')
        + pbtn('cancel', p.id, 'Cancel', 'ghost');
    }
    return pbtn('arm-confirm', p.id, 'Confirm', 'primary') + pbtn('arm-deny', p.id, 'Deny', 'ghost');
  }
  function pendRowHtml(p) {
    return '<div class="pend-row' + (pendExpired(p) ? ' gone' : '') + '">'
      + '<span class="mono">' + esc(p.tool) + '</span>'
      + '<span class="pend-sum" title="' + esc(p.summary) + '">' + esc(oneLine(p.summary, 160)) + '</span>'
      + '<span class="pend-when">' + esc(ago(p.createdAt)) + ' · ' + esc(until(p.expiresAt)) + '</span>'
      + '<span class="pend-acts">' + pendActionsHtml(p) + '</span></div>';
  }

  function paintPending() {
    var el = $('pending');
    el.hidden = false;
    var n = state.pending.length;
    var cls = 'pending', head, body = '';

    if (state.pendState === 'loading' && !n) {
      cls += ' calm';
      head = 'Parked admin tool calls — loading…';
    } else if (state.pendState === 'error') {
      cls += ' broken';
      head = 'Parked admin tool calls — THIS LIST COULD NOT BE READ';
      body = '<div class="pend-note err">' + esc(state.pendError || 'unknown error') + '</div>'
        + '<div class="pend-note">A parked call expires 10 minutes after it was made and this strip is the only '
        + 'place it is visible, so treat the rows below (if any) as last-known, not current.</div>'
        + (n ? state.pending.map(pendRowHtml).join('') : '')
        + '<div class="pend-acts"><button class="ghost sm" data-pact="reload">Retry now</button></div>';
    } else if (!n) {
      cls += ' calm';
      head = 'No parked tool calls — nothing is waiting on you';
      body = '<div class="pend-note">A tool whose admin gate is ON parks its call here instead of executing, and the '
        + 'call expires 10 minutes later. Re-checked every 15s.</div>';
    } else {
      head = n + ' pending admin confirmation' + (n === 1 ? '' : 's') + ' — parked tool calls awaiting a decision';
      body = state.pending.map(pendRowHtml).join('')
        + '<div class="pend-note">Confirm RUNS the tool now and returns its result to the caller that parked it; Deny '
        + 'drops it and the caller’s call fails. Both are irreversible and both ask twice.</div>';
    }
    if (state.pendMsg) {
      // In-flight is deliberately NOT green: this line is the only report of whether a tool
      // ran, so "still running" must not be readable as "ran fine".
      var mcls = state.pendMsg.err ? ' err' : state.pendMsg.busy ? ' busy' : ' ok';
      body += '<div class="pend-note' + mcls + '">' + esc(state.pendMsg.text) + '</div>';
    }
    el.className = cls;
    el.innerHTML = '<div class="pend-h">' + esc(head) + '</div>' + body;
    reportHeight();
  }

  function loadPending() {
    // Never repaint over an in-flight decision: the row the operator is acting on must not
    // move or vanish under the cursor mid-write.
    if (state.pendBusy) return Promise.resolve();
    return api('node', '/mcp/pending').then(function (r) {
      if (state.pendBusy) return;
      if (!r.ok) {
        state.pendState = 'error';
        state.pendError = r.error.code + ': ' + r.error.message;
        paintPending();
        return;
      }
      state.pendState = 'ok';
      state.pendError = '';
      state.pending = (r.data && Array.isArray(r.data.pending)) ? r.data.pending : [];
      // An armed row that is no longer listed (expired or actioned elsewhere) must not stay
      // armed — the next click would otherwise fire at an id that is already gone.
      if (state.pendArmed) {
        var armedId = state.pendArmed.slice(state.pendArmed.indexOf(':') + 1);
        var live = state.pending.some(function (p) { return p.id === armedId; });
        if (!live) state.pendArmed = null;
      }
      paintPending();
    });
  }

  /** Confirm or deny ONE parked call. The row disappears either way, so the OUTCOME has to
   *  be stated explicitly — a call that expired between render and click did NOT run, and
   *  watching the row vanish is indistinguishable from success. */
  function resolvePending(id, action) {
    if (state.pendBusy) return;
    var row = null;
    for (var i = 0; i < state.pending.length; i++) if (state.pending[i].id === id) row = state.pending[i];
    var tool = row ? row.tool : id;
    state.pendBusy = true;
    state.pendArmed = null;
    state.pendMsg = { text: (action === 'confirm' ? 'running ' : 'denying ') + tool + '…', err: false, busy: true };
    paintPending();
    say((action === 'confirm' ? 'confirm ' : 'deny ') + tool + '…');
    api('node', '/mcp/pending/' + encodeURIComponent(id) + '/' + action, { method: 'POST' }).then(function (r) {
      state.pendBusy = false;
      if (!r.ok) {
        var extra = r.error.code === 'MCP_PENDING_NOT_FOUND'
          ? ' — it expired or was already actioned elsewhere, so the tool did NOT run'
          : '';
        state.pendMsg = { text: action + ' failed for ' + tool + ': ' + r.error.code + ': ' + r.error.message + extra, err: true };
        say(action + ' failed — ' + r.error.code + ': ' + r.error.message, true);
      } else {
        var d = r.data || {};
        state.pendMsg = action === 'confirm'
          ? { text: 'confirmed — ' + (d.tool || tool) + ' ' + (d.status || 'executed') + '; its result went back to the caller', err: false }
          : { text: 'denied — ' + (d.tool || tool) + ' was dropped without running', err: false };
        say(state.pendMsg.text);
      }
      // Drop it locally so it cannot be clicked twice, then re-read the authoritative list.
      state.pending = state.pending.filter(function (p) { return p.id !== id; });
      paintPending();
      loadPending();
    });
  }

  // ── the capability ledger (what this pane can and cannot fire) ────────────
  function paintWithheld() {
    var el = $('withheld');
    var n = WITHHELD.length;
    var summary = '<button class="ghost sm" id="withheld-toggle">' + (state.withheldOpen ? 'Hide' : 'Show')
      + '</button><span class="wh-sum">' + n + ' action' + (n === 1 ? '' : 's')
      + ' of the full MCP Tools page are NOT available in this pane</span>';
    if (!state.withheldOpen) { el.innerHTML = summary; reportHeight(); return; }
    el.innerHTML = summary
      + '<div class="wh-body"><div class="lbl">NOT AVAILABLE HERE</div>'
      + WITHHELD.map(function (w) {
          return '<div class="wh-item"><div class="wh-top"><span class="b">' + esc(w.label) + '</span>'
            + '<span class="pill bad">withheld</span><span class="mono-inline">' + esc(w.route) + '</span></div>'
            + '<div class="card-b">' + esc(w.what) + '</div>'
            + '<div class="card-b warn">Why not here: ' + esc(w.why) + '</div>'
            + '<div class="card-b">Where to do it: ' + esc(w.where) + '</div></div>';
        }).join('')
      + '<div class="lbl">AVAILABLE HERE</div>'
      + HELD.map(function (h) {
          return '<div class="wh-item held"><div class="wh-top"><span class="b">' + esc(h[0]) + '</span>'
            + '<span class="pill ok">held</span><span class="mono-inline">' + esc(h[1]) + '</span></div>'
            + '<div class="card-b">' + esc(h[2]) + '</div></div>';
        }).join('')
      + '<div class="hint">Every write above is a LEAF grant naming exactly one route, so a route added next to it '
      + 'later cannot inherit this pane’s authority without a config change and a review.</div></div>';
    reportHeight();
  }

  // ── tool detail ───────────────────────────────────────────────────────────
  function openTool(name) {
    var seq = ++state.seq;
    state.selected = name;
    state.conflict = null;
    state.armed = null;
    state.dtab = 'description';
    paintList();                                  // re-highlight the selected row
    return api('node', '/mcp-tools/' + encodeURIComponent(name)).then(function (r) {
      if (seq !== state.seq) return;              // a newer selection already landed
      if (!r.ok) {
        state.detail = { name: name, loadError: r.error.code + ': ' + r.error.message };
        paintDetail();
        return;
      }
      applyDetail(r.data || null);
    });
  }
  function applyDetail(d) {
    state.detail = d;
    var over = (d && d.doc && d.doc.descriptionOverride != null) ? d.doc.descriptionOverride : '';
    state.draft = over;
    state.base = over;
    state.loadedRev = (d && d.doc && d.doc.rev) || 0;
    paintDetail();
  }
  /** A write's response carries the ORIGIN's fresh doc. Apply it directly — the registry
   *  is origin-anchored, so a re-GET on a replica reads a copy that lags the write until
   *  the pull reconcile, and the save would look dropped. */
  function applyDoc(doc) {
    if (!doc) return false;
    if (state.detail) state.detail.doc = doc;
    state.draft = doc.descriptionOverride != null ? doc.descriptionOverride : '';
    state.base = state.draft;
    state.loadedRev = doc.rev || 0;
    return true;
  }

  function metaRow(label, value) {
    return value ? '<div><span class="k">' + esc(label) + ':</span> ' + esc(value) + '</div>' : '';
  }
  function btn(act, label, cls, arg, dis) {
    return '<button class="' + (cls || 'ghost') + '" data-act="' + esc(act) + '"'
      + (arg !== undefined && arg !== null ? ' data-arg="' + esc(arg) + '"' : '')
      + (dis ? ' disabled' : '') + '>' + esc(label) + '</button>';
  }
  // Two-click confirm: the first click ARMS (relabels), the second acts.
  function confirmBtn(act, label, armedLabel, cls, arg) {
    var key = act + ':' + (arg == null ? '' : arg);
    return state.armed === key
      ? btn(act, armedLabel, 'danger', arg)
      : btn('arm', label, cls || 'ghost', key);
  }

  function descriptionHtml(d) {
    if (!d.knownTool) {
      return '<div class="note">This registry doc has no matching tool in this build (created by another build, or an '
        + 'e2e scratch doc). Its override text:</div>'
        + '<pre class="mono' + (d.doc && d.doc.descriptionOverride ? '' : ' none') + '">'
        + esc(d.doc && d.doc.descriptionOverride != null ? d.doc.descriptionOverride : '(none)') + '</pre>';
    }
    var hasOverride = !!(d.doc && d.doc.descriptionOverride != null);
    var dirty = state.draft !== state.base;
    return '<div class="lbl">EFFECTIVE DESCRIPTION — what tools/list serves right now '
      + (hasOverride ? '(override active)' : '(code default)') + '</div>'
      + '<pre class="mono">' + esc(d.effectiveDescription || '') + '</pre>'
      + '<div class="lbl">OVERRIDE — stored in the fleet registry; leave empty and use Restore default to clear</div>'
      + '<textarea id="ta-override" class="ta" spellcheck="false" placeholder="No override — the code default below is '
      + 'served. Type here to override the description.">' + esc(state.draft) + '</textarea>'
      + '<div class="actions">'
      + btn('save', 'Save override (rev ' + state.loadedRev + ' → ' + (state.loadedRev + 1) + ')', 'primary', null,
            !dirty || state.busy || !state.draft.trim())
      + btn('revert', 'Revert', 'ghost', null, !dirty || state.busy)
      + (hasOverride ? confirmBtn('restore', 'Restore default', 'Really restore the code default?', 'ghost') : '')
      + '</div>'
      + '<div class="hint">Saving an empty override is refused — use Restore default to clear it. Every write is '
      + 'recorded with an actor and a rev, and is reversible from the History tab.</div>'
      + '<div class="lbl">DEFAULT FROM CODE — always available, never editable here</div>'
      + '<pre class="mono dashed">' + esc(d.defaultDescription || '') + '</pre>';
  }

  function implementationHtml(d) {
    if (!d.knownTool) return '<div class="note">No implementation on this build — the name is not an advertised tool here.</div>';
    return '<div class="note">Read-only view of the actual implementation. Names, schemas, scopes and handlers are '
      + 'code-owned — the registry cannot change them.</div>'
      + '<div class="lbl">DEFINING MODULE</div>'
      + '<pre class="mono">' + esc((d.implementation && d.implementation.module) || d.module || '(unknown)') + '</pre>'
      + '<div class="lbl">TOOL DEFINITION (as advertised — includes inputSchema)</div>'
      + '<pre class="mono tall">' + esc(pretty(d.def)) + '</pre>'
      + '<div class="lbl">REGISTERED HANDLER SOURCE (String(handler) of the in-process handler)</div>'
      + '<pre class="mono tall">' + esc((d.implementation && d.implementation.handlerSource) || '(no in-process handler registered)') + '</pre>';
  }

  function settingsHtml(d) {
    var enabled = d.doc ? d.doc.enabled !== false : (d.enabled !== false);
    var gated = state.gates[d.name];
    var s = '<div class="card"><div class="card-h">Enabled</div>'
      + '<div class="card-b">A disabled tool is omitted from tools/list on both MCP surfaces and every call is rejected '
      + 'with a clear TOOL_DISABLED error — live, no Core restart. Re-enabling is instant.</div>';
    if (d.protected) {
      s += '<div class="note">Protected tool — cannot be disabled (part of the orientation surface that keeps agents '
        + 'able to orient and self-help). Description overrides are still allowed.</div>';
    } else if (enabled) {
      s += '<div class="actions">' + confirmBtn('disable', 'Disable tool', 'Really disable ' + d.name + '?', 'ghost') + '</div>';
    } else {
      s += '<div class="actions">' + btn('enable', 'Enable tool', 'primary', null, state.busy) + '</div>';
    }
    s += '</div>';

    if (d.knownTool) {
      s += '<div class="card"><div class="card-h">Admin approval gate</div>'
        + '<div class="card-b">When gated, remote MCP calls to this tool park as pending confirmations (the banner at '
        + 'the top of this pane) instead of executing.</div>';
      if (!state.gatesKnown) {
        s += '<div class="note warn">Gate state unavailable (/mcp/access unreachable) — shown as unknown rather than '
          + 'guessed, because rendering every tool as “not gated” would misreport the security posture. The toggle is '
          + 'withheld while the state is unknown: flipping a gate you cannot read is a coin toss on a security setting.</div>';
      } else if (!state.gateNames[d.name]) {
        // The gate route validates against TOOL_SCOPES; a name it does not carry would 400.
        s += '<div class="actions"><span class="pill">not in the gate catalog</span></div>'
          + '<div class="note">This tool is advertised but absent from the admin-gate catalog (TOOL_SCOPES), so the '
          + 'gate route would reject it with MCP_ACCESS_BAD. No toggle is offered rather than one that always fails.</div>';
      } else {
        s += '<div class="actions"><span class="pill ' + (gated ? 'gate' : '') + '">'
          + (gated ? 'gated — approval required' : 'not gated') + '</span>'
          + (gated
              ? confirmBtn('ungate', 'Turn gate OFF', 'Really remove the approval requirement?', 'ghost')
              : btn('gate', 'Turn gate ON', 'primary', null, state.gateBusy))
          + '</div>'
          + '<div class="hint">Turning it ON is one click — it only ADDS an approval step. Turning it OFF asks twice: '
          + 'it REMOVES one, and unlike a description edit this route records no history, so the only account of the '
          + 'change is this pane telling you now.</div>';
      }
      s += '</div>'
        + '<div class="card"><div class="card-b">scope: <b>' + esc(d.scope || '?') + '</b> · category: <b>'
        + esc(d.category || '?') + '</b></div><div class="card-b mono">' + esc(d.module || '') + '</div></div>';
    }
    return s;
  }

  function historyHtml(d) {
    var hist = (d.doc && Array.isArray(d.doc.history)) ? d.doc.history.slice().reverse() : [];
    if (!hist.length) return '<div class="note">No registry history — this tool runs on pure code defaults.</div>';
    var cur = d.doc ? d.doc.rev : -1;
    return '<table class="tbl"><thead><tr><th>rev</th><th>when</th><th>actor</th><th>state after</th><th>changes</th><th></th></tr></thead><tbody>'
      + hist.map(function (h) {
        var st = (h.state && h.state.enabled) ? '<span class="pill">on</span>' : '<span class="pill off">off</span>';
        if (h.state && h.state.descriptionOverride != null) {
          st += '<span class="pill ovr">override len ' + h.state.descriptionOverride.length + '</span>';
        }
        var changes = Object.keys((h.changes || {})).join(', ') || '—';
        return '<tr><td class="mono">' + esc(h.rev) + (h.rev === cur ? '<span class="pill cur">current</span>' : '') + '</td>'
          + '<td>' + esc(ago(h.at)) + '</td>'
          + '<td>' + esc((h.actor && h.actor.kind) || 'unknown') + esc(h.actor && h.actor.channel ? ' · ' + h.actor.channel : '') + '</td>'
          + '<td>' + st + '</td>'
          + '<td class="mono dim">' + esc(changes) + '</td>'
          + '<td class="ta-r">' + (h.rev !== cur ? confirmBtn('rollback', 'Rollback', 'Restore rev ' + h.rev + '?', 'ghost', h.rev) : '') + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function paintDetail() {
    var d = state.detail;
    var el = $('detail');
    if (!state.selected) {
      el.className = 'detail empty';
      el.textContent = 'Select a tool on the left to see its description, implementation, settings and revision history.';
      reportHeight();
      return;
    }
    el.className = 'detail';
    if (!d) { el.textContent = 'loading ' + state.selected + '…'; reportHeight(); return; }
    if (d.loadError) {
      el.innerHTML = '<h2 class="d-title">' + esc(d.name) + '</h2><div class="note warn"></div>'
        + '<div class="actions">' + btn('reopen', 'Retry', 'ghost') + '</div>';
      el.querySelector('.note').textContent = d.loadError;
      reportHeight();
      return;
    }

    var pills = '';
    if (d.knownTool) {
      pills += '<span class="pill sc-' + esc(d.scope) + '">' + esc(d.scope || '?') + '</span>'
        + '<span class="pill">' + esc(d.category || '?') + '</span>';
    } else {
      pills += '<span class="pill off">not advertised by this build</span>';
    }
    if (d.protected) pills += '<span class="pill prot">protected</span>';
    var enabled = d.doc ? d.doc.enabled !== false : (d.enabled !== false);
    if (!enabled) pills += '<span class="pill off">disabled</span>';
    if (state.gates[d.name]) pills += '<span class="pill gate">gated</span>';
    pills += d.doc ? '<span class="pill">rev ' + esc(d.doc.rev) + '</span>' : '<span class="pill">default — no registry doc</span>';

    var lastEdit = (d.doc && d.doc.lastUpdatedBy)
      ? ('last edit: ' + (d.doc.lastUpdatedBy.kind || 'unknown') + (d.doc.updatedAt ? ' · ' + ago(d.doc.updatedAt) : ''))
      : '';

    // Plain dispatch — each builder handles the orphan-doc case itself, so an
    // unadvertised name still gets a working Settings (enable/disable) and History tab.
    var body = state.dtab === 'implementation' ? implementationHtml(d)
      : state.dtab === 'settings' ? settingsHtml(d)
      : state.dtab === 'history' ? historyHtml(d)
      : descriptionHtml(d);

    el.innerHTML = '<h2 class="d-title mono">' + esc(d.name) + '</h2>'
      + '<div class="d-pills">' + pills + '</div>'
      + (lastEdit ? '<div class="d-sub">' + esc(lastEdit) + '</div>' : '')
      + '<div class="dtabs">' + DTABS.map(function (t) {
          return '<button class="dtab' + (state.dtab === t ? ' on' : '') + '" data-dtab="' + t + '">' + t + '</button>';
        }).join('') + '</div>'
      + (state.conflict ? '<div class="note warn conflict-note"></div>'
          + '<div class="actions">' + btn('reopen', 'Reload latest', 'ghost') + '</div>' : '')
      + '<div class="d-body">' + body + '</div>';
    // Scoped to the container we just populated (same idiom as the loadError branch
    // above) rather than a document-global id lookup, and textContent because the
    // message quotes server-supplied rev numbers.
    if (state.conflict) el.querySelector('.conflict-note').textContent = state.conflict;
    reportHeight();
  }

  // ── writes (the ONE granted write prefix: POST /mcp-tools/*) ───────────────
  function refreshRow(doc) {
    // Reflect the write in the list row without refetching 286 tools.
    for (var i = 0; i < state.tools.length; i++) {
      if (state.tools[i].name !== state.selected) continue;
      var t = state.tools[i];
      t.enabled = doc.enabled !== false;
      t.hasOverride = doc.descriptionOverride != null;
      t.effectiveDescription = doc.descriptionOverride != null ? doc.descriptionOverride : t.defaultDescription;
      t.rev = doc.rev;
      break;
    }
  }
  function write(path, body, label) {
    if (state.busy) return;
    state.busy = true;
    state.armed = null;
    say(label + '…');
    api('node', path, { method: 'POST', body: body }).then(function (r) {
      state.busy = false;
      if (!r.ok) { say(label + ' failed — ' + r.error.code + ': ' + r.error.message, true); paintDetail(); return; }
      var doc = r.data && r.data.doc;
      if (doc) { applyDoc(doc); refreshRow(doc); } else { openTool(state.selected); }
      paintDetail();
      paintList();
      say(label + ' ok — now rev ' + (doc ? doc.rev : '?'));
    });
  }
  /** Optimistic concurrency: re-read the doc and compare revs before overwriting, so a
   *  concurrent edit from another node/session is reported instead of silently clobbered. */
  function guardedWrite(body, label) {
    if (state.busy || !state.selected) return;
    var name = state.selected;
    state.busy = true;
    say('checking for concurrent edits…');
    api('node', '/mcp-tools/' + encodeURIComponent(name)).then(function (r) {
      state.busy = false;
      if (!r.ok) { say('pre-check failed — ' + r.error.code + ': ' + r.error.message, true); return; }
      var freshRev = (r.data && r.data.doc && r.data.doc.rev) || 0;
      if (freshRev !== state.loadedRev) {
        state.conflict = 'This tool’s registry doc changed while you were editing (now rev ' + freshRev
          + ', you loaded rev ' + state.loadedRev + '). Reload the latest, then re-apply your edit.';
        paintDetail();
        say('write refused — the doc moved to rev ' + freshRev, true);
        return;
      }
      state.conflict = null;
      write('/mcp-tools/' + encodeURIComponent(name), body, label);
    });
  }

  /** PUT /mcp/access/tool-gate {tool, enabled} → data = the FULL catalog ({tools:[…]}), the
   *  same body GET /mcp/access returns. Fold it straight back in: it is authoritative and
   *  saves a re-read. Unlike the plugin routes this one carries no server-side locality
   *  control, so holding it here defeats nothing that exists. */
  function setGate(tool, enabled) {
    if (state.gateBusy || !tool) return;
    state.gateBusy = true;
    state.armed = null;
    say((enabled ? 'gating ' : 'ungating ') + tool + '…');
    api('node', '/mcp/access/tool-gate', { method: 'PUT', body: { tool: tool, enabled: enabled } }).then(function (r) {
      state.gateBusy = false;
      if (!r.ok) {
        say('gate change failed — ' + r.error.code + ': ' + r.error.message, true);
        paintDetail();
        return;
      }
      if (!foldGates(r.data)) {
        // A 200 whose body is not the catalog: the write landed but the state we would
        // paint is a guess. Re-read rather than invent one.
        say('gate change accepted but the catalog did not come back — re-reading…');
        api('node', '/mcp/access').then(function (g) {
          if (!foldGates(g.ok ? g.data : null)) state.gatesKnown = false;
          paintList(); paintDetail();
        });
        return;
      }
      paintList();
      paintDetail();
      say('admin gate for ' + tool + ' is now ' + (enabled
        ? 'ON — remote MCP calls to it park for confirmation instead of executing'
        : 'OFF — remote MCP calls to it execute directly'));
    });
  }

  // ── plugins (read-only review) ────────────────────────────────────────────
  function capSummary(c) {
    c = c || { network: [], fs: [], env: [] };
    var p = [];
    if ((c.network || []).length) p.push(c.network.length + ' network host' + (c.network.length > 1 ? 's' : ''));
    if ((c.fs || []).length) p.push(c.fs.length + ' fs path' + (c.fs.length > 1 ? 's' : ''));
    if ((c.env || []).length) p.push(c.env.length + ' env var' + (c.env.length > 1 ? 's' : ''));
    return p.length ? p.join(' · ') : 'no declared access';
  }
  function shortSum(s) {
    if (!s) return '—';
    var hex = s.indexOf('sha256:') === 0 ? s.slice(7) : s;
    return hex.length <= 12 ? hex : hex.slice(0, 12) + '…';
  }
  function phaseBadge(p) {
    if (p.phase === 'enabled') return { label: 'enabled', tone: 'ok', hint: 'Approved and eligible to run; the subprocess starts on first call.' };
    if (p.phase === 'unhealthy') return { label: 'unhealthy', tone: 'warn', hint: (p.health && p.health.lastError) || 'Quarantined after repeated failures.' };
    if (p.phase === 'invalid') return { label: 'invalid', tone: 'bad', hint: (p.manifestErrors || [])[0] || 'The manifest failed validation.' };
    return { label: 'disabled', tone: 'dim', hint: p.reason || 'Not approved — nothing runs until an owner enables it.' };
  }
  function needsReapproval(p) { return !!p.approvedChecksum && p.approvedChecksum !== p.payloadChecksum; }

  function pluginHtml(p) {
    var b = phaseBadge(p);
    var open = state.pluginOpen === p.name;
    var s = '<div class="card"><div class="card-top"><span class="mono b">' + esc(p.name) + '</span>'
      + '<span class="pill ' + b.tone + '" title="' + esc(b.hint) + '">' + esc(b.label) + '</span>'
      + (p.version ? '<span class="pill">v' + esc(p.version) + '</span>' : '')
      + (needsReapproval(p) ? '<span class="pill warn" title="The payload changed after approval, so it was auto-reverted to disabled.">payload changed</span>' : '')
      + btn('plug', open ? 'Hide' : 'Review', 'ghost sm r', p.name) + '</div>'
      + '<div class="card-b">' + esc(p.description || '(no description)') + '</div>'
      + '<div class="card-b dim">' + (p.tools || []).length + ' tool' + ((p.tools || []).length === 1 ? '' : 's')
      + ' · ' + esc(capSummary(p.capabilities)) + ' · payload ' + esc(shortSum(p.payloadChecksum)) + '</div>'
      + (b.tone !== 'ok' ? '<div class="card-b ' + b.tone + '">' + esc(b.hint) + '</div>' : '');
    if (!open) return s + '</div>';

    s += '<div class="lbl">TOOLS IT WOULD ADVERTISE (namespaced — no built-in can be shadowed)</div><div class="sub">'
      + ((p.tools || []).map(function (t) {
          return '<div class="mono b">ext__' + esc(p.name) + '__' + esc(t.name) + '</div><div class="dim">'
            + esc(oneLine(t.description, 240)) + '</div>';
        }).join('') || '<div class="dim">(none)</div>')
      + '</div>'
      + '<div class="lbl">DECLARED CAPABILITIES — what it says it needs</div>'
      + '<pre class="mono">' + esc([
          'network : ' + (((p.capabilities || {}).network || []).join(', ') || '(none)'),
          'fs      : ' + (((p.capabilities || {}).fs || []).join(', ') || '(none)'),
          'env     : ' + (((p.capabilities || {}).env || []).join(', ') || '(none)'),
          'granted : ' + ((p.grantedEnv || []).join(', ') || '(none)'),
          'entry   : ' + (p.entry ? p.entry.command + ' ' + (p.entry.args || []).join(' ') : '(unknown)'),
        ].join('\n')) + '</pre>'
      + '<div class="hint">Network and fs entries are declarations reviewed and pinned at approval — this build does '
      + 'not sandbox the subprocess at the OS level. Environment IS enforced: the child inherits nothing, and only '
      + 'granted names are passed (values never leave the node).</div>'
      + '<div class="lbl">PIN</div>'
      + '<pre class="mono">' + esc([
          'on disk  : ' + (p.payloadChecksum || '(unhashable)'),
          'approved : ' + (p.approvedChecksum || '(never approved)'),
          'matches  : ' + (p.pinMatches ? 'yes' : 'no'),
          p.enabledAt ? 'enabled  : ' + ago(p.enabledAt) : '',
        ].filter(Boolean).join('\n')) + '</pre>'
      + ((p.manifestErrors || []).length
          ? '<div class="lbl">MANIFEST ERRORS</div><pre class="mono bad">' + esc(p.manifestErrors.join('\n')) + '</pre>' : '')
      + '<div class="note warn">Enable and Disable are NOT available in this pane (POST /mcp-plugins/' + esc(p.name)
      + '/enable and /disable). Server-side both are loopback-only owner actions, and a pane reaches Core FROM loopback '
      + 'on both serving tiers — so granting them would not add a capability, it would quietly turn an '
      + 'at-the-console decision into one any LAN browser holding a 15-minute view token could make. Enabling also '
      + 'authorises third-party code execution on this host. Do it at the console, after checking the PIN above.</div>'
      + '<div class="lbl">AUDIT TAIL (arguments are digested, never recorded verbatim)</div>';

    s += state.audit.length
      ? '<table class="tbl"><thead><tr><th>when</th><th>tool</th><th>args</th><th>ms</th><th>outcome</th></tr></thead><tbody>'
        + state.audit.slice().reverse().map(function (e) {
            return '<tr><td>' + esc(ago(e.ts)) + '</td><td class="mono">' + esc(e.tool) + '</td>'
              + '<td class="mono dim">' + esc(e.argDigest) + '</td><td>' + esc(e.durationMs) + '</td>'
              + '<td class="' + (e.outcome === 'ok' ? 'ok' : 'warn') + '">' + esc(e.outcome) + '</td></tr>';
          }).join('') + '</tbody></table>'
      : '<div class="dim">No calls recorded.</div>';
    return s + '</div>';
  }

  function paintPlugins() {
    var el = $('plugins');
    var d = state.plugins;
    if (!d) { el.innerHTML = '<div class="empty-list">loading…</div>'; reportHeight(); return; }
    var list = d.plugins || [];
    var need = list.filter(function (p) { return p.phase === 'disabled' || p.phase === 'invalid' || needsReapproval(p); }).length;
    el.innerHTML = '<div class="ptop">' + list.length + ' installed · '
      + list.filter(function (p) { return p.phase === 'enabled'; }).length + ' enabled · ' + need + ' awaiting review'
      + btn('plugins-reload', 'Refresh', 'ghost sm r') + '</div>'
      + (d.subsystemEnabled ? '' : '<div class="note warn">The plugin subsystem is switched off on this node '
          + '(LM_MCP_PLUGINS=0). No plugin tool is advertised and no plugin can run, whatever its individual state says.</div>')
      // The Sync button of the source page belongs on this tab, so its absence is stated on
      // this tab — not left for a reader to discover from a README they will not open.
      + '<div class="note warn">This tab is REVIEW-ONLY. The source page’s <b>Sync</b> button '
      + '(POST /mcp-plugins/sync-connector — push the current plugin tool set to the claude.ai connector without a '
      + 'restart) and per-plugin <b>Enable/Disable</b> are not available here: all three are loopback-only owner '
      + 'routes, and a pane reaches Core from loopback on both tiers, so a grant would defeat that control rather '
      + 'than pass it. Sync additionally mutates the claude.ai ACCOUNT (cached tool list, per-tool access, '
      + 'auto-approve). Full reasoning and where to run each: the ledger at the top of this pane.</div>'
      + (list.length ? list.map(pluginHtml).join('')
          : '<div class="empty-list">No plugins installed. Drop a plugin directory into the node’s mcp-plugins '
            + 'folder; it is parsed and listed here <b>disabled</b> — nothing runs until an owner enables it.</div>');
    reportHeight();
  }
  function loadPlugins() {
    // Paint the loading state from CODE, not from index.html's initial text: that static
    // "loading…" only covers the very first open, so a Refresh would otherwise sit on stale
    // content with no sign that a call is in flight.
    state.plugins = null;
    state.audit = [];
    paintPlugins();
    return api('node', '/mcp-plugins').then(function (r) {
      if (!r.ok) { fatal(r.error.code + ': ' + r.error.message); return; }
      clearFatal();
      state.plugins = r.data || { plugins: [] };
      paintPlugins();
      // The audit tail was cleared with the list above; an expanded card must not silently
      // re-render as "No calls recorded" just because the operator hit Refresh.
      if (state.pluginOpen) loadAudit(state.pluginOpen);
    });
  }
  function loadAudit(name) {
    return api('node', '/mcp-plugins/' + encodeURIComponent(name) + '/audit?limit=25').then(function (r) {
      state.audit = (r.ok && r.data && Array.isArray(r.data.entries)) ? r.data.entries : [];
      paintPlugins();
    });
  }

  // ── status ────────────────────────────────────────────────────────────────
  function statusRow(label, ok, detail) {
    return '<div class="srow"><span class="sdot ' + (ok === null ? 'unk' : ok ? 'ok' : 'bad') + '"></span>'
      + '<span class="slbl">' + esc(label) + '</span><span class="sdet">' + esc(detail) + '</span></div>';
  }
  function paintStatus() {
    var s = state.status;
    var el = $('status');
    if (!s) { el.innerHTML = '<div class="empty-list">loading…</div>'; reportHeight(); return; }
    var c = s.core, p = s.plugins, h = s.hub, k = s.connector;
    var pc = p && p.counts;
    el.innerHTML = '<div class="ptop">MCP status' + btn('status-reload', 'Refresh', 'ghost sm r') + '</div>'
      + statusRow('Core /health', c ? (!c.error && c.status === 'healthy') : null,
          c ? (c.error || ((c.status || '?') + (c.version ? ' · v' + c.version : '') + (c.hostname ? ' · ' + c.hostname : ''))) : '…')
      + statusRow('Plugins', p ? !p.error : null,
          p ? (p.error || (pc ? pc.enabled + ' enabled / ' + pc.total + ' total' + (pc.unhealthy ? ', ' + pc.unhealthy + ' unhealthy' : '') : '…')) : '…')
      + statusRow('Connector', k ? (!k.error && !!k.connected) : null,
          k ? (k.error || ((k.name || 'connector') + ' · ' + (k.connected ? 'connected' : 'disconnected')
            + (k.toolCount != null ? ' · ' + k.toolCount + ' tools' : ''))) : '…')
      + statusRow('Hub', h ? (!h.error && !!h.authenticated) : null,
          h ? (h.error || ((h.authenticated ? 'authenticated' : h.connected ? 'connected (not authed)'
            : h.configured ? 'configured, offline' : 'not configured')
            + (h.hubUrl ? ' · ' + String(h.hubUrl).replace(/^wss?:\/\//, '') : ''))) : '…')
      + '<div class="hint">Four independent probes: /health, /mcp-plugins, /claude-ai/mcp/servers and /hub/status. '
      + 'Each is reported on its own — one failing probe never blanks the others.</div>';
    reportHeight();
  }
  function loadStatus() {
    state.status = { core: null, plugins: null, hub: null, connector: null };
    paintStatus();
    var s = state.status;
    var jobs = [
      api('node', '/health').then(function (r) { s.core = r.ok ? (r.data || {}) : { error: r.error.code + ': ' + r.error.message }; }),
      api('node', '/mcp-plugins').then(function (r) { s.plugins = r.ok ? (r.data || {}) : { error: r.error.code + ': ' + r.error.message }; }),
      api('node', '/hub/status').then(function (r) { s.hub = r.ok ? (r.data || {}) : { error: r.error.code + ': ' + r.error.message }; }),
      api('node', '/claude-ai/mcp/servers').then(function (r) {
        if (!r.ok) { s.connector = { error: r.error.code + ': ' + r.error.message }; return; }
        var servers = (r.data && r.data.servers) || [];
        var lm = null;
        for (var i = 0; i < servers.length; i++) {
          if (/langmart/i.test(servers[i].url || '') || /langmart/i.test(servers[i].name || '')) { lm = servers[i]; break; }
        }
        if (!lm) lm = servers[0];
        s.connector = lm
          ? { name: lm.name, connected: lm.connected, toolCount: lm.toolCount != null ? lm.toolCount : (lm.tools || []).length }
          : { error: 'no connector' };
      }),
    ];
    return Promise.all(jobs).then(paintStatus);
  }

  // ── tabs ──────────────────────────────────────────────────────────────────
  function switchTab(t) {
    state.tab = t;
    clearFatal();                                  // a fatal from one tab must not pin over another
    ['tools', 'plugins', 'status'].forEach(function (n) { $('view-' + n).hidden = n !== t; });
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.classList.toggle('on', b.dataset.tab === t);
    });
    if (t === 'plugins' && !state.plugins) loadPlugins();
    if (t === 'status' && !state.status) loadStatus();
    reportHeight();
  }
  function reloadActive() {
    if (state.tab === 'plugins') return loadPlugins();
    if (state.tab === 'status') return loadStatus();
    return loadList();
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  document.querySelector('.tabs').addEventListener('click', function (e) {
    if (!e.target.dataset || e.target.dataset.tab === undefined) return;
    switchTab(e.target.dataset.tab);
  });
  $('list').addEventListener('click', function (e) {
    var row = e.target.closest ? e.target.closest('.row') : null;
    if (!row || !row.dataset.tname) return;
    openTool(row.dataset.tname);
  });
  $('chips-scope').addEventListener('click', function (e) {
    if (e.target.dataset.fs === undefined) return;
    state.filter.scope = e.target.dataset.fs; paintChips(); paintList();
  });
  $('chips-state').addEventListener('click', function (e) {
    if (e.target.dataset.fst === undefined) return;
    state.filter.st = e.target.dataset.fst; paintChips(); paintList();
  });
  $('cat').addEventListener('change', function (e) { state.filter.cat = e.target.value; paintList(); });
  $('q').addEventListener('input', function (e) { state.filter.q = e.target.value; paintList(); });
  $('btn-reload').addEventListener('click', function () { loadList(); loadPending(); });

  // Editing the override must NOT repaint (that would drop focus mid-keystroke): track
  // the draft and flip only the two buttons' disabled state.
  $('detail').addEventListener('input', function (e) {
    if (e.target.id !== 'ta-override') return;
    state.draft = e.target.value;
    var dirty = state.draft !== state.base;
    var save = document.querySelector('[data-act="save"]'), rev = document.querySelector('[data-act="revert"]');
    if (save) save.disabled = !dirty || state.busy || !state.draft.trim();
    if (rev) rev.disabled = !dirty || state.busy;
  });

  // One delegated handler for every detail action — the nodes are replaced on each
  // paint, so per-node binding would go stale.
  $('detail').addEventListener('click', function (e) {
    var t = e.target;
    if (t.dataset && t.dataset.dtab !== undefined) { state.dtab = t.dataset.dtab; state.armed = null; paintDetail(); return; }
    var act = t.dataset && t.dataset.act;
    if (!act) return;
    var arg = t.dataset.arg;
    if (act === 'arm') { state.armed = arg; paintDetail(); return; }
    state.armed = null;
    if (act === 'reopen') { state.conflict = null; openTool(state.selected); return; }
    if (act === 'revert') { state.draft = state.base; paintDetail(); return; }
    if (act === 'save') { guardedWrite({ descriptionOverride: state.draft }, 'save override'); return; }
    if (act === 'restore') { guardedWrite({ descriptionOverride: null }, 'restore default'); return; }
    // enable/disable skip the rev pre-check on purpose: they are a single boolean, not a
    // text merge, so a concurrent description edit is no reason to refuse them.
    if (act === 'disable') { write('/mcp-tools/' + encodeURIComponent(state.selected), { enabled: false }, 'disable'); return; }
    if (act === 'enable') { write('/mcp-tools/' + encodeURIComponent(state.selected), { enabled: true }, 'enable'); return; }
    if (act === 'rollback') { write('/mcp-tools/' + encodeURIComponent(state.selected) + '/rollback', { toRev: Number(arg) }, 'rollback to rev ' + arg); return; }
    // The gate is a per-tool security setting, not part of the tool doc, so it is its own
    // route and its own in-flight flag — a description save must not block it or vice versa.
    if (act === 'gate') { setGate(state.selected, true); return; }
    if (act === 'ungate') { setGate(state.selected, false); return; }
  });

  // Parked-call decisions. Delegated for the same reason as the detail actions: the strip
  // is re-rendered by a 15s poll, so a per-node binding would go stale within one tick.
  $('pending').addEventListener('click', function (e) {
    var t = e.target;
    var act = t.dataset && t.dataset.pact;
    if (!act) return;
    if (act === 'reload') { loadPending(); return; }
    if (act === 'cancel') { state.pendArmed = null; paintPending(); return; }
    var id = t.dataset.pid || '';
    if (!id) return;
    if (act === 'arm-confirm') { state.pendArmed = 'confirm:' + id; paintPending(); return; }
    if (act === 'arm-deny') { state.pendArmed = 'deny:' + id; paintPending(); return; }
    if (act === 'confirm' || act === 'deny') { resolvePending(id, act); return; }
  });

  $('withheld').addEventListener('click', function (e) {
    if (e.target.id !== 'withheld-toggle') return;
    state.withheldOpen = !state.withheldOpen;
    paintWithheld();
  });

  $('plugins').addEventListener('click', function (e) {
    var act = e.target.dataset && e.target.dataset.act;
    if (act === 'plugins-reload') { loadPlugins(); return; }
    if (act !== 'plug') return;
    var name = e.target.dataset.arg;
    if (state.pluginOpen === name) { state.pluginOpen = null; state.audit = []; paintPlugins(); return; }
    state.pluginOpen = name;
    state.audit = [];
    paintPlugins();
    loadAudit(name);
  });
  $('status').addEventListener('click', function (e) {
    if (e.target.dataset && e.target.dataset.act === 'status-reload') loadStatus();
  });

  // Who is signed in (identity rides the session, not the view token).
  fetch('/auth/me', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
    $('who-name').textContent = (d.claims && (d.claims.name || d.claims.email)) || d.userId || 'signed in';
  }).catch(function () { $('who-name').textContent = 'signed in'; });

  // ── boot ──────────────────────────────────────────────────────────────────
  paintWithheld();      // the ledger is static — paint it before any network call resolves
  paintPending();       // renders the explicit "loading…" state, not an empty strip
  loadList();
  loadPending();
  // Parked calls expire in 10 minutes, so they are polled; the 286-row registry is not
  // (that is what Refresh is for). Re-render on every tick even when the list is unchanged:
  // the rows carry a live "expires in Nm" countdown and an expired row must stop offering
  // a Confirm button that can no longer do anything.
  setInterval(loadPending, 15000);
})();
