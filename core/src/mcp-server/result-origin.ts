// Per-result origin tag — appended to every MCP tool result so an LLM keeps
// connector/cluster/node awareness across follow-up calls (route the next call
// to the SAME connector; respect the cluster scope). Local-aware: a relayed
// (cloud) call names the fleet/hub; a direct/loopback call says LOCAL.
import type { McpToolResult } from './configure';
import { getHubConfig } from '../hub-client/hub-config';
import { getMyCluster } from '../cluster/cluster-config';
import { hubHostOf } from './fleet-identity';
import { currentMcpContext } from './principal-context';

export interface OriginParts {
  hubHost: string | null;
  hostname: string;
  cluster: string;
}

/** PURE — build the compact origin tag. `relayed` = came via a connector (hub). */
export function formatResultOriginTag(p: OriginParts, relayed: boolean): string {
  const node = `node:${p.hostname}`;
  const cl = `cluster:${p.cluster}`;
  return relayed && p.hubHost
    ? `⟦lm-assist@${p.hubHost} · ${node} · ${cl}⟧`
    : `⟦lm-assist · LOCAL · ${node} · ${cl}⟧`;
}

/** Resolve the origin tag from the current MCP principal + this node. NEVER throws. */
export function resultOriginTag(): string {
  let relayed = false;
  try { relayed = currentMcpContext()?.principal?.type === 'cloud'; } catch { /* no context → local */ }
  let hubHost: string | null = null;
  let hostname = 'this node';
  let cluster = 'default';
  try { const c = getHubConfig(); hubHost = hubHostOf(c.hubUrl); hostname = c.hostname || 'this node'; } catch { /* minimal */ }
  try { cluster = getMyCluster(); } catch { /* default */ }
  return formatResultOriginTag({ hubHost, hostname, cluster }, relayed);
}

/**
 * Append the origin tag to a text tool result. Skips: error results, non-text
 * results, and results that already carry the full FLEET / CONNECTOR IDENTITY
 * block (bootstrap/session_status/guide) so they aren't double-tagged.
 */
export function withOriginTag(result: McpToolResult): McpToolResult {
  if (result.isError) return result;
  const first = result.content?.[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') return result;
  // Skip results that LEAD with the FLEET / CONNECTOR IDENTITY block (bootstrap/
  // session_status/guide) so they aren't double-tagged. Start-anchored so a result
  // that merely echoes the phrase mid-text (e.g. search over these source files)
  // still gets its footer.
  if (first.text.trimStart().startsWith('FLEET / CONNECTOR IDENTITY')) return result;
  const tagged = { ...first, text: `${first.text}\n\n${resultOriginTag()}` };
  return { ...result, content: [tagged, ...result.content.slice(1)] };
}
