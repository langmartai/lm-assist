/**
 * `lm-assist token …` — operator commands for the local api-token and the LAN key.
 *
 *   token rotate --now [--lan-key]   revoke-now: new ring token, EVERY old token dies
 *                                    (current + grace), optionally a new LAN key too
 *   token lan-key --regenerate       new LAN access key (NEW sign-ins need it; devices already
 *                                    signed in hold the ring token and keep access until
 *                                    `token rotate --now`)
 *   token status                     data dir, timestamps and counts — never a value
 *
 * Invoke as `node core/dist/cli.js token …` (dev checkout) or
 * `node "$(npm root -g)/lm-assist/core/dist/cli.js" token …` (npm install).
 *
 * Deliberately explicit: nothing here runs on boot, and `rotate` without `--now` refuses.
 * It acts on the data dir of THIS process (LM_ASSIST_DATA_DIR or ~/.lm-assist) — every
 * Core sharing that dir is affected.
 */
import * as fs from 'fs';
import {
  apiTokenFilePath,
  apiTokenStatus,
  initApiToken,
  rotateApiTokenNow,
} from './api-token';
import { readLanAccessConfig, regenerateLanAccessToken } from './lan-access';
import { getDataDir } from '../utils/path-utils';

type Print = (line: string) => void;

const USAGE = [
  'Usage:',
  '  lm-assist token rotate --now [--lan-key]   revoke every current token and mint a new one',
  '  lm-assist token lan-key --regenerate       replace the LAN access key',
  '  lm-assist token status                     show token state (never prints a secret)',
].join('\n');

function iso(ms: number): string {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : 'unknown';
}

export async function runTokenCommand(
  argv: string[],
  out: Print = (l) => console.log(l),
  err: Print = (l) => console.error(l),
): Promise<number> {
  const [sub, ...rest] = argv;
  const flags = new Set(rest);
  try {
    switch (sub) {
      case 'rotate': {
        if (!flags.has('--now')) {
          err('`token rotate` needs --now: it revokes every current token immediately (no grace).');
          err(USAGE);
          return 2;
        }
        // initApiToken only — NEVER startApiTokenRotation (that would arm a timer and
        // could run a scheduled rotation in this short-lived process).
        initApiToken();
        const r = rotateApiTokenNow();
        let lan = false;
        if (flags.has('--lan-key')) {
          regenerateLanAccessToken();
          lan = true;
        }
        out(`data dir:        ${getDataDir()}`);
        out(`rotated at:      ${iso(r.rotatedAt)}`);
        out(`tokens revoked:  ${r.revokedCount}`);
        if (lan) out('LAN access key:  regenerated — LAN browsers must sign in again');
        out('');
        out('Every Core on this build sharing this data dir drops the old tokens within about 1 s.');
        out('Restart any OLDER Core that shares this data dir — it keeps the old token valid until it restarts.');
        out('Open dashboard tabs re-fetch their token automatically; scripts re-read the token file.');
        return 0;
      }
      case 'lan-key': {
        if (!flags.has('--regenerate')) {
          err('`token lan-key` needs --regenerate.');
          err(USAGE);
          return 2;
        }
        regenerateLanAccessToken();
        out(`data dir:        ${getDataDir()}`);
        out('LAN access key:  regenerated — new LAN sign-ins need the new key');
        out('');
        out('Devices that already signed in hold the ring token and KEEP ACCESS until you run');
        out('`lm-assist token rotate --now` — which cuts off every dashboard tab and script using the old');
        out('token (this machine re-fetches automatically).');
        return 0;
      }
      case 'status': {
        // Read-only: never init (which could write or rotate) — just report the files.
        const st = apiTokenStatus();
        let mtime = 'missing';
        try {
          mtime = iso(fs.statSync(apiTokenFilePath()).mtimeMs);
        } catch {
          /* missing */
        }
        const lan = readLanAccessConfig();
        out(`data dir:            ${getDataDir()}`);
        out(`token file written:  ${mtime}`);
        out(`last rotated:        ${st.lastRotatedAt === null ? 'unknown (no meta file)' : iso(st.lastRotatedAt)}`);
        out(`grace tokens:        ${st.graceCount}`);
        out(`revoked tokens:      ${st.revokedCount}`);
        out(`lanAuthEnabled:      ${lan.lanAuthEnabled}`);
        out(`LAN key configured:  ${lan.lanAccessToken ? 'yes' : 'no'}`);
        return 0;
      }
      case 'help':
      case '--help':
        out(USAGE);
        return 0;
      default:
        if (sub) err(`Unknown token command: ${sub}`);
        err(USAGE);
        return 2;
    }
  } catch (e) {
    // Messages from these paths name files, never token values.
    err(`token ${sub}: ${(e as Error).message}`);
    return 1;
  }
}
