/**
 * Claude Code live-session registry.
 *
 * Safety primitive for remote support: Claude Code transcripts are append-only
 * with NO file lock and NO double-resume guard. Spawning a second
 * `claude --resume <sid>` while another process owns that sessionId corrupts
 * the .jsonl. This module reads the authoritative ownership state and returns a
 * verdict callers must honour before acting.
 *
 * Sources combined:
 *   (A) ~/.claude/sessions/<pid>.json  — Claude's own concurrent-session registry
 *   (B) tmux panes via ppid-chain climb — whether the owner lives inside tmux
 *   (C) ~/.claude/projects/<project>/<sid>.jsonl — transcript file location
 *
 * Linux-only for the ppid-chain climb (/proc). On non-Linux the tmux mapping is
 * skipped (inTmux=false) and verdict degrades gracefully.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from '../utils/exec';
import { isProcessAlive, IS_POSIX } from '../utils/process-utils';

const IS_LINUX = process.platform === 'linux';
const SESS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const PROJ_DIR = path.join(os.homedir(), '.claude', 'projects');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConnectStrategy = 'attach-existing' | 'create-tmux' | 'refuse' | 'none';

/** Fields from ~/.claude/sessions/<pid>.json for a live owner process. */
export interface OwnerInfo {
  pid: number;
  cwd: string;
  kind: string;
  entrypoint: string;
  status: string;
  updatedAt: string;
  version: string;
}

/** A pane entry from `tmux list-panes -a`. */
export interface TmuxPaneRef {
  session: string;
  pane: string;
  pid: number;
  cmd: string;
}

/**
 * A live Claude Code session: registry info + transcript location + tmux mapping.
 * Every entry here corresponds to a pid that is currently alive.
 */
export interface LiveSession {
  sessionId: string;
  jsonl: string | null;
  owner: OwnerInfo;
  inTmux: boolean;
  tmuxSession: string | null;
  /** pane identifier within tmuxSession, e.g. "0.0". */
  pane: string | null;
}

/**
 * Ownership verdict for a session.
 *
 * connectStrategy:
 *   attach-existing — live & in tmux  → attach that pane (NEVER create a new tmux)
 *   create-tmux     — not live        → safe to `claude --resume` as sole writer
 *   refuse          — live & NOT tmux → new tmux would double-write → corruption
 *   none            — no transcript, nothing to do
 */
export interface Verdict {
  sessionId: string;
  jsonl: string | null;
  live: boolean;
  owner: OwnerInfo | null;
  inTmux: boolean;
  tmuxSession: string | null;
  pane: string | null;
  allowedModes: string[];
  connectStrategy: ConnectStrategy;
  safeToCreateTmux: boolean;
  reason: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Read parent-PID from /proc/<pid>/stat (Linux only). */
function ppidOf(pid: number): number {
  if (!IS_LINUX) return 0;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm field is wrapped in parens and may contain spaces; find the last ')'
    const rp = stat.lastIndexOf(')');
    return parseInt(stat.slice(rp + 2).split(' ')[1], 10) || 0;
  } catch {
    return 0;
  }
}

/** Walk the ppid chain upward from pid, returning all ancestor PIDs. */
function ancestorPids(pid: number): number[] {
  const ancestors: number[] = [];
  let current = pid;
  let guard = 0;
  while (current > 1 && guard++ < 40) {
    current = ppidOf(current);
    if (current > 0) ancestors.push(current);
  }
  return ancestors;
}

/** Read ~/.claude/sessions/*.json, filter to alive pids, return map keyed by sessionId. */
function readLiveRegistry(): Map<string, { sessionId: string } & OwnerInfo> {
  const out = new Map<string, { sessionId: string } & OwnerInfo>();
  let files: string[] = [];
  try {
    files = fs.readdirSync(SESS_DIR);
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(fs.readFileSync(path.join(SESS_DIR, f), 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    const sessionId = typeof rec.sessionId === 'string' ? rec.sessionId : '';
    const pid = typeof rec.pid === 'number' ? rec.pid : 0;
    if (!sessionId || !pid || !isProcessAlive(pid)) continue;
    out.set(sessionId, {
      sessionId,
      pid,
      cwd: typeof rec.cwd === 'string' ? rec.cwd : '',
      kind: typeof rec.kind === 'string' ? rec.kind : '',
      entrypoint: typeof rec.entrypoint === 'string' ? rec.entrypoint : '',
      status: typeof rec.status === 'string' ? rec.status : '',
      updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : '',
      version: typeof rec.version === 'string' ? rec.version : '',
    });
  }
  return out;
}

/** Return all tmux panes across all sessions (empty on non-POSIX or if tmux absent). */
function listTmuxPanesRaw(): TmuxPaneRef[] {
  if (!IS_POSIX) return [];
  try {
    const fmt = '#{session_name}|#{window_index}.#{pane_index}|#{pane_pid}|#{pane_current_command}';
    const output = execFileSync('tmux', ['list-panes', '-a', '-F', fmt], {
      encoding: 'utf-8',
      timeout: 3000,
    });
    return output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [session, pane, pidStr, cmd] = line.split('|');
        return { session, pane, pid: parseInt(pidStr, 10), cmd };
      });
  } catch {
    return [];
  }
}

