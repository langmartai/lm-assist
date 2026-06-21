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
  anthropicOAuthDelete,
  getValidAccessToken,
  getOrganizationUuid,
} from '../utils/claude-oauth';

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
export function buildSetupPreamble(): string {
  const apiPort = 3100;
  return [
    "[lm-assist setup] The user asked to install lm-assist (their own dev tooling) in this container — it is NOT installed here. Install it LOCALLY. IMPORTANT: install the user's CUSTOM build from their public GitHub source — the npm-published `lm-assist` is an OLDER build, do not use it:",
    '',
    '  npm install -g github:langmartai/lm-assist     # the custom build (NOT `npm i -g lm-assist`, which is stale)',
    '  claude plugin install lm-assist@langmartai      # adds the lm-assist MCP tools + context hook',
    '  lm-assist start                                 # boots Core locally on :' + apiPort + ' (LOCAL-only — no external connection)',
    `  curl -s localhost:${apiPort}/health             # expect ok`,
    '',
    `This gives you LOCAL lm-assist — its capability guide (call \`bootstrap\` once the MCP is loaded), local session tracking, knowledge, etc., reachable over the CLI and \`curl -s localhost:${apiPort}/...\`. The lm-assist MCP TOOLS attach at the start of your NEXT Claude Code session; in THIS one reach it over HTTP/CLI. lm-assist COMPLEMENTS your built-in tools.`,
    '',
    "To CONNECT this node to the user's lm-assist HUB (to reach their cross-node fleet/data) is a SEPARATE, deliberate step — ASK the user to confirm and provide the hub URL + key; do NOT wire this container to any external hub on your own. Then proceed with the task below.",
    '',
    '────────  task  ────────',
    '',
  ].join('\n');
}

/**
 * Build the POST /v1/sessions body — a create carries the initial user turn (wrapped event).
 * Seed EITHER via `sources` (GitHub repos — the standard) OR `seedFileId` (local git bundle).
 */
