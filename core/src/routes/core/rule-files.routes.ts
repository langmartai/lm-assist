/**
 * Rule file routes — list/read for ALL user rules (own + synced + inert
 * mirrors), write/create/delete for OWN rules only. `synced.<host>.*` and
 * mirror copies are sync artifacts: editing them locally would be clobbered
 * by the next pull, so they are rejected (edit at the origin node instead).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import { rulesRoot, mirrorRootDir } from '../../rules/rule-sync';
import { parseOs, normalizeOsList } from '../../rules/rule-extract';
import { sha256, writeMdFile, deleteMdFile, filenameProblem } from '../../memory/file-write';

const RULES_PROTECTED = [/^synced\./i];
const SYNCED_RE = /^synced\.([A-Za-z0-9_-]+)\./;

function titleOf(content: string): string | null {
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function listDir(dir: string, source: string): Array<Record<string, unknown>> {
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith('.md') && !n.startsWith('.')); } catch { return []; }
  const out: Array<Record<string, unknown>> = [];
  for (const filename of names) {
    try {
      const p = path.join(dir, filename);
      const st = fs.statSync(p);
      const content = fs.readFileSync(p, 'utf-8');
      const osList = normalizeOsList(parseOs(content));
      const isMirror = source.startsWith('mirror:');
      const syncedFrom = SYNCED_RE.exec(filename)?.[1] ?? null;
      out.push({
        filename, source, size: st.size, mtimeMs: st.mtimeMs,
        os: osList,
        active: !isMirror && (osList.length === 0 || osList.includes(os.platform())),
        syncedFrom: isMirror ? source.slice('mirror:'.length) : syncedFrom,
        editable: !isMirror && !syncedFrom,
        title: titleOf(content),
      });
    } catch { /* skip unreadable entry */ }
  }
  return out;
}

/** Resolve a read source to a directory. live → rulesRoot; mirror:<host> → rules-mirror/<host> (host confined). */
function sourceDir(source: string | undefined): string | null {
  if (!source || source === 'live') return rulesRoot();
  if (source.startsWith('mirror:')) {
    const host = source.slice('mirror:'.length);
    if (!/^[A-Za-z0-9._-]+$/.test(host) || host.includes('..')) return null;
    return path.join(mirrorRootDir(), host);
  }
  return null;
}

function bodyOf(req: ParsedRequest): Record<string, unknown> {
  return (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
}

export function createRuleFilesRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // GET /rules/list
    {
      method: 'GET',
      pattern: /^\/rules\/list$/,
      handler: async () => {
        const start = Date.now();
        const rules = listDir(rulesRoot(), 'live');
        try {
          for (const host of fs.readdirSync(mirrorRootDir())) {
            const hostDir = path.join(mirrorRootDir(), host);
            try { if (!fs.statSync(hostDir).isDirectory()) continue; } catch { continue; }
            rules.push(...listDir(hostDir, `mirror:${host}`));
          }
        } catch { /* no mirror root yet */ }
        return wrapResponse({ rules }, start);
      },
    },
    // GET /rules/file/:filename?source=live|mirror:<host>
    {
      method: 'GET',
      pattern: /^\/rules\/file\/(?<filename>.+)$/,
      handler: async (req) => {
        const start = Date.now();
        const filename = decodeURIComponent(req.params.filename);
        if (filenameProblem(filename)) return wrapError('BAD_FILENAME', `BAD_FILENAME: ${filename}`, start);
        const source = (req.query.source as string) || 'live';
        const dir = sourceDir(source);
        if (!dir) return wrapError('INVALID_INPUT', `INVALID_INPUT: bad source ${source}`, start);
        try {
          const content = fs.readFileSync(path.join(dir, filename), 'utf-8');
          return wrapResponse({ filename, source, content, hash: sha256(content) }, start);
        } catch {
          return wrapError('NOT_FOUND', `NOT_FOUND: ${source}/${filename}`, start);
        }
      },
    },
    // PUT /rules/file/:filename  { content, expectedHash? }
    {
      method: 'PUT',
      pattern: /^\/rules\/file\/(?<filename>.+)$/,
      handler: async (req) => {
        const start = Date.now();
        const filename = decodeURIComponent(req.params.filename);
        const { content, expectedHash } = bodyOf(req) as { content?: string; expectedHash?: string };
        if (typeof content !== 'string') return wrapError('INVALID_INPUT', 'INVALID_INPUT: body.content (string) required', start);
        const r = writeMdFile(rulesRoot(), filename, content, {
          expectedHash: typeof expectedHash === 'string' ? expectedHash : undefined,
          protectedPatterns: RULES_PROTECTED,
        });
        if (!r.ok) return wrapError(r.code!, `${r.code}: write refused for ${filename}`, start);
        return wrapResponse({ filename, hash: r.hash }, start);
      },
    },
    // POST /rules/file  { filename, content }
    {
      method: 'POST',
      pattern: /^\/rules\/file$/,
      handler: async (req) => {
        const start = Date.now();
        const { filename, content } = bodyOf(req) as { filename?: string; content?: string };
        if (typeof filename !== 'string' || typeof content !== 'string') {
          return wrapError('INVALID_INPUT', 'INVALID_INPUT: body.filename and body.content required', start);
        }
        const r = writeMdFile(rulesRoot(), filename, content, { mustNotExist: true, protectedPatterns: RULES_PROTECTED });
        if (!r.ok) return wrapError(r.code!, `${r.code}: create refused for ${filename}`, start);
        return wrapResponse({ filename, hash: r.hash }, start);
      },
    },
    // DELETE /rules/file/:filename ?expectedHash=
    {
      method: 'DELETE',
      pattern: /^\/rules\/file\/(?<filename>.+)$/,
      handler: async (req) => {
        const start = Date.now();
        const filename = decodeURIComponent(req.params.filename);
        const b = bodyOf(req) as { expectedHash?: string };
        const expectedHash = (req.query.expectedHash as string) || (typeof b.expectedHash === 'string' ? b.expectedHash : undefined);
        const r = deleteMdFile(rulesRoot(), filename, { expectedHash, protectedPatterns: RULES_PROTECTED });
        if (!r.ok) return wrapError(r.code!, `${r.code}: delete refused for ${filename}`, start);
        return wrapResponse({ filename, deleted: true }, start);
      },
    },
  ];
}
