/**
 * Executor reaper — retire mission executor panes whose work is finished.
 *
 * Born from the 2026-07-26 measurement on 117: 32 `lmx-` panes / 113 claude
 * processes, 30 of them bound to missions already `done`, 20 at ctx:100%, idle
 * up to 263h. Nothing ever retired them — the controller flips `status='done'`
 * and returns, leaving binding and pane intact.
 *
 * The harm is not RAM: an exhausted executor cannot write its mission results
 * or process a follow-up, which is why finished missions keep showing
 * `results=0` with stale `ctl:readiness`. The record lies about state.
 *
 *   REAPS a pane only when ALL of:
 *     - it resolves to a mission that is done/failed, not onboarded, not reserved,
 *     - the pane is NOT busy (fail-closed predicate — never `derivePhase`),
 *     - the mission went terminal at least `graceMinutes` ago,
 *     - context is exhausted (>= ctxExhaustedPct) OR it has been idle >= idleMinutes,
 *     - and an INDEPENDENT re-check immediately before the kill still agrees.
 *   A pane that resolves to no mission is reported `unresolved` and NEVER reaped.
 *
 *   HARVESTS first: a done mission with no results gets one written from its merge
 *   commits, or — when there is no git provenance here — a pointer to the executor
 *   transcript. If the harvest write FAILS the reap is SKIPPED: losing the account
 *   of what happened is worse than leaking a pane.
 *
 * `dryRun` (the shipped default) reports decisions without killing anything.
 */

// ── Types ────────────────────────────────────────────────

export interface ExecutorReaperConfig {
  dryRun?: boolean;
  /** Context-exhausted threshold (percent). */
  ctxExhaustedPct?: number;
  /** A pane idle at least this long qualifies even when context is not exhausted. */
  idleMinutes?: number;
  /** Never reap a mission that went terminal more recently than this. */
  graceMinutes?: number;
  /** Blast-radius bound per run. Logged when it truncates. */
  maxReapsPerRun?: number;
}

export type ReapAction = 'reaped' | 'would-reap' | 'kept' | 'unresolved' | 'harvest-failed';

export interface ReapDecision {
  pane: string;
  missionId: string | null;
  missionStatus: string | null;
  sessionId: string | null;
  ctxPct: number | null;
  idleMinutes: number;
  ageHours: number;
  action: ReapAction;
  reason: string;
  /** What the harvest wrote (or would write), when one happened. */
  harvested?: { ref: string; commits: number } | null;
}

export interface ExecutorReaperResult {
  scanned: number;
  reaped: number;
  kept: number;
  unresolved: number;
  harvested: number;
  /** True when `maxReapsPerRun` cut the run short — never truncate silently. */
  truncated: boolean;
  decisions: ReapDecision[];
}

/** The subset of a Mission this job reads. Keeps the scheduler off the mission types. */
export interface ReaperMission {
  id: string;
  status: string;
  title?: string;
  origin?: string;
  updatedAt?: number;
  resultCount: number;
  repo?: string | null;
}

export interface PaneFacts {
  createdMs: number;
  activityMs: number;
  cwd: string | null;
}

export interface SessionFacts {
  sessionId: string | null;
  jsonl: string | null;
  connectStrategy: string | null;
}

export interface ExecutorReaperDeps {
  /** tmux session names to consider (the `lmx-` executor panes). */
  listExecutorPanes(): string[];
  paneFacts(pane: string): PaneFacts | null;
  /** Visible screen only — no scrollback. */
  capture(pane: string): string;
  sessionForPane(pane: string): SessionFacts | null;
  /** Scan-time resolve, served from one snapshot of the store. */
  missionFor(sessionId: string | null, cwd: string | null): ReaperMission | null;
  /**
   * Re-read ONE mission straight from the store for the pre-kill re-check.
   * Deliberately not the snapshot `missionFor` uses — a re-check that reads the
   * same array it already read is not an independent verdict.
   */
  refetchMission(missionId: string): Promise<ReaperMission | null>;
  /** Leader anchor: only the elected node may reap. */
  isLeader(): boolean;
  /** Guards against a sync lag reading as "every pane is an orphan". */
  missionCount(): number;
  transcriptMtimeMs(jsonl: string | null): number | null;
  /** Recover the mission's merged commits, or null when there is no git provenance. */
  harvestCommits(missionId: string, repo: string | null): { ref: string; summary: string; commits: number } | null;
  /** Write one result entry. MUST return false when the write did not land. */
  appendResult(missionId: string, entry: { ref: string; summary: string }): Promise<boolean>;
  clearBinding(missionId: string): Promise<void>;
  kill(pane: string): void;
  now(): number;
  log(line: string): void;
}

