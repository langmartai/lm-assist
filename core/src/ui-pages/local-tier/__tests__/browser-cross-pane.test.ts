/**
 * Cross-pane isolation, measured in a REAL browser against the REAL tier.
 *
 * 🔴 Why this file exists: a raw-HTTP PoC cannot observe a browser-enforced fix, and this fix is
 * ENTIRELY browser-enforced. `server.test.ts` proves the tier puts each pane on its own port and
 * refuses foreign ids; only a browser proves that a hostile pane consequently CANNOT read a
 * sibling's `__VIEW_TOKEN__`. The two are not the same claim, and the gap between them is where
 * a "fix" that only satisfies a test lives. Raw HTTP has no same-origin policy — it will happily
 * follow a cross-origin redirect and read the body — so a green raw-HTTP run proves nothing here.
 *
 * It models a compromised pane the honest way: the attacker's script runs INSIDE the attacker
 * pane's own document (page.evaluate is the attacker's XSS), the owner has legitimately opened
 * BOTH panes so the jar carries both cookies, the popup blocker is off — a hostile pane can
 * render a button and wait for the one click that buys it a user gesture — and the attacker is
 * TOLD the victim's origin outright, so nothing rests on a port being hard to guess.
 *
 * Six vectors. All are expected CLOSED, and every one of them is closed by the same mechanism:
 * the victim is a DIFFERENT ORIGIN (different port), which the browser enforces on every
 * transport, with no dependence on request headers.
 *   V1  <iframe src=".../ui/victim/">        read the token             → CLOSED
 *   V2  <iframe src="/go/victim">            plant cookie, then read    → CLOSED (plant is inert)
 *   V3  window.open('/go/victim')            read the opened document   → CLOSED
 *   V4  fetch /viewtoken/remint              launder cookie → token     → CLOSED
 *   V5  fetch the sibling DOCUMENT           scrape the injected token  → CLOSED
 *   V6  spend a token on the victim's origin cross-origin /data call    → CLOSED
 *
 * 🔴 V5 and V3 are the two that a Sec-Fetch-Dest gate could never close on the transport this
 * product ships (`http://<LAN-IP>`: no Fetch Metadata at all, so 'absent' on a scripted fetch is
 * indistinguishable from 'absent' on a real navigation). They are why the shared origin had to
 * go. If any of them ever reads OPEN again, panes are sharing an origin — check that first.
 *
 * Run it on BOTH transports; the trustworthy/non-trustworthy difference is invisible on loopback:
 *   LM_LOCAL_TIER_BROWSER_HOST=127.0.0.1  node --test dist-test/.../browser-cross-pane.test.js
 *   LM_LOCAL_TIER_BROWSER_HOST=10.0.1.117 node --test dist-test/.../browser-cross-pane.test.js
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import puppeteer from 'puppeteer-core';
import type { Browser } from 'puppeteer-core';
import { resolveChromePath } from '../../../voice/voice-v2-capability';

// HOME must be redirected BEFORE token.ts / manager.ts read os.homedir() (both read it lazily).
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-browser-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const VICTIM = 'victim-pane';   // broad grant: GET+POST /sessions
const ATTACK = 'evil-pane';     // narrow grant: GET /health only
const API_TOKEN = 'browser-api-token';
/** The host the BROWSER dials. Loopback is a secure context; a LAN IP is not — run both. */
const HOST = process.env.LM_LOCAL_TIER_BROWSER_HOST || '127.0.0.1';

const CHROME_PATH = resolveChromePath();
const skip = !CHROME_PATH ? 'no system Chrome resolved — this environment cannot run the browser e2e' : false;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const listen = (s: http.Server): Promise<number> =>
  new Promise((r) => s.listen(0, '0.0.0.0', () => r((s.address() as AddressInfo).port)));

interface Finding { name: string; outcome: string }

