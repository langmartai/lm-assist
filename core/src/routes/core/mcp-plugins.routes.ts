/** /mcp-plugins — the review + enable surface for third-party MCP plugins.
 *
 *  READS are open (the page must work through the hub relay like every other view).
 *  WRITES — enable, disable, grant — are LOOPBACK-ONLY owner actions, the same
 *  restriction POST /cluster/self and the machine-access writes use. Enabling a
 *  plugin authorises third-party code execution on this host: it is never reachable
 *  over the LAN, never through the hub relay, and never performed by an agent. */
import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import { isLoopbackAddress } from '../../auth/enroll-exempt';
import { discoverPlugins, type DiscoveryOptions, type PluginRecord } from '../../mcp-server/plugins/discovery';
import { readState, writeState } from '../../mcp-server/plugins/state-store';
import { readPluginAudit } from '../../mcp-server/plugins/audit';
import { getPluginAggregator } from '../../mcp-server/plugins/aggregator';
import { syncConnectorForPluginTools } from '../../mcp-server/plugins/connector-sync';
import { callExtToolFleetAware } from '../../mcp-server/plugins/fleet-plugins';
import { pluginsSubsystemEnabled, SEGMENT_RE, type PluginManifest } from '../../mcp-server/plugins/model';

interface Envelope { success: boolean; data?: unknown; error?: { code: string; message: string } }
const ok = <T>(data: T): Envelope => ({ success: true, data });
const fail = (code: string, message: string): Envelope => ({ success: false, error: { code, message } });

export interface PluginRouteOptions extends DiscoveryOptions {
  auditFile?: string;
  scratchRoot?: string;
  /** false = skip the automatic claude.ai connector propagation (tests). */
  connectorSync?: boolean;
}

/** A plugin id must be a single safe segment — never a path fragment. */
function validName(name: string): boolean {
  return typeof name === 'string' && SEGMENT_RE.test(name) && name.length <= 24;
}

function requireLoopback(req: ParsedRequest): Envelope | null {
  return isLoopbackAddress(req.clientIp)
    ? null
    : fail('FORBIDDEN', 'local-only endpoint: enabling or configuring a plugin is an owner action at the console, never over the LAN or the hub relay');
}

