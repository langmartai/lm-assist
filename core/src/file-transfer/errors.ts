/**
 * Typed errors for the file-transfer API. sendPath classifies the raw error of
 * each attempt into one of these codes and decides whether to retry.
 */

export type TransferErrorCode =
  | 'TIMEOUT'            // idle/total timeout, or channel closed before FT_OK
  | 'PEER_UNREACHABLE'   // relay floor never came up / peer not connected
  | 'WS_DOWN'            // hub WebSocket not connected
  | 'INTEGRITY_MISMATCH' // receiver reported a sha256 mismatch
  | 'REJECTED'           // receiver refused for a protocol reason
  | 'MAX_RETRIES'        // exhausted retries
  | 'ABORTED';           // caller aborted

export class TransferError extends Error {
  readonly code: TransferErrorCode;
  readonly cause?: unknown;
  constructor(code: TransferErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'TransferError';
    this.code = code;
    this.cause = cause;
  }
}

/** Map a raw thrown error (from openChannel / waitForReply) to a code. */
export function classifyError(e: unknown): TransferErrorCode {
  const m = e instanceof Error ? e.message : String(e);
  if (/sha256 mismatch/i.test(m)) return 'INTEGRITY_MISMATCH';
  if (/receiver rejected/i.test(m)) return 'REJECTED';
  if (/relay ready timeout|peer node not connected|unreachable|same node/i.test(m)) return 'PEER_UNREACHABLE';
  if (/not connected|websocket|ws closed/i.test(m)) return 'WS_DOWN';
  if (/idle timeout|channel closed before FT_OK|exceeded \d+ms/i.test(m)) return 'TIMEOUT';
  return 'TIMEOUT';
}

/** Retriable codes — transient conditions where a backoff+retry can succeed. */
export function isRetriable(code: TransferErrorCode): boolean {
  return code === 'TIMEOUT'
    || code === 'WS_DOWN'
    || code === 'PEER_UNREACHABLE'
    || code === 'INTEGRITY_MISMATCH';
}
