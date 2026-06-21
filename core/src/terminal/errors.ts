/**
 * Typed error taxonomy for terminal operations.
 *
 * Replaces the previous "everything throws as TmuxError(string)" pattern.
 * Callers can branch on .code without parsing message strings.
 */

export type TerminalErrorCode =
  | 'TMUX_NOT_INSTALLED'
  | 'PLATFORM_UNSUPPORTED'
  | 'INVALID_INPUT'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_DIED'
  | 'PRECONDITION_FAILED'
  | 'POSTCONDITION_FAILED'
  | 'TIMEOUT'
  | 'TMUX_ERROR'
  | 'SPAWN_FAILED'
  | 'REGISTRY_ERROR'
  | 'CONFLICT'
  | 'UPSTREAM_ERROR';

export class TerminalError extends Error {
  readonly code: TerminalErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: TerminalErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'TerminalError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

/** Map a TerminalError to an HTTP-friendly status code. */
export function httpStatusFor(code: TerminalErrorCode): number {
  switch (code) {
    case 'INVALID_INPUT': return 400;
    case 'PRECONDITION_FAILED': return 409;
    case 'CONFLICT': return 409;
    case 'SESSION_NOT_FOUND': return 404;
    case 'PLATFORM_UNSUPPORTED': return 501;
    case 'TMUX_NOT_INSTALLED': return 503;
    case 'TIMEOUT': return 504;
    case 'UPSTREAM_ERROR': return 502;
    case 'POSTCONDITION_FAILED':
    case 'SESSION_DIED':
    case 'TMUX_ERROR':
    case 'SPAWN_FAILED':
    case 'REGISTRY_ERROR':
      return 500;
  }
}
