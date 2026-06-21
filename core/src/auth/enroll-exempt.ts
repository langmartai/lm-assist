// Strict loopback only — NOT isLocalAddress() (which also matches LAN interface IPs).
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// Only REDEEM (/hub/login) is tokenless from loopback — there the single-use keypack
// IS the credential. MINTING (/hub/enroll/create) happens on an already-authed node
// where the api-token is available locally, so it stays token-gated (the CLI sends it
// via lmAuthHeader). This prevents any local process from minting enrollment keypacks.
const EXEMPT_PATHS = new Set(['/hub/login']);

export function isLoopbackAddress(addr: string | undefined | null): boolean {
  return !!addr && LOOPBACK.has(addr);
}

export function isEnrollExempt(
  method: string | undefined,
  path: string,
  remoteAddress: string | undefined | null,
  origin?: string | string[] | undefined | null,
): boolean {
  // A browser cross-origin request ALWAYS carries an Origin header; the CLI and
  // curl do not. Requiring its absence blocks drive-by CSRF (a page the user
  // visits POSTing to 127.0.0.1) while keeping the loopback exemption usable from
  // the CLI/curl. A browser request still works — it just falls back to the token.
  const o = Array.isArray(origin) ? origin[0] : origin;
  if (o) return false;
  return (method || '').toUpperCase() === 'POST'
    && EXEMPT_PATHS.has(path)
    && isLoopbackAddress(remoteAddress);
}
