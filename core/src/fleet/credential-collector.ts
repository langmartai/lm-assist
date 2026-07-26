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
  // Account identity comes from the COOKIE, not from the probe. Measured on
  // prod: /api/account_profile returns a flat preferences object with no
  // `account` or `organization` key, so probe.accountUuid/organizationName are
  // always undefined — and a credential report with no account would let a fork
  // land in the wrong login silently, which is the thing this must prevent.
  // `lastActiveOrg` / `ajs_user_id` are in the cookie jar and cost nothing.
  let orgUuid: string | undefined;
  let userId: string | undefined;
  try {
    const s = getClaudeAISessionStatus();
    configured = Boolean(s.present);
    sessionKeyExpiresAt = s.sessionKeyExpiresAt;
    orgUuid = s.identity?.orgUuid;
    userId = s.identity?.userId;
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
        accountUuid: orgUuid,
        userId,
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
        accountUuid: p.accountUuid || orgUuid,
        organizationName: p.organizationName,
        userId,
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
        accountUuid: orgUuid,
        userId,
        sessionKeyExpiresAt,
      },
    };
  }
}
