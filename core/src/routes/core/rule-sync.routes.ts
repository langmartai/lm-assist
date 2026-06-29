/**
 * Cross-node RULE sync routes — direct-MCP transport (sibling of memory-sync.routes.ts).
 *
 *   POST /rules/export  { key? }                                  -> this node's own USER rules
 *   POST /rules/ingest  { sourceHost, sourcePlatform, rules[], key? } -> OS-route + place a peer's set
 *   GET  /rules/sync/status                                       -> config + daemon
 *   GET  /rules/autosync/status                                   -> daemon only
 *
 * Both POSTs carry the access-key in the BODY: the hub machine-proxy drops x-lm-access-key.
 * Authorization mirrors memory-sync: loopback-only; a relayed (x-relay-source:hub) call needs the key.
 */
import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import { readOwnRules, selfHostId, applyIngest, IngestRule } from '../../rules/rule-sync';
import { getProjectSettings } from '../../project-settings';
// NOTE: the Task-4 daemon is loaded via a RUNTIME require() inside the status handlers
// (exactly like memory-autosync.routes.ts) — NOT a top-level import — so this routes file
// COMPILES in Task 3 before core/src/rules/autosync.ts exists. No stub needed.
import { readMemorySyncConfig } from '../../memory/node-mode';
import { isLoopbackAddress } from '../../auth/enroll-exempt';
import * as os from 'os';

function relaySource(req: ParsedRequest): string | undefined {
  const v = req.headers?.['x-relay-source'];
  return Array.isArray(v) ? v[0] : v;
}

/** Loopback-only; a relayed call (x-relay-source:hub) must carry the node key in the body. */
function authorized(req: ParsedRequest, bodyKey: unknown): boolean {
  if (!isLoopbackAddress(req.clientIp)) return false;
  if (relaySource(req) === 'hub') return typeof bodyKey === 'string' && bodyKey.length > 0;
  return true;
}

export function createRuleSyncRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    {
      method: 'POST',
      pattern: /^\/rules\/export$/,
      handler: async (req: ParsedRequest) => {
        const start = Date.now();
        const b = (req.body || {}) as { key?: string };
        if (!authorized(req, b.key)) return wrapError('FORBIDDEN', 'not authorized for rule sync', start);
        return wrapResponse({ host: selfHostId(), platform: os.platform(), rules: readOwnRules() }, start);
      },
    },
    {
      method: 'POST',
      pattern: /^\/rules\/ingest$/,
      handler: async (req: ParsedRequest) => {
        const start = Date.now();
        const b = (req.body || {}) as { sourceHost?: string; sourcePlatform?: string; rules?: IngestRule[]; key?: string };
        if (!authorized(req, b.key)) return wrapError('FORBIDDEN', 'not authorized for rule sync', start);
        if (!b.sourceHost || !Array.isArray(b.rules)) {
          return wrapError('INVALID_INPUT', 'sourceHost and rules[] are required', start);
        }
        const result = applyIngest(b.sourceHost, b.sourcePlatform || '', b.rules, os.platform());
        return wrapResponse(result, start);
      },
    },
    {
      method: 'GET',
      pattern: /^\/rules\/sync\/status$/,
      handler: async () => {
        const start = Date.now();
        // Graceful degradation: return a minimal daemon shape until Task-4 wires the daemon.
        let daemonStatus: any = { mode: 'not-initialized' };
        try {
          const { getRuleAutoSyncDaemon } = require('../../rules/autosync');
          daemonStatus = getRuleAutoSyncDaemon().getStatus();
        } catch (e: any) {
          // Only swallow MODULE_NOT_FOUND (daemon not yet wired); surface real errors.
          if ((e as any)?.code !== 'MODULE_NOT_FOUND') return wrapError('RULE_SYNC_STATUS_FAILED', String(e), start);
        }
        return wrapResponse({
          config: { ruleSyncEnabled: getProjectSettings().ruleSyncEnabled, nodeMode: readMemorySyncConfig().nodeMode },
          daemon: daemonStatus,
        }, start);
      },
    },
    {
      method: 'GET',
      pattern: /^\/rules\/autosync\/status$/,
      handler: async () => {
        const start = Date.now();
        try {
          const { getRuleAutoSyncDaemon } = require('../../rules/autosync');
          return wrapResponse(getRuleAutoSyncDaemon().getStatus(), start);
        } catch (e) {
          return wrapError('RULE_AUTOSYNC_STATUS_FAILED', String(e), start);
        }
      },
    },
  ];
}
