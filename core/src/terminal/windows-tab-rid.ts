/**
 * Windows Terminal tab RuntimeId cache — the pure part (no Windows dependency).
 *
 * A tab's UIA RuntimeId is the title-independent handle the driver needs to reach a
 * session whose console title is animating (a BUSY Claude Code session rewrites its title
 * every frame). The driver learns it by diffing the tab set at launch — but until
 * 2026-09-05 that knowledge lived only in the launching Core's memory. After a Core restart
 * every send fell back to the engine's marker path (write a marker into the console title,
 * poll ~2.5 s for a tab showing it), which a busy session defeats: measured on 107 right after
 * the 0.2.2 upgrade — the first drive to the idle Mission Control controller worked, the next
 * one (controller busy) failed with "could not locate window/tab". Three such failures in a row
 * relaunch the controller, which is a slower version of the loop the liveness fix had closed.
 *
 * Three remedies, all here or wired from here:
 *   1. PERSIST the sessionId → rid map (windows-terminal.ts writes `wt-tab-rids.json`).
 *   2. RELEARN a missing rid from the live tab set: the ONE tab whose normalized name equals
 *      the pid's normalized console title — never a guess (any ambiguity → no rid, and the
 *      engine keeps its marker fallback).
 *   3. REMEMBER a handle the mission supervisor already holds in its controller record when it
 *      adopts a controller after a restart (`rememberTerminal`).
 */

export interface TabIdLike { rid: string; name: string }
/** `title` is the engine's ALREADY-normalized console title (`procs` action). */
export interface TerminalProcLike { pid: number; title: string }

/**
 * The engine's `Normalize-Title`: drop the leading token (the spinner glyph while busy) and
 * trim. Applied to a raw UIA tab name so it compares equal to an engine-normalized title.
 */
export function normalizeTabTitle(t: string | null | undefined): string {
  if (!t) return '';
  return t.replace(/^\s*\S+\s+/, '').trim();
}

/**
 * The rid of the ONE tab that shows `pid`'s title. Null when the pid is unknown, its title is
 * empty, another process shares the title, or more than one tab matches — a wrong tab would
 * paste a prompt into someone else's session, so ambiguity always loses.
 */
export function pickTabRidForPid(tabs: readonly TabIdLike[], procs: readonly TerminalProcLike[], pid: number): string | null {
  const me = procs.find((p) => p.pid === pid);
  const title = (me?.title ?? '').trim();
  if (!title) return null;
  if (procs.some((p) => p.pid !== pid && (p.title ?? '').trim() === title)) return null;
  const hits = tabs.filter((t) => normalizeTabTitle(t.name) === title);
  return hits.length === 1 ? hits[0].rid : null;
}

/** A dotted UIA RuntimeId (e.g. `42.7933118.4.10118`) — not a bare pid, not a tmux name. */
export function looksLikeTabRid(handle: string | null | undefined): boolean {
  return typeof handle === 'string' && /^\d+(\.\d+){2,}$/.test(handle.trim());
}

/** The on-disk map: `{ "<sessionId>": "<rid>" }`. Anything unreadable parses to empty. */
export function parseTabRidFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const obj = JSON.parse(text) as unknown;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (typeof v === 'string' && v) out.set(k, v);
      }
    }
  } catch { /* unreadable → empty */ }
  return out;
}

export function renderTabRidFile(map: ReadonlyMap<string, string>): string {
  return JSON.stringify(Object.fromEntries(map), null, 2) + '\n';
}

export interface TabRidCache {
  get(key: string): string | undefined;
  set(key: string, rid: string): void;
}

export interface TabProbes {
  listTabs(): Promise<readonly TabIdLike[]>;
  listProcs(): Promise<readonly TerminalProcLike[]>;
}

/**
 * The rid for `sessionId`: cached if known, else relearned from the live tab set and cached.
 * `undefined` means "no title-independent handle" — the caller sends by pid and the engine's
 * marker path takes over. Never throws.
 */
export async function resolveTabRid(sessionId: string, pid: number | null, cache: TabRidCache, probes: TabProbes): Promise<string | undefined> {
  const cached = cache.get(sessionId);
  if (cached) return cached;
  if (!pid) return undefined;
  try {
    const [tabs, procs] = await Promise.all([probes.listTabs(), probes.listProcs()]);
    const rid = pickTabRidForPid(tabs, procs, pid);
    if (!rid) return undefined;
    cache.set(sessionId, rid);
    return rid;
  } catch {
    return undefined;
  }
}
