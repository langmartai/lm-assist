// Per-result trailer — appended to every MCP tool result. Three jobs, one seam:
//
//   1. ORIGIN — connector/cluster/node awareness across follow-up calls (route the next
//      call to the SAME connector; respect the cluster scope). Local-aware: a relayed
//      (cloud) call names the fleet/hub; a direct/loopback call says LOCAL.
//   2. PLAYBOOK — the guide topic governing the tool that just answered, folded INTO the
//      origin tag so it costs no extra line. MCP has no session-start callback, so a
//      session that never called `bootstrap` would otherwise never see the routing; this
//      makes the result of whatever tool it DID reach for carry the pointer.
//   3. NAMING — a reminder to name things rather than read ids, emitted ONLY when the
//      result actually carries ids. It appears exactly when the model is about to speak
//      them, and is silent otherwise.
//
// Design: docs/superpowers/specs/2026-07-25-bootstrap-session-start-routing-design.md
import type { McpToolResult } from './configure';
import { getHubConfig } from '../hub-client/hub-config';
import { getMyCluster } from '../cluster/cluster-config';
import { hubHostOf } from './fleet-identity';
import { currentMcpContext } from './principal-context';
import { playbookTopicForTool } from './tool-topics';

export interface OriginParts {
  hubHost: string | null;
  hostname: string;
  cluster: string;
}

/** PURE — build the compact origin tag. `relayed` = came via a connector (hub).
 *  `topic` (optional) folds the governing playbook in, so the pointer costs no extra line. */
export function formatResultOriginTag(p: OriginParts, relayed: boolean, topic?: string | null): string {
  const node = `node:${p.hostname}`;
  const cl = `cluster:${p.cluster}`;
  const play = topic ? ` · playbook: guide("${topic}")` : '';
  return relayed && p.hubHost
    ? `⟦lm-assist@${p.hubHost} · ${node} · ${cl}${play}⟧`
    : `⟦lm-assist · LOCAL · ${node} · ${cl}${play}⟧`;
}

/** Resolve the origin tag from the current MCP principal + this node. NEVER throws. */
export function resultOriginTag(topic?: string | null): string {
  let relayed = false;
  try { relayed = currentMcpContext()?.principal?.type === 'cloud'; } catch { /* no context → local */ }
  let hubHost: string | null = null;
  let hostname = 'this node';
  let cluster = 'default';
  try { const c = getHubConfig(); hubHost = hubHostOf(c.hubUrl); hostname = c.hostname || 'this node'; } catch { /* minimal */ }
  try { cluster = getMyCluster(); } catch { /* default */ }
  return formatResultOriginTag({ hubHost, hostname, cluster }, relayed, topic);
}

/** The identifier shapes lm-assist hands back: prefixed ids (bl_/mission_/cse_/gw4-/sess_/
 *  exec_/wf_) and bare uuids. Deliberately narrow — a false positive costs a stray line of
 *  advice, so it is anchored on real prefixes rather than "any hex-looking token". */
const ID_PATTERN =
  /\b(?:bl_[0-9a-z]{6,}|mission_[0-9a-z]{6,}|cse_[0-9A-Za-z]{8,}|sess_[0-9A-Za-z]{8,}|exec_[0-9A-Za-z]{8,}|wf_[0-9a-z]{6,}|gw\d+-[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/;

/** PURE — does this result hand the caller identifiers it might read out? */
export function resultCarriesIds(text: string): boolean {
  return ID_PATTERN.test(text);
}

/** The naming reminder. One line: it rides results that are often long, and the rule itself
 *  is short. The full playbook is guide("speaking"). */
export const NAMING_LINE =
  '⟦naming⟧ the ids above are handles for tools — when reporting back, say what each one IS (its name / what it is about). SPEAKING (voice): never read an id aloud. guide("speaking")';

/**
 * Append the trailer to a text tool result. Skips: error results, non-text results, and
 * results that already carry the full FLEET / CONNECTOR IDENTITY block (bootstrap/
 * session_status/guide) so they aren't double-tagged.
 *
 * `toolName` is optional — an unmapped or absent name simply yields no playbook pointer.
 */
export function withOriginTag(result: McpToolResult, toolName?: string): McpToolResult {
  if (result.isError) return result;
  const first = result.content?.[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') return result;
  // Skip results that LEAD with the FLEET / CONNECTOR IDENTITY block (bootstrap/
  // session_status/guide) so they aren't double-tagged. Start-anchored so a result
  // that merely echoes the phrase mid-text (e.g. search over these source files)
  // still gets its footer.
  if (first.text.trimStart().startsWith('FLEET / CONNECTOR IDENTITY')) return result;
  // Detect ids on the ORIGINAL text, before the tag (whose node/cluster names must never
  // themselves trigger the naming line).
  const naming = resultCarriesIds(first.text) ? `\n${NAMING_LINE}` : '';
  const topic = toolName ? playbookTopicForTool(toolName) : null;
  const tagged = { ...first, text: `${first.text}\n\n${resultOriginTag(topic)}${naming}` };
  return { ...result, content: [tagged, ...result.content.slice(1)] };
}
