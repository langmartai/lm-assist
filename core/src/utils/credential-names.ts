/**
 * Credential-shaped FILENAMES — never shipped off this host, whatever their shareability.
 *
 * One list for every path that moves memory or rules off-box (memory autosync + merge
 * ingest, the memory-sync export route, rule sync, and data-bundle's claude-memory /
 * claude-rules sections). They used to carry four copies with two different `key` forms;
 * a copy that drifts is a filter some export path silently stops applying.
 *
 * `key` is matched as a standalone token: `api-key.md`, `api_key.md` and `key.md` match,
 * `monkey.md` and `keyboard.md` do not.
 */
export const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /token/i,
  /(?<![a-zA-Z])key(?![a-zA-Z])/i,
  /cookie/i,
  /password/i,
  /secret/i,
  /credential/i,
];

/** True when a file NAME (a basename — pass path.basename for a path) looks like a credential. */
export function isCredentialName(name: string): boolean {
  return CREDENTIAL_PATTERNS.some((re) => re.test(name));
}
