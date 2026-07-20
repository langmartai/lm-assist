/** The subprocess MCP client — where third-party code actually runs (contract §6-§8).
 *
 *  ENFORCEMENT REALITY, stated plainly so nobody assumes more than is delivered:
 *
 *  Enforced here, in-process, unconditionally:
 *    - environment isolation: the child's env is BUILT, never inherited, so no OAuth
 *      token / hub key / api-token / data-dir path can reach it;
 *    - no shell: spawn(shell:false) with our own interpreter by absolute path and
 *      arguments resolved inside the plugin directory;
 *    - resource limits: handshake deadline, per-call timeout, result-size cap,
 *      concurrency cap, one process per plugin, kill escalation.
 *
 *  NOT enforced here (would need OS sandboxing — seccomp/Landlock/bubblewrap or a
 *  container): the `network` and `fs` capability lists are DECLARATIONS. They are
 *  validated, pinned into the approval, and shown on the review screen, but this
 *  build does not intercept the child's syscalls, so a plugin that ignores its own
 *  declaration is stopped by review and by the manifest pin, not by the kernel.
 *  Treat capability lists as an audited contract, not as a sandbox boundary. */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  MINIMAL_PATH, PLUGIN_LIMITS, RESERVED_ENV,
  type PluginManifest, type PluginToolDef,
} from './model';

export interface McpToolResultLike {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export interface SpawnedPlugin {
  listTools(): Promise<PluginToolDef[]>;
  call(tool: string, args: Record<string, unknown>): Promise<McpToolResultLike>;
  close(): Promise<void>;
  alive(): boolean;
  effectiveTimeoutMs(): number;
  stderrTail(): string;
  pid?: number;
}

export interface SpawnOptions {
  name: string;
  dir: string;
  manifest: PluginManifest;
  scratchDir: string;
  grants?: Record<string, string>;
  handshakeMs?: number;
}

const PROTOCOL_VERSION = '2025-11-25';

/**
 * Build the child environment from scratch (contract §6.1/§6.2).
 *
 * Nothing is copied from `process.env`. Declared names are filled ONLY from the
 * owner-supplied grant store; a declared-but-ungranted variable is simply absent.
 */
export function buildPluginEnv(
  manifest: PluginManifest,
  dir: string,
  scratchDir: string,
  grants: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: MINIMAL_PATH,
    HOME: scratchDir,                       // never the real home: ~/.lm-assist lives there
    TMPDIR: path.join(scratchDir, 'tmp'),
    LANG: 'C.UTF-8',
    LM_PLUGIN_NAME: manifest.name,
    LM_PLUGIN_VERSION: manifest.version,
    LM_PLUGIN_DIR: dir,
    LM_PLUGIN_SCRATCH_DIR: scratchDir,
  };
  for (const name of manifest.capabilities?.env ?? []) {
    if (RESERVED_ENV.has(name) || name.startsWith('LM_')) continue;   // belt and braces; validator refuses these
    const value = grants[name];
    if (typeof value === 'string') env[name] = value;
  }
  return env;
}

/** Resolve the entry point to an absolute command + args, refusing anything that
 *  escapes the plugin directory. The interpreter is OUR node (process.execPath), so
 *  a plugin can never influence which binary runs via PATH. */
export function resolveEntry(manifest: PluginManifest, dir: string): { command: string; args: string[] } {
  const root = path.resolve(dir);
  const args = manifest.entry.args.map((a) => {
    if (a.startsWith('--')) return a;                    // a flag, not a path
    const resolved = path.resolve(root, a);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`entry argument "${a}" resolves outside the plugin directory (traversal refused)`);
    }
    return resolved;
  });
  return { command: process.execPath, args };
}

