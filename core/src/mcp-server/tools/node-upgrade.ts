/**
 * node_upgrade MCP tool — trigger a per-node lm-assist upgrade to a SPECIFIED
 * prebuilt build via the relay (complements node_builds which shows builds).
 *
 * Thin proxy to POST /dev-mode/upgrade. The cross-node `node` param is handled
 * by the relay/_passthrough layer, so the handler just does workerPost.
 *
 * Registered in EXPANDED_TOOL_DEFS + EXPANDED_HANDLERS (expanded.ts),
 * scoped 'admin' in configure.ts TOOL_SCOPES (destructive — restarts services).
 */
import * as fs from 'fs';
import { ok, err, workerGet, workerPost, type McpToolResult } from './_passthrough';
import { envLabelOf, hubHostOf } from '../fleet-identity';
import { getHubConfig } from '../../hub-client/hub-config';
import { getMyCluster } from '../../cluster/cluster-config';

const DOWNGRADE_MSG =
  'source is required — nothing was upgraded, this call was rejected on purpose. Pass a ' +
  'prebuilt .tgz path/URL, a GitHub release URL, or github:owner/repo#ref (or a ref=). ' +
  'A bare call is a SAFE no-op guard: it dispatches nothing and restarts nothing. The guard ' +
  'exists because omitting would otherwise default to installing npm latest, which would ' +
  'DOWNGRADE this fleet — we never publish to npm.';

/**
 * Resolve the upgrade source from explicit source string or a ref shorthand.
 * PURE — no I/O.
 *
 * Returns { ok: true, source } when a valid source is found, or
 * { ok: false, error } when the call would be a downgrade / the guard fires.
 */
export function resolveUpgradeSource(
  source?: string,
  ref?: string,
): { ok: true; source: string } | { ok: false; error: string } {
  const trimmed = (source ?? '').trim();

  if (trimmed) {
    // Guard obvious downgrade footguns — all of these resolve to npm latest.
    if (trimmed === 'latest' || trimmed === 'lm-assist@latest' || trimmed === 'lm-assist') {
      return { ok: false, error: DOWNGRADE_MSG };
    }
    return { ok: true, source: trimmed };
  }

  const trimmedRef = (ref ?? '').trim();
  if (trimmedRef) {
    return { ok: true, source: `github:langmartai/lm-assist#${trimmedRef}` };
  }

  return { ok: false, error: DOWNGRADE_MSG };
}

/** Identity of the node a handler is actually executing on. */
export interface SelfIdentity {
  /** gatewayId — the handle the hub routes by. Null before the hub assigns one. */
  hostId: string | null;
  hostname: string;
  cluster: string;
  hubHost: string | null;
}

/** Compare node handles: trim, casefold, and drop the `(dev)` hostname suffix. */
function normalizeHandle(v: string): string {
  return v.trim().toLowerCase().replace(/\s*\(dev\)\s*$/, '');
}

/**
 * PURE — decide whether THIS node may execute an upgrade that named `requested`.
 *
 * The `node` argument is resolved at the hub, which this repo cannot change, but
 * it SURVIVES the relay into the target handler (measured 2026-07-28). So the
 * target can verify the routing landed where the caller meant. Two ways it does
 * not: `node` omitted, where the hub silently picks its most-recently-connected
 * default; and `node` named but delivered elsewhere (hub fallback, stdio
 * transport, or the caller is on the other connector's fleet).
 *
 * A read tolerates both. An upgrade replaces a build and restarts services, so
 * it refuses and says which machine it was about to replace.
 */
export function checkUpgradeTarget(
  requested: string | null | undefined,
  self: SelfIdentity,
): { ok: true } | { ok: false; error: string } {
  const here = `${self.hostname}${self.hostId ? ` (${self.hostId})` : ''}`;
  const where = `hub ${self.hubHost ?? '(none — local only)'} · cluster ${self.cluster}`;
  const asked = (requested ?? '').trim();

  if (!asked) {
    return {
      ok: false,
      error:
        'node is required to upgrade — nothing was upgraded, this call was rejected on ' +
        'purpose. With no node the hub routes to its DEFAULT node (most recently ' +
        `connected), which here resolved to ${here} on ${where}. That is not necessarily ` +
        'the machine you mean, and an upgrade replaces its build and restarts its ' +
        'services. Name it: node=<hostId|hostname> from list_nodes. This refusal ' +
        'dispatched nothing and restarted nothing.',
    };
  }

  const want = normalizeHandle(asked);
  const matches =
    want === normalizeHandle(self.hostname) ||
    (self.hostId != null && want === normalizeHandle(self.hostId));
  if (matches) return { ok: true };

  return {
    ok: false,
    error:
      `targeting mismatch — nothing was upgraded. This call named "${asked}" but ran on ` +
      `${here} (${where}). Refusing rather than replacing a machine you did not name. ` +
      `Either the hub fell back to its default node, or "${asked}" is not in THIS ` +
      "connector's fleet — a PRODUCTION (langmart) and a DEVELOPMENT (xeenhub) connector " +
      'expose identical tool names over independent fleets that do not share nodes. ' +
      'Confirm with list_nodes on this connector, then retry with a node it lists.',
  };
}

