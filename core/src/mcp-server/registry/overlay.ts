/** Pure overlay application (spec §4.4): the registry's per-tool deltas applied to
 *  the code-owned tool defs at tools/list + tools/call time. Dependency-light on
 *  purpose — configure.ts (shipped in the stdio plugin binary) imports this module,
 *  so it must not pull the store/data-service or any tools/* handler. */
import { PROTECTED_TOOLS, type ToolRegistryDoc } from './model';

export interface ToolOverlay {
  byName: Record<string, { enabled: boolean; descriptionOverride: string | null }>;
}

/** How a transport obtains the current overlay. `null` (or a throw) ⇒ no overlay —
 *  fail-open: the MCP surface serves code defaults rather than breaking. The overlay
 *  is a management layer, not a security boundary (that stays TOOL_SCOPES + gates). */
export interface OverlayProvider {
  get(): Promise<ToolOverlay | null>;
}

export function overlayFromDocs(docs: ToolRegistryDoc[]): ToolOverlay {
  const byName: ToolOverlay['byName'] = {};
  for (const d of docs) {
    byName[d.name] = {
      // The store refuses protected disables, but the fleet dataset can be written
      // around it (data_put) — re-assert here so no doc can ever disable the
      // orientation trio. Description overrides remain allowed.
      enabled: PROTECTED_TOOLS.has(d.name) ? true : d.enabled,
      descriptionOverride: d.descriptionOverride,
    };
  }
  return { byName };
}

/** Apply the overlay to an advertised def list: drop disabled tools, swap overridden
 *  descriptions. Pure — never mutates the canonical defs; overlay entries whose name
 *  isn't in `defs` are ignored (mixed-version fleets, scratch docs). */
export function applyOverlayToToolDefs<T extends { name: string; description?: string }>(
  defs: ReadonlyArray<T>,
  overlay: ToolOverlay | null,
): T[] {
  if (!overlay) return [...defs];
  const out: T[] = [];
  for (const def of defs) {
    const delta = overlay.byName[def.name];
    if (!delta) { out.push(def); continue; }
    if (delta.enabled === false) continue;
    out.push(delta.descriptionOverride != null ? { ...def, description: delta.descriptionOverride } : def);
  }
  return out;
}

export function isToolDisabled(overlay: ToolOverlay | null, name: string): boolean {
  return overlay?.byName[name]?.enabled === false;
}

/** The clear DISABLED rejection every surface returns for a call to a disabled tool. */
export function disabledResult(name: string): { content: Array<{ type: string; text: string }>; isError: true } {
  return {
    isError: true,
    content: [{
      type: 'text',
      text:
        `⛔ TOOL_DISABLED — "${name}" is disabled in the lm-assist MCP tool registry. ` +
        `It was not executed. Re-enable it on the /mcp-tools page (or POST /mcp-tools/${name} {"enabled":true}).`,
    }],
  };
}
