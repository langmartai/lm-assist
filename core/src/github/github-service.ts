// @ts-nocheck
// core/src/github/github-service.ts
// Multi-backend GitHub action service (api / gh / git) for lm-assist.
// CREDENTIAL-SAFE: the token is resolved + injected INTERNALLY and is NEVER logged or returned.
// Debug logs (stderr) carry only non-secret info (presence, source, masked length).
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const GH_API = 'https://api.github.com';
const log = (...a: any[]) => console.error('[gh-svc]', ...a);
const mask = (t: any) => (t ? `present(len=${t.length})` : 'absent');

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

async function resolveToken() {
  for (const k of ['LM_ASSIST_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'])
    if (process.env[k]) return { token: process.env[k], source: `env:${k}` };
  const f = path.join(os.homedir(), '.lm-assist', 'github-token');
  if (existsSync(f)) { const t = (await readFile(f, 'utf8')).trim(); if (t) return { token: t, source: 'file:~/.lm-assist/github-token' }; }
  const g = await exec('gh', ['auth', 'token']);
  if (g.code === 0 && g.out.trim()) return { token: g.out.trim(), source: 'gh:auth-token' };
  const hy = path.join(os.homedir(), '.config', 'gh', 'hosts.yml');
  if (existsSync(hy)) { const m = (await readFile(hy, 'utf8')).match(/oauth_token:\s*(\S+)/); if (m) return { token: m[1], source: 'gh:hosts.yml' }; }
  return { token: null, source: null };
}

async function which(bin: string) { return (await exec('bash', ['-lc', `command -v ${bin} || true`])).out.trim(); }

