/**
 * Path + payload-aware gzip (spec T2). LAN host-direct favors CPU (level 1);
 * the relay floor favors bytes on the scarce hub link (level 6). Small (<4KB)
 * and known-binary/pre-compressed payloads skip; unknown content is decided by
 * a 4KB entropy sample. A peer that did not advertise `comp-gzip` in its HELLO
 * always gets `none` — the mixed-version interop guarantee.
 */
import * as zlib from 'zlib';

export type CompPath = 'direct' | 'relay';
export interface CompDecision { comp: 'none' | 'gzip'; level: number; }
export interface CompressedPayload { bytes: Uint8Array; comp: 'none' | 'gzip'; rawLen: number; }

const MIN_COMPRESS = 4096;
const SAMPLE = 4096;
const MIN_GAIN = 0.99;

const TEXTLIKE = /^(application\/(json|xml|javascript|.*\+json|.*\+xml)|text\/)/i;
const BINARYLIKE = /^(image\/|audio\/|video\/|font\/|application\/(octet-stream|zip|gzip|x-gzip|wasm|pdf|x-protobuf))/i;

function levelFor(path: CompPath): number { return path === 'direct' ? 1 : 6; }

export function chooseCompression(opts: {
  len: number; path: CompPath; contentType?: string; peerHasGzip: boolean; enabled?: boolean; head?: Uint8Array;
}): CompDecision {
  const none: CompDecision = { comp: 'none', level: 0 };
  if (opts.enabled === false || !opts.peerHasGzip) return none;
  if (opts.len < MIN_COMPRESS) return none;
  const ct = opts.contentType?.toLowerCase() ?? '';
  if (ct && BINARYLIKE.test(ct)) return none;
  if (ct && TEXTLIKE.test(ct)) return { comp: 'gzip', level: levelFor(opts.path) };
  // unknown content-type → entropy sample
  if (opts.head && opts.head.length > 0) {
    const head = opts.head.subarray(0, SAMPLE);
    const gz = zlib.gzipSync(Buffer.from(head.buffer, head.byteOffset, head.byteLength), { level: levelFor(opts.path) });
    // Strict criterion: only if compressed is materially smaller
    const gain = 1 - gz.length / head.length;
    return gain >= MIN_GAIN ? { comp: 'gzip', level: levelFor(opts.path) } : none;
  }
  return none; // no sample available → skip compression (safe default)
}

export function applyCompression(payload: Uint8Array, d: CompDecision): CompressedPayload {
  if (d.comp === 'none') return { bytes: payload, comp: 'none', rawLen: payload.length };
  const gz = zlib.gzipSync(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength), { level: d.level });
  return { bytes: new Uint8Array(gz.buffer, gz.byteOffset, gz.byteLength), comp: 'gzip', rawLen: payload.length };
}

export function decompressPayload(bytes: Uint8Array, comp: 'none' | 'gzip', rawLen: number): Uint8Array {
  if (comp === 'none') return bytes;
  const out = zlib.gunzipSync(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  if (out.length !== rawLen) throw new Error(`fabric decompress: rawLen ${rawLen} != ${out.length}`);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}
