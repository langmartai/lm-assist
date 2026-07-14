/**
 * Cloud CCR (BYOC cloud-run) manager.
 *
 * The OTHER CCR model: `claude` runs in an Anthropic-cloud container (no local
 * machine / tmux / worker bridge). Lifecycle is pure OAuth HTTP against
 * api.anthropic.com (anthropic-beta: ccr-byoc-2025-07-29):
 *
 *   seed   POST /v1/files (git bundle of cwd, purpose=user_data) -> file_id
 *   env    GET  /v1/environment_providers                        -> environment_id
 *   create POST /v1/sessions {seed, env, initial user turn}       -> session_…
 *   drive  POST /v1/sessions/{sid}/events                          (follow-up turns)
 *   read   GET  /v1/code/sessions/{sid}/teleport-events            (transcript)
 *   status GET  /v1/code/sessions/{sid}
 *   stop   DELETE /v1/sessions/{sid}                               -> session_deleted
 *
 * Distinct from ccr-manager.ts (the worker-bridge model that drives a LOCAL
 * session). Proven end-to-end on prod 117 via ccr/ccr-cloud-run-client.js.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { execFileSync } from '../utils/exec';

const execFileAsync = promisify(execFile);
import { TerminalError } from './errors';
import {
  anthropicOAuthGet,
  anthropicOAuthPost,
  anthropicOAuthPut,
  anthropicOAuthDelete,
  getValidAccessToken,
  getOrganizationUuid,
} from '../utils/claude-oauth';
import { getHubClient } from '../hub-client';
import { legacyEncodeProjectPath } from '../utils/path-utils';

const CACHE_DIR = path.join(os.homedir(), '.cache', 'lm-assist');
const REGISTRY_FILE = path.join(CACHE_DIR, 'ccr-cloud.json');
const REGISTRY_TMP = path.join(CACHE_DIR, 'ccr-cloud.json.tmp');

const CCR_BETA = 'ccr-byoc-2025-07-29';
const DEFAULT_MODEL = 'claude-opus-4-8[1m]';
const MAX_SEED_BYTES = 50 * 1024 * 1024; // 50 MiB upload guard

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in __tests__/ccr-cloud.test.ts)
// ---------------------------------------------------------------------------

/** claude.ai web URL for a cloud session (sid is already `session_…`). */
export function cloudSessionWebUrl(sid: string): string {
  return `https://claude.ai/code/${sid}`;
}

/** Validate a cloud session id shape. */
export function isCloudSid(sid: string | undefined | null): boolean {
  return typeof sid === 'string' && /^session_[A-Za-z0-9]+$/.test(sid);
}

/** Accept either a cloud sid (`session_…`) or a bridge cse (`cse_…`) — the same code session,
 *  two prefixes. The cloud read/answer/drive/status/stop ops work for both (a bridge falls back
 *  to the client `/events` channel). */
export function isCloudOrBridge(sid: string | undefined | null): boolean {
  return typeof sid === 'string' && /^(?:session_|cse_)[A-Za-z0-9]+$/.test(sid);
}

/** A `sources` entry: a GitHub repo the cloud container clones (the standard seed). */
export function buildGitHubSource(url: string, revision?: string) {
  return { type: 'git_repository' as const, url, ...(revision ? { revision } : {}) };
}

/** Normalise a repo reference (owner/name, github URL, ssh, or .git) → { slug, url }. */
export function parseGitHubRepo(input: string): { slug: string; url: string } | null {
  if (!input || typeof input !== 'string') return null;
  let s = input.trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/^github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const m = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/);
  if (!m) return null;
  const slug = `${m[1]}/${m[2]}`;
  return { slug, url: `https://github.com/${slug}` };
}

/**
 * The lm-assist INSTALL-ONLY setup preamble seeded into a cloud session's first turn: install
 * lm-assist locally (the user's CUSTOM GitHub build — NOT the stale npm-published version) and
 * start it local-only. NO hub key and NO external connection are embedded (so it doesn't read as
 * injected C2-wiring, and no secret lands in the transcript). Connecting to the user's hub is a
 * separate, in-session, user-confirmed step. Pure; tested.
 */
export type CloudRole = 'worker' | 'orchestrator';

/** A repo slug/url is the lm-assist repo if it's empty (working repo unknown → assume lm-assist) or ends in `lm-assist`. */
function isLmAssistRepo(repo: string): boolean {
  return !repo.trim() || /(^|[/:])lm-assist(\.git)?$/i.test(repo.trim());
}

/**
 * The standing bootstrap / self-heal instruction we SEND to a cloud session on START and RESUME.
 * Makes the agent ensure lm-assist is running LOCALLY before its task — RESTART if just down (the common
 * resumed-container case: disk persists, processes don't), INSTALL if missing — covering both repo cases
 * (the session's repo IS lm-assist, or a different project that must clone lm-assist separately) and both
 * roles (worker / orchestrator). NO hub key is embedded (connecting the hub stays a user-confirmed step).
 * Knowledge lives in the always-reachable connector (`bootstrap`/`guide`), so a recycled container self-heals.
 */
export function buildBootstrapInstruction(opts: { role?: CloudRole; taskId?: string; title?: string; primaryRepo?: string; homeNode?: string; homeProject?: string } = {}): string {
  const apiPort = 3100;
  const repo = (opts.primaryRepo || '').trim();
  const lines: string[] = [
    "[lm-assist bootstrap] FIRST — before your task — make sure lm-assist (the user's tooling; you need it to be a node + reach the connector) is running LOCALLY here. Do this on every START and RESUME:",
    '',
    `  1. Up already?  curl -s localhost:${apiPort}/health   (or: lm-assist status)  → ok ⇒ skip to your role/task.`,
    '  2. Installed but Core DOWN?  A resumed/rebooted cloud container keeps its DISK but loses all PROCESSES, so:',
    '       lm-assist start            # ~12s; brings Core back from the on-disk build, NO reinstall.',
    '  3. NOT installed?  install it, then `lm-assist start`:',
  ];
  if (isLmAssistRepo(repo)) {
    lines.push(
      '       This working repo IS lm-assist → install from it: call the connector `bootstrap`, then `guide("install")` and follow it',
      '       (npm install --ignore-scripts → ./core.sh build → lm-assist start). Quick alternative: npm install -g github:langmartai/lm-assist',
      '       then claude plugin install lm-assist@langmartai.',
    );
  } else {
    lines.push(
      `       Your working repo is \`${repo}\` — a DIFFERENT project; lm-assist is a SEPARATE tool. Install it INDEPENDENTLY of your checkout:`,
      '       npm install -g github:langmartai/lm-assist   # npm CLONES + builds the custom lm-assist; does NOT touch your repo',
      '       then claude plugin install lm-assist@langmartai, then lm-assist start.  (Detailed from-source build: `bootstrap` → `guide("install")`.)',
      `       Then RETURN to your actual task on \`${repo}\`.`,
    );
  }
  lines.push(
    '       (WINDOWS host? install via PowerShell instead of bash — irm https://raw.githubusercontent.com/langmartai/lm-assist/main/install.ps1 | iex — then use `lm-assist start` / `lm-assist status` (NOT ./core.sh / curl). `lm-assist doctor` checks Node>=20.9 + the chokidar pin.)',
  );
  lines.push(
    '',
    `This gives you LOCAL lm-assist on :${apiPort} (CLI + curl -s localhost:${apiPort}/...; the MCP TOOLS attach at your NEXT Claude Code session). lm-assist COMPLEMENTS your built-in tools. NO hub key is embedded — to CONNECT this node to the user's HUB is a SEPARATE step: ASK the user to confirm + provide the hub URL + key; do NOT wire any external hub on your own.`,
  );
  if (opts.role === 'worker') {
    const task = opts.taskId ? ` for task \`${opts.taskId}\`${opts.title ? ` ("${opts.title}")` : ''}` : '';
    lines.push(
      '',
      `ROLE — you are a WORKER${task}. Once lm-assist is up, follow \`guide("roles")\`: call set_role, print a ⟦WORKER-STATUS⟧ … ⟦/WORKER-STATUS⟧ block EVERY turn, report_status as you progress, and raise an agree-gate (status:need_approval) before any sensitive step — STOP until it's decided.`,
    );
    // MEMORY auto-sync (direct node-to-node over the hub, NOT git). lm-assist manages it in the BACKGROUND.
    lines.push(
      '',
      "MEMORY — lm-assist auto-manages this project's curated memory for you, in the BACKGROUND (direct node-to-node over the hub, not git):",
      "  • it PULLS the project's PERSISTENT memory from your home node so you begin with the team's knowledge, and",
      '  • it PUSHES your NEW project memory back to the home node so it SURVIVES this ephemeral VM.',
      '  Mark a memory file `persistence: temporary` in its frontmatter ONLY for scratch that should die with this VM (it is never synced).',
    );
    if (opts.homeNode && opts.homeProject) {
      lines.push(
        '  ENABLE it ONCE, right after lm-assist is up (background; safe to repeat) — run from inside your repo so `$(pwd)` is its root:',
        `    curl -s -XPOST localhost:${apiPort}/memory/sync/enable -H 'Content-Type: application/json' --data-binary "{\\"homeNode\\":\\"${opts.homeNode}\\",\\"homeProject\\":\\"${opts.homeProject}\\",\\"cwd\\":\\"$(pwd)\\"}"`,
        `  That writes ~/.lm-assist/memory-sync.json (nodeMode:ephemeral, homeNode:${opts.homeNode}) and pulls the home memory now; push-back is then automatic.`,
      );
    } else {
      lines.push('  (Your home node/project is configured once this node enrolls to the hub; until then memory stays local to this VM.)');
    }
  } else if (opts.role === 'orchestrator') {
    lines.push(
      '',
      'ROLE — you are the ORCHESTRATOR. Once lm-assist is up, follow `guide("roles")`: read your workers (worker_status / list_workers), drive them (send_session_message / CCR), and decide their agree-gates (decide_gate).',
    );
  }
  lines.push('', '────────  your task  ────────', '');
  return lines.join('\n');
}

