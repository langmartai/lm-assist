/**
 * claudeai_login MCP tool — guided re-login for a node's credentials.
 *
 * Handles:
 *   - claude.ai WEB session cookie: browser-capture path (POST /claude-ai/browser/launch-and-capture)
 *     when a desktop browser is available; exact manual steps otherwise.
 *   - Claude Code OAuth token: reports current status + tells the user to run Claude Code
 *     to re-login (OAuth login is interactive; we never enter credentials).
 *
 * Always re-reports /claude-ai/healthz at the end so the caller sees the result.
 *
 * Registered in EXPANDED_TOOL_DEFS + EXPANDED_HANDLERS (expanded.ts), scoped admin
 * in configure.ts TOOL_SCOPES (drives the node's browser with skip-permissions).
 */
import { ok, err, workerGet, workerPost, type McpToolResult } from './_passthrough';

/**
 * Pure decision function — determines what cookie action to take based on the
 * current state. Exported for unit testing.
 */
export function decideCookieAction(i: {
  healthy: boolean;
  browserRequested: boolean;
  hasDesktopBrowser: boolean;
}): 'already-ok' | 'launch' | 'manual' {
  if (i.healthy) return 'already-ok';
  if (i.hasDesktopBrowser) return 'launch';
  return 'manual';
}

const MANUAL_COOKIE = [
  'Manual cookie capture (no desktop browser on this node):',
  '1. In a browser logged into claude.ai, open DevTools → Network → any /api/... request → Copy → Copy as cURL.',
  '2. Grab the `Cookie:` header value (must include the sk-ant-sid… sessionKey).',
  '3. Write ~/.claude/claudeai-session.json per docs/claude-ai-routes.md (cookie capture workflow).',
  'Then re-run auth_status. (The cookie is IP-pinned to the host that captured it.)',
].join('\n');

export const claudeaiLoginToolDef = {
  name: 'claudeai_login',
  description:
    "Guided re-login for a node's credentials — the claude.ai WEB cookie and/or the Claude Code " +
    'OAuth token (which="cookie"|"oauth"|"all", default all). For the cookie: pass browser:true to open ' +
    'Chrome on the node for YOU to log in (it captures the session; it never types your credentials); ' +
    'without browser:true it returns the exact manual capture steps. For OAuth it reports status / tells ' +
    'you to run Claude Code to re-login. Targets a node (cookie is IP-pinned). Returns the resulting auth status.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      which: {
        type: 'string',
        enum: ['cookie', 'oauth', 'all'],
        description: 'Credential to fix (default all).',
      },
      node: {
        type: 'string',
        description: 'Target node (hostId/hostname from list_nodes); omit for default.',
      },
      browser: {
        type: 'boolean',
        description: 'Force the browser-capture path for the cookie (default: auto when a desktop browser exists).',
      },
    },
  },
};

async function handleClaudeaiLogin(args: Record<string, unknown>): Promise<McpToolResult> {
  const which = ['cookie', 'oauth', 'all'].includes(String(args.which)) ? String(args.which) : 'all';
  const browserRequested = args.browser === true || args.browser === 'true';
  const out: string[] = [];
  try {
    if (which === 'oauth' || which === 'all') {
      const o = await workerGet<{ present?: boolean; expired?: boolean }>('/claude-code/oauth-status').catch(() => ({}));
      if (!o || !(o as { present?: boolean }).present) {
        out.push('OAuth: not present — run Claude Code on this node to log in (OAuth login is interactive).');
      } else if ((o as { expired?: boolean }).expired) {
        out.push(
          'OAuth: expired — it auto-refreshes via the refresh token on next use / auth-monitor; ' +
          'if it stays expired, run Claude Code to re-login.',
        );
      } else {
        out.push('OAuth: valid.');
      }
    }
    if (which === 'cookie' || which === 'all') {
      const h = await workerGet<{ ok?: boolean; reason?: string }>('/claude-ai/healthz').catch(() => ({}));
      const healthy = !!((h as { ok?: boolean }).ok);
      // hasDesktopBrowser: we use browserRequested as the proxy — the launch route itself reports
      // if no browser is actually available; treat headless as no-browser unless browser:true forces a try.
      const action = decideCookieAction({ healthy, browserRequested, hasDesktopBrowser: browserRequested });
      if (action === 'already-ok') {
        out.push('claude.ai cookie: already valid.');
      } else if (action === 'launch') {
        const r = await workerPost<{
          ok?: boolean;
          capture?: { cookieCount?: number };
          code?: string;
          message?: string;
        }>('/claude-ai/browser/launch-and-capture', { loginTimeoutMs: 300000 }).catch((e: unknown) => ({
          ok: false,
          message: String((e as Error)?.message || e),
        }));
        if (r && (r as { ok?: boolean }).ok) {
          const count = (r as { capture?: { cookieCount?: number } }).capture?.cookieCount ?? '?';
          out.push(`claude.ai cookie: captured (${count} cookies) — log-in completed.`);
        } else {
          const code = (r as { code?: string }).code || (r as { message?: string }).message || 'unknown';
          out.push(`claude.ai cookie: browser capture did not complete (${code}).\n${MANUAL_COOKIE}`);
        }
      } else {
        out.push('claude.ai cookie: needs re-login.\n' + MANUAL_COOKIE);
      }
    }
    // Re-report final state
    const post = await workerGet<{ ok?: boolean; reason?: string }>('/claude-ai/healthz').catch(() => ({}));
    const postOk = !!((post as { ok?: boolean }).ok);
    const postReason = (post as { reason?: string }).reason;
    out.push(
      `\nNow: claude.ai cookie ${postOk ? 'OK' : 'NOT usable' + (postReason ? ` (${postReason})` : '')}. (auth_status for full detail.)`,
    );
    return ok(out.join('\n'));
  } catch (e) {
    return err((e as Error).message);
  }
}

export const CLAUDEAI_LOGIN_TOOL_DEFS = [claudeaiLoginToolDef];
export const CLAUDEAI_LOGIN_HANDLERS: Record<string, (a: Record<string, unknown>) => Promise<McpToolResult>> = {
  claudeai_login: handleClaudeaiLogin,
};
