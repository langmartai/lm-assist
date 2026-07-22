import type { RouteHandler, RouteContext } from '../index';
import { loadStallStore } from '../../monitor/stall-store';
import { loadModelFallbackStore } from '../../monitor/model-fallback-store';
import { amIMonitor } from '../../monitor/stall-election';
import { getProjectSettings } from '../../project-settings';

/** Shared builder so the MCP `stall_status` tool returns the same payload. */
export async function buildStallStatus(elect: () => Promise<{ isMonitor: boolean; monitorNodeId: string | null }> = amIMonitor) {
  const store = loadStallStore();
  const sessions = Object.entries(store).map(([key, r]) => ({ key, attempts: r.attempts, category: r.category, lastNudgeAt: r.lastNudgeAt, gaveUp: r.gaveUp }));
  const m = await elect();
  const s = getProjectSettings();
  return {
    enabled: s.autoResumeStalledEnabled,
    amMonitor: m.isMonitor,
    monitorNodeId: m.monitorNodeId,
    attempts: sessions.reduce((a, x) => a + x.attempts, 0),
    gaveUp: sessions.filter((x) => x.gaveUp).length,
    sessions,
    // The MODEL class — a separate detector/action/store from the server-error resume
    // above. `switches` is the journal of `/model <fallback>` sends.
    modelFallback: {
      enabled: s.autoModelFallbackEnabled,
      fallbackModel: s.autoModelFallbackModel,
      fromModels: s.autoModelFallbackFrom,
      switches: Object.entries(loadModelFallbackStore()).map(([key, r]) => ({
        key, from: r.from, to: r.to, attempts: r.attempts, switchedAt: r.switchedAt, verified: r.verified,
      })),
    },
  };
}

export function createMonitorStallsRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    {
      method: 'GET',
      pattern: /^\/monitor\/stalls$/,
      handler: async () => ({ success: true, data: await buildStallStatus() }),
    },
  ];
}
