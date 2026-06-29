export interface GitState {
  branch: string | null;
  worktree: string | null;
  upstream: string | null;
  ahead: number;
  dirty: number;
  pushed: boolean;
}

export interface SessionFootprint {
  cluster: string;
  node: string;
  host: string;
  sessionId: string;
  title?: string;
  transport: 'native' | 'cloud';
  managed: string | null;       // missionId if bound, else null
  cwd: string;
  repo: string | null;
  git: GitState;
  openChanges: string[];
  openChangesTruncated: boolean;
  lastActiveRel: string;
  isActive: boolean;
}

export interface PortHold {
  port: number;
  proto: 'tcp' | 'udp';
  pid: number | null;
  proc: string | null;
}

export interface NodeFootprint {
  node: string;
  cluster: string;
  host: string;
  snapshotAgeSec: number;
  reachable: boolean;
  warming: boolean;
  stale: boolean;
  sessions: SessionFootprint[];
  ports: PortHold[];
}

export interface ComposedFootprints {
  generatedAt: number;
  scope: 'cluster' | 'fleet';
  nodes: NodeFootprint[];
  unreachable: string[];
  partial: boolean;
}
