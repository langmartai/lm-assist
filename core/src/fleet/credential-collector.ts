/**
 * This node's claude.ai credential status, for `/fleet/credentials/local`.
 *
 * Kept apart from credential-fleet.ts so the selection policy there stays pure
 * and testable without a cookie, a hub or a network.
 *
 * SECRET-FREE BY CONSTRUCTION. It reports whether a cookie WORKS and which
 * ACCOUNT it belongs to — never the cookie, and never the account email. The
 * probe already hashes the email (`emailHash`) for exactly this reason, and this
 * report does not carry even that. What crosses the relay is: a verdict, a
 * reason code, an org name and an org/account uuid.
 */
import { getClaudeAISessionStatus, probeClaudeAISession } from '../utils/claudeai-session';
import { getHubConfig } from '../hub-client/hub-config';
import { getMyCluster } from '../cluster/cluster-config';
import type { NodeCredential, CredentialReason } from './credential-fleet';

/**
 * @param probe when false, skip the live claude.ai call and report `unprobed`.
 *   A configured-but-unprobed cookie is NOT `ok` — only a 200 means usable.
 */
export async function collectLocalCredential(probe = true): Promise<NodeCredential> {
  const cfg = getHubConfig();
  const hostId = cfg.gatewayId || cfg.machineId || 'unknown';
  const displayName = cfg.hostname || 'unknown';

  let cluster = 'default';
  try {
    cluster = getMyCluster();
  } catch {
    /* cluster map unreadable — 'default' is the documented implicit cluster */
  }

  let configured = false;
  let sessionKeyExpiresAt: number | null | undefined;
  try {
    const s = getClaudeAISessionStatus();
    configured = Boolean(s.present);
    sessionKeyExpiresAt = s.sessionKeyExpiresAt;
  } catch {
    /* treat an unreadable session file as not configured */
  }

  if (!probe) {
    return {
      hostId,
      displayName,
      cluster,
      isSelf: true,
      cookie: {
        configured,
        ok: false,
        reason: 'unprobed' as CredentialReason,
        hint: 'Not live-checked. Only a 200 from claude.ai proves the cookie is usable.',
        sessionKeyExpiresAt,
      },
    };
  }

  try {
    const p = await probeClaudeAISession();
    return {
      hostId,
      displayName,
      cluster,
      isSelf: true,
      cookie: {
        configured,
        ok: Boolean(p.ok),
        reason: p.reason as CredentialReason,
        hint: p.hint,
        accountUuid: p.accountUuid,
        organizationName: p.organizationName,
        sessionKeyExpiresAt,
      },
    };
  } catch (err) {
    return {
      hostId,
      displayName,
      cluster,
      isSelf: true,
      cookie: {
        configured,
        ok: false,
        reason: 'unknown' as CredentialReason,
        hint: err instanceof Error ? err.message : String(err),
        sessionKeyExpiresAt,
      },
    };
  }
}