let lmui: http.Server, core: http.Server, meta: http.Server, browser: Browser | null = null;
let stopTier: (() => void) | undefined;
let tierPort = 0, victimPort = 0, attackPort = 0, metaPort = 0;
let findings: Finding[] = [];
const tierLog: string[] = [];
/** Sec-Fetch-* seen by a server on THIS transport, from a request the page itself made. */
let metaSeen: string | null = null;
let coldCookieNames: string[] = [];
let coldPlantedRead = '';
/** Does the browser send Sec-Fetch-* to this origin? False over plain http to a LAN IP. */
let fetchMetadata = false;
let legitGoLanded = '';
let legitGoHasToken = false;

/**
 * The hostile pane's script, as a STRING evaluated inside the attacker document's own realm —
 * so everything it reaches is exactly what an XSS in a pane reaches. A string rather than a
 * typed function on purpose: core compiles without the DOM lib, and widening `lib` for the whole
 * backend to type-check an attacker payload would be a far bigger change than this file.
 *
 * `victimOrigin` is handed over deliberately: an attacker that has to guess a port is a weaker
 * attacker than the one we must survive. Everything below is measured against the strong one.
 */
function attackScript(victim: string, victimOrigin: string, metaOrigin: string): string {
  const V = JSON.stringify(victim);
  const VO = JSON.stringify(victimOrigin);
  const MO = JSON.stringify(metaOrigin);
  return `(async () => {
  const R = [];
  const rep = (name, outcome) => R.push({ name, outcome });
  const readFrame = (f, name) => {
    try {
      const t = f.contentWindow && f.contentWindow.__VIEW_TOKEN__;
      rep(name, t === undefined ? 'BLOCKED:no-token-visible' : 'READ:' + t);
    } catch (e) { rep(name, 'BLOCKED:' + e.name); }
  };
  const frameProbe = (src, name) => new Promise((done) => {
    const f = document.createElement('iframe');
    f.src = src;
    let settled = false;
    const finish = () => { if (settled) return; settled = true; readFrame(f, name); done(); };
    f.onload = finish;
    f.onerror = () => { if (!settled) { settled = true; rep(name, 'BLOCKED:onerror'); done(); } };
    document.body.appendChild(f);
    setTimeout(finish, 1500);
  });
  // Does this transport even give the browser a Fetch Metadata header to send? Measured against
  // a server that RECORDS what arrived, not inferred from a gate's behaviour.
  try { await fetch(${MO} + '/probe', { mode: 'no-cors' }); } catch (e) { /* opaque either way */ }

  // V1 — silent iframe read of the victim document (the jar already holds its cookie).
  await frameProbe(${VO} + '/ui/' + ${V} + '/', 'V1 iframe victim document -> read __VIEW_TOKEN__');

  // V2 — silent iframe through /go, which ALSO plants the victim's 8h cookie.
  await frameProbe('/go/' + ${V}, 'V2 iframe /go/<victim> -> read __VIEW_TOKEN__');

  // V4 — no DOM read at all: launder the ambient cookie into a bearer token. Both the origin
  // this script can read (its own) and the one that holds the answer (the victim's).
  const remints = [
    ['V4a remint {uiId:victim} on MY origin', '/viewtoken/remint', JSON.stringify({ uiId: ${V} })],
    ['V4b remint + attacker OWN token as proof', '/viewtoken/remint', JSON.stringify({ uiId: ${V}, token: window.__VIEW_TOKEN__ })],
    ['V4c remint on the VICTIM origin (cross-origin)', ${VO} + '/viewtoken/remint', JSON.stringify({ uiId: ${V} })],
  ];
  for (const [label, url, body] of remints) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, credentials: 'include' });
      const j = await r.json().catch(() => ({}));
      rep(label, r.status === 200 && j.token ? 'READ:' + j.token : 'BLOCKED:HTTP' + r.status);
    } catch (e) { rep(label, 'BLOCKED:' + e.name); }
  }

  // V5 — the vector a Sec-Fetch-Dest gate cannot close where no Sec-Fetch-Dest is sent: a plain
  // same-origin-looking fetch of the sibling's DOCUMENT, whose body carries the injected token.
  // Three shapes: through my own origin's redirect, straight at the victim origin with cookies,
  // and no-cors (which is delivered but must come back opaque).
  const reads = [
    ['V5a fetch /ui/victim/ via MY origin (follows the 302)', '/ui/' + ${V} + '/', { credentials: 'include' }],
    ['V5b fetch the victim document cross-origin', ${VO} + '/ui/' + ${V} + '/', { credentials: 'include' }],
    ['V5c fetch the victim document no-cors', ${VO} + '/ui/' + ${V} + '/', { credentials: 'include', mode: 'no-cors' }],
  ];
  for (const [label, url, init] of reads) {
    try {
      const r = await fetch(url, init);
      const text = await r.text().catch(() => '');
      const m = /__VIEW_TOKEN__=\\"([^\\"]+)\\"/.exec(text);
      rep(label, m ? 'READ:' + m[1] : 'BLOCKED:HTTP' + r.status + (r.type ? '/' + r.type : '') + ':' + text.length + 'B');
    } catch (e) { rep(label, 'BLOCKED:' + e.name); }
  }

  // V3 — one user gesture's worth of popup. POLL: a fixed timeout races the navigation and
  // manufactures a fake 'undefined', which reads as a fix that is not there.
  await new Promise((done) => {
    let popup = null;
    const NAME = 'V3 window.open(/go/<victim>) -> read __VIEW_TOKEN__';
    try { popup = window.open('/go/' + ${V}, 'vic'); }
    catch (e) { rep(NAME, 'BLOCKED:' + e.name); return done(); }
    if (!popup) { rep(NAME, 'BLOCKED:popup-null'); return done(); }
    let tries = 0;
    const poll = setInterval(() => {
      tries++;
      let out = null;
      try {
        const v = popup.__VIEW_TOKEN__;
        if (v !== undefined) out = 'READ:' + v;
        else if (tries >= 100) {
          // 🔴 Never report a bare INCONCLUSIVE. "The popup showed no token" is indistinguishable
          // between 'the opener was severed' (a fix) and 'it had not navigated yet' (a slow
          // transport) — and reading it as the former is how a residual gets recorded as closed.
          // A CROSS-origin popup makes href unreadable, which is itself the evidence — SAY WHICH.
          let where = '?', state = '?';
          try { where = String(popup.location.href); } catch (e) { where = 'unreadable:' + e.name; }
          try { state = String(popup.document.readyState); } catch (e) { state = 'unreadable:' + e.name; }
          out = 'INCONCLUSIVE:no-token-after-10s href=' + where + ' readyState=' + state;
        }
      } catch (e) { out = 'BLOCKED:' + e.name; }
      if (out) { clearInterval(poll); rep(NAME, out); done(); }
    }, 100);
  });

  // Spend whatever was stolen on the VICTIM's data plane — a token nobody can spend is not a
  // finding, and a token that spends is the whole point.
  const stolen = R.find((x) => x.outcome.indexOf('READ:') === 0 && x.outcome !== 'READ:undefined');
  if (stolen) {
    const tk = stolen.outcome.slice(5);
    const dr = await fetch(${VO} + '/data/node/sessions', { headers: { authorization: 'Bearer ' + tk } });
    rep('SPEND stolen token on the victim-only data plane', dr.status === 200 ? 'ESCALATED' : 'refused:HTTP' + dr.status);
  } else {
    rep('SPEND stolen token on the victim-only data plane', 'n/a (nothing stolen)');
  }

  // V6 — even WITH a token, the victim's data plane is a cross-origin call. An Authorization
  // header is not CORS-safelisted, so this preflights and nothing answers OPTIONS.
  try {
    const r = await fetch(${VO} + '/data/node/sessions', { headers: { authorization: 'Bearer ' + window.__VIEW_TOKEN__ } });
    rep('V6 cross-origin /data call on the victim origin', 'REACHED:HTTP' + r.status);
  } catch (e) { rep('V6 cross-origin /data call on the victim origin', 'BLOCKED:' + e.name); }

  // CONTROL — the attacker's OWN token still cannot reach the victim's routes on its OWN origin.
  // If this ever reads ESCALATED the grant check itself broke and every row above is noise.
  const own = await fetch('/data/node/sessions', { headers: { authorization: 'Bearer ' + window.__VIEW_TOKEN__ } });
  rep('CONTROL attacker OWN token on victim-only /sessions', own.status === 200 ? 'ESCALATED' : 'refused:HTTP' + own.status);
  return R;
})()`;
}

