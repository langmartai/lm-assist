/**
 * list_recent_sessions tool — recent Claude Code sessions, newest first.
 */

import { getSessionCache } from '../../session-cache';

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

export async function handleListRecentSessions(args: Record<string, unknown>): Promise<{
  content: Array<{ type: string; text: string }>;
}> {
  const rawScope = (args.scope as string) || '7d';
  const scope: Scope = rawScope in SCOPE_MS ? (rawScope as Scope) : '7d';
  const project = args.project as string | undefined;
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);

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
      content: [{ type: 'text', text: `No sessions${where} within scope=${scope}.` }],
    };
  }

  const lines: string[] = [`Recent sessions (${filtered.length}, scope=${scope}):`, ''];
  for (const s of filtered) {
    const sid = s.sessionId;
    const cd = s.cacheData;
    const cwd = cd?.cwd || '?';
    const model = cd?.model || '?';
    const turns = cd?.lastTurnIndex ?? 0;
    const when = cd?.fileMtime ? fmtRelative(cd.fileMtime) : '?';
    lines.push(`${sid.slice(0, 8)}…  ${when}  ${cwd}  [${model}]  turns=${turns}`);
    lines.push(`  → detail("${sid}")`);
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
