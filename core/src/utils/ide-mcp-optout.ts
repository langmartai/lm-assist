/**
 * Persistent opt-out tracking and startup auto-activation for IDE/CLI MCP
 * integrations (`antigravity`, `gemini-cli`).
 *
 * When a supported tool/binary is detected on the node and not yet configured,
 * lm-assist activates its MCP entry by default on startup. If the operator
 * explicitly clicks Deactivate, the opt-out is persisted under `<dataDir>/ide-mcp-optout.json`
 * so subsequent restarts/upgrades do not re-enable it until manually re-activated.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDataDir } from './path-utils';

export type IdeMcpTarget = 'antigravity' | 'gemini-cli';

export function ideMcpOptOutFilePath(dataDir: string = getDataDir()): string {
  return path.join(dataDir, 'ide-mcp-optout.json');
}

export function readIdeMcpOptOuts(dataDir: string = getDataDir()): Partial<Record<IdeMcpTarget, boolean>> {
  const file = ideMcpOptOutFilePath(dataDir);
  if (!fs.existsSync(file)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Partial<Record<IdeMcpTarget, boolean>> = {};
    if (typeof (raw as Record<string, unknown>).antigravity === 'boolean') {
      out.antigravity = (raw as Record<string, unknown>).antigravity as boolean;
    }
    if (typeof (raw as Record<string, unknown>)['gemini-cli'] === 'boolean') {
      out['gemini-cli'] = (raw as Record<string, unknown>)['gemini-cli'] as boolean;
    }
    return out;
  } catch {
    return {};
  }
}

export function isIdeMcpOptedOut(target: IdeMcpTarget, dataDir: string = getDataDir()): boolean {
  return readIdeMcpOptOuts(dataDir)[target] === true;
}

export function setIdeMcpOptOut(
  target: IdeMcpTarget,
  optedOut: boolean,
  dataDir: string = getDataDir(),
): void {
  const file = ideMcpOptOutFilePath(dataDir);
  const current = readIdeMcpOptOuts(dataDir);
  if (optedOut) {
    current[target] = true;
  } else {
    delete current[target];
  }
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(current, null, 2), 'utf8');
}

export interface AutoIdeMcpTargetSpec {
  id: IdeMcpTarget;
  detected: boolean;
  installed: boolean;
  activate: () => void;
}

export function runAutoIdeMcpActivation(
  targets: AutoIdeMcpTargetSpec[],
  opts: { dataDir?: string; disabled?: boolean } = {},
): { activated: IdeMcpTarget[]; skipped: Array<{ id: IdeMcpTarget; reason: string }> } {
  const dataDir = opts.dataDir ?? getDataDir();
  const disabled = opts.disabled ?? process.env.LM_ASSIST_DISABLE_AUTO_IDE_MCP === '1';
  const activated: IdeMcpTarget[] = [];
  const skipped: Array<{ id: IdeMcpTarget; reason: string }> = [];

  if (disabled) {
    for (const t of targets) skipped.push({ id: t.id, reason: 'disabled' });
    return { activated, skipped };
  }

  for (const t of targets) {
    if (t.installed) {
      skipped.push({ id: t.id, reason: 'already_installed' });
      continue;
    }
    if (!t.detected) {
      skipped.push({ id: t.id, reason: 'not_detected' });
      continue;
    }
    if (isIdeMcpOptedOut(t.id, dataDir)) {
      skipped.push({ id: t.id, reason: 'opted_out' });
      continue;
    }
    try {
      t.activate();
      activated.push(t.id);
    } catch {
      skipped.push({ id: t.id, reason: 'activate_error' });
    }
  }

  return { activated, skipped };
}
