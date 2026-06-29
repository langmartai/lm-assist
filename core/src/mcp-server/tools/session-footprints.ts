import { getComposed } from '../../fleet/footprint-compose';
import { composeDeps } from '../../routes/core/fleet.routes';

export const sessionFootprintsToolDef = {
  name: 'session_footprints',
  description:
    'Cross-fleet survey of RECENT sessions and what each one OCCUPIES — node, repo, branch, ' +
    'worktree, open changes (uncommitted + committed-but-unpushed), and listening ports — composed ' +
    'server-side in ONE call. Each session is tagged `managed` (a missionId if it is a mission ' +
    'executor, else null = UNMANAGED). The Mission Controller calls this BEFORE placing a worker to ' +
    'avoid colliding with unmanaged in-flight work on a node/repo/branch/port. Read-only; non-blocking ' +
    '(may return `warming`/`partial` right after boot, fills within seconds). scope: "cluster" (default) or "fleet".',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      scope: { type: 'string', enum: ['cluster', 'fleet'], description: 'cluster (default — your placement boundary) or fleet (all online nodes).' },
    },
    required: [] as string[],
  },
};

export async function handleSessionFootprints(args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  const scope = args.scope === 'fleet' ? 'fleet' : 'cluster';
  const composed = await getComposed(scope, composeDeps());
  return { content: [{ type: 'text', text: JSON.stringify(composed, null, 2) }] };
}
