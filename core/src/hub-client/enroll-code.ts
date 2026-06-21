import { BlockList, isIPv4, isIPv6 } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

export interface Keypack { v: 1; hubUrl: string; token: string; }

const PREFIX = 'lmkp_';
const MAX_CODE_LEN = 8192;

// Cloud-metadata hostnames that are never a legitimate hub (their link-local IPs are also blocked by range).
const META_HOSTS = new Set(['metadata.google.internal', 'metadata.goog']);

// Internal / special-use IP ranges that are never a legitimate REMOTE hub and are classic SSRF sinks.
// LOOPBACK IS INTENTIONALLY ALLOWED — local/dev hubs run on `ws://localhost`/`127.0.0.1`/`[::1]`
// (see the "accepts ws://localhost" test); everything else internal is rejected.
const INTERNAL = (() => {
  const b = new BlockList();
  b.addSubnet('0.0.0.0', 8, 'ipv4');        // "this host" / unspecified
  b.addSubnet('10.0.0.0', 8, 'ipv4');       // RFC1918
  b.addSubnet('100.64.0.0', 10, 'ipv4');    // CGNAT (incl. Alibaba metadata 100.100.100.200)
  b.addSubnet('169.254.0.0', 16, 'ipv4');   // link-local (AWS/GCP/Azure IMDS 169.254.169.254)
  b.addSubnet('172.16.0.0', 12, 'ipv4');    // RFC1918
  b.addSubnet('192.168.0.0', 16, 'ipv4');   // RFC1918
  b.addSubnet('192.0.0.0', 24, 'ipv4');     // IETF protocol assignments (incl. Oracle metadata 192.0.0.192)
  b.addAddress('::', 'ipv6');               // unspecified
  b.addSubnet('fc00::', 7, 'ipv6');         // unique-local
  b.addSubnet('fe80::', 10, 'ipv6');        // link-local
  return b;
})();

/** True if an IP-LITERAL host is an internal/special-use SSRF sink (loopback is intentionally allowed). */
function ipLiteralBlocked(host: string): boolean {
  if (isIPv4(host)) return INTERNAL.check(host, 'ipv4');
  if (isIPv6(host)) {
    // IPv4-mapped IPv6 (`::ffff:a.b.c.d` or `::ffff:HHHH:HHHH`) → judge by the embedded IPv4 address.
    const m = /^::ffff:(.+)$/i.exec(host);
    if (m) {
      const inner = m[1];
      if (isIPv4(inner)) return INTERNAL.check(inner, 'ipv4');
      const hx = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(inner);
      if (hx) {
        const hi = parseInt(hx[1], 16), lo = parseInt(hx[2], 16);
        return INTERNAL.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, 'ipv4');
      }
    }
    return INTERNAL.check(host, 'ipv6');
  }
  return false; // a DNS name — see the rebinding note below
}

// A keypack's hubUrl becomes a fetch target AND a persisted hub websocket target, so it must be a real
// hub ws:// URL whose host is not an SSRF sink. We reject by SCHEME (no file:/http:/javascript:/data:,
// no host-less garbage) and by IP RANGE — covering IP literals, IPv4-mapped IPv6, and the GCP metadata
// hostname (with trailing-dot normalized). Loopback stays allowed for local/dev hubs.
// RESIDUAL: a DNS NAME that *resolves* to an internal address (DNS rebinding) is not caught here — that
// needs connect-time peer-IP validation in the hub client (tracked as a follow-up). `redirect:'manual'`
// at the fetch site (hub.routes.ts) already blocks redirect-to-internal.
function assertValidHubUrl(hubUrl: string): void {
  let u: URL;
  try { u = new URL(hubUrl); } catch { throw new Error('invalid keypack: bad hubUrl'); }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
    throw new Error('invalid keypack: hubUrl must be ws:// or wss://');
  }
  if (!u.hostname) throw new Error('invalid keypack: hubUrl has no host');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, ''); // unbracket IPv6, strip trailing dot(s)
  if (META_HOSTS.has(host) || ipLiteralBlocked(host)) {
    throw new Error('invalid keypack: hubUrl host not allowed');
  }
}

export type HostLookup = (host: string) => Promise<Array<{ address: string }>>;
const defaultLookup: HostLookup = (host) => dnsLookup(host, { all: true });

/**
 * DNS-rebinding guard: resolve a keypack hubUrl's HOST and reject if ANY resolved address is an
 * internal/metadata target. This closes the gap assertValidHubUrl can't see — a DNS NAME that
 * *resolves* to an internal IP. Call it at the point the untrusted hubUrl is actually used (the
 * redeem fetch / before persisting it as the hub target). IP-literal hosts are already settled
 * synchronously by assertValidHubUrl (and loopback stays allowed, incl. names resolving to loopback).
 * `lookup` is injectable for tests.
 */
export async function assertHubUrlResolvesSafe(hubUrl: string, lookup: HostLookup = defaultLookup): Promise<void> {
  assertValidHubUrl(hubUrl); // scheme + IP-literal + metadata host (sync) first
  const host = new URL(hubUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (isIPv4(host) || isIPv6(host)) return; // literal already judged above — no DNS to resolve
  let addrs: Array<{ address: string }>;
  try { addrs = await lookup(host); } catch { throw new Error('invalid keypack: hubUrl host does not resolve'); }
  if (!addrs.length) throw new Error('invalid keypack: hubUrl host does not resolve');
  for (const a of addrs) {
    if (ipLiteralBlocked((a.address || '').toLowerCase())) {
      throw new Error('invalid keypack: hubUrl resolves to an internal address');
    }
  }
}

export function encodeKeypack(k: Keypack): string {
  if (!k || k.v !== 1 || typeof k.hubUrl !== 'string' || !k.hubUrl || typeof k.token !== 'string' || !k.token) {
    throw new Error('invalid keypack: incomplete input');
  }
  assertValidHubUrl(k.hubUrl);
  const json = JSON.stringify({ v: 1, hubUrl: k.hubUrl, token: k.token });
  return PREFIX + Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeKeypack(code: string): Keypack {
  if (typeof code !== 'string' || !code.startsWith(PREFIX)) {
    throw new Error('invalid keypack: bad prefix');
  }
  if (code.length > MAX_CODE_LEN) {
    throw new Error('invalid keypack: too large');
  }
  let obj: any;
  try {
    obj = JSON.parse(Buffer.from(code.slice(PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw new Error('invalid keypack: bad encoding');
  }
  if (!obj || obj.v !== 1 || typeof obj.hubUrl !== 'string' || !obj.hubUrl || typeof obj.token !== 'string' || !obj.token) {
    throw new Error('invalid keypack: bad shape');
  }
  assertValidHubUrl(obj.hubUrl);
  return { v: 1, hubUrl: obj.hubUrl, token: obj.token };
}
