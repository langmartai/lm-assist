/* assist-skills — the node's skill inventory + usage analytics as a scoped pane. Plain JS,
 * no build, no deps. Every data call goes through the injected SDK helper (lmui.call), which
 * carries the view token and re-mints it on 401/403. The one declared grant is
 *
 *     node:/skills [GET]        ← READ ONLY, GET only
 *
 * The same prefix also carries POST /skills/reindex and POST /skills/refresh-inventory. This
 * pane never calls them and never asks for POST, so it cannot rebuild the index or rescan the
 * plugin cache — the grant itself is the guarantee, not a code convention.
 *
 * Paths + envelope shapes mirror core/src/routes/core/skills.routes.ts (read at build time and
 * re-verified against the live dev API on :3200):
 *   GET /skills                   → data = { skills:[...], total }  (WRAPPER, not a bare array)
 *   GET /skills/analytics         → data = { top10, byPlugin, overall }.  overall.successRate
 *       is a FRACTION 0..1 (live value 1, meaning 100%) — multiply by 100 for a percentage.
 *   GET /skills/analytics/chains  → data = { chains:[{sequence,occurrences,projects}] }
 *   GET /skills/detail/:skillName → data is FLAT — no {skill} wrapper key. The skill's scalar
 *       fields PLUS its own paginated `sessions` array with totalSessions/limit/offset/hasMore.
 *
 * Two things about the detail route that the shapes alone do not tell you:
 *   1. It answers HTTP 400 {success:false, error:{code:'NOT_FOUND'}} for a skill with NO
 *      recorded invocation, because it is keyed on the USAGE index, not the inventory. 21 of
 *      the 131 installed skills are in that state, so it is a NORMAL outcome, not a failure:
 *      the pane falls back to the inventory row it already holds and says so.
 *   2. It has no `directInvocations` field — only GET /skills does. The direct count shown in
 *      the detail header is therefore taken from the list row this pane already loaded.
 * The skill name carries a colon (superpowers:brainstorming); it is encodeURIComponent'd and
 * the route's greedy (?<skillName>.+) + decodeURIComponent round-trips it (verified live).
 *
 * Session rows are enriched from the session cache ONLY when the cache holds that file, so
 * model / cost / turns / prompts / size / lastMessage / subagents are all OPTIONAL — every one
 * of them was absent for every row on this node at build time. Render them conditionally and
 * never assume they exist.
 *
 * Cross-pane links go through lmui.goto(uiId, params); a pane must never assemble a URL.
 *
 * PINNED CROSS-PANE PARAM VOCABULARY — the entity's singular noun, unqualified, plus the two
 * generic modifiers `tab` and `q`. This pane EMITS only `session` (both the session card and the
 * subagent row target assist-sessions) and READS `skill` / `tab` / `q`. Two rules, learned the
 * expensive way: a name outside the vocabulary is a silently broken button even when today's
 * target happens to tolerate it, and the same entity must never travel under two different names
 * — this file used to send `{session}` from one handler and `{id}` from the next, to the SAME
 * pane. `parent` was dropped with the same edit: the subagent row now emits `{session:<agentId>}`
 * alone, which the target resolves (its /sessions/:id lookup matches an agentId as well as a
 * sessionId), but the caller no longer names the parent, so the breadcrumb it used to enable is
 * gone until the vocabulary gains a word for it. */
