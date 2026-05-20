/**
 * Chrome profile discovery + per-profile cookie-file paths.
 *
 * Reads Chrome's `User Data\Local State` JSON to enumerate profiles. Lives
 * alongside `claudeai-session.ts` but operates on a different artifact:
 *
 *   claudeai-session.ts      — the lm-assist cookie config (~/.claude/claudeai-session*.json)
 *   claudeai-browser-profile — the user's installed Chrome's profile registry
 *
 * The two intersect at capture-session time: we read cookies from a Chrome
 * profile via CDP, then write a session file that the cookie-file path will
 * consume.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Where the spawned-Chrome data dir lives when caller picks 'isolated'. */
export const ISOLATED_PROFILE_DIR = path.join(os.homedir(), '.claude', 'claudeai-browser-profile');

/** Default debug port. Caller can override. */
export const DEFAULT_DEBUG_PORT = 9222;

export interface ChromeProfile {
  /** Directory name under `User Data` (`Default`, `Profile 1`, …). */
  id: string;
  /** Display name from `info_cache.<id>.name`. */
  name: string | null;
  /** Logged-in Google email, if any. */
  userName: string | null;
  /** Gaia display name, if any. */
  gaiaName: string | null;
  /** Absolute path to the profile directory. */
  profileDir: string;
  /** Whether the profile dir exists on disk. */
  exists: boolean;
  /** Per-profile session file path (where capture-session would write). */
  sessionPath: string;
}

/**
 * Resolve the platform-specific Chrome `User Data` directory.
 *
 *  - Windows:  %LOCALAPPDATA%\Google\Chrome\User Data
 *  - macOS:    ~/Library/Application Support/Google/Chrome
 *  - Linux:    ~/.config/google-chrome
 *
 * Returns null on unsupported platforms or when the dir is missing.
 */
export function getChromeUserDataDir(): string | null {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (!local) return null;
    return path.join(local, 'Google', 'Chrome', 'User Data');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  }
  if (process.platform === 'linux') {
    return path.join(os.homedir(), '.config', 'google-chrome');
  }
  return null;
}

/** Session file for a given profile id. e.g. claudeai-session.Default.json */
export function sessionPathForProfile(profileId: string): string {
  // Sanitize: profile ids can contain spaces ("Profile 1"). Spaces are fine
  // on every platform's FS we care about, but normalize to a stable form.
  const safe = profileId.replace(/[^\w.-]+/g, '_');
  return path.join(os.homedir(), '.claude', `claudeai-session.${safe}.json`);
}

/**
 * Enumerate Chrome profiles by reading Local State JSON. Falls back to
 * directory scan if Local State is unreadable.
 */
export function listChromeProfiles(): {
  ok: boolean;
  reason?: string;
  userDataDir: string | null;
  profiles: ChromeProfile[];
} {
  const userDataDir = getChromeUserDataDir();
  if (!userDataDir) {
    return { ok: false, reason: 'unsupported_platform', userDataDir: null, profiles: [] };
  }
  if (!fs.existsSync(userDataDir)) {
    return { ok: false, reason: 'user_data_dir_missing', userDataDir, profiles: [] };
  }

  const localStatePath = path.join(userDataDir, 'Local State');
  let infoCache: Record<string, { name?: string; user_name?: string; gaia_name?: string }> = {};
  try {
    const raw = fs.readFileSync(localStatePath, 'utf-8');
    const parsed = JSON.parse(raw);
    infoCache = parsed?.profile?.info_cache || {};
  } catch {
    // Fall through with empty infoCache — we'll still discover profiles by dir.
  }

  // Merge declared profiles from Local State with on-disk discoveries.
  const candidateIds = new Set<string>(Object.keys(infoCache));
  try {
    for (const entry of fs.readdirSync(userDataDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'Default' || /^Profile \d+$/.test(entry.name)) {
        candidateIds.add(entry.name);
      }
    }
  } catch {
    // ignore
  }

  const profiles: ChromeProfile[] = [];
  for (const id of candidateIds) {
    const info = infoCache[id] || {};
    const profileDir = path.join(userDataDir, id);
    profiles.push({
      id,
      name: info.name || null,
      userName: info.user_name || null,
      gaiaName: info.gaia_name || null,
      profileDir,
      exists: fs.existsSync(profileDir),
      sessionPath: sessionPathForProfile(id),
    });
  }

  // Stable ordering: Default first, then Profile N by number, others alpha.
  profiles.sort((a, b) => {
    if (a.id === 'Default') return -1;
    if (b.id === 'Default') return 1;
    const ma = a.id.match(/^Profile (\d+)$/);
    const mb = b.id.match(/^Profile (\d+)$/);
    if (ma && mb) return parseInt(ma[1], 10) - parseInt(mb[1], 10);
    return a.id.localeCompare(b.id);
  });

  return { ok: true, userDataDir, profiles };
}

/** Find a profile by its id (directory name), or by user email match. */
export function resolveProfile(idOrEmail: string): ChromeProfile | null {
  const { profiles } = listChromeProfiles();
  return (
    profiles.find((p) => p.id === idOrEmail) ||
    profiles.find((p) => p.userName && p.userName.toLowerCase() === idOrEmail.toLowerCase()) ||
    null
  );
}
