/** Code-derived MCP tool catalog (spec §4.3): name → { def, scope, category, module,
 *  protected } + handler source for the read-only Implementation view.
 *
 *  Category/module are a curated static map (the TOOL_SCOPES precedent — one exact
 *  entry per tool) rather than runtime imports of every tools/* def array; the
 *  completeness test in mcp-tool-catalog.test.ts fails the suite the moment a tool
 *  is advertised without an entry here, exactly like assertScopesCoverTools().
 *
 *  Imported by routes only (core process) — configure.ts/stdio must NOT import this
 *  (it pulls every handler module for String(handler)).
 */
import { LM_ASSIST_TOOL_DEFS, TOOL_SCOPES, type ToolScope } from '../configure';
import { PROTECTED_TOOLS } from './model';
import { EXPANDED_HANDLERS } from '../tools/expanded';
import { handleSearch } from '../tools/search';
import { handleDetail } from '../tools/detail';
import { handleFeedback } from '../tools/feedback';
import { handleListRecentSessions } from '../tools/list-recent-sessions';
import { handleListProjects } from '../tools/list-projects';
import { handleSearchMemory } from '../tools/search-memory';
import { handleListClaudeaiConversations } from '../tools/list-claudeai-conversations';
import { handleReadConversation } from '../tools/read-conversation';

export interface ToolCatalogEntry {
  name: string;
  def: (typeof LM_ASSIST_TOOL_DEFS)[number];
  scope: ToolScope;
  category: string;
  module: string;
  protected: boolean;
}

// CATEGORY_ORDER and the tool→category/module map live in categories.ts so that the
// tools/list path can import them without pulling every handler module in here.
export { CATEGORY_ORDER } from './categories';
import { CATEGORY_ORDER as _CAT_ORDER, categoryMeta, T, type Meta } from './categories';
const META = categoryMeta();
void _CAT_ORDER; void (null as unknown as Meta);

let _catalog: Map<string, ToolCatalogEntry> | null = null;

/** name → entry for every ADVERTISED tool. Names without META fall back to
 *  category 'other' / module expanded.ts — the completeness test turns any such
 *  fallback into a failure, so drift is caught at test time, not hidden. */
export function getToolCatalog(): ReadonlyMap<string, ToolCatalogEntry> {
  if (_catalog) return _catalog;
  const m = new Map<string, ToolCatalogEntry>();
  for (const def of LM_ASSIST_TOOL_DEFS) {
    const meta = META[def.name];
    m.set(def.name, {
      name: def.name,
      def,
      scope: TOOL_SCOPES[def.name] ?? 'admin',
      category: meta?.category ?? 'other',
      module: meta?.module ?? `${T}/expanded.ts`,
      protected: PROTECTED_TOOLS.has(def.name),
    });
  }
  _catalog = m;
  return m;
}

const BASE_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  search: handleSearch,
  detail: handleDetail,
  feedback: handleFeedback,
  list_recent_sessions: handleListRecentSessions,
  list_projects: handleListProjects,
  search_memory: handleSearchMemory,
  list_claudeai_conversations: handleListClaudeaiConversations,
  read_conversation: handleReadConversation,
};

/** The registered in-process handler's source (String(fn)) + its defining module —
 *  the read-only Implementation view. Null when the tool has no in-process handler
 *  (unknown name). Some expanded entries are thin arrow wrappers; the module
 *  pointer is the primary navigation aid, the source is best-effort per spec. */
export function handlerSourceFor(name: string): { module: string; source: string } | null {
  const fn = BASE_HANDLERS[name] ?? EXPANDED_HANDLERS[name];
  if (!fn) return null;
  const meta = META[name];
  return { module: meta?.module ?? `${T}/expanded.ts`, source: String(fn) };
}
