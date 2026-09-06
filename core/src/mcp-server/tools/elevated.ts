/**
 * Elevated-worker MCP tools (WINDOWS-ONLY) — surface the `/elevated/*` routes.
 *
 *   elevated_status  (read)   — platform/grant/worker state
 *   elevated_exec    (admin)  — run a command elevated (high-risk)
 *   elevated_grant   (admin)  — one-time UAC grant (registers the task)
 *   elevated_revoke  (admin)  — stop worker + delete the task
 *
 * Each wraps this node's own `/elevated/*` loopback route (single source of
 * truth). On non-Windows the routes return UNSUPPORTED_PLATFORM, which these
 * tools relay verbatim.
 *
 * Wiring: registered in EXPANDED_TOOL_DEFS + EXPANDED_HANDLERS (expanded.ts) and
 * scoped in configure.ts TOOL_SCOPES.
 */
import { ok, err, workerGet, workerPostRaw, type McpToolResult } from './_passthrough';

function pretty(data: unknown): string {
  return typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

// ─── definitions ─────────────────────────────────────────────────────────

export const elevatedStatusToolDef = {
  name: 'elevated_status',
  description:
    'Report the WINDOWS elevated-worker state on this host: whether the platform is supported, ' +
    'whether the one-time grant (the LmAssistElevatedWorker scheduled task) is registered, whether ' +
    'the worker process is up, its integrity level, and the loopback port. Use before elevated_exec. ' +
    'Returns supported:false on non-Windows. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export const elevatedExecToolDef = {
  name: 'elevated_exec',
  description:
    'Run a command ELEVATED (high integrity) on this WINDOWS host via the resident elevated worker — ' +
    'e.g. to restart the elevated prod Core. No UAC prompt (the one-time grant already registered the ' +
    'task). ADMIN / high-risk — runs real code as administrator. If not yet granted, fails with ' +
    'ELEVATED_NOT_GRANTED (run elevated_grant first). Default shell is cmd.exe /c; set shell="powershell" ' +
    'for PowerShell. Returns exitCode/stdout/stderr/elapsedMs. ARG CONTRACT: `cmd` is the shell command ' +
    'LINE, passed verbatim — write pipes, redirects, && and a pre-quoted `bash -c "…"` in it exactly as you ' +
    'would at that shell\'s prompt. Each `args[i]` is ONE argument, quoted per-arg for the chosen shell, so ' +
    'a space, a quote or a | > & inside an arg is data, not syntax (an arg can never open a pipe). Multi-word ' +
    'remote commands go in `cmd` as one pre-quoted string, e.g. cmd: \'ssh host "bash -c \\"ls -la | head\\""\'. ' +
    'Under cmd.exe, %VAR% expands even inside quotes — use shell="powershell" for a literal %.',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      cmd: { type: 'string', description: 'The shell command LINE, passed verbatim (pipes/redirects/pre-quoted bash -c work as typed).' },
      args: { type: 'array', items: { type: 'string' }, description: 'Optional arguments, each quoted PER-ARG for the shell (spaces and | > & inside an arg are data). Do not put shell syntax here — put it in cmd.' },
      cwd: { type: 'string', description: 'Working directory.' },
      timeoutMs: { type: 'number', description: 'Timeout in ms (default 120000, max 600000).' },
      shell: { type: 'string', enum: ['cmd', 'powershell'], description: 'Shell to run under (default cmd).' },
    },
    required: ['cmd'],
  },
};

export const elevatedGrantToolDef = {
  name: 'elevated_grant',
  description:
    'Perform the ONE-TIME UAC grant on this WINDOWS host: register the LmAssistElevatedWorker scheduled ' +
    'task (RunLevel=Highest) so the elevated worker can run without per-command prompts. Triggers a single ' +
    'UAC shield dialog that the operator must approve. ADMIN. Idempotent. Returns supported:false on non-Windows.',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export const elevatedRevokeToolDef = {
  name: 'elevated_revoke',
  description:
    'Revoke the WINDOWS elevated worker: stop the running worker (best effort) and delete the ' +
    'LmAssistElevatedWorker scheduled task. ADMIN / removes the elevation grant. Returns supported:false ' +
    'on non-Windows.',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export const ELEVATED_TOOL_DEFS = [
  elevatedStatusToolDef,
  elevatedExecToolDef,
  elevatedGrantToolDef,
  elevatedRevokeToolDef,
] as const;

// ─── handlers ──────────────────────────────────────────────────────────────

async function handleElevatedStatus(): Promise<McpToolResult> {
  try {
    return ok(pretty(await workerGet('/elevated/status')));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleElevatedExec(args: Record<string, unknown>): Promise<McpToolResult> {
  const cmd = String(args.cmd || '').trim();
  if (!cmd) return err('cmd is required.');
  const body: Record<string, unknown> = { cmd };
  if (Array.isArray(args.args)) body.args = (args.args as unknown[]).map(String);
  if (args.cwd) body.cwd = String(args.cwd);
  if (args.timeoutMs !== undefined) body.timeoutMs = Number(args.timeoutMs);
  if (args.shell) body.shell = String(args.shell);
  try {
    const r = await workerPostRaw('/elevated/exec', body);
    if (r && r.success) return ok(pretty(r.data));
    const e = (r && (r.error as Record<string, unknown>)) || {};
    return err(`${String(e.code || 'ELEVATED_EXEC_FAILED')}: ${String(e.message || 'exec failed')}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleElevatedGrant(): Promise<McpToolResult> {
  try {
    return ok(pretty(await workerPostRaw('/elevated/grant', {})));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleElevatedRevoke(): Promise<McpToolResult> {
  try {
    return ok(pretty(await workerPostRaw('/elevated/revoke', {})));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export const ELEVATED_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  elevated_status: () => handleElevatedStatus(),
  elevated_exec: handleElevatedExec,
  elevated_grant: () => handleElevatedGrant(),
  elevated_revoke: () => handleElevatedRevoke(),
};
