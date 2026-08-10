/**
 * Status heartbeat + screenshot upload for pluggable UI pages.
 *
 * The gateway persists per-UI serving status (ui_page_status) so management surfaces
 * answer without this node online — but a stored "serving" is only trustworthy while
 * fresh, so this module PUSHES the local probe on an interval (heartbeat). The gateway
 * derives OFFLINE from staleness: if this node stops reporting (crash, network, reboot),
 * its pages read offline within the staleness window, no cleanup required.
 */

import * as fs from 'fs';
import { listReportableUis, statusOf, gatewayUiRef, rememberAddressing } from './manager';
import { gatewayCall, resolvedGatewayUrl, uiIdError, readUiAddress } from './gateway-client';
import { getHubConfig, loadServicePorts } from '../hub-client/hub-config';

export const HEARTBEAT_MS = 120_000;

export async function reportStatusesOnce(log: (m: string) => void = () => {}): Promise<number> {
  const ports = loadServicePorts();
  const uiWebPort = ports.uiWebPort ?? null;
  if (!uiWebPort) return 0;
  const hub = getHubConfig();
  let sent = 0;
  // Reportable, not running: a host-mode server is one process serving many UIs, and the
  // gateway keys status per registered UI. See listReportableUis.
  for (const s of listReportableUis()) {
    try {
      const st = await statusOf(s, uiWebPort);
      // The path routes take a bare uiId (resolved inside our own namespace) or the uiKey;
      // send the uiKey once we know it, since it names the row without that resolution step.
      const r = await gatewayCall('PUT', `/registry/uis/${encodeURIComponent(gatewayUiRef(s.uiId))}/status`, {
        workerId: hub.gatewayId || undefined,
        alive: st.alive, serving: st.serving, reachable: st.reachableViaHub, port: st.port,
        // dir + autoStart ride the heartbeat so the platform surfaces can show WHERE the
        // UI's files live and whether a reboot brings it back — without asking the node.
        detail: { dir: st.dir, autoStart: st.autoStart, ...(st.issue ? { issue: st.issue } : {}) },
      });
      // 404 = serving locally but not registered — nothing to report against; not an error.
      if (r.status < 300) sent++;
      else if (r.status !== 404) log(`[ui-pages] status report for ${s.uiId} refused (${r.status})`);
    } catch (e) {
      log(`[ui-pages] status report failed: ${e instanceof Error ? e.message : String(e)}`);
      break; // gateway unreachable — the rest will fail identically this round
    }
  }
  return sent;
}

let timer: NodeJS.Timeout | null = null;

export function startStatusHeartbeat(log: (m: string) => void = () => {}): void {
  if (timer) return;
  const kick = () => { reportStatusesOnce(log).catch(() => {}); };
  kick(); // first report immediately (right after boot/respawn)
  timer = setInterval(kick, HEARTBEAT_MS);
  timer.unref?.(); // never keep the process alive for the heartbeat
  log(`[ui-pages] status heartbeat started (every ${HEARTBEAT_MS / 1000}s → ${resolvedGatewayUrl() || 'unresolved gateway'})`);
}

export function stopStatusHeartbeat(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

/** Declarative sync of MANAGED UIs: every app under the apps root whose
 *  lmui.config.json carries `"managed": true` is (re-)registered on the gateway
 *  verbatim from the file. Disk is the source of truth — the gateway refuses runtime
 *  PATCH/DELETE on managed entries, and this boot sync heals any drift. lm-assist's
 *  own UIs (ui-apps/) ship with the flag; user UIs omit it and stay API-managed. */
export async function syncManagedUis(log: (m: string) => void = () => {}): Promise<number> {
  const path = await import('path');
  const os = await import('os');
  const appsRoot = process.env.LMUI_APPS_DIR || path.join(os.homedir(), '.lmui', 'apps');
  let names: string[] = [];
  try { names = fs.readdirSync(appsRoot); } catch { return 0; }
  const hub = getHubConfig();
  if (!hub.gatewayId || !hub.apiKey) return 0;
  let synced = 0;
  for (const n of names) {
    let cfg: { uiId?: string; name?: string; scope?: string; service?: string; grant?: unknown; managed?: boolean };
    try { cfg = JSON.parse(fs.readFileSync(path.join(appsRoot, n, 'lmui.config.json'), 'utf8')); } catch { continue; }
    if (cfg.managed !== true || !cfg.uiId) continue;
    const bad = uiIdError(cfg.uiId);
    if (bad) { log(`[ui-pages] managed sync of ${appsRoot}/${n} skipped: ${bad}`); continue; }
    try {
      const r = await gatewayCall('POST', '/registry/uis', {
        uiId: cfg.uiId, name: cfg.name || cfg.uiId, scope: cfg.scope || 'lm-assist', access: 'owner',
        grant: cfg.grant, source: 'worker', workerId: hub.gatewayId,
        service: cfg.service || `ui-${cfg.uiId}`, artifactDir: cfg.uiId, managed: true,
      });
      if (r.status < 300) {
        synced++;
        rememberAddressing(cfg.uiId, readUiAddress(r.data));
        log(`[ui-pages] managed sync: ${cfg.uiId} asserted from ${appsRoot}/${n}`);
      }
      else log(`[ui-pages] managed sync of ${cfg.uiId} refused (${r.status}): ${JSON.stringify(r.data)}`);
    } catch (e) {
      log(`[ui-pages] managed sync failed: ${e instanceof Error ? e.message : String(e)}`);
      break;
    }
  }
  return synced;
}

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/** Upload a local screenshot file for one of this user's UIs. The gateway resizes
 *  oversized captures server-side (≤1280px wide, webp) — send the original freely. */
export async function uploadScreenshot(uiId: string, filePath: string): Promise<{ status: number; data: unknown }> {
  const ext = (filePath.match(/\.[a-z]+$/i)?.[0] || '').toLowerCase();
  const type = IMAGE_TYPES[ext];
  if (!type) throw new Error(`unsupported image type "${ext}" — png/jpg/webp`);
  const body = fs.readFileSync(filePath);
  if (body.length > 12 * 1024 * 1024) throw new Error('image exceeds 12MB');
  const { getHubConfig: cfg } = await import('../hub-client/hub-config');
  const hub = cfg();
  if (!hub.apiKey) throw new Error('no API key in hub config');
  const base = resolvedGatewayUrl();
  if (!base) throw new Error('cannot resolve ui-gateway URL');
  const r = await fetch(`${base}/registry/uis/${encodeURIComponent(gatewayUiRef(uiId))}/screenshot`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${hub.apiKey}`, 'content-type': type },
    body,
  });
  let data: unknown = null;
  try { data = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, data };
}
