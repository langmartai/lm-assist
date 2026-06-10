/**
 * Windows backend — adapts the generic Windows Terminal driver
 * (windows-terminal.ts) and the Claude layer (windows-cc.ts) to the shared
 * TerminalBackend / CcController interfaces (backend.ts). The Linux counterpart
 * is tmux-backend.ts. No new behaviour lives here — it just maps the common
 * contract onto the existing functions.
 *
 * Generic backend id = a terminal-hosted pid (string). CcController is keyed by
 * the cross-platform Claude sessionId, resolved to a pid via cc-sessions.
 */

import { IS_WINDOWS } from '../utils/process-utils';
import { listLiveSessions, sessionVerdict, Verdict } from './cc-sessions';
import {
  listTerminalProcs,
  spawnTerminal,
  captureScreen,
  focusAndSend,
  closeWindow,
  getTabRid,
  forgetTabRid,
} from './windows-terminal';
import {
  listWindowsSessions,
  launchSession,
  classifyScreen,
  autoHandle as ccAutoHandle,
} from './windows-cc';
import type {
  TerminalBackend,
  TerminalRef,
  CaptureOut,
  SendKeysOpts,
  CreateOpts,
  CcController,
  CcSessionInfo,
  CcScreen,
  CcLaunchOpts,
  CcAutoHandleOut,
} from './backend';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolve a Claude sessionId to its live owner pid (null if not live here). */
function pidForSession(sessionId: string): number | null {
  const s = listLiveSessions().find((x) => x.sessionId === sessionId);
  return s ? s.owner.pid : null;
}

// ---------------------------------------------------------------------------
// Generic terminal backend (id = terminal-hosted pid as string)
// ---------------------------------------------------------------------------

export const wtTerminalBackend: TerminalBackend = {
  id: 'wt',
  available: () => IS_WINDOWS,

  async list(): Promise<TerminalRef[]> {
    const procs = await listTerminalProcs();
    return procs.map((p) => ({ id: String(p.pid), title: p.title, backend: 'wt', pid: p.pid, hostName: p.hostName }));
  },

  async create(opts: CreateOpts): Promise<TerminalRef> {
    const before = new Set((await listTerminalProcs()).map((p) => p.pid));
    spawnTerminal({ cwd: opts.cwd || process.env.USERPROFILE || '.', command: opts.command, mode: opts.mode as any });
    // poll for the new tab's top program to appear
    const deadline = Date.now() + 12000;
    let newPid = 0;
    while (Date.now() < deadline && !newPid) {
      await sleep(500);
      const now = await listTerminalProcs();
      const neu = now.filter((p) => !before.has(p.pid));
      if (neu.length === 1) newPid = neu[0].pid;
      else if (neu.length > 1) break; // ambiguous (concurrent launches)
    }
    return { id: newPid ? String(newPid) : '', title: opts.command, backend: 'wt', pid: newPid || undefined };
  },

  async capture(id: string): Promise<CaptureOut> {
    const r = await captureScreen(Number(id));
    if (!r.ok) throw new Error(r.error || 'capture failed');
    return { text: r.text || '' };
  },

  async sendKeys(id: string, opts: SendKeysOpts): Promise<void> {
    // Generic text input: paste the text (foreground-verified) + optional Enter.
    const r = await focusAndSend({ pid: Number(id), text: opts.keys, submit: opts.enter === true });
    if (!r.ok) throw new Error(r.error || 'sendKeys failed');
  },

  async close(id: string): Promise<void> {
    const r = await closeWindow(Number(id), true);
    if (!r.ok) throw new Error(r.error || 'close failed');
  },
};

// ---------------------------------------------------------------------------
// Claude Code controller (keyed by Claude sessionId)
// ---------------------------------------------------------------------------

export const wtCcController: CcController = {
  backend: 'wt',
  available: () => IS_WINDOWS,

  async list(): Promise<CcSessionInfo[]> {
    const sessions = await listWindowsSessions();
    return sessions.map((s) => ({ ...s, sessionId: s.sessionId, driveable: s.driveable }));
  },

  verdict(sessionId: string): Verdict {
    return sessionVerdict(sessionId);
  },

  async launch(opts: CcLaunchOpts): Promise<Record<string, unknown>> {
    return (await launchSession({ ...opts, mode: opts.mode as 'window' | 'tab' | undefined })) as unknown as Record<string, unknown>;
  },

  async prompt(sessionId: string, text: string, opts?: { submit?: boolean }): Promise<Record<string, unknown>> {
    const pid = pidForSession(sessionId);
    if (!pid) throw new Error(`no live session ${sessionId} on this host`);
    const r = await focusAndSend({ pid, rid: getTabRid(sessionId), text, submit: opts?.submit !== false });
    if (!r.ok) throw new Error(r.error || 'prompt failed');
    return r as unknown as Record<string, unknown>;
  },

  async screen(sessionId: string): Promise<CcScreen> {
    const pid = pidForSession(sessionId);
    if (!pid) throw new Error(`no live session ${sessionId} on this host`);
    const cap = await captureScreen(pid);
    if (!cap.ok) throw new Error(cap.error || 'capture failed');
    const cls = classifyScreen(cap.text || '');
    return { text: cap.text || '', state: cls.state, detail: cls.detail, options: cls.options, retryHint: cls.retryHint };
  },

  async autoHandle(sessionId: string, opts: { trust?: boolean; answer?: number }): Promise<CcAutoHandleOut> {
    const pid = pidForSession(sessionId);
    if (!pid) return { ok: false, sessionId, error: `no live session ${sessionId} on this host` };
    const r = await ccAutoHandle(pid, { trust: opts.trust, answer: opts.answer, rid: getTabRid(sessionId) });
    return { ...r, sessionId };
  },

  async interrupt(sessionId: string): Promise<void> {
    const pid = pidForSession(sessionId);
    if (!pid) throw new Error(`no live session ${sessionId} on this host`);
    const r = await focusAndSend({ pid, keys: 'CTRL_C' });
    if (!r.ok) throw new Error(r.error || 'interrupt failed');
  },

  async close(sessionId: string, opts?: { closeTab?: boolean }): Promise<Record<string, unknown>> {
    const pid = pidForSession(sessionId);
    if (!pid) throw new Error(`no live session ${sessionId} on this host`);
    const r = await closeWindow(pid, opts?.closeTab !== false, getTabRid(sessionId));
    if (r.ok) forgetTabRid(sessionId);
    return r as unknown as Record<string, unknown>;
  },
};