/** Find the tmux pane whose pane_pid is the given pid or one of its ancestors. */
function findPaneForPid(pid: number, panes: TmuxPaneRef[]): TmuxPaneRef | null {
  const pidSet = new Set([pid, ...ancestorPids(pid)]);
  return panes.find((p) => pidSet.has(p.pid)) ?? null;
}

/** Locate the transcript .jsonl for a sessionId under ~/.claude/projects/. */
function findJsonl(sessionId: string): string | null {
  try {
    for (const dir of fs.readdirSync(PROJ_DIR)) {
      const fp = path.join(PROJ_DIR, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(fp)) return fp;
    }
  } catch {
    // ignore unreadable project dirs
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List all live Claude Code sessions on this host, with tmux mapping and
 * transcript location. Returns only sessions whose owner pid is currently alive.
 */
export function listLiveSessions(): LiveSession[] {
  const registry = readLiveRegistry();
  const panes = listTmuxPanesRaw();
  const sessions: LiveSession[] = [];
  for (const [sessionId, owner] of registry) {
    const jsonl = findJsonl(sessionId);
    const pane = findPaneForPid(owner.pid, panes);
    sessions.push({
      sessionId,
      jsonl,
      owner: {
        pid: owner.pid,
        cwd: owner.cwd,
        kind: owner.kind,
        entrypoint: owner.entrypoint,
        status: owner.status,
        updatedAt: owner.updatedAt,
        version: owner.version,
      },
      inTmux: pane !== null,
      tmuxSession: pane?.session ?? null,
      pane: pane?.pane ?? null,
    });
  }
  return sessions;
}

/**
 * Return the ownership verdict for a single session.
 * Handles the cases: not live (create-tmux or none), live-in-tmux
 * (attach-existing), and live-not-in-tmux (refuse).
 */
export function sessionVerdict(sessionId: string): Verdict {
  const registry = readLiveRegistry();
  const panes = listTmuxPanesRaw();
  const owner = registry.get(sessionId);
  const jsonl = findJsonl(sessionId);

  if (!owner) {
    return {
      sessionId,
      jsonl,
      live: false,
      owner: null,
      inTmux: false,
      tmuxSession: null,
      pane: null,
      allowedModes: jsonl ? ['load', 'connect'] : ['none'],
      connectStrategy: jsonl ? 'create-tmux' : 'none',
      safeToCreateTmux: !!jsonl,
      reason: jsonl
        ? "storage unowned by any live process — safe to create a tmux `claude --resume` as sole writer"
        : 'no live process and no transcript on this host',
    };
  }

  const ownerInfo: OwnerInfo = {
    pid: owner.pid,
    cwd: owner.cwd,
    kind: owner.kind,
    entrypoint: owner.entrypoint,
    status: owner.status,
    updatedAt: owner.updatedAt,
    version: owner.version,
  };

  const pane = findPaneForPid(owner.pid, panes);

  if (pane) {
    return {
      sessionId,
      jsonl,
      live: true,
      owner: ownerInfo,
      inTmux: true,
      tmuxSession: pane.session,
      pane: pane.pane,
      allowedModes: ['load', 'mirror', 'connect'],
      connectStrategy: 'attach-existing',
      safeToCreateTmux: false,
      reason: `live in tmux '${pane.session}' pane ${pane.pane} (pid ${owner.pid}) — attach this pane for two-way; do NOT create a new tmux`,
    };
  }

  return {
    sessionId,
    jsonl,
    live: true,
    owner: ownerInfo,
    inTmux: false,
    tmuxSession: null,
    pane: null,
    allowedModes: ['load', 'mirror'],
    connectStrategy: 'refuse',
    safeToCreateTmux: false,
    reason: `live but NOT in tmux (pid ${owner.pid}, entrypoint=${owner.entrypoint}, kind=${owner.kind}). A new \`claude --resume\` would double-write ${jsonl} -> corruption. Use 'mirror' (one-way) instead.`,
  };
}
