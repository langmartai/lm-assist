/**
 * Linux backend — adapts the generic tmux driver (tmux.ts) and the Claude layer
 * (cc.ts) to the shared TerminalBackend / CcController interfaces (backend.ts).
 * The Windows counterpart is wt-backend.ts. No new behaviour — it maps the
 * common contract onto the existing tmux/cc functions.
 *
 * Generic backend id = a tmux session name. CcController is keyed by the
 * cross-platform Claude sessionId, resolved to its tmux session via cc-sessions.
 */

import { IS_WINDOWS } from '../utils/process-utils';
import { listLiveSessions, sessionVerdict, Verdict } from './cc-sessions';
import * as tmux from './tmux';
import * as cc from './cc';
import { classifyScreen } from './cc-classify';
import { TerminalError } from './errors';
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

const IS_LINUX = !IS_WINDOWS;
const genName = (p: string) => `${p}-${Date.now().toString(36)}`;

/** Resolve a Claude sessionId to its tmux session name (throws if not in tmux). */
function tmuxFor(sessionId: string): string {
  const v = sessionVerdict(sessionId);
  if (!v.tmuxSession) {
    throw new TerminalError('SESSION_NOT_FOUND', `session ${sessionId} is not in a tmux pane (${v.connectStrategy})`);
  }
  return v.tmuxSession;
}

// ---------------------------------------------------------------------------
// Generic terminal backend (id = tmux session name)
// ---------------------------------------------------------------------------

export const tmuxTerminalBackend: TerminalBackend = {
  id: 'tmux',
  available: () => IS_LINUX,

  async list(): Promise<TerminalRef[]> {
    // tmux.list() stashes the session name on each record (the type omits it).
    return tmux.list().map((s) => {
      const name = (s as { name?: string }).name || '';
      return { id: name, title: name, backend: 'tmux', ...s };
    });
  },

  async create(opts: CreateOpts): Promise<TerminalRef> {
    const name = opts.name || genName('lmt');
    await tmux.create(name, { cwd: opts.cwd ?? null, cols: 200, rows: 50 });
    if (opts.command) {
      await tmux.sendKeys(name, { keys: opts.command, literal: true, enter: true, paneQualifier: null });
    }
    return { id: name, title: name, backend: 'tmux' };
  },

  async capture(id: string): Promise<CaptureOut> {
    return { text: tmux.capture(id, { paneQualifier: null, lines: null, start: null }) };
  },

  async sendKeys(id: string, opts: SendKeysOpts): Promise<void> {
    await tmux.sendKeys(id, { keys: opts.keys, literal: opts.literal !== false, enter: opts.enter === true, paneQualifier: null });
  },

  async close(id: string): Promise<void> {
    await tmux.kill(id);
  },
};

// ---------------------------------------------------------------------------
// Claude Code controller (keyed by Claude sessionId; bridged to tmux name)
// ---------------------------------------------------------------------------

export const tmuxCcController: CcController = {
  backend: 'tmux',
  available: () => IS_LINUX,

  async list(): Promise<CcSessionInfo[]> {
    return listLiveSessions().map((s) => ({
      ...s,
      sessionId: s.sessionId,
      driveable: s.inTmux, // can drive via tmux send-keys when in a pane
    }));
  },

  verdict(sessionId: string): Verdict {
    return sessionVerdict(sessionId);
  },

  async launch(opts: CcLaunchOpts): Promise<Record<string, unknown>> {
    const name = genName(opts.tmuxPrefix || 'lmcc');
    const res = await cc.launch(name, {
      cwd: opts.cwd || process.env.HOME || '.',
      model: null,
      extraFlags: opts.resume ? ['--resume', opts.resume] : [],
      skipPermissions: opts.skipPermissions ?? true,
      remoteControl: opts.remoteControl === true,
      cols: 200,
      rows: 50,
      readyPattern: 'ctx:',
      readyTimeoutMs: opts.waitMs ?? 30000,
      autoAcceptTrust: opts.autoTrust !== false,
      appendSystemPromptFile: opts.appendSystemPromptFile,
      mcpConfigPath: opts.mcpConfigPath,
      name: opts.name,
    } as any);
    // Give the session a proper customTitle: `-n` sets the account/terminal title
    // but not the local customTitle the sessions UI shows, so run `/rename` once
    // the TUI is ready + idle (readyPattern 'ctx:' matched above, before any prompt).
    // Best-effort: a rename failure must never fail the launch.
    if (opts.renameTo) {
      const clean = opts.renameTo.replace(/[\r\n]/g, ' ').trim().slice(0, 60);
      if (clean) {
        try { await cc.slash(name, { cmd: 'rename', args: clean }); }
        catch (e) { console.debug(`[tmux-backend] rename to "${clean}" failed (non-fatal): ${(e as Error).message}`); }
      }
    }
    // Correlate the new tmux session to its registered Claude sessionId.
    const live = listLiveSessions().find((s) => s.tmuxSession === name);
    return {
      launched: true,
      sessionId: live?.sessionId ?? null,
      tmuxSession: name,
      pid: live?.owner.pid,
      trustHandled: (res as { trustPromptHandled?: boolean }).trustPromptHandled,
      ...res,
    };
  },

  async prompt(sessionId: string, text: string, _opts?: { submit?: boolean }): Promise<Record<string, unknown>> {
    await cc.prompt(tmuxFor(sessionId), { text, allowNewlines: true });
    return { ok: true, sessionId };
  },

  async screen(sessionId: string): Promise<CcScreen> {
    const text = tmux.capture(tmuxFor(sessionId), { paneQualifier: null, lines: null, start: null });
    const cls = classifyScreen(text);
    return { text, state: cls.state, detail: cls.detail, options: cls.options, retryHint: cls.retryHint };
  },

  async autoHandle(sessionId: string, opts: { trust?: boolean; answer?: number }): Promise<CcAutoHandleOut> {
    const name = tmuxFor(sessionId);
    const cls = classifyScreen(tmux.capture(name, { paneQualifier: null, lines: null, start: null }));
    if (cls.state === 'folder_trust' && opts.trust !== false) {
      await cc.acceptDialog(name); // Enter on the default option ("Yes, I trust")
      return { ok: true, sessionId, state: cls.state, handled: true, action: 'trusted-folder (Enter)' };
    }
    if (cls.state === 'await_question' && typeof opts.answer === 'number' && opts.answer >= 1 && opts.answer <= 9) {
      await cc.selectChoice(name, { n: opts.answer });
      return { ok: true, sessionId, state: cls.state, handled: true, action: `answered ${opts.answer}` };
    }
    return { ok: true, sessionId, state: cls.state, detail: cls.detail, options: cls.options, retryHint: cls.retryHint, handled: false, action: 'observed' };
  },

  async interrupt(sessionId: string): Promise<void> {
    await cc.interrupt(tmuxFor(sessionId));
  },

  async close(sessionId: string, _opts?: { closeTab?: boolean }): Promise<Record<string, unknown>> {
    // On Linux "closing" a CC session = killing its tmux session.
    const name = tmuxFor(sessionId);
    const r = await tmux.kill(name);
    return { ok: r.killed, sessionId, tmuxSession: name, ...r };
  },
};
