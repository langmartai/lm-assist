#!/usr/bin/env node
/**
 * check-token-leak — the browser-auth regression gate (count-only, prints NO secret).
 *
 * The web UI used to inline the Core ring token into every server-rendered page, and a
 * web route handed the LAN access key to anyone who spoofed a Host header. This probe
 * reads the ring token(s) and the LAN key into memory ONLY, fetches every surface that
 * once leaked them, and reports how many times each secret appears — never the value.
 * Run it against a running build (and against a packed build before any publish):
 *
 *   node core/scripts/check-token-leak.js --web http://<LAN-IP>:3948 [--core http://<LAN-IP>:3200] [--data-dir <dir>]
 *
 * For an https base served by this machine's self-signed terminator, pass `--ca <cert.pem>`
 * (the terminator's cert under <dataDir>/tls[-dev]/) to pin it; TLS verification stays on.
 *
 * Probes (each prints `PASS|FAIL <label> status=<n> ring=<count> lan=<count>`):
 *   web   /sessions, /lan-blocked, a random 404, /sessions as an RSC flight request, and
 *         every /_next/static script the /sessions HTML references   → ring=0 lan=0
 *   web   /api/auth/token (plain, Host: localhost, x-relay-source: hub) → 404 (route removed)
 *   web   /_coreapi/auth/browser-token                               → not 200 (proxied = not local)
 *   core  /ttyd-proxy/9224/json/version                              → 401 (no open proxy)
 *   core  /auth/browser-token with Host: rebind.invalid              → not 200 (DNS rebinding)
 *   core  preflight from https://evil.invalid to /agent/execute     → no Access-Control-Allow-Origin
 *
 * Exit 1 on any FAIL. Plain Node, no dependencies. Run it from a LAN address (not
 * localhost) so the local-peer rules are exercised the way a LAN device sees them.
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(name + '='));
  return eq ? eq.slice(name.length + 1) : undefined;
}

const WEB = (arg('--web') || '').replace(/\/+$/, '');
const CORE = (arg('--core') || '').replace(/\/+$/, '');
const DATA_DIR = arg('--data-dir') || process.env.LM_ASSIST_DATA_DIR || path.join(os.homedir(), '.lm-assist');
const CA_FILE = arg('--ca');
const CA = CA_FILE ? fs.readFileSync(CA_FILE, 'utf8') : undefined;

if (!WEB) {
  console.error('usage: check-token-leak.js --web <base> [--core <base>] [--data-dir <dir>] [--ca <cert.pem>]');
  process.exit(2);
}

// ---- secrets: memory only, never printed ----------------------------------------
function readSecrets() {
  const ring = [];
  try {
    const t = fs.readFileSync(path.join(DATA_DIR, 'api-token'), 'utf8').trim();
    if (t) ring.push(t);
  } catch { /* no token file */ }
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'api-token.meta.json'), 'utf8'));
    for (const e of meta.previous || []) {
      const t = typeof e === 'string' ? e : e && e.token;
      if (typeof t === 'string' && t.length >= 16) ring.push(t);
    }
  } catch { /* no meta */ }
  let lan = null;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'assist-config.json'), 'utf8'));
    if (typeof cfg.lanAccessToken === 'string' && cfg.lanAccessToken.length >= 16) lan = cfg.lanAccessToken;
  } catch { /* no config */ }
  return { ring, lan };
}
const SECRETS = readSecrets();

function count(body, needle) {
  if (!needle || !body) return 0;
  let n = 0;
  let i = body.indexOf(needle);
  while (i >= 0) { n++; i = body.indexOf(needle, i + needle.length); }
  return n;
}
function ringCount(body) {
  return SECRETS.ring.reduce((sum, t) => sum + count(body, t), 0);
}
function lanCount(body) {
  return SECRETS.lan ? count(body, SECRETS.lan) : 0;
}

// ---- http ------------------------------------------------------------------------
function request(base, p, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(base + p); } catch (e) { resolve({ status: 0, headers: {}, body: '', error: e.message }); return; }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname.replace(/^\[|\]$/g, ''),
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers,
      agent: false,
      // Verification stays ON; a self-signed terminator is pinned with --ca.
      ...(CA ? { ca: CA } : {}),
      timeout: 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (e) => resolve({ status: res.statusCode || 0, headers: res.headers, body: '', error: e.message }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, headers: {}, body: '', error: e.message }));
    req.end();
  });
}

