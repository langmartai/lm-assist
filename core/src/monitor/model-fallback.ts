/**
 * The auto model-fallback tick: find model-limited sessions → decide → `/model <fallback>`
 * → verify the status line moved off the limited model.
 *
 * Runs beside the auto-resume tick in the same `stall-monitor` scheduled job but shares
 * NO state with it: different detector (a model-named limit banner, never a 5xx),
 * different action (`/model X`, never `continue`), different store. A server error can
 * never trigger a model switch and a model limit can never trigger a `continue`.
 *
 * Scope mirrors auto-resume: local sessions on every node, cloud CCRs only on the single
 * elected monitor.
 */
import { decideModelSwitch, findModelSwitchConfirm, ModelFallbackConfig, ModelFamily, parseCurrentModel } from './model-limit';
import { loadModelFallbackStore, saveModelFallbackStore, localModelKey, remoteModelKey } from './model-fallback-store';
import { ModelSwitchRecord } from './model-limit';
import { getProjectSettings } from '../project-settings';
import { amIMonitor } from './stall-election';
import { coreGet } from './loopback';

/** Don't re-fire while a switch settles (the banner stays on screen either way). */
export const MODEL_SWITCH_COOLDOWN_MS = 10 * 60_000;
/** How long a switch stays in the journal that `/monitor/stalls` surfaces. */
export const MODEL_JOURNAL_TTL_MS = 7 * 24 * 60 * 60_000;
/** How long to wait before re-reading the screen to verify the switch landed. */
const VERIFY_DELAY_MS = 2_500;

export interface ModelLimitedSession {
  /** cross-platform session id */
  sessionId: string;
  /** captured screen (local) or last assistant text (remote) */
  screen: string;
  /** backend session name for the slash path; null → drive by sessionId */
  tmux?: string | null;
}

