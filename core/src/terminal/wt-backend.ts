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
import { composerHolds } from './windows-submit-verify';
import { planCcRestart, safeToResume } from './cc-restart';
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
import { CC_NAV_KEYS } from './backend';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolve a Claude sessionId to its live owner pid (null if not live here). */
function pidForSession(sessionId: string): number | null {
  const s = listLiveSessions().find((x) => x.sessionId === sessionId);
  return s ? s.owner.pid : null;
}

/**
 * Is this pid still running? `null` = could not tell.
 *
 * The restart gate treats `null` as "still alive", so an unknown must stay
 * distinguishable from a confirmed death — never collapse it to a boolean.
 */
function pidAlive(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false; // definitively gone
    if (code === 'EPERM') return true;  // exists, not ours to signal
    return null;                        // anything else: unknown, so treat as alive
  }
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
      else if (neu.length > 1) {
        // Ambiguous under concurrent churn — best-effort: the most recently
        // started new terminal proc (highest pid is a decent proxy).
        newPid = neu.map((p) => p.pid).sort((a, b) => b - a)[0];
        break;
      }
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

  /**
   * Kill a live session and resume its transcript in a fresh window.
   *
   * The load-bearing step is the liveness poll between the two: a resume must not
   * start until the old pid is OBSERVED gone, or two processes end up writing one
   * JSONL. `close()` returning ok is not that proof.
   */
  async restart(sessionId: string, opts?: { force?: boolean }): Promise<Record<string, unknown>> {
    const v = sessionVerdict(sessionId);
    const pid = pidForSession(sessionId);
    const cwd = v.owner?.cwd ?? null;
    let busy = false;
    if (pid) {
      const cap = await captureScreen(pid);
      busy = cap.ok && classifyScreen(cap.text || '').state === 'busy';
    }

    const plan = planCcRestart({
      live: !!pid, busy, force: opts?.force === true,
      hasTranscript: !!v.jsonl, cwd,
    });
    if (plan.action === 'refuse') return { ok: false, sessionId, refused: true, reason: plan.reason };

    if (pid) {
      await closeWindow(pid, true, getTabRid(sessionId));
      forgetTabRid(sessionId);
      // Poll for actual death — never trust the kill's own report.
      let alive: boolean | null = null;
      for (let i = 0; i < 20; i++) {
        await sleep(300);
        alive = pidAlive(pid);
        if (alive === false) break;
      }
      const gate = safeToResume(alive);
      if (!gate.ok) return { ok: false, sessionId, refused: true, reason: gate.reason, oldPid: pid };
    }

    const launched = await launchSession({ cwd: cwd!, resume: sessionId, mode: 'window' });
    const newSid = (launched as { sessionId?: string | null }).sessionId ?? null;
    return {
      ok: !!newSid,
      sessionId,
      resumed: newSid,
      oldPid: pid,
      newPid: (launched as { pid?: number | null }).pid ?? null,
      reason: plan.reason,
      ...(newSid ? {} : { note: 'the old session was terminated but the resume did not register — check for a folder-trust prompt' }),
    };
  },

  async prompt(sessionId: string, text: string, opts?: { submit?: boolean; keys?: string[] }): Promise<Record<string, unknown>> {
    const pid = pidForSession(sessionId);
    if (!pid) throw new Error(`no live session ${sessionId} on this host`);

    // Keys path (Escape / arrows / Tab — the dialog+menu gap). Additive: the
    // text-only path below is unchanged. Order: text (pasted, unsubmitted) →
    // keys → Enter if submit. All via the focus-free WriteConsoleInput token
    // path, so it drives a background window without stealing foreground.
    const wtKeys = (opts?.keys ?? []).map((k) => CC_NAV_KEYS[k].wt);
    if (wtKeys.length > 0) {
      if (text) {
        const rt = await focusAndSend({ pid, rid: getTabRid(sessionId), text, submit: false });
        if (!rt.ok) throw new Error(rt.error || 'text paste failed');
      }
      const rk = await focusAndSend({ pid, rid: getTabRid(sessionId), keys: wtKeys.join(' ') });
      if (!rk.ok) throw new Error(rk.error || 'key send failed');
      if (opts?.submit) {
        const re = await focusAndSend({ pid, keys: 'ENTER' });
        if (!re.ok) throw new Error(re.error || 'submit failed');
      }
      return { ok: true, sessionId, keys: opts?.keys, submitted: opts?.submit === true };
    }

    const wantSubmit = opts?.submit !== false;
    // Paste the text only. The Enter that used to ride along here was a
    // `SendKeys("{ENTER}")` fired 150ms after a clipboard paste, and it did not
    // land — measured on DESKTOP-GDKLATG: text in the composer, session idle,
    // and `submitted: true` reported anyway.
    const r = await focusAndSend({ pid, rid: getTabRid(sessionId), text, submit: false });
    if (!r.ok) throw new Error(r.error || 'prompt failed');
    if (!wantSubmit) return { ...r, submitted: false } as unknown as Record<string, unknown>;

    // Submit through the focus-free console-input path (WriteConsoleInput), which
    // does not depend on the window holding foreground, then VERIFY by looking at
    // the composer. `submitted` is observed, never an echo of the request.
    let submitted = false;
    let attempts = 0;
    for (; attempts < 2 && !submitted; attempts++) {
      await focusAndSend({ pid, keys: 'ENTER' });
      await sleep(700);
      const cap = await captureScreen(pid);
      submitted = cap.ok ? !composerHolds(cap.text || '', text) : false;
    }
    return {
      ...r,
      submitted,
      submitAttempts: attempts,
      ...(submitted ? {} : {
        note: 'text reached the composer but Enter did not submit it — the prompt is '
          + 'still pending in the session. Nothing was sent to the model.',
      }),
    } as unknown as Record<string, unknown>;
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