/** Back-compat: the former install-only name → the no-role bootstrap instruction. */
export function buildSetupPreamble(): string {
  return buildBootstrapInstruction({});
}

/**
 * Build the POST /v1/sessions body — a create carries the initial user turn (wrapped event).
 * Seed EITHER via `sources` (GitHub repos — the standard) OR `seedFileId` (local git bundle).
 */
export function buildCreateBody(opts: { prompt?: string; model: string; environmentId: string; title?: string; seedFileId?: string; sources?: unknown[]; effort?: string }) {
  const session_context: Record<string, unknown> = {
    sources: opts.sources || [],
    outcomes: [],
    model: opts.model,
  };
  // Effort (thinking level) — claude.ai's Faster↔Smarter slider maps to config.effort_level.
  // Only include when provided so an unset create keeps the account default.
  if (opts.effort && opts.effort.trim()) session_context.effort_level = opts.effort.trim();
  if (opts.seedFileId) session_context.seed_bundle_file_id = opts.seedFileId;
  // The prompt is OPTIONAL — with no prompt the session boots (clones the repo) and waits to be
  // driven (events:[]). With a prompt it carries an initial user turn.
  const events = opts.prompt && opts.prompt.trim()
    ? [{ type: 'event', data: { uuid: randomUUID(), session_id: '', type: 'user', parent_tool_use_id: null, message: { role: 'user', content: opts.prompt } } }]
    : [];
  return {
    title: opts.title || 'lm-assist cloud ccr',
    events,
    session_context,
    environment_id: opts.environmentId,
  };
}

// ---------------------------------------------------------------------------
// Answering a pending question (AskUserQuestion tool_use) — pure, tested
// ---------------------------------------------------------------------------

export interface PendingQuestion {
  toolUseId: string;
  questions: Array<{ header?: string; question?: string; multiSelect?: boolean; options?: Array<{ label: string; description?: string }> }>;
}

/** Scan raw teleport events for an UNANSWERED AskUserQuestion tool_use (session awaiting a tool_result). */
export function findPendingQuestion(events: Array<{ payload?: { message?: { content?: any[] } } }>): PendingQuestion | null {
  let pending: PendingQuestion | null = null;
  const answered = new Set<string>();
  for (const e of events || []) {
    const c = e?.payload?.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b?.type === 'tool_use' && b?.name === 'AskUserQuestion' && b?.id) pending = { toolUseId: b.id, questions: (b.input?.questions as PendingQuestion['questions']) || [] };
      else if (b?.type === 'tool_result' && b?.tool_use_id) answered.add(b.tool_use_id);
    }
  }
  return pending && !answered.has(pending.toolUseId) ? pending : null;
}

/**
 * Scan raw native JSONL messages (each line parsed as { message?: { content?: any[] } }) for the
 * LAST UNANSWERED AskUserQuestion tool_use. Mirrors findPendingQuestion but for the native .jsonl
 * format where content is at `msg.message.content` rather than `event.payload.message.content`.
 * Pure and testable.
 */
export function extractPendingQuestion(rawMessages: Array<{ message?: { content?: any[] } }>): PendingQuestion | null {
  let pending: PendingQuestion | null = null;
  const answered = new Set<string>();
  for (const msg of rawMessages || []) {
    const c = msg?.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b?.type === 'tool_use' && b?.name === 'AskUserQuestion' && b?.id) {
        pending = { toolUseId: b.id, questions: (b.input?.questions as PendingQuestion['questions']) || [] };
      } else if (b?.type === 'tool_result' && b?.tool_use_id) {
        answered.add(b.tool_use_id);
      }
    }
  }
  return pending && !answered.has(pending.toolUseId) ? pending : null;
}

/**
 * Build the tool_result content for an AskUserQuestion answer. EXPLICIT on purpose: a bare option
 * label was empirically under-specified (the model pushed to main instead of branching), so we
 * spell out the SELECTED option (label + description) for a click, or the verbatim free text for an
 * input. `answer` matching an option label = a click; otherwise = free-text input. Both supported.
 */
export function formatAnswerContent(questions: PendingQuestion['questions'], answer: string): string {
  const q = questions?.[0] || {};
  const a = (answer || '').trim();
  const opt = (q.options || []).find((o) => o.label === a || o.label?.toLowerCase() === a.toLowerCase());
  const label = q.header || q.question || 'question';
  if (opt) return `[answer to "${label}"] The user selected the option "${opt.label}"${opt.description ? ` — ${opt.description}` : ''}. Proceed accordingly.`;
  return `[answer to "${label}"] The user replied: ${answer}`;
}

/** Build the user event that carries a tool_result (the answer to a tool_use, e.g. AskUserQuestion). */
export function buildAnswerEvent(sid: string, toolUseId: string, content: string, uuid?: string) {
  return {
    uuid: uuid || randomUUID(),
    session_id: sid,
    type: 'user' as const,
    parent_tool_use_id: null,
    message: { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: toolUseId, content, is_error: false }] },
  };
}

/** Build a follow-up drive event (POST /v1/sessions/{sid}/events — NOT wrapped, unlike create). */
export function buildDriveEvent(sid: string, text: string, uuid?: string) {
  return {
    uuid: uuid || randomUUID(),
    session_id: sid,
    type: 'user' as const,
    parent_tool_use_id: null,
    message: { role: 'user' as const, content: text },
  };
}