export interface ModelFallbackTickDeps {
  now: number;
  cfg: ModelFallbackConfig;
  amMonitor: () => Promise<{ isMonitor: boolean }>;
  /** Local candidates on this node. */
  findLocal: () => Promise<ModelLimitedSession[]>;
  /** Send `/model <to>` to a local session. Returns false when it couldn't be sent (busy). */
  switchLocal: (s: ModelLimitedSession, to: ModelFamily) => Promise<boolean>;
  /** Re-read a local session's screen for verification. */
  reread?: (s: ModelLimitedSession) => Promise<string>;
  /** Cloud CCR candidates (monitor node only). */
  findRemote: () => Promise<ModelLimitedSession[]>;
  switchRemote: (s: ModelLimitedSession, to: ModelFamily) => Promise<boolean>;
  remoteScan: boolean;
  load: () => Record<string, ModelSwitchRecord>;
  save: (s: Record<string, ModelSwitchRecord>) => void;
  /** Structured journal line per switch (console by default). */
  journal?: (e: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface ModelSwitchOutcome {
  key: string;
  sessionId: string;
  from: string;
  to: string;
  verified: boolean;
}

export async function runModelFallbackTick(deps: ModelFallbackTickDeps): Promise<{
  switched: ModelSwitchOutcome[];
  skipped: number;
  isMonitor: boolean;
}> {
  const store = deps.load();
  const switched: ModelSwitchOutcome[] = [];
  let skipped = 0;

  const { isMonitor } = await deps.amMonitor();

  // Detector failures are isolated per branch — a hub/cloud blip must not sink the
  // local pass (same contract as the auto-resume tick).
  let local: ModelLimitedSession[] = [];
  try { local = await deps.findLocal(); } catch { local = []; }
  let remote: ModelLimitedSession[] = [];
  if (isMonitor && deps.remoteScan) {
    try { remote = await deps.findRemote(); } catch { remote = []; }
  }

  const act = async (
    key: string,
    s: ModelLimitedSession,
    send: (to: ModelFamily) => Promise<boolean>,
    verify: ((s: ModelLimitedSession) => Promise<string>) | undefined,
  ) => {
    const decision = decideModelSwitch({
      screen: s.screen,
      cfg: deps.cfg,
      record: store[key],
      now: deps.now,
      cooldownMs: MODEL_SWITCH_COOLDOWN_MS,
    });
    if (decision.action !== 'switch' || !decision.to) {
      skipped++;
      // The record is deliberately KEPT once a session recovers: it is the switch
      // JOURNAL that `/monitor/stalls` surfaces, not just a cooldown latch. Old
      // entries age out below rather than being dropped the moment they take effect.
      return;
    }

    let sent = false;
    try {
      sent = await send(decision.to);
    } catch {
      sent = false; // busy / no driver → retry next tick, no record written
    }
    if (!sent) { skipped++; return; }

    // Verify: re-read and confirm the live model is no longer the limited one.
    let verified = false;
    if (verify) {
      try {
        await (deps.sleep ?? defaultSleep)(VERIFY_DELAY_MS);
        const after = await verify(s);
        const now = parseCurrentModel(after);
        verified = !!now && now !== decision.limitedModel;
      } catch {
        verified = false; // couldn't confirm — recorded as unverified, retried after cooldown
      }
    }

    const prev = store[key];
    store[key] = {
      switchedAt: deps.now,
      attempts: (prev?.attempts ?? 0) + 1,
      from: decision.limitedModel ?? 'unknown',
      to: decision.to,
      verified,
    };
    const outcome: ModelSwitchOutcome = {
      key,
      sessionId: s.sessionId,
      from: decision.limitedModel ?? 'unknown',
      to: decision.to,
      verified,
    };
    switched.push(outcome);
    (deps.journal ?? defaultJournal)({ at: deps.now, event: 'model-fallback-switch', ...outcome });
  };

  for (const s of local) await act(localModelKey(s.sessionId), s, (to) => deps.switchLocal(s, to), deps.reread);
  for (const s of remote) await act(remoteModelKey(s.sessionId), s, (to) => deps.switchRemote(s, to), undefined);

  // Age out journal entries so the file stays bounded across long-lived nodes.
  for (const [k, r] of Object.entries(store)) {
    if (deps.now - r.switchedAt > MODEL_JOURNAL_TTL_MS) delete store[k];
  }

  deps.save(store);
  return { switched, skipped, isMonitor };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function defaultJournal(e: Record<string, unknown>): void {
  console.log(`[model-fallback] ${JSON.stringify(e)}`);
}

// ── real deps ───────────────────────────────────────────────────────────────

/** Local candidates: every driveable CC session whose screen shows a model-limit banner. */
export async function findLocalModelLimited(): Promise<ModelLimitedSession[]> {
  const r = await coreGet('/terminal/cc-sessions');
  const list: any[] = r?.data?.sessions ?? r?.sessions ?? r?.data ?? [];
  const out: ModelLimitedSession[] = [];
  for (const s of list) {
    const sessionId = (s?.sessionId || s?.id) as string | undefined;
    if (!s || s.driveable !== true || !sessionId) continue;
    const screen = await readLocalScreen(sessionId).catch(() => '');
    // Cheap pre-filter; decideModelSwitch does the real (and only binding) judgement.
    if (!/reached\s+your/i.test(screen)) continue;
    out.push({ sessionId, screen, tmux: (s.tmuxSession as string) ?? null });
  }
  return out;
}

async function readLocalScreen(sessionId: string): Promise<string> {
  const r = await coreGet(`/terminal/cc-sessions/${encodeURIComponent(sessionId)}/screen`);
  return (r?.data?.text ?? r?.text ?? '') as string;
}

/** How long to wait for the "Switch model?" confirm dialog to render before giving up
 *  on it (a session with no cached history never shows one). */
const CONFIRM_TIMEOUT_MS = 6_000;
const CONFIRM_POLL_MS = 500;

/**
 * Send `/model <to>` to a tmux-hosted session and settle the confirm dialog.
 *
 * Uses the same idle-guarded slash path the supervisor uses for `/compact` —
 * `cc.slash` asserts idle and throws when the session is mid-turn, which callers treat
 * as "retry next tick". A conversation already cached for the current model then asks
 * to confirm; we answer only the option that both affirms AND names the target model.
 * Shared by the tick and the mission-controller guard so both behave identically.
 */
export async function sendModelSlash(
  tmuxName: string,
  to: ModelFamily,
  deps?: {
    slash?: (name: string, o: { cmd: string; args: string | null }) => Promise<void>;
    capture?: (name: string) => string;
    choose?: (name: string, n: number) => Promise<unknown>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<boolean> {
  const cc = require('../terminal/cc') as typeof import('../terminal/cc');
  const tmux = require('../terminal/tmux') as typeof import('../terminal/tmux');
  const slash = deps?.slash ?? ((n, o) => cc.slash(n, o));
  const capture = deps?.capture ?? ((n: string) => tmux.capture(n, { paneQualifier: null, lines: null, start: null }));
  const choose = deps?.choose ?? ((n: string, k: number) => cc.selectChoice(n, { n: k }));
  const sleep = deps?.sleep ?? defaultSleep;
  const now = deps?.now ?? (() => Date.now());

  await slash(tmuxName, { cmd: 'model', args: to });

  const deadline = now() + CONFIRM_TIMEOUT_MS;
  while (now() < deadline) {
    await sleep(CONFIRM_POLL_MS);
    let pane = '';
    try { pane = capture(tmuxName); } catch { break; }
    const choice = findModelSwitchConfirm(cc.parseDialogPrompt(pane), to);
    if (choice) {
      await choose(tmuxName, choice);
      return true;
    }
    // Already applied without asking (no cached history) → nothing left to confirm.
    if (new RegExp(`Set model to[^\\n]*${to}`, 'i').test(pane)) return true;
  }
  return true; // slash landed; verification is the caller's job
}

/** Local action: `/model <fallback>` on the session's backend pane. */
export async function switchLocalModel(s: ModelLimitedSession, to: ModelFamily): Promise<boolean> {
  if (!s.tmux) return false; // no backend session name → nothing to slash
  return sendModelSlash(s.tmux, to);
}

/** Cloud CCR candidates — the account's live sessions whose last assistant text carries
 *  the banner. Monitor-node only (the caller gates on election). */
export async function findRemoteModelLimited(): Promise<ModelLimitedSession[]> {
  const { cloudListAccount, cloudRead } = require('../terminal/ccr-cloud') as typeof import('../terminal/ccr-cloud');
  const { getOAuthStatus } = require('../utils/claude-oauth') as typeof import('../utils/claude-oauth');
  const st = getOAuthStatus();
  if (!st.present || st.expired) return []; // credless monitor degrades to local-only

  const sessions = await cloudListAccount();
  const out: ModelLimitedSession[] = [];
  for (const s of sessions) {
    if (/completed|stopped|failed|terminated|ended/i.test(s.status || '')) continue;
    const r = await cloudRead({ sid: s.sid, lastN: 6 }).catch(() => null);
    if (!r) continue;
    const last = [...r.messages].reverse().find((m: { role?: string }) => m.role === 'assistant');
    const screen = (last as { text?: string } | undefined)?.text || '';
    if (!/reached\s+your/i.test(screen)) continue;
    out.push({ sessionId: s.sid, screen, tmux: null });
  }
  return out;
}

/** Remote: drive `/model <to>` as a user turn — the same path the web UI types into. */
export async function switchRemoteModel(s: ModelLimitedSession, to: ModelFamily): Promise<boolean> {
  const { cloudDrive } = require('../terminal/ccr-cloud') as typeof import('../terminal/ccr-cloud');
  const r = await cloudDrive({ sid: s.sessionId, text: `/model ${to}` });
  return !!r?.delivered;
}

/** Config from project-settings, in the shape the pure decider wants. */
export function modelFallbackConfig(): ModelFallbackConfig {
  const s = getProjectSettings();
  return {
    enabled: s.autoModelFallbackEnabled,
    fallbackModel: s.autoModelFallbackModel,
    fromModels: s.autoModelFallbackFrom,
  };
}

/** Assemble the real deps and run one tick. Called by the stall-monitor job. */
export async function runModelFallbackWithRealDeps(): Promise<{ switched: ModelSwitchOutcome[]; skipped: number }> {
  const s = getProjectSettings();
  const r = await runModelFallbackTick({
    now: Date.now(),
    cfg: modelFallbackConfig(),
    amMonitor: () => amIMonitor().then((m) => ({ isMonitor: m.isMonitor })),
    findLocal: findLocalModelLimited,
    switchLocal: switchLocalModel,
    reread: (x) => readLocalScreen(x.sessionId),
    findRemote: findRemoteModelLimited,
    switchRemote: switchRemoteModel,
    remoteScan: s.autoResumeRemoteScan,
    load: loadModelFallbackStore,
    save: saveModelFallbackStore,
  });
  return { switched: r.switched, skipped: r.skipped };
}
