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
    'mode, isDir, mtime. Optionally filter by name with `pattern` (a shell glob like "*.ts" by ' +
    'default, or a JS regex when regex:true). Shallow + entry-capped (does not recurse, so it is ' +
    'safe on huge trees; truncated:true means there were more matches than returned). ' +
    peerNote +
    ' Read-only, cached (pass refresh:true to force a re-read).',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      path: { type: 'string', description: 'Absolute directory path on the target node.' },
      pattern: { type: 'string', description: 'Optional name filter: a shell glob by default (e.g. "*.ts", "data-?.json"), matched against the filename only (listing is one level, not recursive).' },
      regex: { type: 'boolean', description: 'Interpret `pattern` as a JavaScript regular expression instead of a glob.' },
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

export const fsReadToolDef = {
  name: 'fs_read',
  description:
    'Read the CONTENTS of a file on a node by ABSOLUTE path (a bounded byte slice — ' +
    'fs_list/fs_stat only show metadata). Returns the text plus size/offset/eof; page ' +
    'large files with `offset` + `maxBytes` (default 64KB, max 1MB). Binary files return ' +
    'binary:true with no text. ' +
    'SECURITY: refuses known credential/secret files — SSH keys, .env, *.pem/*.key, ' +
    'cloud + gh tokens, and lm-assist\'s own keys (~/.lm-assist, ~/.lm-oandaproxy, ' +
    '~/.claude/.credentials.json) — returning a `blocked` reason instead of the bytes. ' +
    peerNote +
    ' Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      path: { type: 'string', description: 'Absolute file path on the target node.' },
      offset: { type: 'number', description: 'Byte offset to start reading at (default 0). Use with maxBytes to page a large file.' },
      maxBytes: { type: 'number', description: 'Max bytes to return (default 65536, capped at 1048576).' },
      peerGatewayId: { type: 'string', description: 'Optional peer node to inspect (from list_nodes).' },
    },
    required: ['path'],
  },
};

export const FS_INSPECT_TOOL_DEFS = [fsDrivesToolDef, fsListToolDef, fsStatToolDef, fsReadToolDef] as const;

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
  if (typeof args.pattern === 'string' && args.pattern) body.pattern = args.pattern;
  if (args.regex === true) body.regex = true;
  if (args.peerGatewayId) body.peerGatewayId = String(args.peerGatewayId);
  if (args.refresh === true) body.refresh = true;
  try {
    const d = await workerPost<{ path: string; entries: Entry[]; truncated: boolean; total: number; matched?: number; pattern?: string }>(
      '/storage/list',
      body,
    );
    const entries = d.entries || [];
    const scope = d.pattern
      ? `${d.matched ?? entries.length} of ${d.total} matching ${d.pattern}`
      : `${d.total} item${d.total === 1 ? '' : 's'}`;
    const header = `${d.path} (${scope}${d.truncated ? `, showing ${entries.length}` : ''}):`;
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

interface ReadResp {
  path: string; exists: boolean; isFile: boolean; size: number; offset: number;
  bytesReturned: number; eof: boolean; truncated: boolean; binary: boolean;
  blocked?: string; content: string;
}

async function handleFsRead(args: Record<string, unknown>): Promise<McpToolResult> {
  const p = String(args.path || '').trim();
  if (!p) return err('path is required (absolute file path).');
  const body: Record<string, unknown> = { path: p };
  if (args.offset !== undefined && args.offset !== null) body.offset = Number(args.offset);
  if (args.maxBytes !== undefined && args.maxBytes !== null) body.maxBytes = Number(args.maxBytes);
  if (args.peerGatewayId) body.peerGatewayId = String(args.peerGatewayId);
  try {
    const r = await workerPost<ReadResp>('/storage/read', body);
    if (r.blocked) return err(`refused to read ${r.path}: ${r.blocked}`);
    if (!r.exists) return ok(`${r.path} — does not exist.`);
    if (!r.isFile) return ok(`${r.path} — not a regular file (cannot read contents).`);
    if (r.binary) return ok(`${r.path} — binary file (${r.size} bytes); contents not shown as text.`);
    const shown = r.offset + r.bytesReturned;
    const span = `bytes ${r.offset}–${shown} of ${r.size}`;
    const more = r.truncated ? `  (truncated — continue with offset=${shown})` : '';
    return ok(`${r.path} (${span}${more}):\n${r.content}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export const FS_INSPECT_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  fs_drives: handleFsDrives,
  fs_list: handleFsList,
  fs_stat: handleFsStat,
  fs_read: handleFsRead,
};
