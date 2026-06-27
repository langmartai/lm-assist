'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Loader2,
  Play,
  Pause,
  CheckCircle,
  Save,
  Cloud,
  Monitor,
  MessageSquare,
} from 'lucide-react';
import { MissionSessionChat } from './MissionSessionChat';
import { FullScreenOverlay, ExpandIconButton } from './FullScreenOverlay';
import { MarkdownSplitEditor } from './MarkdownSplitEditor';

/** Which large element is currently expanded full-screen (null = none). */
type ExpandTarget = 'objective' | 'plan' | 'nextSteps' | 'chat';

/** Next steps render as a bullet list in the Markdown preview. */
function nextStepsToMarkdown(v: string): string {
  return v
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `- ${s}`)
    .join('\n');
}

// ── Types (mirror MissionsPage.tsx — do not invent fields) ───────────────────

type MissionStatus = 'draft' | 'active' | 'waiting' | 'paused' | 'blocked' | 'done' | 'failed';

interface MissionBinding {
  sessionId: string | null;
  node: string | null;
  kind: 'orchestrator' | 'worker' | null;
}

/** Subset of the full Mission shape the detail view consumes. */
interface MissionDetail {
  id: string;
  title: string;
  objective: string;
  status: MissionStatus;
  plan?: string;
  nextSteps?: string[];
  binding?: MissionBinding | null;
  ownerNode?: string;
  interim?: { at: number; text: string } | null;
  control?: { waitReason?: string };
  tags?: Record<string, string[]>;
  parentId?: string | null;
  dependsOn?: string[];
}

/** Mission session row from GET /mission/:id/sessions. */
interface MissionSessionRow {
  sid: string;
  kind: 'orchestrator' | 'worker';
  role: 'primary' | 'sub';
  lastContact?: number;
}

const STATUS_BADGE: Record<MissionStatus, string> = {
  draft: 'badge-default',
  active: 'badge-green',
  waiting: 'badge-blue',
  paused: 'badge-default',
  blocked: 'badge-red',
  done: 'badge-outline',
  failed: 'badge-red',
};

// Liveness window: a session is "live" if it reported contact within ~2 min.
const LIVE_WINDOW_MS = 2 * 60 * 1000;

type ApiFetch = <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;

interface MissionDetailViewProps {
  missionId: string;
  apiFetch: ApiFetch;
  controllerSid: string | null;
  controllerNode: string | null;
  onOpenSession: (s: { sid: string; title: string; node?: string | null; missionId?: string | null }) => void;
}

// ── Editable-fields draft model ──────────────────────────────────────────────

interface Draft {
  title: string;
  objective: string;
  plan: string;
  nextSteps: string; // newline-separated; split/join to string[]
}

/** Build the canonical draft from a loaded mission (nextSteps → newline text). */
function draftFromMission(m: MissionDetail): Draft {
  return {
    title: m.title ?? '',
    objective: m.objective ?? '',
    plan: m.plan ?? '',
    nextSteps: (m.nextSteps ?? []).join('\n'),
  };
}

function draftsEqual(a: Draft, b: Draft): boolean {
  return a.title === b.title && a.objective === b.objective && a.plan === b.plan && a.nextSteps === b.nextSteps;
}

