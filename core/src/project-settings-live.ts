/**
 * Live-apply of project-settings toggles — the side effects a settings change must trigger
 * so the running daemons follow the file without a Core restart. Shared by PUT
 * /project-settings and the data-bundle project-settings import: a writer that skips these
 * leaves the Settings UI showing one state while the node runs another.
 *
 * Every module is required lazily so importing this pulls no daemon in at load time.
 * Returns one line per failed side effect (never throws).
 */
import type { ProjectSettings } from './project-settings';

export function applyProjectSettingsSideEffects(prev: ProjectSettings, next: ProjectSettings): string[] {
  const errors: string[] = [];

  // Live-apply the memory-sync toggle: re-resolve the autosync daemon mode (no restart).
  if (prev.memorySyncEnabled !== next.memorySyncEnabled) {
    try {
      const mode = require('./memory/autosync').getAutoSyncDaemon().refreshMode();
      console.log(`[ProjectSettings] memorySyncEnabled=${next.memorySyncEnabled} → autosync mode=${mode}`);
    } catch (err: any) {
      console.error('[ProjectSettings] memory-sync toggle error:', err?.message);
      errors.push(`memorySyncEnabled: ${err?.message ?? err}`);
    }
  }

  // Live-apply the cross-project signpost toggle: start the sweep+watcher, or stop the watcher.
  if (prev.crossProjectSignpostEnabled !== next.crossProjectSignpostEnabled) {
    try {
      const sp = require('./memory/cross-project-signpost');
      if (next.crossProjectSignpostEnabled) sp.startCrossProjectSignpost();
      else sp.stopCrossProjectSignpost();
      console.log(`[ProjectSettings] crossProjectSignpostEnabled=${next.crossProjectSignpostEnabled}`);
    } catch (err: any) {
      console.error('[ProjectSettings] signpost toggle error:', err?.message);
      errors.push(`crossProjectSignpostEnabled: ${err?.message ?? err}`);
    }
  }

  // Live-apply the rule-sync toggle: re-resolve the rule-autosync daemon mode (no restart).
  if (prev.ruleSyncEnabled !== next.ruleSyncEnabled) {
    try {
      const mode = require('./rules/autosync').getRuleAutoSyncDaemon().refreshMode();
      console.log(`[ProjectSettings] ruleSyncEnabled=${next.ruleSyncEnabled} → rule-autosync mode=${mode}`);
    } catch (err: any) {
      console.error('[ProjectSettings] rule-sync toggle error:', err?.message);
      errors.push(`ruleSyncEnabled: ${err?.message ?? err}`);
    }
  }

  // Runtime load/unload knowledge system on toggle
  if (prev.knowledgeEnabled !== next.knowledgeEnabled) {
    try {
      if (next.knowledgeEnabled) {
        // Re-enable: start scheduler, pre-warm embedder + vector store
        console.log('[ProjectSettings] Knowledge enabled — starting scheduler and pre-warming');
        const { getKnowledgeScheduler } = require('./knowledge/scheduler');
        getKnowledgeScheduler().start();
        const { getEmbedder } = require('./vector/embedder');
        const { getVectorStore } = require('./vector/vector-store');
        getEmbedder().load().catch(() => {});
        getVectorStore().init().catch(() => {});
      } else {
        // Disable: stop scheduler, destroy embedder + vector store to free memory
        console.log('[ProjectSettings] Knowledge disabled — stopping scheduler and unloading');
        const { getKnowledgeScheduler } = require('./knowledge/scheduler');
        getKnowledgeScheduler().stop();
        const { destroyEmbedder } = require('./vector/embedder');
        destroyEmbedder();
        const { destroyVectorStore } = require('./vector/vector-store');
        destroyVectorStore();
      }
    } catch (err: any) {
      console.error('[ProjectSettings] Knowledge toggle error:', err.message);
      errors.push(`knowledgeEnabled: ${err?.message ?? err}`);
    }
  }

  return errors;
}
