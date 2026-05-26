/**
 * list_projects tool — aggregate sessions by cwd, return projects with
 * activity stats sorted by recency.
 */

import { getSessionCache } from '../../session-cache';

export { listProjectsToolDef } from './definitions';

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

export async function handleListProjects(args: Record<string, unknown>): Promise<{
  content: Array<{ type: string; text: string }>;
}> {
  const rawScope = (args.scope as string) || '30d';
  const scope: Scope = rawScope in SCOPE_MS ? (rawScope as Scope) : '30d';
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);

  const cache = getSessionCache();
  const all = cache.getAllSessionsFromCache();
  const cutoff = scope === 'all' ? 0 : Date.now() - SCOPE_MS[scope];

  // Group by cwd
  const byProject = new Map<string, { sessions: number; lastMtime: number }>();
  for (const s of all) {
    const cwd = s.cacheData?.cwd;
    const m = s.cacheData?.fileMtime;
    if (!cwd || !m || m < cutoff) continue;
    const prev = byProject.get(cwd);
    if (prev) {
      prev.sessions += 1;
      if (m > prev.lastMtime) prev.lastMtime = m;
    } else {
      byProject.set(cwd, { sessions: 1, lastMtime: m });
    }
  }

  if (byProject.size === 0) {
    return {
      content: [{ type: 'text', text: `No projects with activity within scope=${scope}.` }],
    };
  }

  const projects = Array.from(byProject.entries())
    .map(([cwd, v]) => ({ cwd, sessions: v.sessions, lastMtime: v.lastMtime }))
    .sort((a, b) => b.lastMtime - a.lastMtime)
    .slice(0, limit);

  const lines: string[] = [
    `Projects (${projects.length}, scope=${scope}, sorted by recency):`,
    '',
  ];
  for (const p of projects) {
    lines.push(`${p.cwd}`);
    lines.push(`  ${p.sessions} session${p.sessions === 1 ? '' : 's'}  ·  last ${fmtRelative(p.lastMtime)}`);
    lines.push(`  → list_recent_sessions(project="${p.cwd}")`);
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
