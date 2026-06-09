/**
 * File/dir transfer API over the node-to-node transport Channel.
 *
 * Public surface:
 *   sendPath(peer, localPath, remotePath, opts?)  — push a file or directory.
 *   listRemote(peer, remotePath)                  — list a peer directory.
 *   handleIncomingTransfer(channel, { root })     — service an inbound channel.
 *   receiveRoot()                                 — default safe root.
 *
 * INTEGRATION CONTRACT (inbound routing):
 *   The transport driver opens channels but does not know which subsystem an
 *   incoming channel belongs to. The opener (sendPath / listRemote) sends, as
 *   its FIRST control frame, a subsystem tag: { "type": SUBSYSTEM_TAG }.
 *   The integrator that accepts new inbound transport channels must peek the
 *   first frame, and when its `type === SUBSYSTEM_TAG`, hand the channel to
 *   handleIncomingTransfer(channel, { root }). handleIncomingTransfer is
 *   tolerant of the tag frame arriving first (it ignores it), so the
 *   integrator may simply forward the channel without re-injecting the frame.
 */

export { sendPath, listRemote, requestFs } from './sender';
export { TransferError, classifyError, isRetriable } from './errors';
export { snapshotTransfers, getTransfer } from './transfer-stats';
export { enqueueSend, snapshotQueue, getSendJob } from './send-queue';
export type { SendJobView, SendJobState } from './send-queue';
export type { TransferStatView } from './transfer-stats';
export type { TransferErrorCode } from './errors';
export { handleIncomingTransfer, receiveRoot } from './receiver';
export type { ReceiveOpts } from './receiver';
export { SUBSYSTEM_TAG } from './protocol';
export { safeJoin, UnsafePathError } from './safe-path';
export { listDirAbs, statAbs, listDrives, markDirty, clearFsCache } from './fs-inspect';
export type { StatInfo, FsListResult, DriveInfo } from './fs-inspect';
export {
  FrameReader,
  encodeControl,
  encodeData,
  decodePayload,
  transferIdHash,
  KIND_CONTROL,
  KIND_DATA,
  DATA_HEADER_LEN,
} from './frame';
export type { Frame, ControlFrame, DataFrame } from './frame';
export { sendFirehose } from './firehose-sender';
export type { FirehoseSendOpts } from './firehose-sender';
export {
  FIREHOSE_CHUNK,
  packFirehoseDatagram,
  unpackFirehoseDatagram,
  encodeMissingRuns,
  decodeMissingRuns,
} from './firehose-wire';
export type {
  FileEntry,
  DirEntry,
  FtMeta,
  FtData,
  FtEnd,
  FtOk,
  FtErr,
  FtList,
  FtListResult,
  FtListErr,
  FtFhMeta,
  FtNack,
  FtFhEnd,
  FtFhRepair,
  FtControl,
  SendOpts,
  SendResult,
} from './types';
