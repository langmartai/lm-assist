// @ts-nocheck
// core/src/github/github-service.ts
// Multi-backend, MULTI-ACCOUNT GitHub action service (api / gh / git) for lm-assist.
// CREDENTIAL-SAFE: tokens are resolved + injected INTERNALLY and are NEVER logged or returned.
// Debug logs (stderr) carry only non-secret info (account, presence, source, masked length).
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isCwdAllowed } from '../utils/cwd-allowlist';

const GH_API = 'https://api.github.com';
const log = (...a: any[]) => console.error('[gh-svc]', ...a);
const mask = (t: any) => (t ? `present(len=${t.length})` : 'absent');
const envSuffix = (acct: any) => String(acct).toUpperCase().replace(/[^A-Z0-9]/g, '_');

function exec(cmd: string, args: string[], { env, cwd, input, timeout = 90000 }: any = {}): Promise<any> {
  return new Promise((resolve) => {
    let p: any;
    try { p = spawn(cmd, args, { env: { ...process.env, ...(env || {}) }, cwd }); }
    catch (e: any) { return resolve({ code: -1, out: '', err: String(e.message || e) }); }
    let out = '', err = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, timeout);
    p.stdout.on('data', (d: any) => (out += d));
    p.stderr.on('data', (d: any) => (err += d));
    p.on('error', (e: any) => { clearTimeout(t); resolve({ code: -1, out, err: String(e.message || e) }); });
    p.on('close', (code: number) => { clearTimeout(t); resolve({ code, out, err }); });
    if (input != null) { p.stdin.write(input); p.stdin.end(); }
  });
}

// ---- accounts config file (~/.lm-assist/github-accounts.json), never logged ----
async function readAccountsFile(): Promise<{ map: Record<string, any>, default: string | null }> {
  const f = path.join(os.homedir(), '.lm-assist', 'github-accounts.json');
  if (!existsSync(f)) return { map: {}, default: null };
  try {
    const j: any = JSON.parse(await readFile(f, 'utf8'));
    const raw = j.accounts && typeof j.accounts === 'object' ? j.accounts : j;
    const map: Record<string, any> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k === 'accounts' || k === 'default') continue;
      map[k] = typeof v === 'string' ? { token: v } : (v || {});
    }
    return { map, default: j.default || null };
  } catch (e: any) { log(`accounts-file parse error: ${String(e.message || e)}`); return { map: {}, default: null }; }
}
function findAcct(map: Record<string, any>, account: string) {
  if (map[account]) return { name: account, cfg: map[account] };
  const lc = String(account).toLowerCase();
  for (const k of Object.keys(map)) if (k.toLowerCase() === lc) return { name: k, cfg: map[k] };
  return null;
}

// ---- gh hosts.yml parse (both formats), token values stay in-process ----
async function readHostsYml(): Promise<{ users: Record<string, string | null>, active: string | null, top: any }> {
  const hy = path.join(os.homedir(), '.config', 'gh', 'hosts.yml');
  const win = process.env.APPDATA ? path.join(process.env.APPDATA, 'GitHub CLI', 'hosts.yml') : null;
  const file = existsSync(hy) ? hy : (win && existsSync(win) ? win : null);
  if (!file) return { users: {}, active: null, top: null };
  const txt = await readFile(file, 'utf8');
  const users: Record<string, string | null> = {};
  const um = txt.match(/^\s*users:\s*$([\s\S]*?)(?=^\S|\Z)/m);
  if (um) {
    const re = /^( {4,8})([A-Za-z0-9-]+):\s*$([\s\S]*?)(?=^\1\S|^ {0,4}\S|\Z)/gm;
    let m: any; while ((m = re.exec(um[1])) !== null) {
      const name = m[2]; const tm = m[3].match(/oauth_token:\s*(\S+)/);
      users[name] = tm ? tm[1] : null;
    }
  }
  const topTok = txt.match(/^\s{2,4}oauth_token:\s*(\S+)/m);
  const topUser = txt.match(/^\s{2,4}user:\s*(\S+)/m);
  const active = topUser ? topUser[1] : ((txt.match(/^\s*user:\s*(\S+)/m) || [])[1] || null);
  return { users, active, top: topTok ? { user: topUser ? topUser[1] : active, token: topTok[1] } : null };
}

