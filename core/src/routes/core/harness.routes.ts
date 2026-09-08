/** /harness — what non-Claude agent harnesses this node can actually run, and
 *  where they get their credentials.
 *
 *  `GET /harness/status` is open, like every other status view, because it
 *  carries no secret: the provider config is rendered through
 *  describeProviderConfig(), which reports `hasKey: true|false` and never the
 *  key itself. Nothing here ever logs, echoes or returns an apiKey. */
import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import { describeHarnesses, getHarness } from '../../harness/registry';
import { describeProviderConfig, HARNESS_ENV_PREFIX } from '../../harness/provider-config';
import type { HarnessProbe } from '../../harness/types';

interface Envelope { success: boolean; data?: unknown; error?: { code: string; message: string } }
const ok = <T>(data: T): Envelope => ({ success: true, data });
const fail = (code: string, message: string): Envelope => ({ success: false, error: { code, message } });

/**
 * A probe shells out to a third-party binary, so it is bounded here rather than
 * trusted to return. One wedged CLI must not wedge the status endpoint that
 * exists to tell you the CLI is wedged.
 */
const PROBE_TIMEOUT_MS = 8000;

async function probeWithDeadline(id: string): Promise<HarnessProbe | null> {
  const harness = getHarness(id);
  // Builtins ('sdk', 'tmux') are served inside agent-api and expose no probe.
  // null means "not probeable" — deliberately not `available: true`, which would
  // assert something about the `claude` CLI and tmux that nothing here measured.
  if (!harness?.probe) return null;

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      harness.probe(),
      new Promise<HarnessProbe>((resolve) => {
        timer = setTimeout(
          () => resolve({ available: false, reason: `probe did not answer within ${PROBE_TIMEOUT_MS}ms` }),
          PROBE_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    return { available: false, reason: `probe threw: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function handleHarnessStatus(): Promise<Envelope> {
  const harnesses = await Promise.all(
    describeHarnesses().map(async (h) => ({
      ...h,
      displayName: getHarness(h.id)?.displayName,
      probe: await probeWithDeadline(h.id),
    })),
  );

  const providers = describeProviderConfig();
  return ok({
    harnesses,
    providers,
    // Say why a harness that needs a profile cannot run, instead of leaving the
    // reader to work it out from an empty list.
    ready: harnesses.every((h) => !h.capabilities.usesProviderProfile || providers.profiles.length > 0),
    envFallback: `${HARNESS_ENV_PREFIX}BASE_URL + ${HARNESS_ENV_PREFIX}API_KEY (+ ${HARNESS_ENV_PREFIX}MODEL)`,
  });
}

export function createHarnessRoutes(_ctx: RouteContext): RouteHandler[] {
  const wrap = (run: (req: ParsedRequest) => Promise<Envelope>): RouteHandler['handler'] =>
    async (req) => {
      const start = Date.now();
      const e = await run(req);
      return e.success
        ? wrapResponse(e.data, start)
        : wrapError(e.error?.code ?? 'ERROR', e.error?.message ?? 'error', start);
    };

  return [
    { method: 'GET', pattern: /^\/harness\/status$/, handler: wrap(() => handleHarnessStatus()) },
  ];
}
