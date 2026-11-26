/**
 * Google Colab CLI MCP tools — surface `/colab/*` action endpoints over MCP.
 *
 * Split along the capability-scope boundary:
 *   - `colab_query`  (read)  — doctor, version, sessions, status, usage, url, ls, log
 *   - `colab_mutate` (write) — new, stop, restart-kernel, exec, run, install,
 *                              upload, download, rm, drivemount, auth, logout, ssh-exec
 *
 * Intentionally omits raw `cli` passthrough over MCP.
 */

import { ok, err, workerPostRaw, type McpToolResult } from './_passthrough';
import { COLAB_READ_ACTIONS, COLAB_WRITE_ACTIONS } from '../../colab/colab-service';

function pretty(data: unknown): string {
  return typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

function pick(args: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  for (const k of keys) {
    if (args[k] !== undefined && args[k] !== null) p[k] = args[k];
  }
  return p;
}

async function colabAction(action: string, params: Record<string, unknown>): Promise<McpToolResult> {
  let body: Record<string, unknown>;
  try {
    body = await workerPostRaw(`/colab/${action}`, params);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
  if (body && body.ok) {
    return ok(pretty({ backend: body.backend, data: body.data }));
  }
  const e = (body && (body.error as Record<string, unknown>)) || {};
  const code = String(e.code || 'COLAB_ERROR');
  return err(`${code}: ${String(e.message || 'colab action failed')}`);
}

export const colabQueryToolDef = {
  name: 'colab_query',
  description:
    'Read-only Google Colab CLI (`google-colab-cli`) inspection. Trigger words: "colab", ' +
    '"colab sessions", "colab status", "colab usage", "colab credits", "colab gpu". `action`: ' +
    '`doctor` (binary/platform/auth/loginGuide check), `overview` (combined doctor + credits usage ' +
    '+ running sessions), `version`, `whoami`, `sessions`, `status`, `usage`, `url`, `ls`, `log`. ' +
    'Note: `google-colab-cli` supports Linux/macOS (target a Linux/macOS `node` when calling from Windows). Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: [...COLAB_READ_ACTIONS],
        description: 'Which read operation to run.',
      },
      auth: { type: 'string', enum: ['oauth2', 'adc'], description: 'Global auth strategy (`oauth2` or `adc`).' },
      oauthConfig: { type: 'string', description: 'Optional `-c` path to OAuth client config JSON.' },
      config: { type: 'string', description: 'Optional `--config` path to colab-cli sessions.json.' },
      session: { type: 'string', description: 'Target session name (`-s NAME`).' },
      path: { type: 'string', description: 'Remote path for `ls` (defaults to `/content`).' },
      n: { type: 'number', description: 'Number of log entries for `log` (1..200).' },
      outputFile: { type: 'string', description: 'Local export file path for `log` (gated by cwd allowlist).' },
      timeoutMs: { type: 'number', description: 'Command timeout in ms.' },
    },
    required: ['action'],
  },
};

