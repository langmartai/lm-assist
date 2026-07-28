/**
 * Is `env.repo` an absolute path — on the platform that will actually USE it?
 *
 * 🔴 Not `path.isAbsolute`. That resolves to `path.posix` on a Linux host, so a
 * Linux mission leader validating a repo for a WINDOWS node rejects every
 * legitimate Windows path:
 *
 *   POST /mission { env.repo: "C:\\home\\lm-assist" }
 *   -> 400 INVALID_REPO: env.repo must be an absolute path — got "C:\home\lm-assist"
 *
 * The leader is not the machine that runs the mission. A repo path is validated
 * on one OS and dereferenced on another, so the check has to accept an absolute
 * path in EITHER convention. (Measured 2026-07-28: this made it impossible to
 * create a mission with a repo on the Windows node at all — the same POSIX
 * assumption as bl_ee6b080c, one layer up.)
 */

import * as path from 'path';

/**
 * True when `v` is absolute under POSIX (`/srv/app`) or Windows
 * (`C:\ws\app`, `\\server\share`) rules.
 *
 * Deliberately permissive across platforms rather than switching on the local
 * OS: the validating host and the executing host are routinely different.
 */
export function isAbsoluteRepoPath(v: string): boolean {
  return path.posix.isAbsolute(v) || path.win32.isAbsolute(v);
}