export function buildCreateBody(opts: { prompt?: string; model: string; environmentId: string; title?: string; seedFileId?: string; sources?: unknown[] }) {
  const session_context: Record<string, unknown> = {
    sources: opts.sources || [],
    outcomes: [],
    model: opts.model,
  };
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
export async function cloudStart(opts: { prompt?: string; repo?: string; branch?: string; cwd?: string; model?: string; title?: string; setup?: boolean }): Promise<CloudStartResult> {
  const prompt = (opts.prompt || '').toString().trim();
  const hasRepo = !!(opts.repo && opts.repo.trim());
  const hasCwd = !!(opts.cwd && opts.cwd.trim());
  // Prompt is optional: a session can boot from just a repo (clones + waits) or just lm-assist setup.
  if (!prompt && !hasRepo && !hasCwd && !opts.setup) throw new TerminalError('INVALID_INPUT', 'provide a repo or a prompt to start a cloud session');
  const model = opts.model || DEFAULT_MODEL;
  const environmentId = await getEnvironmentId();

  // Optional lm-assist INSTALL-ONLY setup: prepend install instructions to the first turn so the
  // fresh container installs lm-assist locally (no hub key / external connect — that's a separate
  // in-session step the user confirms).
  let effectivePrompt = prompt;
  let setupApplied = false;
  if (opts.setup) {
    effectivePrompt = buildSetupPreamble() + (prompt || 'Then await my instructions.');
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

  const res = await anthropicOAuthPost('/v1/sessions', buildCreateBody({ prompt: effectivePrompt, model, environmentId, title: opts.title, seedFileId, sources }), await ccrOpts());
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
  return { sid, webUrl: rec.webUrl, status, model, repo: repoSlug, branch, cwd, environmentId, setup: setupApplied };
}

/** Drive a follow-up turn into a cloud session. */
export async function cloudDrive(opts: { sid: string; text: string }): Promise<{ delivered: boolean; sid: string; eventId?: string }> {
  if (!isCloudSid(opts.sid)) throw new TerminalError('INVALID_INPUT', 'sid must look like session_…');
  const text = (opts.text || '').toString();
  if (!text.trim()) throw new TerminalError('INVALID_INPUT', 'text is required');
  const res = await anthropicOAuthPost(`/v1/sessions/${opts.sid}/events`, { events: [buildDriveEvent(opts.sid, text)] }, await ccrOpts());
  assertOk(res, 'cloud drive');
  const r = res.body && Array.isArray(res.body.results) ? res.body.results[0] : undefined;
  return { delivered: true, sid: opts.sid, eventId: r?.event_id };
}

/** Read a cloud session's transcript (teleport-events) + any pending question awaiting an answer. */
export async function cloudRead(opts: { sid: string; lastN?: number }): Promise<{ sid: string; messages: CloudTranscriptMsg[]; pendingQuestion: PendingQuestion | null }> {
  if (!isCloudSid(opts.sid)) throw new TerminalError('INVALID_INPUT', 'sid must look like session_…');
  const res = await anthropicOAuthGet(`/v1/code/sessions/${opts.sid}/teleport-events`, await ccrOpts());
  assertOk(res, 'cloud read');
  const events = ((res.body as { data?: any[] })?.data) || [];
  let messages = parseTeleportTranscript(res.body);
  if (opts.lastN && opts.lastN > 0) messages = messages.slice(-opts.lastN);
  return { sid: opts.sid, messages, pendingQuestion: findPendingQuestion(events) };
}

/**
 * Answer a pending question (AskUserQuestion) in a cloud session by POSTing a tool_result.
 * `answer` = an option's label (a CLICK) or arbitrary text (free INPUT) — both handled. The
 * tool_use_id auto-resolves from the session's pending question unless given explicitly.
 */
export async function cloudAnswer(opts: { sid: string; answer: string; toolUseId?: string }): Promise<{ answered: boolean; sid: string; toolUseId: string; mode: 'option' | 'input'; sentContent: string }> {
  if (!isCloudSid(opts.sid)) throw new TerminalError('INVALID_INPUT', 'sid must look like session_…');
  const answer = (opts.answer || '').toString();
  if (!answer.trim()) throw new TerminalError('INVALID_INPUT', 'answer is required');
  const res = await anthropicOAuthGet(`/v1/code/sessions/${opts.sid}/teleport-events`, await ccrOpts());
  assertOk(res, 'cloud read');
  const events = ((res.body as { data?: any[] })?.data) || [];
  const pending = findPendingQuestion(events);
  const toolUseId = opts.toolUseId || pending?.toolUseId;
  if (!toolUseId) throw new TerminalError('PRECONDITION_FAILED', 'no pending AskUserQuestion to answer in this session');
  const q = pending?.questions?.[0];
  const isOption = !!(q?.options || []).find((o) => o.label === answer.trim() || o.label?.toLowerCase() === answer.trim().toLowerCase());
  const content = formatAnswerContent(pending?.questions || [], answer);
  const post = await anthropicOAuthPost(`/v1/sessions/${opts.sid}/events`, { events: [buildAnswerEvent(opts.sid, toolUseId, content)] }, await ccrOpts());
  assertOk(post, 'cloud answer');
  return { answered: true, sid: opts.sid, toolUseId, mode: isOption ? 'option' : 'input', sentContent: content };
}

/** Get raw cloud session status. */
export async function cloudStatus(sid: string): Promise<{ sid: string; status: string; connectionStatus?: string; raw: any }> {
  if (!isCloudSid(sid)) throw new TerminalError('INVALID_INPUT', 'sid must look like session_…');
  const res = await anthropicOAuthGet(`/v1/code/sessions/${sid}`, await ccrOpts());
  assertOk(res, 'cloud status');
  const b = res.body as Record<string, any>;
  const shape = b?.response_shape || b;
  return { sid, status: shape?.session_status || shape?.status || 'unknown', connectionStatus: shape?.connection_status, raw: shape };
}

/** Stop (delete) a cloud session and drop it from the registry. */
export async function cloudStop(sid: string): Promise<{ stopped: boolean; sid: string }> {
  if (!isCloudSid(sid)) throw new TerminalError('INVALID_INPUT', 'sid must look like session_…');
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
