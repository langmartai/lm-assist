/**
 * GitHub Routes (lm-assist)
 *
 * Unified multi-backend GitHub action endpoint. One POST entrypoint:
 *   POST /github/<action>   body = action params  ->  { ok, backend, data } | { ok:false, error }
 *   GET  /github            ->  { ok, data: { actions: [...] } }   (introspection)
 *
 * Backends (auto-selected, with graceful fallback): api (token → REST), gh (CLI), git (local tree).
 * The token is resolved + injected INTERNALLY by the service and is NEVER logged or returned.
 * Errors are structured: AUTH_MISSING / AUTH_INVALID / FORBIDDEN / NOT_FOUND / RATE_LIMITED /
 *   CONFLICT / VALIDATION / PUSH_REJECTED / BACKEND_UNAVAILABLE / NETWORK / SERVER.
 *
 * Actions: auth/status, whoami, repo/get, pr/list, pr/create, pr/close, issue/create,
 *   issue/close, branch/delete, file/put, git/clone, git/commit-push, gh, api.
 */
import type { RouteHandler, RouteContext } from '../index';
import { runAction, GITHUB_ACTIONS } from '../../github/github-service';

export function createGithubRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    {
      method: 'GET',
      pattern: /^\/github$/,
      // lm-assist rest-server maps HTTP status from `result.success` (200 vs 400).
      handler: async () => ({ success: true, data: { actions: GITHUB_ACTIONS } }),
    },
    {
      method: 'POST',
      pattern: /^\/github\/(?<action>.+)$/,
      handler: async (req) => {
        const action = decodeURIComponent(req.params.action || '');
        const r: any = await runAction(action, req.body || {});
        // success drives the HTTP status; keep the structured {ok, backend, data|error} in the body.
        return { success: !!r.ok, ...r };
      },
    },
  ];
}