/**
 * True when `source` denotes a tarball on the target node's OWN filesystem —
 * i.e. something an existence check applies to. URLs and scheme-style specs
 * (github:, npm:) are resolved by the upgrade script, not from disk.
 *
 * Windows paths (`C:\…\lm-assist.tgz`) deliberately fall through to the
 * extension test: `C:` is not a `://` URL and not a known spec scheme.
 */
export function isLocalTarball(source: string): boolean {
  const s = source.trim();
  if (!s) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return false;
  if (/^(github|git|npm|file):/i.test(s)) return false;
  return /\.(tgz|tar\.gz)$/i.test(s);
}

/**
 * PURE (I/O injected) — refuse a local tarball path that does not exist on the
 * target, BEFORE anything is dispatched.
 *
 * This is not politeness about a doomed install. `upgrade.js` resolveSource()
 * falls through to the npm-spec branch when the path is absent, and main()
 * kills every service (step 2) BEFORE attempting the install (step 3). A typo'd
 * path therefore takes the node's Core and Web down, fails to install, and the
 * route has already answered "Upgrade started" — it spawns detached with
 * stdio:'ignore' and cannot observe the child dying.
 */
export function checkSourceExists(
  source: string,
  exists: (p: string) => boolean,
): { ok: true } | { ok: false; error: string } {
  const s = source.trim();
  if (!isLocalTarball(s)) return { ok: true };
  if (exists(s)) return { ok: true };
  return {
    ok: false,
    error:
      `source not found on the target node: ${s} — nothing was upgraded. This path must ` +
      'exist on the machine being upgraded, not the one you are calling from. Dispatching ' +
      'anyway would be destructive rather than merely useless: the upgrade script STOPS ' +
      'Core and Web first and installs second, and a missing .tgz falls through to an npm ' +
      'spec that cannot resolve — so the node would be left with its services down and no ' +
      'new build. Build the tarball ON the target (./core.sh pack) or copy it there, then ' +
      'retry with its absolute path.',
  };
}

/**
 * PURE — state the resolved target BEFORE dispatching.
 *
 * The `⟦lm-assist@hub · node · cluster⟧` result footer carries the same facts,
 * but it arrives after the services have already been restarted. An upgrade
 * should say which machine, on which hub, in which cluster, and from which
 * build to which — while refusing is still possible.
 */
export function formatPreflight(
  self: SelfIdentity,
  currentVersion: string,
  source: string,
): string {
  const env = envLabelOf(self.hubHost, self.hostname);
  return [
    'Upgrade target — resolved BEFORE dispatch:',
    `  hub:     ${self.hubHost ?? '(none — local only)'}  [${env}]`,
    `  cluster: ${self.cluster}`,
    `  node:    ${self.hostname}${self.hostId ? ` (${self.hostId})` : ''}`,
    `  build:   ${currentVersion} → ${source}`,
  ].join('\n');
}

