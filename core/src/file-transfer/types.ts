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

export type FtControl =
  | FtMeta
  | FtData
  | FtEnd
  | FtOk
  | FtErr
  | FtList
  | FtListResult
  | FtListErr;

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
}