export interface CloudTranscriptMsg { role: string; type: string; text: string; tools?: string[] }

/** Parse a teleport-events response into a simplified transcript (role + text + tool names). */
export function parseTeleportTranscript(body: unknown): CloudTranscriptMsg[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const out: CloudTranscriptMsg[] = [];
  for (const e of data as Array<Record<string, any>>) {
    const type = String(e.event_type || e.type || '');
    if (type !== 'assistant' && type !== 'user') continue;
    const content = e.payload?.message?.content;
    let text = '';
    const tools: string[] = [];
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'text' && typeof b.text === 'string') text += b.text;
        else if (b?.type === 'tool_use' && b.name) tools.push(String(b.name));
      }
    }
    const msg: CloudTranscriptMsg = { role: e.payload?.message?.role || type, type, text };
    if (tools.length) msg.tools = tools;
    out.push(msg);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Registry (sessions WE created — for list/stop convenience)
// ---------------------------------------------------------------------------

export interface CloudRecord {
  sid: string;
  title: string;
  model: string;
  /** GitHub repo slug (owner/name) the cloud cloned, when seeded from GitHub. */
  repo: string | null;
  /** Local repo path, when seeded from a local bundle instead. */
  cwd: string | null;
  seedFileId: string | null;
  environmentId: string | null;
  webUrl: string;
  createdAt: string;
}

function loadRegistry(): Record<string, CloudRecord> {
  try {
    const parsed = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, CloudRecord>;
  } catch { /* missing/corrupt */ }
  return {};
}

function saveRegistry(data: Record<string, CloudRecord>): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const fd = fs.openSync(REGISTRY_TMP, 'w');
  try { fs.writeSync(fd, JSON.stringify(data, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(REGISTRY_TMP, REGISTRY_FILE);
}

// ---------------------------------------------------------------------------
// Upstream call options (ccr-byoc beta + org header), resolved per call
// ---------------------------------------------------------------------------

async function ccrOpts() {
  const org = await getOrganizationUuid();
  return { betaHeader: CCR_BETA, extraHeaders: { 'anthropic-version': '2023-06-01', 'x-organization-uuid': org } };
}

function assertOk(res: { status: number; statusText: string; body: any }, what: string): void {
  if (res.status < 200 || res.status >= 300) {
    throw new TerminalError('UPSTREAM_ERROR', `${what}: HTTP ${res.status} ${res.statusText}`, { status: res.status, body: res.body });
  }
}

// ---------------------------------------------------------------------------
// Seed bundle + upload + environment
// ---------------------------------------------------------------------------

/** git-bundle a cwd (HEAD) or a minimal scratch repo when no/!git cwd. Returns the bundle bytes. */
function makeSeedBundle(cwd?: string): { buf: Buffer; cwd: string | null } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-cloud-'));
  const bundlePath = path.join(tmpDir, 'seed.bundle');
  try {
    const isRepo = !!cwd && (() => {
      try { return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, encoding: 'utf-8', timeout: 5000 }).trim() === 'true'; }
      catch { return false; }
    })();
    if (isRepo) {
      execFileSync('git', ['bundle', 'create', bundlePath, 'HEAD'], { cwd, encoding: 'utf-8', timeout: 60_000 });
      const buf = fs.readFileSync(bundlePath);
      if (buf.length > MAX_SEED_BYTES) {
        throw new TerminalError('INVALID_INPUT', `seed bundle for ${cwd} is ${(buf.length / 1048576).toFixed(1)} MiB (> ${MAX_SEED_BYTES / 1048576} MiB cap) — start without cwd or use a smaller repo`);
      }
      return { buf, cwd: cwd! };
    }
    // scratch seed — no user code uploaded
    const sd = path.join(tmpDir, 'repo');
    fs.mkdirSync(sd);
    execFileSync('git', ['init', '-q'], { cwd: sd, encoding: 'utf-8' });
    execFileSync('git', ['config', 'user.email', 'ccr@lm-assist'], { cwd: sd, encoding: 'utf-8' });
    execFileSync('git', ['config', 'user.name', 'ccr'], { cwd: sd, encoding: 'utf-8' });
    fs.writeFileSync(path.join(sd, 'README.md'), 'lm-assist cloud ccr seed\n');
    execFileSync('git', ['add', '-A'], { cwd: sd, encoding: 'utf-8' });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: sd, encoding: 'utf-8' });
    execFileSync('git', ['bundle', 'create', bundlePath, '--all'], { cwd: sd, encoding: 'utf-8' });
    return { buf: fs.readFileSync(bundlePath), cwd: null };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** Upload the seed bundle (multipart, files-api beta) → file_id. */
async function uploadSeed(buf: Buffer): Promise<string> {
  const creds = await getValidAccessToken();
  const org = await getOrganizationUuid();
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'application/octet-stream' }), '_source_seed.bundle');
  fd.append('purpose', 'user_data');
  const res = await fetch('https://api.anthropic.com/v1/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'files-api-2025-04-14,oauth-2025-04-20',
      'x-organization-uuid': org,
    },
    body: fd,
  });
  const body = await res.json().catch(() => null);
  if (res.status < 200 || res.status >= 300) {
    throw new TerminalError('UPSTREAM_ERROR', `seed upload failed: HTTP ${res.status}`, { status: res.status, body });
  }
  const id = (body as { id?: string })?.id;
  if (!id) throw new TerminalError('UPSTREAM_ERROR', 'seed upload returned no file id', { body });
  return id;
}

let cachedEnvId: string | null = null;
/** Resolve the cloud environment id (first available), cached. */
async function getEnvironmentId(): Promise<string> {
  if (cachedEnvId) return cachedEnvId;
  const res = await anthropicOAuthGet('/v1/environment_providers', await ccrOpts());
  assertOk(res, 'environment lookup');
  const envs = (res.body as { environments?: Array<{ environment_id?: string; id?: string }> })?.environments || [];
  const id = envs[0]?.environment_id || envs[0]?.id;
  if (!id) throw new TerminalError('PRECONDITION_FAILED', 'no cloud environment available for this account (ccr-byoc not provisioned)');
  cachedEnvId = id;
  return id;
}

// ---------------------------------------------------------------------------
// GitHub repo listing (for the seed picker) — via the gh CLI
// ---------------------------------------------------------------------------

export interface GitHubRepo { repo: string; isPrivate: boolean; pushedAt: string }

/**
 * List the user's GitHub repos (gh), most-recently-pushed first. Best-effort: [] if gh
 * unavailable. NOTE: we deliberately do NOT request `defaultBranchRef` — a fine-grained
 * PAT often lacks GraphQL access to it ("Resource not accessible by personal access token"),
 * which would error the whole call. The cloud picks the repo's default branch on clone when
 * no branch is specified.
 */
export function listGitHubRepos(limit = 50): GitHubRepo[] {
  try {
    const out = execFileSync('gh', ['repo', 'list', '--limit', String(limit), '--json', 'nameWithOwner,isPrivate,pushedAt'], { encoding: 'utf-8', timeout: 15_000 });
    const arr = JSON.parse(out) as Array<{ nameWithOwner: string; isPrivate: boolean; pushedAt: string }>;
    return arr
      .map((r) => ({ repo: r.nameWithOwner, isPrivate: !!r.isPrivate, pushedAt: r.pushedAt || '' }))
      .sort((a, b) => (a.pushedAt < b.pushedAt ? 1 : -1));
  } catch {
    return [];
  }
}

/**
 * List a repo's branches for the branch picker. Async (non-blocking). Primary:
 * `git ls-remote` over SSH — sees the langmartai account's public AND private repos.
 * Fallback: `gh api .../branches` (REST) for public repos the PAT can read.
 * Best-effort: [] when neither is authorised (caller can still type a branch).
 */