(function () {
  'use strict';

  // Usage filter vocabulary — a local constant, not server data.
  var USAGE_CHIPS = [['', 'all'], ['used', 'used'], ['unused', 'never used']];
  var PAGE_SIZE = 20;        // sessions per page in the detail (matches the old web page)
  var FETCH_LIMIT = 200;     // sessions per detail request; `hasMore` drives a Load-more button
  var STORE_KEY = 'lmui:assist-skills:selected';
  // Common chains: the old web page rendered .slice(0,10) and said nothing about the rest, so a
  // reader could not tell a 10-chain node from a 20-chain one. Both numbers are disclosed here.
  var CHAIN_PREVIEW = 10;
  // The API's OWN ceiling — skill-index.ts detectChains() ends in .slice(0, 20). A full 20 rows
  // therefore means "at least 20", never "exactly 20", and the UI says so rather than implying
  // a total the server never promised. (Live on this node: 20 returned, i.e. truncated.)
  var CHAIN_API_MAX = 20;

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

  // ── inbound params — the pinned vocabulary, read ON LOAD ──────────────────
  // A pane that emits a name nobody reads is a broken button; a pane that ignores the name for
  // the entity it displays is the same bug pointed the other way. This pane displays SKILLS, so
  // `skill` is the one it must land on. URLSearchParams (not a regex) because it is the exact
  // inverse of lmui.goto's encodeURIComponent and it decodes '+' as a space the way a hand-typed
  // query means it.
  //   skill=<skillName>       select that skill (wins over the remembered selection)
  //   tab=sessions|timeline   which detail sub-view opens first — validated against the two real
  //                           values, so a typo cannot park state.tab on something unrenderable
  //   q=<text>                prefill for the list's filter box
  var QP = new URLSearchParams(location.search);
  var IN = {
    skill: QP.get('skill') || '',
    tab: (QP.get('tab') === 'timeline' || QP.get('tab') === 'sessions') ? QP.get('tab') : '',
    q: QP.get('q') || '',
  };
  var pendingTab = IN.tab;   // consumed by the FIRST skill opened, then cleared for good

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // Server-supplied counts go through this instead of esc(): a number that is not a number
  // renders as 0 rather than as markup.
  function num(n) { var v = Number(n); return isFinite(v) ? String(v) : '0'; }
  // EVERY count printed next to a word goes through this. "1 skills" is small, but it is the
  // reader's cheapest signal that nobody looked at the number — and this pane had it in the
  // one place a single-skill plugin lands (frontend-design, skillCount 1).
  function plural(n, one, many) { return Number(n) === 1 ? one : (many || (one + 's')); }
  function countOf(n, one, many) { return num(n) + ' ' + plural(n, one, many); }

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
  function agoISO(iso) {
    if (!iso) return '—';
    var t = new Date(iso).getTime();
    var m = Math.floor((Date.now() - t) / 60000);
    // A future timestamp must show its date, not "just now" — hence the m < 0 guard.
    if (!isFinite(m) || m < 0) return String(iso).slice(0, 16).replace('T', ' ');
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    if (m < 1440) return Math.floor(m / 60) + 'h ago';
    if (m < 43200) return Math.floor(m / 1440) + 'd ago';
    return Math.floor(m / 43200) + 'mo ago';
  }
  function fmtBytes(n) {
    var v = Number(n);
    if (!isFinite(v) || v <= 0) return '';
    var u = ['B', 'KB', 'MB', 'GB'], i = Math.floor(Math.log(v) / Math.log(1024));
    if (i < 0) i = 0; if (i >= u.length) i = u.length - 1;
    return parseFloat((v / Math.pow(1024, i)).toFixed(1)) + ' ' + u[i];
  }
  function fmtCost(n) { var v = Number(n); return isFinite(v) ? '$' + v.toFixed(2) : ''; }
  function shortId(id) { return String(id || '').slice(0, 8); }
  function projBase(p) {
    if (!p) return '(unknown project)';
    var parts = String(p).replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || p;
  }
  // Same mapping as the web page's getModelShortName (web/src/lib/utils.ts).
  function modelShort(model) {
    if (!model) return 'claude';
    var m = String(model).toLowerCase();
    if (m.indexOf('opus-4-5') >= 0) return 'Opus 4.5';
    if (m.indexOf('opus-4') >= 0) return 'Opus 4';
    if (m.indexOf('sonnet-4') >= 0) return 'Sonnet 4';
    if (m.indexOf('sonnet-3-5') >= 0 || m.indexOf('sonnet-3.5') >= 0) return 'Sonnet 3.5';
    if (m.indexOf('sonnet') >= 0) return 'Sonnet';
    if (m.indexOf('haiku-3-5') >= 0 || m.indexOf('haiku-3.5') >= 0) return 'Haiku 3.5';
    if (m.indexOf('haiku') >= 0) return 'Haiku';
    if (m.indexOf('opus') >= 0) return 'Opus';
    return String(model).replace(/[-_]\d{8}$/, '').replace(/^claude-/, '');
  }
  function pct(part, whole) { return whole > 0 ? Math.round((part / whole) * 100) + '%' : '—'; }
  // Timeline grouping is LOCAL-time (both the day key and the clock), so a day reads the way
  // the operator lived it. The ISO string is UTC, so slicing it here would be wrong.
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function dayKey(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function dayLabel(key) {
    var d = new Date(key + 'T00:00:00');
    if (isNaN(d.getTime())) return key || 'unknown date';
    var o = { month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
    return d.toLocaleDateString('en-US', o);
  }
  function clockOf(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '--:--' : pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  // ── state ───────────────────────────────────────────────────────────────
  var state = {
    skills: [],                       // inventory rows from GET /skills → data.skills
    filter: { q: IN.q, usage: '' },   // client-side; usage '' = all | 'used' | 'unused'
    collapsed: Object.create(null),   // pluginName → true when that group is collapsed
    selectedName: null,               // skillName of the selected row
    detail: null,                     // FLAT payload of GET /skills/detail/:name
    sessions: [],                     // accumulated detail.sessions (Load more appends)
    hasMore: false,                   // more session records exist beyond what we hold
    detailErr: null,                  // {code,message} when the detail call failed outright
    inventoryOnly: false,             // NOT_FOUND for a never-used skill → show the list row
    missingName: null,                // a wanted skill this node's inventory does not have
    tab: 'sessions',                  // 'sessions' | 'timeline'
    page: 0,                          // sessions-tab page index
    agentsOpen: Object.create(null),  // sessionId → true when its subagent list is expanded
    analytics: null,                  // { top10, byPlugin, overall }
    chains: [],                       // [{sequence,occurrences,projects}]
    chainsAll: false,                 // false = the CHAIN_PREVIEW head; true = every row held
    chainsErr: null,                  // chains failed on its own — NOT the same as "none found"
    chainsLoading: false,             // in flight (boot, or a chains-only retry)
    analyticsErr: null,
  };

  function say(msg, isErr) {
    var out = $('out');                 // rendered inside the detail pane, so it may not exist
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
    d.innerHTML = '<div class="fatal-card"><div class="fatal-h">Skills could not be loaded</div>'
      + '<pre class="fatal-msg"></pre><button class="primary" id="fatal-retry">Retry</button></div>';
    d.querySelector('.fatal-msg').textContent = message;   // textContent — server text is NOT trusted HTML
    document.body.appendChild(d);
    $('fatal-retry').onclick = function () { d.remove(); loadList(); };
    reportHeight();
  }

  function remember(name) {
    try {
      if (name) localStorage.setItem(STORE_KEY, name);
      else localStorage.removeItem(STORE_KEY);
    } catch (e) {}                       // storage can be partitioned away in an embedded frame
  }
  function recall() {
    if (IN.skill) return IN.skill;      // an inbound ?skill= wins over the last local choice
    try { return localStorage.getItem(STORE_KEY); } catch (e) { return null; }
  }
  function rowFor(name) {
    for (var i = 0; i < state.skills.length; i++) {
      if (state.skills[i].skillName === name) return state.skills[i];
    }
    return null;
  }

  // ── filters + list ────────────────────────────────────────────────────────
  function paintChips() {
    $('chips-usage').innerHTML = USAGE_CHIPS.map(function (c) {
      return '<span class="fchip' + (state.filter.usage === c[0] ? ' on' : '') + '" data-fu="' + c[0] + '">' + esc(c[1]) + '</span>';
    }).join('');
  }
  function passFilters(s) {
    var f = state.filter;
    var used = Number(s.totalInvocations) > 0;
    if (f.usage === 'used' && !used) return false;
    if (f.usage === 'unused' && used) return false;
    var q = f.q.trim().toLowerCase();
    if (q) {
      var hay = ((s.skillName || '') + ' ' + (s.shortName || '') + ' ' + (s.pluginName || '')).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  }
  // Group by plugin, groups A→Z, rows keeping the server's invocations-desc order.
  function groupSkills(list) {
    var map = Object.create(null), order = [];
    list.forEach(function (s) {
      var p = s.pluginName || 'unknown';
      if (!map[p]) { map[p] = []; order.push(p); }
      map[p].push(s);
    });
    order.sort(function (a, b) { return a.localeCompare(b); });
    return order.map(function (p) { return { plugin: p, items: map[p] }; });
  }

  function skillRowHtml(s) {
    var sel = state.selectedName === s.skillName ? ' sel' : '';
    var dim = Number(s.totalInvocations) > 0 ? '' : ' unused';
    return '<div class="row' + sel + dim + '" data-sid="' + esc(s.skillName) + '" title="' + esc(s.skillName) + '">'
      + '<span class="rt">' + esc(s.shortName || s.skillName) + '</span>'
      + (Number(s.totalInvocations) > 0 ? '<span class="pill uses">' + num(s.totalInvocations) + '</span>' : '')
      + '<span class="rwhen">' + esc(s.lastUsed ? agoISO(s.lastUsed) : 'never') + '</span>'
      + '</div>';
  }
  function groupHtml(g) {
    var collapsed = !!state.collapsed[g.plugin];
    var uses = 0;
    g.items.forEach(function (s) { uses += Number(s.totalInvocations) || 0; });
    var head = '<div class="grp" data-grp="' + esc(g.plugin) + '">'
      + '<span class="caret">' + (collapsed ? '▸' : '▾') + '</span>'
      + '<span class="grp-name">' + esc(g.plugin) + '</span>'
      + '<span class="grp-n">' + g.items.length + ' · ' + uses + '</span></div>';
    return collapsed ? head : head + g.items.map(skillRowHtml).join('');
  }

  function paintList() {
    var vis = state.skills.filter(passFilters);
    var groups = groupSkills(vis);
    $('list').innerHTML = groups.length
      ? groups.map(groupHtml).join('')
      : '<div class="empty-list">' + (state.skills.length ? 'No skills match the current filter.' : 'No skills found.') + '</div>';
    $('counts').textContent = 'showing ' + vis.length + ' of ' + state.skills.length
      + ' ' + plural(state.skills.length, 'skill')
      + (groups.length ? ' · ' + countOf(groups.length, 'plugin') : '');
    reportHeight();
  }

  function loadList() {
    $('list').innerHTML = 'loading…';
    return api('node', '/skills').then(function (r) {
      if (!r.ok) { fatal(r.error.code + ': ' + r.error.message); return; }
      // data is the WRAPPER { skills, total } — never a bare array.
      state.skills = (r.data && Array.isArray(r.data.skills)) ? r.data.skills : [];
      paintChips();
      paintList();
      // The Overview card reconciles its own population against this list ("114 … of 131
      // listed"), so it must be repainted once the list exists — the two reads race at boot and
      // analytics usually wins. Only repaint something that has already rendered: calling it
      // early would replace "loading…" with "No analytics data."
      if (state.analytics || state.analyticsErr) paintAnalytics();
      var want = state.selectedName || recall();
      if (want && rowFor(want)) openSkill(want);
      else if (want) {
        // The wanted skill is not on this node. NAME it instead of falling back to the generic
        // placeholder — an inbound ?skill= that lands nowhere and says nothing is precisely the
        // silently-broken link this round exists to remove. And only a stale LOCAL memory is
        // cleared: a bad inbound param must not wipe the operator's own remembered selection.
        state.missingName = want;
        if (want !== IN.skill) remember(null);
        state.selectedName = null;
        paintDetail();
      }
      // Bound ?tab= to boot. If the named skill was not in the inventory, openSkill never ran and
      // never consumed it — without this, the operator's NEXT click would open on a tab they
      // never asked for.
      pendingTab = '';
    });
  }

  // ── detail ────────────────────────────────────────────────────────────────
  function openSkill(name) {
    state.selectedName = name;
    state.detail = null; state.sessions = []; state.hasMore = false;
    state.detailErr = null; state.inventoryOnly = false; state.missingName = null;
    // An inbound ?tab= lands the FIRST skill on that sub-view; every later selection opens on
    // Sessions, because the deep link described one arrival, not a preference.
    state.tab = pendingTab || 'sessions'; pendingTab = '';
    state.page = 0; state.agentsOpen = Object.create(null);
    remember(name);
    paintList();                                   // re-highlight the selected row
    $('detail').className = 'detail empty';
    $('detail').textContent = 'loading ' + name + '…';
    return fetchSessions(0, true);
  }

  // One page of the detail. `replace` starts a fresh view; otherwise the rows are appended.
  function fetchSessions(offset, replace) {
    var name = state.selectedName;
    var path = '/skills/detail/' + encodeURIComponent(name)
      + '?limit=' + FETCH_LIMIT + '&offset=' + offset;
    return api('node', path).then(function (r) {
      if (state.selectedName !== name) return;     // a newer selection already superseded this
      if (!r.ok) {
        if (!replace) { say('load more failed — ' + r.error.code + ': ' + r.error.message, true); return; }
        // NOT_FOUND is the normal answer for a skill the usage index has never seen. Fall back
        // to the inventory row we already hold rather than showing the user a red error.
        if (r.error.code === 'NOT_FOUND' && rowFor(name)) { state.inventoryOnly = true; }
        else { state.detailErr = r.error; }
        paintDetail();
        return;
      }
      var d = r.data || {};
      var got = Array.isArray(d.sessions) ? d.sessions : [];
      state.detail = d;                            // FLAT payload — no {skill} wrapper
      state.sessions = replace ? got : state.sessions.concat(got);
      state.hasMore = !!d.hasMore;
      paintDetail();
      if (!replace) say('loaded ' + state.sessions.length + ' of ' + countOf(d.totalSessions, 'session record'));
    });
  }

  function metaRow(label, value) {
    return value ? '<div><span class="k">' + esc(label) + ':</span> ' + esc(value) + '</div>' : '';
  }

  // 🔴 The subagent COUNT and the subagent RECORDS reach this pane by two different routes:
  //   count   — `subagentCount` rides the skill-index session record, so it is ALWAYS present;
  //   records — `subagents[]` is built by the detail route from the SESSION CACHE, and only
  //             when the cache holds that session's .jsonl. It holds none of them on this node,
  //             so the live payload is `subagentCount: 3, subagents: []` on 35 of 140 rows.
  // The old card printed `A:3` from the count and gated the expander on the records, so the
  // badge advertised a list that could not arrive: 8 of the 20 cards on page 1 showed A:n and
  // the `.agents` block was absent from all 20. The count is REAL and stays; what changes is
  // that the disclosure now exists whenever the count is > 0 and, when the records are missing,
  // opens onto a stated reason instead of nothing.
  //
  // Keyed per ROW, not per sessionId: the same session can appear twice in one skill's list
  // (two invocations, different timestamps, DIFFERENT subagent counts — c7e77d65 shows A:1 and
  // A:2), and a sessionId key made one click toggle both.
  function rowKey(s) { return String(s.sessionId || '') + '|' + String(s.timestamp || ''); }

  function sessionCardHtml(s) {
    var agents = Array.isArray(s.subagents) ? s.subagents : [];
    var open = !!state.agentsOpen[rowKey(s)];
    var dot = s.success === true ? ' ok' : (s.success === false ? ' bad' : '');
    var bits = '<span class="sb">' + esc(agoISO(s.timestamp)) + '</span>';
    if (s.model) bits += '<span class="pill model">' + esc(modelShort(s.model)) + '</span>';
    if (Number(s.totalCostUsd) > 0) bits += '<span class="sb mono">' + esc(fmtCost(s.totalCostUsd)) + '</span>';
    if (s.numTurns !== undefined && s.numTurns !== null) bits += '<span class="sb mono">T:' + num(s.numTurns) + '</span>';
    if (Number(s.userPromptCount) > 0) bits += '<span class="sb mono">U:' + num(s.userPromptCount) + '</span>';
    var ac = Number(s.agentCount) || Number(s.subagentCount) || agents.length || 0;
    if (ac > 0) {
      bits += '<span class="sb mono" title="' + esc(countOf(ac, 'subagent') + ' recorded for this session')
        + '">A:' + num(ac) + '</span>';
    }
    if (Number(s.toolUseCount) > 0) bits += '<span class="sb mono">' + num(s.toolUseCount) + ' tools</span>';

    var head = '<div class="s-head"><span class="sdot' + dot + '"></span>'
      + (s.isSubagentSession ? '<span class="pill sub">sub</span>' : '')
      + '<span class="s-proj">' + esc(projBase(s.project)) + '</span>'
      + (s.size ? '<span class="sb mono">' + esc(fmtBytes(s.size)) + '</span>' : '')
      + '<span class="sb mono">' + esc(shortId(s.sessionId)) + '</span>'
      + '<span class="s-open">open ↗</span></div>';

    var card = '<div class="scard' + (ac > 0 && open ? ' with-agents' : '') + '"'
      + ' data-go-session="' + esc(s.sessionId) + '" title="Open this session in the Sessions pane">'
      + head
      + (s.lastMessage ? '<div class="s-msg">' + esc(s.lastMessage) + '</div>' : '')
      + '<div class="s-bits">' + bits + '</div></div>';

    // No count, no badge, no disclosure — nothing to say either way.
    if (!ac) return '<div class="s-wrap">' + card + '</div>';

    var list = '';
    if (open) {
      list = agents.length ? agents.map(function (a) {
        var st = a.status === 'completed' ? ' ok' : (a.status === 'error' ? ' bad' : '');
        // No data-parent: the pinned vocabulary has no word for "the session this agent ran
        // under", so the attribute would only feed a param this pane is not allowed to emit.
        return '<div class="arow" data-go-agent="' + esc(a.agentId) + '"'
          + ' title="' + esc(a.description || a.agentId) + '">'
          + '<span class="pill kind">' + esc(a.type || 'agent') + '</span>'
          + '<span class="atxt">' + esc(a.description || shortId(a.agentId)) + '</span>'
          + (Number(a.totalCostUsd) > 0 ? '<span class="sb mono">' + esc(fmtCost(a.totalCostUsd)) + '</span>' : '')
          + '<span class="sdot' + st + '"></span><span class="s-open">↗</span></div>';
      }).join('')
        // The honest empty state. It names the count we DO have, the reason the records are
        // absent, and where they can be seen — it never pretends the session had no subagents.
        : '<div class="arow-none">' + esc('This node’s session cache holds no record for '
            + (ac === 1 ? 'this subagent' : 'these ' + ac + ' subagents') + ', so there is nothing to list here. '
            + 'The count comes from the skill index; the detail would come from the cached session file. '
            + 'Open the session to see them.') + '</div>';
    }
    // The button says what is behind it BEFORE it is clicked — a disclosure that has to be
    // opened to learn it is empty is the same false promise the badge used to make.
    var label = !agents.length
      ? countOf(ac, 'subagent') + ' · no records on this node'
      : (agents.length < ac
          ? agents.length + ' of ' + countOf(ac, 'subagent')
          : countOf(ac, 'subagent'));
    return '<div class="s-wrap">' + card
      + '<div class="agents' + (open ? ' on' : '') + (agents.length ? '' : ' agents-empty') + '">'
      + '<button class="agents-btn" data-agents="' + esc(rowKey(s)) + '">'
      + (open ? '▾' : '▸') + ' ' + esc(label) + '</button>'
      + list + '</div></div>';
  }

  function sessionsTabHtml() {
    var total = state.sessions.length;
    if (!total) {
      return '<div class="empty-list">No sessions recorded for this skill.</div><div id="out" class="out">ready</div>';
    }
    var pages = Math.ceil(total / PAGE_SIZE);
    if (state.page >= pages) state.page = pages - 1;
    var from = state.page * PAGE_SIZE;
    var rows = state.sessions.slice(from, from + PAGE_SIZE).map(sessionCardHtml).join('');
    var known = Number(state.detail && state.detail.totalSessions) || total;
    var nav = pages > 1
      ? '<div class="pager"><button class="ghost" id="btn-prev"' + (state.page === 0 ? ' disabled' : '') + '>‹ Prev</button>'
        + '<span class="pnum">' + (from + 1) + '–' + Math.min(from + PAGE_SIZE, total) + ' of ' + total + '</span>'
        + '<button class="ghost" id="btn-next"' + (state.page >= pages - 1 ? ' disabled' : '') + '>Next ›</button></div>'
      : '';
    var more = state.hasMore
      ? '<div class="more"><button class="ghost" id="btn-more">Load more</button>'
        + '<span class="hint">holding ' + total + ' of ' + esc(countOf(known, 'session record')) + '</span></div>'
      : '';
    return '<div class="scards">' + rows + '</div>' + nav + more + '<div id="out" class="out">ready</div>';
  }

  function timelineTabHtml() {
    if (!state.sessions.length) return '<div class="empty-list">No usage recorded for this skill.</div>';
    var map = Object.create(null), order = [];
    state.sessions.forEach(function (s) {
      var k = dayKey(s.timestamp) || 'unknown';
      if (!map[k]) { map[k] = []; order.push(k); }
      map[k].push(s);
    });
    order.sort(function (a, b) { return b.localeCompare(a); });     // newest day first
    return order.map(function (k) {
      var items = map[k];
      var rows = items.map(function (s) {
        var dot = s.success === true ? ' ok' : (s.success === false ? ' bad' : '');
        return '<div class="trow" data-go-session="' + esc(s.sessionId) + '" title="' + esc(s.sessionId) + '">'
          + '<span class="sdot' + dot + '"></span>'
          + '<span class="tclock mono">' + esc(clockOf(s.timestamp)) + '</span>'
          + '<span class="tproj">' + esc(projBase(s.project)) + '</span>'
          + (Number(s.toolUseCount) > 0 ? '<span class="sb mono">' + num(s.toolUseCount) + ' tools</span>' : '')
          + (s.isSubagentSession ? '<span class="pill sub">sub</span>' : '')
          + '</div>';
      }).join('');
      return '<div class="tday"><div class="tday-h"><span class="tday-l">' + esc(dayLabel(k)) + '</span>'
        + '<span class="sb">' + esc(countOf(items.length, 'invocation')) + '</span>'
        + '<span class="tline"></span></div>' + rows + '</div>';
    }).join('');
  }

  function paintDetail() {
    var el = $('detail');
    if (!state.selectedName) {
      el.className = 'detail empty';
      // textContent, not innerHTML: missingName is an untrusted inbound query param.
      el.textContent = state.missingName
        ? 'No skill named "' + state.missingName + '" is installed or indexed on this node. '
          + 'Pick one on the left.'
        : 'Select a skill on the left to see its description, usage stats and the sessions that invoked it.';
      reportHeight();
      return;
    }
    el.className = 'detail';

    if (state.detailErr) {
      el.innerHTML = '<h2 class="d-title">' + esc(state.selectedName) + '</h2>'
        + '<div class="d-err"><div class="d-err-h">Could not load this skill</div><pre class="d-err-msg"></pre>'
        + '<button class="primary" id="btn-retry">Retry</button></div>';
      el.querySelector('.d-err-msg').textContent = state.detailErr.code + ': ' + state.detailErr.message;
      $('btn-retry').onclick = function () { openSkill(state.selectedName); };
      reportHeight();
      return;
    }

    var row = rowFor(state.selectedName) || {};
    var d = state.detail || {};
    // Inventory-only view: the usage index has no entry, so everything shown comes from the
    // GET /skills row. Say that plainly instead of pretending the counts are zero-from-data.
    var name = d.shortName || row.shortName || state.selectedName;
    var plugin = d.pluginName || row.pluginName || '';
    // The inventory scan writes the LITERAL string 'unknown' when a plugin manifest declares no
    // version (8 of the 131 skills here — every plugin-dev skill, plus frontend-design), and the
    // pill template prefixed it blindly: "vunknown". Say the words instead of minting a version
    // number that does not exist. An empty string is a different case — a usage-only skill with
    // no inventory record at all — and still renders no pill.
    var version = d.pluginVersion || row.pluginVersion || '';
    var verKnown = !!version && !/^unknown$/i.test(String(version).trim());
    var desc = d.fullDescription || d.description || row.description || '';
    var installPath = d.installPath || row.installPath || '';
    var invocations = Number(state.inventoryOnly ? row.totalInvocations : d.totalInvocations) || 0;
    var ok = Number(state.inventoryOnly ? row.successCount : d.successCount) || 0;
    var bad = Number(state.inventoryOnly ? row.failCount : d.failCount) || 0;
    // The detail route has no directInvocations — only the list row does.
    var direct = row.directInvocations !== undefined ? Number(row.directInvocations) : invocations;
    var totalSessions = state.inventoryOnly ? 0 : (Number(d.totalSessions) || 0);
    var lastUsed = (state.inventoryOnly ? row.lastUsed : d.lastUsed) || row.lastUsed;
    var firstUsed = (state.inventoryOnly ? row.firstUsed : d.firstUsed) || row.firstUsed;

    // 🔴 The success percentage is NOT computed over `invocations` — it is computed over the
    // invocations that recorded an outcome (successCount + failCount). Live: brainstorming is
    // 410 invocations / 401 rated / 0 failures, and the row printed "410 invocations … 100%
    // success" side by side, which reads as a claim about all 410. Print the rate's own
    // denominator whenever it differs, and never colour a "—" red.
    var rated = ok + bad;
    var rateCls = rated === 0 ? '' : (ok / rated >= 0.8 ? 'good' : (ok / rated >= 0.5 ? 'accent' : 'bad'));
    var rateNote = (rated === invocations)
      ? ''
      : '<span class="of">(' + rated + ' of ' + invocations + ' rated)</span>';
    var stats = '<div class="stats">'
      + '<span class="st"><b class="accent">' + invocations + '</b> ' + plural(invocations, 'invocation') + '</span>'
      + '<span class="st"><b>' + totalSessions + '</b> ' + plural(totalSessions, 'session') + '</span>'
      + '<span class="st"><b class="' + rateCls + '">' + esc(pct(ok, rated)) + '</b> success' + rateNote + '</span>'
      + '<span class="st"><b>' + direct + '</b> direct</span>'
      + '</div>';

    var body;
    if (state.inventoryOnly) {
      body = '<div class="note">This skill is installed but has no entry in the usage index '
        + '(<code>GET /skills/detail</code> answers NOT_FOUND), so there is nothing to show beyond '
        + 'its inventory record. It has never been invoked in an indexed session.</div>';
    } else {
      body = '<div class="tabs">'
        + '<button class="tab' + (state.tab === 'sessions' ? ' on' : '') + '" id="tab-sessions">Sessions'
        + '<span class="tab-n">' + totalSessions + '</span></button>'
        + '<button class="tab' + (state.tab === 'timeline' ? ' on' : '') + '" id="tab-timeline">Usage timeline</button>'
        + '</div>'
        + (state.tab === 'sessions' ? sessionsTabHtml() : timelineTabHtml());
    }

    el.innerHTML =
      '<h2 class="d-title">' + esc(name) + '</h2>'
      + '<div class="d-idrow"><span class="d-id">' + esc(state.selectedName) + '</span></div>'
      + '<div class="d-pills">'
      + (plugin ? '<span class="pill kind">' + esc(plugin) + '</span>' : '')
      + (verKnown
          ? '<span class="pill ver" title="plugin version">v' + esc(version) + '</span>'
          : (version
              ? '<span class="pill ver" title="the plugin manifest declares no version for this skill">version unknown</span>'
              : ''))
      + (state.inventoryOnly ? '<span class="pill sub">no usage recorded</span>' : '')
      + '</div>'
      + (desc ? '<pre class="d-desc">' + esc(desc) + '</pre>' : '')
      + stats
      + '<div class="d-meta">'
      + metaRow('first used', firstUsed ? agoISO(firstUsed) + ' (' + String(firstUsed).slice(0, 10) + ')' : 'never')
      + metaRow('last used', lastUsed ? agoISO(lastUsed) + ' (' + String(lastUsed).slice(0, 10) + ')' : 'never')
      + metaRow(plural(bad, 'failure'), bad ? String(bad) : '')
      + metaRow('install path', installPath)
      + '</div>'
      + body;

    if (!state.inventoryOnly) {
      $('tab-sessions').onclick = function () { state.tab = 'sessions'; paintDetail(); };
      $('tab-timeline').onclick = function () { state.tab = 'timeline'; paintDetail(); };
      if ($('btn-prev')) $('btn-prev').onclick = function () { if (state.page > 0) { state.page--; paintDetail(); } };
      if ($('btn-next')) $('btn-next').onclick = function () { state.page++; paintDetail(); };
      if ($('btn-more')) $('btn-more').onclick = function () {
        $('btn-more').disabled = true;
        say('loading more session records…');
        fetchSessions(state.sessions.length, false);
      };
    }
    reportHeight();
  }

  // ── analytics ─────────────────────────────────────────────────────────────
  var BAR_CLASS = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'];

  function paintAnalytics() {
    var el = $('analytics');
    if (state.analyticsErr) {
      el.innerHTML = '<div class="a-sect"><h3>Analytics</h3><div class="d-err"><pre class="d-err-msg"></pre>'
        + '<button class="ghost" id="btn-an-retry">Retry</button></div></div>';
      el.querySelector('.d-err-msg').textContent = state.analyticsErr.code + ': ' + state.analyticsErr.message;
      $('btn-an-retry').onclick = loadAnalytics;
      reportHeight();
      return;
    }
    var a = state.analytics;
    if (!a) { el.innerHTML = '<div class="empty-list">No analytics data.</div>'; reportHeight(); return; }

    var o = a.overall || {};
    // 🔴 Every number in this column counts the USAGE INDEX, and the list beside it counts the
    // INVENTORY — two different populations that were printed as if they were one. Live: the
    // list footer says "131 skills" while this card said "Total skills 114"; and "Invocations
    // 2039" sat next to "Success rate 100%", a rate whose denominator is 1890. Each card now
    // names its own population, so no two numbers on screen claim a relationship they lack.
    var totalInv = Number(o.totalInvocations) || 0;
    var ratedAll = (Number(o.successCount) || 0) + (Number(o.failCount) || 0);
    var rate = totalInv > 0 ? Math.round((Number(o.successRate) || 0) * 100) + '%' : '—';
    var listed = state.skills.length;   // 0 until GET /skills lands; then this repaints
    var cards = '<div class="cards">'
      + '<div class="card"><div class="c-l">Skills with usage</div><div class="c-v">' + num(o.totalSkills) + '</div>'
      + (listed ? '<div class="c-sub">of ' + listed + ' listed</div>' : '') + '</div>'
      + '<div class="card"><div class="c-l">Invocations</div><div class="c-v accent">' + num(totalInv) + '</div></div>'
      + '<div class="card"><div class="c-l">Success rate</div><div class="c-v good">' + esc(rate) + '</div>'
      + (ratedAll === totalInv ? '' : '<div class="c-sub">' + ratedAll + ' of ' + totalInv + ' rated</div>') + '</div>'
      + '<div class="card"><div class="c-l">Failed</div><div class="c-v' + (Number(o.failCount) > 0 ? ' bad' : '') + '">' + num(o.failCount) + '</div></div>'
      + '</div>';

    var top = Array.isArray(a.top10) ? a.top10 : [];
    var max = 1;
    top.forEach(function (s) { if (Number(s.totalInvocations) > max) max = Number(s.totalInvocations); });
    var bars = top.length
      ? top.map(function (s, i) {
          var w = Math.max(2, Math.round((Number(s.totalInvocations) || 0) / max * 100));
          return '<div class="bar-row" data-sid="' + esc(s.skillName) + '" title="' + esc(s.skillName) + '">'
            + '<span class="bar-l">' + esc(s.shortName || s.skillName) + '</span>'
            + '<span class="bar-t"><span class="bar ' + BAR_CLASS[i % BAR_CLASS.length] + '" style="width:' + w + '%"></span></span>'
            + '<span class="bar-n mono">' + num(s.totalInvocations) + '</span></div>';
        }).join('')
      : '<div class="empty-list">No skill usage data.</div>';

    var byPlugin = Array.isArray(a.byPlugin) ? a.byPlugin.slice() : [];
    byPlugin.sort(function (x, y) { return (Number(y.totalInvocations) || 0) - (Number(x.totalInvocations) || 0); });
    var plugins = byPlugin.length
      ? byPlugin.map(function (p) {
          // "1 skills" lived here — frontend-design is the single-skill plugin that exposed it.
          // The count is also usage-scoped (superpowers: 13 here, 15 in the list), which the
          // section heading states rather than leaving the two numbers to argue.
          return '<div class="prow" title="' + esc(countOf(p.skillCount, 'skill') + ' of this plugin '
              + plural(p.skillCount, 'has', 'have') + ' recorded usage · '
              + countOf(p.totalInvocations, 'invocation')) + '">'
            + '<span class="pname">' + esc(p.pluginName) + '</span>'
            + '<span class="sb mono">' + esc(countOf(p.skillCount, 'skill')) + '</span>'
            + '<span class="pn mono">' + num(p.totalInvocations) + '</span></div>';
        }).join('')
      : '<div class="empty-list">No plugin data.</div>';

    // ── common chains: three distinct states, and the cap stated out loud ──
    // "No repeated skill chains detected" is a CLAIM about the node. It must never be what a
    // failed request looks like, so the error state is separate from the empty one.
    var all = state.chains;
    var showAll = state.chainsAll || all.length <= CHAIN_PREVIEW;
    var shown = showAll ? all : all.slice(0, CHAIN_PREVIEW);
    var capped = shown.length < all.length;
    // A full page from the API means the server truncated too: say "20+", not "20".
    var chainCount = all.length
      ? '<span class="sect-n">' + (capped ? shown.length + ' of ' + all.length : String(all.length))
        + (all.length >= CHAIN_API_MAX ? '+' : '') + '</span>'
      : '';
    var chainBody;
    if (state.chainsLoading) {
      chainBody = '<div class="empty-list">loading…</div>';
    } else if (state.chainsErr) {
      chainBody = '<div class="d-err"><div class="d-err-h">Chains could not be loaded</div>'
        + '<pre class="d-err-msg" id="chains-err-msg"></pre>'
        + '<button class="ghost" data-chains-retry="1">Retry</button></div>';
    } else if (!all.length) {
      chainBody = '<div class="empty-list">No repeated skill chains detected.</div>';
    } else {
      chainBody = shown.map(function (c) {
        var seq = (Array.isArray(c.sequence) ? c.sequence : []).map(function (n, j) {
          return (j > 0 ? '<span class="arrow">→</span>' : '') + '<span class="pill kind">' + esc(n) + '</span>';
        }).join('');
        return '<div class="chain">' + seq + '<span class="pill uses">x' + num(c.occurrences) + '</span></div>';
      }).join('');
      if (all.length > CHAIN_PREVIEW) {
        chainBody += '<div class="more"><button class="ghost" data-chains-all="1">'
          + (showAll ? 'Show top ' + CHAIN_PREVIEW : 'Show all ' + all.length) + '</button>'
          + '<span class="hint">showing ' + shown.length + ' of ' + esc(countOf(all.length, 'chain')) + ' held'
          + (all.length >= CHAIN_API_MAX ? ' — the API returns at most ' + CHAIN_API_MAX : '')
          + '</span></div>';
      } else if (all.length >= CHAIN_API_MAX) {
        chainBody += '<div class="more"><span class="hint">the API returns at most '
          + CHAIN_API_MAX + ' chains</span></div>';
      }
    }

    el.innerHTML = '<div class="a-sect"><h3>Overview<span class="sect-note">usage index</span></h3>' + cards + '</div>'
      + '<div class="a-sect"><h3>Top skills<span class="sect-note">by invocations</span></h3>' + bars + '</div>'
      + '<div class="a-sect"><h3>By plugin<span class="sect-note">skills with usage</span></h3>' + plugins + '</div>'
      + '<div class="a-sect"><h3>Common chains' + chainCount + '</h3>' + chainBody + '</div>';
    // Server text goes in as TEXT, never as markup — same rule as every other error surface here.
    if (state.chainsErr && $('chains-err-msg')) {
      $('chains-err-msg').textContent = state.chainsErr.code + ': ' + state.chainsErr.message;
    }
    reportHeight();
  }

  // A chains response → state. A failure is REMEMBERED rather than flattened into an empty
  // array: `chains = []` renders as "no chains detected", which would report a transport
  // failure as a fact about this node.
  function applyChains(r) {
    if (r.ok) {
      state.chains = (r.data && Array.isArray(r.data.chains)) ? r.data.chains : [];
      state.chainsErr = null;
    } else {
      state.chains = [];
      state.chainsErr = r.error;
    }
    state.chainsLoading = false;
  }

  function loadAnalytics() {
    $('analytics').innerHTML = 'loading…';
    state.analyticsErr = null;
    state.chainsErr = null;
    state.chainsLoading = true;
    // Two independent reads: a chains failure must not blank the overview, so they are
    // resolved separately and each owns its own error state.
    return Promise.all([
      api('node', '/skills/analytics'),
      api('node', '/skills/analytics/chains'),
    ]).then(function (rs) {
      if (rs[0].ok) { state.analytics = rs[0].data || null; }
      else { state.analytics = null; state.analyticsErr = rs[0].error; }
      applyChains(rs[1]);
      paintAnalytics();
    });
  }

  // Retry JUST the chains read — an overview that already loaded is not thrown away for it.
  function loadChains() {
    state.chainsErr = null;
    state.chainsLoading = true;
    paintAnalytics();
    return api('node', '/skills/analytics/chains').then(function (r) {
      applyChains(r);
      paintAnalytics();
    });
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  $('list').addEventListener('click', function (e) {
    var t = e.target;
    var grp = t.closest ? t.closest('.grp') : null;
    if (grp && grp.dataset.grp) {
      var p = grp.dataset.grp;
      if (state.collapsed[p]) delete state.collapsed[p]; else state.collapsed[p] = true;
      paintList();
      return;
    }
    var row = t.closest ? t.closest('.row') : null;
    if (!row || !row.dataset.sid) return;
    openSkill(row.dataset.sid);
  });
  $('chips-usage').addEventListener('click', function (e) {
    if (e.target.dataset.fu === undefined) return;
    state.filter.usage = e.target.dataset.fu; paintChips(); paintList();
  });
  $('q').addEventListener('input', function (e) { state.filter.q = e.target.value; paintList(); });

  // The detail pane's repeated rows are delegated (the singleton buttons are bound in
  // paintDetail). Cross-pane navigation goes through lmui.goto — never a hand-built URL.
  $('detail').addEventListener('click', function (e) {
    var t = e.target;
    var btn = t.closest ? t.closest('.agents-btn') : null;
    if (btn && btn.dataset.agents) {
      var sid = btn.dataset.agents;
      if (state.agentsOpen[sid]) delete state.agentsOpen[sid]; else state.agentsOpen[sid] = true;
      paintDetail();
      return;
    }
    // Both rows open a session record in the SAME pane, so both emit the SAME pinned name.
    // A subagent's agentId is a session identifier there (its /sessions/:id lookup matches an
    // agentId as well as a sessionId), so `session` is the honest word for it — not a second
    // name for the same thing.
    var arow = t.closest ? t.closest('[data-go-agent]') : null;
    if (arow) { lmui.goto('assist-sessions', { session: arow.dataset.goAgent }); return; }
    var srow = t.closest ? t.closest('[data-go-session]') : null;
    if (srow) lmui.goto('assist-sessions', { session: srow.dataset.goSession });
  });
  // Analytics is re-rendered wholesale, so its controls are delegated rather than re-bound.
  // A bar in the Top-skills chart selects that skill, the same as clicking its list row.
  $('analytics').addEventListener('click', function (e) {
    var t = e.target;
    if (t.closest && t.closest('[data-chains-all]')) { state.chainsAll = !state.chainsAll; paintAnalytics(); return; }
    if (t.closest && t.closest('[data-chains-retry]')) { loadChains(); return; }
    var bar = t.closest ? t.closest('.bar-row') : null;
    if (!bar || !bar.dataset.sid) return;
    openSkill(bar.dataset.sid);
  });

  // Who is signed in (identity rides the session, not the view token).
  fetch('/auth/me', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
    $('who-name').textContent = (d.claims && (d.claims.name || d.claims.email)) || d.userId || 'signed in';
  }).catch(function () { $('who-name').textContent = 'signed in'; });

  // ── boot ────────────────────────────────────────────────────────────────
  // An inbound ?q= has to reach the INPUT too, not just state.filter — a filtered list whose
  // box looks empty reads as a broken list, and there is no way to clear what you cannot see.
  if (IN.q) $('q').value = IN.q;
  state.selectedName = recall();
  loadList();
  loadAnalytics();
})();
