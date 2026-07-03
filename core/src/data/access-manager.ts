// core/src/data/access-manager.ts
import * as crypto from 'crypto';
import type {
  Principal, DatasetDescriptor, DataAction, AccessKey, AccessRequest, Grant, AclRule,
} from './types';
import type { DatasetRegistry } from './dataset-registry';
import type { KeyStore } from './key-store';
import type { ParsedRequest } from '../routes/index';

const READ_ONLY_ACTIONS: DataAction[] = ['read', 'query', 'search'];
const TTL_DEFAULT = 3600;       // 1h
const TTL_MAX = 24 * 3600;      // 24h
const TTL_MIN = 60;

export type IssueResult =
  | { ok: true; key: string; keyId: string; grants: Grant[]; expiresAt: string }
  | { ok: false; reason: string };

export type EnforceResult =
  | { ok: true; principal: Principal }
  | { ok: false; code: string; status: number; reason: string };

function header(req: ParsedRequest, name: string): string | undefined {
  const v = req.headers?.[name];
  return Array.isArray(v) ? v[0] : v;
}

function isLoopbackAddress(ip?: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function principalMatches(rule: AclRule['principal'], p: Principal): boolean {
  if (rule === '*') return true;
  if (typeof rule === 'string') return rule === p.type;
  return p.type === 'cloud' && p.userId === rule.userId;
}

export class AccessManager {
  constructor(private deps: { datasets: DatasetRegistry; keys: KeyStore; nodeId: string }) {}

  /** Expose the underlying KeyStore so DataService.listKeys can list/strip keys consistently. */
  get keyStore(): KeyStore { return this.deps.keys; }

  resolvePrincipal(req: ParsedRequest): Principal {
    // `x-relay-source` is set server-side by the hub relay, which strips any client-supplied copy
    // (see api-relay-handler) — so it is a trustworthy signal that this is a relayed (cloud) call.
    // `x-lm-user-id` is likewise relay-controlled (stripped from client input); it is unset in M1
    // until the hub injects a verified user id, so cloud callers get only '*'/cloud-class grants.
    if (header(req, 'x-relay-source') === 'hub') {
      return { type: 'cloud', userId: header(req, 'x-lm-user-id') };
    }
    // A fabric peer RPC arrives via the rpc-server's loopbackDispatch (127.0.0.1) carrying
    // x-relay-source:'peer' + x-lm-peer-node. Honor a peer principal ONLY from a genuine loopback
    // origin — that is the only path that can set this header (a non-loopback caller forging it must
    // NOT get peer trust). Checked BEFORE the loopback→local branch precisely because a peer RPC IS
    // loopback: without this, a peer sync call would resolve to LOCAL ROOT (the pre-W4 bug that made
    // the /data/* fabric allow-list a root-access hole).
    if (header(req, 'x-relay-source') === 'peer' && isLoopbackAddress(req.clientIp)) {
      const node = header(req, 'x-lm-peer-node');
      if (node) return { type: 'peer', node };
      return { type: 'cloud' }; // malformed peer header → untrusted, never local
    }
    // Not relayed: only a genuinely loopback caller (holding the local api-token) is trusted as
    // local root. Any other origin is treated as cloud (no userId) — never local root — which
    // defends the 0.0.0.0 bind if api-token auth is ever disabled.
    if (isLoopbackAddress(req.clientIp)) return { type: 'local' };
    return { type: 'cloud' };
  }

  evaluateGrants(p: Principal, d: DatasetDescriptor, requested: DataAction[]): DataAction[] {
    let allowed = new Set<DataAction>(requested);
    if (p.type === 'cloud') {
      // ACL intersection
      const aclActions = new Set<DataAction>();
      for (const rule of d.acl) {
        if (principalMatches(rule.principal, p)) rule.actions.forEach((a) => aclActions.add(a));
      }
      allowed = new Set([...allowed].filter((a) => aclActions.has(a)));
      // visibility
      if (d.visibility !== 'synced' && d.visibility !== 'cross-node-readable') return [];
      // sensitivity
      if (d.sensitive) return [];
    }
    if (p.type === 'peer') {
      // A fabric peer (trusted-by-construction gatewayId) may ONLY read a shareable, non-sensitive
      // dataset for sync — no ACL key, never write/delete/manage. This is what makes /data/sync/manifest
      // advertise exactly the shareable set to a peer (syncManifest calls evaluateGrants(peer, d, ['read'])).
      if (d.sensitive) return [];
      if (d.visibility !== 'synced' && d.visibility !== 'cross-node-readable') return [];
      allowed = new Set([...allowed].filter((a) => READ_ONLY_ACTIONS.includes(a)));
    }
    // readOnly is a HARD cap for everyone, incl. local root
    if (d.readOnly) allowed = new Set([...allowed].filter((a) => READ_ONLY_ACTIONS.includes(a)));
    return [...allowed];
  }

  async requestAccess(p: Principal, req: AccessRequest): Promise<IssueResult> {
    const grants: Grant[] = [];
    for (const g of req.grants) {
      const d = this.deps.datasets.get(g.dataset);
      if (!d) continue;
      const actions = this.evaluateGrants(p, d, g.actions);
      if (actions.length) grants.push({ dataset: g.dataset, actions });
    }
    if (!grants.length) {
      await this.deps.keys.appendAudit({ at: new Date().toISOString(), event: 'deny',
        principalType: p.type, principalId: p.userId, detail: 'no grantable scope' });
      return { ok: false, reason: 'no grantable scope for the requested datasets/actions' };
    }
    const ttl = Math.min(TTL_MAX, Math.max(TTL_MIN, req.ttlSeconds ?? TTL_DEFAULT));
    const keyId = crypto.randomUUID();
    const secret = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const key: AccessKey = {
      keyId,
      secretHash: crypto.createHash('sha256').update(secret).digest('hex'),
      principalType: p.type,
      principalId: p.userId,
      node: this.deps.nodeId,
      grants,
      label: req.intent,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttl * 1000).toISOString(),
    };
    await this.deps.keys.put(key);
    await this.deps.keys.appendAudit({ at: key.issuedAt, event: 'issue', keyId,
      principalType: p.type, principalId: p.userId, detail: req.intent });
    return { ok: true, key: `${keyId}.${secret}`, keyId, grants, expiresAt: key.expiresAt };
  }

  async enforce(p: Principal, keyHeader: string | undefined, d: DatasetDescriptor, action: DataAction): Promise<EnforceResult> {
    const deny = async (code: string, status: number, reason: string, keyId?: string): Promise<EnforceResult> => {
      await this.deps.keys.appendAudit({
        at: new Date().toISOString(), event: 'deny',
        keyId, principalType: p.type, principalId: p.userId,
        dataset: d.id, action, detail: code,
      });
      return { ok: false, code, status, reason };
    };

    // Hard caps first (apply to everyone, incl. local root).
    if (d.readOnly && !READ_ONLY_ACTIONS.includes(action)) {
      return await deny('READ_ONLY', 403, `dataset "${d.id}" is read-only`);
    }
    if (d.sensitive && p.type === 'cloud') {
      return await deny('SENSITIVE', 403, `dataset "${d.id}" is not available to cloud callers`);
    }

    // Peer principal (fabric sync RPC): authoritative + read-only, evaluated BEFORE the key branch
    // so a peer can never widen its scope by presenting a key. No key is required or consulted.
    if (p.type === 'peer') {
      if (d.sensitive) return await deny('SENSITIVE', 403, `dataset "${d.id}" is not shareable`);
      if (!READ_ONLY_ACTIONS.includes(action)) {
        return await deny('PEER_READ_ONLY', 403, `peers may only read via sync; "${action}" is denied`);
      }
      if (d.visibility !== 'synced' && d.visibility !== 'cross-node-readable') {
        return await deny('PEER_NOT_SHAREABLE', 403, `dataset "${d.id}" is not shareable cross-node`);
      }
      await this.deps.keys.appendAudit({ at: new Date().toISOString(), event: 'use',
        principalType: p.type, principalId: p.node, dataset: d.id, action });
      return { ok: true, principal: p };
    }

    if (keyHeader) {
      const dot = keyHeader.indexOf('.');
      const keyId = dot >= 0 ? keyHeader.slice(0, dot) : keyHeader;
      const secret = dot >= 0 ? keyHeader.slice(dot + 1) : '';
      const key = this.deps.keys.get(keyId);
      if (!key) return await deny('KEY_INVALID', 403, 'unknown access key', keyId);
      if (key.revoked) return await deny('KEY_REVOKED', 403, 'access key revoked', keyId);
      if (Date.parse(key.expiresAt) <= Date.now()) return await deny('KEY_EXPIRED', 403, 'access key expired', keyId);
      if (key.node !== this.deps.nodeId) return await deny('KEY_WRONG_NODE', 403, 'access key not valid on this node', keyId);
      const expected = Buffer.from(key.secretHash, 'hex');
      const got = crypto.createHash('sha256').update(secret).digest();
      if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) {
        return await deny('KEY_INVALID', 403, 'bad access key secret', keyId);
      }
      const grant = key.grants.find((g) => g.dataset === d.id);
      if (!grant || !grant.actions.includes(action)) {
        return await deny('NOT_GRANTED', 403, `key does not grant "${action}" on "${d.id}"`, keyId);
      }
      await this.deps.keys.appendAudit({ at: new Date().toISOString(), event: 'use', keyId,
        principalType: p.type, principalId: p.userId, dataset: d.id, action });
      return { ok: true, principal: p };
    }

    // No key: local fast-path (root on local data). Cloud must present a key.
    if (p.type === 'local') return { ok: true, principal: p };
    return await deny('KEY_REQUIRED', 403, 'cloud callers must present an access key');
  }
}
