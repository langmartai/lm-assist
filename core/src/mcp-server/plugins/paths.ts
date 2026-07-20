/** Filesystem layout for the plugin subsystem (contract §1).
 *
 *  Enable-state, grants, scratch space and the audit journal all live OUTSIDE the
 *  plugin directories, so that recording any of them can never perturb a plugin's
 *  payload checksum (which would auto-revert it to disabled). */
import * as path from 'path';
import { getDataDir, isDevRepo } from '../../utils/path-utils';

/** Same dev/prod split the rest of lm-assist uses, so a repo build and an npm
 *  install never share plugin state. */
function suffix(): string {
  return isDevRepo() ? '-dev' : '';
}

export function pluginsDir(): string {
  return path.join(getDataDir(), `mcp-plugins${suffix()}`);
}

export function pluginStateFile(): string {
  return path.join(getDataDir(), `mcp-plugin-state${suffix()}.json`);
}

export function pluginScratchRoot(): string {
  return path.join(getDataDir(), `mcp-plugin-scratch${suffix()}`);
}

export function pluginAuditFile(): string {
  return path.join(getDataDir(), `mcp-plugin-audit${suffix()}.jsonl`);
}
