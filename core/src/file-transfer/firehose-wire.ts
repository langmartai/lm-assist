/**
 * Firehose wire helpers — shared by the firehose sender and receiver.
 *
 * Firehose DATA datagram (carried inside channel.sendUnreliable, i.e. AFTER the
 * transport's 0xF1 marker):
 *
 *     [4B seq BE][payload...]
 *
 * `seq` is the chunk index; the file offset of a chunk = seq * FIREHOSE_CHUNK.
 * The payload length is FIREHOSE_CHUNK for every chunk except the last (which is
 * size - (totalChunks-1)*FIREHOSE_CHUNK). The whole UDP datagram on the wire is
 * 1 (0xF1 marker) + 4 (seq) + payload; with FIREHOSE_CHUNK = 1100 that is at
 * most 1105 bytes — MTU-safe (< 1200).
 *
 * NACK compact encoding: a missing-seq set is run-length encoded as a flat array
 * of [start, len] pairs. A handful of [start,len] runs covers the typical loss
 * pattern (scattered drops + occasional bursts) of even a 64K-chunk file in a
 * few hundred bytes of JSON.
 */

/** Firehose payload bytes per chunk (keeps the whole UDP datagram < 1200). */
export const FIREHOSE_CHUNK = 1100;

/** Bytes of the firehose data-datagram header (the 4-byte seq). */
export const FH_DATA_HEADER = 4;

/** Pack a firehose data datagram payload: [4B seq][bytes]. */
export function packFirehoseDatagram(seq: number, bytes: Buffer): Buffer {
  const out = Buffer.allocUnsafe(FH_DATA_HEADER + bytes.length);
  out.writeUInt32BE(seq >>> 0, 0);
  bytes.copy(out, FH_DATA_HEADER);
  return out;
}

/** Unpack a firehose data datagram payload → { seq, bytes }, or null if short. */
export function unpackFirehoseDatagram(buf: Buffer): { seq: number; bytes: Buffer } | null {
  if (buf.length < FH_DATA_HEADER) return null;
  const seq = buf.readUInt32BE(0);
  return { seq, bytes: buf.subarray(FH_DATA_HEADER) };
}

/**
 * Run-length encode a SORTED-ASCENDING list of missing seqs into [start,len]
 * runs. `maxRuns` bounds the result (worst/first N runs); the caller relies on
 * the next NACK interval to report any overflow.
 */
export function encodeMissingRuns(sortedMissing: number[], maxRuns = 256): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let i = 0;
  while (i < sortedMissing.length && runs.length < maxRuns) {
    const start = sortedMissing[i];
    let len = 1;
    while (i + len < sortedMissing.length && sortedMissing[i + len] === start + len) len++;
    runs.push([start, len]);
    i += len;
  }
  return runs;
}

/** Expand [start,len] runs back into a flat list of seqs. */
export function decodeMissingRuns(runs: Array<[number, number]>): number[] {
  const out: number[] = [];
  for (const [start, len] of runs) {
    for (let k = 0; k < len; k++) out.push(start + k);
  }
  return out;
}
