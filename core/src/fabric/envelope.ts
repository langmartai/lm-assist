/**
 * W2 fabric wire: an Envelope is msgpack, framed `[4B len][0x02][msgpack]`.
 * It shares the length-prefix convention with file-transfer/frame.ts and the
 * W1 hello control frame (`[4B len][0x00][utf8 json]`), so ONE reader
 * (FabricFrameReader) decodes a connected link that carries both re-advertised
 * W1 hellos (0x00) and W2 envelopes (0x02). msgpack carries `payload` as a
 * native binary blob (no base64 bloat) — the reason W2 adds the dep instead of
 * JSON+gzip.
 *
 * msgpack is ESM-only: it is loaded ONLY via the Function-import trap so tsc's
 * CJS downlevel cannot turn it into a require() (ERR_REQUIRE_ESM).
 */
import { KIND_CONTROL } from '../file-transfer/frame';
import { parseFabricControl, FABRIC_TAG, type FabricHello } from './protocol';

export type FrameKind = 'hello' | 'ping' | 'pong' | 'req' | 'res' | 'pub' | 'chunk' | 'xfer';
export type TrafficClass = 'control' | 'rpc' | 'bus' | 'bulk';

export interface EnvelopeHeaders {
  comp?: 'none' | 'gzip';
  rawLen?: number;
  method?: string;
  path?: string;
  status?: number;
  code?: string;
  message?: string;
  cls?: TrafficClass;
  seq?: number;
  fin?: boolean;
  bulk?: boolean;
  reqId?: string;
  [k: string]: unknown;
}

export interface Envelope {
  kind: FrameKind;
  id: string;
  headers: EnvelopeHeaders;
  payload: Uint8Array;
}

export const KIND_ENVELOPE = 0x02;
const LEN_PREFIX = 4;
/** Guard against a corrupt/desynced length prefix (readUInt32BE can claim up
 *  to ~4GB): 64MB is comfortably above the real CHUNK_THRESHOLD (64KB, see
 *  chunking.ts) plus envelope/msgpack overhead, so any legitimate frame stays
 *  well under it. */
const MAX_FRAME = 64 * 1024 * 1024;

interface MsgpackCodec {
  encode(value: unknown): Uint8Array;
  decode(buffer: ArrayLike<number> | ArrayBufferView | ArrayBuffer): unknown;
}

const esmImport: (m: string) => Promise<Record<string, unknown>> =
  new Function('m', 'return import(m)') as (m: string) => Promise<Record<string, unknown>>;

let codec: MsgpackCodec | null = null;

/** Load the ESM-only msgpack codec once (idempotent). Call at fabric boot + in tests. */
export async function initEnvelopeCodec(): Promise<void> {
  if (codec) return;
  const mod = await esmImport('@msgpack/msgpack');
  codec = { encode: mod.encode as MsgpackCodec['encode'], decode: mod.decode as MsgpackCodec['decode'] };
}

function requireCodec(): MsgpackCodec {
  if (!codec) throw new Error('envelope codec not loaded — call await initEnvelopeCodec() first');
  return codec;
}

/** `[4B len][0x02][msgpack(env)]`. */
export function encodeEnvelope(env: Envelope): Buffer {
  const mp = requireCodec().encode(env);
  const body = Buffer.allocUnsafe(1 + mp.length);
  body[0] = KIND_ENVELOPE;
  Buffer.from(mp.buffer, mp.byteOffset, mp.byteLength).copy(body, 1);
  const out = Buffer.allocUnsafe(LEN_PREFIX + body.length);
  out.writeUInt32BE(body.length >>> 0, 0);
  body.copy(out, LEN_PREFIX);
  return out;
}

/** Decode a frame body AFTER the 0x02 kind byte. */
export function decodeEnvelope(payloadBody: Buffer): Envelope {
  const raw = requireCodec().decode(payloadBody) as Record<string, unknown>;
  const payload = raw.payload;
  return {
    kind: raw.kind as FrameKind,
    id: typeof raw.id === 'string' ? raw.id : '',
    headers: (raw.headers && typeof raw.headers === 'object' ? raw.headers : {}) as EnvelopeHeaders,
    payload: payload instanceof Uint8Array ? payload
      : ArrayBuffer.isView(payload) ? new Uint8Array((payload as ArrayBufferView).buffer as ArrayBuffer)
      : new Uint8Array(0),
  };
}

/** msgpack a request/response BODY (application data), not a whole envelope. */
export function encodeBody(v: unknown): Uint8Array { return requireCodec().encode(v); }
export function decodeBody(u: Uint8Array): unknown { return requireCodec().decode(u); }

export type FabricInbound =
  | { kind: 'hello'; hello: FabricHello }
  | { kind: 'envelope'; env: Envelope };

/** Reads a mixed stream of W1 hello control frames (0x00) and W2 envelopes (0x02). */
export class FabricFrameReader {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): FabricInbound[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: FabricInbound[] = [];
    for (;;) {
      if (this.buf.length < LEN_PREFIX) break;
      const len = this.buf.readUInt32BE(0);
      if (len > MAX_FRAME) {
        // A malformed/corrupt length prefix desyncs the framing — we cannot
        // trust where the next real frame boundary is. Drop everything
        // buffered so far rather than waiting (unboundedly) for `len` bytes
        // that will likely never arrive; return whatever was already parsed
        // earlier in this same push() call.
        this.buf = Buffer.alloc(0);
        break;
      }
      const total = LEN_PREFIX + len;
      if (this.buf.length < total) break;
      const body = this.buf.subarray(LEN_PREFIX, total);
      this.buf = this.buf.subarray(total);
      if (body.length < 1) continue;
      const kind = body[0];
      if (kind === KIND_ENVELOPE) {
        try { out.push({ kind: 'envelope', env: decodeEnvelope(body.subarray(1)) }); } catch { /* skip malformed */ }
      } else if (kind === KIND_CONTROL) {
        try {
          const msg = JSON.parse(body.subarray(1).toString('utf8')) as unknown;
          const hello = (msg as { type?: string })?.type === FABRIC_TAG ? parseFabricControl(msg) : null;
          if (hello) out.push({ kind: 'hello', hello });
        } catch { /* skip */ }
      }
      // other kinds (e.g. 0x01 file-transfer data) never appear on a fabric link → skip
    }
    return out;
  }

  pending(): number { return this.buf.length; }
}
