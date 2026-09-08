/** /harness — what non-Claude agent harnesses this node can actually run, and
 *  where they get their credentials.
 *
 *  READ (`GET /harness/status`) is open, like every other status view, because it
 *  carries no secret: the provider config is rendered through
 *  describeProviderConfig(), which reports `hasKey: true|false` and never the key.
 *
 *  WRITE (`PUT /harness/provider/:name`) is LOOPBACK-ONLY, following the
 *  precedent set by the plugin enable/grant routes: it stores a real credential
 *  on this host, which is an owner action at the console — never over the LAN,
 *  never through the hub relay, never by an agent. The profile file is node-local
 *  and 0600 for the same reason; a credential is not a fleet-synced decision.
 *
 *  Nothing here ever logs, echoes or returns an apiKey. The response to a
 *  successful write is the same redacted view a read returns, so a caller can
 *  confirm what landed without the value coming back out. */
import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import { isLoopbackAddress } from '../../auth/enroll-exempt';
import { describeHarnesses, getHarness } from '../../harness/registry';
import {
  describeProviderConfig,
  loadProviderConfig,
  saveProviderConfig,
  HARNESS_ENV_PREFIX,
  type ProviderProfile,
} from '../../harness/provider-config';
import type { HarnessProbe } from '../../harness/types';

interface Envelope { success: boolean; data?: unknown; error?: { code: string; message: string } }
const ok = <T>(data: T): Envelope => ({ success: true, data });
const fail = (code: string, message: string): Envelope => ({ success: false, error: { code, message } });

/** A profile name is a single safe segment — it becomes a JSON key, never a path. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * A probe shells out to a third-party binary, so it is bounded here rather than
 * trusted to return. One wedged CLI must not wedge the status endpoint that
 * exists to tell you the CLI is wedged.
 */
const PROBE_TIMEOUT_MS = 8000;

function requireLoopback(req: ParsedRequest): Envelope | null {
  return isLoopbackAddress(req.clientIp)
    ? null
    : fail('FORBIDDEN', 'local-only endpoint: storing a harness provider credential is an owner action at the console, never over the LAN or the hub relay');
}

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

/**
 * PUT /harness/provider/:name — create or update one provider profile.
 *
 * `apiKey` may be omitted when the profile already exists: that is how you change
 * a model or a note without the credential making another trip over the wire.
 */
export async function handleProviderPut(
  name: string,
  req: ParsedRequest,
  body: Record<string, unknown>,
): Promise<Envelope> {
  const denied = requireLoopback(req);
  if (denied) return denied;

  if (!NAME_RE.test(name)) {
    return fail('INVALID_NAME', `profile name ${JSON.stringify(name)} must match ${NAME_RE.source}`);
  }
  if (name === 'env') {
    // loadProviderConfig() synthesises a profile called "env" from
    // LM_HARNESS_*. A stored profile of the same name would read as that one and
    // silently take precedence over it — two different things wearing one name.
    return fail('RESERVED_NAME', '"env" is reserved for the profile synthesised from the environment');
  }

  const existing = loadProviderConfig().profiles[name];

  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v.trim() : undefined);
  const baseUrl = str(body.baseUrl) ?? existing?.baseUrl;
  const apiKey = str(body.apiKey) ?? existing?.apiKey;

  if (!baseUrl) return fail('INVALID_INPUT', 'baseUrl is required');
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return fail('INVALID_INPUT', `baseUrl ${JSON.stringify(baseUrl)} is not an absolute URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return fail('INVALID_INPUT', `baseUrl scheme ${parsed.protocol} is not http(s)`);
  }
  if (!apiKey) {
    return fail('INVALID_INPUT', `apiKey is required (profile "${name}" does not exist yet, so there is none to keep)`);
  }
  if (body.wire !== undefined && body.wire !== 'openai-chat') {
    return fail('UNSUPPORTED_WIRE', `wire ${JSON.stringify(body.wire)} is not implemented; only "openai-chat" is`);
  }

  const profile: ProviderProfile = {
    baseUrl,
    apiKey,
    model: str(body.model) ?? existing?.model ?? '',
    wire: 'openai-chat',
    ...(str(body.note) !== undefined || existing?.note ? { note: (str(body.note) ?? existing?.note)!.slice(0, 500) } : {}),
  };

  const current = loadProviderConfig();
  // A first profile becomes the default. Without this a successful write leaves
  // resolveProfile() returning null and every run refused — a dead end that
  // looks like the write failed.
  const makeDefault = body.makeDefault === true || !current.defaultProfile;

  saveProviderConfig({
    profiles: { [name]: profile },
    ...(makeDefault ? { defaultProfile: name } : {}),
  });

  // Redacted, always: the write path must not become a way to read a key back.
  return ok({ written: name, isDefault: makeDefault, providers: describeProviderConfig() });
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
    {
      method: 'PUT',
      pattern: /^\/harness\/provider\/(?<name>[^/]+)$/,
      handler: wrap((req) => handleProviderPut(req.params.name, req, (req.body || {}) as Record<string, unknown>)),
    },
  ];
}
