import { readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

/**
 * x-api-key header for SERVER-SIDE (Next.js API route) calls to the local
 * worker core. The core gates every non-/health endpoint behind the
 * worker-owned rotating API token; server routes that call it must attach it or
 * get 401. This is the ONLY web code that reads the token file: the root layout
 * no longer injects anything into the page, and browsers fetch their token from
 * Core's GET /auth/browser-token, where Core judges the real socket peer.
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

/**
 * Base URL of THIS node's Core for server-side calls. Prefers the runtime port
 * (LM_LOCAL_API_PORT, set by the launcher) over the build-time NEXT_PUBLIC value,
 * because one build serves both prod (:3100) and dev (:3200). 127.0.0.1 rather than
 * localhost: on Windows localhost can resolve to ::1 while Core listens on IPv4.
 */
export function coreBaseUrlServer(): string {
  const port = process.env.LM_LOCAL_API_PORT || process.env.NEXT_PUBLIC_LOCAL_API_PORT || '3100';
  return `http://127.0.0.1:${port}`;
}