/** Public shape of a plugin — deliberately free of grant VALUES. */
function view(rec: PluginRecord) {
  const m = rec.manifest;
  return {
    name: rec.name,
    phase: rec.effective.phase,
    reason: rec.effective.reason,
    version: m?.version,
    description: m?.description,
    author: m?.author,
    homepage: m?.homepage,
    tools: (m?.tools ?? []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    capabilities: m?.capabilities ?? { network: [], fs: [], env: [] },
    entry: m?.entry,
    payloadChecksum: rec.payloadChecksum,
    approvedChecksum: rec.state.approvedPayloadChecksum,
    pinMatches: !!rec.state.approvedPayloadChecksum && rec.state.approvedPayloadChecksum === rec.payloadChecksum,
    grantedEnv: Object.keys(rec.state.grants ?? {}),      // NAMES only; values never leave the node
    enabledAt: rec.state.enabledAt,
    health: rec.state.health ?? { failures: 0 },
    manifestErrors: rec.manifestErrors,
  };
}

export async function handlePluginList(_req: ParsedRequest, opts: PluginRouteOptions = {}): Promise<Envelope> {
  const recs = discoverPlugins(opts);
  return ok({
    subsystemEnabled: pluginsSubsystemEnabled(),
    plugins: recs.map(view),
    counts: {
      total: recs.length,
      enabled: recs.filter((r) => r.effective.phase === 'enabled').length,
      disabled: recs.filter((r) => r.effective.phase === 'disabled').length,
      invalid: recs.filter((r) => r.effective.phase === 'invalid').length,
      unhealthy: recs.filter((r) => r.effective.phase === 'unhealthy').length,
    },
  });
}

export async function handlePluginGet(name: string, _req: ParsedRequest, opts: PluginRouteOptions = {}): Promise<Envelope> {
  if (!validName(name)) return fail('NOT_FOUND', `no plugin named "${name}"`);
  const rec = discoverPlugins(opts).find((r) => r.name === name);
  if (!rec) return fail('NOT_FOUND', `no plugin named "${name}"`);
  return ok({ plugin: view(rec) });
}

export async function handlePluginEnable(
  name: string, req: ParsedRequest, body: Record<string, unknown>, opts: PluginRouteOptions = {},
): Promise<Envelope> {
  const denied = requireLoopback(req);
  if (denied) return denied;
  if (!validName(name)) return fail('NOT_FOUND', `no plugin named "${name}"`);

  const rec = discoverPlugins(opts).find((r) => r.name === name);
  if (!rec) return fail('NOT_FOUND', `no plugin named "${name}"`);
  if (!rec.manifest || rec.manifestErrors.length > 0) {
    return fail('INVALID_MANIFEST', `"${name}" cannot be enabled: ${rec.manifestErrors.join('; ')}`);
  }
  if (!rec.payloadChecksum || !rec.manifestDigest) {
    return fail('UNPINNABLE', `"${name}" cannot be enabled: its payload could not be hashed`);
  }
  // The caller may pin the exact checksum they reviewed; a mismatch means the payload
  // moved between review and approval, so refuse rather than approve something else.
  const expected = body.expectedChecksum;
  if (typeof expected === 'string' && expected !== rec.payloadChecksum) {
    return fail('CHECKSUM_MISMATCH',
      `payload checksum is ${rec.payloadChecksum}, not the ${expected} you reviewed — re-review before enabling`);
  }

  const state = writeState(name, {
    enabled: true,
    approvedPayloadChecksum: rec.payloadChecksum,
    approvedManifestDigest: rec.manifestDigest,
    enabledAt: Date.now(),
    enabledBy: typeof body.actor === 'string' ? body.actor.slice(0, 64) : 'owner@console',
    revertedReason: undefined,
    health: { failures: 0 },
  }, opts.stateFile);

  const after = discoverPlugins(opts).find((r) => r.name === name)!;
  const nsTools = (rec.manifest as PluginManifest).tools.map((t) => `ext__${name}__${t.name}`);
  // Propagate to the claude.ai connector WITHOUT any restart (cache clear →
  // bootstrap refetch → tool access → auto-approve). Best-effort + async: the
  // enable itself must not block on (or fail with) claude.ai reachability;
  // POST /mcp-plugins/sync-connector re-runs it manually anytime.
  // (skipped when a custom stateFile is injected — that's the unit-test path,
  // and the sync would otherwise touch the LIVE claude.ai account from tests)
  if (opts.connectorSync !== false && !opts.stateFile) {
    void syncConnectorForPluginTools({ addedTools: nsTools })
      .then((r) => console.log(`[mcp-plugins] connector sync after enabling "${name}": ok=${r.ok} listed=${r.toolsListed} ${r.steps.map((s) => `${s.step}:${s.ok ? 'ok' : 'FAIL'}`).join(' ')}`))
      .catch((e) => console.warn(`[mcp-plugins] connector sync after enabling "${name}" failed:`, e));
  }
  return ok({
    plugin: view(after),
    approvedChecksum: state.approvedPayloadChecksum,
    tools: nsTools,
    connectorSync: opts.connectorSync !== false && !opts.stateFile ? 'started' : 'skipped',
  });
}

export async function handlePluginDisable(name: string, req: ParsedRequest, opts: PluginRouteOptions = {}): Promise<Envelope> {
  const denied = requireLoopback(req);
  if (denied) return denied;
  if (!validName(name)) return fail('NOT_FOUND', `no plugin named "${name}"`);
  const rec = discoverPlugins(opts).find((r) => r.name === name);
  if (!rec) return fail('NOT_FOUND', `no plugin named "${name}"`);

  writeState(name, { enabled: false, revertedReason: 'disabled by the owner' }, opts.stateFile);
  // Stop any running child immediately — disable is instant, not lazy.
  try { await getPluginAggregator().shutdown(); } catch { /* best effort */ }
  // Refresh claude.ai's connector tool list so the removed tools disappear
  // without a restart (no access changes needed — they just drop off the list).
  if (opts.connectorSync !== false && !opts.stateFile) {
    const removed = rec.manifest ? (rec.manifest as PluginManifest).tools.map((t) => `ext__${name}__${t.name}`) : [];
    void syncConnectorForPluginTools({ removedTools: removed })
      .then((r) => console.log(`[mcp-plugins] connector sync after disabling "${name}": ok=${r.ok}`))
      .catch((e) => console.warn(`[mcp-plugins] connector sync after disabling "${name}" failed:`, e));
  }
  const after = discoverPlugins(opts).find((r) => r.name === name)!;
  return ok({ plugin: view(after) });
}

export async function handlePluginGrant(
  name: string, req: ParsedRequest, body: Record<string, unknown>, opts: PluginRouteOptions = {},
): Promise<Envelope> {
  const denied = requireLoopback(req);
  if (denied) return denied;
  if (!validName(name)) return fail('NOT_FOUND', `no plugin named "${name}"`);
  const rec = discoverPlugins(opts).find((r) => r.name === name);
  if (!rec) return fail('NOT_FOUND', `no plugin named "${name}"`);
  if (!rec.manifest) return fail('INVALID_MANIFEST', `"${name}" has no valid manifest`);

  const env = body.env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return fail('INVALID_INPUT', 'body.env must be an object of {ENV_NAME: value}');
  }
  const declared = new Set(rec.manifest.capabilities.env);
  const grants: Record<string, string> = { ...(rec.state.grants ?? {}) };
  for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
    if (!declared.has(k)) {
      return fail('UNDECLARED_ENV', `"${k}" is not declared in the manifest's capabilities.env — a grant needs a declaration first`);
    }
    if (v === null) { delete grants[k]; continue; }
    if (typeof v !== 'string') return fail('INVALID_INPUT', `grant "${k}" must be a string (or null to clear)`);
    grants[k] = v;
  }
  writeState(name, { grants }, opts.stateFile);
  // Response carries NAMES only — a granted secret is never echoed back.
  return ok({ name, grantedEnv: Object.keys(grants), declaredEnv: [...declared] });
}

