/**
 * Shareability classifier for memory files
 *
 * Decides whether a memory file in `memory/<other-host>/` should be
 * surfaced to other hosts via the cross-host endpoint.
 *
 *   - 'host-local'      → tied to one machine (Chrome flags, PowerShell
 *                         pitfalls, voice-mic bridge). Never auto-suggest.
 *   - 'project-domain'  → portable knowledge about the project itself
 *                         (broker boundary, Kelly architecture, engine
 *                         ownership). Auto-suggest by default.
 *   - 'ambiguous'       → cannot decide from filename + description.
 *                         Hidden by default, opt-in via ?include=ambiguous.
 *
 * Classification is best-effort. Patterns match the project's existing
 * `memory/<host-id>/` files; tweak if false positives appear.
 */

import type { MemoryFrontmatter } from './frontmatter';

export type Shareability = 'host-local' | 'project-domain' | 'ambiguous';

/** Filename patterns that mark a memory as host-local on sight. */
const HOST_LOCAL_FILENAME_PATTERNS: RegExp[] = [
  /chrome/i,
  /powershell/i,
  /windows/i,
  /\bgpu\b/i,
  /voice_?mic/i,
  /mobile_?coord/i,
  /remote_(hosts|claude)/i,
  /oci_cli/i,
  /perf_diagnosis/i,
  /4k_hdr/i,
  /trade_web_perf_leak/i,  // explicitly a Windows-host bug
];

/** Description phrases that indicate host-local content. */
const HOST_LOCAL_DESCRIPTION_PHRASES: RegExp[] = [
  /this machine/i,
  /on windows/i,
  /on linux/i,
  /\bps5\.1\b/i,
  /4k@/i,
  /\bhdr\b/i,
  /cpu delta/i,
  /\bnssdb\b/i,
];

/** Filename prefixes that are inherently project-domain. */
const PROJECT_DOMAIN_PREFIXES = ['project_', 'research_'];

export function classifyShareability(
  filename: string,
  frontmatter: MemoryFrontmatter,
): Shareability {
  // 1) Filename gives the strongest signal
  for (const re of HOST_LOCAL_FILENAME_PATTERNS) {
    if (re.test(filename)) return 'host-local';
  }

  // 2) Then frontmatter type + description
  if (frontmatter.type === 'reference') {
    // References to credentials/infra are usually host-local
    return 'host-local';
  }

  if (PROJECT_DOMAIN_PREFIXES.some(p => filename.toLowerCase().startsWith(p))) {
    return 'project-domain';
  }

  const desc = frontmatter.description || '';
  if (HOST_LOCAL_DESCRIPTION_PHRASES.some(re => re.test(desc))) {
    return 'host-local';
  }

  // 3) Feedback type with project-flavoured description → project-domain
  if (frontmatter.type === 'feedback') {
    return 'project-domain';
  }

  // 4) User-type defaults to project-domain (user preferences travel)
  if (frontmatter.type === 'user') {
    return 'project-domain';
  }

  return 'ambiguous';
}
