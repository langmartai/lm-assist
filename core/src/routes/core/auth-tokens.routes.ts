/**
 * Scoped-token admin routes (lm-assist)
 *
 * Mint / list / revoke narrow, revocable API tokens (see auth/scoped-token.ts).
 * These routes sit behind the NORMAL full-token gate: a scoped token can never
 * reach them (no scope allow-lists them), so only a full-token caller — a
 * server-side shim, the CLI, another node — can mint or revoke.
 *
 * Endpoints:
 *   POST   /auth/scoped-tokens        { scope, ttlMs?, label? } → { ...info, token }
 *   GET    /auth/scoped-tokens        → { tokens: [info] }   (never the secrets)
 *   DELETE /auth/scoped-tokens/:id    → { revoked: boolean }
 */
import type { RouteHandler, RouteContext } from '../index';
import { isKnownScope, listScopedTokens, mintScopedToken, revokeScopedToken } from '../../auth/scoped-token';

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
  ];
}