// ── Pure predicates (exported for tests) ─────────────────

/** Statuses whose executor may be retired. Mirrors `isTerminal` in mission-model. */
const TERMINAL_STATUSES = new Set(['done', 'failed']);

/** Reserved non-mission store ids that must never be treated as missions. */
const RESERVED_IDS = new Set(['__controller__', '__engagement__']);

/**
 * Is the pane actively working RIGHT NOW?
 *
 * Fail-closed and deliberately NOT `derivePhase`: that returns `idle` whenever
 * `ctx:` + `❯` are on screen, and the TUI paints `❯` *while working* (documented
 * from live observation in CLAUDE.md, cc.ts, tmux-runner.ts and ccr-manager.ts).
 * Order copied from the reference implementation at ccr-manager.ts:552-577.
 */
export function isPaneBusy(screen: string, transcriptAgeMs: number | null): boolean {
  // Queued input means CC is busy AND holds work that a kill would destroy.
  if (/press up to edit queued messages?/i.test(screen)) return true;
  if (screen.includes('esc to interrupt')) return true;
  // Running spinner: glyph + word + "… (Ns". A FINISHED turn renders
  // "✻ Cogitated for 25s" — no paren — so it cannot false-match.
  if (/[✻✶✽✢✳✺·]\s?\S+…\s*\(\d+s/.test(screen)) return true;
  if (/↓\s*\d+\s+tokens/.test(screen)) return true; // streaming counter
  // Records still flushing ⇒ the turn is live. Filesystem truth, not screen-scrape:
  // this is the only signal covering submitted-but-not-yet-painted.
  if (transcriptAgeMs != null && transcriptAgeMs < 12_000) return true;
  return false;
}

/**
 * Parse `ctx:NN%` from the pane footer.
 *
 * Takes the LAST match (the live status line is the BOTTOM one), unlike
 * `inspector.parseContextPct` which takes the first — an agent reading a capture
 * has other `ctx:` lines scrolled up its own pane.
 */
export function parseCtxPctLast(screen: string): number | null {
  const all = [...screen.matchAll(/ctx:\s*(\d{1,3})\s*%/gi)];
  if (!all.length) return null;
  const n = parseInt(all[all.length - 1][1], 10);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

export interface GateInput {
  mission: ReaperMission | null;
  busy: boolean;
  connectStrategy: string | null;
  ctxPct: number | null;
  idleMinutes: number;
  terminalAgeMinutes: number | null;
  cfg: Required<Pick<ExecutorReaperConfig, 'ctxExhaustedPct' | 'idleMinutes' | 'graceMinutes'>>;
}

/** The kill gate. Anything unknown keeps the pane. */
export function reapGate(i: GateInput): { reap: boolean; reason: string } {
  const m = i.mission;
  if (!m) return { reap: false, reason: 'no mission resolved — never reaped' };
  if (RESERVED_IDS.has(m.id)) return { reap: false, reason: 'reserved store id' };
  if (m.origin === 'onboarded') return { reap: false, reason: 'onboarded session — never killed' };
  if (!TERMINAL_STATUSES.has(m.status)) return { reap: false, reason: `mission ${m.status} — still live` };
  if (i.busy) return { reap: false, reason: 'pane is mid-turn' };
  if (i.connectStrategy === 'refuse') return { reap: false, reason: 'connectStrategy=refuse' };
  if (i.terminalAgeMinutes == null) return { reap: false, reason: 'terminal age unknown' };
  if (i.terminalAgeMinutes < i.cfg.graceMinutes) {
    return { reap: false, reason: `went terminal ${Math.round(i.terminalAgeMinutes)}m ago < grace ${i.cfg.graceMinutes}m` };
  }
  const exhausted = i.ctxPct != null && i.ctxPct >= i.cfg.ctxExhaustedPct;
  const longIdle = i.idleMinutes >= i.cfg.idleMinutes;
  if (!exhausted && !longIdle) {
    return { reap: false, reason: `ctx ${i.ctxPct ?? '?'}% < ${i.cfg.ctxExhaustedPct}% and idle ${i.idleMinutes}m < ${i.cfg.idleMinutes}m` };
  }
  return {
    reap: true,
    reason: exhausted ? `mission ${m.status} + ctx ${i.ctxPct}% exhausted` : `mission ${m.status} + idle ${i.idleMinutes}m`,
  };
}

const SUMMARY_MAX = 2000;
const REF_MAX = 500;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Build the result entry for a mission with an empty record. */
export function buildHarvestEntry(
  m: ReaperMission,
  git: { ref: string; summary: string; commits: number } | null,
  session: { sessionId: string | null; jsonl: string | null },
  pane: { name: string; ctxPct: number | null; idleMinutes: number },
): { ref: string; summary: string; commits: number } {
  const where = `pane ${pane.name} (ctx:${pane.ctxPct ?? '?'}%, idle ${pane.idleMinutes}m)`;
  if (git) {
    return {
      ref: clip(git.ref, REF_MAX),
      summary: clip(`Auto-harvested by executor-reaper on retiring ${where}. ${git.summary}`, SUMMARY_MAX),
      commits: git.commits,
    };
  }
  const sid = session.sessionId || 'unknown';
  return {
    ref: clip(`session:${sid} (no git provenance)`, REF_MAX),
    summary: clip(
      `Auto-harvested by executor-reaper on retiring ${where}. No \`merge mission/${m.id}\` found in this node's reflog — the mission never branched here, or was merged on another node. The full account is in the executor transcript: ${session.jsonl || `(session ${sid})`}`,
      SUMMARY_MAX,
    ),
    commits: 0,
  };
}

// ── The sweep ────────────────────────────────────────────

export async function runExecutorReaper(
  config: ExecutorReaperConfig = {},
  deps: ExecutorReaperDeps,
): Promise<ExecutorReaperResult> {
  const dryRun = config.dryRun !== false; // default TRUE — ships report-only
  const cfg = {
    ctxExhaustedPct: config.ctxExhaustedPct ?? 95,
    idleMinutes: config.idleMinutes ?? 120,
    graceMinutes: config.graceMinutes ?? 30,
  };
  const maxReaps = Math.max(1, config.maxReapsPerRun ?? 10);
  const decisions: ReapDecision[] = [];
  let truncated = false;

  // Leader anchor: only the elected node reaps, so two nodes never race a kill.
  if (!deps.isLeader()) {
    return { scanned: 0, reaped: 0, kept: 0, unresolved: 0, harvested: 0, truncated: false, decisions: [] };
  }
  // A sync lag that empties the mission list must not read as "every pane is an orphan".
  if (deps.missionCount() === 0) {
    deps.log('mission list empty — refusing to classify any pane (sync lag guard)');
    return { scanned: 0, reaped: 0, kept: 0, unresolved: 0, harvested: 0, truncated: false, decisions: [] };
  }

  let reapedCount = 0;
  for (const pane of deps.listExecutorPanes()) {
    if (reapedCount >= maxReaps) { truncated = true; break; }

    const facts = deps.paneFacts(pane);
    if (!facts) {
      decisions.push({ pane, missionId: null, missionStatus: null, sessionId: null, ctxPct: null, idleMinutes: 0, ageHours: 0, action: 'kept', reason: 'pane vanished mid-scan' });
      continue;
    }
    const now = deps.now();
    const idleMinutes = Math.max(0, Math.round((now - facts.activityMs) / 60_000));
    const ageHours = Math.max(0, Math.round((now - facts.createdMs) / 3_600_000));

    const sess = deps.sessionForPane(pane) || { sessionId: null, jsonl: null, connectStrategy: null };
    const mission = deps.missionFor(sess.sessionId, facts.cwd);
    const screen = deps.capture(pane);
    const ctxPct = parseCtxPctLast(screen);
    const tAge = deps.transcriptMtimeMs(sess.jsonl);
    const busy = isPaneBusy(screen, tAge == null ? null : now - tAge);
    // Explicit, not truthiness: a missing/zero/garbage `updatedAt` is an UNKNOWN
    // age, and the gate keeps the pane rather than treating epoch-0 as "ancient".
    const stamp = mission?.updatedAt;
    const terminalAgeMinutes =
      typeof stamp === 'number' && Number.isFinite(stamp) && stamp > 0
        ? Math.max(0, (now - stamp) / 60_000)
        : null;

    const base: Omit<ReapDecision, 'action' | 'reason'> = {
      pane,
      missionId: mission?.id ?? null,
      missionStatus: mission?.status ?? null,
      sessionId: sess.sessionId,
      ctxPct,
      idleMinutes,
      ageHours,
    };

    const gate = reapGate({ mission, busy, connectStrategy: sess.connectStrategy, ctxPct, idleMinutes, terminalAgeMinutes, cfg });
    if (!gate.reap) {
      decisions.push({ ...base, action: mission ? 'kept' : 'unresolved', reason: gate.reason });
      continue;
    }
    const m = mission as ReaperMission;

    // ── Harvest BEFORE the kill. A failed write cancels the reap. ──
    let harvested: { ref: string; commits: number } | null = null;
    if (m.resultCount === 0) {
      const git = deps.harvestCommits(m.id, m.repo ?? null);
      const entry = buildHarvestEntry(m, git, sess, { name: pane, ctxPct, idleMinutes });
      if (dryRun) {
        harvested = { ref: entry.ref, commits: entry.commits };
      } else {
        let ok = false;
        try { ok = await deps.appendResult(m.id, { ref: entry.ref, summary: entry.summary }); } catch { ok = false; }
        if (!ok) {
          decisions.push({ ...base, action: 'harvest-failed', reason: 'result write did not land — reap SKIPPED so the account is not lost' });
          continue;
        }
        harvested = { ref: entry.ref, commits: entry.commits };
      }
    }

    if (dryRun) {
      decisions.push({ ...base, action: 'would-reap', reason: gate.reason, harvested });
      reapedCount++;
      continue;
    }

    // ── Independent re-check immediately before the destructive step. ──
    // State can change between the scan and the kill; re-resolve rather than
    // trusting the values read above (ccr-restart.ts ordering).
    const screen2 = deps.capture(pane);
    const t2 = deps.transcriptMtimeMs(sess.jsonl);
    if (isPaneBusy(screen2, t2 == null ? null : deps.now() - t2)) {
      decisions.push({ ...base, action: 'kept', reason: 're-check found the pane busy — kill aborted', harvested });
      continue;
    }
    let m2: ReaperMission | null = null;
    try { m2 = await deps.refetchMission(m.id); } catch { m2 = null; }
    if (!m2 || !TERMINAL_STATUSES.has(m2.status) || m2.origin === 'onboarded') {
      decisions.push({ ...base, action: 'kept', reason: `re-check: mission now ${m2?.status ?? 'unresolved'} — kill aborted`, harvested });
      continue;
    }

    try {
      deps.kill(pane);
    } catch (e) {
      decisions.push({ ...base, action: 'kept', reason: `kill failed: ${(e as Error).message}`, harvested });
      continue;
    }
    try { await deps.clearBinding(m.id); } catch { /* pane is gone; a stale binding is the lesser evil */ }
    decisions.push({ ...base, action: 'reaped', reason: gate.reason, harvested });
    reapedCount++;
  }

  if (truncated) {
    deps.log(`maxReapsPerRun=${maxReaps} reached — ${deps.listExecutorPanes().length - decisions.length} pane(s) not examined this run`);
  }

  return {
    scanned: decisions.length,
    reaped: decisions.filter((d) => d.action === 'reaped').length,
    kept: decisions.filter((d) => d.action === 'kept' || d.action === 'harvest-failed').length,
    unresolved: decisions.filter((d) => d.action === 'unresolved').length,
    harvested: decisions.filter((d) => d.harvested).length,
    truncated,
    decisions,
  };
}

// ── Production wiring ────────────────────────────────────

/** Executor panes carry the `lmx-` prefix; `lmcc-` is the CONTROLLER and is never touched. */
const EXECUTOR_PREFIX = 'lmx-';

/** Field separator — tmux will not put \x1f in a session name or a path. */
const FACTS_SEP = '\x1f';

/**
 * argv to read one session's facts.
 *
 * 🔴 This must NEVER be `display-message -p -t '=NAME' '#{session_created}'`.
 * That call SEGFAULTS the tmux server, killing every Claude Code pane on the
 * host: `-t` on display-message is a target-PANE, `=` is a SESSION qualifier, so
 * the target resolves to NULL and a session-scoped format dereferences it.
 * Measured on tmux 3.2a — `dmesg` shows `tmux: server[N]: segfault at 0`, and
 * the client prints "server exited unexpectedly". It ran hourly on prod at :28
 * from a DRY-RUN sweep that was correctly reaping nothing; the damage was
 * entirely in the read.
 *
 * `list-sessions` takes a SESSION target and `-f` filters on an exact name
 * match, so it cannot mis-resolve and cannot crash. An older tmux without `-f`
 * errors out, which yields '' -> null -> the pane is KEPT: fail-safe.
 */
export function paneFactsArgv(pane: string): string[] {
  return [
    'list-sessions',
    '-f', `#{==:#{session_name},${pane}}`,
    '-F', `#{session_created}${FACTS_SEP}#{session_activity}${FACTS_SEP}#{pane_current_path}`,
  ];
}

/** Parse `paneFactsArgv` output. Empty/!created => null, which the sweep treats as KEEP. */
export function parsePaneFacts(out: string): PaneFacts | null {
  const first = (out || '').trim().split('\n')[0];
  if (!first) return null;
  const [c, a, cwd] = first.split(FACTS_SEP);
  const createdMs = (parseInt(c, 10) || 0) * 1000;
  const activityMs = (parseInt(a, 10) || 0) * 1000;
  if (!createdMs) return null;
  return { createdMs, activityMs: activityMs || createdMs, cwd: cwd || null };
}
const MISSION_CWD_RE = /worktrees\/mission-(mission_[a-z0-9]+)/;

/**
 * Recover a mission's merged commits from this node's reflog.
 *
 * `merge mission/<id>` names the merge target; the branch's commits are then
 * `sha^1..sha` for a real merge commit, or `prevReflogSha..sha` for a
 * fast-forward. Verified on 117 against four missions whose ship-shas were known
 * independently (b893bb8, 1b84922, b168bee, 419a9ea).
 */
export function harvestFromReflog(
  missionId: string,
  repo: string,
  git: (args: string[]) => string,
): { ref: string; summary: string; commits: number } | null {
  let entries: string[];
  try { entries = git(['reflog', 'main', '--format=%gs\x1f%H']).split('\n').filter(Boolean); } catch { return null; }
  const idx = entries.findIndex((l) => l.split('\x1f')[0].includes(`merge mission/${missionId}`));
  if (idx < 0) return null;
  const mergeSha = entries[idx].split('\x1f')[1];
  if (!mergeSha) return null;
  const prevSha = entries[idx + 1]?.split('\x1f')[1] ?? null;

  let parents = 0;
  try { parents = git(['rev-list', '--parents', '-n1', mergeSha]).trim().split(/\s+/).length - 1; } catch { return null; }
  const range = parents >= 2 ? `${mergeSha}^1..${mergeSha}` : prevSha ? `${prevSha}..${mergeSha}` : null;
  if (!range) return null;

  let subjects: string[] = [];
  try { subjects = git(['log', '--no-merges', '--format=%h %s', range]).split('\n').filter(Boolean); } catch { return null; }
  if (!subjects.length) return null;

  return {
    ref: `${mergeSha.slice(0, 7)} merged to main (${repo})`,
    summary: `${subjects.length} commit(s) merged from mission/${missionId}: ${subjects.join('; ')}`,
    commits: subjects.length,
  };
}

/** Journal file — dev/prod separated like every other scheduler store. */
export function reaperJournalPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getDataDir, isDevRepo } = require('../utils/path-utils');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const p = require('path');
  return p.join(getDataDir(), isDevRepo() ? 'executor-reaper-dev.json' : 'executor-reaper.json');
}