export async function probeBackends() {
  const { token, source } = await resolveToken();
  const api = { available: !!token, source: token ? source : null, reason: token ? null : 'no_token_source' };
  let gh: any = { available: false, reason: 'not_installed' };
  if (await which('gh')) { const st = await exec('gh', ['auth', 'status']); gh = st.code === 0 ? { available: true, reason: null } : { available: false, reason: 'not_authenticated' }; }
  let git: any = { available: false, reason: 'not_installed' };
  if (await which('git')) {
    const ssh = await exec('bash', ['-lc', 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -T git@github.com 2>&1 | grep -q "successfully authenticated" && echo ssh || true']);
    const hasSsh = ssh.out.includes('ssh');
    const id = (await exec('bash', ['-lc', 'git config --global user.email || true'])).out.trim();
    git = { available: true, auth: token ? 'https-token' : (hasSsh ? 'ssh' : 'none'), hasIdentity: !!id, reason: (token || hasSsh) ? null : 'no_git_credential' };
  }
  return { tokenPresent: !!token, tokenSource: source, api, gh, git };
}

function classifyHttp(status: number, body: string) {
  if (status === 401) return { code: 'AUTH_INVALID', message: 'bad credentials' };
  if (status === 403) return /rate limit/i.test(body) ? { code: 'RATE_LIMITED', message: 'rate limited' } : { code: 'FORBIDDEN', message: 'forbidden (scope/permission/installation)' };
  if (status === 404) return { code: 'NOT_FOUND', message: 'not found (repo missing or no access)' };
  if (status === 409) return { code: 'CONFLICT', message: 'conflict' };
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
async function gitClone(owner: string, repo: string, token: any, { ssh = false }: any = {}) {
  if (!(await which('git'))) return { ok: false, error: { code: 'BACKEND_UNAVAILABLE', message: 'git not installed', backend: 'git' } };
  const dir = path.join(WORKDIR_ROOT, owner, repo);
  await rm(dir, { recursive: true, force: true }); await mkdir(path.dirname(dir), { recursive: true });
  let url: string, env: any = {};
  if (ssh) url = `git@github.com:${owner}/${repo}.git`;
  else if (token) { url = `https://github.com/${owner}/${repo}.git`; env = httpsHeaderEnv(token); }
  else return { ok: false, error: { code: 'AUTH_MISSING', message: 'no token/ssh for git clone', backend: 'git' } };
  const r = await exec('git', ['clone', '--depth', '1', url, dir], { env });
  if (r.code !== 0) { let code = 'GIT_ERROR'; if (/Authentication failed|403|denied/i.test(r.err)) code = 'AUTH_INVALID'; else if (/not found|Repository not found/i.test(r.err)) code = 'NOT_FOUND'; return { ok: false, error: { code, message: r.err.trim().slice(0, 300), backend: 'git' } }; }
  return { ok: true, backend: 'git', data: { dir } };
}
async function gitCommitPush(owner: string, repo: string, token: any, { branch, files, message, ssh = false, name = 'lm-assist', email = 'lm-assist@local' }: any) {
  const cl: any = await gitClone(owner, repo, token, { ssh }); if (!cl.ok) return cl;
  const dir = cl.data.dir; const env = ssh ? {} : httpsHeaderEnv(token);
  await exec('git', ['config', 'user.name', name], { cwd: dir });
  await exec('git', ['config', 'user.email', email], { cwd: dir });
  await exec('git', ['checkout', '-b', branch], { cwd: dir });
  for (const f of files) await writeFile(path.join(dir, f.path), f.content);
  await exec('git', ['add', '-A'], { cwd: dir });
  const cm = await exec('git', ['commit', '-m', message], { cwd: dir });
  if (cm.code !== 0) return { ok: false, error: { code: 'COMMIT_FAILED', message: cm.err.trim().slice(0, 200), backend: 'git' } };
  const ps = await exec('git', ['push', '-u', 'origin', branch], { cwd: dir, env });
  if (ps.code !== 0) { let code = 'PUSH_FAILED'; if (/denied|403|Authentication/i.test(ps.err)) code = 'AUTH_INVALID'; else if (/rejected|non-fast-forward/i.test(ps.err)) code = 'PUSH_REJECTED'; return { ok: false, error: { code, message: ps.err.trim().slice(0, 300), backend: 'git' } }; }
  return { ok: true, backend: 'git', data: { branch, pushed: true } };
}

const ACTIONS: Record<string, (p: any, t: any) => Promise<any>> = {
  'auth/status': async () => ({ ok: true, data: await probeBackends() }),
  whoami: async (_p, t) => (t.token ? apiCall('GET', '/user', null, t.token) : ghCall(['api', 'user'], null)),
  'repo/get': async ({ owner, repo }, t) => (t.token ? apiCall('GET', `/repos/${owner}/${repo}`, null, t.token) : ghCall(['api', `repos/${owner}/${repo}`], null)),
  'pr/list': async ({ owner, repo, state = 'open' }, t) => (t.token ? apiCall('GET', `/repos/${owner}/${repo}/pulls?state=${state}`, null, t.token) : ghCall(['pr', 'list', '-R', `${owner}/${repo}`, '--json', 'number,title,state'], null)),
  'issue/create': async ({ owner, repo, title, body }, t) => (t.token ? apiCall('POST', `/repos/${owner}/${repo}/issues`, { title, body }, t.token) : ghCall(['issue', 'create', '-R', `${owner}/${repo}`, '-t', title, '-b', body || ''], null)),
  'issue/close': async ({ owner, repo, number }, t) => apiCall('PATCH', `/repos/${owner}/${repo}/issues/${number}`, { state: 'closed' }, t.token),
  'pr/create': async ({ owner, repo, title, head, base = 'main', body }, t) => (t.token ? apiCall('POST', `/repos/${owner}/${repo}/pulls`, { title, head, base, body }, t.token) : ghCall(['pr', 'create', '-R', `${owner}/${repo}`, '-t', title, '-B', base, '-H', head, '-b', body || ''], null)),
  'pr/close': async ({ owner, repo, number }, t) => apiCall('PATCH', `/repos/${owner}/${repo}/pulls/${number}`, { state: 'closed' }, t.token),
  'branch/delete': async ({ owner, repo, branch }, t) => apiCall('DELETE', `/repos/${owner}/${repo}/git/refs/heads/${branch}`, null, t.token),
  'file/put': async ({ owner, repo, path: fp, content, message, branch }, t) => apiCall('PUT', `/repos/${owner}/${repo}/contents/${fp}`, { message, content: Buffer.from(content).toString('base64'), branch }, t.token),
  'git/clone': async ({ owner, repo, ssh }, t) => gitClone(owner, repo, t.token, { ssh }),
  'git/commit-push': async (p, t) => gitCommitPush(p.owner, p.repo, t.token, p),
  gh: async ({ args }, t) => ghCall(args, t.token),
  api: async ({ method = 'GET', path: ap, body }, t) => apiCall(method, ap, body, t.token),
};

export async function runAction(action: string, params: any = {}) {
  const fn = ACTIONS[action];
  if (!fn) return { ok: false, error: { code: 'UNKNOWN_ACTION', message: `no action ${action}` } };
  const t = await resolveToken();
  log(`action=${action} token=${mask(t.token)} source=${t.source || 'none'}`);
  try { return await fn(params, t); } catch (e: any) { return { ok: false, error: { code: 'INTERNAL', message: String(e.message || e) } }; }
}

export const GITHUB_ACTIONS = Object.keys(ACTIONS);