export const nodeUpgradeToolDef = {
  name: 'node_upgrade',
  description:
    'Upgrade a node\'s lm-assist build to a SPECIFIED prebuilt source (then confirm with ' +
    'node_builds). source = a prebuilt .tgz path (absolute, ON the target node) / .tgz URL / ' +
    'GitHub release URL. STRONGLY PREFER a prebuilt .tgz: a github:owner/repo#ref (or ref=) ' +
    'builds FROM SOURCE, which on this repo runs a full dependency install that trips ' +
    'onnxruntime-node\'s native postinstall and FAILS — build a tarball first with ' +
    '`./core.sh pack` and pass it as source. ' +
    'You MUST also name the target explicitly with node=<hostId|hostname from list_nodes>: ' +
    'omitting it would let the hub route to its most-recently-connected DEFAULT node, so ' +
    'this tool REFUSES a nodeless call rather than replacing a machine you did not name. It ' +
    'likewise refuses if the call lands on a node other than the one named (hub fallback, or ' +
    "the node belongs to the OTHER connector's fleet), and refuses a local .tgz source that " +
    'does not exist on the target — a missing tarball would stop that node\'s services and ' +
    'then fail to install. All three refusals dispatch nothing and restart nothing. ' +
    'To actually upgrade you MUST pass source (or ref). Calling with NEITHER is SAFE and ' +
    'side-effect-free: the tool returns a guard error and dispatches/restarts NOTHING — so a ' +
    'bare node_upgrade({}) is a no-op you can call freely to see the guard. (The guard exists ' +
    'because a bare call would otherwise default to npm latest, which would DOWNGRADE this ' +
    'fleet — we don\'t publish to npm.) WITH a valid source it dispatches the detached ' +
    'upgrade + RESTARTS the node\'s Core/Web, returning immediately (\'Upgrade started\'); ' +
    'poll node_builds + GET /dev-mode/upgrade-log to confirm (~30-60s for a .tgz; minutes ' +
    'for github:). NOTE: cleanest on standard nodes (`lm-assist restart`); a systemd-managed ' +
    'or Windows-scheduled-task Core may need its own restart path.',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      source: {
        type: 'string',
        description:
          'Prebuilt .tgz path (absolute, ON the target node), .tgz URL, GitHub release URL, ' +
          'or npm spec. Required to actually upgrade; omitting (with no ref) is a SAFE no-op ' +
          'that returns a guard error and upgrades nothing (NOT an npm-latest downgrade). ' +
          'Wins over ref.',
      },
      ref: {
        type: 'string',
        description:
          'Git ref shorthand — expands to github:langmartai/lm-assist#<ref>. Only used when ' +
          'source is absent. DISCOURAGED: this builds from source and FAILS on this repo ' +
          '(onnxruntime-node postinstall). Prefer a prebuilt .tgz `source` from `./core.sh pack`.',
      },
      node: {
        type: 'string',
        description: 'Target node id/hostId (from list_nodes/node_builds). Omit for the current node.',
      },
    },
  },
};

interface UpgradeResult {
  message?: string;
  pid?: number;
  source?: string;
}

/**
 * Resolve THIS node's identity from lm-assist's own runtime config.
 * NEVER throws — degrades to placeholders so a guard can still refuse safely.
 */
function resolveSelf(): SelfIdentity {
  let hostId: string | null = null;
  let hostname = 'this node';
  let hubHost: string | null = null;
  try {
    const cfg = getHubConfig();
    hostId = cfg.gatewayId;
    hostname = cfg.hostname || 'this node';
    hubHost = hubHostOf(cfg.hubUrl);
  } catch {
    /* hub config unavailable — placeholders stand */
  }
  let cluster = 'default';
  try {
    cluster = getMyCluster();
  } catch {
    /* default */
  }
  return { hostId, hostname, cluster, hubHost };
}

export async function handleNodeUpgrade(
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  try {
    const r = resolveUpgradeSource(
      args.source != null ? String(args.source) : undefined,
      args.ref != null ? String(args.ref) : undefined,
    );
    if (!r.ok) return err(r.error);

    const self = resolveSelf();

    // This call is destructive and already landed on the machine it will replace.
    // Make it prove that machine is the one the caller named.
    const target = checkUpgradeTarget(
      args.node != null ? String(args.node) : undefined,
      self,
    );
    if (!target.ok) return err(target.error);

    // `source` is a path on the TARGET, and this handler runs on the target, so
    // a plain existsSync here IS the target-side check.
    const src = checkSourceExists(r.source, (p) => fs.existsSync(p));
    if (!src.ok) return err(src.error);

    // Best-effort current build for the pre-flight line — never block on it.
    let current = '?';
    try {
      const b = await workerGet<{ current?: string }>('/node/build');
      current = b?.current ?? '?';
    } catch {
      /* '?' */
    }
    const preflight = formatPreflight(self, current, r.source);

    const data = await workerPost<UpgradeResult>('/dev-mode/upgrade', { source: r.source });
    const message = data?.message ?? 'Upgrade started';
    const pid = data?.pid;
    const usedSource = data?.source ?? r.source;
    return ok(
      `${preflight}\n\n` +
        `${message}\n` +
        `source: ${usedSource}\n` +
        (pid != null ? `pid: ${pid}\n` : '') +
        'NOTE: the route spawns the upgrade DETACHED and returns immediately, so ' +
        '"started" is not "succeeded". Poll node_builds and GET /dev-mode/upgrade-log ' +
        'to confirm (~30-60s for a .tgz).',
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export const NODE_UPGRADE_TOOL_DEFS = [nodeUpgradeToolDef] as const;

export const NODE_UPGRADE_HANDLERS: Record<
  string,
  (args: Record<string, unknown>) => Promise<McpToolResult>
> = {
  node_upgrade: handleNodeUpgrade,
};
