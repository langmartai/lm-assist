/**
 * Rule extraction — file -> RuleRecord[]
 *
 * The atomic unit of the project/node-aware RULES map — the sibling of the
 * record-level MEMORY map (see core/src/memory/record-extract.ts and
 * docs/plans/2026-06-06-record-level-memory-map-and-sync.md). Rules are the
 * user-written `.claude/rules/*.md` instruction files (PROJECT and USER scope),
 * distinct from CLAUDE.md and from auto-memory.
 *
 *  - Each rule file -> exactly ONE RuleRecord (rules are one-topic, like memory).
 *  - PROJECT rules live in `<projectRoot>/.claude/rules/` recursive .md (committed).
 *  - USER rules live in `~/.claude/rules/` recursive .md (apply to every project).
 *  - USER rules load BEFORE project rules, so PROJECT rules win on conflict.
 *  - KEY FEATURE — path-scoping: a `paths:` YAML list in the frontmatter restricts
 *    the rule to sessions that touch a matching file glob. No `paths` => always-on
 *    (same priority as CLAUDE.md).
 *
 * See docs/plans/2026-06-06-rules-map-and-sync.md
 */
import { createHash } from 'crypto';
import * as os from 'os';
import { parseFrontmatter } from '../utils/frontmatter';
import { categorize, RecordType } from '../memory/record-extract';

export type RuleScope = 'user' | 'project';
export type LoadCondition = 'always' | 'path-scoped';

export interface RuleRecord {
  recordId: string;       // "<node>:<scope>:<project>:<relpath>"
  contentHash: string;    // sha256(complete) — change detection + cross-node dedup
  node: string;
  project: string;        // projectId slug; for USER rules a synthetic "(user)" project
  source: string;         // "live" | "repo:<host>"
  file: string;           // relative path under .claude/rules (may include subdirs)
  title: string;          // frontmatter.name | filename
  brief: string;          // frontmatter.description | first prose line  (BRIEF level)
  complete: string;       // full body                                   (COMPLETE level)
  category: string;       // reuses the memory categorizer
  // rules-specific dimensions
  scope: RuleScope;       // 'user' (machine-wide) | 'project' (committed)
  paths: string[];        // the path globs; [] = always-on
  loadCondition: LoadCondition;  // 'always' | 'path-scoped'
  // OS-applicability dimension (sync placement decided against the serving platform)
  os: string[];           // canonical platform list ([] = all platforms)
  osDependent: boolean;   // os.length > 0 — the per-rule "OS-dependent or not" tag
  active: boolean;        // os.length === 0 || os.includes(servingPlatform)
  priority: number;       // load order: user rules BEFORE project rules (project wins on conflict)
  originSessionId?: string;
  recordedAtMs: number;   // file mtime
  lastValidatedMs: number;
  validity: 'current' | 'stale' | 'outdated' | 'superseded';
  mtimeMs: number;
  size: number;
}

export interface ExtractInput {
  node: string;
  project: string;
  source: string;
  scope: RuleScope;
  /** path relative to the .claude/rules dir (forward-slash, may include subdirs) */
  relpath: string;
  content: string;
  mtimeMs: number;
  size: number;
  /** serving platform for the active computation; default os.platform() */
  platform?: string;
}

// User rules load BEFORE project rules, so project rules win on conflict.
// Higher number = applied later = wins. (Mirrors Claude Code's load order.)
const PRIORITY_USER = 10;
const PRIORITY_PROJECT = 20;

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
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

function mkId(node: string, scope: RuleScope, project: string, relpath: string): string {
  return node + ':' + scope + ':' + project + ':' + relpath;
}

/**
 * Parse the `paths:` YAML list out of the raw frontmatter block.
 *
 * parseFrontmatter() only keeps the known memory keys (name/description/type/
 * originSessionId) and collapses everything else into `extra` as a SCALAR string,
 * so a multi-line `paths:` list is dropped there. We therefore parse it ourselves
 * directly from the raw fenced block. Supports the block list, an inline flow
 * list (paths: ["a", "b"]), and a single scalar (paths: src/**).
 */
export function parsePaths(content: string): string[] {
  const normalized = content.replace(/\r\n/g, '\n');
  const stripped = normalized.startsWith('﻿') ? normalized.slice(1) : normalized;
  if (!stripped.startsWith('---\n') && !stripped.startsWith('---\r')) return [];
  const lines = stripped.split('\n');
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---' || lines[i] === '---\r') { end = i; break; }
  }
  if (end === -1) return [];
  const fm = lines.slice(1, end);

  const clean = (s: string): string => {
    let v = s.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v.trim();
  };

  const out: string[] = [];
  for (let i = 0; i < fm.length; i++) {
    const line = fm[i].replace(/\r$/, '');
    const m = line.match(/^(\s*)paths\s*:\s*(.*)$/);
    if (!m) continue;
    const inline = m[2].trim();
    if (inline) {
      if (inline.startsWith('[') && inline.endsWith(']')) {
        const inner = inline.slice(1, -1);
        for (const part of inner.split(',')) {
          const v = clean(part);
          if (v) out.push(v);
        }
      } else {
        const v = clean(inline);
        if (v) out.push(v);
      }
      return out;
    }
    // Block list — following lines `  - <glob>` until dedent / next key
    const baseIndent = m[1].length;
    for (let j = i + 1; j < fm.length; j++) {
      const bl = fm[j].replace(/\r$/, '');
      if (!bl.trim()) continue;
      const indent = bl.length - bl.trimStart().length;
      const item = bl.trim();
      if (item.startsWith('- ') || item === '-') {
        const v = clean(item.replace(/^-\s*/, ''));
        if (v) out.push(v);
        continue;
      }
      // a non-list line at the same-or-lower indent ends the list
      if (indent <= baseIndent) break;
    }
    return out;
  }
  return out;
}

