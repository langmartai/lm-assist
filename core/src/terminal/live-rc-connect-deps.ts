// Wires the real I/O for ensureRemoteControlled. Surface-specific resumeDead /
// bindCse / isConnected are passed in by each caller (mission vs ccr).
import { execFileSync } from 'child_process';
import {
  type EnsureDeps, type CloudSession, type InjectTarget,
  killOwner as killOwnerPrim, injectRemoteControl, clearInjectedInput, pollForCloudConnection,
} from './live-rc-connect';
import { sessionVerdict } from './cc-sessions';
import { isProcessAlive } from '../utils/process-utils';
import { cloudListAccount } from './ccr-cloud';

const IS_WINDOWS = process.platform === 'win32';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function tmuxTargetOf(v: { tmuxSession: string | null; pane: string | null }): string | null {
  if (!v.tmuxSession) return null;
  return v.pane ? `${v.tmuxSession}:${v.pane}` : v.tmuxSession;
}

async function listCloud(): Promise<CloudSession[]> {
  try {
    const ss = await cloudListAccount(50);
    return ss.map((s) => ({ sid: s.sid, status: s.status, title: s.title }));
  } catch { return []; }
}

export function buildEnsureDeps(args: {
  resumeDead: (sid: string) => Promise<{ ok: boolean; cse?: string; error?: string }>;
  bindCse?: (sid: string, cse: string) => Promise<void>;
  isConnected?: (sid: string, title?: string) => Promise<boolean>;
}): EnsureDeps {
  const injectExec = {
    tmuxSend: (target: string, keys: string, literal: boolean, enter: boolean) => {
      const a = ['send-keys', '-t', target];
      if (literal) a.push('-l');
      a.push(keys);
      execFileSync('tmux', a, { encoding: 'utf-8', timeout: 5000 });
      if (enter) execFileSync('tmux', ['send-keys', '-t', target, 'Enter'], { encoding: 'utf-8', timeout: 5000 });
    },
    windowsSend: async (pid: number, opts: { text?: string; keys?: string; submit?: boolean }) => {
      const { focusAndSend } = require('./windows-terminal') as typeof import('./windows-terminal');
      return focusAndSend({ pid, ...opts });
    },
  };

  return {
    now: () => Date.now(),
    verdict: (sid) => {
      const v = sessionVerdict(sid);
      return {
        live: v.live, inTmux: v.inTmux, connectStrategy: v.connectStrategy,
        tmuxTarget: tmuxTargetOf(v), pid: v.owner?.pid ?? null, updatedAt: v.owner?.updatedAt,
      };
    },
    isWindows: IS_WINDOWS,
    windowsDriveable: async (pid) => {
      try {
        const { listWindowsSessions } = require('./windows-cc') as typeof import('./windows-cc');
        const list = await listWindowsSessions();
        return list.some((s: any) => s?.win?.pid === pid && s.driveable) || list.some((s: any) => s.owner?.pid === pid && s.driveable);
      } catch { return false; }
    },
    isConnected: args.isConnected ?? (async () => false),
    listCloud,
    inject: (target: InjectTarget) => injectRemoteControl(target, injectExec),
    clearInput: (target: InjectTarget) => clearInjectedInput(target, injectExec),
    pollConnection: (excludeSids, title) =>
      pollForCloudConnection({ title, excludeSids }, listCloud, { timeoutMs: 20000, intervalMs: 1500, sleep }),
    killOwner: async (pid) => {
      const r = await killOwnerPrim(pid, { isWindows: IS_WINDOWS }, {
        // zombie-aware (see isProcessAlive): a defunct owner is DEAD, not "still live"
        isAlive: (p) => isProcessAlive(p),
        signal: (p, sig) => process.kill(p, sig),
        taskkill: (p) => { execFileSync('taskkill', ['/PID', String(p), '/T', '/F'], { encoding: 'utf-8', timeout: 8000 }); },
        sleep,
      });
      return { killed: r.killed };
    },
    resumeDead: args.resumeDead,
    verifyDriveable: args.isConnected ?? (async () => true),
    bindCse: args.bindCse ?? (async () => {}),
  };
}
