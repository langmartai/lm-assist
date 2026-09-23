/**
 * Pure planner for the `terminal_open_tab` MCP tool: decides which worker route
 * to hit and assembles the request body. Extracted so it is unit-testable
 * without the worker HTTP hop.
 */
import { isCwdAllowed, describeCwdPolicy } from '../../utils/cwd-allowlist';

export type OpenTabPlan = { error: string } | { route: string; body: Record<string, unknown> };

export function planOpenTab(args: Record<string, unknown>): OpenTabPlan {
  const command = String(args.command || '').trim();
  if (!command) return { error: 'command is required.' };

  const cwd = args.cwd ? String(args.cwd) : '';
  if (cwd && !isCwdAllowed(cwd)) {
    return { error: `cwd "${cwd}" is not permitted; allowed: ${describeCwdPolicy()}` };
  }

  // No explicit kind -> the platform-neutral /terminal/local route, whose backend
  // is auto-picked per host (tmux on Linux, wt on Windows). This is what lets the
  // tool run a command on a Windows node, where the gnome|wt-ssh|tmux kinds (the
  // /terminal/tabs spawner) don't apply.
  if (args.kind === undefined || args.kind === null || args.kind === '') {
    const body: Record<string, unknown> = { command };
    if (cwd) body.cwd = cwd;
    return { route: '/terminal/local', body };
  }

  // Explicit kind -> the advanced gnome/wt-ssh/tmux tab spawner. Forward ALL of
  // its parameters; previously sshTarget and tmuxSession were dropped, so wt-ssh
  // and tmux failed "requires X" even when the caller supplied them.
  const body: Record<string, unknown> = { command, kind: String(args.kind) };
  if (cwd) body.cwd = cwd;
  if (args.title) body.title = String(args.title);
  if (args.sshTarget) body.sshTarget = String(args.sshTarget);
  if (args.tmuxSession) body.tmuxSession = String(args.tmuxSession);
  if (args.env && typeof args.env === 'object') body.env = args.env;
  if (args.cols !== undefined && args.cols !== null) body.cols = args.cols;
  if (args.rows !== undefined && args.rows !== null) body.rows = args.rows;
  if (args.windowGroup !== undefined && args.windowGroup !== null) body.windowGroup = args.windowGroup;
  return { route: '/terminal/tabs', body };
}
