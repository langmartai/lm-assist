/**
 * Path-safety guard for the receiver.
 *
 * Every relPath that arrives from a peer is untrusted. We must guarantee the
 * resolved write target stays strictly inside the configured safe root, so a
 * malicious sender cannot write to `/etc/...` (absolute) or climb out with
 * `../../`. Rejection is by exception — the receiver turns it into an FT_ERR.
 */

import * as path from 'path';

export class UnsafePathError extends Error {
  constructor(public readonly relPath: string, reason: string) {
    super('unsafe path "' + relPath + '": ' + reason);
    this.name = 'UnsafePathError';
  }
}

/**
 * Resolve `relPath` under `root`, rejecting absolute paths and any path that
 * escapes `root` after normalization. Returns the absolute target path.
 */
export function safeJoin(root: string, relPath: string): string {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new UnsafePathError(String(relPath), 'empty');
  }
  // Normalize separators so a Windows-style or mixed relPath cannot sneak past.
  const normalizedRel = relPath.replace(/\\/g, '/');
  if (path.posix.isAbsolute(normalizedRel) || path.win32.isAbsolute(normalizedRel)) {
    throw new UnsafePathError(relPath, 'absolute');
  }
  // Reject explicit drive-letter / UNC forms even if isAbsolute missed them.
  if (/^[a-zA-Z]:/.test(normalizedRel)) {
    throw new UnsafePathError(relPath, 'drive-letter');
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, normalizedRel);
  // The target must be the root itself or strictly inside it.
  const rootWithSep = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : resolvedRoot + path.sep;
  if (target !== resolvedRoot && !target.startsWith(rootWithSep)) {
    throw new UnsafePathError(relPath, 'escapes root');
  }
  return target;
}
