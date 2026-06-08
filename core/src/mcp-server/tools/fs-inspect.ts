/**
 * Filesystem inspect MCP tools — wrap the worker's /storage/* REST routes so an
 * agent can browse drives → directories → files on any owned node, then copy
 * files to/from real locations with transfer_send_file.
 *
 * The `node` selector (configure.ts) picks WHICH node runs the command (its
 * local filesystem). Pass `peerGatewayId` to inspect ANOTHER node's filesystem
 * instead — the selected node opens a transport channel to the peer and runs
 * the inspect there. Both nodes must belong to you.
 *
 * Wiring: registered in EXPANDED_TOOL_DEFS + EXPANDED_HANDLERS (expanded.ts),
 * scoped read in configure.ts TOOL_SCOPES.
 */
import { ok, err, workerPost, type McpToolResult } from './_passthrough';

const peerNote =
  'Omit peerGatewayId to inspect the selected node\'s own filesystem; pass it (a hostId from ' +
  'list_nodes) to inspect that peer\'s filesystem instead.';

export const fsDrivesToolDef = {
  name: 'fs_drives',
  description:
    'List the top-level roots ("drives") to start browsing from on a node — POSIX: /, home, ' +
    'mount points; Windows: drive letters. ' +
    peerNote +
    ' Read-only, cached.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      peerGatewayId: { type: 'string', description: 'Optional peer node to inspect (from list_nodes).' },
      refresh: { type: 'boolean', description: 'Bypass the cache and re-read from disk.' },
    },
  },
};

export const fsListToolDef = {
  name: 'fs_list',
  description:
    'List a directory (one level) on a node by ABSOLUTE path. Returns each child: name, size, ' +
    'mode, isDir, mtime. Shallow + entry-capped (does not recurse, so it is safe on huge trees; ' +
    'truncated:true means there were more children than returned). ' +
    peerNote +
    ' Read-only, cached (pass refresh:true to force a re-read).',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      path: { type: 'string', description: 'Absolute directory path on the target node.' },
      peerGatewayId: { type: 'string', description: 'Optional peer node to inspect (from list_nodes).' },
      refresh: { type: 'boolean', description: 'Bypass the cache and re-read from disk.' },
    },
    required: ['path'],
  },
};

export const fsStatToolDef = {
  name: 'fs_stat',
  description:
    'Stat a single ABSOLUTE path on a node: exists, isDir/isFile/isSymlink, size, mode, mtime, ' +
    'symlink target. A missing path returns exists:false (not an error). ' +
    peerNote +
    ' Read-only, cached.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      path: { type: 'string', description: 'Absolute path on the target node.' },
      peerGatewayId: { type: 'string', description: 'Optional peer node to inspect (from list_nodes).' },
      refresh: { type: 'boolean', description: 'Bypass the cache and re-read from disk.' },
    },
    required: ['path'],
  },
};

export const FS_INSPECT_TOOL_DEFS = [fsDrivesToolDef, fsListToolDef, fsStatToolDef] as const;

interface Drive { path: string; type: string; label?: string }
interface Entry { name: string; size: number; mode: number; isDir: boolean; mtimeMs: number }

function modeStr(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, '0');
}

async function handleFsDrives(args: Record<string, unknown>): Promise<McpToolResult> {
  const body: Record<string, unknown> = {};
  if (args.peerGatewayId) body.peerGatewayId = String(args.peerGatewayId);
  if (args.refresh === true) body.refresh = true;
  try {
    const d = await workerPost<{ drives: Drive[]; node?: string }>('/storage/drives', body);
    const drives = d.drives || [];
    return ok(
      `Drives/roots${d.node ? ' on ' + d.node : ''} (${drives.length}):\n` +
        drives.map((x) => `  ${x.type}\t${x.path}${x.label ? '  (' + x.label + ')' : ''}`).join('\n'),
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleFsList(args: Record<string, unknown>): Promise<McpToolResult> {
  const p = String(args.path || '').trim();
  if (!p) return err('path is required (absolute directory path).');
  const body: Record<string, unknown> = { path: p };
  if (args.peerGatewayId) body.peerGatewayId = String(args.peerGatewayId);
  if (args.refresh === true) body.refresh = true;
  try {
    const d = await workerPost<{ path: string; entries: Entry[]; truncated: boolean; total: number }>(
      '/storage/list',
      body,
    );
    const entries = d.entries || [];
    const header = `${d.path} (${d.total} item${d.total === 1 ? '' : 's'}${d.truncated ? `, showing ${entries.length}` : ''}):`;
    if (!entries.length) return ok(`${header}\n  (empty)`);
    return ok(
      header +
        '\n' +
        entries
          .map(
            (e) =>
              `  ${e.isDir ? 'd' : '-'} ${modeStr(e.mode)} ${String(e.size).padStart(10)}  ${e.name}${e.isDir ? '/' : ''}`,
          )
          .join('\n'),
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleFsStat(args: Record<string, unknown>): Promise<McpToolResult> {
  const p = String(args.path || '').trim();
  if (!p) return err('path is required (absolute path).');
  const body: Record<string, unknown> = { path: p };
  if (args.peerGatewayId) body.peerGatewayId = String(args.peerGatewayId);
  if (args.refresh === true) body.refresh = true;
  try {
    const s = await workerPost<{
      path: string; name: string; exists: boolean; isDir: boolean; isFile: boolean;
      isSymlink: boolean; size: number; mode: number; mtimeMs: number; symlinkTarget?: string;
    }>('/storage/stat', body);
    if (!s.exists) return ok(`${s.path} — does not exist.`);
    const kind = s.isDir ? 'directory' : s.isSymlink ? 'symlink' : s.isFile ? 'file' : 'other';
    return ok(
      `${s.path}\n` +
        `  type: ${kind}${s.symlinkTarget ? ' -> ' + s.symlinkTarget : ''}\n` +
        `  size: ${s.size}   mode: ${modeStr(s.mode)}   mtime: ${new Date(s.mtimeMs).toISOString()}`,
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export const FS_INSPECT_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  fs_drives: handleFsDrives,
  fs_list: handleFsList,
  fs_stat: handleFsStat,
};
