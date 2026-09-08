/**
 * What it means to abort a harness-backed run.
 *
 * This is a separate module because the rule it encodes is a HONESTY rule, not a
 * mechanism, and it was got wrong once already: the background wrapper's abort
 * was `() => { running = false; }`, which stopped the bookkeeping and left the
 * child process running. `POST /agent/execution/:id/abort` therefore answered
 * `success: true` while a gateway agent kept working, kept editing files and
 * kept spending tokens — the worst kind of wrong answer, because the caller has
 * no reason to look again.
 *
 * The rule: only the harness can end its own run (it owns the child; the
 * background map owns a promise, and a promise has no pid), so the harness's
 * answer is the API's answer. A refusal must say WHICH of the two very different
 * situations it is — "this harness cannot abort, the run continues" or "the run
 * had already finished" — because the caller acts differently on each.
 */

import type { AgentHarness } from './types';

export type HarnessAbortOutcome =
  | { success: true }
  | { success: false; reason: string };

/**
 * Ask a harness to end one run.
 *
 * `alreadyCompleted` is what the caller's own bookkeeping believes; it is used
 * only to explain a false result, never to manufacture a true one.
 */
export async function abortHarnessRun(
  harness: AgentHarness,
  executionId: string,
  alreadyCompleted: boolean,
): Promise<HarnessAbortOutcome> {
  if (!harness.abort) {
    return {
      success: false,
      reason:
        `Harness "${harness.id}" cannot abort a run in flight ` +
        `(capabilities.abortable=${harness.capabilities.abortable}). The run is still going.`,
    };
  }

  let signalled: boolean;
  try {
    signalled = await harness.abort(executionId);
  } catch (err) {
    // A throwing abort is a failed abort. Reporting success here would be the
    // original defect wearing a different hat.
    return {
      success: false,
      reason: `Harness "${harness.id}" failed to abort ${executionId}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!signalled) {
    return {
      success: false,
      reason: alreadyCompleted
        ? `Execution ${executionId} had already finished; nothing to abort.`
        : `Harness "${harness.id}" found no live process for ${executionId}.`,
    };
  }
  return { success: true };
}
