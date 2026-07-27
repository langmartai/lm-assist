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
import { ok, err, workerPost, type McpToolResult } from './_passthrough';

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

export const nodeUpgradeToolDef = {
  name: 'node_upgrade',
  description:
    'Upgrade a node\'s lm-assist build to a SPECIFIED prebuilt source (then confirm with ' +
    'node_builds). source = a prebuilt .tgz path (absolute, ON the target node) / .tgz URL / ' +
    'GitHub release URL. STRONGLY PREFER a prebuilt .tgz: a github:owner/repo#ref (or ref=) ' +
    'builds FROM SOURCE, which on this repo runs a full dependency install that trips ' +
    'onnxruntime-node\'s native postinstall and FAILS — build a tarball first with ' +
    '`./core.sh pack` and pass it as source. ' +
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

export async function handleNodeUpgrade(
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  try {
    const r = resolveUpgradeSource(
      args.source != null ? String(args.source) : undefined,
      args.ref != null ? String(args.ref) : undefined,
    );
    if (!r.ok) return err(r.error);

    const data = await workerPost<UpgradeResult>('/dev-mode/upgrade', { source: r.source });
    const message = data?.message ?? 'Upgrade started';
    const pid = data?.pid;
    const usedSource = data?.source ?? r.source;
    return ok(
      `${message}\n` +
        `source: ${usedSource}\n` +
        (pid != null ? `pid: ${pid}\n` : '') +
        `Poll node_builds and GET /dev-mode/upgrade-log to confirm (~30-60s for a .tgz).`,
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
