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

export { searchMemoryToolDef } from './definitions';

const MAX_BODY_BYTES = 200_000;

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

  const project = (args.project as string | undefined) || process.cwd();
  const includeRepo = Boolean(args.include_repo_mirror);
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);
  const q = query.toLowerCase();

  let projectMemory;
  try {
    projectMemory = getMemoryCache().getForProject(project, {
      sources: includeRepo ? 'all' : 'live',
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: 'text', text: `Memory cache error: ${msg}` }] };
  }

  type Hit = {
    source: string;
    filename: string;
    title?: string;
    description?: string;
    snippet: string;
    score: number;
  };
  const hits: Hit[] = [];

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

      // Cheap pre-filter on metadata + preview before doing the disk read
      const inFilename = filename.toLowerCase().includes(q);
      const inTitle = title.toLowerCase().includes(q);
      const inDesc = description.toLowerCase().includes(q);
      const inPreview = (file.bodyPreview || '').toLowerCase().includes(q);

      let inBody = false;
      let bodyForSnippet = file.bodyPreview || '';
      if (!inFilename && !inTitle && !inDesc && !inPreview) {
        // Fall back to full-body read for files where the preview doesn't capture it
        const full = readBodyOnce(file.filePath);
        if (full && full.toLowerCase().includes(q)) {
          inBody = true;
          bodyForSnippet = full;
        }
      } else if (inPreview) {
        bodyForSnippet = file.bodyPreview || '';
      }

      if (!(inFilename || inTitle || inDesc || inPreview || inBody)) continue;

      const score =
        (inFilename ? 3 : 0) +
        (inTitle ? 3 : 0) +
        (inDesc ? 2 : 0) +
        (inPreview ? 1 : 0) +
        (inBody ? 1 : 0);

      hits.push({
        source: file.source || 'live',
        filename,
        title,
        description,
        snippet: snippet(bodyForSnippet, query),
        score,
      });
    }
  }

  if (hits.length === 0) {
    const sources = includeRepo ? 'live + repo mirrors' : 'live';
    return {
      content: [
        {
          type: 'text',
          text: `No memory files match "${query}" for project ${project} (sources: ${sources}).`,
        },
      ],
    };
  }

  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, limit);

  const lines: string[] = [
    `Memory matches for "${query}" (${top.length} of ${hits.length}, project=${project}):`,
    '',
  ];
  for (const h of top) {
    const tag = h.source === 'live' ? '[live]' : `[${h.source}]`;
    lines.push(`${tag} ${h.filename}${h.title ? `  — ${h.title}` : ''}`);
    if (h.description) lines.push(`  ${h.description}`);
    lines.push(`  > ${h.snippet}`);
    lines.push('');
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