export const colabMutateToolDef = {
  name: 'colab_mutate',
  description:
    'Mutating Google Colab CLI (`google-colab-cli`) operations. WRITE — prompts for approval. ' +
    '`action`: `login-start` (returns OAuth2 authUrl + loginId, or ADC command), ' +
    '`login-complete` (submits { loginId, code }), `new` (gpu/tpu/highMem/session), `stop`, ' +
    '`restart-kernel`, `exec` (code via stdin or allowlisted file, optional outputImage), `run` ' +
    '(script, gpu/tpu/highMem/keep, args[]), `install` (packages[] or requirementsFile), ' +
    '`upload` (localPath, remotePath), `download` (remotePath, localPath), `rm` (remotePath), ' +
    '`drivemount` (path?), `auth`, `logout`, `ssh-exec` (command[]). Local file paths are gated ' +
    'by the node cwd allowlist. Requires Linux/macOS.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: [...COLAB_WRITE_ACTIONS],
        description: 'Which mutating operation to run.',
      },
      auth: { type: 'string', enum: ['oauth2', 'adc'], description: 'Global auth strategy (`oauth2` or `adc`).' },
      oauthConfig: { type: 'string', description: 'Optional `-c` path to OAuth client config JSON.' },
      config: { type: 'string', description: 'Optional `--config` path to colab-cli sessions.json.' },
      session: { type: 'string', description: 'Target session name (`-s NAME`).' },
      gpu: { type: 'string', enum: ['T4', 'L4', 'G4', 'A100', 'H100'], description: 'GPU type for `new` / `run`.' },
      tpu: { type: 'string', enum: ['v5e1', 'v6e1'], description: 'TPU type for `new` / `run`.' },
      highMem: { type: 'boolean', description: 'Request high-RAM runtime (`--high-mem`).' },
      keep: { type: 'boolean', description: 'Keep runtime alive after `run` (`--keep`).' },
      all: { type: 'boolean', description: 'Stop all active sessions (`stop --all`).' },
      code: { type: 'string', description: 'Inline Python code to pipe to `exec` stdin, or OAuth2 authorization code for `login-complete`.' },
      file: { type: 'string', description: 'Local `.py` or `.ipynb` path for `exec -f` (allowlisted).' },
      outputImage: { type: 'string', description: 'Local output image path for `exec --output-image` (allowlisted).' },
      script: { type: 'string', description: 'Local script path for `run` (allowlisted).' },
      args: { type: 'array', items: { type: 'string' }, description: 'Forwarded CLI args for `run`.' },
      packages: { type: 'array', items: { type: 'string' }, description: 'Packages for `install`.' },
      requirementsFile: { type: 'string', description: 'Local requirements file for `install -r` (allowlisted).' },
      localPath: { type: 'string', description: 'Local path for `upload` / `download` (allowlisted).' },
      remotePath: { type: 'string', description: 'Remote path on VM for `upload` / `download` / `rm`.' },
      path: { type: 'string', description: 'Remote mount path for `drivemount`.' },
      command: { type: 'array', items: { type: 'string' }, description: 'Argv array passed after `--` to `colab ssh` for `ssh-exec`.' },
      loginId: { type: 'string', description: 'Pending login ID returned by `login-start` (for `login-complete`).' },
      timeoutMs: { type: 'number', description: 'Command timeout in ms.' },
    },
    required: ['action'],
  },
};

export const COLAB_TOOL_DEFS = [colabQueryToolDef, colabMutateToolDef] as const;

export async function handleColabQuery(args: Record<string, unknown>): Promise<McpToolResult> {
  const action = String(args.action || '').trim();
  if (!(COLAB_READ_ACTIONS as readonly string[]).includes(action)) {
    return err(`colab_query action must be one of: ${COLAB_READ_ACTIONS.join(', ')}`);
  }
  return colabAction(
    action,
    pick(args, ['auth', 'oauthConfig', 'config', 'session', 'path', 'n', 'outputFile', 'timeoutMs']),
  );
}

export async function handleColabMutate(args: Record<string, unknown>): Promise<McpToolResult> {
  const action = String(args.action || '').trim();
  if (!(COLAB_WRITE_ACTIONS as readonly string[]).includes(action)) {
    return err(`colab_mutate action must be one of: ${COLAB_WRITE_ACTIONS.join(', ')}`);
  }
  return colabAction(
    action,
    pick(args, [
      'auth', 'oauthConfig', 'config', 'session', 'gpu', 'tpu', 'highMem', 'keep', 'all',
      'code', 'file', 'outputImage', 'script', 'args', 'packages', 'requirementsFile',
      'localPath', 'remotePath', 'path', 'command', 'loginId', 'timeoutMs',
    ]),
  );
}

export const COLAB_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  colab_query: handleColabQuery,
  colab_mutate: handleColabMutate,
};
