/** Fleet-synced MCP tool-registry store (dataset `mcp-tool-registry`, syncMode:'full',
 *  scope:'fleet') — a thin instantiation of the generic overlay-doc store (doc-store.ts;
 *  the assist-content registry is the second consumer). All semantics — write-only
 *  dataset creation, coded refusal throws, per-name locks, inline full-state history,
 *  rollback-as-new-rev, protected-disable refusal on EVERY write path — live in the
 *  shared factory; this module contributes only the tool-specific spec. */
import {
  PROTECTED_TOOLS, TOOL_REGISTRY_HISTORY_CAP,
  validateToolName, validateDescriptionOverride,
  type ToolRegistryDoc, type ToolRegistryState,
} from './model';
import { lenOf, type OverlayDocPort } from './doc-model';
import { createOverlayDocStore } from './doc-store';
import type { MissionActor } from '../../mission/mission-model';

/** Dataset id shared with the write-side origin-anchor in mcp-tools.routes.ts. */
export const TOOL_REGISTRY_DATASET = 'mcp-tool-registry';

/** The seam the store reads/writes through. Tests inject an in-memory fake. */
export type ToolRegistryPort = OverlayDocPort<ToolRegistryState>;

const toolStore = createOverlayDocStore<ToolRegistryState>({
  dataset: TOOL_REGISTRY_DATASET,
  datasetTitle: 'MCP Tool Registry',
  label: 'tool-registry',
  historyCap: TOOL_REGISTRY_HISTORY_CAP,
  validateName: validateToolName,
  fields: [
    {
      key: 'descriptionOverride',
      defaultValue: null,
      validate: (v) => validateDescriptionOverride(v as string | null),
      summarize: (v) => lenOf(v as string | null),
    },
    {
      key: 'enabled',
      defaultValue: true,
      validate: (v) =>
        typeof v === 'boolean'
          ? { ok: true }
          : { ok: false, code: 'INVALID_INPUT', message: `enabled must be a boolean, got ${JSON.stringify(v)}` },
    },
  ],
  refuseWrite: (name, next) =>
    next.enabled === false && PROTECTED_TOOLS.has(name)
      ? { ok: false, code: 'PROTECTED_TOOL', message: `"${name}" is protected and cannot be disabled (orientation surface — see the design brief)` }
      : { ok: true },
});

export async function getToolDoc(name: string, port?: ToolRegistryPort): Promise<ToolRegistryDoc | null> {
  return toolStore.get(name, port);
}

export async function listToolDocs(port?: ToolRegistryPort): Promise<ToolRegistryDoc[]> {
  return toolStore.list(port);
}

export async function putToolDoc(
  input: { name: string; descriptionOverride?: string | null; enabled?: boolean },
  actor: MissionActor,
  port?: ToolRegistryPort,
): Promise<{ doc: ToolRegistryDoc; changed: boolean }> {
  return toolStore.put(input, actor, port);
}

/** Restore the full state of history entry `toRev` as a NEW revision. */
export async function rollbackToolDoc(
  name: string, toRev: number, actor: MissionActor,
  port?: ToolRegistryPort,
): Promise<{ doc: ToolRegistryDoc } | { error: { code: string; message: string } }> {
  return toolStore.rollback(name, toRev, actor, port);
}
