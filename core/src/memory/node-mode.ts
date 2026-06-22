/**
 * Node mode + home-node config for cross-node memory sync.
 *
 * Persistent nodes hold the durable canonical memory; ephemeral (cloud) nodes treat their
 * memory dir as a working copy and sync new project-domain memory back to a `homeNode`.
 * Stored in ~/.lm-assist/memory-sync.json (or $LM_ASSIST_DATA_DIR/memory-sync.json),
 * the same dir convention used by the hub/port-forward/transfer config.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type NodeMode = 'persistent' | 'ephemeral';
export interface MemorySyncConfig {
  nodeMode: NodeMode;
  homeNode: string | null;  // hub gatewayId of the persistent home node to sync with
  project: string | null;   // project slug this ephemeral node is working on
}

const DEFAULTS: MemorySyncConfig = { nodeMode: 'persistent', homeNode: null, project: null };

function baseDir(homeDir: string): string {
  return process.env.LM_ASSIST_DATA_DIR || path.join(homeDir, '.lm-assist');
}

/** Read memory-sync.json (override home dir for tests). Never throws. */
export function readMemorySyncConfig(homeDir: string = os.homedir()): MemorySyncConfig {
  const p = path.join(baseDir(homeDir), 'memory-sync.json');
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return {
      nodeMode: raw.nodeMode === 'ephemeral' ? 'ephemeral' : 'persistent',
      homeNode: typeof raw.homeNode === 'string' && raw.homeNode ? raw.homeNode : null,
      project: typeof raw.project === 'string' && raw.project ? raw.project : null,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Write the config (used by cloud bootstrap), merging onto any existing values. Never throws. */
export function writeMemorySyncConfig(cfg: Partial<MemorySyncConfig>, homeDir: string = os.homedir()): void {
  const dir = baseDir(homeDir);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const merged = { ...readMemorySyncConfig(homeDir), ...cfg };
    fs.writeFileSync(path.join(dir, 'memory-sync.json'), JSON.stringify(merged, null, 2));
  } catch { /* best-effort */ }
}
