/** Manifest validator — the runtime enforcement of docs/mcp-plugin.schema.json plus
 *  the semantic rules a JSON Schema cannot express (private-network declarations,
 *  reserved env names, data-dir escapes, the composed-name budget).
 *
 *  Hand-written rather than schema-driven so every refusal carries a precise reason
 *  and so validation pulls no extra runtime dependency. Kept deliberately in lockstep
 *  with the published schema: __tests__/mcp-plugin-manifest.test.ts asserts the same
 *  hostile-input matrix that was proved at contract-publication time. */
import * as path from 'path';
import { getDataDir } from '../../utils/path-utils';
import {
  MAX_PLUGIN_NAME, MAX_TOOL_NAME, PLUGIN_LIMITS, REGISTRY_NAME_RE, RESERVED_ENV, SEGMENT_RE,
  composeToolName, type PluginManifest, type PluginToolDef,
} from './model';

export type ManifestValidation =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; errors: string[] };

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const CHECKSUM_RE = /^sha256:[a-f0-9]{64}$/;
const ENTRY_ARG_RE = /^(?!.*\.\.)(?:--[a-z0-9][a-z0-9-]*(?:=[A-Za-z0-9._:/-]+)?|[A-Za-z0-9._][A-Za-z0-9._/-]*)$/;
const NETWORK_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$/;
const FS_RE = /^(?:<pluginDir>|<scratchDir>|\/(?!.*\.\.)[^:\0]*)(?::(?:ro|rw))?$/;
const ENV_RE = /^[A-Z][A-Z0-9_]*$/;

const TOP_LEVEL_KEYS = new Set([
  '$schema', 'manifestVersion', 'name', 'version', 'description', 'author', 'homepage',
  'entry', 'tools', 'capabilities', 'keepWarm', 'timeoutMs', 'checksum',
]);
const TOOL_KEYS = new Set(['name', 'description', 'inputSchema', 'annotations']);
const CAPABILITY_KEYS = new Set(['network', 'fs', 'env']);

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** IPv4 ranges a plugin may never target: they are routes into the local host, the
 *  private fleet, or cloud metadata — i.e. a way to turn plugin credentials into an
 *  SSRF handle on lm-assist itself. */
function forbiddenIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, Number(m[2]), Number(m[3]), Number(m[4])].some((n) => n > 255)) return true; // malformed => refuse
  if (a === 0 || a === 127) return true;                       // this-host / loopback
  if (a === 10) return true;                                   // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true;            // RFC1918
  if (a === 192 && b === 168) return true;                     // RFC1918
  if (a === 169 && b === 254) return true;                     // link-local + cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true;           // CGNAT
  if (a === 192 && b === 0) return true;                       // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true;         // benchmarking
  if (a >= 224) return true;                                   // multicast / reserved / broadcast
  return false;
}

function forbiddenHostname(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === 'metadata.google.internal' || h.endsWith('.internal')) return true;
  if (h === 'broadcasthost') return true;
  return forbiddenIpv4(h);
}

function validateTool(raw: unknown, index: number, pluginName: string, errors: string[]): PluginToolDef | null {
  if (!isObj(raw)) { errors.push(`tools[${index}] must be an object`); return null; }
  for (const k of Object.keys(raw)) {
    if (!TOOL_KEYS.has(k)) errors.push(`tools[${index}] has unknown field "${k}"`);
  }
  const { name, description, inputSchema, annotations } = raw as Record<string, unknown>;

  if (typeof name !== 'string' || !SEGMENT_RE.test(name)) {
    errors.push(`tools[${index}].name must match ${SEGMENT_RE} (lowercase, single _ or - separators, no "__")`);
  } else if (name.length > MAX_TOOL_NAME) {
    errors.push(`tools[${index}].name exceeds ${MAX_TOOL_NAME} characters`);
  } else {
    const composed = composeToolName(pluginName, name);
    if (!REGISTRY_NAME_RE.test(composed)) {
      errors.push(`composed name "${composed}" (${composed.length} chars) breaks the 64-character tool-registry budget`);
    }
  }
  if (typeof description !== 'string' || description.length < 1 || description.length > 1024) {
    errors.push(`tools[${index}].description must be a string of 1..1024 characters`);
  }
  if (!isObj(inputSchema)) {
    errors.push(`tools[${index}].inputSchema is required and must be a JSON Schema object`);
  } else if ((inputSchema as { type?: unknown }).type !== 'object') {
    errors.push(`tools[${index}].inputSchema.type must be "object" (MCP requirement)`);
  }
  if (annotations !== undefined && !isObj(annotations)) {
    errors.push(`tools[${index}].annotations must be an object`);
  }
  if (errors.length) return null;
  return { name: name as string, description: description as string, inputSchema: inputSchema as Record<string, unknown>, ...(annotations ? { annotations: annotations as Record<string, unknown> } : {}) };
}

