/**
 * Single source of truth for the operator's directory allowlist (defense-in-depth).
 *
 * Per operator decision: any directory under /home/ubuntu is permitted. Used by
 * `agent_execute` / `terminal_open_tab` (MCP) and by the github git backend's
 * directory-targeted clone / commit-push. Keep ONE definition so every gate
 * agrees — re-exported from `mcp-server/tools/_passthrough.ts` for existing callers.
 */
export function isCwdAllowed(cwd: string): boolean {
  if (!cwd) return false;
  const norm = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  return norm === '/home/ubuntu' || norm.startsWith('/home/ubuntu/');
}
