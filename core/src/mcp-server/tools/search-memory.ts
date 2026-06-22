/**
 * search_memory tool — grep across the user's curated Claude memory files
 * for a project. Searches both the live auto-memory dir and (optionally)
 * the repo-mirrored memory from other hosts.
 *
 * MemoryCache.getForProject returns MemoryFile entries with `bodyPreview`
 * (first ~500 chars) and `frontmatter.{name,description,type}`. For
 * full-body matches we read the file from `filePath` on disk.
 */

import * as fs from 'fs';
import { getMemoryCache } from '../../memory-cache';
import { getProjectsDir, decodePath } from '../../utils/path-utils';

export { searchMemoryToolDef } from './definitions';

const MAX_BODY_BYTES = 200_000;

/**
 * Enumerate every Claude project cwd that has an on-disk project slug under
 * `~/.claude/projects/`. Used when the caller omits `project` — "search my
 * memory" should sweep ALL projects, not the lm-assist server's process.cwd()
 * (which is the npm install dir and has no memory/, so the old default always
 * returned "no results"). Mirrors memory-cache.startWatching()'s discovery.
 */
function listAllProjectCwds(): string[] {
  let slugs: string[] = [];
  try {
    slugs = fs.readdirSync(getProjectsDir());
  } catch {
    return [];
  }
  const cwds: string[] = [];
  const seen = new Set<string>();
  for (const slug of slugs) {
    if (slug.startsWith('.')) continue;
    let cwd: string;
    try {
      cwd = decodePath(slug);
    } catch {
      continue;
    }
    if (cwd && !seen.has(cwd)) {
      seen.add(cwd);
      cwds.push(cwd);
    }
  }
  return cwds;
}

/** Short, human label for a project cwd (its basename), for tagging hits. */
function projectLabel(cwd: string): string {
  const base = cwd.split(/[\\/]/).filter(Boolean).pop();
  return base || cwd;
}

function readBodyOnce(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return '';
    const fd = fs.openSync(filePath, 'r');
    try {
      const len = Math.min(stat.size, MAX_BODY_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, 0);
      return buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function snippet(body: string, query: string, ctxChars = 80): string {
  const lower = body.toLowerCase();
  const q = query.toLowerCase();
  const i = lower.indexOf(q);
  if (i < 0) {
    return body.slice(0, 160).replace(/\s+/g, ' ').trim();
  }
  const start = Math.max(0, i - ctxChars);
  const end = Math.min(body.length, i + q.length + ctxChars);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < body.length ? '…' : '';
  return (prefix + body.slice(start, end) + suffix).replace(/\s+/g, ' ').trim();
}

export async function handleSearchMemory(args: Record<string, unknown>): Promise<{
  content: Array<{ type: string; text: string }>;
}> {
  const query = String(args.query || '').trim();
  if (!query) {
    return { content: [{ type: 'text', text: 'Error: query is required' }] };
  }

  const explicitProject = (args.project as string | undefined)?.trim() || undefined;
  const includeRepo = Boolean(args.include_repo_mirror);
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);
  const q = query.toLowerCase();
  // Split into individual terms. A file matches when EVERY term appears
  // somewhere in its searchable text — multi-word queries no longer require the
  // words to be contiguous (e.g. "crossing zebra" matches "zebra crossing").
  // A single-term query reduces to the previous substring behaviour.
  const terms = q.split(/\s+/).filter(Boolean);

  // No project given → sweep ALL projects' memory (the natural "search my
  // memory" intent). Only scope to one project when the caller names it.
  const targets = explicitProject ? [explicitProject] : listAllProjectCwds();
  const scopeLabel = explicitProject
    ? `project ${explicitProject}`
    : `all projects (${targets.length})`;

  let cache: ReturnType<typeof getMemoryCache>;
  try {
    cache = getMemoryCache();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: 'text', text: `Memory cache error: ${msg}` }] };
  }

  type Hit = {
    project: string;
    source: string;
    filename: string;
    title?: string;
    description?: string;
    snippet: string;
    score: number;
  };
  const hits: Hit[] = [];

  for (const cwd of targets) {
    let projectMemory;
    try {
      projectMemory = cache.getForProject(cwd, { sources: includeRepo ? 'all' : 'live' });
    } catch {
      // A single unreadable project shouldn't sink the whole sweep.
      continue;
    }
    const label = projectLabel(cwd);

    for (const dir of projectMemory.dirs) {
      for (const file of (dir.files || []) as Array<{
        source: string;
        filename: string;
        filePath: string;
        frontmatter?: { name?: string; description?: string };
        bodyPreview?: string;
      }>) {
        const filename = file.filename || '';
        const title = file.frontmatter?.name || '';
        const description = file.frontmatter?.description || '';

        const fnLower = filename.toLowerCase();
        const titleLower = title.toLowerCase();
        const descLower = description.toLowerCase();
        const prevLower = (file.bodyPreview || '').toLowerCase();
        const metaText = `${fnLower}\n${titleLower}\n${descLower}\n${prevLower}`;

        // Cheap pre-filter on metadata + preview before doing the disk read.
        // Hit when every term is present across the combined metadata/preview;
        // otherwise fall back to a single full-body read.
        let bodyForSnippet = file.bodyPreview || '';
        let fullBody = '';
        let matched = terms.every((t) => metaText.includes(t));
        if (!matched) {
          fullBody = readBodyOnce(file.filePath);
          if (fullBody) {
            const unionText = `${metaText}\n${fullBody.toLowerCase()}`;
            matched = terms.every((t) => unionText.includes(t));
            if (matched) bodyForSnippet = fullBody;
          }
        }

        if (!matched) continue;

        // Per-field score: a field earns its weight when it contains the whole
        // phrase or (for multi-term queries) any of the terms.
        const fieldHit = (text: string): boolean =>
          text.includes(q) || (terms.length > 1 && terms.some((t) => text.includes(t)));
        const score =
          (fieldHit(fnLower) ? 3 : 0) +
          (fieldHit(titleLower) ? 3 : 0) +
          (fieldHit(descLower) ? 2 : 0) +
          (fieldHit(prevLower) ? 1 : 0) +
          (fullBody && fieldHit(fullBody.toLowerCase()) ? 1 : 0);

        hits.push({
          project: label,
          source: file.source || 'live',
          filename,
          title,
          description,
          snippet: snippet(bodyForSnippet, query),
          score,
        });
      }
    }
  }

  if (hits.length === 0) {
    const sources = includeRepo ? 'live + repo mirrors' : 'live';
    return {
      content: [
        {
          type: 'text',
          text: `No memory files match "${query}" across ${scopeLabel} (sources: ${sources}).`,
        },
      ],
    };
  }

  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, limit);

  const lines: string[] = [
    `Memory matches for "${query}" (${top.length} of ${hits.length}, ${scopeLabel}):`,
    '',
  ];
  for (const h of top) {
    const tag = h.source === 'live' ? '[live]' : `[${h.source}]`;
    lines.push(`${tag} {${h.project}} ${h.filename}${h.title ? `  — ${h.title}` : ''}`);
    if (h.description) lines.push(`  ${h.description}`);
    lines.push(`  > ${h.snippet}`);
    lines.push('');
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
