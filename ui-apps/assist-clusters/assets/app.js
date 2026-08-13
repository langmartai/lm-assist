/* assist-clusters — the fleet's cluster map as a scoped pane. Plain JS, no build, no deps.
 * Every data call goes through the injected SDK helper (lmui.call), which carries the view
 * token and re-mints it on 401/403.
 *
 * Paths + envelope shapes mirror core/src/routes/core/cluster.routes.ts and the pure
 * resolvers in core/src/cluster/cluster-map.ts (read at build time, then curl-verified
 * against the dev Core on :3200):
 *   GET  /cluster/list      → data = { clusters:[{ name, members:[{gatewayId,online,hostname?}],
 *                                      leader:string|null, description?, status? }], myCluster }
 *                             (a WRAPPER — `clusters` and `myCluster` sit side by side)
 *   POST /cluster/assign    {node,cluster} → 200 on success, else {code:'INVALID_INPUT'|'BAD_NODE'}
 *   POST /cluster/unassign  {node}         → same, cluster forced to 'default'
 *   POST /cluster/describe  {cluster,description,status?} → data = { described:true, cluster }
 *   GET  /hub/machines      → data = { machines:[{gatewayId,hostname,platform,status,
 *                                      lastHeartbeat,connectedAt,systemInfo?}] }
 *
 * 🔴 WHY /hub/machines IS A SECOND SOURCE AND NOT A LUXURY. `/cluster/list` is the union of the
 * synced cluster RECORDS and the currently-ONLINE ids (clustersOverview in cluster-map.ts). A
 * node that is offline AND has no cluster record is in NEITHER set, so it is absent from that
 * response entirely — and a dropdown built from it alone can never name that node, which is
 * exactly the case the page this replaces allowed (its dropdown came from MachineContext, i.e.
 * /hub/machines). Measured on this node: /cluster/list carries 2 members, /hub/machines carries
 * 20, and the 18-node difference is unreachable without this read. The same response is also the
 * only place a member's PLATFORM appears — cluster records carry gatewayId/online/hostname and
 * nothing else, so the per-member platform indicator needs it too. Both restored features are
 * this one GET; when it fails the pane says so instead of looking complete (paintMachNote).
 *
 * The assign/unassign RESPONSE BODY is deliberately ignored: it is {assigned,node,cluster}
 * when the target is this node, but the proxied peer's own nested envelope when it is not.
 * Like the page this replaces, the pane re-reads /cluster/list instead of parsing it.
 *
 * `node` accepts a gatewayId OR a hostname (resolveNodeId in cluster.routes.ts); this pane
 * always sends the gatewayId, which is unambiguous.
 *
 * NOT reachable from here: POST /cluster/self, the loopback-only setter. The local tier
 * proxies from 127.0.0.1, so a blanket node:/cluster grant WOULD reach it — the declared
 * grant therefore names the /cluster routes one by one instead of the /cluster prefix.
 * `/hub/machines` is declared the same way (GET, `exact`), so it is a LEAF: it carries neither
 * the rest of `/hub` (config, api-key, connect/disconnect, login/logout) nor the subtree below
 * itself, where `POST /hub/machines/<id>/proxy-token` mints a credential for another node. */
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

  // ── formatters ────────────────────────────────────────────────────────────
  // Deterministic colour per cluster name, mirroring clusterBadge() in
  // web/src/hooks/useClusters.ts, so a cluster keeps the colour it had on the old page.
  function clusterClass(name) {
    if (!name || name === 'default') return 'cl-default';
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return 'cl' + (h % 8);
  }
  function clusterPill(name) {
    return '<span class="pill cl ' + clusterClass(name) + '">' + esc(name) + '</span>';
  }
  // Mirrors clusterName() in core/src/cluster/cluster-config.ts. The server normalizes the
  // name it stores, so normalize locally too — otherwise a freshly created cluster matches
  // no row when we try to select it after the write. Drift only costs the auto-select.
  function normCluster(raw) {
    var n = String(raw == null ? '' : raw).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    return n || 'default';
  }
  // Mirrors getPlatformEmoji() in web/src/lib/utils.ts — the same three buckets in the same
  // order, so a node keeps the icon it had on the old page. Note `win` must be tested after
  // `darwin`, which contains it.
  function platformEmoji(p) {
    var s = String(p == null ? '' : p).toLowerCase();
    if (s.indexOf('darwin') !== -1 || s.indexOf('mac') !== -1) return '🍎';
    if (s.indexOf('win') !== -1) return '🪟';
    return '🐧';
  }

  // One /hub/machines entry → the four fields this pane uses. The id/platform/online fallbacks
  // mirror mergeHubMachines() in web/src/lib/api-client.ts and fetchAllOnlineIds() in
  // cluster.routes.ts: the hub's machine records are NOT uniformly shaped (camelCase and
  // snake_case both occur, and the id has lived under three names), and a machine whose
  // gatewayId we cannot read is dropped rather than offered as an unassignable blank.
  function normMachine(w) {
    var si = (w && (w.systemInfo || w.system_info)) || {};
    return {
      gatewayId: String((w && (w.gatewayId || w.machineId || w.id)) || ''),
      hostname: (w && (w.hostname || w.name)) || '',
      platform: (w && (w.platform || w.osPlatform)) || si.osPlatform || si.os_platform || '',
      online: String((w && w.status) || '').toLowerCase() === 'online' || (w && w.connected === true),
      lastHeartbeat: (w && w.lastHeartbeat) || '',
    };
  }

  /** The registry entry for a gatewayId, or null when the registry is unavailable/silent. */
  function machineOf(gatewayId) {
    return gatewayId ? (state.machById[gatewayId] || null) : null;
  }

  // A member carries a hostname only when its cluster RECORD did. Fall back to the registry's
  // hostname before the truncated gatewayId — the old page enriched members from the same map.
  function nodeName(mem) {
    if (!mem) return '(unknown node)';
    var mc = machineOf(mem.gatewayId);
    return mem.hostname || (mc && mc.hostname) || String(mem.gatewayId || '').slice(0, 16) || '(unknown node)';
  }
  function onlineCount(c) {
    return (c.members || []).filter(function (m) { return m.online; }).length;
  }

  // ── state ─────────────────────────────────────────────────────────────────
  var state = {
    clusters: [],            // Cluster[] from GET /cluster/list (name, members[], leader, description?, status?)
    myCluster: 'default',    // this node's own cluster, from the same response
    listErr: null,           // {code,message} from the LAST /cluster/list — a hard failure (fatal overlay)
    selectedName: null,      // the SELECTED cluster's name; the object is re-derived on every load
    filter: { q: '', status: '' },   // client-side; status '' = all
    busy: false,             // a write is in flight — every mutating control is disabled

    // ── machine registry (GET /hub/machines) — a SECONDARY source ──────────
    // Its failure must never blank the pane: the cluster map still renders, only the platform
    // indicators and the registry-only half of the node list go away, and paintMachNote() says
    // exactly that. Hence a state machine of its own rather than a shared error path.
    machines: [],            // normMachine[] — every machine the hub has ever registered
    machById: Object.create(null),   // gatewayId → machine. NULL-PROTOTYPE: the keys are
                             // server-supplied strings, and on a plain {} an id of
                             // '__proto__'/'constructor' would read back a truthy inherited
                             // value and be rendered as if it were a machine.
    machState: 'loading',    // 'loading' | 'ok' | 'empty' | 'error'
    machErr: null,           // {code,message} when machState === 'error'

    pickedNode: '',          // the assign dropdown's selection, held OUTSIDE the DOM so a
                             // refresh (which rebuilds every <option>) cannot silently drop it
  };

  function findCluster(name) {
    if (!name) return null;
    for (var i = 0; i < state.clusters.length; i++) if (state.clusters[i].name === name) return state.clusters[i];
    return null;
  }

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
    d.innerHTML = '<div class="fatal-card"><div class="fatal-h">Clusters could not be loaded</div>'
      + '<pre class="fatal-msg"></pre><button class="primary" id="fatal-retry">Retry</button></div>';
    d.querySelector('.fatal-msg').textContent = message;   // textContent — server text is NOT trusted HTML
    document.body.appendChild(d);
    $('fatal-retry').onclick = function () { d.remove(); load(); };
    reportHeight();
  }

  // ── filter chips ──────────────────────────────────────────────────────────
  // Unlike the sibling panes, these values are SERVER data (operator-written cluster meta),
  // not model constants — so every value is escaped into the label AND the data attribute.
  function statusVocab() {
    var seen = [];
    state.clusters.forEach(function (c) { if (c.status && seen.indexOf(c.status) < 0) seen.push(c.status); });
    return seen.sort();
  }
  function paintChips() {
    var vals = statusVocab(), cur = state.filter.status;
    var s = ['<span class="fchip' + (cur ? '' : ' on') + '" data-fs="">all</span>'];
    vals.forEach(function (v) {
      s.push('<span class="fchip' + (cur === v ? ' on' : '') + '" data-fs="' + esc(v) + '">' + esc(v) + '</span>');
    });
    $('chips-status').innerHTML = s.join('');
    $('row-status').style.display = vals.length ? '' : 'none';   // no statuses set anywhere → no chip row
  }

  function passFilter(c) {
    if (state.filter.status && c.status !== state.filter.status) return false;
    var q = state.filter.q.trim().toLowerCase();
    if (!q) return true;
    // nodeName(), not m.hostname — a member whose cluster record carries no hostname is still
    // findable by the one the registry knows, which is the name the row actually displays.
    var hay = (c.name + ' ' + (c.description || '') + ' ' + (c.status || '') + ' '
      + (c.members || []).map(function (m) { return nodeName(m) + ' ' + m.gatewayId; }).join(' ')).toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  // ── list ──────────────────────────────────────────────────────────────────
  function rowHtml(c) {
    var sel = state.selectedName === c.name ? ' sel' : '';
    var mems = c.members || [];
    var names = mems.slice(0, 6).map(function (m) {
      return '<span class="node' + (m.online ? '' : ' off') + '">' + esc(nodeName(m)) + '</span>';
    }).join('');
    if (mems.length > 6) names += '<span class="node more">+' + (mems.length - 6) + ' more</span>';
    return '<div class="row' + sel + '" data-cl="' + esc(c.name) + '">'
      + '<div class="rt">' + clusterPill(c.name)
      + (c.name === state.myCluster ? '<span class="pill mine">this node</span>' : '')
      + (c.status ? '<span class="pill st">' + esc(c.status) + '</span>' : '') + '</div>'
      + '<div class="rmeta"><span class="rcount">' + mems.length + ' node' + (mems.length === 1 ? '' : 's')
      + ' · ' + onlineCount(c) + ' online</span></div>'
      + (c.description ? '<div class="rsub">' + esc(c.description) + '</div>' : '')
      + '<div class="rnodes">' + names + '</div></div>';
  }

  function paintList() {
    var vis = state.clusters.filter(passFilter);
    $('list').innerHTML = vis.length
      ? vis.map(rowHtml).join('')
      : '<div class="empty-list">' + (state.clusters.length
        ? 'No clusters match the current filter.'
        : 'No clusters yet — every node is in the implicit <b>default</b> cluster. Use <b>Assign a node</b> to split the fleet.')
      + '</div>';
    var nodes = 0;
    state.clusters.forEach(function (c) { nodes += (c.members || []).length; });
    $('counts').textContent = 'showing ' + vis.length + ' of ' + state.clusters.length
      + ' cluster' + (state.clusters.length === 1 ? '' : 's') + ' · ' + nodes + ' node' + (nodes === 1 ? '' : 's') + ' fleet-wide';
    reportHeight();
  }

  // ── assignable nodes ──────────────────────────────────────────────────────
  // The UNION of the two sources, keyed by gatewayId:
  //   • the cluster MAP (/cluster/list) — records ∪ currently-online ids, and the only source
  //     that knows which cluster a node is in;
  //   • the machine REGISTRY (/hub/machines) — every machine the hub has ever registered.
  // The registry-only half is the whole point: a node that is offline AND has no cluster record
  // appears there and NOWHERE in the cluster map, so a dropdown built from the map alone cannot
  // name it. The map-only half is kept too — a record can outlive its hub registration — so
  // neither source silently shrinks the list when the other is missing an entry.
  function assignableNodes() {
    var seen = Object.create(null), out = [];    // null-prototype: keys are server-supplied ids
    function push(id, hostname, cluster, online, platform) {
      if (!id || seen[id]) return;
      seen[id] = true;
      out.push({
        gatewayId: id, hostname: hostname || '', cluster: cluster,
        online: !!online, platform: platform || '',
      });
    }
    // Cluster map first: it is the source that carries `cluster`, and first write wins.
    state.clusters.forEach(function (c) {
      (c.members || []).forEach(function (m) {
        var mc = machineOf(m.gatewayId);
        push(m.gatewayId, m.hostname || (mc && mc.hostname), c.name, m.online, mc && mc.platform);
      });
    });
    state.machines.forEach(function (m) { push(m.gatewayId, m.hostname, null, m.online, m.platform); });
    return out.sort(function (a, b) { return nodeLabel(a).localeCompare(nodeLabel(b)); });
  }

  // 🔴 The gatewayId is part of the LABEL, not just the value. This fleet's registry holds 18
  // machines sharing one hostname (successive gateway registrations of the same host), so a
  // hostname-only label — what the old page used, when the offline half was rarely shown —
  // makes 18 options indistinguishable, and picking the wrong one assigns the wrong node.
  function nodeLabel(e) {
    return (e.platform ? platformEmoji(e.platform) + ' ' : '')
      + (e.hostname || '(no hostname)')
      + ' · ' + String(e.gatewayId).slice(0, 12)
      + ' · ' + (e.cluster || 'no cluster record')
      + (e.online ? '' : ' · offline');
  }

  function optHtml(e) {
    var mc = machineOf(e.gatewayId);
    var title = e.gatewayId + (mc && mc.lastHeartbeat ? '\nlast heartbeat: ' + mc.lastHeartbeat : '')
      + (e.platform ? '\nplatform: ' + e.platform : '');
    return '<option value="' + esc(e.gatewayId) + '" title="' + esc(title) + '">' + esc(nodeLabel(e)) + '</option>';
  }

  function paintNodeSelect() {
    var el = $('a-node');
    // LOADING: the registry is still in flight, so the union is not final yet. Say so rather
    // than briefly showing the map-only list, which is the exact under-count being fixed.
    if (state.machState === 'loading') {
      el.innerHTML = '<option value="">loading nodes…</option>';
      el.disabled = true;
      return;
    }
    el.disabled = state.busy;
    var all = assignableNodes();
    // EMPTY: no node from either source. Possible on a node whose cluster record has not
    // published yet and whose hub is unreachable — an empty <select> alone would read as a bug.
    if (!all.length) {
      el.innerHTML = '<option value="">— no nodes known —</option>';
      state.pickedNode = '';
      return;
    }
    var inMap = [], regOnly = [];
    all.forEach(function (e) { (e.cluster ? inMap : regOnly).push(e); });
    var opts = ['<option value="">— pick a node —</option>'];
    // Group labels are model constants, but they are escaped anyway — an unescaped literal is a
    // pattern that survives being edited into a server value later.
    if (inMap.length) {
      opts.push('<optgroup label="' + esc('in the cluster map') + '">' + inMap.map(optHtml).join('') + '</optgroup>');
    }
    if (regOnly.length) {
      opts.push('<optgroup label="' + esc('registry only — no cluster record') + '">'
        + regOnly.map(optHtml).join('') + '</optgroup>');
    }
    el.innerHTML = opts.join('');
    el.value = state.pickedNode || '';
    // The pick may have vanished from the rebuilt list (a node dropped out of both sources);
    // the <select> silently falls back to '' and state must follow, or doAssign would post an
    // id that is no longer on screen.
    state.pickedNode = el.value;
  }

  // ── machine-registry notice ───────────────────────────────────────────────
  // Built with textContent + appendChild, never innerHTML: every branch below interpolates
  // SERVER text (the error message), and this element must stay unable to render markup.
  function paintMachNote() {
    var el = $('mach-note');
    if (state.machState === 'ok') { el.hidden = true; el.className = 'note'; el.textContent = ''; return; }
    el.hidden = false;
    el.className = state.machState === 'loading' ? 'note' : 'note warn';
    el.textContent = '';
    if (state.machState === 'loading') { el.textContent = 'machine registry: loading…'; return; }
    var err = state.machErr || { code: 'ERROR', message: 'no detail reported' };
    var head = document.createElement('span');
    head.textContent = state.machState === 'empty'
      ? 'Machine registry (GET /hub/machines) returned no machines. '
      : 'Machine registry (GET /hub/machines) unavailable — ' + err.code + ': ' + err.message + '. ';
    var tail = document.createElement('span');
    tail.className = 'note-sub';
    tail.textContent = 'Platform indicators are hidden and the node list falls back to the cluster '
      + 'map alone, so a node that is offline AND has no cluster record cannot be selected. '
      + 'Everything else on this page is unaffected.';
    var btn = document.createElement('button');
    btn.className = 'ghost note-btn';
    btn.textContent = 'Retry';
    btn.disabled = state.busy;
    btn.onclick = function () { state.machState = 'loading'; paintMachNote(); paintNodeSelect(); reloadMachines(); };
    el.appendChild(head); el.appendChild(tail); el.appendChild(btn);
  }

  function paintDatalist() {
    $('cluster-names').innerHTML = state.clusters.map(function (c) {
      return '<option value="' + esc(c.name) + '"></option>';
    }).join('');
  }

  // ── loading ───────────────────────────────────────────────────────────────
  // Each fetch* updates STATE ONLY; painting happens once, after both have settled. Painting
  // from inside each fetch would repaint the detail pane mid-edit (it rebuilds the describe
  // inputs) and would show the node dropdown twice — once map-only, once complete.
  function fetchClusters() {
    return api('node', '/cluster/list').then(function (r) {
      if (!r.ok) { state.listErr = r.error; return; }
      state.listErr = null;
      var d = r.data || {};
      state.clusters = Array.isArray(d.clusters) ? d.clusters : [];
      state.myCluster = d.myCluster || 'default';
      // A cluster exists only while it has members: moving the last node out un-lists it.
      if (state.selectedName && !findCluster(state.selectedName)) {
        say('cluster "' + state.selectedName + '" has no members left and is no longer listed');
        state.selectedName = null;
      }
    });
  }

  // Never fatal: a registry failure degrades two features, it does not break the page.
  function fetchMachines() {
    return api('node', '/hub/machines').then(function (r) {
      state.machines = [];
      state.machById = Object.create(null);
      if (!r.ok) { state.machState = 'error'; state.machErr = r.error; return; }
      state.machErr = null;
      var raw = (r.data && r.data.machines) || [];
      (Array.isArray(raw) ? raw : []).forEach(function (w) {
        var m = normMachine(w);
        if (!m.gatewayId || state.machById[m.gatewayId]) return;   // first entry per id wins
        state.machById[m.gatewayId] = m;
        state.machines.push(m);
      });
      state.machState = state.machines.length ? 'ok' : 'empty';
    });
  }

  function paintAll() {
    var mine = $('my-cluster');
    mine.className = 'pill cl ' + clusterClass(state.myCluster);
    mine.textContent = state.myCluster;
    paintMachNote();
    paintChips();
    paintDatalist();
    paintNodeSelect();
    paintList();
    paintDetail();          // last: it calls reportHeight() once the page is final
  }

  /**
   * @param opts.machines false = re-read the cluster map only. A cluster write cannot change
   *   the machine registry, so afterWrite() does not re-fetch it.
   * @param opts.quiet    true = no "loading…" placeholders (a background re-read).
   */
  function load(opts) {
    opts = opts || {};
    var jobs = [fetchClusters()];
    if (opts.machines !== false) { state.machState = 'loading'; jobs.push(fetchMachines()); }
    if (!opts.quiet) { $('list').innerHTML = 'loading…'; paintMachNote(); paintNodeSelect(); }
    return Promise.all(jobs).then(function () {
      // Only the PRIMARY read is fatal — the overlay replaces a page that has no content.
      if (state.listErr) { fatal(state.listErr.code + ': ' + state.listErr.message); return; }
      paintAll();
    });
  }

  /** The notice's Retry: re-read the registry alone, then repaint what depends on it. */
  function reloadMachines() {
    return fetchMachines().then(function () {
      paintMachNote();
      paintNodeSelect();
      paintList();          // hostnames enriched from the registry
      paintDetail();        // platform indicators
    });
  }

  // ── detail ────────────────────────────────────────────────────────────────
  function metaRow(label, value) {
    return value ? '<div><span class="k">' + esc(label) + ':</span> ' + esc(value) + '</div>' : '';
  }

  function memberHtml(c, m) {
    var isLeader = c.leader === m.gatewayId;
    var mc = machineOf(m.gatewayId);
    return '<div class="mem">'
      // Platform indicator — rendered ONLY for a member the registry actually knows. The
      // emoji function has no "unknown" bucket (it falls through to 🐧), so emitting it for
      // an unknown member would state a fact this pane does not have. Same rule as the old
      // page, which rendered the emoji inside `{mc && …}`.
      + (mc ? '<span class="mem-plat" title="' + esc(mc.platform || 'platform not reported') + '">'
        + platformEmoji(mc.platform) + '</span>' : '')
      + '<span class="dotm ' + (m.online ? 'on' : 'off') + '" title="' + (m.online ? 'online' : 'offline') + '"></span>'
      + '<span class="mem-name">' + esc(nodeName(m)) + '</span>'
      + (isLeader ? '<span class="pill lead">leader</span>' : '')
      + '<span class="mem-id">' + esc(m.gatewayId) + '</span>'
      + (c.name === 'default' ? ''
        : '<button class="ghost mem-x" data-un="' + esc(m.gatewayId) + '" title="Move this node back to the default cluster">→ default</button>')
      + '</div>';
  }

  function paintDetail() {
    var c = findCluster(state.selectedName);
    var el = $('detail');
    if (!c) {
      el.className = 'detail empty';
      el.textContent = 'Select a cluster on the left to see its members, leader and description.';
      reportHeight();
      return;
    }
    el.className = 'detail';
    var mems = (c.members || []);
    var leader = null;
    mems.forEach(function (m) { if (m.gatewayId === c.leader) leader = m; });

    el.innerHTML =
      '<h2 class="d-title">' + clusterPill(c.name) + '</h2>'
      + '<div class="d-pills">'
      + '<span class="pill">' + mems.length + ' node' + (mems.length === 1 ? '' : 's') + '</span>'
      + '<span class="pill">' + onlineCount(c) + ' online</span>'
      + (c.status ? '<span class="pill st">' + esc(c.status) + '</span>' : '')
      + (c.name === state.myCluster ? '<span class="pill mine">this node’s cluster</span>' : '')
      + (c.name === 'default' ? '<span class="pill">implicit — unassigned nodes land here</span>' : '')
      + '</div>'
      + (c.description ? '<div class="d-desc">' + esc(c.description) + '</div>' : '')
      + '<div class="d-meta">'
      + metaRow('leader', leader ? nodeName(leader) + ' (' + leader.gatewayId + ')' : (c.leader || 'none — no member is online'))
      + '</div>'
      + '<div class="d-sect"><h3>Members (' + mems.length + ')</h3>'
      + (mems.length ? mems.map(function (m) { return memberHtml(c, m); }).join('') : '<div class="empty-list">No members.</div>')
      + (c.name === 'default' ? '<div class="hint">default is where unassigned nodes live — a node cannot be removed from it, only assigned elsewhere.</div>' : '')
      + '</div>'
      + '<div class="d-sect"><h3>Describe</h3>'
      + '<div class="form-row">'
      + '<label class="fld">description'
      + '<input id="d-desc" type="text" maxlength="300" placeholder="what this cluster is for" value="' + esc(c.description || '') + '"></label>'
      + '<label class="fld">status'
      + '<input id="d-status" type="text" maxlength="60" placeholder="stable / busy / frozen" value="' + esc(c.status || '') + '"></label>'
      + '</div>'
      + '<div class="actions"><button id="d-save" class="primary">Save description</button></div>'
      + '<div class="hint">Annotation only — it never moves a node. An empty status clears it.</div>'
      + '</div>';

    $('d-save').onclick = doDescribe;
    if (state.busy) setBusy(true);            // a write started elsewhere is still in flight
    reportHeight();
  }

  // ── writes ────────────────────────────────────────────────────────────────
  function setBusy(on) {
    state.busy = on;
    ['a-go', 'd-save', 'btn-refresh'].forEach(function (id) { var b = $(id); if (b) b.disabled = on; });
    Array.prototype.forEach.call(document.querySelectorAll('.mem-x, .note-btn'), function (b) { b.disabled = on; });
    // The node picker too: changing the target mid-write would leave the status line naming a
    // node the write was not sent for. Never re-ENABLE it while the registry is still loading.
    var sel = $('a-node');
    if (sel) sel.disabled = on || state.machState === 'loading';
  }

  // A write whose target is a PEER lands on that node; this node's copy of the map converges
  // through the reconcile the route kicks off fire-and-forget, so the first re-read can still
  // show the pre-write map. Read now, then once more after the reconcile window.
  function afterWrite() {
    load({ machines: false, quiet: true });
    setTimeout(function () { load({ machines: false, quiet: true }); }, 1500);
  }

  /**
   * Two-click arm, the same shape as assist-content's confirmThen(): the FIRST click only
   * re-labels the button, the second one fires, and an unattended arm decays after 4 s.
   *
   * A modal confirm() is not an option here — the pane renders inside a cross-origin iframe,
   * where a sandbox without `allow-modals` makes confirm() return false with no dialog, i.e.
   * silently swallows the action.
   *
   * Both writes it guards re-home a node for the WHOLE fleet (placement, leader election and
   * registry sync are cluster-scoped), and the assign dropdown now also lists nodes that exist
   * only in the registry — 18 of them share one hostname on this fleet — so a mis-pick that
   * used to be impossible to express is now one click away.
   */
  function confirmThen(btn, label, run) {
    if (!btn) { run(); return; }
    if (btn.dataset.armed === '1') {
      btn.dataset.armed = '';
      btn.textContent = btn.dataset.idle || btn.textContent;
      btn.classList.remove('danger');
      run();
      return;
    }
    btn.dataset.idle = btn.textContent;
    btn.dataset.armed = '1';
    btn.textContent = label;
    btn.classList.add('danger');
    reportHeight();
    setTimeout(function () {
      if (btn.dataset.armed !== '1') return;
      btn.dataset.armed = '';
      btn.textContent = btn.dataset.idle || btn.textContent;
      btn.classList.remove('danger');
    }, 4000);
  }

  /** Arm (or fire) the assign. Both the button and Enter in the cluster field land here. */
  function armAssign() {
    if (state.busy) return;
    var node = state.pickedNode;
    var typed = $('a-cluster').value.trim();
    // Validate BEFORE arming: a confirm prompt on an incomplete form is noise.
    if (!node || !typed) { say('pick a node and a cluster name', true); return; }
    var e = nodeById(node);
    var who = e ? (e.hostname || node) : node;
    confirmThen($('a-go'), 'Confirm: ' + who + ' → ' + normCluster(typed) + '?', doAssign);
  }

  function nodeById(id) {
    var all = assignableNodes();
    for (var i = 0; i < all.length; i++) if (all[i].gatewayId === id) return all[i];
    return null;
  }

  // The dropdown can now name a node the cluster map has never seen — and for exactly those,
  // resolveNodeId() in cluster.routes.ts answers BAD_NODE, because it resolves against the
  // cluster RECORDS ∪ the currently-ONLINE ids and a registry-only node is in neither. That is
  // the server's verdict, not a bug in the pick, so translate it instead of leaving the operator
  // with a bare "unknown node" for a node the page is visibly listing.
  function whyBadNode(err, node) {
    if (!err || err.code !== 'BAD_NODE') return '';
    var e = nodeById(node);
    if (!e || e.cluster) return '';
    return ' — this node is in the machine registry only: it is offline and has never published'
      + ' a cluster record, so the fleet cannot resolve it. It becomes assignable once it comes'
      + ' back online.';
  }

  function doAssign() {
    if (state.busy) return;
    var node = state.pickedNode;
    var typed = $('a-cluster').value.trim();
    if (!node || !typed) { say('pick a node and a cluster name', true); return; }
    var target = normCluster(typed);
    setBusy(true);
    say('assigning ' + node + ' → ' + target + '…');
    api('node', '/cluster/assign', { method: 'POST', body: { node: node, cluster: typed } }).then(function (r) {
      setBusy(false);
      if (!r.ok) { say('assign failed — ' + r.error.code + ': ' + r.error.message + whyBadNode(r.error, node), true); return; }
      say('assigned ' + node + ' → ' + target);
      state.selectedName = target;              // land on the cluster we just wrote into
      $('a-cluster').value = '';
      afterWrite();
    });
  }

  function doUnassign(node) {
    if (state.busy) return;
    setBusy(true);
    say('moving ' + node + ' → default…');
    api('node', '/cluster/unassign', { method: 'POST', body: { node: node } }).then(function (r) {
      setBusy(false);
      if (!r.ok) { say('unassign failed — ' + r.error.code + ': ' + r.error.message, true); return; }
      say('moved ' + node + ' → default');
      afterWrite();
    });
  }

  function doDescribe() {
    if (state.busy) return;
    var c = findCluster(state.selectedName);
    if (!c) { say('select a cluster first', true); return; }
    var body = { cluster: c.name, description: $('d-desc').value };
    var st = $('d-status').value.trim();
    if (st) body.status = st;                   // omitted = cleared (the route re-puts the record)
    setBusy(true);
    say('saving description for ' + c.name + '…');
    api('node', '/cluster/describe', { method: 'POST', body: body }).then(function (r) {
      setBusy(false);
      if (!r.ok) { say('describe failed — ' + r.error.code + ': ' + r.error.message, true); return; }
      say('described ' + ((r.data && r.data.cluster) || c.name));
      load({ machines: false, quiet: true });
    });
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  $('list').addEventListener('click', function (e) {
    var row = e.target.closest ? e.target.closest('.row') : null;
    if (!row || !row.dataset.cl) return;
    state.selectedName = row.dataset.cl;
    paintList();                                 // re-highlight the selected row
    paintDetail();
  });
  $('detail').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-un]') : null;
    if (!btn || !btn.dataset.un) return;
    var node = btn.dataset.un;
    // One click used to re-home a node fleet-wide with no prompt; now it arms first.
    confirmThen(btn, 'Confirm → default?', function () { doUnassign(node); });
  });
  $('chips-status').addEventListener('click', function (e) {
    if (e.target.dataset.fs === undefined) return;
    state.filter.status = e.target.dataset.fs; paintChips(); paintList();
  });
  $('q').addEventListener('input', function (e) { state.filter.q = e.target.value; paintList(); });
  $('btn-refresh').addEventListener('click', function () { say('refreshing…'); load().then(function () { say('ready'); }); });
  // The pick lives in state, not in the <select> — paintNodeSelect() rebuilds every option.
  $('a-node').addEventListener('change', function (e) { state.pickedNode = e.target.value; });
  $('a-go').addEventListener('click', armAssign);
  $('a-cluster').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); armAssign(); } });

  // Who is signed in (identity rides the session, not the view token).
  fetch('/auth/me', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
    $('who-name').textContent = (d.claims && (d.claims.name || d.claims.email)) || d.userId || 'signed in';
  }).catch(function () { $('who-name').textContent = 'signed in'; });

  // ── boot ──────────────────────────────────────────────────────────────────
  load();
})();
