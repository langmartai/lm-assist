/**
 * Record extraction — file -> MemoryRecord[]
 *
 * The atomic unit of the project/node-aware memory map. Three kinds:
 *  - memory         : a standard one-fact memory file (frontmatter + body) -> 1 record
 *  - claude-section : CLAUDE.md split by H1/H2 headings -> 1 record per section
 *  - index-entry    : a MEMORY.md bullet -> 1 record pointing at a memory file
 *
 * See docs/plans/2026-06-06-record-level-memory-map-and-sync.md
 */
import { createHash } from 'crypto';
import { parseFrontmatter } from '../utils/frontmatter';
import { classifyShareability, Shareability } from '../utils/memory-shareability';

export type RecordKind = 'memory' | 'claude-section' | 'index-entry';
export type RecordType =
  | 'user' | 'feedback' | 'project' | 'reference' | 'claude' | 'index';

export interface MemoryRecord {
  recordId: string;       // "<node>:<project>:<file>#<anchor>"
  contentHash: string;    // sha256(complete)
  node: string;
  project: string;
  source: string;         // "live" | "repo:<host>"
  file: string;
  kind: RecordKind;
  anchor: string;         // "" whole-file | heading slug | index target
  title: string;
  brief: string;          // BRIEF level
  complete: string;       // COMPLETE level
  type: RecordType;
  category: string;
  shareability: Shareability;
  originSessionId?: string;  // backtrack to the session that recorded it
  recordedAtMs: number;     // when this record state was written (file mtime)
  lastValidatedMs: number;  // when last confirmed still-true (harvester/reconcile); defaults to recordedAtMs
  validity: 'current' | 'stale' | 'outdated' | 'superseded';
  validFrom?: string;
  validUntil?: string;
  supersededBy?: string;  // recordId that replaces this one
  mtimeMs: number;
  size: number;
}

