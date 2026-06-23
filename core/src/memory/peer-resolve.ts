/**
 * Peer discovery for convergent memory sync: find the fleet nodes that share a project (by git remote)
 * and how that project is slugged on each. Pure logic with the network parts injected (list_nodes +
 * the per-node by-remote query), so it is unit-testable; the daemon wires the real relayed calls.
 */

export interface Peer { node: string; slug: string }

/** Pure: which of THIS node's projects have a cwd whose git remote normalizes to `key`. */
export function projectsMatchingRemote(
  projects: Array<{ projectId: string; projectPath: string }>,
  key: string,
  remoteKeyOf: (cwd: string) => string | null,
): string[] {
  if (!key) return [];
  return projects.filter((p) => remoteKeyOf(p.projectPath) === key).map((p) => p.projectId);
}

/**
 * Resolve fleet peers that share `localRemoteKey`. `slugsByRemote(node,key)` asks that node which of
 * its project slugs match the remote (relayed GET /memory/projects-by-remote). Unreachable nodes are
 * skipped. Returns a flat [{node, slug}] list (a node may host the repo at >1 path).
 */
export async function resolvePeers(
  localRemoteKey: string,
  fleetNodes: string[],
  slugsByRemote: (node: string, key: string) => Promise<string[]>,
): Promise<Peer[]> {
  if (!localRemoteKey) return [];
  const peers: Peer[] = [];
  for (const node of fleetNodes) {
    let slugs: string[] = [];
    try { slugs = await slugsByRemote(node, localRemoteKey); } catch { continue; }
    for (const slug of slugs) peers.push({ node, slug });
  }
  return peers;
}