export async function listRepoBranches(repo: string): Promise<string[]> {
  const parsed = parseGitHubRepo(repo);
  if (!parsed) return [];
  try {
    const { stdout } = await execFileAsync('git', ['ls-remote', '--heads', `git@github.com:${parsed.slug}.git`], {
      timeout: 12_000,
      env: { ...process.env, GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new' },
    });
    const heads = stdout.split('\n')
      .map((l) => { const i = l.indexOf('refs/heads/'); return i >= 0 ? l.slice(i + 11).trim() : ''; })
      .filter(Boolean);
    if (heads.length) return heads;
  } catch { /* fall through to gh */ }
  try {
    const { stdout } = await execFileAsync('gh', ['api', `repos/${parsed.slug}/branches?per_page=100`, '--jq', '.[].name'], { timeout: 12_000 });
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CloudStartResult { sid: string; webUrl: string; status: string; model: string; repo: string | null; branch: string | null; cwd: string | null; environmentId: string; setup: boolean }

/**
 * Create a cloud-run CCR session (returns immediately; poll cloudRead for the first turn).
 * Standard seed = a GitHub repo (`repo` = owner/name or URL; the cloud clones it, branch
 * defaults to the repo's default). Fallback = a local git bundle (`cwd`) or empty scratch.
 */
export async function cloudStart(opts: { prompt?: string; repo?: string; branch?: string; cwd?: string; model?: string; effort?: string; permissionMode?: string; title?: string; setup?: boolean; role?: CloudRole; primaryRepo?: string; homeProject?: string }): Promise<CloudStartResult> {
  const prompt = (opts.prompt || '').toString().trim();
  const hasRepo = !!(opts.repo && opts.repo.trim());
  const hasCwd = !!(opts.cwd && opts.cwd.trim());
  // Prompt is optional: a session can boot from just a repo (clones + waits) or just lm-assist setup.
  if (!prompt && !hasRepo && !hasCwd && !opts.setup) throw new TerminalError('INVALID_INPUT', 'provide a repo or a prompt to start a cloud session');
  const model = opts.model || DEFAULT_MODEL;
  const environmentId = await getEnvironmentId();

  // Optional lm-assist bootstrap/self-heal: prepend the standing instruction so the container ensures
  // lm-assist is running locally (restart if down, install/clone if missing) — role-aware, repo-case-aware
  // (primaryRepo defaults to the cloned repo). No hub key / external connect (a separate user-confirmed step).
  let effectivePrompt = prompt;
  let setupApplied = false;
  if (opts.setup) {
    // Seed the worker's memory-sync home: this spawner is the persistent home node.
    let homeNode: string | undefined;
    try { homeNode = getHubClient().getStatus().gatewayId || undefined; } catch { homeNode = undefined; }
    let homeProject = opts.homeProject;
    if (!homeProject) { try { homeProject = legacyEncodeProjectPath(process.cwd()); } catch { homeProject = undefined; } }
    effectivePrompt = buildBootstrapInstruction({
      role: opts.role, primaryRepo: opts.primaryRepo || opts.repo, homeNode, homeProject,
    }) + (prompt || 'Then await my instructions.');
    setupApplied = true;
  }

  let sources: unknown[] = [];
  let seedFileId: string | undefined;
  let repoSlug: string | null = null;
  let branch: string | null = null;
  let cwd: string | null = null;

  if (opts.repo && opts.repo.trim()) {
    // Standard path: the cloud clones a GitHub repo.
    const parsed = parseGitHubRepo(opts.repo);
    if (!parsed) throw new TerminalError('INVALID_INPUT', 'repo must be "owner/name" or a github.com URL');
    // No branch given → omit revision so the cloud clones the repo's default branch.
    branch = (opts.branch && opts.branch.trim()) || null;
    sources = [buildGitHubSource(parsed.url, branch || undefined)];
    repoSlug = parsed.slug;
  } else {
    // Fallback: seed from a local git bundle (cwd) or an empty scratch workspace.
    const seed = makeSeedBundle(opts.cwd);
    seedFileId = await uploadSeed(seed.buf);
    cwd = seed.cwd;
  }

  const res = await anthropicOAuthPost('/v1/sessions', buildCreateBody({ prompt: effectivePrompt, model, environmentId, title: opts.title, seedFileId, sources, effort: opts.effort }), await ccrOpts());
  assertOk(res, 'cloud session create');
  const sid = (res.body as { id?: string })?.id;
  if (!sid) throw new TerminalError('UPSTREAM_ERROR', 'create returned no session id', { body: res.body });
  const status = (res.body as { session_status?: string })?.session_status || 'pending';

  const rec: CloudRecord = {
    sid, title: opts.title || (repoSlug ? `cloud: ${repoSlug}` : 'lm-assist cloud ccr'), model,
    repo: repoSlug, cwd, seedFileId: seedFileId || null, environmentId,
    webUrl: cloudSessionWebUrl(sid), createdAt: new Date().toISOString(),
  };
  const data = loadRegistry(); data[sid] = rec; saveRegistry(data);
  // Apply the composer's permission mode best-effort (non-fatal): the freshly-created session
  // accepts a set_permission_mode control on its client channel. A hiccup here must not fail the start.
  if (opts.permissionMode) {
    try { await cloudControl({ sid, permissionMode: opts.permissionMode }); } catch { /* best-effort */ }
  }
  return { sid, webUrl: rec.webUrl, status, model, repo: repoSlug, branch, cwd, environmentId, setup: setupApplied };
}

/** Drive a follow-up turn into a cloud session. */
export async function cloudDrive(opts: { sid: string; text: string; reBootstrap?: boolean; role?: CloudRole; primaryRepo?: string }): Promise<{ delivered: boolean; sid: string; eventId?: string }> {
  if (!isCloudOrBridge(opts.sid)) throw new TerminalError('INVALID_INPUT', 'sid must look like session_… or cse_…');
  let text = (opts.text || '').toString();
  if (!text.trim()) throw new TerminalError('INVALID_INPUT', 'text is required');
  // Resume self-heal: prepend the bootstrap/self-heal instruction so a re-engaged (possibly rebooted)
  // container ensures lm-assist is up (restart/install) before doing the new turn.
  if (opts.reBootstrap) text = buildBootstrapInstruction({ role: opts.role, primaryRepo: opts.primaryRepo }) + text;
  const res = await anthropicOAuthPost(`/v1/sessions/${opts.sid}/events`, { events: [buildDriveEvent(opts.sid, text)] }, await ccrOpts());
  // Bridge fallback: a `--remote-control` session isn't driveable on the cloud `/v1/sessions` ingress;
  // drive it as a CLIENT user-event on `/v1/code/sessions/{cse}/events` (the backend relays it to the
  // worker, the same path the web UI types into). Lets the CCR page drive a controller/executor too.
  if (res.status < 200 || res.status >= 300) {
    const cse = toBridgeCse(opts.sid);
    const ev = { ...buildDriveEvent(cse, text), type: 'user' as const };
    const cr = await anthropicOAuthPost(`/v1/code/sessions/${cse}/events`, { events: [{ payload: ev }] }, await ccrOpts());
    assertOk(cr, 'cloud drive (bridge)');
    return { delivered: true, sid: opts.sid };
  }
  const r = res.body && Array.isArray(res.body.results) ? res.body.results[0] : undefined;
  return { delivered: true, sid: opts.sid, eventId: r?.event_id };
}

/** True when the session is genuinely blocked awaiting input (a question/permission). */
function isRequiresAction(sessionBody: any): boolean {
  const shape = sessionBody?.response_shape || sessionBody || {};
  return /requires_action/i.test(String(shape?.worker_status || ''));
}

/** Read a cloud session's transcript (teleport-events) + any pending question awaiting an answer. */
export async function cloudRead(opts: { sid: string; lastN?: number }): Promise<{ sid: string; messages: CloudTranscriptMsg[]; pendingQuestion: PendingQuestion | null }> {
  if (!isCloudOrBridge(opts.sid)) throw new TerminalError('INVALID_INPUT', 'sid must look like session_… or cse_…');
  const ccr = await ccrOpts();
  const [res, st] = await Promise.all([
    anthropicOAuthGet(`/v1/code/sessions/${opts.sid}/teleport-events`, ccr).catch(() => null),
    anthropicOAuthGet(`/v1/code/sessions/${opts.sid}`, ccr).catch(() => null),
  ]);
  // Teleport-tolerant: a `--remote-control` bridge cse has no transcript here (404/empty) — don't
  // throw; just yield no messages and rely on the client `/events` fallbacks below.
  const teleportOk = !!res && res.status >= 200 && res.status < 300;
  const events = teleportOk ? (((res!.body as { data?: any[] })?.data) || []) : [];
  let messages: CloudTranscriptMsg[] = teleportOk ? parseTeleportTranscript(res!.body) : [];
  // Transcript fallback: bridge / remote-control sessions have NO teleport transcript — the
  // claude.ai/code web app renders them from the CLIENT /events channel (each payload is a
  // transcript line). Do the same: fetch the client log and parse it with the shared cowork
  // parser (same substrate — sorts by sequence_num, drops tool_result user-turns, groups tool
  // calls + thinking into assistant turns). One read is reused for the pending-question check.
  let clientRead: Awaited<ReturnType<typeof cloudClientEventsRead>> | null = null;
  if (messages.length === 0) {
    try {
      clientRead = await cloudClientEventsRead(opts.sid, { maxPages: 3 });
      if (clientRead.events.length) {
        const { parseCoworkEvents } = require('../cowork/cowork-read') as typeof import('../cowork/cowork-read');
        messages = parseCoworkEvents({ data: clientRead.events }).messages;
      }
    } catch { /* best-effort — an empty transcript beats an error */ }
  }
  if (opts.lastN && opts.lastN > 0) messages = messages.slice(-opts.lastN);
  // Gate on worker_status: a client-sent tool_result doesn't reliably appear in teleport-events,
  // so only surface a pending question when the worker is actually blocked (requires_action).
  let pendingQuestion: PendingQuestion | null = isRequiresAction(st?.body) ? findPendingQuestion(events) : null;
  // Bridge fallback: a `--remote-control` session's AskUserQuestion is a can_use_tool relayed via
  // the CLIENT /events channel — it's NOT in teleport-events. When teleport shows nothing pending,
  // check the client event log (resolution-tracked, so no false positives). Lets the CCR page's
  // CcrCloudView surface a bridge controller/executor's question, not just cloud sessions.
  if (!pendingQuestion) {
    try {
      const cr = clientRead ?? await cloudClientEventsRead(opts.sid);
      if (cr.pendingQuestion) pendingQuestion = cr.pendingQuestion;
    } catch { /* best-effort */ }
  }
  return { sid: opts.sid, messages, pendingQuestion };
}

/**
 * Decide which transport resolves a cloud/bridge session's pending AskUserQuestion.
 *
 *  - `'client'` — POST a `control_response` to the CLIENT channel `/v1/code/sessions/{sid}/events`.
 *    A cloud BYOC worker (spawned via `/v1/sessions`) AND a `--remote-control` bridge BOTH surface
 *    AskUserQuestion as a `can_use_tool` **control_request** there, resolved ONLY by a control_response
 *    (the backend relays it down to the worker — exactly what the claude.ai web UI does). This is the
 *    canonical path. VERIFIED live (123): a tool_result on the drive channel below is silently ignored
 *    by such a worker — it idle-suspends and never proceeds; a control_response wakes it and it writes.
 *  - `'cloud'` — POST a `tool_result` to the DRIVE channel `/v1/sessions/{sid}/events`. Fallback for a
 *    legacy / teleport-only session whose AskUserQuestion is a plain tool_use awaiting a tool_result
 *    (NO control_request on the client channel).
 *  - `'none'` — nothing pending to answer.
 *
 * The client path is preferred whenever a client control_request is pending (or an explicit requestId
 * is supplied) — REGARDLESS of whether teleport-events also shows the tool_use. The old code keyed off
 * the teleport tool_use first, so a cloud worker (which has BOTH) wrongly took the drive path and the
 * answer never reached it. See memory: remote-control-worker-events-protocol.
 */
export function chooseAnswerTransport(opts: { hasClientControlRequest: boolean; explicitRequestId?: boolean; hasTeleportToolUse: boolean }): 'client' | 'cloud' | 'none' {
  if (opts.hasClientControlRequest || opts.explicitRequestId) return 'client';
  if (opts.hasTeleportToolUse) return 'cloud';
  return 'none';
}

/**
 * Answer a pending question (AskUserQuestion) in a cloud/bridge session.
 * `answer` = an option's label (a CLICK) or arbitrary text (free INPUT) — both handled.
 *
 * Prefers the CLIENT control_response path (see {@link chooseAnswerTransport}): a cloud BYOC worker's
 * AskUserQuestion is a `can_use_tool` control_request resolved on `/v1/code/sessions/{sid}/events`, NOT
 * a tool_result on the `/v1/sessions/{sid}/events` drive channel. Falls back to the tool_result/drive
 * path only for a legacy teleport-only tool_use with no client control_request.
 */
export async function cloudAnswer(opts: { sid: string; answer: string; toolUseId?: string; requestId?: string }): Promise<{ answered: boolean; sid: string; toolUseId: string; mode: 'option' | 'input'; sentContent: string; transport?: 'cloud' | 'bridge' }> {
  if (!isCloudOrBridge(opts.sid)) throw new TerminalError('INVALID_INPUT', 'sid must look like session_… or cse_…');
  const answer = (opts.answer || '').toString();
  if (!answer.trim()) throw new TerminalError('INVALID_INPUT', 'answer is required');

  // Look for a pending control_request on the CLIENT channel first — that's how AskUserQuestion
  // surfaces for cloud BYOC workers + bridges, and how it must be resolved. Best-effort: a network
  // hiccup here falls through to the teleport read below rather than failing the answer.
  let clientPending: PendingControlRequest | null = null;
  try { clientPending = (await cloudClientEventsRead(opts.sid)).pendingQuestion; } catch { /* fall through to teleport */ }

  // Teleport read only matters for the drive-channel fallback (a tool_use awaiting a tool_result).
  // Gate on requires_action so we don't re-answer an already-resolved teleport question.
  const ccr = await ccrOpts();
  const [res, st] = await Promise.all([
    anthropicOAuthGet(`/v1/code/sessions/${opts.sid}/teleport-events`, ccr).catch(() => null),
    anthropicOAuthGet(`/v1/code/sessions/${opts.sid}`, ccr).catch(() => null),
  ]);
  const events = (res && res.status >= 200 && res.status < 300 ? ((res.body as { data?: any[] })?.data) : []) || [];
  const teleportPending = isRequiresAction(st?.body) ? findPendingQuestion(events) : null;
  const teleportToolUseId = opts.toolUseId || teleportPending?.toolUseId;

  const transport = chooseAnswerTransport({
    hasClientControlRequest: !!clientPending,
    explicitRequestId: !!opts.requestId,
    hasTeleportToolUse: !!teleportToolUseId,
  });

  if (transport === 'client') {
    // control_response on /v1/code/sessions/{sid}/events — the backend relays it to the worker.
    const r = await cloudClientEventsAnswer({ cse: opts.sid, answer, requestId: opts.requestId || clientPending?.requestId, questions: clientPending?.questions });
    return { answered: r.answered, sid: opts.sid, toolUseId: r.requestId, mode: r.mode, sentContent: answer, transport: 'bridge' };
  }
  if (transport === 'none') {
    throw new TerminalError('PRECONDITION_FAILED', 'no pending question to answer (neither a client control_request nor a teleport tool_use)');
  }
  // transport === 'cloud': legacy teleport tool_use → tool_result on the drive channel.
  const q = teleportPending?.questions?.[0];
  const isOption = !!(q?.options || []).find((o) => o.label === answer.trim() || o.label?.toLowerCase() === answer.trim().toLowerCase());
  const content = formatAnswerContent(teleportPending?.questions || [], answer);
  const post = await anthropicOAuthPost(`/v1/sessions/${opts.sid}/events`, { events: [buildAnswerEvent(opts.sid, teleportToolUseId!, content)] }, await ccrOpts());
  assertOk(post, 'cloud answer');
  return { answered: true, sid: opts.sid, toolUseId: teleportToolUseId!, mode: isOption ? 'option' : 'input', sentContent: content, transport: 'cloud' };
}

/** Get raw cloud session status. */
export async function cloudStatus(sid: string): Promise<{ sid: string; status: string; connectionStatus?: string; raw: any }> {
  if (!isCloudOrBridge(sid)) throw new TerminalError('INVALID_INPUT', 'sid must look like session_… or cse_…');
  const res = await anthropicOAuthGet(`/v1/code/sessions/${sid}`, await ccrOpts());
  assertOk(res, 'cloud status');
  const b = res.body as Record<string, any>;
  const shape = b?.response_shape || b;
  return { sid, status: shape?.session_status || shape?.status || 'unknown', connectionStatus: shape?.connection_status, raw: shape };
}

/** Stop (delete) a cloud session and drop it from the registry. */
export async function cloudStop(sid: string): Promise<{ stopped: boolean; sid: string }> {
  if (!isCloudOrBridge(sid)) throw new TerminalError('INVALID_INPUT', 'sid must look like session_… or cse_…');
  const res = await anthropicOAuthDelete(`/v1/sessions/${sid}`, await ccrOpts());
  // 404 = already gone; treat as stopped (idempotent)
  if (res.status !== 404) assertOk(res, 'cloud stop');
  const data = loadRegistry(); delete data[sid]; saveRegistry(data);
  return { stopped: true, sid };
}

/** List cloud sessions WE created (from the registry). */
export function cloudList(): CloudRecord[] {
  return Object.values(loadRegistry()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** List the ACCOUNT's cloud code sessions (fleet-wide, not just ones we created). */
export async function cloudListAccount(limit = 50): Promise<Array<{ sid: string; status: string; title?: string }>> {
  const res = await anthropicOAuthGet('/v1/code/sessions', { ...(await ccrOpts()), query: `limit=${limit}` });
  assertOk(res, 'cloud list account');
  const arr: any[] = res.body?.sessions ?? res.body?.data ?? (Array.isArray(res.body) ? res.body : []);
  // field names confirmed against the live endpoint at build time; defensive reads kept.
  return arr.map((s) => ({
    sid: (s.id || s.session_id || s.uuid) as string,
    status: (s.status || s.session_status || '') as string,
    title: s.title,
  })).filter((s) => s.sid);
}

// ===========================================================================
// Enriched account list + session management (claude.ai/code parity)
// ---------------------------------------------------------------------------
// The claude.ai/code home renders each session with a STATUS PILL + a status
// detail sentence + repo/branch, driven by the `/v1/code/sessions` list fields
// (status_bucket / worker_status / post_turn_summary). cloudListAccount only
// surfaced {sid,status,title}; this surfaces the full shape for the UI, plus
// rename / archive / model+permission control. Pure mappers are unit-tested in
// __tests__/ccr-cloud-manage.test.ts; the network wrappers are thin.
// ===========================================================================

/** Rich per-session shape the CCR page renders (mirrors claude.ai/code's row). */
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
  /** cloud = anthropic_cloud container; remote = a `bridge` (local `claude rc` / connected) session. */
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

/** Extract {repo, branch} from a session `config` (outcomes git_info first, then sources url). Pure. */
export function repoFromConfig(config: any): { repo: string | null; branch: string | null } {
  const outcomes = Array.isArray(config?.outcomes) ? config.outcomes : [];
  for (const o of outcomes) {
    const gi = o?.git_info;
    if (gi?.repo) return { repo: String(gi.repo), branch: Array.isArray(gi.branches) && gi.branches[0] ? String(gi.branches[0]) : null };
  }
  const sources = Array.isArray(config?.sources) ? config.sources : [];
  for (const s of sources) {
    if (typeof s?.url === 'string') {
      const parsed = parseGitHubRepo(s.url);
      if (parsed) return { repo: parsed.slug, branch: s.revision ? String(s.revision) : null };
    }
  }
  return { repo: null, branch: null };
}

/** Map one raw `/v1/code/sessions` list item → the enriched CloudSessionInfo the UI renders. Pure. */
export function mapAccountSession(raw: any): CloudSessionInfo {
  const sid = String(raw?.id || raw?.session_id || raw?.uuid || '');
  const config = raw?.config || {};
  const ext = raw?.external_metadata || {};
  const pts = ext?.post_turn_summary || raw?.post_turn_summary || {};
  const rb = repoFromConfig(config);
  let branch = rb.branch;
  // Prefer the live current branch (external_metadata.current_branches[repo]) when present.
  const cur = ext?.current_branches;
  if (rb.repo && cur && typeof cur === 'object' && cur[rb.repo]) branch = String(cur[rb.repo]);
  const environmentKind = String(raw?.environment_kind || '');
  return {
    sid,
    title: (raw?.title && String(raw.title)) || '(untitled)',
    model: String(config?.model || ''),
    repo: rb.repo,
    branch,
    cwd: null,
    webUrl: sid ? cloudSessionWebUrl(sid) : '',
    createdAt: String(raw?.created_at || ''),
    lastEventAt: raw?.last_event_at ? String(raw.last_event_at) : null,
    kind: environmentKind === 'anthropic_cloud' ? 'cloud' : 'remote',
    environmentKind,
    connectionStatus: raw?.connection_status ? String(raw.connection_status) : null,
    statusBucket: raw?.status_bucket ? String(raw.status_bucket) : null,
    workerStatus: raw?.worker_status ? String(raw.worker_status) : null,
    statusCategory: pts?.status_category ? String(pts.status_category) : null,
    statusDetail: pts?.status_detail ? String(pts.status_detail) : null,
    needsAction: pts?.needs_action ? String(pts.needs_action) : null,
    unread: !!raw?.unread,
    tags: Array.isArray(raw?.tags) ? raw.tags.map(String) : [],
  };
}

/** claude.ai UI permission-mode label → the wire `set_permission_mode` value. Pure. */
export function normalizePermissionMode(ui: string | undefined): string {
  const k = (ui || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  const map: Record<string, string> = {
    manual: 'default', default: 'default', ask: 'default',
    acceptedits: 'acceptEdits', accept: 'acceptEdits',
    plan: 'plan', auto: 'auto',
  };
  return map[k] || 'default';
}

/** Build a `set_model` control_request event (POST to /v1/code/sessions/{cse}/events). Pure. */
export function buildSetModelEvent(model: string, ids?: { requestId?: string; uuid?: string }) {
  return { payload: { type: 'control_request' as const, request_id: ids?.requestId || `set-model-${Date.now()}`, request: { subtype: 'set_model' as const, model }, uuid: ids?.uuid || randomUUID() } };
}

/** Build a `set_permission_mode` control_request event (mode already wire-normalized). Pure. */
export function buildSetPermissionModeEvent(mode: string, ids?: { requestId?: string; uuid?: string }) {
  return { payload: { type: 'control_request' as const, request_id: ids?.requestId || `set-perm-mode-${Date.now()}`, request: { subtype: 'set_permission_mode' as const, mode }, uuid: ids?.uuid || randomUUID() } };
}

/**
 * List the ACCOUNT's code sessions (cloud + bridge), enriched for the CCR page. Merges the
 * local registry (repo/webUrl/createdAt for sessions WE created) over the account payload.
 * Newest activity first.
 */
export async function cloudListEnriched(limit = 50): Promise<CloudSessionInfo[]> {
  const res = await anthropicOAuthGet('/v1/code/sessions', { ...(await ccrOpts()), query: `limit=${limit}` });
  assertOk(res, 'cloud list enriched');
  const arr: any[] = res.body?.data ?? res.body?.sessions ?? (Array.isArray(res.body) ? res.body : []);
  const reg = loadRegistry();
  const items = arr.map(mapAccountSession).filter((s) => s.sid).map((s) => {
    const r = reg[s.sid];
    return r ? { ...s, repo: s.repo || r.repo, cwd: s.cwd || r.cwd, createdAt: s.createdAt || r.createdAt } : s;
  });
  const ts = (s: CloudSessionInfo) => Date.parse(s.lastEventAt || s.createdAt || '') || 0;
  return items.sort((a, b) => ts(b) - ts(a));
}

/** Rename a cloud/bridge session (PUT /v1/code/sessions/{cse} {title}). */
export async function cloudRename(sid: string, title: string): Promise<{ renamed: boolean; sid: string; title: string }> {
  if (!isCloudOrBridge(sid)) throw new TerminalError('INVALID_INPUT', 'sid must look like session_… or cse_…');
  const t = (title || '').trim();
  if (!t) throw new TerminalError('INVALID_INPUT', 'title is required');
  const cse = toBridgeCse(sid);
  const res = await anthropicOAuthPut(`/v1/code/sessions/${cse}`, { title: t }, await ccrOpts());
  assertOk(res, 'cloud rename');
  const reg = loadRegistry(); if (reg[sid]) { reg[sid].title = t; saveRegistry(reg); }
  return { renamed: true, sid, title: t };
}

/** Archive / unarchive a cloud/bridge session (POST /v1/code/sessions/{cse}/{archive|unarchive}). */
export async function cloudArchive(sid: string, archived = true): Promise<{ archived: boolean; sid: string }> {
  if (!isCloudOrBridge(sid)) throw new TerminalError('INVALID_INPUT', 'sid must look like session_… or cse_…');
  const cse = toBridgeCse(sid);
  const res = await anthropicOAuthPost(`/v1/code/sessions/${cse}/${archived ? 'archive' : 'unarchive'}`, {}, await ccrOpts());
  assertOk(res, 'cloud archive');
  return { archived, sid };
}

/**
 * Apply live session controls (model and/or permission mode) via control_request events on the
 * CLIENT channel — the same path the claude.ai composer uses. Effort is a create-time option only.
 */
export async function cloudControl(opts: { sid: string; model?: string; permissionMode?: string }): Promise<{ applied: boolean; sid: string; model: string | null; permissionMode: string | null }> {
  if (!isCloudOrBridge(opts.sid)) throw new TerminalError('INVALID_INPUT', 'sid must look like session_… or cse_…');
  const cse = toBridgeCse(opts.sid);
  const events: unknown[] = [];
  if (opts.model && opts.model.trim()) events.push(buildSetModelEvent(opts.model.trim()));
  const mode = opts.permissionMode ? normalizePermissionMode(opts.permissionMode) : null;
  if (mode) events.push(buildSetPermissionModeEvent(mode));
  if (!events.length) throw new TerminalError('INVALID_INPUT', 'provide model and/or permissionMode');
  const res = await anthropicOAuthPost(`/v1/code/sessions/${cse}/events`, { events }, await ccrOpts());
  assertOk(res, 'cloud control');
  return { applied: true, sid: opts.sid, model: opts.model?.trim() || null, permissionMode: mode };
}

// ===========================================================================
// Remote-control "worker/events" channel
// ---------------------------------------------------------------------------
// A `claude --remote-control` session (e.g. the mission controller) is a LOCAL
// session ALSO bridged to claude.ai. An AskUserQuestion is a `can_use_tool`
// permission INTERCEPTED by the bridge and relayed over this channel — so it is
// NOT in the local .jsonl nor in teleport-events. The truth is on:
//
//   POST /v1/code/sessions/{cse}/worker/events                 (write an event)
//   GET  /v1/code/sessions/{cse}/worker/events/stream?from_sequence_num=N (SSE read)
//   GET  /v1/code/sessions/{cse}/worker                        (snapshot → worker_epoch)
//
// The question is a control_request{can_use_tool, AskUserQuestion}; the answer is
// a control_response{success, behavior:allow, updatedInput.answers:{qText:label}}
// echoing the request_id. The real claude-code client sends NO anthropic-beta and
// NO x-organization-uuid here — only Authorization + anthropic-version +
// anthropic-client-platform + the claude-code UA. See memory:
// remote-control-worker-events-protocol. Pure helpers are unit-tested in
// __tests__/ccr-worker-events.test.ts; the network functions are live-verified.
// ===========================================================================

export interface WorkerEvent {
  eventId?: string;
  sequenceNum?: number;
  eventType?: string;
  /** 'client' (claude.ai / us) vs 'worker' (the local --remote-control bridge). */
  source?: string;
  payload?: any;
  createdAt?: string;
}

/** A pending AskUserQuestion read off the worker/events channel — carries the control_request's request_id. */
export interface PendingControlRequest extends PendingQuestion {
  requestId: string;
}

/** Parse an SSE worker/events stream body into structured events (skips `:keepalive` heartbeats). Pure. */
export function parseWorkerEventStream(raw: string): WorkerEvent[] {
  const out: WorkerEvent[] = [];
  if (!raw) return out;
  for (const block of raw.split('\n\n')) {
    let dataLine: string | null = null;
    for (const ln of block.split('\n')) {
      const t = ln.replace(/^﻿/, '');
      if (t.startsWith(':')) continue; // :keepalive / SSE comments
      if (t.startsWith('data:')) dataLine = (dataLine ?? '') + t.slice(5).trimStart();
    }
    if (dataLine === null) continue;
    let ev: any;
    try { ev = JSON.parse(dataLine); } catch { continue; }
    if (!ev || typeof ev !== 'object') continue;
    out.push({
      eventId: ev.event_id,
      sequenceNum: ev.sequence_num != null ? Number(ev.sequence_num) : undefined,
      eventType: ev.event_type,
      source: ev.source,
      payload: ev.payload,
      createdAt: ev.created_at,
    });
  }
  return out;
}

/**
 * Find the LATEST unanswered AskUserQuestion control_request in an event list. A
 * control_request is "resolved" once a `control_response` echoes its request_id OR a
 * `control_cancel_request` names it (the dialog was superseded/cancelled). Returns the
 * question carrying the control_request's request_id (needed to build the answer) + the
 * AskUserQuestion tool_use_id. Works on both the worker SSE events and the client `/events`
 * payloads (same `payload.type` discriminator). Expects OLDEST-first order: the last
 * unresolved request wins (client `/events` is newest-first → reverse before calling). Pure.
 */
export function findPendingControlRequest(events: WorkerEvent[]): PendingControlRequest | null {
  let pending: PendingControlRequest | null = null;
  const resolved = new Set<string>();
  for (const e of events || []) {
    const p = e?.payload || {};
    if (p.type === 'control_request') {
      const req = p.request || {};
      if (req.tool_name === 'AskUserQuestion' && p.request_id) {
        pending = {
          requestId: String(p.request_id),
          toolUseId: String(req.tool_use_id || p.request_id),
          questions: (req.input?.questions as PendingQuestion['questions']) || [],
        };
      }
    } else if (p.type === 'control_response') {
      const rid = p.response?.request_id;
      if (rid) resolved.add(String(rid));
    } else if (p.type === 'control_cancel_request') {
      const rid = p.request_id;
      if (rid) resolved.add(String(rid));
    }
  }
  return pending && !resolved.has(pending.requestId) ? pending : null;
}

/**
 * Map an answer to the control_response `answers` object: keyed by the question
 * TEXT → the chosen option label (canonical-cased on a case-insensitive match),
 * or the verbatim free text when no option matches. Single-question (the common
 * AskUserQuestion case). Pure.
 */
export function buildAnswersMap(questions: PendingQuestion['questions'], answer: string): Record<string, string> {
  const out: Record<string, string> = {};
  const a = (answer || '').trim();
  const q0 = questions?.[0];
  if (!q0) return out;
  const key = q0.question || q0.header || 'question';
  const opt = (q0.options || []).find((o) => o.label === a || o.label?.toLowerCase() === a.toLowerCase());
  out[key] = opt ? opt.label : answer;
  return out;
}

/** Build the worker/events control_response payload that answers an AskUserQuestion. Pure. */
export function buildControlResponse(opts: { sessionId: string; requestId: string; questions: PendingQuestion['questions']; answer: string; uuid?: string }) {
  return {
    type: 'control_response' as const,
    response: {
      subtype: 'success' as const,
      request_id: opts.requestId,
      response: {
        behavior: 'allow' as const,
        updatedInput: {
          questions: opts.questions || [],
          answers: buildAnswersMap(opts.questions, opts.answer),
          annotations: {} as Record<string, unknown>,
        },
        updatedPermissions: [] as unknown[],
      },
    },
    session_id: opts.sessionId,
    uuid: opts.uuid || randomUUID(),
  };
}

/**
 * Extract the bridge cse_… that a `claude --remote-control` session records in its OWN local
 * transcript as `{type:'bridge-session', bridgeSessionId:'cse_…'}` lines (written on every
 * bridge (re)connect). Returns the LATEST. This is the robust, general source of a native
 * session's bridge handle — controller AND native executors both write it; a pure-local
 * (non-remote-control) session has none → null. Pure.
 */
export function extractBridgeCse(rawLines: Array<{ type?: string; bridgeSessionId?: string }>): string | null {
  let cse: string | null = null;
  for (const l of rawLines || []) {
    if (l && l.type === 'bridge-session' && typeof l.bridgeSessionId === 'string' && /^cse_[A-Za-z0-9]+$/.test(l.bridgeSessionId)) {
      cse = l.bridgeSessionId;
    }
  }
  return cse;
}

/** Derive a bridge cse_… from a sid that may already be `cse_…` or the `session_…` form. */
export function toBridgeCse(idOrCse: string): string {
  return (idOrCse || '').replace(/^session_/, 'cse_');
}

// ---------------------------------------------------------------------------
// CLIENT side of the relay — read/answer a bridge session's pending question.
// ---------------------------------------------------------------------------
// IMPORTANT: lm-assist acts as the CLIENT (what the claude.ai web UI does), NOT
// the worker. The worker endpoints (`/worker/events`) require the bridge's own
// session-scoped, epoch-bound worker JWT (iss:ccr-service, minted via POST
// /bridge, which BUMPS the epoch) — not third-party usable without disrupting
// the live bridge, and a freshly-minted JWT's stream won't even replay the
// already-pending question (epoch-scoped). The CLIENT endpoints instead use our
// ordinary account OAuth token (ccrOpts) and the backend relays our events down
// to the worker — verified live on 123:
//
//   read   GET  /v1/code/sessions/{cse}/events[?cursor=]   -> { data:[event…], next_cursor }
//   answer POST /v1/code/sessions/{cse}/events { events:[{payload}] }
//
// `data` is NEWEST-first and includes the worker's control_request (AskUserQuestion)
// plus control_response / control_cancel_request resolutions. See memory:
// remote-control-worker-events-protocol + claudeai-web-ui-ccr-code-sessions.

/** One client `/events` row (the shape the web UI consumes). */
interface ClientEvent { event_type?: string; payload?: any; created_at?: string }

/**
 * Read a bridge session's CLIENT event log and extract any pending AskUserQuestion.
 * Pages newest→older via `next_cursor` (a blocked worker's question is among the most
 * recent events, so the default 1 page suffices; `maxPages` bounds a busy session).
 * Account-authed (ccrOpts). Returns null pending on a missing/closed session rather than throwing.
 */
export async function cloudClientEventsRead(cse: string, opts: { maxPages?: number } = {}): Promise<{ events: ClientEvent[]; pendingQuestion: PendingControlRequest | null }> {
  const bridge = toBridgeCse(cse);
  const maxPages = Math.max(1, opts.maxPages ?? 2);
  const collected: ClientEvent[] = [];
  let cursor = '';
  try {
    const ccr = await ccrOpts();
    for (let page = 0; page < maxPages; page++) {
      const res = await anthropicOAuthGet(`/v1/code/sessions/${bridge}/events`, { ...ccr, query: cursor ? `cursor=${encodeURIComponent(cursor)}` : undefined });
      if (res.status < 200 || res.status >= 300) break;
      const body = res.body as { data?: ClientEvent[]; next_cursor?: string };
      const data = body?.data || [];
      collected.push(...data);
      const next = body?.next_cursor;
      if (!next || next === cursor || data.length === 0) break;
      cursor = next;
    }
  } catch { /* best-effort → return what we have */ }
  // `data` is newest-first; findPendingControlRequest wants oldest-first (last unresolved wins).
  const oldestFirst = collected.slice().reverse();
  return { events: collected, pendingQuestion: findPendingControlRequest(oldestFirst as WorkerEvent[]) };
}

/**
 * Answer a pending AskUserQuestion on a bridge session by POSTing a control_response to
 * the CLIENT events endpoint (account-authed — the backend relays it down to the worker's
 * stream, exactly as the web UI does). Auto-resolves the pending request_id/questions from
 * the client log unless given. `cse` = the cloud handle of the `--remote-control` session.
 */
export async function cloudClientEventsAnswer(opts: { cse: string; answer: string; requestId?: string; questions?: PendingQuestion['questions'] }): Promise<{ answered: boolean; cse: string; requestId: string; mode: 'option' | 'input' }> {
  const cse = toBridgeCse(opts.cse);
  const answer = (opts.answer || '').toString();
  if (!answer.trim()) throw new TerminalError('INVALID_INPUT', 'answer is required');
  let requestId = opts.requestId;
  let questions = opts.questions;
  if (!requestId || !questions) {
    const { pendingQuestion } = await cloudClientEventsRead(cse);
    if (!pendingQuestion) throw new TerminalError('PRECONDITION_FAILED', 'no pending AskUserQuestion on the bridge to answer (the worker is not awaiting input)');
    requestId = requestId || pendingQuestion.requestId;
    questions = questions || pendingQuestion.questions;
  }
  const q0 = questions?.[0];
  const isOption = !!(q0?.options || []).find((o) => o.label === answer.trim() || o.label?.toLowerCase() === answer.trim().toLowerCase());
  const payload = buildControlResponse({ sessionId: cse, requestId: requestId!, questions: questions!, answer });
  const res = await anthropicOAuthPost(`/v1/code/sessions/${cse}/events`, { events: [{ payload }] }, await ccrOpts());
  assertOk(res, 'client events answer');
  return { answered: true, cse, requestId: requestId!, mode: isOption ? 'option' : 'input' };
}
