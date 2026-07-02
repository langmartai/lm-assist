/**
 * File-transfer wire types — control messages and shared shapes.
 *
 * All control messages are JSON, framed by frame.ts as a length-prefixed
 * payload whose first byte is 0 (control). File bytes travel as type-1
 * (binary data) frames. See frame.ts for the on-wire layout.
 */

/** One filesystem entry inside a transfer (file or directory). */
export interface FileEntry {
  /** Path relative to the transfer root. Always forward-slash separated. */
  relPath: string;
  /** Size in bytes (0 for directories). */
  size: number;
  /** POSIX mode bits (e.g. 0o644). */
  mode: number;
  isDir: boolean;
}

/** A directory listing entry returned by listRemote. */
export interface DirEntry {
  name: string;
  /** Path relative to the listed directory. */
  relPath: string;
  size: number;
  mode: number;
  isDir: boolean;
  /** Modification time, epoch milliseconds. */
  mtimeMs: number;
}

/** Sent first by the sender to announce what is about to be transferred. */
export interface FtMeta {
  type: 'FT_META';
  transferId: string;
  /** Final destination path on the receiver (relative to its safe root). */
  root: string;
  entries: FileEntry[];
  totalBytes: number;
  /** Whether this transfer supports resumption. */
  resumable?: boolean;
  /** Hex sha256 hash of the transfer for integrity checking. */
  sha256?: string;
}

/**
 * Control header that precedes a run of raw bytes. The raw bytes do NOT live
 * in this JSON object — they are carried by a separate type-1 binary frame.
 * This message is informational/legacy; the binary frame is self-describing.
 */
export interface FtData {
  type: 'FT_DATA';
  transferId: string;
  entryIndex: number;
  offset: number;
  len: number;
}

/** Sent last by the sender; carries per-entry sha256 for verification. */
export interface FtEnd {
  type: 'FT_END';
  transferId: string;
  /** Hex sha256 per entry, indexed parallel to FtMeta.entries (dirs: ''). */
  sha256PerEntry?: string[];
}

/** Receiver acknowledges a completed, verified transfer. */
export interface FtOk {
  type: 'FT_OK';
  transferId: string;
}

/** Receiver reports failure (verification, write error, traversal reject). */
export interface FtErr {
  type: 'FT_ERR';
  transferId: string;
  error: string;
}

/** Sender requests the receiver's resume state (bytes already written). */
export interface FtResumeState {
  type: 'FT_RESUME_STATE';
  transferId: string;
  bytesDone: number;
}

/** Sender requests the transfer to be cancelled. */
export interface FtCancel {
  type: 'FT_CANCEL';
  transferId: string;
  reason?: string;
}

/** Request a directory listing on the peer. */
export interface FtList {
  type: 'FT_LIST';
  path: string;
}

/** Reply to FtList. */
export interface FtListResult {
  type: 'FT_LIST_RESULT';
  entries: DirEntry[];
}

/** Reply to FtList on error. */
export interface FtListErr {
  type: 'FT_LIST_ERR';
  error: string;
}

/** Filesystem inspect request over the transport (whole-fs; no receive-root). */
export interface FtFs {
  type: 'FT_FS';
  op: 'drives' | 'list' | 'stat' | 'read';
  path?: string;
  refresh?: boolean;
  pattern?: string;
  regex?: boolean;
  /** read: byte offset to start at (default 0). */
  offset?: number;
  /** read: max bytes to return (backend-capped). */
  maxBytes?: number;
}
/** Reply to FtFs. data shape depends on op: DriveInfo[] | FsListResult | StatInfo | ReadResult. */
export interface FtFsResult {
  type: 'FT_FS_RESULT';
  op: 'drives' | 'list' | 'stat' | 'read';
  data: unknown;
}
export interface FtFsErr {
  type: 'FT_FS_ERR';
  op: 'drives' | 'list' | 'stat' | 'read';
  error: string;
}

