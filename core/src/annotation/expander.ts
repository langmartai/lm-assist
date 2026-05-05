/**
 * Convert compact annotations (what the LLM emits) to the full form
 * downstream stages read.
 */
import type { Annotation, CompactAnnotation, Role, Stickyness } from './types';

const ROLE_EXPAND: Record<string, Role> = {
  use: 'user-brief',
  dec: 'decision',
  sta: 'state-change',
  ref: 'reference',
  rea: 'reasoning',
  tol: 'tool-output',
  imp: 'imperative',
};

const STICKY_EXPAND: Record<string, Stickyness> = {
  h: 'high',
  m: 'medium',
  l: 'low',
};

export function expand(c: CompactAnnotation): Annotation {
  return {
    uuid: c.u,
    topics: c.t || [],
    entities: c.e || [],
    role: (c.r && ROLE_EXPAND[c.r]) || 'reference',
    summary: c.s || '',
    referenced_uuids: c.ref || [],
    state_impact: c.i || 'none',
    stickyness: (c.k && STICKY_EXPAND[c.k]) || 'low',
    keep_raw: c.kr === '1',
  };
}

export function compact(a: Annotation): CompactAnnotation {
  const out: CompactAnnotation = { u: a.uuid, t: a.topics };
  const roleCode = (Object.entries(ROLE_EXPAND).find(([, v]) => v === a.role) || [null])[0];
  if (roleCode && roleCode !== 'ref') out.r = roleCode;  // 'ref' is the default we skip
  if (a.summary) out.s = a.summary;
  if (a.entities && a.entities.length) out.e = a.entities;
  if (a.stickyness && a.stickyness !== 'low') out.k = a.stickyness[0];
  if (a.state_impact && a.state_impact !== 'none') out.i = a.state_impact;
  if (a.referenced_uuids && a.referenced_uuids.length) out.ref = a.referenced_uuids;
  if (a.keep_raw) out.kr = '1';
  return out;
}