// ---- token resolver: account-aware, multi-source, never logs the value ----
async function resolveToken(account?: string): Promise<any> {
  if (account) {
    const ev = process.env[`LM_ASSIST_GITHUB_TOKEN_${envSuffix(account)}`];
    if (ev) return { token: ev, source: `env:LM_ASSIST_GITHUB_TOKEN_${envSuffix(account)}`, account };
    const { map } = await readAccountsFile();
    const hit = findAcct(map, account);
    if (hit && hit.cfg.token) return { token: hit.cfg.token, source: 'file:github-accounts.json', account: hit.name, cfg: hit.cfg };
    const g = await exec('gh', ['auth', 'token', '--user', account]);
    if (g.code === 0 && g.out.trim()) return { token: g.out.trim(), source: 'gh:auth-token --user', account };
    const hy = await readHostsYml();
    if (hy.users[account]) return { token: hy.users[account], source: 'gh:hosts.yml users', account };
    const lc = account.toLowerCase();
    for (const [k, v] of Object.entries(hy.users)) if (k.toLowerCase() === lc && v) return { token: v, source: 'gh:hosts.yml users', account: k };
    if (hy.top && hy.top.user && String(hy.top.user).toLowerCase() === lc) return { token: hy.top.token, source: 'gh:hosts.yml', account: hy.top.user };
    return { token: null, source: null, account, reason: 'account_not_resolved' };
  }
  for (const k of ['LM_ASSIST_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'])
    if (process.env[k]) return { token: process.env[k], source: `env:${k}`, account: null };
  const f = path.join(os.homedir(), '.lm-assist', 'github-token');
  if (existsSync(f)) { const t = (await readFile(f, 'utf8')).trim(); if (t) return { token: t, source: 'file:~/.lm-assist/github-token', account: null }; }
  const g = await exec('gh', ['auth', 'token']);
  if (g.code === 0 && g.out.trim()) return { token: g.out.trim(), source: 'gh:auth-token', account: null };
  const hy = await readHostsYml();
  if (hy.top && hy.top.token) return { token: hy.top.token, source: 'gh:hosts.yml', account: hy.top.user };
  for (const [k, v] of Object.entries(hy.users)) if (v) return { token: v, source: 'gh:hosts.yml users', account: k };
  return { token: null, source: null, account: null };
}

// ---- enumerate available accounts (NO tokens ever) ----
export async function listAccounts(): Promise<any> {
  const accounts: Record<string, any> = {};
  const add = (name: string, src: string) => { if (!name) return; (accounts[name] ||= { account: name, sources: [] }); if (!accounts[name].sources.includes(src)) accounts[name].sources.push(src); };
  for (const k of Object.keys(process.env)) { const m = k.match(/^LM_ASSIST_GITHUB_TOKEN_(.+)$/); if (m) add(m[1], 'env'); }
  const { map, default: fileDefault } = await readAccountsFile();
  for (const k of Object.keys(map)) add(k, 'file');
  let ghActive: string | null = null;
  const st = await exec('gh', ['auth', 'status']);
  if (st.code === 0 || st.out || st.err) {
    const text = (st.out || '') + '\n' + (st.err || '');
    let last: string | null = null;
    for (const ln of text.split('\n')) {
      const m = ln.match(/(?:account|as) ([A-Za-z0-9][A-Za-z0-9-]*)/);
      if (m) { last = m[1]; add(last, 'gh'); }
      if (/Active account:\s*true/i.test(ln) && last) ghActive = last;
    }
    if (!ghActive && last) ghActive = last;
  }
  const hy = await readHostsYml();
  for (const k of Object.keys(hy.users)) add(k, 'hosts.yml');
  if (hy.top && hy.top.user) add(hy.top.user, 'hosts.yml');
  const activeDefault = fileDefault || ghActive || hy.active || null;
  const list = Object.values(accounts).map((a: any) => ({ ...a, active: a.account === activeDefault }));
  return { accounts: list, default: activeDefault };
}