// ===========================================================================
// FIREHOSE control messages (single large-file fast path).
//
// The firehose data plane is the DIRECT UDP socket (unreliable, rate-paced,
// fire-once); ALL coordination — meta, NACK, end, escalated repair, completion —
// rides the EXISTING reliable relay control plane (channel.sendControl). File
// offset for a firehose data datagram = seq * chunk; totalChunks = ceil(size/chunk).
// ===========================================================================

/**
 * Sender → receiver: switch this transfer into firehose mode + sizing. Sent on
 * the reliable control plane BEFORE any firehose datagram. `chunk` is the
 * firehose payload size (bytes/chunk); file offset of seq = seq * chunk.
 */
export interface FtFhMeta {
  type: 'FT_FH_META';
  transferId: string;
  /** Final destination path on the receiver (relative to its safe root). */
  root: string;
  /** Single-file base name (relative path written under root). */
  name: string;
  /** Total file size in bytes. */
  size: number;
  /** Firehose payload size per chunk (bytes). */
  chunk: number;
  /** ceil(size / chunk). */
  totalChunks: number;
  mode: 'firehose';
  /** POSIX mode bits for the written file. */
  fileMode: number;
}

/**
 * Receiver → sender: chunks still missing. `missing` is a COMPACT run-length
 * encoding: a flat array of [start, len] pairs (each run = seqs start..start+len-1).
 * Bounded — if too many runs, the receiver sends the first/worst N and relies on
 * the next interval to report the rest.
 */
export interface FtNack {
  type: 'FT_NACK';
  transferId: string;
  /** Run-length encoded missing seqs: [[start,len],...]. */
  missing: Array<[number, number]>;
}

export interface FtDelay {
  type: 'FT_DELAY';
  transferId: string;
  /** Receiver-measured queuing delay in ms (current one-way delay minus its running min). */
  qd: number;
}

/** Sender → receiver: all chunks fired once. Carries whole-file sha256. */
export interface FtFhEnd {
  type: 'FT_FH_END';
  transferId: string;
  totalChunks: number;
  /** Hex sha256 of the whole file. */
  sha256: string;
}

/**
 * Sender → receiver: an ESCALATED repair of one chunk over the reliable relay
 * (sent only after a seq survives K direct re-fire rounds, or on direct death).
 * `data` is base64 of the chunk's raw bytes.
 */
export interface FtFhRepair {
  type: 'FT_FH_REPAIR';
  transferId: string;
  seq: number;
  /** base64 of the chunk bytes at offset seq*chunk. */
  data: string;
}

export type FtControl =
  | FtMeta
  | FtData
  | FtEnd
  | FtOk
  | FtErr
  | FtResumeState
  | FtCancel
  | FtList
  | FtListResult
  | FtListErr
  | FtFhMeta
  | FtNack
  | FtDelay
  | FtFhEnd
  | FtFhRepair
  | FtFs
  | FtFsResult
  | FtFsErr;

export interface SendResult {
  bytes: number;
  entries: number;
  /** Final channel mode at end of transfer: 'bidi' | 'oneway' | 'relay'. */
  mode?: string;
  /** Winning outbound candidate kind: 'host' | 'static' | 'srflx' | null. */
  via?: string | null;
}

export interface SendOpts {
  onProgress?: (sent: number, total: number) => void;
  /** Force the channel transport: 'relay' (hub only) or 'direct' (best-effort). */
  forceMode?: 'direct' | 'relay';
  /** Bytes per data chunk on the wire. Default 32 KiB (256 KiB for large files). */
  chunkSize?: number;
  /** Hard ceiling for the whole transfer in ms. Default scales with file size. */
  timeoutMs?: number;
  /** Retry attempts after the first (default 2). Backoff also covers WS reconnect. */
  maxRetries?: number;
  /** Override the transfer id (the send queue sets it to the jobId for stats linkage). */
  transferId?: string;
  /** Abort the transfer mid-flight (job cancel). */
  signal?: AbortSignal;
  /** Resume: begin streaming the single entry at this byte offset. */
  resumeFrom?: number;
  /** Ask the receiver for its resume state before streaming (large files). */
  resumable?: boolean;
}
