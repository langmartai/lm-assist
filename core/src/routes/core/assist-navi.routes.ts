/**
 * Assist Navi Routes
 *
 * File browser and log viewer for tier-agent-context (assist) system files.
 * Whitelist security approach — only allows reading from known assist directories.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { RouteHandler, RouteContext } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import { getDataDir } from '../../utils/path-utils';

const DATA = getDataDir();

// ─── Allowed Directories (whitelist) ───
const ALLOWED_DIRS = [
  DATA,
];
const ALLOWED_FILES: string[] = [];

// Known log filenames (for /assist-navi/log endpoint)
const KNOWN_LOGS: Record<string, string> = {
  'context-inject-hook.log': path.join(DATA, 'logs', 'context-inject-hook.log'),
  'mcp-calls.jsonl': path.join(DATA, 'logs', 'mcp-calls.jsonl'),
};

// ─── Extra allowed files outside the data dir ───
const EXTRA_FILES: { path: string; category: string }[] = [];

// ─── Helpers ───

function isPathAllowed(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  for (const dir of ALLOWED_DIRS) {
    if (resolved.startsWith(dir + path.sep) || resolved === dir) return true;
  }
  for (const f of ALLOWED_FILES) {
    if (resolved === f) return true;
  }
  return false;
}

interface FileInfo {
  name: string;
  path: string;
  size: number;
  modified: string;
  isDirectory: boolean;
  category: string;
  fileCount?: number;
  children?: FileInfo[];
}

function statFileInfo(filePath: string, category: string): FileInfo | null {
  try {
    const stats = fs.statSync(filePath);
    const info: FileInfo = {
      name: path.basename(filePath),
      path: filePath,
      size: stats.size,
      modified: stats.mtime.toISOString(),
      isDirectory: stats.isDirectory(),
      category,
    };
    if (stats.isDirectory()) {
      try {
        const children = fs.readdirSync(filePath);
        info.fileCount = children.length;
        let totalSize = 0;
        for (const child of children) {
          try { totalSize += fs.statSync(path.join(filePath, child)).size; } catch { /* skip */ }
        }
        info.size = totalSize;
      } catch { /* empty dir */ }
    }
    return info;
  } catch {
    return null;
  }
}

/**
 * Recursively scan a directory up to a given depth.
 * depth=0 returns just the entry, depth=1 returns entry + immediate children, etc.
 */
function scanDir(dirPath: string, category: string, depth: number): FileInfo | null {
  const info = statFileInfo(dirPath, category);
  if (!info || !info.isDirectory || depth <= 0) return info;

  try {
    const names = fs.readdirSync(dirPath).sort();
    info.children = [];
    for (const name of names) {
      const childPath = path.join(dirPath, name);
      const child = scanDir(childPath, category, depth - 1);
      if (child) info.children.push(child);
    }
  } catch { /* skip */ }
  return info;
}

const MAX_READ_BYTES = 1024 * 1024; // 1MB cap

function tailLines(filePath: string, limit: number): { lines: string[]; truncated: boolean; totalLines: number } {
  try {
    const stats = fs.statSync(filePath);
    const truncated = stats.size > MAX_READ_BYTES;
    // Read from end if file is large
    let content: string;
    if (truncated) {
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(MAX_READ_BYTES);
      fs.readSync(fd, buf, 0, MAX_READ_BYTES, stats.size - MAX_READ_BYTES);
      fs.closeSync(fd);
      content = buf.toString('utf-8');
      // Drop first partial line
      const nl = content.indexOf('\n');
      if (nl >= 0) content = content.slice(nl + 1);
    } else {
      content = fs.readFileSync(filePath, 'utf-8');
    }
    const allLines = content.split('\n').filter(l => l.length > 0);
    const totalLines = allLines.length;
    const lines = allLines.slice(-limit);
    return { lines, truncated, totalLines };
  } catch {
    return { lines: [], truncated: false, totalLines: 0 };
  }
}

// ─── Routes ───

