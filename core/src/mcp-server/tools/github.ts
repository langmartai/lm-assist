/**
 * GitHub MCP tools — surface the lm-assist `/github/*` action endpoint over MCP.
 *
 * Two tools, split along the capability-scope boundary (a tool maps to exactly
 * one scope in configure.ts TOOL_SCOPES):
 *
 *   github_query  (read)  — auth/status, accounts/list, whoami, repo/get, pr/list
 *   github_mutate (write) — pr/create, pr/close, issue/create, issue/close,
 *                            branch/delete, file/put, git/commit-push
 *
 * Both dispatch to `POST /github/<action>` on loopback (the same route a direct
 * HTTP caller hits), so EVERY guarantee of the underlying service holds for free:
 *   - multi-account: pass `account` to act as a specific GitHub login; an
 *     unresolved account fails closed (AUTH_MISSING) — never silent fallback.
 *   - credential safety: responses are deep-redacted by the service; no token
 *     can cross this boundary. accounts/list returns names + sources, never tokens.
 *
 * Wiring: registered in EXPANDED_TOOL_DEFS + EXPANDED_HANDLERS (expanded.ts), so
 * both transports (StreamableHTTP in-process; stdio via /mcp-call) pick them up.
 * The raw `gh`/`api` passthrough actions of the endpoint are intentionally NOT
 * exposed over MCP — only the structured, scope-classified actions are.
 */

import { ok, err, workerPostRaw, type McpToolResult } from './_passthrough';

const READ_ACTIONS = ['auth/status', 'accounts/list', 'whoami', 'repo/get', 'repo/list', 'pr/list'] as const;
const WRITE_ACTIONS = [
  'pr/create', 'pr/close', 'issue/create', 'issue/close', 'branch/delete', 'file/put',
  'fork', 'git/clone', 'git/commit-push',
] as const;

function pretty(data: unknown): string {
  return typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

/** Copy only the provided (defined) keys from args into a params object. */
function pick(args: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  for (const k of keys) if (args[k] !== undefined && args[k] !== null) p[k] = args[k];
  return p;
}

/**
 * Call one `/github/<action>` on loopback and render the structured envelope.
 * On success returns the backend that served it + the (already-redacted) data;
 * on failure surfaces the typed code/backend/message — no credential ever
 * appears because the service redacts before responding.
 */
async function githubAction(action: string, params: Record<string, unknown>): Promise<McpToolResult> {
  let body: Record<string, unknown>;
  try {
    body = await workerPostRaw(`/github/${action}`, params);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
  if (body && body.ok) {
    return ok(pretty({ backend: body.backend, data: body.data }));
  }
  const e = (body && (body.error as Record<string, unknown>)) || {};
  const code = String(e.code || 'GITHUB_ERROR');
  const backend = e.backend ? ` [${String(e.backend)}]` : '';
  return err(`${code}${backend}: ${String(e.message || 'github action failed')}`);
}

// ─── Tool definitions ────────────────────────────────────────────

export const githubQueryToolDef = {
  name: 'github_query',
  description:
    'Read-only GitHub operations, multi-account aware. Trigger words: "github", "which github ' +
    'account", "list my PRs", "repo info", "github accounts". `action` selects the operation: ' +
    '`accounts/list` (which GitHub accounts this host can act as — names + sources, never tokens), ' +
    '`auth/status` (per-backend availability, optional `account`), `whoami` (the authenticated ' +
    'login), `repo/get` (repo metadata; needs owner+repo), `repo/list` (repos — no owner = the ' +
    'account\'s own repos incl. private; with owner = that user/org\'s repos), `pr/list` (open PRs; ' +
    'needs owner+repo). Pass `account="<login>"` to act as a specific account; if that account has no ' +
    'credential on this host the call fails closed (AUTH_MISSING) rather than acting as someone else. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: [...READ_ACTIONS],
        description: 'Which read operation to run.',
      },
      account: { type: 'string', description: 'GitHub login to act as (optional; default = host default credential).' },
      owner: { type: 'string', description: 'Repo owner (repo/get, pr/list; repo/list: a user/org to list).' },
      repo: { type: 'string', description: 'Repo name (for repo/get, pr/list).' },
      state: { type: 'string', description: 'pr/list state filter: open | closed | all (default open).' },
      visibility: { type: 'string', description: 'repo/list (own repos): all | public | private.' },
      sort: { type: 'string', description: 'repo/list sort: created | updated | pushed | full_name (default pushed).' },
      per_page: { type: 'number', description: 'repo/list page size (default 30, max 100).' },
    },
    required: ['action'],
  },
};

