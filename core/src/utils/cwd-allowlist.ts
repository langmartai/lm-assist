/**
 * Single source of truth for the operator's directory allowlist (defense-in-depth).
 *
 * Per operator decision: any directory under the worker's OWN home dir is
 * permitted. Used by `agent_execute` / `terminal_open_tab` (MCP) and by the
 * github git backend's directory-targeted clone / commit-push. Keep ONE
 * definition so every gate agrees — re-exported from
 * `mcp-server/tools/_passthrough.ts` for existing callers.
 *
 * The gate is keyed to the EXECUTING worker's home (os.homedir()), not a literal
 * path: these MCP tools run on the node they target (the hub relays the call to
 * that worker), so the home dir is correct for each host — /home/ubuntu, /home/yi,
 * C:\Users\yi, etc. `home` is injectable for testing.
 */
import * as os from 'os';

export function isCwdAllowed(cwd: string, home: string = os.homedir()): boolean {
  if (!cwd) return false;
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const c = norm(cwd);
  const h = norm(home);
  if (!h) return false;
  return c === h || c.startsWith(h + '/');
}
