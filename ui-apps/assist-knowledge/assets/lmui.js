/* lmui.js — pluggable-UI client helper. Copy this file into your UI's assets/.
 * Provides lmui.call(service, path, opts): fetch with the injected view token,
 * automatic re-mint on 401 (tokens live 15 min), and the gateway's error shapes
 * passed through untouched; and lmui.goto(uiId, params, opts): navigate to another
 * pane without ever assembling its URL (see the navigation section at the bottom).
 * No external dependencies (CSP: everything self-hosted).
 *
 * 🔴 This file is BYTE-IDENTICAL in every pane and is copied verbatim, never forked.
 * ui-apps/assist-backlog/assets/lmui.js is the canonical copy in this repo, and
 * core/src/__tests__/lmui-shim-identity.test.ts fails the suite if any copy drifts. */
(function () {
  'use strict';
  var token = window.__VIEW_TOKEN__;
  var uiId = window.__UI_ID__;              // the bare id you declared — show this to people
  // The globally unique key, <ownerSlug>-<uiId>, and the audience of every view token.
  // Gateway APIs accept either form (a bare id resolves inside your own namespace), so the
  // calls below keep using uiId; uiKey is exposed for pages that compare against aud.
  var uiKey = window.__UI_KEY__ || uiId;

  async function remint() {
    // `token` is PROOF OF POSSESSION, not authorization: it shows the server this request comes
    // from the document that was handed the token, not merely from a browser whose cookie jar
    // happens to hold this uiId's cookie. On a single-origin serving tier every pane's cookie
    // rides every request, so the cookie alone cannot tell the panes apart. Sent even when
    // expired — the server re-dates the expiry check for this use only. Tiers that don't need
    // it (the hub, one origin per pane) ignore the field.
    var r = await fetch('/viewtoken/remint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uiId: uiId, token: token }),
    });
    if (!r.ok) throw new Error('re-mint failed: HTTP ' + r.status + ' (is your session still alive?)');
    token = (await r.json()).token;
    return token;
  }

  async function call(service, path, opts) {
    opts = opts || {};
    var doFetch = function () {
      return fetch('/data/' + uiId + '/' + service + path, {
        method: opts.method || 'GET',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    };
    var r = await doFetch();
    // 401 = the token expired. 403 = the token's grant does not cover this call — which is
    // ALSO what you get right after new scope access is granted, because the page is still
    // holding the token minted at load time. Re-mint once and retry in both cases; a genuine
    // denial simply 403s again with the same reason.
    if (r.status === 401 || r.status === 403) {
      var before = token;
      await remint();
      if (token !== before) r = await doFetch();
    }
    return r;
  }

  // Request additional scope access at runtime. For your own UI this is simply granted —
  // there is nothing to approve. For a third-party/untrusted UI the response instead carries
  // consentUrl, which the USER must visit; this helper never decides on their behalf.
  async function requestAccess(rules, reason) {
    var r = await fetch('/access/request', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uiId: uiId, rules: rules, reason: reason || '' }),
    });
    if (!r.ok) throw new Error('access request refused: HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
    var d = await r.json(); // { requestId, granted, consentRequired?, consentUrl? }
    // Granted: the scope access is live server-side, so re-mint and the next call carries it.
    if (d.granted) await remint();
    return d;
  }

  // Discovery: what scopes/services exist and what this UI holds vs may still request.
  async function scopes() {
    var r = await fetch('/access/scopes?uiId=' + encodeURIComponent(uiId));
    if (!r.ok) throw new Error('scope list failed: HTTP ' + r.status);
    return r.json();
  }

  // Release ("log off") previously-approved access. Omit service/pathPrefix to drop all.
  async function releaseAccess(service, pathPrefix) {
    var r = await fetch('/access/revoke', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uiId: uiId, service: service, pathPrefix: pathPrefix }),
    });
    if (!r.ok) throw new Error('release failed: HTTP ' + r.status);
    var d = await r.json();
    await remint(); // narrow the live token immediately
    return d;
  }

  // What has this user already approved for this UI?
  async function approvedGrants() {
    var r = await fetch('/access/grants/' + encodeURIComponent(uiId));
    return r.ok ? (await r.json()).approved : [];
  }

  // ── cross-pane navigation ──────────────────────────────────────────────────────────
  // lmui.goto(uiId, params, opts) — go to ANOTHER pane, carrying params, on BOTH tiers.
  //
  // Never build a sibling's URL by hand: the hub gives each pane its own ORIGIN, the local
  // tier serves them all from one origin under /ui/<uiId>/, and both shapes have already
  // changed once. So this emits a ROOT-RELATIVE /go/<uiId> and lets the serving tier
  // construct the destination — and when the pane is EMBEDDED it does not navigate at all,
  // it asks the shell (whose sandbox deliberately withholds allow-top-navigation).
  //
  // Reserved keys and over-cap values THROW here rather than being dropped: this is the one
  // surface where the author is still in a position to fix the call.
  var NAV_RESERVED = { lt: 1, embed: 1, theme: 1, code: 1, token: 1, returnTo: 1 };
  var navPending = null, navTimer = null, navRetry = null;

  function navQuery(params) {
    if (params == null) return '';
    if (typeof params !== 'object' || Object.prototype.toString.call(params) === '[object Array]') {
      throw new Error('lmui.goto: params must be a plain object');
    }
    var keys = Object.keys(params), pairs = [], n = 0, i, j, k, list, v;
    for (i = 0; i < keys.length; i++) {
      k = keys[i];
      if (params[k] === undefined || params[k] === null) continue;
      // Reserved BEFORE the charset check: a '_lm…' key would otherwise be reported as a
      // malformed name, which sends the author looking for a typo instead of a namespace.
      if (NAV_RESERVED[k] === 1 || k.indexOf('_lm') === 0) throw new Error('lmui.goto: "' + k + '" is reserved by the serving tier');
      if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,39}$/.test(k)) throw new Error('lmui.goto: illegal param name "' + k + '"');
      list = Object.prototype.toString.call(params[k]) === '[object Array]' ? params[k] : [params[k]];
      for (j = 0; j < list.length; j++) {
        if (list[j] === null || typeof list[j] === 'object') throw new Error('lmui.goto: "' + k + '" must be a string, number or boolean');
        v = String(list[j]);
        if (v.length > 512) throw new Error('lmui.goto: "' + k + '" exceeds 512 chars');
        // A token in a URL lands in history, Referer and the target's own location.search.
        if (/^(lvt1|let1)\./.test(v)) throw new Error('lmui.goto: refusing to put a token in a URL');
        if (++n > 16) throw new Error('lmui.goto: at most 16 params');
        pairs.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
      }
    }
    var qs = pairs.join('&');
    if (qs.length > 2048) throw new Error('lmui.goto: query too long (' + qs.length + ' > 2048)');
    return qs;
  }

  function gotoPane(targetUiId, params, opts) {
    var id = String(targetUiId || '');
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) throw new Error('lmui.goto: "' + id + '" is not a uiId');
    var qs = navQuery(params);
    // ROOT-relative on purpose: the local tier injects <base href="/ui/<uiId>/">, so a bare
    // 'go/x' would resolve into THIS pane's asset space and 401 as an illegal asset.
    var href = '/go/' + encodeURIComponent(id) + (qs ? '?' + qs : '');
    if (opts && opts.newTab) { window.open(href, '_blank', 'noopener'); return; }
    if (!window.parent || window.parent === window) { window.location.assign(href); return; }

    var shell = window.__SHELL_ORIGIN__ || '';
    // An ID and a query string — never a URL, an origin or a path. A URL in the message
    // would re-create "navigate the top window anywhere" by proxy.
    var msg = { type: 'lmui:navigate', v: 1, uiId: id, params: qs, from: uiId };
    navPending = href;
    try { window.parent.postMessage(msg, shell || '*'); }
    catch (e) { navPending = null; window.open(href, '_blank', 'noopener'); return; }
    // A pinned post is silently dropped when this pane is framed by embedAncestors[1..n]
    // rather than [0] (__SHELL_ORIGIN__ is only ever [0]). Re-post wildcard once before
    // giving up: the message carries only what this pane authored, and the SHELL is the
    // enforcing side.
    if (navRetry) clearTimeout(navRetry);
    if (shell) navRetry = setTimeout(function () {
      if (navPending) { try { window.parent.postMessage(msg, '*'); } catch (e2) { /* gone */ } }
    }, 300);
    if (navTimer) clearTimeout(navTimer);
    navTimer = setTimeout(function () {
      if (!navPending) return;
      navPending = null;
      // An old shell has no listener at all. allow-popups IS granted; top-navigation is not.
      window.open(href, '_blank', 'noopener');
    }, 750);
  }

  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || d.type !== 'lmui:navigate:ack' || !navPending) return;
    var shell = window.__SHELL_ORIGIN__ || '';
    if (shell && e.origin !== shell) return;
    var href = navPending;
    navPending = null;
    if (navTimer) { clearTimeout(navTimer); navTimer = null; }
    if (navRetry) { clearTimeout(navRetry); navRetry = null; }
    // ok:false = the shell heard us and cannot route it. Fall back NOW instead of waiting
    // out the 750ms timeout.
    if (d.ok === false) window.open(href, '_blank', 'noopener');
  });

  window.lmui = {
    call: call, remint: remint, requestAccess: requestAccess, approvedGrants: approvedGrants,
    scopes: scopes, releaseAccess: releaseAccess,
    // `goto` is a future-reserved word in ES3, so the implementation is named gotoPane.
    uiId: uiId, uiKey: uiKey, goto: gotoPane, get token() { return token; },
  };
})();
