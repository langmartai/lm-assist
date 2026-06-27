/** Resolve the MCP caller's identity into a globally-addressable MissionActor. Best-effort; never throws. */
import { MissionActor } from './mission-model';
import { resolveCallerCandidates } from '../mcp-server/mcp-session-resolver';
import { runWithMcpContext } from '../mcp-server/principal-context';

interface Candidates { claudeAi?: { id: string; label?: string }; claudeCode?: { id: string; label?: string }; precise?: boolean }

export async function resolveMcpActor(
  toolUseId: string | null | undefined,
  node: string,
  now: number,
  deps: { resolve?: () => Promise<Candidates> } = {},
): Promise<MissionActor> {
  const coarse: MissionActor = { kind: 'user', channel: 'mcp', node, toolUseId: toolUseId ?? null, at: now };
  if (!toolUseId) return coarse;
  try {
    const resolve = deps.resolve
      ?? (() => runWithMcpContext({ principal: { type: 'local' }, toolUseId }, () => resolveCallerCandidates()));
    const c = await resolve();
    if (c.precise && c.claudeCode) {
      return { kind: 'local-session', id: c.claudeCode.id, node, channel: 'mcp', label: c.claudeCode.label, toolUseId, at: now };
    }
    if (c.claudeAi) {
      return { kind: 'claudeai-conversation', id: c.claudeAi.id, channel: 'mcp', label: c.claudeAi.label, toolUseId, at: now };
    }
    if (c.claudeCode) {
      return { kind: 'local-session', id: c.claudeCode.id, node, channel: 'mcp', label: c.claudeCode.label, toolUseId, at: now };
    }
    return coarse;
  } catch {
    return coarse;
  }
}

/**
 * Stamp channel:'controller' on a write that originates from the elected controller session,
 * so it is distinguishable from a human MCP edit (used by recentExternalChanges to exclude it).
 * Pure: callers pass the current controller session id (e.g. (await getControllerSession())?.sessionId).
 */
export function upgradeControllerActor(actor: MissionActor, controllerSessionId: string | null | undefined): MissionActor {
  if (controllerSessionId && actor.kind === 'local-session' && actor.id === controllerSessionId) {
    return { ...actor, kind: 'controller', channel: 'controller' };
  }
  return actor;
}