interface Pending {
  resolve: (msg: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export async function spawnPlugin(opts: SpawnOptions): Promise<SpawnedPlugin> {
  const { name, dir, manifest, scratchDir } = opts;
  const handshakeMs = opts.handshakeMs ?? PLUGIN_LIMITS.handshakeMs;
  const timeoutMs = Math.min(
    Math.max(manifest.timeoutMs ?? PLUGIN_LIMITS.defaultTimeoutMs, 1000),
    PLUGIN_LIMITS.maxTimeoutMs,
  );

  fs.mkdirSync(path.join(scratchDir, 'tmp'), { recursive: true });
  const { command, args } = resolveEntry(manifest, dir);
  const env = buildPluginEnv(manifest, dir, scratchDir, opts.grants ?? {});

  const child: ChildProcessWithoutNullStreams = spawn(command, args, {
    cwd: dir,
    env,                      // exactly what we built — no inheritance
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,             // never a shell: no metacharacter interpretation
    detached: false,          // dies with us; no orphaned daemons
    windowsHide: true,
  });

  let dead = false;
  let exitInfo = '';
  let stderrTail = '';
  let buf = '';
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const failAll = (err: Error) => {
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(err); }
    pending.clear();
  };

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-PLUGIN_LIMITS.maxStderrCapture);
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buf += chunk;
    // A plugin that never emits a newline must not be able to exhaust our memory.
    if (buf.length > PLUGIN_LIMITS.maxResultBytes * 8) {
      buf = '';
      kill('protocol violation: unframed output exceeded the buffer guard');
      return;
    }
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line) as Record<string, unknown>; } catch { continue; }  // stray non-JSON: ignore
      const id = msg.id;
      if (typeof id === 'number' && pending.has(id)) {
        const p = pending.get(id)!;
        clearTimeout(p.timer);
        pending.delete(id);
        p.resolve(msg);
      }
    }
  });

  const onDeath = (why: string) => {
    dead = true;
    exitInfo = why;
    failAll(new Error(`plugin "${name}" is not running: ${why}`));
  };
  child.on('error', (e) => onDeath(`spawn error: ${e.message}`));
  child.on('exit', (code, signal) => onDeath(signal ? `killed by ${signal}` : `exited with code ${code}`));

  function kill(reason: string): void {
    if (dead) return;
    exitInfo = reason;
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, PLUGIN_LIMITS.killGraceMs);
    t.unref?.();
  }

  /** One JSON-RPC round trip with its own deadline. */
  function rpc(method: string, params: unknown, deadlineMs: number): Promise<Record<string, unknown>> {
    if (dead) return Promise.reject(new Error(`plugin "${name}" is not running: ${exitInfo}`));
    const id = nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        // A hanging plugin is killed, per the resource-limit contract.
        kill(`timeout after ${deadlineMs}ms on ${method}`);
        reject(new Error(`timeout after ${deadlineMs}ms waiting for ${method}`));
      }, deadlineMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n');
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error(`could not write to plugin "${name}": ${(e as Error).message}`));
      }
    });
  }

  function notify(method: string): void {
    try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); } catch { /* ignore */ }
  }

  // --- handshake, on its own deadline ---------------------------------------------
  try {
    const init = await rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'lm-assist', version: '1.x' },
    }, handshakeMs);
    if ((init as { error?: unknown }).error) {
      throw new Error(`initialize failed: ${JSON.stringify((init as { error: unknown }).error).slice(0, 200)}`);
    }
    notify('notifications/initialized');
  } catch (e) {
    kill('handshake failed');
    const detail = stderrTail.trim().split('\n').slice(-3).join(' | ');
    throw new Error(`plugin "${name}" handshake failed: ${(e as Error).message}${detail ? ` [stderr: ${detail}]` : ''}`);
  }

  // --- concurrency gate ------------------------------------------------------------
  let inFlight = 0;
  const queue: Array<() => void> = [];
  const acquire = (): Promise<void> => new Promise((res) => {
    if (inFlight < PLUGIN_LIMITS.maxConcurrentCalls) { inFlight++; res(); return; }
    queue.push(() => { inFlight++; res(); });
  });
  const release = (): void => {
    inFlight--;
    const next = queue.shift();
    if (next) next();
  };

  function capResult(raw: unknown): McpToolResultLike {
    const r = (raw ?? {}) as { content?: unknown; isError?: unknown };
    const content = Array.isArray(r.content)
      ? (r.content as Array<Record<string, unknown>>).map((c) => ({
        type: typeof c.type === 'string' ? c.type : 'text',
        text: typeof c.text === 'string' ? c.text : JSON.stringify(c.text ?? ''),
      }))
      : [{ type: 'text', text: '' }];

    const bytes = content.reduce((n, c) => n + Buffer.byteLength(c.text, 'utf8'), 0);
    if (bytes > PLUGIN_LIMITS.maxResultBytes) {
      const head = content[0]?.text ?? '';
      const keep = Buffer.from(head, 'utf8').subarray(0, Math.min(4096, PLUGIN_LIMITS.maxResultBytes)).toString('utf8');
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `⛔ result too large — the plugin returned ${bytes} bytes, over the ${PLUGIN_LIMITS.maxResultBytes}-byte cap, and was truncated.\n\nFirst 4 KiB:\n${keep}`,
        }],
      };
    }
    return { content, ...(r.isError === true ? { isError: true as const } : {}) };
  }

  return {
    pid: child.pid,
    alive: () => !dead,
    effectiveTimeoutMs: () => timeoutMs,
    stderrTail: () => stderrTail,

    async listTools(): Promise<PluginToolDef[]> {
      const res = await rpc('tools/list', undefined, timeoutMs);
      const tools = ((res.result ?? {}) as { tools?: unknown }).tools;
      if (!Array.isArray(tools)) return [];
      return tools
        .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
        .map((t) => ({
          name: String(t.name ?? ''),
          description: String(t.description ?? ''),
          inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
        }));
    },

    async call(tool: string, args: Record<string, unknown>): Promise<McpToolResultLike> {
      await acquire();
      try {
        const res = await rpc('tools/call', { name: tool, arguments: args }, timeoutMs);
        if ((res as { error?: unknown }).error) {
          const err = (res as { error: { message?: string } }).error;
          return { isError: true, content: [{ type: 'text', text: `plugin protocol error: ${err?.message ?? 'unknown'}` }] };
        }
        return capResult(res.result);
      } finally {
        release();
      }
    },

    async close(): Promise<void> {
      if (dead) return;
      try { child.stdin.end(); } catch { /* already closed */ }
      await new Promise<void>((resolve) => {
        if (dead) return resolve();
        const done = () => resolve();
        child.once('exit', done);
        const t = setTimeout(() => {
          try { child.kill('SIGTERM'); } catch { /* gone */ }
          const t2 = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, PLUGIN_LIMITS.killGraceMs);
          t2.unref?.();
        }, 250);
        t.unref?.();
      });
      dead = true;
    },
  };
}