/**
 * The cold-jar probe: a framed /go still PLANTS the victim's cookie (the 302 carries Set-Cookie
 * before any document refuses to be framed). Under one origin per pane that plant is inert, and
 * "inert" is a claim that has to be measured too — so the probe then TRIES to use it.
 */
function coldPlantScript(victim: string, victimOrigin: string): string {
  const V = JSON.stringify(victim);
  const VO = JSON.stringify(victimOrigin);
  return `(async () => {
  await new Promise((done) => {
    const f = document.createElement('iframe');
    f.src = '/go/' + ${V};
    f.onload = () => done(true);
    document.body.appendChild(f);
    setTimeout(() => done(true), 1500);
  });
  try {
    const r = await fetch(${VO} + '/ui/' + ${V} + '/', { credentials: 'include' });
    const t = await r.text();
    return /__VIEW_TOKEN__/.test(t) ? 'READ:token-visible' : 'BLOCKED:HTTP' + r.status;
  } catch (e) { return 'BLOCKED:' + e.name; }
})()`;
}

before(async () => {
  if (skip) return;
  const SERVED = [VICTIM, ATTACK];
  lmui = http.createServer((rq, rs) => {
    if (SERVED.some((id) => rq.url === `/ui-${id}/index.html`)) {
      rs.writeHead(200, { 'content-type': 'text/html' });
      rs.end('<!doctype html><html><head><title>pane</title></head><body>pane</body></html>');
    } else { rs.writeHead(404); rs.end('nope'); }
  });
  core = http.createServer((rq, rs) => {
    rs.writeHead(200, { 'content-type': 'application/json' });
    rs.end(JSON.stringify({ ok: true, url: rq.url, secret: 'victim-only-data' }));
  });
  // A server OUTSIDE the tier whose only job is to record what the browser sent it. This is how
  // "does this transport carry Fetch Metadata" is measured rather than inferred from a gate.
  meta = http.createServer((rq, rs) => {
    if ((rq.url || '').startsWith('/probe')) metaSeen = (rq.headers['sec-fetch-dest'] as string) || null;
    rs.writeHead(204); rs.end();
  });
  const lmuiPort = await listen(lmui);
  const corePort = await listen(core);
  metaPort = await listen(meta);

  const mk = (id: string, grant: unknown): void => {
    const dir = path.join(tmpHome, 'apps', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'lmui.config.json'), JSON.stringify({ uiId: id, service: `ui-${id}`, grant }));
    fs.mkdirSync(path.join(tmpHome, '.lmui'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.lmui', `dev-${id}.json`), JSON.stringify({
      uiId: id, service: `ui-${id}`, pid: process.pid, port: lmuiPort, dir,
      sdkPath: '', log: '', startedAt: new Date().toISOString(),
    }));
  };
  mk(VICTIM, [{ service: 'node', pathPrefix: '/sessions', verbs: ['GET', 'POST'] }]);
  mk(ATTACK, [{ service: 'node', pathPrefix: '/health', verbs: ['GET'] }]);

  const probe = http.createServer();
  const freePort = await listen(probe);
  await new Promise<void>((r) => probe.close(() => r()));

  const tier = require('../server');
  // Keep the tier's own log: when a vector reads CLOSED, this is the evidence for WHICH gate
  // closed it. Without it a browser-side "no token" is an unattributed observation.
  stopTier = tier.startLocalUiTier({
    localUiPort: freePort, uiWebPort: lmuiPort, apiPort: corePort, getApiToken: () => API_TOKEN,
    log: (m: string) => { tierLog.push(m); },
  });
  tierPort = freePort;
  for (let i = 0; i < 200 && !tier.isLocalTierRunning(); i++) await delay(10);
  assert.ok(tier.isLocalTierRunning(), 'tier failed to start listening');

  const { mintEntryToken } = require('../token');
  // The ONE URL the product hands out: the dispatcher's. The browser follows its 302 to the
  // pane's own origin — the extra hop is exactly what a viewer experiences.
  const entry = (id: string): string => `http://${HOST}:${tierPort}/ui/${id}/?lt=${mintEntryToken(id)}`;

  browser = await puppeteer.launch({
    executablePath: CHROME_PATH as string,
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      // Models the ONE user gesture a hostile pane can obtain by rendering a button.
      '--disable-popup-blocking',
    ],
  });

  // ── Scenario A: the ordinary precondition — the owner has opened BOTH panes, so ONE jar
  // carries both cookies (cookies ignore port, so one host-wide jar covers both origins).
  // Anything the attacker can still do here is a real capability, not an artefact.
  const page = await browser.newPage();
  await page.goto(entry(VICTIM), { waitUntil: 'load' });
  const victimLanded = page.url();
  await page.goto(entry(ATTACK), { waitUntil: 'load' });
  const attackLanded = page.url();
  victimPort = tier.panePortFor(VICTIM);
  attackPort = tier.panePortFor(ATTACK);
  assert.ok(victimPort > 0 && attackPort > 0 && victimPort !== attackPort,
    `precondition: separate origins (victim ${victimPort}, attacker ${attackPort})`);
  assert.ok(victimLanded.startsWith(`http://${HOST}:${victimPort}/`), `victim landed on its own origin (${victimLanded})`);
  assert.ok(attackLanded.startsWith(`http://${HOST}:${attackPort}/`), `attacker landed on its own origin (${attackLanded})`);
  const cookieNames = (await page.cookies()).map((c) => c.name).sort();
  assert.deepEqual(cookieNames, [`lm_ui_${ATTACK}`, `lm_ui_${VICTIM}`], `precondition: both cookies in the jar (got ${cookieNames.join(',')})`);

  const victimOrigin = `http://${HOST}:${victimPort}`;
  findings = await page.evaluate(attackScript(VICTIM, victimOrigin, `http://${HOST}:${metaPort}`)) as Finding[];
  // 🔴 Which REGIME are we in? Fetch Metadata (`Sec-Fetch-*`) is sent only to POTENTIALLY
  // TRUSTWORTHY origins — https and loopback. Over plain http to a LAN IP Chrome sends NOTHING.
  // Measured on a recording server, so the answer does not depend on any gate in the tier.
  fetchMetadata = metaSeen !== null;

  // What a LEGITIMATE cross-pane navigation does on this transport — a REAL top-level
  // navigation, the same channel lmui.goto uses (location.assign). This is the control that
  // stops a dead feature from being scored as a closed vector.
  await page.goto(`http://${HOST}:${tierPort}/go/${VICTIM}?tab=logs&id=7`, { waitUntil: 'load' });
  legitGoLanded = page.url();
  legitGoHasToken = await page.evaluate('typeof window.__VIEW_TOKEN__ !== "undefined"') as boolean;
  await page.close();

  // ── Scenario B: a COLD jar (only the attacker pane opened). A framed /go DOES still plant the
  // victim's 8h cookie — the half of the attack a framing header cannot stop. What has changed
  // is that the plant buys nothing, so the probe goes on to try to use it.
  const cold = await browser.createBrowserContext();
  const coldPage = await cold.newPage();
  await coldPage.goto(entry(ATTACK), { waitUntil: 'load' });
  coldPlantedRead = await coldPage.evaluate(coldPlantScript(VICTIM, victimOrigin)) as string;
  coldCookieNames = (await coldPage.cookies()).map((c) => c.name).sort();
  await cold.close();
});