export async function handlePluginAudit(
  name: string, _req: ParsedRequest, query: Record<string, unknown>, opts: PluginRouteOptions = {},
): Promise<Envelope> {
  if (!validName(name)) return fail('NOT_FOUND', `no plugin named "${name}"`);
  const limitRaw = Number(query.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100;
  return ok({ entries: readPluginAudit({ auditFile: opts.auditFile, plugin: name, limit }) });
}

/** Namespaced tool defs for the stdio surface (which cannot reach the aggregator in-process). */
export async function handlePluginToolDefs(): Promise<Envelope> {
  try {
    return ok({ tools: await getPluginAggregator().listToolDefs() });
  } catch {
    return ok({ tools: [] });   // fail-open: a broken plugin subsystem must not break tools/list
  }
}

/** Execution shim for the stdio surface AND the cross-node forward target:
 *  `POST /mcp-plugins/call {tool, args, noForward?}`. Fleet-aware like the /mcp
 *  surface — a call for a plugin this node doesn't own forwards one hop to the
 *  owner. `noForward:true` marks an already-forwarded call (or a caller that
 *  wants strictly-local execution): it never bounces again — loop-proof. */
export async function handlePluginCall(body: Record<string, unknown>): Promise<Envelope> {
  const tool = String(body.tool || '');
  const args = (body.args || {}) as Record<string, unknown>;
  if (!tool) return fail('INVALID_INPUT', 'body.tool is required');
  const result = await callExtToolFleetAware(tool, args, { noForward: body.noForward === true });
  return ok(result);
}

/** POST /mcp-plugins/sync-connector — propagate the CURRENT plugin tool set to
 *  the claude.ai connector without restarting anything (manual/no-restart
 *  re-sync; the same chain runs automatically on enable/disable). Loopback-only:
 *  it mutates claude.ai account state (cache, tool access, auto-approve). */
export async function handleConnectorSync(req: ParsedRequest): Promise<Envelope> {
  const denied = requireLoopback(req);
  if (denied) return denied;
  let tools: string[] = [];
  try { tools = (await getPluginAggregator().listToolDefs()).map((t) => t.name); } catch { /* subsystem off */ }
  const r = await syncConnectorForPluginTools({ addedTools: tools });
  return ok({ ...r, syncedTools: tools });
}

export function createMcpPluginsRoutes(_ctx: RouteContext): RouteHandler[] {
  const wrap = (run: (req: ParsedRequest) => Promise<Envelope>): RouteHandler['handler'] =>
    async (req) => {
      const start = Date.now();
      const e = await run(req);
      return e.success
        ? wrapResponse(e.data, start)
        : wrapError(e.error?.code ?? 'ERROR', e.error?.message ?? 'error', start);
    };

  return [
    // literals MUST precede the /:name patterns
    { method: 'GET', pattern: /^\/mcp-plugins$/, handler: wrap((req) => handlePluginList(req)) },
    { method: 'GET', pattern: /^\/mcp-plugins\/tool-defs$/, handler: wrap(() => handlePluginToolDefs()) },
    { method: 'POST', pattern: /^\/mcp-plugins\/call$/, handler: wrap((req) => handlePluginCall((req.body || {}) as Record<string, unknown>)) },
    { method: 'GET', pattern: /^\/mcp-plugins\/(?<name>[^/]+)\/audit$/, handler: wrap((req) => handlePluginAudit(req.params.name, req, req.query ?? {})) },
    { method: 'POST', pattern: /^\/mcp-plugins\/sync-connector$/, handler: wrap((req) => handleConnectorSync(req)) },
    { method: 'POST', pattern: /^\/mcp-plugins\/(?<name>[^/]+)\/enable$/, handler: wrap((req) => handlePluginEnable(req.params.name, req, (req.body || {}) as Record<string, unknown>)) },
    { method: 'POST', pattern: /^\/mcp-plugins\/(?<name>[^/]+)\/disable$/, handler: wrap((req) => handlePluginDisable(req.params.name, req)) },
    { method: 'POST', pattern: /^\/mcp-plugins\/(?<name>[^/]+)\/grant$/, handler: wrap((req) => handlePluginGrant(req.params.name, req, (req.body || {}) as Record<string, unknown>)) },
    { method: 'GET', pattern: /^\/mcp-plugins\/(?<name>[^/]+)$/, handler: wrap((req) => handlePluginGet(req.params.name, req)) },
  ];
}