export function createAssistNaviRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // GET /assist-navi/files — Scan ~/.lm-assist/ directory tree
    //   ?depth=2 (default 2) — how deep to recurse
    {
      method: 'GET',
      pattern: /^\/assist-navi\/files$/,
      handler: async (req) => {
        const start = Date.now();
        try {
          const depth = Math.min(parseInt(req.query.depth || '2', 10), 5);

          // Scan the data directory
          const root = scanDir(DATA, 'lm-assist', depth);

          // Also include extra allowed files (e.g., hook-events.jsonl)
          const extras: FileInfo[] = [];
          for (const extra of EXTRA_FILES) {
            const info = statFileInfo(extra.path, extra.category);
            if (info) extras.push(info);
          }

          // Compute totals from top-level children
          let totalSize = 0;
          let totalFiles = 0;
          let lastActivity = '';
          if (root?.children) {
            for (const child of root.children) {
              totalSize += child.size;
              totalFiles += child.isDirectory ? (child.fileCount || 0) : 1;
              if (child.modified > lastActivity) lastActivity = child.modified;
            }
          }
          for (const e of extras) {
            totalSize += e.size;
            totalFiles++;
            if (e.modified > lastActivity) lastActivity = e.modified;
          }

          return wrapResponse({
            root: root || { name: '.lm-assist', path: DATA, size: 0, modified: '', isDirectory: true, category: 'lm-assist', children: [] },
            extras,
            totalFiles,
            totalSize,
            lastActivity: lastActivity || null,
          }, start);
        } catch (e) {
          return wrapError('ASSIST_NAVI_FILES_ERROR', String(e), start);
        }
      },
    },

    // GET /assist-navi/file?path=...&limit=500 — Read a single file's content
    {
      method: 'GET',
      pattern: /^\/assist-navi\/file$/,
      handler: async (req) => {
        const start = Date.now();
        try {
          const filePath = req.query.path;
          const limit = parseInt(req.query.limit || '500', 10);

          if (!filePath) {
            return wrapError('ASSIST_NAVI_MISSING_PATH', 'path query parameter is required', start);
          }

          const resolved = path.resolve(filePath);
          if (!isPathAllowed(resolved)) {
            return wrapError('ASSIST_NAVI_FORBIDDEN', `Path not in allowed directories: ${filePath}`, start);
          }

          if (!fs.existsSync(resolved)) {
            return wrapError('ASSIST_NAVI_NOT_FOUND', `File not found: ${filePath}`, start);
          }

          const stats = fs.statSync(resolved);
          if (stats.isDirectory()) {
            return wrapError('ASSIST_NAVI_IS_DIR', `Path is a directory: ${filePath}`, start);
          }

          const ext = path.extname(resolved).toLowerCase();

          // Binary files (LMDB .mdb, etc.)
          if (ext === '.mdb' || ext === '.lock') {
            return wrapResponse({
              format: 'binary',
              path: resolved,
              size: stats.size,
              modified: stats.mtime.toISOString(),
              message: 'Binary file — cannot display contents',
            }, start);
          }

          const truncated = stats.size > MAX_READ_BYTES;

          // JSON files
          if (ext === '.json') {
            let content: string;
            if (truncated) {
              const buf = Buffer.alloc(MAX_READ_BYTES);
              const fd = fs.openSync(resolved, 'r');
              fs.readSync(fd, buf, 0, MAX_READ_BYTES, 0);
              fs.closeSync(fd);
              content = buf.toString('utf-8');
            } else {
              content = fs.readFileSync(resolved, 'utf-8');
            }
            try {
              const parsed = JSON.parse(content);
              return wrapResponse({
                format: 'json',
                path: resolved,
                size: stats.size,
                modified: stats.mtime.toISOString(),
                content: parsed,
                truncated,
              }, start);
            } catch {
              // Invalid JSON, return as text
              return wrapResponse({
                format: 'text',
                path: resolved,
                size: stats.size,
                modified: stats.mtime.toISOString(),
                content,
                truncated,
              }, start);
            }
          }

          // JSONL files
          if (ext === '.jsonl') {
            const { lines, truncated: isTruncated, totalLines } = tailLines(resolved, limit);
            const entries = lines.map(line => {
              try { return JSON.parse(line); }
              catch { return { _raw: line }; }
            });
            return wrapResponse({
              format: 'jsonl',
              path: resolved,
              size: stats.size,
              modified: stats.mtime.toISOString(),
              entries,
              totalLines,
              truncated: isTruncated,
            }, start);
          }

          // Markdown files
          if (ext === '.md') {
            let content: string;
            if (truncated) {
              const buf = Buffer.alloc(MAX_READ_BYTES);
              const fd = fs.openSync(resolved, 'r');
              fs.readSync(fd, buf, 0, MAX_READ_BYTES, 0);
              fs.closeSync(fd);
              content = buf.toString('utf-8');
            } else {
              content = fs.readFileSync(resolved, 'utf-8');
            }
            return wrapResponse({
              format: 'markdown',
              path: resolved,
              size: stats.size,
              modified: stats.mtime.toISOString(),
              content,
              truncated,
            }, start);
          }

          // Plain text / log files
          const { lines, truncated: isTruncated, totalLines } = tailLines(resolved, limit);
          return wrapResponse({
            format: 'text',
            path: resolved,
            size: stats.size,
            modified: stats.mtime.toISOString(),
            content: lines.join('\n'),
            totalLines,
            truncated: isTruncated,
          }, start);
        } catch (e) {
          return wrapError('ASSIST_NAVI_FILE_ERROR', String(e), start);
        }
      },
    },

    // GET /assist-navi/log?file=...&limit=300&search=... — Specialized log tail
    {
      method: 'GET',
      pattern: /^\/assist-navi\/log$/,
      handler: async (req) => {
        const start = Date.now();
        try {
          const fileName = req.query.file;
          const limit = parseInt(req.query.limit || '300', 10);
          const search = req.query.search || '';

          if (!fileName) {
            return wrapError('ASSIST_NAVI_MISSING_FILE', 'file query parameter is required', start);
          }

          const logPath = KNOWN_LOGS[fileName];
          if (!logPath) {
            return wrapError('ASSIST_NAVI_UNKNOWN_LOG', `Unknown log file: ${fileName}. Known: ${Object.keys(KNOWN_LOGS).join(', ')}`, start);
          }

          if (!fs.existsSync(logPath)) {
            return wrapResponse({
              file: fileName,
              format: fileName.endsWith('.jsonl') ? 'jsonl' : 'text',
              entries: [],
              totalLines: 0,
              matchCount: 0,
            }, start);
          }

          // Read more lines than limit if searching (to get enough matches)
          const readLimit = search ? limit * 5 : limit;
          const { lines, totalLines } = tailLines(logPath, readLimit);

          if (fileName.endsWith('.jsonl')) {
            // Parse JSONL entries
            let entries = lines.map(line => {
              try { return JSON.parse(line); }
              catch { return { _raw: line }; }
            });

            // Filter by search term across tool, args, error fields
            if (search) {
              const lowerSearch = search.toLowerCase();
              entries = entries.filter(e => {
                const str = JSON.stringify(e).toLowerCase();
                return str.includes(lowerSearch);
              });
            }

            const matchCount = entries.length;
            entries = entries.slice(-limit);

            return wrapResponse({
              file: fileName,
              format: 'jsonl',
              entries,
              totalLines,
              matchCount,
            }, start);
          }

          // Plain text log
          let filteredLines = lines;
          if (search) {
            const lowerSearch = search.toLowerCase();
            filteredLines = lines.filter(l => l.toLowerCase().includes(lowerSearch));
          }

          const matchCount = filteredLines.length;
          filteredLines = filteredLines.slice(-limit);

          return wrapResponse({
            file: fileName,
            format: 'text',
            entries: filteredLines,
            totalLines,
            matchCount,
          }, start);
        } catch (e) {
          return wrapError('ASSIST_NAVI_LOG_ERROR', String(e), start);
        }
      },
    },
  ];
}