export function MissionDetailView({
  missionId,
  apiFetch,
  controllerSid,
  controllerNode,
  onOpenSession,
}: MissionDetailViewProps) {
  const [mission, setMission] = useState<MissionDetail | null>(null);
  const [sessions, setSessions] = useState<MissionSessionRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);

  // Which large element is expanded to a full-screen overlay (null = none).
  const [expanded, setExpanded] = useState<ExpandTarget | null>(null);

  // Editable draft state + the last-loaded baseline (to detect user edits).
  const [draft, setDraft] = useState<Draft | null>(null);
  const baselineRef = useRef<Draft | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Fetch mission (poll 5s) ──
  const fetchMission = useCallback(async () => {
    try {
      const res = await apiFetch<{ data?: MissionDetail } | MissionDetail>(
        `/mission/${encodeURIComponent(missionId)}`,
      );
      const m = ((res as any)?.data ?? res) as MissionDetail | null;
      if (!m || !m.id) {
        setLoadError('Mission not found');
        return;
      }
      setLoadError(null);
      setMission(m);
      // Reset drafts to the freshly-loaded values ONLY if the user hasn't edited
      // (i.e. current draft still matches the previous baseline).
      const fresh = draftFromMission(m);
      setDraft((cur) => {
        const base = baselineRef.current;
        const userEdited = cur && base && !draftsEqual(cur, base);
        baselineRef.current = fresh;
        if (cur === null || !userEdited) return fresh;
        return cur; // keep the user's in-progress edits
      });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [apiFetch, missionId]);

  // ── Fetch sessions (poll 5s) ──
  const fetchSessions = useCallback(async () => {
    try {
      const res = await apiFetch<{ sessions: MissionSessionRow[] } | { data: { sessions: MissionSessionRow[] } }>(
        `/mission/${encodeURIComponent(missionId)}/sessions`,
      );
      const list = (res as any).sessions ?? (res as any).data?.sessions ?? [];
      setSessions(list);
    } catch {
      // silently ignore — sessions list stays as-is
    }
  }, [apiFetch, missionId]);

  useEffect(() => {
    fetchMission();
    fetchSessions();
    const interval = setInterval(() => {
      fetchMission();
      fetchSessions();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchMission, fetchSessions]);

  // Cleanup the transient "saved" timer on unmount.
  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  // ── Dirty check ──
  const baseline = baselineRef.current;
  const isDirty = !!(draft && baseline && !draftsEqual(draft, baseline));

  // ── Save edited fields ──
  const saveFields = useCallback(async () => {
    if (!draft || !mission) return;
    setSaving(true);
    setSaved(false);
    try {
      const nextSteps = draft.nextSteps
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      await apiFetch(`/mission/${encodeURIComponent(mission.id)}`, {
        method: 'POST',
        body: {
          title: draft.title,
          objective: draft.objective,
          plan: draft.plan,
          nextSteps,
        },
      });
      // Baseline now matches what we saved so the next poll doesn't clobber it.
      baselineRef.current = { ...draft };
      setSaved(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaved(false), 2500);
      // Pull fresh state.
      fetchMission();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [apiFetch, draft, mission, fetchMission]);

  // ── Status actions (Pause / Resume / Done) ──
  const setStatus = useCallback(
    async (status: MissionStatus) => {
      if (!mission) return;
      setStatusBusy(true);
      try {
        await apiFetch(`/mission/${encodeURIComponent(mission.id)}`, {
          method: 'POST',
          body: { status },
        });
        fetchMission();
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        setStatusBusy(false);
      }
    },
    [apiFetch, mission, fetchMission],
  );

  // ── Loading / not-found states ──
  if (!mission && !loadError) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-tertiary)' }}>
        <Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} />
      </div>
    );
  }
  if (!mission) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-status-red)', fontSize: 13, padding: 24, textAlign: 'center' }}>
        {loadError ?? 'Mission not found'}
      </div>
    );
  }

  const d = draft ?? draftFromMission(mission);

  // Field map for the full-screen editor overlay — binds to the SAME draft setters the inline
  // textareas use, so edits made in the overlay flow back to Save / dirty-tracking unchanged.
  const fieldMap: Record<
    'objective' | 'plan' | 'nextSteps',
    { label: string; value: string; set: (v: string) => void; mono?: boolean; transform?: (v: string) => string }
  > = {
    objective: { label: 'Objective', value: d.objective, set: (v) => setDraft((p) => ({ ...(p ?? d), objective: v })) },
    plan: { label: 'Plan', value: d.plan, set: (v) => setDraft((p) => ({ ...(p ?? d), plan: v })), mono: true },
    nextSteps: { label: 'Next steps', value: d.nextSteps, set: (v) => setDraft((p) => ({ ...(p ?? d), nextSteps: v })), transform: nextStepsToMarkdown },
  };
  const expandedField = expanded && expanded !== 'chat' ? fieldMap[expanded] : null;

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        minHeight: 0,
        background: 'var(--color-bg-root)',
      }}
    >
      {/* ── Header: title + status badge ── */}
      <div
        style={{
          padding: '10px 16px',
          borderBottom: '1px solid var(--color-border-subtle)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)', flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {mission.title}
        </span>
        <span className={`badge ${STATUS_BADGE[mission.status]}`}>{mission.status}</span>
        <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)' }}>
          {mission.id}
        </span>
      </div>

      {/* Error banner */}
      {loadError && (
        <div style={{ padding: '5px 16px', fontSize: 11, color: 'var(--color-status-red)', background: 'var(--color-bg-elevated)', borderBottom: '1px solid var(--color-border-subtle)', flexShrink: 0 }}>
          {loadError}
        </div>
      )}

      {/* ── Scroll container ── */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* ── Section 1: Editable fields ── */}
        <div
          style={{
            padding: '12px 16px',
            borderBottom: '1px solid var(--color-border-subtle)',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <label style={{ fontSize: 11, color: 'var(--color-text-secondary)', display: 'flex', flexDirection: 'column', gap: 3 }}>
            Title
            <input
              className="input"
              value={d.title}
              style={{ width: '100%', fontSize: 12 }}
              onChange={(e) => setDraft((p) => ({ ...(p ?? d), title: e.target.value }))}
            />
          </label>

          <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ flex: 1 }}>Objective</span>
              <ExpandIconButton onClick={() => setExpanded('objective')} title="Expand Objective" />
            </div>
            <textarea
              className="input"
              value={d.objective}
              rows={3}
              style={{ width: '100%', resize: 'vertical', fontSize: 12 }}
              onChange={(e) => setDraft((p) => ({ ...(p ?? d), objective: e.target.value }))}
            />
          </div>

          <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ flex: 1 }}>Plan</span>
              <ExpandIconButton onClick={() => setExpanded('plan')} title="Expand Plan" />
            </div>
            <textarea
              className="input"
              value={d.plan}
              rows={4}
              placeholder="Mission plan…"
              style={{ width: '100%', resize: 'vertical', fontSize: 12, fontFamily: 'var(--font-mono)' }}
              onChange={(e) => setDraft((p) => ({ ...(p ?? d), plan: e.target.value }))}
            />
          </div>

          <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ flex: 1 }}>Next steps <span style={{ color: 'var(--color-text-tertiary)' }}>(one per line)</span></span>
              <ExpandIconButton onClick={() => setExpanded('nextSteps')} title="Expand Next steps" />
            </div>
            <textarea
              className="input"
              value={d.nextSteps}
              rows={3}
              placeholder={'First step\nSecond step'}
              style={{ width: '100%', resize: 'vertical', fontSize: 12 }}
              onChange={(e) => setDraft((p) => ({ ...(p ?? d), nextSteps: e.target.value }))}
            />
          </div>

          {(mission.tags && Object.keys(mission.tags).length > 0) || mission.parentId || (mission.dependsOn?.length ?? 0) > 0 ? (
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--color-text-secondary)' }}>
              {Object.entries(mission.tags ?? {}).map(([dim, vals]) => (
                <div key={dim} style={{ marginBottom: 2 }}><span style={{ color: dim.startsWith('ctl:') ? '#fbbf24' : 'var(--color-text-tertiary)' }}>{dim}:</span> {vals.join(', ')}</div>
              ))}
              {mission.parentId && <div>parent: {mission.parentId}</div>}
              {(mission.dependsOn?.length ?? 0) > 0 && <div>depends on: {mission.dependsOn!.join(', ')}</div>}
            </div>
          ) : null}

          {/* Save + status buttons */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <button
              className="btn btn-primary btn-sm"
              disabled={!isDirty || saving}
              onClick={saveFields}
              title="Save mission fields"
            >
              {saving ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> : <Save size={11} />}
              {' '}Save
            </button>
            {saved && (
              <span style={{ fontSize: 11, color: 'var(--color-status-green)', display: 'flex', alignItems: 'center', gap: 3 }}>
                <CheckCircle size={11} /> saved
              </span>
            )}

            <div style={{ flex: 1 }} />

            {mission.status === 'active' && (
              <button className="btn btn-ghost btn-sm" disabled={statusBusy} onClick={() => setStatus('paused')} title="Pause">
                <Pause size={11} /> Pause
              </button>
            )}
            {(mission.status === 'paused' || mission.status === 'blocked' || mission.status === 'waiting') && (
              <button className="btn btn-primary btn-sm" disabled={statusBusy} onClick={() => setStatus('active')} title="Resume">
                <Play size={11} /> Resume
              </button>
            )}
            {mission.status !== 'done' && mission.status !== 'failed' && (
              <button className="btn btn-ghost btn-sm" disabled={statusBusy} onClick={() => setStatus('done')} title="Mark done">
                <CheckCircle size={11} /> Done
              </button>
            )}
            {statusBusy && <Loader2 size={11} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-text-tertiary)' }} />}
          </div>

          {/* Interim progress / wait reason (read-only context) */}
          {mission.status === 'active' && mission.interim?.text && (
            <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontStyle: 'italic' }}>
              ⏳ working — {mission.interim.text.length > 160 ? mission.interim.text.slice(0, 160) + '…' : mission.interim.text}
            </div>
          )}
          {mission.control?.waitReason && (
            <div style={{ fontSize: 11, color: 'var(--color-status-orange)' }}>waiting: {mission.control.waitReason}</div>
          )}
        </div>

        {/* ── Section 2: Sessions (flat, always visible) ── */}
        <div
          style={{
            padding: '12px 16px',
            borderBottom: '1px solid var(--color-border-subtle)',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
            Sessions
            {sessions.length > 0 && <span className="badge badge-outline">{sessions.length}</span>}
          </div>

          {sessions.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>No sessions yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {sessions.map((s) => {
                const isCloud = /^(session_|cse_)/.test(s.sid);
                const transport: 'cloud' | 'native' = isCloud ? 'cloud' : 'native';
                const shortSid = s.sid.slice(0, 10);
                const roleLabel = s.kind === 'orchestrator' ? 'orchestrator' : 'worker';
                const isExecutor = !!mission.binding?.sessionId && s.sid === mission.binding.sessionId;
                const isLive = typeof s.lastContact === 'number' && Date.now() - s.lastContact < LIVE_WINDOW_MS;
                const title = `${roleLabel} · ${shortSid}`;
                return (
                  <button
                    key={s.sid}
                    className="btn btn-ghost btn-sm"
                    style={{ justifyContent: 'flex-start', gap: 6, fontSize: 11, textAlign: 'left' }}
                    onClick={() =>
                      onOpenSession({
                        sid: s.sid,
                        title,
                        node: mission.binding?.node ?? mission.ownerNode ?? null,
                        missionId: mission.id,
                      })
                    }
                    title={`Open ${title} in a tab`}
                  >
                    {/* Liveness dot */}
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        flexShrink: 0,
                        background: isLive ? 'var(--color-status-green)' : 'var(--color-text-tertiary)',
                      }}
                      title={isLive ? 'live' : 'idle'}
                    />
                    {/* Transport icon */}
                    {isCloud ? (
                      <Cloud size={11} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />
                    ) : (
                      <Monitor size={11} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
                    )}
                    {/* Kind badge */}
                    <span className={`badge ${s.kind === 'orchestrator' ? 'badge-blue' : 'badge-default'}`} style={{ fontSize: 9 }}>
                      {roleLabel}
                      {s.role === 'sub' ? ' · sub' : ''}
                    </span>
                    {/* Executor badge */}
                    {isExecutor && (
                      <span className="badge badge-green" style={{ fontSize: 9 }}>
                        executor
                      </span>
                    )}
                    {/* Short sid */}
                    <span style={{ flex: 1, color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {shortSid}
                    </span>
                    <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)' }}>{transport}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Section 3: Mission-scoped controller chat ── */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            minHeight: 320,
            overflow: 'hidden',
          }}
        >
          <div style={{ padding: '10px 16px 6px', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <MessageSquare size={13} style={{ color: 'var(--color-accent)' }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)' }}>Mission chat</span>
            <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>→ Mission Controller</span>
            <div style={{ flex: 1 }} />
            {controllerSid && <ExpandIconButton onClick={() => setExpanded('chat')} title="Expand Mission chat" />}
          </div>
          {controllerSid ? (
            <MissionSessionChat
              sid={controllerSid}
              node={controllerNode ?? undefined}
              apiFetch={apiFetch}
              heightFill
              missionTag={`[mission ${missionId} "${mission.title}"] `}
            />
          ) : (
            <div style={{ padding: '8px 16px 16px', fontSize: 11, color: 'var(--color-text-tertiary)' }}>
              No controller running — start the Mission Controller to chat about this mission.
            </div>
          )}
        </div>
      </div>

      {/* ── Full-screen overlay: expanded text field (editor + Markdown preview) ── */}
      {expandedField && (
        <FullScreenOverlay
          title={
            <>
              {expandedField.label} — <span style={{ color: 'var(--color-text-tertiary)', fontWeight: 400 }}>{mission.title}</span>
            </>
          }
          onClose={() => setExpanded(null)}
          headerExtra={
            <>
              <button className="btn btn-primary btn-sm" disabled={!isDirty || saving} onClick={saveFields} title="Save mission fields">
                {saving ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> : <Save size={11} />} Save
              </button>
              {saved && (
                <span style={{ fontSize: 11, color: 'var(--color-status-green)', display: 'flex', alignItems: 'center', gap: 3 }}>
                  <CheckCircle size={11} /> saved
                </span>
              )}
            </>
          }
        >
          <MarkdownSplitEditor
            value={expandedField.value}
            onChange={expandedField.set}
            previewTransform={expandedField.transform}
            mono={expandedField.mono}
          />
        </FullScreenOverlay>
      )}

      {/* ── Full-screen overlay: expanded mission chat ── */}
      {expanded === 'chat' && controllerSid && (
        <FullScreenOverlay
          title={
            <>
              Mission chat — <span style={{ color: 'var(--color-text-tertiary)', fontWeight: 400 }}>{mission.title}</span>
            </>
          }
          onClose={() => setExpanded(null)}
        >
          <MissionSessionChat
            sid={controllerSid}
            node={controllerNode ?? undefined}
            apiFetch={apiFetch}
            heightFill
            missionTag={`[mission ${missionId} "${mission.title}"] `}
          />
        </FullScreenOverlay>
      )}
    </div>
  );
}
