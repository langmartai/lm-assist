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

function principalMatches(rule: AclRule['principal'], p: Principal): boolean {
  if (rule === '*') return true;
  if (typeof rule === 'string') return rule === p.type;
  return p.type === 'cloud' && p.userId === rule.userId;
}

export class AccessManager {
  constructor(private deps: { datasets: DatasetRegistry; keys: KeyStore; nodeId: string }) {}

  resolvePrincipal(req: ParsedRequest): Principal {
    // The hub relay marks every relayed call with `x-relay-source: hub` (see api-relay-handler).
    if (header(req, 'x-relay-source') === 'hub') {
      return { type: 'cloud', userId: header(req, 'x-lm-user-id') };
    }
    return { type: 'local' };
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
    // Hard caps first (apply to everyone, incl. local root).
    if (d.readOnly && !READ_ONLY_ACTIONS.includes(action)) {
      return { ok: false, code: 'READ_ONLY', status: 403, reason: `dataset "${d.id}" is read-only` };
    }
    if (d.sensitive && p.type === 'cloud') {
      return { ok: false, code: 'SENSITIVE', status: 403, reason: `dataset "${d.id}" is not available to cloud callers` };
    }

    if (keyHeader) {
      const dot = keyHeader.indexOf('.');
      const keyId = dot >= 0 ? keyHeader.slice(0, dot) : keyHeader;
      const secret = dot >= 0 ? keyHeader.slice(dot + 1) : '';
      const key = this.deps.keys.get(keyId);
      if (!key) return { ok: false, code: 'KEY_INVALID', status: 403, reason: 'unknown access key' };
      if (key.revoked) return { ok: false, code: 'KEY_REVOKED', status: 403, reason: 'access key revoked' };
      if (Date.parse(key.expiresAt) <= Date.now()) return { ok: false, code: 'KEY_EXPIRED', status: 403, reason: 'access key expired' };
      if (key.node !== this.deps.nodeId) return { ok: false, code: 'KEY_WRONG_NODE', status: 403, reason: 'access key not valid on this node' };
      const expected = Buffer.from(key.secretHash, 'hex');
      const got = crypto.createHash('sha256').update(secret).digest();
      if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) {
        return { ok: false, code: 'KEY_INVALID', status: 403, reason: 'bad access key secret' };
      }
      const grant = key.grants.find((g) => g.dataset === d.id);
      if (!grant || !grant.actions.includes(action)) {
        return { ok: false, code: 'NOT_GRANTED', status: 403, reason: `key does not grant "${action}" on "${d.id}"` };
      }
      await this.deps.keys.appendAudit({ at: new Date().toISOString(), event: 'use', keyId,
        principalType: p.type, principalId: p.userId, dataset: d.id, action });
      return { ok: true, principal: p };
    }

    // No key: local fast-path (root on local data). Cloud must present a key.
    if (p.type === 'local') return { ok: true, principal: p };
    return { ok: false, code: 'KEY_REQUIRED', status: 403, reason: 'cloud callers must present an access key' };
  }
}
