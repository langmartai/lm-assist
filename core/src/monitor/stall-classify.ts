/**
 * Server-vs-user stall classification — the SAFETY boundary for auto-resume.
 * Wraps the existing ordered classifier so the regexes live in exactly one place.
 */
import { classifyScreen, ScreenState } from '../terminal/cc-classify';

/** States that mean "the server/network hiccuped, not the user" — safe to auto-`continue`.
 *  Includes transient connectivity loss (internet dropped): the request never landed,
 *  so retrying once it's back is always safe. */
export const SERVER_STALL_STATES: ScreenState[] = ['overloaded', 'server_error', 'rate_limit_server', 'connection_error'];

/** Classify a screen/error text. `retryable` is true ONLY for server-side / transport
 *  stalls (529 / 5xx / server throttle / connection failure) — NEVER for the user's own
 *  usage limit or auth errors. */
export function isServerStall(text: string): { retryable: boolean; category: ScreenState } {
  const { state } = classifyScreen(text || '');
  return { retryable: SERVER_STALL_STATES.includes(state), category: state };
}
