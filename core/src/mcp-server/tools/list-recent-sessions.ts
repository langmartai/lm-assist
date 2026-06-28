/**
 * list_recent_sessions tool — recent Claude Code sessions, newest first.
 *
 * Returns the LAST ~20 real user prompts per session so the model has
 * enough context to know which session is which. Drops metadata noise
 * (cwd, model, turn count) entirely.
 */

import { getSessionCache, isRealUserPrompt } from '../../session-cache';
import { repoOfCached } from '../../utils/repo-id';

export { listRecentSessionsToolDef } from './definitions';

type Scope = '24h' | '3d' | '7d' | '30d' | 'all';
const SCOPE_MS: Record<Scope, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  'all': Infinity,
};

function fmtRelative(ms: number): string {
  const age = Date.now() - ms;
  if (age < 60_000) return 'just now';
  if (age < 3600_000) return `${Math.floor(age / 60_000)}m ago`;
  if (age < 86400_000) return `${Math.floor(age / 3600_000)}h ago`;
  if (age < 30 * 86400_000) return `${Math.floor(age / 86400_000)}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

function clip(s: string | undefined, n: number): string {
  if (!s) return '';
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > n ? oneLine.slice(0, n - 1) + '…' : oneLine;
}

export async function handleListRecentSessions(args: Record<string, unknown>): Promise<{
  content: Array<{ type: string; text: string }>;
}> {
  const rawScope = (args.scope as string) || '7d';
  const scope: Scope = rawScope in SCOPE_MS ? (rawScope as Scope) : '7d';
  const project = args.project as string | undefined;
  const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
  const promptsPerSession = Math.min(Math.max(Number(args.prompts_per_session) || 20, 1), 50);
  const promptCharLimit = Math.min(Math.max(Number(args.prompt_char_limit) || 120, 40), 500);

  const cache = getSessionCache();
  const all = cache.getAllSessionsFromCache();
  const cutoff = scope === 'all' ? 0 : Date.now() - SCOPE_MS[scope];

  const filtered = all
    .filter((s) => {
      const m = s.cacheData?.fileMtime;
      if (!m || m < cutoff) return false;
      if (project && s.cacheData?.cwd !== project) return false;
      return true;
    })
    .sort((a, b) => (b.cacheData?.fileMtime || 0) - (a.cacheData?.fileMtime || 0))
    .slice(0, limit);

  if (filtered.length === 0) {
    const where = project ? ` in ${project}` : '';
    return {
      content: [{ type: 'text', text: `No code sessions${where} within scope=${scope}.` }],
    };
  }

  const lines: string[] = [
    `Recent code sessions (${filtered.length}, scope=${scope}, last ${promptsPerSession} prompts per session):`,
    '',
  ];
  for (const s of filtered) {
    const sid = s.sessionId;
    const cd = s.cacheData;
    const when = cd?.fileMtime ? fmtRelative(cd.fileMtime) : '?';
    const allPrompts = (cd?.userPrompts || []).filter(isRealUserPrompt);

    lines.push(`━━━ ${sid}  ·  ${when}  ·  ${allPrompts.length} user prompts ━━━`);
    // Per-resource project/repo provenance (which codebase this session ran in).
    const rid = repoOfCached(cd?.cwd);
    if (rid) lines.push(`  project: ${rid.project}${rid.repo ? `  ·  repo: ${rid.repo}` : ''}`);
    if (allPrompts.length === 0) {
      lines.push('  (no real user prompts in cache)');
    } else {
      // Newest first: take the last N, but render with the OLDEST of those first
      // so the reader sees chronological context flowing into the latest.
      const tail = allPrompts.slice(-promptsPerSession);
      for (let i = 0; i < tail.length; i++) {
        const p = tail[i];
        const idx = allPrompts.length - tail.length + i;
        lines.push(`  [${idx}] ${clip(p.text, promptCharLimit)}`);
      }
      if (allPrompts.length > tail.length) {
        lines.push(`  (${allPrompts.length - tail.length} earlier prompts omitted — use detail("${sid}", section="conversation") for the full thread)`);
      }
    }
    lines.push(`  → detail("${sid}")`);
    lines.push('');
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
