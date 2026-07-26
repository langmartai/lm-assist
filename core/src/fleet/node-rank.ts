/**
 * Node ranking — PURE. No IO, no imports that touch the network or disk.
 *
 * Combines the OBSERVED layer (`node-facts.ts`, read live) with the LEARNED layer
 * (`node-profiles` registry, taught by LLMs) into a ranked list of placement
 * candidates, each carrying its reasons.
 *
 * 🔴 TWO CONSUMERS, DELIBERATELY ASYMMETRIC — this is the whole point of the split:
 *   • The Mission Controller (an LLM) reads the candidates AND each node's `notes`
 *     prose, reasons over it, and may override the top pick.
 *   • The starvation safety net has no LLM. It takes `candidates[0]` from a ranking
 *     computed with `includeNotes:false`, so the prose CANNOT move automated
 *     placement. Someone editing a node's notes must never silently change where
 *     unattended work lands; if a preference is meant to be binding it has to be
 *     expressed as a structured `capability`/`avoid`/`weight`.
 * `rankNodes` therefore never reads `notes` at all — it is surfaced alongside the
 * result for the LLM, not folded into the score.
 *
 * 🔴 NOTHING IS SILENTLY FILTERED. An eliminated node comes back with `blockers[]`
 * saying why, so "why not node X?" is always answerable. A bare list of survivors
 * reads as "these are all the options" when it is really "these are the ones that
 * passed checks you cannot see" — the bounded-is-not-honest lesson.
 */

/** What the work needs. Tokens are matched EXACTLY against capabilities / avoid. */
export interface Need {
  /** Required traits. A node whose `avoid` names one of these is ELIMINATED. */
  need?: string[];
  /** Absolute repo path the work must run in; a node without it is eliminated. */
  repo?: string;
  /** Branch the work will use — a node already holding it is preferred (warm worktree). */
  branch?: string;
  /** Mission id, when ranking for a mission. Its own executor never counts as a conflict. */
  missionId?: string;
  /** Resource leases the work will take (mission env.resources). */
  resources?: string[];
  /** True when the mission demands exclusivity on its resources. */
  exclusive?: boolean;
}

/** One node's live, observed state. Everything here is read fresh — never declared. */
export interface NodeFacts {
  nodeId: string;
  hostname?: string;
  platform?: string;
  online: boolean;
  /** Whether this node is in the SELECTING node's cluster. Placement is cluster-scoped. */
  inCluster: boolean;
  cluster?: string;
  /** Absolute paths of repos PRESENT on the node (not merely in use). */
  repos?: string[];
  /** Whether `repos` is an EXHAUSTIVE inventory or merely what was observed.
   *  Only an exhaustive list may eliminate a node for a missing repo: a partial
   *  list (e.g. peers, where repos are inferred from footprint sessions) proves
   *  presence but never absence, and treating it as absence would silently
   *  eliminate every node that simply had no session open in that repo. */
  reposComplete?: boolean;
  /** Branches currently checked out per repo, when known. */
  branches?: string[];
  /** Live occupancy from session_footprints: what is running here right now. */
  occupancy?: Array<{
    sessionId: string;
    repo?: string;
    branch?: string;
    /** missionId when this session is a managed mission executor, else null. */
    managed?: string | null;
    resources?: string[];
    exclusive?: boolean;
  }>;
  /** Signals that could not be collected for this node (never silently omitted). */
  degraded?: string[];
}

export interface ProfileLike {
  capabilities: string[];
  avoid: string[];
  weight: number;
  /** Present for the caller to show an LLM. NEVER read by the scorer. */
  notes?: string;
}

export interface Candidate {
  node: string;
  hostname?: string;
  /** Higher is better. Only meaningful relative to the other candidates. */
  score: number;
  /** Why this node scored as it did — always populated, for chosen and unchosen alike. */
  why: string[];
  /** Non-empty ⇒ ELIMINATED. Why it cannot take this work. */
  blockers: string[];
  /** Carried through for an LLM consumer; excluded from `score` by construction. */
  notes?: string;
  degraded?: string[];
}

export interface RankOptions {
  /** Attach each node's `notes` to its candidate for an LLM reader. Scoring is
   *  identical either way — this only controls whether the prose is CARRIED. */
  includeNotes?: boolean;
}

/** Weight of each soft signal. Kept small and explicit so a ranking can be explained
 *  in the `why[]` lines rather than being an opaque number. */
const SCORE = {
  capabilityMatch: 10,
  hasRepo: 8,
  warmBranch: 4,
  perConflict: -3,
  unmanagedConflict: -5,
} as const;

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

/**
 * Rank nodes for a piece of work. Returns EVERY node considered, best first among
 * the eligible ones; eliminated nodes sort last and carry `blockers[]`.
 *
 * Callers that want only the usable ones filter on `blockers.length === 0` — but the
 * full list is always returned so a refusal can explain itself.
 */