/** Append this run to the journal (keeps the last 200 entries). Never throws. */
export function journalRun(result: ExecutorReaperResult, dryRun: boolean, at: number): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    const f = reaperJournalPath();
    let prior: unknown[] = [];
    try { const raw = JSON.parse(fs.readFileSync(f, 'utf8')); if (Array.isArray(raw)) prior = raw; } catch { /* first run */ }
    // Only the acted-on decisions — a full 32-pane dump every hour buries the signal.
    const acted = result.decisions.filter((d) => d.action !== 'kept');
    prior.push({ at: new Date(at).toISOString(), dryRun, reaped: result.reaped, harvested: result.harvested, unresolved: result.unresolved, truncated: result.truncated, decisions: acted });
    const trimmed = prior.slice(-200);
    fs.writeFileSync(f + '.tmp', JSON.stringify(trimmed, null, 2), { mode: 0o600 });
    fs.renameSync(f + '.tmp', f);
  } catch { /* best effort — losing the journal must never block the sweep */ }
}

/**
 * The real production wiring. Exported so a pre-deploy validation can exercise
 * THIS function against live tmux/session/git state — a validation that rebuilds
 * its own deps is only testing the copy.
 */
export function productionDeps(missions: ReaperMission[], isLeader: boolean): ExecutorReaperDeps {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { execFileSync } = require('child_process');
  const fs = require('fs');
  const tmux = require('../terminal/tmux') as typeof import('../terminal/tmux');
  const ccs = require('../terminal/cc-sessions') as typeof import('../terminal/cc-sessions');
  const store = require('../mission/mission-store') as typeof import('../mission/mission-store');
  /* eslint-enable @typescript-eslint/no-var-requires */

  const raw = (args: string[]): string => {
    try { return execFileSync('tmux', args, { encoding: 'utf8', timeout: 10_000 }); } catch { return ''; }
  };
  const gitIn = (cwd: string) => (args: string[]): string =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30_000 });

  const byId = new Map(missions.map((m) => [m.id, m]));

  return {
    listExecutorPanes: () =>
      raw(['list-sessions', '-F', '#{session_name}']).split('\n').map((s) => s.trim())
        .filter((s) => s.startsWith(EXECUTOR_PREFIX)),
    paneFacts: (pane) => parsePaneFacts(raw(paneFactsArgv(pane))),
    // Visible screen only — no scrollback, so a scrolled-up transcript cannot
    // contribute a stale `ctx:` or a phantom busy marker.
    capture: (pane) => { try { return tmux.capture(pane, { paneQualifier: null, lines: null, start: null }); } catch { return ''; } },
    sessionForPane: (pane) => {
      try {
        const live = ccs.listLiveSessions().find((s) => s.tmuxSession === pane);
        if (!live) return { sessionId: null, jsonl: null, connectStrategy: null };
        const v = ccs.sessionVerdict(live.sessionId);
        return { sessionId: live.sessionId, jsonl: v.jsonl, connectStrategy: v.connectStrategy };
      } catch { return { sessionId: null, jsonl: null, connectStrategy: null }; }
    },
    missionFor: (sessionId, cwd) => {
      if (sessionId) {
        const hit = missions.find((m) => (m as ReaperMission & { _sid?: string })._sid === sessionId);
        if (hit) return hit;
      }
      const mid = (cwd || '').match(MISSION_CWD_RE)?.[1];
      return mid ? byId.get(mid) ?? null : null;
    },
    refetchMission: async (id) => {
      const m = await store.getMission(id);
      return m ? toReaperMission(m) : null;
    },
    isLeader: () => isLeader,
    missionCount: () => missions.length,
    transcriptMtimeMs: (jsonl) => { if (!jsonl) return null; try { return fs.statSync(jsonl).mtimeMs; } catch { return null; } },
    harvestCommits: (missionId, repo) => {
      const root = repo || null;
      if (!root || !fs.existsSync(root)) return null;
      try { return harvestFromReflog(missionId, root, gitIn(root)); } catch { return null; }
    },
    appendResult: async (missionId, entry) => {
      const m = await store.getMission(missionId);
      if (!m) return false;
      m.results = [...(m.results ?? []), { at: Date.now(), ref: entry.ref, summary: entry.summary, by: { kind: 'system', id: 'executor-reaper' } as never }];
      const saved = await store.putMission(m);
      // The write only counts if it actually landed in the record.
      return (saved.results?.length ?? 0) > 0;
    },
    clearBinding: async (missionId) => {
      const m = await store.getMission(missionId);
      if (!m) return;
      m.binding = null;
      await store.putMission(m);
    },
    kill: (pane) => { tmux.kill(pane); }, // mutex + postcondition — never a raw execFileSync
    now: () => Date.now(),
    log: (l) => console.log(`[executor-reaper] ${l}`),
  };
}

