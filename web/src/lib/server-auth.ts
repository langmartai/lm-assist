import { readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

/**
 * x-api-key header for SERVER-SIDE (Next.js API route) calls to the local
 * worker core. The core gates every non-/health endpoint behind the
 * worker-owned rotating API token; server routes that call it must attach it or
 * get 401. Reads the same file web/src/app/layout.tsx injects to the browser.
 * Returns no header in hub mode / when the file is absent (safe no-op).
 */
export function serverAuthHeader(): Record<string, string> {
  try {
    const dir = process.env.LM_ASSIST_DATA_DIR || path.join(homedir(), '.lm-assist');
    const t = readFileSync(path.join(dir, 'api-token'), 'utf8').trim();
    if (t) return { 'x-api-key': t };
  } catch {
    /* hub mode / no file */
  }
  return {};
}