export const githubMutateToolDef = {
  name: 'github_mutate',
  description:
    'Mutating GitHub operations, multi-account aware. WRITE — prompts for approval on every call. ' +
    '`action`: `pr/create` (owner,repo,title,head,base,body), `pr/close` (owner,repo,number), ' +
    '`issue/create` (owner,repo,title,body), `issue/close` (owner,repo,number), `branch/delete` ' +
    '(owner,repo,branch), `file/put` (owner,repo,path,content,message,branch), `fork` ' +
    '(owner,repo,organization?), `git/clone` (owner,repo,dir?,depth?,ssh?), `git/commit-push` ' +
    '(owner,repo,branch,message,files[]; set ssh=true to push with the host SSH key instead of a ' +
    'token). `dir` (git/clone, git/commit-push) targets a real directory and is gated by the ' +
    'lm-assist allowlist (/home/ubuntu/*) — clone refuses a non-empty dir; commit-push operates in ' +
    'place on an existing checkout there. Pass `account="<login>"` to act as a specific account — a ' +
    'credential for it must exist on the host (else AUTH_MISSING). API writes need a write-scoped ' +
    'token; the git backend can push over SSH. No credential is ever returned.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: [...WRITE_ACTIONS],
        description: 'Which mutating operation to run.',
      },
      account: { type: 'string', description: 'GitHub login to act as (recommended; needs a credential on this host).' },
      owner: { type: 'string', description: 'Repo owner.' },
      repo: { type: 'string', description: 'Repo name.' },
      branch: { type: 'string', description: 'Branch name (branch/delete, file/put, git/commit-push).' },
      title: { type: 'string', description: 'PR/issue title (pr/create, issue/create).' },
      body: { type: 'string', description: 'PR/issue body text.' },
      head: { type: 'string', description: 'pr/create: source branch.' },
      base: { type: 'string', description: 'pr/create: target branch (default main).' },
      number: { type: 'number', description: 'PR/issue number (pr/close, issue/close).' },
      path: { type: 'string', description: 'file/put: repo file path.' },
      content: { type: 'string', description: 'file/put: file content (UTF-8).' },
      message: { type: 'string', description: 'Commit message (file/put, git/commit-push).' },
      files: {
        type: 'array',
        description: 'git/commit-push: files to write then commit.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path within the repo.' },
            content: { type: 'string', description: 'File content.' },
          },
          required: ['path', 'content'],
        },
      },
      ssh: { type: 'boolean', description: 'git/clone, git/commit-push: use the host SSH key instead of an https token.' },
      organization: { type: 'string', description: 'fork: target org to fork into (default = your account).' },
      dir: { type: 'string', description: 'git/clone, git/commit-push: target directory — gated by the lm-assist allowlist (/home/ubuntu/*).' },
      depth: { type: 'number', description: 'git/clone: shallow depth (default 1; 0 = full clone).' },
    },
    required: ['action'],
  },
};

export const GITHUB_TOOL_DEFS = [githubQueryToolDef, githubMutateToolDef] as const;

// ─── Handlers ────────────────────────────────────────────────────

async function handleGithubQuery(args: Record<string, unknown>): Promise<McpToolResult> {
  const action = String(args.action || '').trim();
  if (!(READ_ACTIONS as readonly string[]).includes(action)) {
    return err(`github_query action must be one of: ${READ_ACTIONS.join(', ')}`);
  }
  return githubAction(action, pick(args, ['account', 'owner', 'repo', 'state', 'visibility', 'sort', 'per_page', 'page']));
}

async function handleGithubMutate(args: Record<string, unknown>): Promise<McpToolResult> {
  const action = String(args.action || '').trim();
  if (!(WRITE_ACTIONS as readonly string[]).includes(action)) {
    return err(`github_mutate action must be one of: ${WRITE_ACTIONS.join(', ')}`);
  }
  return githubAction(
    action,
    pick(args, ['account', 'owner', 'repo', 'branch', 'title', 'body', 'head', 'base', 'number', 'path', 'content', 'message', 'files', 'ssh', 'sshHost', 'organization', 'dir', 'depth']),
  );
}

export const GITHUB_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  github_query: handleGithubQuery,
  github_mutate: handleGithubMutate,
};