async function which(bin: string) { return (await exec('bash', ['-lc', `command -v ${bin} || true`])).out.trim() || (await exec(process.platform === 'win32' ? 'where' : 'which', [bin])).out.trim(); }

export async function probeBackends(account?: string) {
  const { token, source, account: acct } = await resolveToken(account);
  const api = { available: !!token, source: token ? source : null, reason: token ? null : (account ? 'account_not_resolved' : 'no_token_source') };
  let gh: any = { available: false, reason: 'not_installed' };
  if (await which('gh')) { const st = await exec('gh', ['auth', 'status']); gh = st.code === 0 ? { available: true, reason: null } : { available: false, reason: 'not_authenticated' }; }
  let git: any = { available: false, reason: 'not_installed' };
  if (await which('git')) {
    const ssh = await exec('bash', ['-lc', 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -T git@github.com 2>&1 | grep -q "successfully authenticated" && echo ssh || true']);
    const hasSsh = ssh.out.includes('ssh');
    const id = (await exec('bash', ['-lc', 'git config --global user.email || true'])).out.trim();
    git = { available: true, auth: token ? 'https-token' : (hasSsh ? 'ssh' : 'none'), hasIdentity: !!id, reason: (token || hasSsh) ? null : 'no_git_credential' };
  }
  return { account: acct || account || null, tokenPresent: !!token, tokenSource: source, api, gh, git };
}

function classifyHttp(status: number, body: string) {
  if (status === 401) return { code: 'AUTH_INVALID', message: 'bad credentials' };
  if (status === 403) return /rate limit/i.test(body) ? { code: 'RATE_LIMITED', message: 'rate limited' } : { code: 'FORBIDDEN', message: 'forbidden (scope/permission/installation)' };
  if (status === 404) return { code: 'NOT_FOUND', message: 'not found (repo missing or no access)' };
  if (status === 409) return { code: 'CONFLICT', message: 'conflict' };
  if (status === 410) return { code: 'GONE', message: 'gone (feature disabled on repo)' };
  if (status === 422) return { code: 'VALIDATION', message: 'validation failed' };
  if (status >= 500) return { code: 'SERVER', message: `github ${status}` };
  return { code: 'HTTP', message: `http ${status}` };
}

async function apiCall(method: string, p: string, body: any, token: any) {
  if (!token) return { ok: false, error: { code: 'AUTH_MISSING', message: 'no token available for api backend', backend: 'api' } };
  const _fetch = (globalThis as any).fetch;
  if (typeof _fetch !== 'function') return { ok: false, error: { code: 'BACKEND_UNAVAILABLE', message: 'fetch unavailable (node<18)', backend: 'api' } };
  let res: any;
  try {
    res = await _fetch(GH_API + p, { method, headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'lm-assist-github' }, body: body ? JSON.stringify(body) : undefined });
  } catch (e: any) { return { ok: false, error: { code: 'NETWORK', message: String(e.message || e), backend: 'api' } }; }
  const text = await res.text(); let data: any; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) return { ok: false, error: { ...classifyHttp(res.status, text), backend: 'api', status: res.status } };
  return { ok: true, backend: 'api', data };
}

async function ghCall(args: string[], token: any) {
  if (!(await which('gh'))) return { ok: false, error: { code: 'BACKEND_UNAVAILABLE', message: 'gh not installed', backend: 'gh' } };
  const r = await exec('gh', args, token ? { env: { GH_TOKEN: token } } : {});
  if (r.code !== 0) {
    let code = 'GH_ERROR'; const e = r.err || '';
    if (/not found|Could not resolve/i.test(e)) code = 'NOT_FOUND';
    else if (/auth|login|HTTP 401/i.test(e)) code = 'AUTH_INVALID';
    else if (/HTTP 403/i.test(e)) code = 'FORBIDDEN';
    return { ok: false, error: { code, message: e.trim().slice(0, 300), backend: 'gh' } };
  }
  let data: any; try { data = JSON.parse(r.out); } catch { data = r.out.trim(); }
  return { ok: true, backend: 'gh', data };
}

