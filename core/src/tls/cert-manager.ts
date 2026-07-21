/**
 * TLS certificate manager for the opt-in HTTPS terminator (LM_HTTPS=1).
 *
 * Generates and caches a self-signed certificate under the node's data dir
 * (`~/.lm-assist/tls` for the npm install, `tls-dev` for the dev repo):
 *
 *   key.pem   0600   private key — never leaves this directory
 *   cert.pem  0644   the certificate browsers are asked to accept once per device
 *   meta.json 0600   informational provenance (when/why generated, SANs)
 *
 * Reuse vs regenerate is decided from the ACTUAL cert (node:crypto X509Certificate),
 * not the sidecar: regenerate when files are missing/unparsable, the key no longer
 * matches the cert, the cert expires within `renewBeforeDays`, or the host's current
 * LAN IPv4s / hostname are no longer covered by the SANs (IP drift after a DHCP move
 * would otherwise pin a stale cert). Only IPv4 coverage is enforced on reuse — IPv6
 * SAN text normalization varies across OpenSSL builds ("::1" vs "0:0:…:1"), so ::1 is
 * included at generation time but not required for reuse.
 *
 * Dependency note: `selfsigned` is pinned to major 2 (CJS, node-forge — the
 * webpack-dev-server lineage). The v5 line pulls ESM-leaning deps (pkijs/@peculiar):
 * same `require()`-of-ESM hazard class as chokidar 4/5, so do NOT bump the major.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

export interface EnsureTlsCertOptions {
  /** Directory holding key.pem / cert.pem / meta.json (created 0700 if missing). */
  dir: string;
  /** DNS SANs. Default: ['localhost', os.hostname()]. */
  hostnames?: string[];
  /** IP SANs. Default: 127.0.0.1 + ::1 + discoverLanIps(). */
  ips?: string[];
  /** Certificate validity in days. Default 397 (max Safari accepts for new certs). */
  validityDays?: number;
  /** Regenerate when fewer than this many days remain. Default 14. */
  renewBeforeDays?: number;
  /** Subject CN. Default 'lm-assist'. */
  commonName?: string;
  /** RSA key size. Default 2048; tests pass 512 to keep keygen fast. */
  keySize?: number;
  log?: (msg: string) => void;
}

export interface TlsCertResult {
  key: string;
  cert: string;
  keyPath: string;
  certPath: string;
  regenerated: boolean;
  /** Why the cert was regenerated (absent when reused). */
  reason?: string;
  dns: string[];
  ips: string[];
}

/** Non-internal IPv4 addresses of this host (the LAN IPs a second device dials). */
export function discoverLanIps(): string[] {
  const out: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] || []) {
      if (addr.family === 'IPv4' && !addr.internal && addr.address) out.push(addr.address);
    }
  }
  return [...new Set(out)];
}

const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function dedupe(list: string[]): string[] {
  return [...new Set(list.filter((s) => !!s && !!s.trim()))];
}

/** Exact SAN-entry check against node's "DNS:a, IP Address:b" rendering. */
function sanEntries(certPem: string): Set<string> {
  const x = new crypto.X509Certificate(certPem);
  return new Set((x.subjectAltName || '').split(',').map((s) => s.trim()).filter(Boolean));
}

/** null = reusable; otherwise the reason a regeneration is needed. */
function reuseBlocker(
  keyPem: string,
  certPem: string,
  dns: string[],
  ipv4s: string[],
  renewBeforeDays: number,
): string | null {
  let x: crypto.X509Certificate;
  try {
    x = new crypto.X509Certificate(certPem);
  } catch {
    return 'existing cert.pem is not a valid certificate';
  }
  try {
    if (!x.checkPrivateKey(crypto.createPrivateKey(keyPem))) return 'key.pem does not match cert.pem';
  } catch {
    return 'existing key.pem is not a valid private key';
  }
  const remainingMs = new Date(x.validTo).getTime() - Date.now();
  if (!(remainingMs > renewBeforeDays * 86400000)) return `cert expires ${x.validTo}`;
  const sans = sanEntries(certPem);
  for (const d of dns) if (!sans.has(`DNS:${d}`)) return `SAN missing DNS:${d}`;
  for (const ip of ipv4s) if (!sans.has(`IP Address:${ip}`)) return `SAN missing IP:${ip} (IP drift)`;
  return null;
}

/**
 * Ensure a usable self-signed cert exists in `opts.dir`, generating/replacing it
 * when needed. Synchronous by design — runs once at HTTPS startup; the RSA keygen
 * (~1s) only happens when the cached cert is missing or stale.
 */
export function ensureTlsCert(opts: EnsureTlsCertOptions): TlsCertResult {
  const log = opts.log || (() => {});
  const validityDays = opts.validityDays ?? 397;
  const renewBeforeDays = opts.renewBeforeDays ?? 14;
  const commonName = opts.commonName ?? 'lm-assist';
  const dns = dedupe(['localhost', ...(opts.hostnames ?? [os.hostname()])]);
  const allIps = dedupe(['127.0.0.1', '::1', ...(opts.ips ?? discoverLanIps())]);
  const ipv4s = allIps.filter((ip) => IPV4_RE.test(ip));

  const keyPath = path.join(opts.dir, 'key.pem');
  const certPath = path.join(opts.dir, 'cert.pem');
  const metaPath = path.join(opts.dir, 'meta.json');

  let reason: string | undefined;
  try {
    const key = fs.readFileSync(keyPath, 'utf8');
    const cert = fs.readFileSync(certPath, 'utf8');
    const blocker = reuseBlocker(key, cert, dns, ipv4s, renewBeforeDays);
    if (!blocker) return { key, cert, keyPath, certPath, regenerated: false, dns, ips: ipv4s };
    reason = blocker;
  } catch {
    reason = 'no cached certificate';
  }

  log(`[TLS] generating self-signed cert (${reason}) — SANs: ${[...dns, ...allIps].join(', ')}`);
  // Lazy require: node-forge is ~1MB of JS; only pay the parse when actually generating.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const selfsigned = require('selfsigned') as typeof import('selfsigned');
  const altNames: Array<{ type: number; value?: string; ip?: string }> = [
    ...dns.map((value) => ({ type: 2, value })), // 2 = DNS
    ...allIps.map((ip) => ({ type: 7, ip })), // 7 = IP
  ];
  const pems = selfsigned.generate([{ name: 'commonName', value: commonName }], {
    days: validityDays,
    keySize: opts.keySize ?? 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true },
      {
        name: 'keyUsage',
        keyCertSign: true,
        digitalSignature: true,
        nonRepudiation: true,
        keyEncipherment: true,
        dataEncipherment: true,
      },
      { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  });

  fs.mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(opts.dir, 0o700); } catch { /* best-effort on non-POSIX */ }
  fs.writeFileSync(keyPath, pems.private, { mode: 0o600 });
  try { fs.chmodSync(keyPath, 0o600); } catch { /* best-effort on non-POSIX */ }
  fs.writeFileSync(certPath, pems.cert, { mode: 0o644 });
  const meta = {
    version: 1,
    generator: 'selfsigned@2',
    createdAt: new Date().toISOString(),
    expiresAt: new crypto.X509Certificate(pems.cert).validTo,
    commonName,
    reason,
    dns,
    ips: allIps,
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), { mode: 0o600 });
  try { fs.chmodSync(metaPath, 0o600); } catch { /* best-effort on non-POSIX */ }

  return { key: pems.private, cert: pems.cert, keyPath, certPath, regenerated: true, reason, dns, ips: ipv4s };
}
