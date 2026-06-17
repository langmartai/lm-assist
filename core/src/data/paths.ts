// core/src/data/paths.ts
import * as os from 'os';
import * as path from 'path';
import { getDataDir } from '../utils/path-utils';

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
// M1 node identity: stable per host. M5 will unify this with the canonical machineId
// used by the knowledge/vector remote-sync layer.
export function thisNodeId(): string {
  return os.hostname() || 'local';
}
