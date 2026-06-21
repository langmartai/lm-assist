export interface Keypack { v: 1; hubUrl: string; token: string; }

const PREFIX = 'lmkp_';
const MAX_CODE_LEN = 8192;

// A keypack's hubUrl becomes a fetch + a persisted hub target, so it must be a
// real hub websocket URL. Reject anything that isn't ws://host or wss://host
// (blocks file:, http:, javascript:, data:, and host-less garbage → no SSRF via
// a hostile keypack scheme). See decodeKeypack callers in hub.routes.ts.
function assertValidHubUrl(hubUrl: string): void {
  let u: URL;
  try { u = new URL(hubUrl); } catch { throw new Error('invalid keypack: bad hubUrl'); }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
    throw new Error('invalid keypack: hubUrl must be ws:// or wss://');
  }
  if (!u.hostname) throw new Error('invalid keypack: hubUrl has no host');
  // Block link-local / cloud-metadata targets — never a legitimate hub, classic SSRF sink.
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h.startsWith('169.254.') || h.startsWith('fe80:') || h === 'metadata.google.internal') {
    throw new Error('invalid keypack: hubUrl host not allowed');
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
