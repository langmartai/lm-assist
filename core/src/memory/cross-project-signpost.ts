/**
 * Cross-project memory signpost.
 *
 * lm-assist writes a managed `_cross-project.md` into every project's memory dir (+ a one-line
 * MEMORY.md pointer) so an LLM recalling THIS project's memory knows it can pull OTHER projects'
 * curated memory on demand via the langmart MCP tools. The file is regenerated locally per node;
 * it is excluded from knowledge records and from cross-node sync.
 *
 * See docs/superpowers/specs/2026-06-23-cross-project-memory-signpost-design.md
 */

import * as fs from 'fs';
import * as path from 'path';
import { createMemoryApiImpl } from '../api/memory-api';
import { getProjectsDir } from '../utils/path-utils';
import { getProjectSettings } from '../project-settings';

export const SIGNPOST_VERSION = 1;
export const SIGNPOST_FILE = '_cross-project.md';
const MANAGED_HEADER = '<!-- managed by lm-assist — do not edit; regenerated automatically -->';
export const POINTER_LINE =
  `- [Cross-Project Memory](${SIGNPOST_FILE}) — other projects' memory via langmart MCP (managed)`;

export interface ProjectRef {
  slug: string;
  name: string;
  hook?: string;
}

/** Render the signpost markdown: a static tool-list instruction + the live "other projects" list. */
export function renderSignpost(_self: ProjectRef, others: ProjectRef[]): string {
  const lines: string[] = [
    MANAGED_HEADER,
    `<!-- lm-assist:cross-project v${SIGNPOST_VERSION} -->`,
    '',
    '# Cross-Project Memory',
    '',
    "This lm-assist node curates memory for MULTIPLE projects. When THIS project's own memory is thin,",
    'or a question spans projects / references shared infra or conventions, pull another project\'s',
    'curated memory on demand via the **langmart MCP** tools:',
    '',
    '- `memory_projects` — list every project with curated memory (+ its slug).',
    "- `detail` / by-project read (`getByProject`) — read another project's memory by slug.",
    '- `search_memory` — search memory across projects.',
    '- `memory_cross_host` — portable knowledge mirrored from other hosts.',
    '',
    "Prefer THIS project's memory first; reach cross-project when it adds value.",
    '',
    '## Other projects on this node',
    '',
  ];
  if (others.length === 0) {
    lines.push('_(no other projects with curated memory yet)_');
  } else {
    for (const o of others) {
      const hook = o.hook && o.hook.trim() ? ` — ${o.hook.trim()}` : '';
      lines.push(`- **${o.name}** (\`${o.slug}\`)${hook}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Write the signpost file into a project's memory dir and ensure its MEMORY.md carries the managed
 * pointer line. Idempotent: the file is rewritten only when `content` changes; the pointer is added
 * only if absent (a minimal MEMORY.md is created if none exists). Returns what actually changed.
 */
export function ensureSignpostFor(liveMemDir: string, content: string): { wroteFile: boolean; wrotePointer: boolean } {
  fs.mkdirSync(liveMemDir, { recursive: true });

  const filePath = path.join(liveMemDir, SIGNPOST_FILE);
  let wroteFile = false;
  let prev = '';
  try { prev = fs.readFileSync(filePath, 'utf-8'); } catch { /* none yet */ }
  if (prev !== content) { fs.writeFileSync(filePath, content); wroteFile = true; }

  const indexPath = path.join(liveMemDir, 'MEMORY.md');
  let index = '';
  try { index = fs.readFileSync(indexPath, 'utf-8'); } catch { /* none yet */ }
  let wrotePointer = false;
  if (!index.includes(`(${SIGNPOST_FILE})`)) {
    const head = index ? '' : '# Memory Index\n\n';
    const sep = index && !index.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(indexPath, `${head}${index}${sep}${POINTER_LINE}\n`);
    wrotePointer = true;
  }
  return { wroteFile, wrotePointer };
}

// ─── Sweep: write the signpost into every local project ─────────────

export interface ProjectSummaryLite {
  projectId: string;
  projectPath: string;
  hasLive: boolean;
  fileCount: number;
}

export interface SweepResult { swept: number; skipped: number; filesWritten: number; disabled?: boolean; }

function nameFromPath(p: string): string { return path.basename(p) || p; }

/** Pure: projects eligible for a signpost — has live memory and not excluded. */
export function selectEligible(summaries: ProjectSummaryLite[], excludedPaths: string[]): ProjectSummaryLite[] {
  const excluded = new Set(excludedPaths);
  return summaries.filter((s) => s.hasLive && !excluded.has(s.projectPath));
}

/** A stable one-line hook for a project: its MEMORY.md first real title/prose, else "<n> memory entries".
 *  Ignores our managed boilerplate (the `# Memory Index` heading + the pointer line) so it stays stable. */
function hookFor(liveMemDir: string, fileCount: number): string {
  try {
    const idx = fs.readFileSync(path.join(liveMemDir, 'MEMORY.md'), 'utf-8');
    for (const raw of idx.split('\n')) {
      const t = raw.trim();
      if (!t || t.startsWith('<!--') || t.startsWith('-') || t.includes(SIGNPOST_FILE)) continue;
      const h = t.replace(/^#+\s*/, '').trim();
      if (!h || h === 'Memory Index') continue; // our boilerplate title
      return h.slice(0, 80);
    }
  } catch { /* no index */ }
  return `${fileCount} memory entr${fileCount === 1 ? 'y' : 'ies'}`;
}

/** Write/refresh the managed signpost into every eligible local project. Gated by the setting. */
export async function sweepAllProjects(): Promise<SweepResult> {
  if (!getProjectSettings().crossProjectSignpostEnabled) {
    return { swept: 0, skipped: 0, filesWritten: 0, disabled: true };
  }
  const res = await createMemoryApiImpl().listProjects();
  const all: ProjectSummaryLite[] = (res.success && Array.isArray(res.data)) ? res.data as any : [];
  const eligible = selectEligible(all, getProjectSettings().excludedPaths);

  const refs: ProjectRef[] = eligible.map((s) => ({
    slug: s.projectId,
    name: nameFromPath(s.projectPath),
    hook: hookFor(path.join(getProjectsDir(), s.projectId, 'memory'), s.fileCount),
  }));

  let filesWritten = 0;
  for (const s of eligible) {
    const self: ProjectRef = { slug: s.projectId, name: nameFromPath(s.projectPath) };
    const others = refs.filter((r) => r.slug !== s.projectId);
    const memDir = path.join(getProjectsDir(), s.projectId, 'memory');
    const r = ensureSignpostFor(memDir, renderSignpost(self, others));
    if (r.wroteFile || r.wrotePointer) filesWritten++;
  }
  return { swept: eligible.length, skipped: all.length - eligible.length, filesWritten };
}
