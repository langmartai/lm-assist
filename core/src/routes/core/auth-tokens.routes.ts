/**
 * Auth admin routes (lm-assist)
 *
 * Mint / list / revoke narrow, revocable API tokens (see auth/scoped-token.ts),
 * verify a presented token, and revoke-now the ring token. These routes sit behind
 * the NORMAL full-token gate: a scoped token can never reach them (no scope
 * allow-lists them), so only a full-token caller — a server-side shim, the CLI,
 * another node — can mint, revoke or rotate.
 *
 * Endpoints:
 *   POST   /auth/scoped-tokens        { scope, ttlMs?, label? } → { ...info, token }
 *   GET    /auth/scoped-tokens        → { tokens: [info] }   (never the secrets)
 *   DELETE /auth/scoped-tokens/:id    → { revoked: boolean }
 *   GET    /auth/check                → { valid: true } | 401 — re-validates x-api-key itself
 *   POST   /auth/token/rotate         { regenerateLanKey? } → { rotatedAt, revokedCount, lanKeyRegenerated }
 *                                     direct loopback, no Origin, no proxy/relay hop; returns no secret
 *
 * (GET /auth/browser-token is NOT here: it is its own gate and rest-server dispatches
 * it before the api-token gate — see auth/browser-token.ts.)
 */
import type { RouteHandler, RouteContext } from '../index';
import { isKnownScope, listScopedTokens, mintScopedToken, revokeScopedToken } from '../../auth/scoped-token';
import { isValidToken, resolveProvidedApiKey, rotateApiTokenNow } from '../../auth/api-token';
import { isDirectLoopbackPeer } from '../../auth/peer-trust';
import { regenerateLanAccessToken } from '../../auth/lan-access';
import { wrapError, wrapResponse } from '../../api/helpers';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function createAuthTokensRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    {
      method: 'POST',
      pattern: /^\/auth\/scoped-tokens$/,
      handler: async (req) => {
        const b = req.body || {};
        if (!isKnownScope(b.scope)) {
          return { success: false, error: { code: 'UNKNOWN_SCOPE', message: `body.scope must be a known scope (got ${JSON.stringify(b.scope)})` } };
        }
        try {
          const t = mintScopedToken({
            scope: b.scope,
            ttlMs: typeof b.ttlMs === 'number' ? b.ttlMs : undefined,
            label: typeof b.label === 'string' ? b.label : undefined,
            listPrefix: typeof b.listPrefix === 'string' ? b.listPrefix : undefined,
          });
          return { success: true, data: t };
        } catch (err) {
          return { success: false, error: { code: 'MINT_FAILED', message: (err as Error).message } };
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/auth\/scoped-tokens$/,
      handler: async () => ({ success: true, data: { tokens: listScopedTokens() } }),
    },
    {
      method: 'DELETE',
      pattern: /^\/auth\/scoped-tokens\/(?<id>[A-Za-z0-9_-]+)$/,
      handler: async (req) => ({ success: true, data: { revoked: revokeScopedToken(req.params.id) } }),
    },

    // GET /auth/check — does the presented x-api-key hold full (ring) authority?
    // Used by the web SERVER to authenticate its own state-changing routes: it forwards
    // the caller's header here over loopback. The handler re-validates the header ITSELF
    // rather than trusting that the request passed the gate: with
    // LM_ASSIST_API_AUTH_EXEMPT_LOCAL=1 the web server's own loopback call would pass the
    // gate with no token at all. Scoped lmsc_ tokens never pass (isValidToken is ring-only).
    {
      method: 'GET',
      pattern: /^\/auth\/check$/,
      handler: async (req) => {
        const start = Date.now();
        if (isValidToken(resolveProvidedApiKey(req.headers?.['x-api-key']))) {
          return wrapResponse({ valid: true }, start);
        }
        return { ...wrapError('UNAUTHORIZED', 'Invalid or missing API token', start), httpStatus: 401 };
      },
    },

    // POST /auth/token/rotate — operator revoke-now (see rotateApiTokenNow). Behind the
    // gate AND: a DIRECT loopback caller (no web /_coreapi proxy, no hub relay) with no
    // Origin (no browser page, same-origin or not). The caller's own token dies too —
    // re-read <dataDir>/api-token afterwards. Returns timestamps and counts, never a secret.
    {
      method: 'POST',
      pattern: /^\/auth\/token\/rotate$/,
      handler: async (req) => {
        const start = Date.now();
        const origin = req.headers?.['origin'];
        if (!isDirectLoopbackPeer(req.clientIp, req.headers) || origin !== undefined) {
          return {
            ...wrapError('FORBIDDEN', 'token rotation is an operator action on this machine: a direct loopback call with no Origin (or `cli.js token rotate --now`)', start),
            httpStatus: 403,
          };
        }
        const b = (req.body || {}) as { regenerateLanKey?: unknown };
        try {
          const r = rotateApiTokenNow();
          let lanKeyRegenerated = false;
          if (b.regenerateLanKey === true) {
            regenerateLanAccessToken();
            lanKeyRegenerated = true;
          }
          return wrapResponse({ rotatedAt: r.rotatedAt, revokedCount: r.revokedCount, lanKeyRegenerated }, start);
        } catch (err) {
          return { ...wrapError('ROTATE_FAILED', (err as Error).message, start), httpStatus: 500 };
        }
      },
    },
  ];
}