let failed = 0;
function report(ok, label, r) {
  if (!ok) failed++;
  const extra = r.error ? ` error=${JSON.stringify(r.error)}` : '';
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label} status=${r.status} ring=${ringCount(r.body)} lan=${lanCount(r.body)}${extra}`);
}
const clean = (r) => r.status > 0 && ringCount(r.body) === 0 && lanCount(r.body) === 0;

async function main() {
  console.log(`[check-token-leak] data dir ${DATA_DIR}: ring tokens loaded=${SECRETS.ring.length}, LAN key loaded=${SECRETS.lan ? 'yes' : 'no'}`);
  if (SECRETS.ring.length === 0) console.log('[check-token-leak] WARNING: no ring token found — the ring counts below prove nothing');

  // -- web: nothing server-rendered carries a secret --
  const sessions = await request(WEB, '/sessions');
  report(clean(sessions), 'web /sessions', sessions);
  const blocked = await request(WEB, '/lan-blocked');
  report(clean(blocked), 'web /lan-blocked', blocked);
  const rnd = `/no-such-page-${crypto.randomBytes(6).toString('hex')}`;
  const nf = await request(WEB, rnd);
  report(clean(nf), 'web random-404', nf);
  const rsc = await request(WEB, '/sessions', { headers: { RSC: '1' } });
  report(clean(rsc), 'web /sessions (RSC flight)', rsc);

  const scripts = new Set();
  const re = /<script[^>]+src="([^"]*\/_next\/static\/[^"]+)"/g;
  let m;
  while ((m = re.exec(sessions.body)) && scripts.size < 300) scripts.add(m[1]);
  for (const src of scripts) {
    let p = src;
    try { const u = new URL(src, WEB + '/'); p = u.pathname + u.search; } catch { /* keep as-is */ }
    const r = await request(WEB, p);
    report(clean(r), `web script ${p.split('?')[0]}`, r);
  }
  if (scripts.size === 0) console.log('[check-token-leak] note: /sessions referenced no /_next/static scripts');

  // -- web: the LAN-key leak route is gone, however it is asked --
  for (const [label, headers] of [
    ['plain', {}],
    ['Host: localhost', { Host: 'localhost' }],
    ['x-relay-source: hub', { 'x-relay-source': 'hub' }],
  ]) {
    const r = await request(WEB, '/api/auth/token', { headers });
    report(r.status === 404 && clean(r), `web /api/auth/token (${label}) → 404`, r);
  }

  // -- web: the /_coreapi rewrite is a proxy hop, so it is never "local" --
  const viaProxy = await request(WEB, '/_coreapi/auth/browser-token', { headers: { 'X-LM-Client': 'web' } });
  report(viaProxy.status !== 200 && viaProxy.status !== 0 && clean(viaProxy), 'web /_coreapi/auth/browser-token → not 200', viaProxy);

  if (CORE) {
    const ttyd = await request(CORE, '/ttyd-proxy/9224/json/version');
    report(ttyd.status === 401 && clean(ttyd), 'core /ttyd-proxy/9224/json/version → 401', ttyd);

    const rebind = await request(CORE, '/auth/browser-token', { headers: { Host: 'rebind.invalid', 'X-LM-Client': 'web' } });
    report(rebind.status !== 200 && rebind.status !== 0 && clean(rebind), 'core /auth/browser-token Host: rebind.invalid → not 200', rebind);

    const pre = await request(CORE, '/agent/execute', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.invalid', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-api-key' },
    });
    const acao = pre.headers['access-control-allow-origin'];
    report(pre.status > 0 && !acao, `core preflight from https://evil.invalid → no ACAO (got ${acao ? 'ACAO' : 'none'})`, pre);
  }

  console.log(failed ? `[check-token-leak] ${failed} FAIL` : '[check-token-leak] all PASS');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('[check-token-leak] error:', e && e.message);
  process.exit(1);
});
