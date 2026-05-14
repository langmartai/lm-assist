/**
 * Terminal manager — orchestrator over registry + tmux + spawn-tabs + cc.
 *
 * This is the only module routes/core/terminal.routes.ts talks to. It glues
 * the validated DTOs to the layered primitives, with audit on every mutation.
 */

import { IS_POSIX, IS_WINDOWS } from '../utils/process-utils';
import { TerminalError } from './errors';
import { withAudit } from './audit';
import * as tmux from './tmux';
import * as registry from './registry';
import { openGnomeTab, openWtSshTab } from './spawn-tabs';
import type { TabRecord, TabKind } from './types';

export interface CreateTabInput {
  kind: TabKind;
  title: string | null;
  cwd: string | null;
  command: string | null;
  tmuxSession: string | null;
  sshTarget: string | null;
  env: Record<string, string>;
  cols: number | null;
  rows: number | null;
}

export async function createTab(input: CreateTabInput, caller?: string): Promise<TabRecord> {
  return await withAudit({ op: 'createTab', session: input.tmuxSession, caller, details: { kind: input.kind } }, async () => {
    const id = registry.newTabId();
    const meta: Record<string, unknown> = {};

    if (input.kind === 'gnome') {
      if (!IS_POSIX) throw new TerminalError('PLATFORM_UNSUPPORTED', 'gnome tabs require a POSIX host');
      const res = openGnomeTab({
        title: input.title,
        cwd: input.cwd,
        command: input.command,
        tmuxSession: input.tmuxSession,
        cols: input.cols,
        rows: input.rows,
        env: input.env,
      });
      meta.pid = res.pid;
      meta.displayAvailable = res.displayAvailable;
      if (res.stderr) meta.spawnStderr = res.stderr;
    } else if (input.kind === 'wt-ssh') {
      if (!IS_WINDOWS) throw new TerminalError('PLATFORM_UNSUPPORTED', 'wt-ssh tabs require a Windows lm-assist host');
      if (!input.sshTarget) throw new TerminalError('INVALID_INPUT', 'wt-ssh requires sshTarget');
      const res = openWtSshTab({
        title: input.title,
        sshTarget: input.sshTarget,
        tmuxSession: input.tmuxSession,
        command: input.command,
      });
      meta.scheduledTask = res.scheduledTask;
      meta.batPath = res.batPath;
    } else if (input.kind === 'tmux') {
      if (!input.tmuxSession) throw new TerminalError('INVALID_INPUT', 'tmux kind requires tmuxSession');
      await tmux.create(input.tmuxSession, { cwd: input.cwd, cols: input.cols, rows: input.rows });
      if (input.command) {
        await tmux.sendKeys(input.tmuxSession, {
          keys: input.command, literal: false, enter: true, paneQualifier: null,
        });
      }
    } else {
      throw new TerminalError('INVALID_INPUT', `unsupported tab kind: ${(input as { kind: string }).kind}`);
    }

    const rec: TabRecord = {
      id,
      kind: input.kind,
      title: input.title,
      tmuxSession: input.tmuxSession,
      sshTarget: input.sshTarget,
      command: input.command,
      cwd: input.cwd,
      createdAt: new Date().toISOString(),
      meta,
    };
    await registry.put(rec);
    return rec;
  });
}

export async function deleteTab(id: string, caller?: string): Promise<{ removed: boolean; killedTmux: boolean }> {
  return await withAudit({ op: 'deleteTab', caller, details: { id } }, async () => {
    const rec = registry.get(id);
    if (!rec) throw new TerminalError('SESSION_NOT_FOUND', `tab not found: ${id}`);
    let killedTmux = false;
    if (rec.tmuxSession && IS_POSIX) {
      try {
        const res = await tmux.kill(rec.tmuxSession);
        killedTmux = res.killed;
      } catch (e) {
        if (!(e instanceof TerminalError && e.code === 'SESSION_NOT_FOUND')) throw e;
      }
    }
    await registry.remove(id);
    return { removed: true, killedTmux };
  });
}

export function listTabs(): Array<TabRecord & { alive: boolean }> {
  if (!IS_POSIX) {
    // Without tmux access we can't determine liveness; return raw registry.
    return Object.values(registry.load()).map((r) => ({ ...r, alive: true }));
  }
  return registry.listWithLiveness();
}

export function getTab(id: string): (TabRecord & { alive: boolean }) | undefined {
  const rec = registry.get(id);
  if (!rec) return undefined;
  // Lookup liveness for this single record.
  let alive = true;
  if (rec.tmuxSession && IS_POSIX) {
    try { alive = tmux.exists(rec.tmuxSession); } catch { alive = false; }
  }
  return { ...rec, alive };
}

export async function pruneDead(caller?: string): Promise<{ pruned: string[] }> {
  return await withAudit({ op: 'pruneDead', caller }, async () => {
    const pruned = await registry.pruneDead();
    return { pruned };
  });
}