export function rankNodes(
  need: Need,
  facts: NodeFacts[],
  profiles: Map<string, ProfileLike>,
  opts: RankOptions = {},
): Candidate[] {
  const wanted = uniq((need.need ?? []).filter(Boolean));

  const candidates: Candidate[] = facts.map((f) => {
    const p = profiles.get(f.nodeId);
    const why: string[] = [];
    const blockers: string[] = [];
    let score = 0;

    // ── HARD gates: each one ELIMINATES, and says so. ──
    if (!f.online) blockers.push('offline');
    if (!f.inCluster) {
      // Cross-cluster placement is refused elsewhere too (checkPlacement); naming it
      // here stops an operator concluding the node is broken when it is merely
      // out of scope for THIS selector.
      blockers.push(`not in this cluster${f.cluster ? ` (it is in "${f.cluster}")` : ''}`);
    }

    const avoided = wanted.filter((n) => (p?.avoid ?? []).includes(n));
    if (avoided.length) {
      blockers.push(`profile says avoid: ${avoided.join(', ')}`);
    }

    if (need.repo) {
      const has = (f.repos ?? []).includes(need.repo);
      if (!has) {
        // Absence is only provable from an EXHAUSTIVE inventory. A partial list
        // (peers, inferred from footprints) or a degraded probe means "unknown", and
        // treating unknown as absent would eliminate the whole fleet the moment the
        // inventory degrades — failing closed on a signal that is merely missing.
        if (f.reposComplete) blockers.push(`repo ${need.repo} not present`);
        else why.push('repo presence unknown (inventory not exhaustive) — not held against it');
      } else {
        score += SCORE.hasRepo;
        why.push(`has ${need.repo}`);
      }
    }

    // Resource / exclusivity conflicts against work already running here.
    const occ = (f.occupancy ?? []).filter((o) => !need.missionId || o.managed !== need.missionId);
    const wantRes = new Set(need.resources ?? []);
    for (const o of occ) {
      const shared = (o.resources ?? []).filter((r) => wantRes.has(r));
      if (shared.length && (need.exclusive || o.exclusive)) {
        blockers.push(`exclusive resource conflict on ${shared.join(', ')} (session ${o.sessionId})`);
      }
    }

    // ── SOFT signals: shape the order among the survivors. ──
    const matched = wanted.filter((n) => (p?.capabilities ?? []).includes(n));
    if (matched.length) {
      score += SCORE.capabilityMatch * matched.length;
      why.push(`capabilities: ${matched.join(', ')}`);
    }
    const unmatched = wanted.filter((n) => !matched.includes(n) && !avoided.includes(n));
    if (unmatched.length) {
      // NOT a blocker: an unprofiled node is "nothing learned yet", not "unusable".
      why.push(`no declared capability for: ${unmatched.join(', ')}`);
    }

    if (need.branch && (f.branches ?? []).includes(need.branch)) {
      score += SCORE.warmBranch;
      why.push(`already holds branch ${need.branch}`);
    }

    if (occ.length) {
      const unmanaged = occ.filter((o) => !o.managed).length;
      score += SCORE.perConflict * occ.length + SCORE.unmanagedConflict * unmanaged;
      why.push(`${occ.length} session(s) already here${unmanaged ? `, ${unmanaged} unmanaged` : ''}`);
    }

    if (p?.weight) {
      score += p.weight;
      why.push(`profile weight ${p.weight > 0 ? '+' : ''}${p.weight}`);
    }
    if (!p) why.push('no profile yet — nothing learned about this node');

    return {
      node: f.nodeId,
      hostname: f.hostname,
      score,
      why,
      blockers,
      ...(opts.includeNotes && p?.notes ? { notes: p.notes } : {}),
      ...(f.degraded?.length ? { degraded: f.degraded } : {}),
    };
  });

  // Eligible first (best score, then stable by nodeId so ranking is deterministic —
  // an unstable order would make the safety net's pick vary run to run).
  return candidates.sort((a, b) => {
    const ae = a.blockers.length === 0 ? 0 : 1;
    const be = b.blockers.length === 0 ? 0 : 1;
    if (ae !== be) return ae - be;
    if (b.score !== a.score) return b.score - a.score;
    return a.node.localeCompare(b.node);
  });
}

/** The deterministic pick used by the starvation safety net. `notes` is excluded by
 *  construction (rankNodes never scores it), so this is a pure function of the
 *  structured fields + live facts. Returns null when nothing is eligible — the caller
 *  journals that rather than guessing. */
export function pickDeterministic(
  need: Need, facts: NodeFacts[], profiles: Map<string, ProfileLike>,
): Candidate | null {
  const ranked = rankNodes(need, facts, profiles, { includeNotes: false });
  const eligible = ranked.filter((c) => c.blockers.length === 0);
  return eligible[0] ?? null;
}
