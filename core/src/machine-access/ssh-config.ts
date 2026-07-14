/**
 * Minimal ~/.ssh/config → machine-access import.
 *
 * Pure, dependency-free. Parses concrete `Host` blocks into draft profiles the
 * node owner can review, annotate (with the operational notes an import can't
 * know), reachability-check, and enable. Drafts are `enabled:false` and tagged
 * `imported` — inert until the owner turns them on.
 *
 * Deliberate limitations (documented in the spec): no `Include` expansion, no
 * `Match` blocks, wildcard `Host` patterns (`*`/`?`) are skipped (not machines).
 */
import { validateProfile, type MachineProfile } from './store';

export interface SshConfigHost {
  alias: string;
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

/** Slugify an ssh Host alias into a valid machine id: [a-z0-9][a-z0-9._-]* ≤64. */
export function slugifyAlias(alias: string): string {
  const s = alias.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return /^[a-z0-9]/.test(s) ? s : `h-${s}`.slice(0, 64);
}

function isWildcard(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?') || pattern === '!';
}

/** Parse ssh_config text into concrete (non-wildcard) host entries. */
export function parseSshConfig(text: string): SshConfigHost[] {
  const out: SshConfigHost[] = [];
  let current: SshConfigHost[] = []; // the aliases sharing the block currently being read
  const flush = () => { for (const h of current) out.push(h); current = []; };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    // key/value: "Key value" or "Key=value"; key is case-insensitive.
    const m = line.match(/^([A-Za-z]+)\s*=?\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'host') {
      flush();
      const patterns = value.split(/\s+/).filter((p) => p && !isWildcard(p));
      current = patterns.map((alias) => ({ alias }));
      continue;
    }
    if (current.length === 0) continue; // setting outside any Host block — ignore
    for (const h of current) {
      if (key === 'hostname') h.hostName = value;
      else if (key === 'user') h.user = value;
      else if (key === 'port') { const n = parseInt(value, 10); if (Number.isInteger(n)) h.port = n; }
      else if (key === 'identityfile') h.identityFile = value;
    }
  }
  flush();
  return out;
}

/** Build reviewable draft profiles from parsed hosts. Drops any that fail validation. */
export function buildImportCandidates(
  hosts: SshConfigHost[],
  opts: { defaultUser: string },
): { candidates: MachineProfile[]; skippedInvalid: Array<{ alias: string; reason: string }> } {
  const candidates: MachineProfile[] = [];
  const skippedInvalid: Array<{ alias: string; reason: string }> = [];
  for (const h of hosts) {
    const ssh: Record<string, unknown> = {
      type: 'ssh',
      host: h.hostName || h.alias, // no HostName → the alias IS the host
      user: h.user || opts.defaultUser,
    };
    if (h.port !== undefined) ssh.port = h.port;
    if (h.identityFile) ssh.identityFile = h.identityFile;
    const profile: MachineProfile = {
      id: slugifyAlias(h.alias),
      name: h.alias,
      tags: ['imported'],
      enabled: false, // drafts are inert until the owner reviews + enables
      notes: 'Imported from ~/.ssh/config — review, add operational notes, run check, then enable.',
      access: [ssh as unknown as MachineProfile['access'][number]],
    };
    const err = validateProfile(profile);
    if (err) skippedInvalid.push({ alias: h.alias, reason: err });
    else candidates.push(profile);
  }
  return { candidates, skippedInvalid };
}
