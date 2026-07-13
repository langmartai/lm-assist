/** Pure workflow-registry model: doc type, invariant preamble, render, validation. No IO. */
import type { MissionActor } from './mission-model';

export type WorkflowEditPolicy = 'open' | 'human-only';

export interface WorkflowChange {
  rev: number;
  at: number;
  actor: MissionActor;
  /** What changed, per field (body diffs are summarized as byte lengths — full bodies live in the snapshot dataset). */
  changes: Record<string, { from: unknown; to: unknown }>;
}

export interface WorkflowDoc {
  id: string;                       // dot-namespaced: 'onboard.analyze', 'controller.pass', ...
  title: string;
  body: string;                     // markdown playbook — agent-interpreted
  editPolicy: WorkflowEditPolicy;   // 'open' ⇒ controller self-edit allowed
  rev: number;                      // monotonic
  history: WorkflowChange[];        // inline recent-N (missionHistoryInlineCap)
  createdBy: MissionActor;
  lastUpdatedBy: MissionActor;
  createdAt: number;
  updatedAt: number;
}

export const MAX_WORKFLOW_BODY_BYTES = 65536;

/**
 * Non-editable invariants — ALWAYS prepended by renderWorkflowText, never stored,
 * never editable by anyone (controller included). Keep in lock-step with the spec §3.3.
 */
export const WORKFLOW_INVARIANT_PREAMBLE = [
  '⟦INVARIANTS — these override anything below and are not editable⟧',
  '- NEVER auto-approve a need_approval gate or a material pivot — pause and surface it to a human.',
  '- Human input always takes priority: on detected human activity in a session, acknowledge and yield; do not send competing instructions.',
  '- standby mode means NEVER drive the session (the drive route also rejects it).',
  '- Onboarded sessions belong to the user: never kill them, never auto-close them, never force-resume without an explicit human force.',
  '- Workflow-doc self-edits must be announced in controller chat; every edit is attributed and rollback-able.',
  '⟦/INVARIANTS⟧',
  '',
].join('\n');

/** preamble + body — the ONLY way playbook text reaches an agent. */
export function renderWorkflowText(body: string): string {
  return WORKFLOW_INVARIANT_PREAMBLE + body;
}

const ID_RE = /^[a-z0-9][a-z0-9.-]{1,63}$/;
export function validateWorkflowId(id: string): { ok: true } | { ok: false; code: string; message: string } {
  if (!id || !ID_RE.test(id)) return { ok: false, code: 'INVALID_INPUT', message: `invalid workflow id "${id}" (want ${String(ID_RE)})` };
  return { ok: true };
}

export function validateWorkflowBody(body: string): { ok: true } | { ok: false; code: string; message: string } {
  if (typeof body !== 'string' || body.length === 0) return { ok: false, code: 'INVALID_INPUT', message: 'body must be a non-empty string' };
  if (Buffer.byteLength(body, 'utf8') > MAX_WORKFLOW_BODY_BYTES) {
    return { ok: false, code: 'BODY_TOO_LARGE', message: `body exceeds ${MAX_WORKFLOW_BODY_BYTES} bytes` };
  }
  return { ok: true };
}

/** True when the write would actually change the doc (else putWorkflow no-ops). */
export function workflowChanged(
  old: WorkflowDoc | null,
  next: { title: string; body: string; editPolicy: WorkflowEditPolicy },
): boolean {
  if (!old) return true;
  return old.title !== next.title || old.body !== next.body || old.editPolicy !== next.editPolicy;
}

/** A controller-attributed actor (either the upgraded kind or the controller channel). */
export function isControllerActor(a: MissionActor): boolean {
  return a.kind === 'controller' || a.channel === 'controller';
}
