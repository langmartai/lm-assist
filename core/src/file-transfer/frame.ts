/**
 * Framing layer over a transport Channel.
 *
 * Channel.send is reliable + ordered but NOT message-preserving: a single
 * send() may be split or coalesced before it reaches onData(). So we impose
 * our own message boundaries with a 4-byte big-endian length prefix:
 *
 *   [4B payloadLen][payload...]
 *
 * The first byte of every payload is a kind tag:
 *   0x00 = JSON control message (the rest of the payload is UTF-8 JSON)
 *   0x01 = binary data frame, with a fixed header then raw file bytes:
 *
 *     control byte (0x01)        1 byte
 *     transferIdHash             4 bytes  (md5(transferId)[0:4], BE)
 *     entryIndex                 4 bytes  BE
 *     offset                     8 bytes  BE (within the entry's file)
 *     len                        4 bytes  BE (number of raw bytes that follow)
 *     raw bytes                  len bytes
 *
 * FrameReader buffers partial input and emits whole frames as they complete.
 */

import * as crypto from 'crypto';
import type { FtControl } from './types';

export const KIND_CONTROL = 0x00;
export const KIND_DATA = 0x01;

/** Bytes in the binary-data fixed header (including the kind tag). */
export const DATA_HEADER_LEN = 1 + 4 + 4 + 8 + 4;

const LEN_PREFIX = 4;

/** Stable 4-byte hash of a transferId, used to tag binary frames cheaply. */
export function transferIdHash(transferId: string): number {
  const h = crypto.createHash('md5').update(transferId).digest();
  return h.readUInt32BE(0);
}

/** Encode a JSON control message into a length-prefixed frame. */
export function encodeControl(msg: FtControl): Buffer {
  const json = Buffer.from(JSON.stringify(msg), 'utf8');
  const payload = Buffer.allocUnsafe(1 + json.length);
  payload[0] = KIND_CONTROL;
  json.copy(payload, 1);
  return withLengthPrefix(payload);
}

/** Encode a binary data frame: fixed header + raw bytes. */
export function encodeData(
  transferId: string,
  entryIndex: number,
  offset: number,
  bytes: Buffer,
): Buffer {
  const payload = Buffer.allocUnsafe(DATA_HEADER_LEN + bytes.length);
  let p = 0;
  payload[p] = KIND_DATA;
  p += 1;
  payload.writeUInt32BE(transferIdHash(transferId), p);
  p += 4;
  payload.writeUInt32BE(entryIndex >>> 0, p);
  p += 4;
  payload.writeBigUInt64BE(BigInt(offset), p);
  p += 8;
  payload.writeUInt32BE(bytes.length >>> 0, p);
  p += 4;
  bytes.copy(payload, p);
  return withLengthPrefix(payload);
}

function withLengthPrefix(payload: Buffer): Buffer {
  const out = Buffer.allocUnsafe(LEN_PREFIX + payload.length);
  out.writeUInt32BE(payload.length >>> 0, 0);
  payload.copy(out, LEN_PREFIX);
  return out;
}

export interface ControlFrame {
  kind: 'control';
  msg: FtControl;
}

export interface DataFrame {
  kind: 'data';
  transferIdHash: number;
  entryIndex: number;
  offset: number;
  bytes: Buffer;
}

export type Frame = ControlFrame | DataFrame;

/** Decode one already-deframed payload (no length prefix) into a Frame. */
export function decodePayload(payload: Buffer): Frame {
  if (payload.length < 1) {
    throw new Error('ft frame: empty payload');
  }
  const kind = payload[0];
  if (kind === KIND_CONTROL) {
    const json = payload.subarray(1).toString('utf8');
    return { kind: 'control', msg: JSON.parse(json) as FtControl };
  }
  if (kind === KIND_DATA) {
    if (payload.length < DATA_HEADER_LEN) {
      throw new Error('ft frame: truncated data header');
    }
    let p = 1;
    const tHash = payload.readUInt32BE(p);
    p += 4;
    const entryIndex = payload.readUInt32BE(p);
    p += 4;
    const offset = Number(payload.readBigUInt64BE(p));
    p += 8;
    const len = payload.readUInt32BE(p);
    p += 4;
    const bytes = payload.subarray(p, p + len);
    if (bytes.length !== len) {
      throw new Error('ft frame: truncated data body');
    }
    return { kind: 'data', transferIdHash: tHash, entryIndex, offset, bytes };
  }
  throw new Error('ft frame: unknown kind ' + kind);
}

/**
 * Accumulates bytes from Channel.onData and yields whole frames. Handles
 * partial prefixes, partial payloads, and multiple frames per chunk.
 */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);

  /** Feed a chunk; returns any frames that completed. */
  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const frames: Frame[] = [];
    for (;;) {
      if (this.buf.length < LEN_PREFIX) {
        break;
      }
      const payloadLen = this.buf.readUInt32BE(0);
      const total = LEN_PREFIX + payloadLen;
      if (this.buf.length < total) {
        break;
      }
      const payload = this.buf.subarray(LEN_PREFIX, total);
      frames.push(decodePayload(payload));
      this.buf = this.buf.subarray(total);
    }
    return frames;
  }

  /** Bytes still buffered awaiting more input (for diagnostics/tests). */
  pending(): number {
    return this.buf.length;
  }
}
