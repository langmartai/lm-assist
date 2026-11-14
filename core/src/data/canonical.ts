// core/src/data/canonical.ts
/**
 * JSON with object keys sorted at every depth and undefined-valued keys dropped — so equal
 * content gives an equal string. The ONE implementation behind every "identical content"
 * compare (DataService import, the bundle config/files/datasets sections); two copies drift.
 */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export function canonicalEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
