/* lmui.js — pluggable-UI client helper. Copy this file into your UI's assets/.
 * Provides lmui.call(service, path, opts): fetch with the injected view token,
 * automatic re-mint on 401 (tokens live 15 min), and the gateway's error shapes
 * passed through untouched. No external dependencies (CSP: everything self-hosted). */
(function () {
  'use strict';
  var token = window.__VIEW_TOKEN__;
  var uiId = window.__UI_ID__;              // the bare id you declared — show this to people
  // The globally unique key, <ownerSlug>-<uiId>, and the audience of every view token.
  // Gateway APIs accept either form (a bare id resolves inside your own namespace), so the
  // calls below keep using uiId; uiKey is exposed for pages that compare against aud.
  var uiKey = window.__UI_KEY__ || uiId;

  async function remint() {
    var r = await fetch('/viewtoken/remint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uiId: uiId }),
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

  window.lmui = {
    call: call, remint: remint, requestAccess: requestAccess, approvedGrants: approvedGrants,
    scopes: scopes, releaseAccess: releaseAccess,
    uiId: uiId, uiKey: uiKey, get token() { return token; },
  };
})();
