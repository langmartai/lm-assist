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
    // No statuses set anywhere → no chip row. The `hidden` PROPERTY, not an inline display: the
    // toggle is now uniform across this pane, and `[hidden]{display:none!important}` in app.css
    // makes it beat `.chip-row{display:flex}` — which is exactly what an inline style was working
    // around here.
    $('row-status').hidden = !vals.length;
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
    // 🔴 This total counts the CLUSTER MAP, which is not the fleet. /cluster/list is the union of
    // the synced cluster RECORDS and the currently-ONLINE ids, so a node that is offline AND has
    // no cluster record is in neither — it is absent from every members[] this loop can see. It
    // used to be labelled "fleet-wide": measured on this node that read 2 while the machine
    // registry held 20, i.e. it was wrong by 18 with the correct number visible in the dropdown
    // three lines below it. Name the source instead, and report the registry's own total beside
    // it so the gap is legible rather than being silently resolved in favour of the smaller one.
    var nodesAll = 0, nodesVis = 0;
    state.clusters.forEach(function (c) { nodesAll += (c.members || []).length; });
    vis.forEach(function (c) { nodesVis += (c.members || []).length; });
    // Under a filter the shown clusters carry fewer nodes than the map holds; say both rather
    // than quietly reporting the map total under a heading that reads as "what is on screen".
    var nodeTxt = (nodesVis === nodesAll)
      ? nodesAll + ' node' + (nodesAll === 1 ? '' : 's') + ' in the cluster map'
      : nodesVis + ' of ' + nodesAll + ' nodes in the cluster map';
    $('counts').textContent = 'showing ' + vis.length + ' of ' + state.clusters.length
      + ' cluster' + (state.clusters.length === 1 ? '' : 's') + ' · ' + nodeTxt + ' · ' + registryTotalText();
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

  /**
   * The hint under the dropdown claims where its options come from. That claim is false the
   * moment the registry read fails — the list becomes the cluster map alone — so it is withdrawn
   * rather than left standing as static text next to a shrunken list, and the degraded sentence
   * is stated at the control instead.
   *
   * 🔴 That sentence is NOT carried by the <select>'s selected-option text, which is where it
   * used to live. A <select> renders only as much of that text as the control is wide and cannot
   * wrap it, so the warning was truncated at every width this column ever has: Chrome's own
   * intrinsic width for '— pick a node · cluster map only, registry unavailable —' is 354px and
   * the field is 350px even with .wide, which cost the trailing em-dash and would cost whole
   * words on a narrower viewport. #node-warn is an ordinary wrapping block, so it reflows
   * instead of clipping and stays legible at any width. The control keeps a short flag that fits.
   */
  function paintNodeSrcHint() {
    var ok = $('src-ok'), warn = $('node-warn');
    var degraded = state.machState !== 'ok';
    // #fld-node used to be widened to the full row HERE, only while degraded. That toggle is gone:
    // the field is `class="fld wide"` in the markup unconditionally, because the option labels are
    // long on BOTH paths — measured, the HEALTHY list is the longer one (the registry-only half
    // adds "· no cluster record · offline"), so the state this widened for was the wrong one.
    if (ok) ok.hidden = degraded;
    if (!warn) return;
    // 'loading' is transient and the control already says "loading nodes…" — a warning that
    // appears and vanishes on every refresh trains the operator to ignore this line.
    if (!degraded || state.machState === 'loading') { warn.hidden = true; warn.textContent = ''; return; }
    warn.hidden = false;
    warn.textContent = (state.machState === 'empty'
      ? 'Cluster map only: the hub answered, but its machine registry lists no machines. '
      : 'Cluster map only: the machine registry is unavailable. ')
      + 'A node that is offline AND has no cluster record is missing from this list entirely — '
      + 'it is not the fleet.';
  }

  /**
   * The <select>'s own text, and SHORT by construction: it is the one string on this page that
   * cannot wrap, so it flags the degradation and #node-warn carries the explanation. Measured
   * against Chrome's intrinsic width for this control — 350px on a desktop, and 314px at the
   * narrowest viewport this pane is checked at (380px): '— pick a node · registry unavailable —'
   * needs 258px, '— pick a node · registry empty —' 228px, the widest form here ('— no nodes
   * known · registry unavailable —') 285px — all fit at BOTH widths.
   * 'empty' is a distinct state on purpose: the registry answered, it just had nothing in it,
   * and calling that "unavailable" is a claim the pane cannot support.
   */
  function nodePlaceholder(anyNodes) {
    var head = anyNodes ? '— pick a node' : '— no nodes known';
    if (state.machState === 'ok') return head + ' —';
    if (state.machState === 'empty') return head + ' · registry empty —';
    return head + ' · registry unavailable —';
  }

  /**
   * 🔴 The pick, said in text that CAN wrap.
   *
   * The <select> renders only as much of its selected option as the control is wide, and this
   * control cannot be made wide enough: its widest real label ('🐧 ubuntu-Virtual-Machine (dev) ·
   * gw4-0065715a · no cluster record · offline') needs 469px in Chrome, while the field's ceiling
   * is the list column's content box — 350px on a desktop even with the full row, 314px at a 380px
   * viewport. Half a column (the old layout) was 170px and clipped all 20 node options at EVERY
   * viewport; the full row clears them all between 600px and 1000px (one column, wide pane) and
   * halves the deficit on a desktop, but the tail survives — and this fleet's tail is 18
   * same-hostname machines that differ ONLY in the gatewayId a truncated label eats first, which
   * is exactly "assigned the wrong node".
   *
   * So the control keeps whatever it can show and the full label is echoed here, the same escape
   * hatch #node-warn uses. Echoed on every repaint AND on change, because the option set is
   * rebuilt under the user (load() → paintNodeSelect()) and a stale echo naming a node that is no
   * longer selected is worse than none.
   *
   * textContent, never innerHTML: the label is built from server-supplied hostnames.
   */
  function paintNodePick() {
    var el = $('a-node'), pick = $('node-pick');
    if (!el || !pick) return;
    var opt = el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
    // No pick yet (or the placeholder is selected): the placeholder is short by construction and
    // fits in the control, so echoing it would be noise under an empty field.
    if (!el.value || !opt) { pick.hidden = true; pick.textContent = ''; return; }
    pick.hidden = false;
    pick.textContent = 'picked: ' + opt.textContent;
  }

  function paintNodeSelect() {
    var el = $('a-node');
    paintNodeSrcHint();
    // LOADING: the registry is still in flight, so the union is not final yet. Say so rather
    // than briefly showing the map-only list, which is the exact under-count being fixed.
    if (state.machState === 'loading') {
      el.innerHTML = '<option value="">loading nodes…</option>';
      el.disabled = true;
      paintNodePick();
      return;
    }
    el.disabled = state.busy;
    var all = assignableNodes();
    // EMPTY: no node from either source. Possible on a node whose cluster record has not
    // published yet and whose hub is unreachable — an empty <select> alone would read as a bug.
    if (!all.length) {
      el.innerHTML = '<option value="">' + esc(nodePlaceholder(false)) + '</option>';
      state.pickedNode = '';
      paintNodePick();
      return;
    }
    var inMap = [], regOnly = [];
    all.forEach(function (e) { (e.cluster ? inMap : regOnly).push(e); });
    // The control flags the degradation too — the note at the top of the page can be scrolled
    // off, while this string is inside the control whose contents are incomplete. A FLAG, not
    // the message: see nodePlaceholder() for why the sentence itself cannot live here.
    var opts = ['<option value="">' + esc(nodePlaceholder(true)) + '</option>'];
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
    paintNodePick();     // last: the echo must name what the REBUILT control actually holds
  }

  // ── machine-registry state, said out loud ─────────────────────────────────
  /** The registry half of the counts line — never a number this pane does not actually have. */
  function registryTotalText() {
    if (state.machState === 'loading') return 'machine registry: loading…';
    if (state.machState === 'error') return 'machine registry: unavailable — fleet size unknown';
    if (state.machState === 'empty') return 'machine registry: no machines';
    return 'machine registry: ' + state.machines.length + ' machine' + (state.machines.length === 1 ? '' : 's');
  }

  /**
   * Turn the route's failure into a claim an operator can act on, WITHOUT discarding its text.
   *
   * 🔴 GET /hub/machines answers EVERY hub-side condition the same way: HTTP 400 with a bare
   * STRING error (core/src/routes/core/hub.routes.ts) — 'Hub not configured', 'Not connected to
   * hub', 'Hub returned <status>', or the fetch's own message. None of those is a complaint
   * about the REQUEST, and none can be: this pane hard-codes a parameterless GET, so there is
   * nothing in it to malform. The envelope carries no code either, so api() falls back to
   * synthesizing 'HTTP_400' — and 400 is the one status an operator reads as "the page sent
   * something bad", which sends them looking at the wrong end of the wire.
   *
   * So: lead with the hub, print the status as this route's CATCH-ALL rather than as a verdict,
   * and keep the server's own words verbatim underneath — a lead that replaced them would be a
   * second guess dressed as a diagnosis. The server itself is out of scope (another owner).
   */
  function machFailure() {
    var err = state.machErr || { code: 'ERROR', message: 'no detail reported' };
    var m = String(err.message || '').toLowerCase();
    var code = String(err.code || '');
    var synth = /^HTTP_\d+$/.test(code);   // api() invented it: the envelope carried no code
    var lead, note = '';
    if (m.indexOf('not configured') !== -1) {
      lead = 'This node has no hub configured, so there is no fleet machine registry to reach.';
    } else if (m.indexOf('hub returned') !== -1) {
      // The only branch where the hub DID answer — do not call that unreachable.
      lead = 'The hub was reached but refused the machine registry read.';
    } else if (code === 'NETWORK') {
      // NETWORK is thrown by the browser's own fetch, so the call never left this page. Blaming
      // the hub here would point at a machine that was never contacted.
      lead = 'This page could not reach this node\'s API, so the machine registry read never went out.';
    } else if (code === 'HTTP_400' || /not connected|econnrefused|enotfound|fetch failed|timeout|socket hang up|network/.test(m)) {
      // Everything else the route can answer with — 'Not connected to hub' and the hub fetch's
      // own error, both of which arrive as the catch-all 400 — is the hub being out of reach.
      lead = 'The hub is unreachable from this node, so the fleet machine registry could not be read.';
    } else {
      lead = 'This node failed the machine registry read before it reached the hub.';
    }
    if (code === 'HTTP_400') {
      note = 'The 400 is this route\'s catch-all for every hub-side condition — not a complaint '
        + 'about the request, which is a parameterless GET this page hard-codes.';
    }
    return {
      lead: lead,
      // 'HTTP_400' is api()'s invention; show it as a plain status so it is not mistaken for a
      // code the server chose. A code the server DID send is printed exactly as it sent it.
      raw: 'GET /hub/machines → ' + (synth ? 'HTTP ' + code.slice(5) : code) + ': ' + err.message,
      note: note,
    };
  }

  // Built with textContent + appendChild, never innerHTML: every branch below interpolates
  // SERVER text (the error message), and this element must stay unable to render markup.
  function paintMachNote() {
    var el = $('mach-note');
    if (state.machState === 'ok') { el.hidden = true; el.className = 'note'; el.textContent = ''; return; }
    el.hidden = false;
    el.className = state.machState === 'loading' ? 'note' : 'note warn';
    el.textContent = '';
    if (state.machState === 'loading') { el.textContent = 'machine registry: loading…'; return; }
    var head = document.createElement('span');
    if (state.machState === 'empty') {
      head.textContent = 'The hub answered, but its machine registry lists no machines at all. ';
    } else {
      var f = machFailure();
      head.textContent = f.lead + ' ';
      var raw = document.createElement('span');
      raw.className = 'note-sub note-raw';
      raw.textContent = f.raw;                  // verbatim — the lead above is an interpretation
      head.appendChild(raw);
      // Why a 4xx is on screen at all. Sits under the raw line so the status and its explanation
      // are read together, rather than the status being read alone and misfiled as a bad request.
      if (f.note) {
        var why = document.createElement('span');
        why.className = 'note-sub';
        why.textContent = f.note;
        head.appendChild(why);
      }
    }
    // What this page consequently does NOT know. The node counts are named explicitly: they are
    // the one number on screen that a reader would otherwise take for the fleet's size.
    var tail = document.createElement('span');
    tail.className = 'note-sub';
    tail.textContent = 'While this lasts the fleet size is unknown: the node counts below report '
      + 'the cluster map only. Platform indicators are hidden, and the node list falls back to the '
      + 'cluster map alone, so a node that is offline AND has no cluster record cannot be selected. '
      + 'The cluster map itself is a separate read and is unaffected.';
    var btn = document.createElement('button');
    btn.className = 'ghost note-btn';
    btn.textContent = 'Retry';
    btn.disabled = state.busy;
    btn.onclick = function () { state.machState = 'loading'; paintMachNote(); paintNodeSelect(); paintList(); reloadMachines(); };
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
  $('a-node').addEventListener('change', function (e) { state.pickedNode = e.target.value; paintNodePick(); });
  $('a-go').addEventListener('click', armAssign);
  $('a-cluster').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); armAssign(); } });

  // Who is signed in (identity rides the session, not the view token).
  fetch('/auth/me', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
    $('who-name').textContent = (d.claims && (d.claims.name || d.claims.email)) || d.userId || 'signed in';
  }).catch(function () { $('who-name').textContent = 'signed in'; });

  // ── boot ──────────────────────────────────────────────────────────────────
  load();
})();
