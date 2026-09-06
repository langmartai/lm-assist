/**
 * Single source of truth for the operator's directory allowlist (defense-in-depth).
 *
 * Per operator decision: any directory under the worker's OWN home dir is
 * permitted, PLUS any extra root the operator configures for this node. Used by
 * `agent_execute` / `terminal_open_tab` (MCP) and by the github git backend's
 * directory-targeted clone / commit-push. Keep ONE definition so every gate
 * agrees — re-exported from `mcp-server/tools/_passthrough.ts` for existing callers.
 *
 * The gate is keyed to the EXECUTING worker's home (os.homedir()), not a literal
 * path: these MCP tools run on the node they target (the hub relays the call to
 * that worker), so the home dir is correct for each host — /home/ubuntu, /home/yi,
 * C:\Users\yi, etc. `home` is injectable for testing.
 *
 * EXTRA ROOTS (2026-09): on 107 the operator's repos live under C:\home, and
 * terminal_open_tab refused them ("restricted to C:\Users\admin and below")
 * while windows_terminal_create — the Claude-launch surface, which has never
 * had a cwd gate — happily opened them. Instead of relaxing the gate to
 * "anything", a node can declare extra roots:
 *   - env  LM_ASSIST_CWD_ROOTS  — `;`-separated (`;` on every platform: a Windows
 *     path contains `:`), e.g. `C:\home;D:\work`
 *   - file <dataDir>/cwd-roots  — one path per line, `#` comments
 *     (dataDir = ~/.lm-assist or LM_ASSIST_DATA_DIR)
 * The refusal message names both, so the fix is one line away from the error.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getDataDir } from './path-utils';

export const CWD_ROOTS_ENV = 'LM_ASSIST_CWD_ROOTS';
export const CWD_ROOTS_FILE = 'cwd-roots';

/** Parse a roots list: `;` or newline separated, `#` comments, blanks dropped. */
export function parseRootsList(text: string | undefined | null): string[] {
  if (!text) return [];
  return text
    .split(/[;\r\n]+/)
    .map((s) => s.replace(/#.*$/, '').trim())
    .filter((s) => s.length > 0);
}

/** Extra roots configured for THIS node (env + file). Never throws. */
export function configuredRoots(opts: { env?: NodeJS.ProcessEnv; dataDir?: string } = {}): string[] {
  const env = opts.env ?? process.env;
  const out = parseRootsList(env[CWD_ROOTS_ENV]);
  try {
    const f = path.join(opts.dataDir ?? getDataDir(), CWD_ROOTS_FILE);
    out.push(...parseRootsList(fs.readFileSync(f, 'utf8')));
  } catch { /* no file — fine */ }
  return Array.from(new Set(out));
}

const CASE_INSENSITIVE = process.platform === 'win32';

function norm(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  if (CASE_INSENSITIVE) s = s.toLowerCase();
  return s;
}

function under(cwd: string, root: string): boolean {
  const c = norm(cwd);
  const r = norm(root);
  if (!r) return false;
  return c === r || c.startsWith(r + '/');
}

export function isCwdAllowed(cwd: string, home: string = os.homedir(), extraRoots: string[] = configuredRoots()): boolean {
  if (!cwd) return false;
  if (under(cwd, home)) return true;
  return extraRoots.some((r) => under(cwd, r));
}

/** One line for refusal messages: what IS allowed here and how to extend it. */
export function describeCwdPolicy(home: string = os.homedir(), extraRoots: string[] = configuredRoots()): string {
  const extra = extraRoots.length ? `, plus configured roots: ${extraRoots.join(', ')}` : '';
  return `${home} and below${extra}. To allow another directory on this node, set ${CWD_ROOTS_ENV} (\`;\`-separated) or add it to ${path.join(getDataDir(), CWD_ROOTS_FILE)} (one path per line).`;
}
