/**
 * Memory file WRITE routes — the web editor's mutation surface.
 *
 *   PUT    /memory/by-project/:projectId/file/:filename   { content, expectedHash? }
 *   POST   /memory/by-project/:projectId/file             { filename, content, indexLine? }
 *   DELETE /memory/by-project/:projectId/file/:filename   ?expectedHash=&removeIndexLine=true (query or body)
 *
 * Writes are confined to `<projectsDir>/<slug>/memory/` for a slug that is
 * already registered on this node (same allow-list idea as memory-sync's
 * resolveKnownProjectCwd — a relayed projectId can never decode to an
 * arbitrary path). Managed files and mirrors are not writable. Error
 * messages start with their code so the web client can match on them.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import { getProjectsDir } from '../../utils/path-utils';
import { parseFrontmatter, isValidMemoryFrontmatter } from '../../utils/frontmatter';
import { writeMdFile, deleteMdFile, appendIndexLine, removeIndexLines } from '../../memory/file-write';
import { createMemoryApiImpl, MemoryApi } from '../../api/memory-api';

const MEMORY_PROTECTED = [/^_cross-project\.md$/i, /^_hosts\.md$/i];

let memoryApi: MemoryApi | null = null;
function getApi(): MemoryApi {
  if (!memoryApi) memoryApi = createMemoryApiImpl();
  return memoryApi; // clear() hits the shared getMemoryCache() singleton
}

/** Allow-list resolution: slug must be a safe single segment AND a registered project dir. */
function resolveLiveMemoryDir(slug: string | undefined): string | null {
  if (!slug || slug.includes('/') || slug.includes('\\') || slug.includes('..')) return null;
  const projectDir = path.join(getProjectsDir(), slug);
  if (!fs.existsSync(projectDir)) return null;
  return path.join(projectDir, 'memory');
}

function frontmatterWarnings(content: string): string[] {
  const warnings: string[] = [];
  const pf = parseFrontmatter(content);
  if (!pf.hasFrontmatter) warnings.push('no frontmatter block (--- … ---) — record extraction will use defaults');
  else {
    if (!pf.frontmatter.name) warnings.push('frontmatter missing `name`');
    if (!pf.frontmatter.description) warnings.push('frontmatter missing `description`');
    if (!isValidMemoryFrontmatter(pf.frontmatter)) warnings.push('frontmatter missing/unknown `type`');
  }
  return warnings;
}

function bodyOf(req: ParsedRequest): Record<string, unknown> {
  return (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
}

async function invalidate(projectId: string): Promise<void> {
  try { await getApi().clear(projectId); } catch { /* cache refreshes via watcher anyway */ }
}

export function createMemoryFilesRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // PUT /memory/by-project/:projectId/file/:filename
    {
      method: 'PUT',
      pattern: /^\/memory\/by-project\/(?<projectId>[^/]+)\/file\/(?<filename>.+)$/,
      handler: async (req) => {
        const start = Date.now();
        const projectId = decodeURIComponent(req.params.projectId);
        const filename = decodeURIComponent(req.params.filename);
        const { content, expectedHash } = bodyOf(req) as { content?: string; expectedHash?: string };
        if (typeof content !== 'string') return wrapError('INVALID_INPUT', 'INVALID_INPUT: body.content (string) required', start);
        const dir = resolveLiveMemoryDir(projectId);
        if (!dir) return wrapError('PROJECT_NOT_FOUND', `PROJECT_NOT_FOUND: ${projectId}`, start);
        const r = writeMdFile(dir, filename, content, {
          expectedHash: typeof expectedHash === 'string' ? expectedHash : undefined,
          protectedPatterns: MEMORY_PROTECTED,
        });
        if (!r.ok) return wrapError(r.code!, `${r.code}: write refused for ${filename}`, start);
        await invalidate(projectId);
        return wrapResponse({ projectId, filename, hash: r.hash, warnings: frontmatterWarnings(content) }, start);
      },
    },
    // POST /memory/by-project/:projectId/file  (create)
    {
      method: 'POST',
      pattern: /^\/memory\/by-project\/(?<projectId>[^/]+)\/file$/,
      handler: async (req) => {
        const start = Date.now();
        const projectId = decodeURIComponent(req.params.projectId);
        const { filename, content, indexLine } = bodyOf(req) as { filename?: string; content?: string; indexLine?: string };
        if (typeof filename !== 'string' || typeof content !== 'string') {
          return wrapError('INVALID_INPUT', 'INVALID_INPUT: body.filename and body.content required', start);
        }
        const dir = resolveLiveMemoryDir(projectId);
        if (!dir) return wrapError('PROJECT_NOT_FOUND', `PROJECT_NOT_FOUND: ${projectId}`, start);
        const r = writeMdFile(dir, filename, content, { mustNotExist: true, protectedPatterns: MEMORY_PROTECTED });
        if (!r.ok) return wrapError(r.code!, `${r.code}: create refused for ${filename}`, start);
        let indexUpdated = false;
        if (typeof indexLine === 'string' && indexLine.trim()) {
          appendIndexLine(dir, indexLine);
          indexUpdated = true;
        }
        await invalidate(projectId);
        return wrapResponse({ projectId, filename, hash: r.hash, warnings: frontmatterWarnings(content), indexUpdated }, start);
      },
    },
    // DELETE /memory/by-project/:projectId/file/:filename
    {
      method: 'DELETE',
      pattern: /^\/memory\/by-project\/(?<projectId>[^/]+)\/file\/(?<filename>.+)$/,
      handler: async (req) => {
        const start = Date.now();
        const projectId = decodeURIComponent(req.params.projectId);
        const filename = decodeURIComponent(req.params.filename);
        const b = bodyOf(req) as { expectedHash?: string; removeIndexLine?: boolean };
        const expectedHash = (req.query.expectedHash as string) || (typeof b.expectedHash === 'string' ? b.expectedHash : undefined);
        const removeIdx = req.query.removeIndexLine === 'true' || b.removeIndexLine === true;
        const dir = resolveLiveMemoryDir(projectId);
        if (!dir) return wrapError('PROJECT_NOT_FOUND', `PROJECT_NOT_FOUND: ${projectId}`, start);
        const r = deleteMdFile(dir, filename, { expectedHash, protectedPatterns: MEMORY_PROTECTED });
        if (!r.ok) return wrapError(r.code!, `${r.code}: delete refused for ${filename}`, start);
        let indexUpdated = false;
        if (removeIdx) indexUpdated = removeIndexLines(dir, filename) > 0;
        await invalidate(projectId);
        return wrapResponse({ projectId, filename, deleted: true, indexUpdated }, start);
      },
    },
  ];
}
