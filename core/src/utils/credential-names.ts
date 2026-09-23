/**
 * Credential-shaped FILENAMES — never shipped off this host, whatever their shareability.
 *
 * One module for every path that moves memory or rules off-box (memory autosync + merge
 * ingest, the memory-sync export route, rule sync, and data-bundle's claude-memory /
 * claude-rules sections). They used to carry four inline copies; a copy that drifts is a
 * filter some export path silently stops applying.
 *
 * The two families deliberately keep the `key` form they ALREADY had — changing it would
 * change which real files sync:
 *   - memory uses `\bkey\b`, so `api_key.md` / `no_prod_key_notes.md` (underscore = word
 *     char) are NOT credential-named and keep syncing, while `api-key.md` / `key.md` are.
 *   - rules use a letters-only boundary, so `api_key.md` IS credential-named there.
 * Neither matches `monkey.md` or `keyboard.md`.
 */
const COMMON: readonly RegExp[] = [/token/i, /cookie/i, /password/i, /secret/i, /credential/i];

/** Memory files (autosync, merge-ingest, /memory/export, bundle claude-memory). */
export const MEMORY_CREDENTIAL_PATTERNS: readonly RegExp[] = [...COMMON, /\bkey\b/i];

/** Rule files (rule sync, bundle claude-rules). */
export const RULE_CREDENTIAL_PATTERNS: readonly RegExp[] = [...COMMON, /(?<![a-zA-Z])key(?![a-zA-Z])/i];

/** True when a memory file NAME (a basename) looks like a credential. */
export function isCredentialMemoryName(name: string): boolean {
  return MEMORY_CREDENTIAL_PATTERNS.some((re) => re.test(name));
}

/** True when a rule file NAME (a basename) looks like a credential. */
export function isCredentialRuleName(name: string): boolean {
  return RULE_CREDENTIAL_PATTERNS.some((re) => re.test(name));
}
