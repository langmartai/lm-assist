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
 *  confirm what landed without the value coming back out.
 *
 *  RUN HISTORY (`GET /harness/runners`, `/harness/runs`, `/harness/runs/:id`,
 *  `/:id/transcript`, `/:id/debug`) is read-only and node-local: it is not on the
 *  hub relay allow-list. Every response passes through redactDeep() on its way
 *  out, because transcripts quote whatever the agent printed — including a key,
 *  if it ran `env`. See docs/harness-runs.md. */
import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import { isLoopbackAddress } from '../../auth/enroll-exempt';
import { describeHarnesses, getCapabilities, getHarness } from '../../harness/registry';
import {
  describeProviderConfig,
  loadProviderConfig,
  saveProviderConfig,
  HARNESS_ENV_PREFIX,
  type ProviderProfile,
} from '../../harness/provider-config';
import type { HarnessProbe } from '../../harness/types';
import { isDevRepo } from '../../utils/path-utils';
import { collectSecrets, redactDeep, redactString } from '../../harness/redact';
import { RUN_ID_RE, RUN_LIMITS, type HarnessRunRecord, type HarnessRunStatus, type HarnessRunnerSummary } from '../../harness/run-types';
import {
  RUNNER_DISPLAY_NAMES,
  allRuns,
  childAliveOf,
  deriveStatus,
  getRun,
  listRuns,
  sourceRefFor,
  summarizeRunner,
} from '../../harness/run-store';
import { resolveRecordRunDir } from '../../harness/run-paths';
import { ensureBackfill } from '../../harness/backfill';
import {
  loadTranscript,
  readQwenDebugTail,
  resolveTranscriptSource,
  transcriptVersion,
  type TranscriptSources,
} from '../../harness/transcript';

interface Envelope { success: boolean; data?: unknown; error?: { code: string; message: string }; httpStatus?: number }
const ok = <T>(data: T): Envelope => ({ success: true, data });
const fail = (code: string, message: string, httpStatus?: number): Envelope =>
  ({ success: false, error: { code, message }, ...(httpStatus ? { httpStatus } : {}) });
/** Every run-history response leaves through here: redacted at the last moment, whatever its source. */
const okRedacted = <T>(data: T): Envelope => ok(redactDeep(data));

/** A profile name is a single safe segment — it becomes a JSON key, never a path. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * A probe shells out to a third-party binary, so it is bounded here rather than
 * trusted to return. One wedged CLI must not wedge the status endpoint that
 * exists to tell you the CLI is wedged.
 */
const PROBE_TIMEOUT_MS = 8000;

/**
 * Headers that mark a request as having come THROUGH something to reach Core's
 * loopback socket: the hub relay (`x-relay-source`) or the web's `/_coreapi`
 * rewrite (Next's proxy adds `x-forwarded-host`; other proxies the rest).
 */
const PROXY_MARKERS = ['x-relay-source', 'x-forwarded-host', 'x-forwarded-for', 'x-forwarded-proto'];

/**
 * Loopback AND not relayed or proxied.
 *
 * 🔴 A loopback source address alone proves nothing here. The hub relay
 * forwards every request to 127.0.0.1 with the owner's token and marks it with
 * `x-relay-source` (api-relay-handler makeLocalRequest). And the web binds
 * 0.0.0.0 and rewrites `/_coreapi/:path*` to 127.0.0.1:<core>, so a LAN client
 * holding the token reaches Core from loopback too — marked only by the
 * `x-forwarded-host` Next adds. Any of these headers refuses: a genuine console
 * caller (curl on the host, straight at Core) sends none, and the web UI never
 * calls this write.
 */
