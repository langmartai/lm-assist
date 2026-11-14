import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

/**
 * The LAN access settings shared by the web server and Core (SERVER-ONLY — never
 * import from a client component; it holds the LAN credential).
 *
 * The path must match Core's getDataDir() (`LM_ASSIST_DATA_DIR`, else ~/.lm-assist),
 * because Core reads the same file to decide LAN-key grants on
 * GET /auth/browser-token. The routes used to hard-code ~/.lm-assist, so a Core run
 * with a different data dir silently disagreed with the web about the LAN key.
 */
export interface AssistConfig {
  lanEnabled?: boolean;
  /** true (the default): LAN browsers may sign in. false: only this machine can use the dashboard. */
  lanAuthEnabled?: boolean;
  lanAccessToken?: string;
}

export function assistDataDir(): string {
  return process.env.LM_ASSIST_DATA_DIR || path.join(homedir(), '.lm-assist');
}

export function assistConfigFile(): string {
  return path.join(assistDataDir(), 'assist-config.json');
}

export function readAssistConfig(): AssistConfig {
  try {
    const parsed = JSON.parse(readFileSync(assistConfigFile(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed as AssistConfig : {};
  } catch {
    return {};
  }
}

export function writeAssistConfig(config: AssistConfig): void {
  const file = assistConfigFile();
  mkdirSync(path.dirname(file), { recursive: true });
  // 0600: holds the lanAccessToken (LAN credential) — owner-only; chmod repairs
  // pre-existing loose files, since the mode option only applies on create.
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best-effort (e.g. Windows) */ }
}
