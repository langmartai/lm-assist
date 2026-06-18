/**
 * Claude Code layer on top of the GENERIC Windows terminal driver
 * (windows-terminal.ts) — the Windows analog of Linux `cc.ts` sitting on
 * `tmux.ts`. The generic driver knows nothing about Claude; this layer adds the
 * Claude-specific behaviour:
 *   - map live Claude Code sessions (cc-sessions registry) to WT windows/tabs
 *   - launch `claude` (resume / skip-permissions / remote-control) with
 *     auto-accept of the folder-trust prompt
 *   - classify Claude's on-screen state (trust prompt, questions, rate limits,
 *     server/auth errors, busy, idle) and auto-advance the actionable ones
 *
 * Other terminal apps can reuse windows-terminal.ts directly (launchWindow,
 * focusAndSend, captureScreen, closeWindow, …) without any of this.
 */

import * as os from 'os';
import { execFile } from '../utils/exec';
import { IS_WINDOWS } from '../utils/process-utils';
import { listLiveSessions, LiveSession } from './cc-sessions';
import {
  WinMapping,
  mapPidsToWindows,
  captureScreen,
  focusAndSend,
  listTabIds,
  setTabRid,
  spawnTerminal,
} from './windows-terminal';
import { classifyScreen, type ScreenState } from './cc-classify';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function samePath(a: string, b: string): boolean {
  const norm = (s: string) => (s || '').replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/** All live claude.exe pids via PowerShell Get-Process (reliable on Windows;
 *  the find-process npm pkg is flaky here). [] on non-Windows or on error. */
function listClaudePids(): Promise<number[]> {
  if (!IS_WINDOWS) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', '(Get-Process claude -ErrorAction SilentlyContinue).Id'],
      { timeout: 8000, windowsHide: true } as any,
      (_err: any, stdout: string) => {
        resolve(
          String(stdout || '')
            .split(/\r?\n/)
            .map((s) => parseInt(s.trim(), 10))
            .filter((n) => Number.isFinite(n) && n > 0),
        );
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Session listing
// ---------------------------------------------------------------------------

/** A live Claude Code session enriched with its Windows window/tab mapping. */
export interface WinLiveSession extends LiveSession {
  win: WinMapping | null;
  /** true when the session can be brought to front + driven (focus/send). */
  driveable: boolean;
  /** when not driveable, why (cross-session / no mapping) — for diagnostics. */
  reason?: string | null;
}

/** List all live Claude Code sessions on this host, enriched with window/tab mapping. */
export async function listWindowsSessions(): Promise<WinLiveSession[]> {
  const live = listLiveSessions();
  if (!IS_WINDOWS) return live.map((s) => ({ ...s, win: null, driveable: false }));
  const pids = live.map((s) => s.owner.pid);
  const maps = await mapPidsToWindows(pids);
  const byPid = new Map<number, WinMapping>(maps.map((m) => [m.pid, m]));
  return live.map((s) => {
    const win = byPid.get(s.owner.pid) ?? null;
    return {
      ...s,
      win,
      driveable: !!(win && win.driveable),
      reason: win?.reason ?? (win ? null : 'no window/tab mapping for this session'),
    };
  });
}

// ---------------------------------------------------------------------------
// Screen-state classifier + auto-handlers (Claude Code specific)
//
// On top of captureScreen: pattern-match the visible terminal text into a
// known Claude state so callers (and the create flow) can react automatically —
// most importantly auto-accepting the folder-trust prompt, but also surfacing
// questions, rate limits, server errors and auth problems instead of hanging.
// Patterns are derived from the Claude Code CLI's on-screen strings.
// ---------------------------------------------------------------------------

// Screen-state classifier lives in the shared, platform-independent cc-classify.ts
// (used by both backends). Re-exported here for the Claude (Windows) layer.
export { classifyScreen } from './cc-classify';
export type { ScreenState, ScreenClassification } from './cc-classify';

export interface AutoHandleResult {
  ok: boolean;
  pid: number;
  state: ScreenState;
  detail?: string;
  options?: string[];
  retryHint?: string;
  /** true when we sent keystrokes to advance the prompt */
  handled: boolean;
  action?: string;
  error?: string;
}

/**
 * Capture + classify a session's screen and, when actionable, advance it:
 *   - folder_trust  -> press Enter (confirms the highlighted "Yes, I trust") when trust!==false
 *   - await_question -> press the given `answer` digit (only if provided — never guesses)
 * Everything else (rate limits, server errors, auth) is reported, not actioned.
 */
export async function autoHandle(
  pid: number,
  opts: { trust?: boolean; answer?: number; rid?: string } = {},
): Promise<AutoHandleResult> {
  if (!IS_WINDOWS) return { ok: false, pid, state: 'unknown', handled: false, error: 'windows-only' };
  const cap = await captureScreen(pid);
  if (!cap.ok) return { ok: false, pid, state: 'unknown', handled: false, error: cap.error };
  const cls = classifyScreen(cap.text || '');
  const base: AutoHandleResult = { ok: true, pid, state: cls.state, detail: cls.detail, options: cls.options, retryHint: cls.retryHint, handled: false };

  if (cls.state === 'folder_trust' && opts.trust !== false) {
    const r = await focusAndSend({ pid, rid: opts.rid, keys: 'ENTER' });
    return { ...base, handled: r.ok, action: r.ok ? 'trusted-folder (Enter)' : r.error };
  }
  if (cls.state === 'await_question' && typeof opts.answer === 'number' && opts.answer >= 1 && opts.answer <= 9) {
    const r = await focusAndSend({ pid, rid: opts.rid, keys: `${opts.answer} ENTER` });
    return { ...base, handled: r.ok, action: r.ok ? `answered ${opts.answer}` : r.error };
  }
  return { ...base, action: 'observed' };
}

// ---------------------------------------------------------------------------
// Launch a Claude Code session (claude on top of the generic launcher)
// ---------------------------------------------------------------------------

export interface LaunchResult {
  launched: boolean;
  sessionId: string | null;
  win?: WinMapping | null;
  pid?: number;
  /** stable, title-independent tab handle captured at create (for robust drive) */
  tabRid?: string | null;
  /** true when a folder-trust prompt was detected and auto-accepted during launch */
  trustHandled?: boolean;
  mode: string;
  cwd: string;
  note?: string;
}

/**
 * Launch a new Claude Code session in a Windows Terminal window (default) or tab,
 * then poll the live-session registry for the newly-registered sessionId (matched
 * by cwd). Auto-accepts the folder-trust prompt by default. Returns the new
 * session + its window mapping once it registers.
 */
export async function launchSession(opts: {
  cwd?: string;
  mode?: 'window' | 'tab';
  resume?: string;
  waitMs?: number;
  skipPermissions?: boolean;
  remoteControl?: boolean | string;
  /** auto-accept the folder-trust prompt if it blocks registration (default true) */
  autoTrust?: boolean;
} = {}): Promise<LaunchResult> {
  if (!IS_WINDOWS) return { launched: false, sessionId: null, mode: '', cwd: '', note: 'windows-only' };
  const cwd = opts.cwd || os.homedir();
  const mode = opts.mode || 'window';
  const autoTrust = opts.autoTrust !== false;
  const before = new Set(listLiveSessions().map((s) => s.sessionId));
  const beforeRids = new Set((await listTabIds()).map((t) => t.rid));
  const beforeClaude = new Set(await listClaudePids());
  const skipFlag = opts.skipPermissions ? ' --dangerously-skip-permissions' : '';
  const rcFlag = opts.remoteControl ? ' --remote-control' + (typeof opts.remoteControl === 'string' ? ` ${opts.remoteControl}` : '') : '';
  const claudeCmd = (opts.resume ? `claude --resume ${opts.resume}` : 'claude') + rcFlag + skipFlag;

  // Generic launcher does the wt spawn (windowsHide:false, mode handling).
  spawnTerminal({ cwd, command: claudeCmd, mode });

  const start = Date.now();
  const deadline = start + (opts.waitMs ?? 9000);
  let sid: string | null = null;
  let pid: number | undefined;
  let trustHandled = false;
  let lastTrustTry = 0;
  while (Date.now() < deadline) {
    await sleep(400);
    for (const s of listLiveSessions()) {
      // On resume, `claude --resume <id>` briefly registers a transient session id
      // at startup before settling onto <id>; match the resumed id specifically so
      // we don't return the transient. On fresh create, take the new id by diff.
      const match = opts.resume
        ? s.sessionId === opts.resume && samePath(s.owner.cwd, cwd)
        : !before.has(s.sessionId) && samePath(s.owner.cwd, cwd);
      if (match) {
        sid = s.sessionId;
        pid = s.owner.pid;
        break;
      }
    }
    if (sid) break;

    // Auto-trust: if registration is blocked for a couple seconds, a new claude
    // is probably sitting at the folder-trust prompt (it doesn't register until
    // accepted). Find the new claude pid (reliable Get-Process, not find-process),
    // confirm it's the trust screen, inject Enter into its console buffer, then
    // keep polling for it to register. Retried across the poll until handled.
    if (autoTrust && !trustHandled && Date.now() - start > 2200 && Date.now() - lastTrustTry > 1400) {
      lastTrustTry = Date.now();
      try {
        for (const cp of await listClaudePids()) {
          if (beforeClaude.has(cp)) continue;
          const cap = await captureScreen(cp);
          if (cap.ok && classifyScreen(cap.text || '').state === 'folder_trust') {
            await focusAndSend({ pid: cp, keys: 'ENTER' });
            trustHandled = true;
            break;
          }
        }
      } catch {
        /* best effort */
      }
    }
  }

  // Capture the new tab's RuntimeId by diffing the tab set — a title-independent
  // handle so we can drive this session even while its title is still animating.
  // The new WT window can lag the registry by a few seconds, so poll for it.
  let tabRid: string | null = null;
  if (sid) {
    for (let i = 0; i < 14 && !tabRid; i++) {
      await sleep(500);
      const newTabs = (await listTabIds()).filter((t) => !beforeRids.has(t.rid));
      if (newTabs.length === 1) {
        tabRid = newTabs[0].rid;
        setTabRid(sid, tabRid);
      } else if (newTabs.length > 1) {
        break; // ambiguous (concurrent launches) — leave uncached, marker fallback
      }
    }
  }

  let win: WinMapping | null = null;
  if (pid) win = (await mapPidsToWindows([pid]))[0] ?? null;
  return {
    launched: true,
    sessionId: sid,
    pid,
    win,
    tabRid,
    trustHandled,
    mode,
    cwd,
    note: sid
      ? trustHandled
        ? 'folder-trust prompt was auto-accepted during launch'
        : undefined
      : 'launched, but no new session registered within the wait window — a folder-trust prompt may still be pending (autoTrust may have been disabled or the prompt differs); GET /terminal/windows/capture?pid=<newClaudePid> to see it',
  };
}
