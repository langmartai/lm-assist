/**
 * Local-tier grant primitives — the declared allow-list a pane's data-plane calls
 * are checked against. Grants are DECLARED by the app in <appDir>/lmui.config.json
 * ({ grant: [{ service, pathPrefix, verbs }] }); this module reads that file and
 * answers "is (service, path, method) allowed?".
 *
 * A malformed/absent config yields no grant (deny-all), never an error — a broken
 * config must not open the data plane, and must not crash the server either.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface GrantRule { service: string; pathPrefix: string; verbs: string[] }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function readDeclaredGrant(appDir: string): GrantRule[] {
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(path.join(appDir, 'lmui.config.json'), 'utf8')); }
  catch { return []; }
  const grant = isRecord(parsed) ? parsed.grant : undefined;
  if (!Array.isArray(grant)) return [];
  const out: GrantRule[] = [];
  for (const g of grant) {
    if (!isRecord(g)) continue;
    const { service, pathPrefix, verbs } = g;
    // A rule missing either identifier is meaningless — drop it rather than guess.
    if (typeof service !== 'string' || !service) continue;
    if (typeof pathPrefix !== 'string' || !pathPrefix) continue;
    out.push({
      service,
      pathPrefix,
      verbs: Array.isArray(verbs)
        ? verbs.filter((v): v is string => typeof v === 'string').map((v) => v.toUpperCase())
        : [],
    });
  }
  return out;
}

/** Prefix match that ends at a segment boundary: '/backlog' allows '/backlog' and
 *  '/backlog/x' but NOT '/backlogx'. A prefix already ending in '/' is its own
 *  boundary, so any deeper path under it matches. */
function pathUnderPrefix(pathName: string, prefix: string): boolean {
  if (!pathName.startsWith(prefix)) return false;
  if (pathName.length === prefix.length) return true;
  return prefix.endsWith('/') || pathName[prefix.length] === '/';
}

export function grantAllows(grant: GrantRule[], service: string, pathName: string, method: string): boolean {
  const verb = method.toUpperCase();
  return grant.some((r) => r.service === service && r.verbs.includes(verb) && pathUnderPrefix(pathName, r.pathPrefix));
}
