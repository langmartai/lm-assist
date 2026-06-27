// A node's own cluster identity. Authoritative for THIS node; published into the
// fleet-wide `node-clusters` dataset by cluster-store.ts so peers learn it.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const IS_DEV_REPO = !__dirname.includes('node_modules');
const FILE = `cluster${IS_DEV_REPO ? '-dev' : ''}.json`;

export function clusterName(raw: string | null | undefined): string {
  const n = (raw ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  return n || 'default';
}

function configPath(): string {
  return path.join(os.homedir(), '.lm-assist', FILE);
}

export function getMyCluster(): string {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
    return clusterName(raw?.cluster);
  } catch {
    return 'default';
  }
}

export function setMyCluster(name: string): string {
  const cluster = clusterName(name);
  const dir = path.join(os.homedir(), '.lm-assist');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify({ cluster }), 'utf-8');
  return cluster;
}
