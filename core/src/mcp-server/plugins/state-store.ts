/** Enable-state + capability grants for plugins.
 *
 *  This file holds SECRETS (the owner-supplied values for a manifest's declared env
 *  names), so it is written 0600 and lives outside every plugin directory. It is
 *  node-local: enabling third-party code execution is never a fleet-synced decision. */
import * as fs from 'fs';
import * as path from 'path';
import { pluginStateFile } from './paths';
import type { PluginState } from './model';

type StateFile = Record<string, PluginState>;

const DEFAULT_STATE: PluginState = { enabled: false };

export function readAllState(file: string = pluginStateFile()): StateFile {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as StateFile;
  } catch {
    return {};   // absent or hand-mangled => everything is simply disabled (fail closed)
  }
}

export function readState(name: string, file: string = pluginStateFile()): PluginState {
  return { ...DEFAULT_STATE, ...(readAllState(file)[name] ?? {}) };
}

/** Merge `patch` into one plugin's state and persist atomically at 0600. */
export function writeState(name: string, patch: Partial<PluginState>, file: string = pluginStateFile()): PluginState {
  const all = readAllState(file);
  const next: PluginState = { ...DEFAULT_STATE, ...(all[name] ?? {}), ...patch };
  all[name] = next;
  persist(all, file);
  return next;
}

export function deleteState(name: string, file: string = pluginStateFile()): void {
  const all = readAllState(file);
  if (!(name in all)) return;
  delete all[name];
  persist(all, file);
}

function persist(all: StateFile, file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    try { fs.copyFileSync(file, `${file}.bak`); } catch { /* best effort */ }
  }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* enforce 0600 even if pre-existing looser */ }
  try { if (fs.existsSync(`${file}.bak`)) fs.chmodSync(`${file}.bak`, 0o600); } catch { /* best effort */ }
}
