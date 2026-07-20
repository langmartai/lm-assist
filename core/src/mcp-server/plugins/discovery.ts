/** Plugin discovery + the pin (contract §1, §2; design §Security 1/2).
 *
 *  THE LOAD-BEARING PROPERTY OF THIS FILE: discovery is not execution. Everything
 *  here reads and hashes files. Nothing spawns a process, and nothing in a plugin's
 *  payload is ever loaded into this process — a dropped-in plugin is inert until an
 *  owner enables it at the console. */
import * as fs from 'fs';
import * as path from 'path';
import { MANIFEST_FILENAME, type PluginManifest, type PluginPhase, type PluginState } from './model';
import { validateManifest } from './manifest';
import { manifestDigest, payloadChecksum } from './checksum';
import { pluginStateFile, pluginsDir } from './paths';
import { readState, writeState } from './state-store';

export interface PluginRecord {
  name: string;
  dir: string;
  manifest: PluginManifest | null;
  manifestErrors: string[];
  payloadChecksum: string | null;
  manifestDigest: string | null;
  state: PluginState;
  effective: { phase: PluginPhase; reason?: string };
}

export interface DiscoveryOptions {
  dir?: string;
  stateFile?: string;
}

/**
 * Decide whether a plugin may run — PURE and FAIL-CLOSED.
 *
 * Anything unexpected (no manifest, nothing pinned, a pin that does not match, an
 * active quarantine) resolves to a phase that cannot execute. Enabling is the only
 * path to `enabled`, and it stays valid only while both pins still match.
 */
export function effectivePhase(rec: Omit<PluginRecord, 'effective'>): { phase: PluginPhase; reason?: string } {
  if (!rec.manifest || rec.manifestErrors.length > 0) {
    return { phase: 'invalid', reason: rec.manifestErrors[0] ?? 'manifest could not be validated' };
  }
  const st = rec.state;
  if (!st.enabled) {
    return { phase: 'disabled', ...(st.revertedReason ? { reason: st.revertedReason } : {}) };
  }
  if (!st.approvedPayloadChecksum || !st.approvedManifestDigest) {
    return { phase: 'disabled', reason: 'enabled without a recorded approval pin — re-enable at the console' };
  }
  if (rec.payloadChecksum !== st.approvedPayloadChecksum) {
    return { phase: 'disabled', reason: 'payload checksum changed since approval — re-approve to re-enable' };
  }
  if (rec.manifestDigest !== st.approvedManifestDigest) {
    return { phase: 'disabled', reason: 'manifest changed since approval — re-approve to re-enable' };
  }
  const q = st.health?.quarantinedUntil ?? 0;
  if (q > Date.now()) {
    return { phase: 'unhealthy', reason: st.health?.lastError ?? 'quarantined after repeated failures' };
  }
  return { phase: 'enabled' };
}

function readOne(dir: string, name: string, stateFile: string): PluginRecord {
  const manifestPath = path.join(dir, MANIFEST_FILENAME);
  const state = readState(name, stateFile);
  let manifest: PluginManifest | null = null;
  let manifestErrors: string[] = [];
  let digest: string | null = null;
  let checksum: string | null = null;

  let rawParsed: unknown = null;
  try {
    rawParsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    manifestErrors = [`${MANIFEST_FILENAME} is missing or not valid JSON: ${(e as Error).message}`];
  }

  if (rawParsed !== null) {
    // Digest the manifest AS WRITTEN: any edit (capabilities, tools, entry) must move
    // it, so an approved plugin can never silently widen its own declared access.
    try { digest = manifestDigest(rawParsed as Record<string, unknown>); } catch { digest = null; }
    const v = validateManifest(rawParsed, { dirName: name });
    if (v.ok) manifest = v.manifest; else manifestErrors = v.errors;
  }

  // Hashing the payload also rejects symlinks/special files — a tree we cannot pin
  // is a tree we refuse to run.
  try {
    checksum = payloadChecksum(dir);
  } catch (e) {
    checksum = null;
    manifestErrors = [...manifestErrors, `payload cannot be pinned: ${(e as Error).message}`];
  }

  const base = { name, dir, manifest, manifestErrors, payloadChecksum: checksum, manifestDigest: digest, state };
  return { ...base, effective: effectivePhase(base) };
}

/**
 * Scan the plugins directory. Never throws: a malformed or hostile plugin becomes an
 * `invalid` record for human review rather than an error that hides its neighbours.
 *
 * Side effect by design: when an approved pin no longer matches, the stored `enabled`
 * flag is flipped to false (the contracted auto-revert) so the state on disk agrees
 * with the fail-closed decision and re-approval is explicit.
 */
export function discoverPlugins(opts: DiscoveryOptions = {}): PluginRecord[] {
  const root = opts.dir ?? pluginsDir();
  const stateFile = opts.stateFile ?? pluginStateFile();

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];   // no plugins directory yet => nothing installed
  }

  const out: PluginRecord[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;                     // loose files are not plugins
    const dir = path.join(root, e.name);
    if (!fs.existsSync(path.join(dir, MANIFEST_FILENAME))) continue;
    let rec: PluginRecord;
    try {
      rec = readOne(dir, e.name, stateFile);
    } catch (err) {
      const base = {
        name: e.name, dir, manifest: null,
        manifestErrors: [`could not read plugin: ${(err as Error).message}`],
        payloadChecksum: null, manifestDigest: null, state: readState(e.name, stateFile),
      };
      rec = { ...base, effective: effectivePhase(base) };
    }

    // Persist the auto-revert so the UI and the on-disk state tell the same story.
    if (rec.state.enabled && rec.effective.phase === 'disabled') {
      try {
        rec.state = writeState(e.name, { enabled: false, revertedReason: rec.effective.reason }, stateFile);
      } catch { /* the fail-closed decision already stands regardless */ }
    }
    out.push(rec);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function findPlugin(name: string, opts: DiscoveryOptions = {}): PluginRecord | null {
  return discoverPlugins(opts).find((p) => p.name === name) ?? null;
}