function requireLoopback(req: ParsedRequest): Envelope | null {
  const relayed = PROXY_MARKERS.some((h) => req.headers?.[h] !== undefined);
  return isLoopbackAddress(req.clientIp) && !relayed
    ? null
    : fail('FORBIDDEN', 'local-only endpoint: storing a harness provider credential is an owner action at the console (a direct loopback call to Core), never over the LAN, the web proxy or the hub relay', 403);
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

  // A stored key is tied to the endpoint it was given for: pointing an existing
  // profile at a new host must re-supply the key, so no write — and no future
  // bypass of the guard above — can redirect a credential to another server.
  if (existing && str(body.baseUrl) !== undefined && str(body.baseUrl) !== existing.baseUrl && !str(body.apiKey)) {
    return fail('INVALID_INPUT', `changing baseUrl of profile "${name}" requires re-supplying apiKey (the stored key is not sent to a new host)`);
  }

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

// ── run history ─────────────────────────────────────────────────────────────

type Query = Record<string, string | undefined>;

const RUN_STATUSES: ReadonlySet<string> = new Set<HarnessRunStatus>([
  'running', 'succeeded', 'failed', 'timed_out', 'aborted', 'refused', 'launch_failed', 'interrupted', 'not_started', 'unknown',
]);

/** Clamp a query number (adapted from backup.routes.ts): garbage or empty takes the default, out-of-range is pinned. */
function num(v: string | undefined, dflt: number, min: number, max: number): number {
  const n = Number(v);
  if (v === undefined || v === '' || !Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Echo what the caller sent: their own typo is the fastest thing to act on. */
const invalidQuery = (field: string, value: unknown, expected: string): Envelope =>
  fail('INVALID_QUERY', `${field}=${JSON.stringify(String(value).slice(0, 100))} is not valid — expected ${expected}`, 400);

function currentCore(): 'dev' | 'prod' {
  return isDevRepo() ? 'dev' : 'prod';
}

function displayNameOf(id: string): string {
  return getHarness(id)?.displayName ?? RUNNER_DISPLAY_NAMES[id] ?? id;
}

/**
 * A route id is only ever a lookup key. It is decoded once and must match
 * RUN_ID_RE — no '.', '/', '\\' or NUL — so `..%2F..%2Fetc` is refused here and
 * never reaches anything that builds a path (run dirs come from the record).
 */
function parseRunId(raw: string | undefined): { id: string } | { error: Envelope } {
  let id: string;
  try {
    id = decodeURIComponent(raw ?? '');
  } catch {
    return { error: fail('INVALID_ID', `run id ${JSON.stringify(String(raw).slice(0, 100))} is not valid percent-encoding`, 400) };
  }
  if (!RUN_ID_RE.test(id)) {
    return { error: fail('INVALID_ID', `run id ${JSON.stringify(id.slice(0, 100))} must match ${RUN_ID_RE.source}`, 400) };
  }
  return { id };
}

const notFound = (id: string): Envelope =>
  fail('NOT_FOUND', `no harness run ${JSON.stringify(id)} on this node's ${currentCore()} Core — pruned by retention, or recorded by the other (dev/prod) Core`, 404);

/**
 * stdout.log carries no marker when the writer hits its 8 MB cap — it just
 * stops — so only the record knows the capture is partial. The transcript layer
 * reads the file, not the record, and cannot say so itself.
 */
function withCaptureTruncation<S extends TranscriptSources>(sources: S, rec: HarnessRunRecord): S {
  return rec.capture?.truncated ? { ...sources, captured: { ...sources.captured, truncated: true } } : sources;
}

/** `since` as epoch ms, or a relative window like 24h / 7d. `all` (or empty) means no bound. */
function parseSince(v: string | undefined, now: number): number | undefined | null {
  if (v === undefined || v === '' || v === 'all') return undefined;
  const rel = /^(\d{1,4})([hd])$/.exec(v);
  if (rel) return now - Number(rel[1]) * (rel[2] === 'h' ? 3600e3 : 86400e3);
  if (/^\d{1,16}$/.test(v)) return Number(v);
  return null;
}

/** GET /harness/runs — recorded (and, on dev, backfilled) runs, newest first. */
export function handleRunsList(query: Query = {}): Envelope {
  const now = Date.now();
  const backfill = ensureBackfill();

  let statuses: HarnessRunStatus[] | undefined;
  if (query.status) {
    const parts = query.status.split(',').map((s) => s.trim()).filter(Boolean);
    const bad = parts.find((s) => !RUN_STATUSES.has(s));
    if (bad !== undefined) return invalidQuery('status', bad, `a comma list of ${[...RUN_STATUSES].join('|')}`);
    statuses = parts as HarnessRunStatus[];
  }
  const runner = query.runner || undefined;
  if (runner && !describeHarnesses().some((h) => h.id === runner) && !allRuns().some((r) => r.runner === runner)) {
    return invalidQuery('runner', runner, `one of ${describeHarnesses().map((h) => h.id).join('|')}`);
  }
  const since = parseSince(query.since, now);
  if (since === null) return invalidQuery('since', query.since, 'epoch ms, <n>h, <n>d or all');
  const ib = query.includeBackfill;
  if (ib !== undefined && !['1', '0', 'true', 'false', ''].includes(ib)) {
    return invalidQuery('includeBackfill', ib, '1 or 0');
  }

  const res = listRuns({
    runner,
    statuses,
    q: (query.q ?? '').slice(0, 100),
    since,
    includeBackfill: !(ib === '0' || ib === 'false'),
    limit: num(query.limit, RUN_LIMITS.listDefault, 1, RUN_LIMITS.listMax),
    offset: num(query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
    displayName: displayNameOf,
  });
  return okRedacted({ core: currentCore(), ...res, backfill });
}

const ISOLATION: Record<string, string> = {
  qwen: 'QWEN_HOME per run',
  opencode: 'shares ~/.config/opencode and ~/.local/share/opencode with the operator',
};
const MAX_TURNS_ENFORCED: Record<string, boolean> = { qwen: true, opencode: false };

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * GET /harness/runners — one summary per runner: capabilities, the default
 * provider profile (redacted view), and window stats for the recorded ones.
 *
 * 🔴 NEVER probes. A probe spawns the CLI (`/harness/status` takes ~1.6 s for
 * it); this endpoint is polled by the page, and a page must not fork two CLIs
 * every 15 seconds to draw a card.
 */
export function handleRunners(query: Query = {}): Envelope {
  const windowDays = num(query.days, 30, 1, 365);
  ensureBackfill();
  const providers = describeProviderConfig();
  const dflt = providers.profiles.find((p) => p.name === providers.defaultProfile);
  const profile = dflt ? { name: dflt.name, model: dflt.model, baseUrlHost: hostOf(dflt.baseUrl), hasKey: dflt.hasKey } : null;

  const runners: HarnessRunnerSummary[] = describeHarnesses().map((h) => ({
    id: h.id,
    displayName: displayNameOf(h.id),
    pluggable: h.pluggable,
    recorded: h.pluggable,
    capabilities: h.capabilities,
    maxTurnsEnforced: h.pluggable ? MAX_TURNS_ENFORCED[h.id] ?? null : null,
    isolation: ISOLATION[h.id] ?? null,
    profile: h.pluggable && h.capabilities.usesProviderProfile ? profile : null,
    ...(h.pluggable ? {} : { note: 'Claude runner — its runs are Claude Code sessions (see /sessions)' }),
    stats: h.pluggable ? summarizeRunner(h.id, windowDays) : null,
  }));
  return okRedacted({ generatedAt: Date.now(), windowDays, core: currentCore(), runners });
}

/** GET /harness/runs/:id — the record, its derived status, and which transcript sources exist. */
export function handleRunGet(rawId: string): Envelope {
  const parsed = parseRunId(rawId);
  if ('error' in parsed) return parsed.error;
  const rec = getRun(parsed.id);
  if (!rec) return notFound(parsed.id);

  const d = deriveStatus(rec);
  const { sources } = resolveTranscriptSource(sourceRefFor(rec, d.live), 'auto');
  // The DB locator is an absolute path into the operator's home — used here, never served.
  const { native, ...rest } = rec;
  return okRedacted({
    run: { ...rest, ...(native ? { native: { kind: native.kind } } : {}) },
    status: d.status,
    live: d.live,
    abortable: d.live && rec.origin === 'recorded' && getCapabilities(rec.runner)?.abortable === true,
    ...(d.status === 'interrupted' ? { childAlive: childAliveOf(rec) } : {}),
    sources: withCaptureTruncation(sources, rec),
  });
}

/**
 * GET /harness/runs/:id/transcript — one page of the normalized event stream.
 *
 * `ifVersion` makes polling a live run cheap: when the chosen source has not
 * changed, the answer is `unchanged: true` with no events and the client keeps
 * the page it has.
 */
export function handleRunTranscript(rawId: string, query: Query = {}): Envelope {
  const parsed = parseRunId(rawId);
  if ('error' in parsed) return parsed.error;
  const rec = getRun(parsed.id);
  if (!rec) return notFound(parsed.id);

  const requested = query.source ?? 'auto';
  if (requested !== 'auto' && requested !== 'captured' && requested !== 'native') {
    return invalidQuery('source', requested, 'auto|captured|native');
  }
  const offset = num(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = num(query.limit, 300, 1, 1000);
  const maxField = num(query.maxField, 4000, 256, 65536);

  const d = deriveStatus(rec);
  const ref = sourceRefFor(rec, d.live);
  const head = { id: rec.id, runner: rec.runner, live: d.live, runStatus: d.status };

  if (query.ifVersion) {
    const { source, sources } = resolveTranscriptSource(ref, requested);
    const version = transcriptVersion(ref, source);
    if (version === query.ifVersion) {
      return okRedacted({
        ...head, source, sources: withCaptureTruncation(sources, rec), version, unchanged: true,
        events: [], total: 0, offset, nextOffset: null, truncated: false, filesTouched: [], warnings: [],
      });
    }
  }

  // Redacted BEFORE each field is cut to maxField, then again on the way out (okRedacted).
  const secrets = collectSecrets();
  const t = loadTranscript(ref, { source: requested, offset, limit, maxField, redact: (s) => redactString(s, secrets) });
  return okRedacted({ ...head, ...t, sources: withCaptureTruncation(t.sources, rec) });
}

/** GET /harness/runs/:id/debug — the tail of qwen's own debug log (qwen only). */
export function handleRunDebug(rawId: string, query: Query = {}): Envelope {
  const parsed = parseRunId(rawId);
  if ('error' in parsed) return parsed.error;
  const rec = getRun(parsed.id);
  if (!rec) return notFound(parsed.id);
  if (rec.runner !== 'qwen') {
    return fail('NOT_APPLICABLE', `run ${JSON.stringify(rec.id)} is a ${rec.runner} run; only qwen writes a debug log`, 404);
  }
  const lines = num(query.lines, 120, 1, 200);
  const runDir = resolveRecordRunDir(rec);
  if (!runDir) return okRedacted({ available: false, reason: 'NO_RUN_DIR', lines: [], totalLines: 0, truncated: false });
  return okRedacted(readQwenDebugTail(runDir, rec.sessionId ?? null, lines));
}

export function createHarnessRoutes(_ctx: RouteContext): RouteHandler[] {
  const wrap = (run: (req: ParsedRequest) => Envelope | Promise<Envelope>): RouteHandler['handler'] =>
    async (req) => {
      const start = Date.now();
      const e = await run(req);
      const out = e.success
        ? wrapResponse(e.data, start)
        : wrapError(e.error?.code ?? 'ERROR', e.error?.message ?? 'error', start);
      // rest-server honours a top-level httpStatus; without it a 404 goes out as 400.
      return e.httpStatus ? { ...out, httpStatus: e.httpStatus } : out;
    };

  // Literal paths before the `/:id` patterns — the first matching regex wins.
  return [
    { method: 'GET', pattern: /^\/harness\/status$/, handler: wrap(() => handleHarnessStatus()) },
    { method: 'GET', pattern: /^\/harness\/runners$/, handler: wrap((req) => handleRunners(req.query)) },
    { method: 'GET', pattern: /^\/harness\/runs$/, handler: wrap((req) => handleRunsList(req.query)) },
    {
      method: 'GET',
      pattern: /^\/harness\/runs\/(?<id>[^/]+)\/transcript$/,
      handler: wrap((req) => handleRunTranscript(req.params.id, req.query)),
    },
    {
      method: 'GET',
      pattern: /^\/harness\/runs\/(?<id>[^/]+)\/debug$/,
      handler: wrap((req) => handleRunDebug(req.params.id, req.query)),
    },
    { method: 'GET', pattern: /^\/harness\/runs\/(?<id>[^/]+)$/, handler: wrap((req) => handleRunGet(req.params.id)) },
    {
      method: 'PUT',
      pattern: /^\/harness\/provider\/(?<name>[^/]+)$/,
      handler: wrap((req) => handleProviderPut(req.params.name, req, (req.body || {}) as Record<string, unknown>)),
    },
  ];
}