/** Project a full Mission down to what the reaper reads. */
function toReaperMission(m: {
  id: string; status: string; title?: string; origin?: string; updatedAt?: number;
  results?: unknown[]; env?: { repo?: string }; binding?: { sessionId?: string | null; ccr?: { sid?: string } } | null;
}): ReaperMission & { _sid?: string } {
  return {
    id: m.id,
    status: String(m.status || ''),
    title: m.title,
    origin: m.origin,
    updatedAt: m.updatedAt,
    resultCount: (m.results ?? []).length,
    repo: m.env?.repo ?? null,
    _sid: m.binding?.sessionId ?? m.binding?.ccr?.sid ?? undefined,
  };
}

const fmtPane = (d: ReapDecision) =>
  `${d.action}: ${d.pane} → ${d.missionId ?? '(none)'} [${d.missionStatus ?? '?'}] ctx:${d.ctxPct ?? '?'}% idle:${d.idleMinutes}m — ${d.reason}`;

export function registerExecutorReaper(jobs: {
  registerHandler: (t: string, fn: (config: Record<string, unknown>, ctx: { dryRunForced?: boolean }) => Promise<{ result: string; status?: 'ok' | 'error' | 'skipped' }>) => void;
}): void {
  jobs.registerHandler('executor-reaper', async (config, ctx) => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const store = require('../mission/mission-store') as typeof import('../mission/mission-store');
    const { amIMonitor } = require('../monitor/stall-election') as typeof import('../monitor/stall-election');
    /* eslint-enable @typescript-eslint/no-var-requires */

    const { isMonitor } = await amIMonitor().catch(() => ({ isMonitor: false }));
    const all = (await store.listMissions().catch(() => [])).map(toReaperMission);

    const num = (k: string) => (typeof config[k] === 'number' ? (config[k] as number) : undefined);
    const cfg: ExecutorReaperConfig = {
      // dryRunForced (a manual "preview this job" run) can only make it SAFER.
      dryRun: ctx.dryRunForced === true ? true : config.dryRun !== false,
      ctxExhaustedPct: num('ctxExhaustedPct'),
      idleMinutes: num('idleMinutes'),
      graceMinutes: num('graceMinutes'),
      maxReapsPerRun: num('maxReapsPerRun'),
    };

    const deps = productionDeps(all, isMonitor);
    const r = await runExecutorReaper(cfg, deps);
    journalRun(r, cfg.dryRun !== false, Date.now());

    if (!isMonitor) return { result: 'not the elected monitor — no-op', status: 'skipped' };
    const acted = r.decisions.filter((d) => d.action !== 'kept');
    const head = `${cfg.dryRun !== false ? 'DRY-RUN ' : ''}scanned=${r.scanned} ${cfg.dryRun !== false ? 'would-reap' : 'reaped'}=${r.reaped} harvested=${r.harvested} kept=${r.kept} unresolved=${r.unresolved}${r.truncated ? ' TRUNCATED' : ''}`;
    const lines = acted.slice(0, 8).map(fmtPane);
    return {
      result: `${head}${lines.length ? ' | ' + lines.join('; ') : ''}${acted.length > 8 ? ` (+${acted.length - 8} more in the journal)` : ''}`,
      status: 'ok',
    };
  });
}
