// core/src/data/paths.ts
import * as os from 'os';
import * as path from 'path';
import { getDataDir } from '../utils/path-utils';
import { getHubConfig } from '../hub-client/hub-config';

// Mirror the hub-config dev/prod split so dev (repo) and prod (npm) never collide.
const IS_DEV_REPO = process.env.LM_ASSIST_PROD === 'true' ? false : !__dirname.includes('node_modules');
const DEV_SUFFIX = IS_DEV_REPO ? '-dev' : '';

export function dataRoot(): string {
  return path.join(getDataDir(), `data${DEV_SUFFIX}`);
}
export function datasetsFile(): string {
  return path.join(dataRoot(), 'datasets.json');
}
export function keysDir(): string {
  return path.join(dataRoot(), 'keys.lmdb');
}
export function cacheDirFor(datasetId: string): string {
  return path.join(dataRoot(), 'cache', `${datasetId}.lmdb`);
}
/** Store dir for the generic vector backend's per-dataset LanceDB tables (ds_<id>).
 *  Separate from the knowledge `lance-store/vectors` table so the two never collide. */
export function vectorStoreDir(): string {
  return path.join(dataRoot(), 'vectors');
}
// Canonical fleet node id: hub-assigned gatewayId when registered, else the stable machineId,
// else hostname. Matches what the hub + knowledge remote-sync use to identify a node.
export function thisNodeId(): string {
  try {
    const cfg = getHubConfig();
    return cfg.gatewayId || cfg.machineId || os.hostname() || 'local';
  } catch {
    return os.hostname() || 'local';
  }
}
/** Storage dir for a remote node's replica of a dataset (used by the sync engine, M5+). */
export function remoteDir(node: string, datasetId: string): string {
  return path.join(dataRoot(), 'remote', node, `${datasetId}.lmdb`);
}