const WORKDIR_ROOT = path.join(os.homedir(), '.lm-assist', 'github-workdirs');
function httpsHeaderEnv(token: string) { return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from('x-access-token:' + token).toString('base64')}` }; }
// Resolve the working directory for a git op. A caller-supplied `dir` is gated by the lm-assist
// allowlist (same gate as agent_execute, /home/ubuntu/*). The default managed scratch dir is the
// ONLY one ever wiped; a caller dir is never clobbered.
async function gitClone(owner: string, repo: string, token: any, { ssh = false, sshHost = 'github.com', dir: targetDir, depth = 1 }: any = {}) {
  if (!(await which('git'))) return { ok: false, error: { code: 'BACKEND_UNAVAILABLE', message: 'git not installed', backend: 'git' } };
  let dir: string, managed = false;
  if (targetDir) {
    if (!isCwdAllowed(String(targetDir))) return { ok: false, error: { code: 'FORBIDDEN_DIR', message: `dir "${targetDir}" is outside the lm-assist allowlist (/home/ubuntu/*)`, backend: 'git' } };
    dir = path.resolve(String(targetDir));
    if (existsSync(dir)) {
      const entries = await readdir(dir).catch(() => [] as string[]);
      if (entries.length) return { ok: false, error: { code: 'DIR_NOT_EMPTY', message: `dir "${dir}" exists and is not empty; refusing to clobber`, backend: 'git' } };
    }
    await mkdir(dir, { recursive: true });
  } else {
    dir = path.join(WORKDIR_ROOT, owner, repo); managed = true;
    await rm(dir, { recursive: true, force: true }); await mkdir(path.dirname(dir), { recursive: true });
  }
  let url: string, env: any = {};
  if (ssh) url = `git@${sshHost}:${owner}/${repo}.git`;
  else if (token) { url = `https://github.com/${owner}/${repo}.git`; env = httpsHeaderEnv(token); }
  else return { ok: false, error: { code: 'AUTH_MISSING', message: 'no token/ssh for git clone', backend: 'git' } };
  const args = ['clone'];
  if (depth && Number(depth) > 0) args.push('--depth', String(depth));
  args.push(url, dir);
  const r = await exec('git', args, { env });
  if (r.code !== 0) { let code = 'GIT_ERROR'; if (/Authentication failed|403|denied/i.test(r.err)) code = 'AUTH_INVALID'; else if (/not found|Repository not found/i.test(r.err)) code = 'NOT_FOUND'; return { ok: false, error: { code, message: r.err.trim().slice(0, 300), backend: 'git' } }; }
  return { ok: true, backend: 'git', data: { dir, managed } };
}
async function gitCommitPush(owner: string, repo: string, token: any, { branch, files = [], message, ssh = false, sshHost = 'github.com', name = 'lm-assist', email = 'lm-assist@local', dir: targetDir }: any) {
  const env = ssh ? {} : httpsHeaderEnv(token);
  let dir: string;
  if (targetDir) {
    // operate IN PLACE on an existing allowlisted checkout — no clone, no wipe.
    if (!isCwdAllowed(String(targetDir))) return { ok: false, error: { code: 'FORBIDDEN_DIR', message: `dir "${targetDir}" is outside the lm-assist allowlist (/home/ubuntu/*)`, backend: 'git' } };
    dir = path.resolve(String(targetDir));
    if (!existsSync(path.join(dir, '.git'))) return { ok: false, error: { code: 'NOT_A_REPO', message: `dir "${dir}" is not a git repository (clone it first)`, backend: 'git' } };
  } else {
    if (!branch) return { ok: false, error: { code: 'VALIDATION', message: 'branch is required for a managed-scratch commit-push', backend: 'git' } };
    const cl: any = await gitClone(owner, repo, token, { ssh, sshHost }); if (!cl.ok) return cl;
    dir = cl.data.dir;
  }
  await exec('git', ['config', 'user.name', name], { cwd: dir });
  await exec('git', ['config', 'user.email', email], { cwd: dir });
  if (branch) {
    const co = await exec('git', ['checkout', '-b', branch], { cwd: dir });
    if (co.code !== 0) {
      const co2 = await exec('git', ['checkout', branch], { cwd: dir }); // branch may already exist in a real checkout
      if (co2.code !== 0) return { ok: false, error: { code: 'CHECKOUT_FAILED', message: co.err.trim().slice(0, 200), backend: 'git' } };
    }
  }
  for (const f of files) await writeFile(path.join(dir, f.path), f.content);
  await exec('git', ['add', '-A'], { cwd: dir });
  const cm = await exec('git', ['commit', '-m', message], { cwd: dir });
  if (cm.code !== 0) return { ok: false, error: { code: 'COMMIT_FAILED', message: cm.err.trim().slice(0, 200), backend: 'git' } };
  const pushRef = branch || 'HEAD';
  const ps = await exec('git', ['push', '-u', 'origin', pushRef], { cwd: dir, env });
  if (ps.code !== 0) { let code = 'PUSH_FAILED'; if (/denied|403|Authentication/i.test(ps.err)) code = 'AUTH_INVALID'; else if (/rejected|non-fast-forward/i.test(ps.err)) code = 'PUSH_REJECTED'; return { ok: false, error: { code, message: ps.err.trim().slice(0, 300), backend: 'git' } }; }
  return { ok: true, backend: 'git', data: { branch: branch || null, dir, pushed: true } };
}

// Defense-in-depth: scrub any credential-shaped value (or known secret-bearing key) from EVERY
// response, so the endpoint can never emit a token even if a backend or GitHub field leaks one.
const SECRET_KEY_RE = /^(temp_clone_token|clone_token|oauth_token|access_token|refresh_token|client_secret|authorization|token)$/i;
const TOKENISH_RE = /(gh[oprsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g;
export function redactDeep(v: any): any {
  if (v == null) return v;
  if (typeof v === 'string') return v.replace(TOKENISH_RE, '<REDACTED>');
  if (Array.isArray(v)) return v.map(redactDeep);
  if (typeof v === 'object') {
    const o: any = {};
    for (const [k, val] of Object.entries(v)) o[k] = SECRET_KEY_RE.test(k) ? '<REDACTED>' : redactDeep(val);
    return o;
  }
  return v;
}

const ACTIONS: Record<string, (p: any, t: any) => Promise<any>> = {
  'auth/status': async (p) => ({ ok: true, data: await probeBackends(p.account) }),
  'accounts/list': async () => ({ ok: true, data: await listAccounts() }),
  whoami: async (_p, t) => (t.token ? apiCall('GET', '/user', null, t.token) : ghCall(['api', 'user'], t.token)),
  'repo/get': async ({ owner, repo }, t) => (t.token ? apiCall('GET', `/repos/${owner}/${repo}`, null, t.token) : ghCall(['api', `repos/${owner}/${repo}`], t.token)),
  'pr/list': async ({ owner, repo, state = 'open' }, t) => (t.token ? apiCall('GET', `/repos/${owner}/${repo}/pulls?state=${state}`, null, t.token) : ghCall(['pr', 'list', '-R', `${owner}/${repo}`, '--json', 'number,title,state'], t.token)),
  'repo/list': async ({ owner, visibility, sort = 'pushed', per_page = 30, page = 1 }, t) => {
    if (!t.token) return { ok: false, error: { code: 'AUTH_MISSING', message: 'repo/list needs a token', backend: 'api' } };
    const qs = new URLSearchParams({ sort: String(sort), per_page: String(per_page), page: String(page) });
    let p: string;
    if (owner) { p = `/users/${owner}/repos?${qs.toString()}`; }               // a specific user/org's repos
    else { if (visibility) qs.set('visibility', String(visibility)); p = `/user/repos?${qs.toString()}`; } // the account's own repos
    const r: any = await apiCall('GET', p, null, t.token);
    if (!r.ok) return r;
    const list = Array.isArray(r.data)
      ? r.data.map((x: any) => ({ full_name: x.full_name, private: x.private, default_branch: x.default_branch, pushed_at: x.pushed_at, html_url: x.html_url }))
      : r.data;
    return { ok: true, backend: 'api', data: { count: Array.isArray(list) ? list.length : 0, repos: list } };
  },
  'issue/create': async ({ owner, repo, title, body }, t) => (t.token ? apiCall('POST', `/repos/${owner}/${repo}/issues`, { title, body }, t.token) : ghCall(['issue', 'create', '-R', `${owner}/${repo}`, '-t', title, '-b', body || ''], t.token)),
  'issue/close': async ({ owner, repo, number }, t) => apiCall('PATCH', `/repos/${owner}/${repo}/issues/${number}`, { state: 'closed' }, t.token),
  'pr/create': async ({ owner, repo, title, head, base = 'main', body }, t) => (t.token ? apiCall('POST', `/repos/${owner}/${repo}/pulls`, { title, head, base, body }, t.token) : ghCall(['pr', 'create', '-R', `${owner}/${repo}`, '-t', title, '-B', base, '-H', head, '-b', body || ''], t.token)),
  'pr/close': async ({ owner, repo, number }, t) => apiCall('PATCH', `/repos/${owner}/${repo}/pulls/${number}`, { state: 'closed' }, t.token),
  'branch/delete': async ({ owner, repo, branch }, t) => apiCall('DELETE', `/repos/${owner}/${repo}/git/refs/heads/${branch}`, null, t.token),
  'file/put': async ({ owner, repo, path: fp, content, message, branch }, t) => apiCall('PUT', `/repos/${owner}/${repo}/contents/${fp}`, { message, content: Buffer.from(content).toString('base64'), branch }, t.token),
  fork: async ({ owner, repo, organization }, t) => apiCall('POST', `/repos/${owner}/${repo}/forks`, organization ? { organization } : {}, t.token),
  'git/clone': async ({ owner, repo, ssh, sshHost, dir, depth }, t) => gitClone(owner, repo, t.token, { ssh, sshHost, dir, depth }),
  'git/commit-push': async (p, t) => gitCommitPush(p.owner, p.repo, t.token, p),
  gh: async ({ args }, t) => {
    const a = (args || []).map(String);
    // the gh passthrough must never be usable to READ a credential out of the host
    if (a[0] === 'auth' || (a[0] === 'config' && a[1] === 'get' && a.join(' ').toLowerCase().includes('token'))) {
      return { ok: false, error: { code: 'FORBIDDEN_PASSTHROUGH', message: 'gh passthrough may not read credentials (gh auth / config-get token are blocked)', backend: 'gh' } };
    }
    return ghCall(a, t.token);
  },
  api: async ({ method = 'GET', path: ap, body }, t) => apiCall(method, ap, body, t.token),
};

export async function runAction(action: string, params: any = {}) {
  const fn = ACTIONS[action];
  if (!fn) return { ok: false, error: { code: 'UNKNOWN_ACTION', message: `no action ${action}` } };
  const t = await resolveToken(params.account);
  log(`action=${action} account=${t.account || params.account || 'default'} token=${mask(t.token)} source=${t.source || 'none'}`);
  // multi-account safety: an explicitly requested account that can't be resolved must NOT silently
  // fall back to ambient gh/SSH auth (which would act as a DIFFERENT account). Fail closed instead.
  if (params.account && !t.token && action !== 'auth/status' && action !== 'accounts/list') {
    return { ok: false, error: { code: 'AUTH_MISSING', message: `account "${params.account}" not resolved on this host (no env/file/gh/hosts.yml credential)`, backend: 'api', account: params.account } };
  }
  try { const r = await fn(params, t); return redactDeep(r); } catch (e: any) { return { ok: false, error: { code: 'INTERNAL', message: String(e.message || e) } }; }
}

export const GITHUB_ACTIONS = Object.keys(ACTIONS);
