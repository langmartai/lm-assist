// core/src/data/system-datasets.ts
// Reserved system datasets that expose existing stores through the generic data service.
// Registered idempotently at service init. Gating: read open to all authed callers;
// write/delete/manage local-only by default (an operator adds a cloud { userId, actions } rule to grant more).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatasetRegistry } from './dataset-registry';
import type { BackendKind, BackendConfig, AclRule } from './types';
import { getDataDir } from '../utils/path-utils';
import { isHardExcludedPath } from './redaction';

const GATING_ACL: AclRule[] = [
  { principal: '*', actions: ['read', 'query', 'search'] },
  { principal: 'local', actions: ['write', 'delete', 'manage'] },
];

export const SYSTEM_DATASETS: Array<{ id: string; backend: BackendKind; config: BackendConfig; title: string }> = [
  { id: 'knowledge', backend: 'knowledge', config: { kind: 'knowledge' }, title: 'Knowledge base (system)' },
  { id: 'vectors', backend: 'vectors', config: { kind: 'vectors' }, title: 'Vector index (system)' },
];

const CACHE_DIR = () => path.join(os.homedir(), '.cache', 'lm-assist');
const LOGS_DIR = () => path.join(getDataDir(), 'logs');

/** Curated allow-list of known lm-assist artifacts exposed read-only. Only those that EXIST
 *  (and are not credential paths) are registered. Resolver fns keep paths lazy/portable. */
export const TRACKED_FILES: Array<{ id: string; resolvePath: () => string; format: 'json' | 'log'; title: string; maxLines?: number }> = [
  { id: 'log-context-inject', resolvePath: () => path.join(LOGS_DIR(), 'context-inject-hook.log'), format: 'log', title: 'Context-inject hook log', maxLines: 1000 },
  { id: 'log-mcp-calls', resolvePath: () => path.join(LOGS_DIR(), 'mcp-calls.jsonl'), format: 'log', title: 'MCP call log', maxLines: 1000 },
  { id: 'log-upgrade', resolvePath: () => path.join(CACHE_DIR(), 'upgrade.log'), format: 'log', title: 'Upgrade log', maxLines: 500 },
  { id: 'json-learning-signals', resolvePath: () => path.join(CACHE_DIR(), 'learning-signals.json'), format: 'json', title: 'Learning signals (script-owned)' },
  { id: 'json-project-summaries', resolvePath: () => path.join(CACHE_DIR(), 'project-summaries.json'), format: 'json', title: 'Project summaries (script-owned)' },
  { id: 'json-prompt-queue', resolvePath: () => path.join(CACHE_DIR(), 'prompt-queue.json'), format: 'json', title: 'Prompt queue (script-owned)' },
];

const TRACKED_ACL: AclRule[] = [{ principal: '*', actions: ['read', 'query', 'search'] }];

/** Idempotently register the allow-listed tracked files that exist and are not credential paths. */
export function ensureTrackedFiles(registry: DatasetRegistry): void {
  for (const t of TRACKED_FILES) {
    if (registry.get(t.id)) continue;
    let p: string;
    try { p = t.resolvePath(); } catch { continue; }
    if (!p || isHardExcludedPath(p)) continue;     // never expose a credential path
    if (!fs.existsSync(p)) continue;               // allow-list only what actually exists
    registry.create({
      id: t.id, backend: 'file', title: t.title,
      visibility: 'cross-node-readable', system: true, readOnly: true,
      config: { kind: 'file', path: p, format: t.format, ...(t.maxLines ? { maxLines: t.maxLines } : {}) },
      acl: TRACKED_ACL.map((a) => ({ ...a, actions: [...a.actions] })),
      syncMode: 'none',
    });
  }
}

/** Idempotently ensure the reserved system datasets exist in the registry. */
export function ensureSystemDatasets(registry: DatasetRegistry): void {
  for (const s of SYSTEM_DATASETS) {
    if (registry.get(s.id)) continue;
    registry.create({
      id: s.id, backend: s.backend, title: s.title,
      visibility: 'cross-node-readable', // reads allowed cross-node; mutate/manage still ACL+key gated
      system: true,
      config: s.config,
      acl: GATING_ACL.map((a) => ({ ...a, actions: [...a.actions] })),
      syncMode: 'none',
    });
  }
}