/** Friendly → canonical (Node os.platform()) OS normalization map. */
const OS_NORMALIZE: Record<string, string> = {
  windows: 'win32', win: 'win32', win32: 'win32',
  mac: 'darwin', macos: 'darwin', osx: 'darwin', darwin: 'darwin',
  linux: 'linux',
};

/** Canonicalize one token; unknown tokens are kept verbatim (lowercased) for forward-compat. */
function normalizeOsToken(t: string): string {
  const k = t.trim().toLowerCase();
  return OS_NORMALIZE[k] || k;
}

/** Canonical, de-duplicated platform list from raw os: tokens. */
export function normalizeOsList(tokens: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    const v = normalizeOsToken(t);
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Parse the `os:` YAML list out of the raw frontmatter block — IDENTICAL shape to parsePaths
 * (block list, inline flow list `os: [a, b]`, single scalar `os: windows`). parseFrontmatter()
 * collapses unknown keys to a scalar string, so we parse it ourselves from the raw block.
 */
export function parseOs(content: string): string[] {
  const normalized = content.replace(/\r\n/g, '\n');
  const stripped = normalized.startsWith('﻿') ? normalized.slice(1) : normalized;
  if (!stripped.startsWith('---\n') && !stripped.startsWith('---\r')) return [];
  const lines = stripped.split('\n');
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---' || lines[i] === '---\r') { end = i; break; }
  }
  if (end === -1) return [];
  const fm = lines.slice(1, end);

  const clean = (s: string): string => {
    let v = s.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v.trim();
  };

  const out: string[] = [];
  for (let i = 0; i < fm.length; i++) {
    const line = fm[i].replace(/\r$/, '');
    const m = line.match(/^(\s*)os\s*:\s*(.*)$/);
    if (!m) continue;
    const inline = m[2].trim();
    if (inline) {
      if (inline.startsWith('[') && inline.endsWith(']')) {
        for (const part of inline.slice(1, -1).split(',')) {
          const v = clean(part);
          if (v) out.push(v);
        }
      } else {
        const v = clean(inline);
        if (v) out.push(v);
      }
      return out;
    }
    const baseIndent = m[1].length;
    for (let j = i + 1; j < fm.length; j++) {
      const bl = fm[j].replace(/\r$/, '');
      if (!bl.trim()) continue;
      const indent = bl.length - bl.trimStart().length;
      const item = bl.trim();
      if (item.startsWith('- ') || item === '-') {
        const v = clean(item.replace(/^-\s*/, ''));
        if (v) out.push(v);
        continue;
      }
      if (indent <= baseIndent) break;
    }
    return out;
  }
  return out;
}

/** A single rule file -> exactly one record. */
export function extractRule(inp: ExtractInput): RuleRecord {
  const { frontmatter, body } = parseFrontmatter(inp.content);
  const base = inp.relpath.split('/').pop() || inp.relpath;
  const title = frontmatter.name || base.replace(/\.md$/, '');
  const brief = frontmatter.description || firstProse(body);
  const complete = body.trim() || inp.content.trim();
  const paths = parsePaths(inp.content);
  const loadCondition: LoadCondition = paths.length ? 'path-scoped' : 'always';
  const osList = normalizeOsList(parseOs(inp.content));
  const servingPlatform = inp.platform || os.platform();
  const active = osList.length === 0 || osList.includes(servingPlatform);
  // Rules carry no memory `type`; treat as 'project' for the categorizer axis.
  const catType: RecordType = 'project';
  return {
    recordId: mkId(inp.node, inp.scope, inp.project, inp.relpath),
    contentHash: sha256(complete),
    node: inp.node, project: inp.project, source: inp.source, file: inp.relpath,
    title, brief, complete,
    category: categorize(title + ' ' + brief + ' ' + complete + ' ' + inp.relpath, catType),
    scope: inp.scope,
    paths,
    loadCondition,
    os: osList, osDependent: osList.length > 0, active,
    priority: inp.scope === 'user' ? PRIORITY_USER : PRIORITY_PROJECT,
    originSessionId: (frontmatter as { originSessionId?: string }).originSessionId,
    recordedAtMs: inp.mtimeMs, lastValidatedMs: inp.mtimeMs, validity: 'current' as const,
    mtimeMs: inp.mtimeMs, size: inp.size,
  };
}