after(async () => {
  try { await browser?.close(); } catch { /* ignore */ }
  try { stopTier?.(); } catch { /* ignore */ }
  if (lmui) await new Promise<void>((r) => lmui.close(() => r()));
  if (core) await new Promise<void>((r) => core.close(() => r()));
  if (meta) await new Promise<void>((r) => meta.close(() => r()));
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** The measurement is worthless if the page wedged and reported nothing. */
function outcome(prefix: string): string {
  const f = findings.find((x) => x.name.startsWith(prefix));
  assert.ok(f, `the attacker page did not report "${prefix}" — findings: ${JSON.stringify(findings)}`);
  return f.outcome;
}

test('the hostile pane ran and reported (a silent run is indistinguishable from a fix)', { skip }, () => {
  console.log(`\n  Chrome via http://${HOST}:${tierPort} — real local tier, real panes`);
  console.log(`  pane origins: ${VICTIM}=${victimPort}  ${ATTACK}=${attackPort}  (dispatcher ${tierPort})`);
  console.log(`  Fetch Metadata (Sec-Fetch-*) sent to this origin: ${fetchMetadata} (recorded sec-fetch-dest=${metaSeen ?? 'absent'})`);
  console.log(`  legitimate top-level /go landed on: ${legitGoLanded} (token injected: ${legitGoHasToken})\n`);
  for (const f of findings) console.log(`  ${f.outcome.startsWith('READ:') || f.outcome === 'ESCALATED' ? 'OPEN  ' : 'CLOSED'}  ${f.name}\n          -> ${f.outcome.slice(0, 110)}`);
  console.log(`\n  cold jar after a framed /go: ${coldCookieNames.join(',') || 'nothing'} — read with it: ${coldPlantedRead}`);
  console.log('\n  tier log (only >=400 responses are logged, plus every cookie mint):');
  for (const l of tierLog) console.log(`    ${l}`);
  console.log('');
  assert.ok(findings.length >= 10, `expected every vector to report, got ${findings.length}`);
});

test('LEGITIMATE cross-pane navigation WORKS on this transport (a dead feature is not a fix)', { skip }, () => {
  // 🔴 The control that must come first. The previous guard refused /go whenever Sec-Fetch-Dest
  // was absent, which over plain http to a LAN IP is ALWAYS — so on the transport
  // `POST /ui-pages/<uiId>/local-url` actually mints, every vector below read "closed" only
  // because the feature was 403. This asserts the feature is alive in WHICHEVER regime this run
  // is in, before anything claims a vector is shut.
  assert.ok(legitGoLanded.startsWith(`http://${HOST}:${victimPort}/ui/${VICTIM}/`),
    `/go must land on the victim's own origin here; landed ${legitGoLanded}`);
  assert.ok(legitGoLanded.includes('tab=logs') && legitGoLanded.includes('id=7'), 'deep-link params survive the hop');
  assert.equal(legitGoHasToken, true, 'and the landing document carries its token');
});

test('every pane is its own ORIGIN — the mechanism the rest of this file measures', { skip }, () => {
  assert.notEqual(victimPort, attackPort);
  assert.notEqual(victimPort, tierPort);
  assert.notEqual(attackPort, tierPort);
});

test('V5 CLOSED: a scripted fetch of the sibling document cannot read the token', { skip }, () => {
  // 🔴 The escalation this design exists to close, and the one no request-header gate could:
  // over plain http to a LAN IP the browser sends no Sec-Fetch-* on a scripted fetch OR a
  // navigation, so 'absent' meant "serve it". Measured then: 200 + __VIEW_TOKEN__ in the body,
  // spent on the victim's /sessions. Now the read is cross-origin in all three shapes.
  assert.match(outcome('V5a'), /^BLOCKED:/, 'a redirect into another origin is still another origin');
  assert.match(outcome('V5b'), /^BLOCKED:/, 'a direct cross-origin read is refused by CORS');
  assert.match(outcome('V5c'), /^BLOCKED:/, 'and a no-cors read comes back opaque');
});

test('V1 CLOSED: an iframe of the victim document yields no token', { skip }, () => {
  assert.match(outcome('V1'), /^BLOCKED:/);
});

test('V2 CLOSED: a framed /go yields no token, and the cookie it plants is inert', { skip }, () => {
  assert.match(outcome('V2'), /^BLOCKED:/);
  // The plant still happens — the 302's Set-Cookie lands before any document refuses to be
  // framed, and cookies ignore port so it is jar-wide. That is fine ONLY because it cannot be
  // cashed: the cold jar holds the victim cookie and still cannot read the victim document.
  assert.deepEqual(coldCookieNames, [`lm_ui_${ATTACK}`, `lm_ui_${VICTIM}`],
    `a framed /go does plant the cookie (cold jar held: ${coldCookieNames.join(',') || 'nothing'})`);
  assert.match(coldPlantedRead, /^BLOCKED:/, 'and the planted cookie buys no read of the victim document');
});

test('V3 CLOSED: window.open cannot read the document it opened (the old residual, retired)', { skip }, () => {
  // 🔴 This assertion used to be INVERTED — V3 was pinned OPEN, because on a shared origin a
  // popup is a real top-level navigation and a same-origin opener can always read it. Per-pane
  // origins are exactly the fix that note named: the popup is now CROSS-origin, so the opener
  // gets a SecurityError instead of a token. If this ever reads READ: again, panes are sharing
  // an origin — that is the first thing to check, not this test.
  const v3 = outcome('V3');
  assert.doesNotMatch(v3, /^READ:/, `V3 must not yield a token; got ${v3}`);
  assert.doesNotMatch(v3, /^INCONCLUSIVE/, `V3 must be conclusive; got ${v3}`);
  assert.match(v3, /^BLOCKED:/);
});

test('V4 CLOSED: remint refuses a foreign uiId, on my origin and on the victim\'s', { skip }, () => {
  assert.match(outcome('V4a'), /^BLOCKED:HTTP401/, 'my own origin only remints me');
  assert.match(outcome('V4b'), /^BLOCKED:HTTP401/, 'and my own token is not proof for a sibling');
  assert.match(outcome('V4c'), /^BLOCKED:/, 'the victim origin is a cross-origin call I cannot read');
});

test('V6 CLOSED: a cross-origin /data call is never even delivered (Authorization preflights)', { skip }, () => {
  assert.match(outcome('V6'), /^BLOCKED:/);
});

test('nothing was stolen, so nothing spends', { skip }, () => {
  assert.equal(outcome('SPEND'), 'n/a (nothing stolen)');
});

test('every vector is closed by a mechanism that does NOT depend on Fetch Metadata', { skip }, () => {
  // 🔴 The load-bearing check. Sec-Fetch-Dest gates are inert over plain http to a LAN IP —
  // measured above on a recording server, not assumed — so the fix must not rest on them. It
  // doesn't: it rests on the ORIGIN, which a browser enforces identically in both regimes. This
  // asserts every vector holds in WHICHEVER regime this run is in, INCLUDING the one where the
  // header does not exist, and asserts the feature is alive there too.
  for (const v of ['V1', 'V2', 'V3', 'V4a', 'V4b', 'V4c', 'V5a', 'V5b', 'V5c', 'V6']) {
    assert.match(outcome(v), /^BLOCKED:/, `${v} must be closed in the ${fetchMetadata ? 'metadata' : 'NO-metadata'} regime`);
  }
  assert.equal(legitGoHasToken, true, 'and legitimate navigation still works in this regime');
});

test('CONTROL: the grant check itself still works (without it, every row above is noise)', { skip }, () => {
  assert.match(outcome('CONTROL'), /^refused:HTTP403/);
});