function validateCapabilities(raw: unknown, errors: string[], dataDir: string): PluginManifest['capabilities'] {
  if (raw === undefined) return { network: [], fs: [], env: [] };
  if (!isObj(raw)) { errors.push('capabilities must be an object'); return { network: [], fs: [], env: [] }; }
  for (const k of Object.keys(raw)) {
    if (!CAPABILITY_KEYS.has(k)) errors.push(`capabilities has unknown kind "${k}" (only network, fs, env exist)`);
  }
  const arr = (key: 'network' | 'fs' | 'env'): string[] => {
    const v = (raw as Record<string, unknown>)[key];
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      errors.push(`capabilities.${key} must be an array of strings`);
      return [];
    }
    return v as string[];
  };

  const network = arr('network');
  for (const entry of network) {
    if (!NETWORK_RE.test(entry)) {
      errors.push(`capabilities.network entry "${entry}" is not host[:port] (no scheme, no path, no IPv6 literal)`);
      continue;
    }
    const host = entry.split(':')[0].replace(/^\*\./, '');
    if (forbiddenHostname(host)) {
      errors.push(`capabilities.network entry "${entry}" targets loopback/private/link-local/metadata address space — a plugin may not declare a route into the local fleet`);
    }
  }

  const fsEntries = arr('fs');
  for (const entry of fsEntries) {
    if (!FS_RE.test(entry)) {
      errors.push(`capabilities.fs entry "${entry}" must be <pluginDir>, <scratchDir> or an absolute path, optionally suffixed :ro or :rw`);
      continue;
    }
    const p = entry.replace(/:(ro|rw)$/, '');
    if (p.startsWith('/')) {
      const resolved = path.resolve(p);
      if (resolved === dataDir || resolved.startsWith(dataDir + path.sep)) {
        errors.push(`capabilities.fs entry "${entry}" points inside the lm-assist data directory (credentials/state) — always refused`);
      }
    }
  }

  const env = arr('env');
  for (const name of env) {
    if (!ENV_RE.test(name)) {
      errors.push(`capabilities.env entry "${name}" must match ${ENV_RE}`);
      continue;
    }
    if (RESERVED_ENV.has(name) || name.startsWith('LM_')) {
      errors.push(`capabilities.env entry "${name}" is reserved (it would override the injected base environment or inject code)`);
    }
  }

  return { network, fs: fsEntries, env };
}

/**
 * Validate a parsed `mcp-plugin.json`.
 *
 * `opts.dirName` — when given, the manifest name must equal the directory name
 * (contract §1); the loader always passes it.
 */
