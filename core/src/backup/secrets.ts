/**
 * Capture-time secret exclusion.
 *
 * WHY THIS FILE EXISTS. The PowerShell implementation kept secrets out of the
 * GitHub repo with a `.gitignore` that excluded every payload directory. That
 * worked — the remote holds 6 files, 41 KB, all scripts and status, and no
 * credential has ever been pushed. But it protects the PUSH, not the CAPTURE:
 * verified on 2026-07-29 the local store held a live Claude Code OAuth token
 * (`windows-desk/.claude/.credentials.json`), three live claude.ai session
 * cookie files, and a whole Chrome profile — and each remote tarball is
 * `tar czf - .claude`, so it carries that host's token too. One line in a
 * `.gitignore` was the only thing between live tokens and a public repo.
 *
 * So the filter moved to capture. Nothing secret enters the store in the first
 * place, and `backup_status` reports the exclusion count so the guard is
 * visible rather than assumed.
 *
 * WHAT IS *NOT* EXCLUDED, deliberately: sessions, `projects/*.memory`, `rules/`,
 * `settings.json`, `history.jsonl`, `tasks/`, plugins and claude.ai
 * conversations are backed up fully and exactly. Losing a token costs one
 * login; losing a transcript is permanent. The things worth backing up are
 * exactly the things that are not secrets.
 */

import { sensitiveReadReason } from '../file-transfer/fs-inspect';

/**
 * `.claude`-specific paths the generic deny-list does not know about. Matched
 * against a POSIX-style path RELATIVE to the `.claude` directory being
 * captured, so they apply identically to a Windows mirror and a Linux tarball.
 */
const CLAUDE_SECRET_RULES: { test: RegExp; reason: string }[] = [
  { test: /^\.credentials\.json$/i, reason: 'live Claude Code OAuth token' },
  { test: /^claudeai-session[^/]*\.json$/i, reason: 'live claude.ai session cookies' },
  { test: /^claudeai-browser-profile(\/|$)/i, reason: 'Chrome profile — contains the cookie database' },
  { test: /^chrome(\/|$)/i, reason: 'browser state / profile data' },
  { test: /^ide(\/|$)/i, reason: 'IDE lockfiles carrying ports and auth tokens' },
  { test: /^mcp-needs-auth-cache\.json$/i, reason: 'MCP auth state cache' },
];

/**
 * Why this path must not be captured, or null to capture it.
 *
 * `relPath` is relative to the captured `.claude` root, POSIX separators.
 * `absPath` (optional) additionally runs the shared lm-assist deny-list —
 * `sensitiveReadReason` already refuses `.credentials.json`, `.ssh/`, `.env`,
 * `*.pem`, `*.key` and `~/.lm-assist`, and reusing it means there is ONE list
 * to keep correct instead of two that drift.
 */
export function excludeReason(relPath: string, absPath?: string): string | null {
  const rel = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  for (const rule of CLAUDE_SECRET_RULES) {
    if (rule.test.test(rel)) return rule.reason;
  }
  if (absPath) {
    const shared = sensitiveReadReason(absPath);
    if (shared) return shared;
  }
  // Apply the shared list to the relative path too, so a tarball member is
  // filtered even though it has no local absolute path to resolve.
  const asPath = sensitiveReadReason(rel);
  if (asPath) return asPath;
  return null;
}

/**
 * WHY THE LOCAL MIRROR IS NOT `robocopy /XF`.
 *
 * 🔴 `/XF` IS NOT RETROACTIVE. Robocopy skips an excluded file, and `/MIR` only
 * deletes destination files it actually considered — so a secret ALREADY in the
 * mirror is neither copied nor removed. It just stays. Had the port kept
 * robocopy and simply added `/XF .credentials.json`, the live OAuth token
 * captured in July would have sat in the store forever while `backup_status`
 * cheerfully reported secrets excluded.
 *
 * `capture.ts` therefore walks the tree itself and prunes destination files the
 * policy no longer allows, so adding an exclusion CLEANS the store rather than
 * merely stopping the next copy. Purging what the PowerShell era captured is
 * still surfaced as an explicit `backup_remove` step — deleting user data is
 * not a silent side effect of a backup run — but the mechanism exists.
 */

/**
 * Build the `tar --exclude` arguments for a remote snapshot. Paths are relative
 * to the tar's working directory, which is the remote `$HOME`, so they are
 * prefixed with `.claude/`.
 */
export function tarExcludeArgs(): string[] {
  return [
    '.claude/.credentials.json',
    '.claude/claudeai-session*.json',
    '.claude/claudeai-browser-profile',
    '.claude/chrome',
    '.claude/ide',
    '.claude/mcp-needs-auth-cache.json',
    '.claude/**/.env',
    '.claude/**/*.pem',
    '.claude/**/*.key',
  ].map((p) => `--exclude=${p}`);
}