export interface ExtractInput {
  node: string;
  project: string;
  source: string;
  filename: string;
  content: string;
  mtimeMs: number;
  size: number;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

/** First prose line (skips blank/heading/table/list markers), stripped of md emphasis. */
function firstProse(body: string, max = 220): string {
  for (const raw of body.split('\n')) {
    const l = raw.trim();
    if (!l || l.startsWith('#') || l.startsWith('|') || l.startsWith('```') || l.startsWith('---')) continue;
    const clean = l.replace(/^[-*]\s+/, '').replace(/[*_`]/g, '').trim();
    if (clean) return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
  }
  return '';
}

function mkId(node: string, project: string, file: string, anchor: string): string {
  return `${node}:${project}:${file}#${anchor}`;
}

const CATEGORIES = ['index','endpoint','deployment','architecture','component','feature','lesson','config','knowledge'] as const;
export function categorize(text: string, type: RecordType): string {
  const t = text.toLowerCase();
  if (type === 'index') return 'index';
  const hit = (...ws: string[]) => ws.some(w => t.includes(w));
  if (hit('endpoint','/api/',' route','rest ','curl ','http ','jsonrpc')) return 'endpoint';
  if (hit('deploy','install','systemd','docker','nginx','rebuild','restart',' port ','pm2',' cron','build:')) return 'deployment';
  if (hit('architect','design','boundary','pipeline','protocol','data model','two-stream','two stream')) return 'architecture';
  if (hit('component','module','library',' package',' script ','daemon','engine')) return 'component';
  if (hit('feature','command','skill','workflow','dashboard')) return 'feature';
  if (hit('lesson','gotcha','incident',' bug','pitfall','learned','trap','mistake','do not','never ','always ')) return 'lesson';
  if (hit('credential','token',' key ','account','config','setting','env ','.env')) return 'config';
  return 'knowledge';
}

/** A standard one-fact memory file -> exactly one record. */
function extractMemoryFile(inp: ExtractInput): MemoryRecord[] {
  const { frontmatter, body } = parseFrontmatter(inp.content);
  const title = frontmatter.name || inp.filename.replace(/\.md$/, '');
  const brief = frontmatter.description || firstProse(body);
  const complete = body.trim() || inp.content.trim();
  const type = (frontmatter.type as RecordType) || 'project';
  return [{
    recordId: mkId(inp.node, inp.project, inp.filename, ''),
    contentHash: sha256(complete),
    node: inp.node, project: inp.project, source: inp.source, file: inp.filename,
    kind: 'memory', anchor: '', title, brief, complete, type,
    category: categorize(title + ' ' + brief + ' ' + complete + ' ' + inp.filename, type),
    originSessionId: (frontmatter as { originSessionId?: string }).originSessionId,
    recordedAtMs: inp.mtimeMs, lastValidatedMs: inp.mtimeMs, validity: 'current' as const,
    shareability: classifyShareability(inp.filename, frontmatter),
    mtimeMs: inp.mtimeMs, size: inp.size,
  }];
}

/** CLAUDE.md -> one record per H1/H2 section (deeper headings stay inside the body). */
export function extractClaudeSections(inp: ExtractInput): MemoryRecord[] {
  const lines = inp.content.split('\n');
  const out: MemoryRecord[] = [];
  let curTitle = '(preamble)';
  let curLevel = 0;
  let buf: string[] = [];
  const flush = () => {
    const complete = buf.join('\n').trim();
    if (!complete) { buf = []; return; }
    const anchor = slug(curTitle) || 'preamble';
    out.push({
      recordId: mkId(inp.node, inp.project, inp.filename, anchor),
      contentHash: sha256(complete),
      node: inp.node, project: inp.project, source: inp.source, file: inp.filename,
      kind: 'claude-section', anchor, title: curTitle,
      brief: firstProse(curLevel ? buf.slice(1).join('\n') : complete),
      complete, type: 'claude',
      category: categorize(curTitle + ' ' + complete, 'claude'),
      recordedAtMs: inp.mtimeMs, lastValidatedMs: inp.mtimeMs, validity: 'current' as const,
      shareability: 'project-domain', // CLAUDE.md is shared repo content
      mtimeMs: inp.mtimeMs, size: complete.length,
    });
    buf = [];
  };
  for (const line of lines) {
    const m = /^(#{1,2})\s+(.+?)\s*$/.exec(line);
    if (m) { flush(); curLevel = m[1].length; curTitle = m[2]; buf = [line]; }
    else buf.push(line);
  }
  flush();
  return out;
}

/** MEMORY.md -> one index-entry record per bullet "- [Title](file.md) — hook". */
export function extractIndexEntries(inp: ExtractInput): MemoryRecord[] {
  const out: MemoryRecord[] = [];
  const re = /^\s*-\s*\[([^\]]+)\]\(([^)]+)\)\s*(?:[—\-:]\s*(.*))?$/;
  for (const line of inp.content.split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    const [, title, target, hook = ''] = m;
    const anchor = slug(target.replace(/\.md$/, ''));
    const complete = line.trim();
    out.push({
      recordId: mkId(inp.node, inp.project, inp.filename, anchor),
      contentHash: sha256(complete),
      node: inp.node, project: inp.project, source: inp.source, file: inp.filename,
      kind: 'index-entry', anchor, title: title.trim(),
      brief: hook.trim(), complete, type: 'index',
      category: 'index',
      recordedAtMs: inp.mtimeMs, lastValidatedMs: inp.mtimeMs, validity: 'current' as const,
      shareability: 'project-domain',
      mtimeMs: inp.mtimeMs, size: complete.length,
    });
  }
  return out;
}

/** Dispatch by filename. */
export function extractRecords(inp: ExtractInput): MemoryRecord[] {
  const base = inp.filename.split('/').pop() || inp.filename;
  if (base === 'CLAUDE.md') return extractClaudeSections(inp);
  if (base === 'MEMORY.md') return extractIndexEntries(inp);
  return extractMemoryFile(inp);
}
