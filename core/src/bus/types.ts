/**
 * Bus value types + pure helpers (spec §5 S1). A BusEvent is the unit of the
 * append-only log: per-origin monotonic `seq`, global id `origin:seq`, ordering
 * guaranteed per origin. A cursor is a per-origin high-water map; it is encoded
 * to an opaque base64url string so an MCP caller can hold it statelessly and
 * hand it back on the next read.
 */
export interface BusRef {
  kind: 'dataset' | 'bulk';
  id: string;
  bytes?: number;
}

export interface BusEvent {
  topic: string;
  origin: string;   // gatewayId that first appended this event
  seq: number;      // per-(topic,origin) monotonic, 1-based
  type: string;     // application event type
  at: number;       // epoch ms
  payload?: unknown; // JSON-serializable, ≤ BUS_PAYLOAD_CAP bytes
  ref?: BusRef;     // carried instead of payload when the data was offloaded
  scope?: 'cluster' | 'fleet'; // fan-out scope, recorded on the origin node
}

/** origin → last-seen seq for a topic. */
export type BusCursor = Record<string, number>;

export const BUS_PAYLOAD_CAP = 64 * 1024;

export function globalId(e: { origin: string; seq: number }): string {
  return `${e.origin}:${e.seq}`;
}

export function payloadSize(payload: unknown): number {
  if (payload === undefined || payload === null) return 4;
  try { return Buffer.byteLength(JSON.stringify(payload)); } catch { return Number.MAX_SAFE_INTEGER; }
}

export function encodeCursor(c: BusCursor): string {
  return Buffer.from(JSON.stringify(c ?? {}), 'utf8').toString('base64url');
}

export function decodeCursor(s?: string | null): BusCursor {
  if (!s) return {};
  try {
    const obj = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as unknown;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    const out: BusCursor = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function mergeCursor(a: BusCursor, b: BusCursor): BusCursor {
  const out: BusCursor = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, v);
  return out;
}
