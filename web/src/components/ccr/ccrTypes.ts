/** Shared types for the claude.ai/code-style CCR page. */
import type { CcrStatusInput } from '@/lib/ccr-status';

export type ApiFetch = <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;

/** Enriched cloud/bridge session from GET /ccr/cloud (mirrors core CloudSessionInfo). */
export interface CloudSessionInfo {
  sid: string;
  title: string;
  model: string;
  repo: string | null;
  branch: string | null;
  cwd: string | null;
  webUrl: string;
  createdAt: string;
  lastEventAt: string | null;
  kind: 'cloud' | 'remote';
  environmentKind: string;
  connectionStatus: string | null;
  statusBucket: string | null;
  workerStatus: string | null;
  statusCategory: string | null;
  statusDetail: string | null;
  needsAction: string | null;
  unread: boolean;
  tags: string[];
}

/** A running CCR bridge we started (GET /ccr/remote). */
export interface Remote {
  id: string;
  mode: 'load' | 'mirror' | 'connected';
  sessionId: string | null;
  webUrl: string | null;
  live?: boolean;
  strategy?: string;
}

export interface Verdict {
  live: boolean;
  allowedModes: Array<'load' | 'mirror' | 'connect'>;
  connectStrategy: 'attach-existing' | 'create-tmux' | 'refuse' | 'none';
  safeToCreateTmux: boolean;
  reason?: string;
}

/** A local Claude Code session on this node (GET /terminal/cc-sessions). */
export interface CcSession {
  sessionId: string;
  jsonl?: string;
  owner?: { cwd?: string; status?: string; kind?: string } | null;
  inTmux?: boolean;
  tmuxSession?: string;
  driveable?: boolean;
  verdict?: Verdict;
}

export interface RcController { sid: string; cse: string | null; tmux?: string; node?: string; title?: string; startedAt?: number }
export interface RcExecutor { sid: string; cse?: string | null; title?: string; missionId?: string; status?: string }
export interface RcAccountSession { sid: string; status?: string; title?: string }
export interface RcData { controller: RcController | null; executors: RcExecutor[]; accountRc: RcAccountSession[] }

/** The normalized row the unified session list renders. */
export interface CcrRow {
  key: string;
  kind: 'cloud' | 'remote' | 'local';
  /** cloud/bridge cse or session_ id, or a local session UUID. */
  id: string;
  title: string;
  repo?: string | null;
  branch?: string | null;
  model?: string | null;
  status: CcrStatusInput;
  statusDetail?: string | null;
  time?: string | null;
  webUrl?: string | null;
  unread?: boolean;
  driveable?: boolean;
  /** carried through for detail rendering + actions. */
  cloud?: CloudSessionInfo;
  local?: CcSession;
  /** the RC bridge (if this local/remote session is currently bridged). */
  remoteBridge?: Remote;
}

export type EnvChoice = 'cloud' | 'remote-control' | 'local';
