/**
 * Path resolution for annotation artifacts.
 *
 * Claude Code JSONL files live at ~/.claude/projects/<encoded-cwd>/<sid>.jsonl
 * where <encoded-cwd> replaces `/` with `-` (leading `-` kept).
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { ProjectPaths } from './types';

export function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

export function projectDir(cwd: string): string {
  return path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwd));
}

export function resolveFromCwd(sessionId: string, cwd: string): ProjectPaths {
  const pdir = projectDir(cwd);
  return {
    sessionFile: path.join(pdir, `${sessionId}.jsonl`),
    compactAnnotationsFile: path.join(pdir, `${sessionId}.annotations.compact.jsonl`),
    indexFile: path.join(pdir, `${sessionId}.index.json`),
  };
}

/**
 * When caller only has sessionId, scan projects/ to find the session file and
 * derive cwd from inside the JSONL (reading the `cwd` field from early lines).
 *
 * The encoded directory name (`-home-ubuntu-lm-assist`) can't be losslessly
 * decoded back to the original path because hyphens in path components (e.g.
 * `lm-assist`) are indistinguishable from encoded slashes. So we read cwd
 * from the session data itself.
 */
export function resolveFromSessionId(sessionId: string): { paths: ProjectPaths; cwd: string } | null {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  let entries: string[];
  try { entries = fs.readdirSync(projectsRoot); } catch { return null; }
  for (const enc of entries) {
    const candidate = path.join(projectsRoot, enc, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) {
      // Extract cwd from inside the JSONL — scan first 10 lines for a `cwd` field.
      const cwd = extractCwdFromJsonl(candidate);
      if (cwd) {
        return { paths: resolveFromCwd(sessionId, cwd), cwd };
      }
      // Fallback: use the encoded directory path (lossy but better than nothing)
      const lossyCwd = enc.replace(/-/g, '/');
      return { paths: resolveFromCwd(sessionId, lossyCwd), cwd: lossyCwd };
    }
  }
  return null;
}

/** Read the first few lines of a session JSONL to find the `cwd` field. */
function extractCwdFromJsonl(filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(8192); // First 8KB is enough to find cwd
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const text = buf.toString('utf-8', 0, bytesRead);
    for (const line of text.split('\n').slice(0, 10)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj.cwd && typeof obj.cwd === 'string') return obj.cwd;
      } catch { /* skip malformed lines */ }
    }
  } catch { /* file read error */ }
  return null;
}