export function validateManifest(
  raw: unknown,
  opts: { dirName?: string; dataDir?: string } = {},
): ManifestValidation {
  const errors: string[] = [];
  const dataDir = path.resolve(opts.dataDir ?? getDataDir());

  if (!isObj(raw)) return { ok: false, errors: ['manifest must be a JSON object'] };

  for (const k of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(k)) {
      errors.push(`unknown top-level field "${k}" (the manifest is a closed schema — no side-channel directives)`);
    }
  }

  if (raw.manifestVersion !== 1) {
    errors.push('manifestVersion must be exactly 1 (unknown versions are rejected, never guessed)');
  }

  const name = raw.name;
  if (typeof name !== 'string' || !SEGMENT_RE.test(name)) {
    errors.push(`name must match ${SEGMENT_RE} (lowercase, single _ or - separators, no "__")`);
  } else if (name.length > MAX_PLUGIN_NAME) {
    errors.push(`name exceeds ${MAX_PLUGIN_NAME} characters`);
  } else if (opts.dirName !== undefined && opts.dirName !== name) {
    errors.push(`manifest name "${name}" does not match its directory name "${opts.dirName}"`);
  }

  if (typeof raw.version !== 'string' || !SEMVER_RE.test(raw.version)) errors.push('version must be semver');
  if (typeof raw.description !== 'string' || raw.description.length < 1 || raw.description.length > 300) {
    errors.push('description must be a string of 1..300 characters');
  }
  if (typeof raw.author !== 'string' || raw.author.length < 1 || raw.author.length > 120) {
    errors.push('author must be a string of 1..120 characters');
  }
  if (raw.homepage !== undefined && (typeof raw.homepage !== 'string' || raw.homepage.length > 300)) {
    errors.push('homepage must be a string of at most 300 characters');
  }

  // entry — structured on purpose: a shell string would be an injection surface.
  const entry = raw.entry;
  if (!isObj(entry)) {
    errors.push('entry must be an object {command, args} — a shell command string is never accepted');
  } else {
    for (const k of Object.keys(entry)) {
      if (k !== 'command' && k !== 'args') errors.push(`entry has unknown field "${k}"`);
    }
    if (entry.command !== 'node') {
      errors.push('entry.command must be "node" (the only interpreter on the v1 allow-list)');
    }
    const args = entry.args;
    if (!Array.isArray(args) || args.length < 1 || args.length > 16) {
      errors.push('entry.args must be an array of 1..16 strings');
    } else {
      args.forEach((a, i) => {
        if (typeof a !== 'string' || a.length > 200 || !ENTRY_ARG_RE.test(a)) {
          errors.push(`entry.args[${i}] must be a plugin-relative path or a --flag: no absolute path, no "..", no shell metacharacters`);
        }
      });
    }
  }

  // tools
  const tools: PluginToolDef[] = [];
  const pluginName = typeof name === 'string' ? name : 'plugin';
  if (!Array.isArray(raw.tools) || raw.tools.length < 1) {
    errors.push('tools must be a non-empty array');
  } else if (raw.tools.length > 64) {
    errors.push('tools may declare at most 64 entries');
  } else {
    const seen = new Set<string>();
    raw.tools.forEach((t, i) => {
      const parsed = validateTool(t, i, pluginName, errors);
      if (parsed) {
        if (seen.has(parsed.name)) errors.push(`duplicate tool name "${parsed.name}"`);
        seen.add(parsed.name);
        tools.push(parsed);
      }
    });
  }

  const capabilities = validateCapabilities(raw.capabilities, errors, dataDir);

  if (raw.keepWarm !== undefined && typeof raw.keepWarm !== 'boolean') errors.push('keepWarm must be a boolean');
  if (raw.timeoutMs !== undefined) {
    const t = raw.timeoutMs;
    if (typeof t !== 'number' || !Number.isInteger(t) || t < 1000 || t > PLUGIN_LIMITS.maxTimeoutMs) {
      errors.push(`timeoutMs must be an integer between 1000 and ${PLUGIN_LIMITS.maxTimeoutMs}`);
    }
  }
  if (typeof raw.checksum !== 'string' || !CHECKSUM_RE.test(raw.checksum)) {
    errors.push('checksum must be "sha256:<64 hex chars>"');
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    manifest: {
      manifestVersion: 1,
      name: name as string,
      version: raw.version as string,
      description: raw.description as string,
      author: raw.author as string,
      ...(raw.homepage ? { homepage: raw.homepage as string } : {}),
      entry: { command: 'node', args: (entry as { args: string[] }).args },
      tools,
      capabilities,
      ...(raw.keepWarm !== undefined ? { keepWarm: raw.keepWarm as boolean } : {}),
      ...(raw.timeoutMs !== undefined ? { timeoutMs: raw.timeoutMs as number } : {}),
      checksum: raw.checksum as string,
    },
  };
}
