/**
 * Google Colab CLI (`google-colab-cli` / `colab`) service for lm-assist.
 *
 * Wraps the official `colab` CLI with strict argument validation, local path
 * allowlist checks (`isCwdAllowed`), token redaction, and structured errors.
 * Note: upstream `google-colab-cli` supports Linux and macOS (not Windows), so
 * callers on multi-node setups should target a Linux/macOS node when running
 * from a Windows coordinator.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describeCwdPolicy, isCwdAllowed } from '../utils/cwd-allowlist';
import {
  ADC_LOGIN_COMMAND,
  completeColabLogin,
  detectKeyringWarning,
  parseColabWhoami,
  startColabLogin,
} from './colab-login';

export type ColabAuthMode = 'oauth2' | 'adc';

export interface ColabExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  errno?: string;
}

export type ColabExecFn = (
  cmd: string,
  args: string[],
  opts?: { stdin?: string; timeoutMs?: number },
) => Promise<ColabExecResult>;

export type ColabActionResult =
  | { ok: true; backend: 'colab-cli'; data: Record<string, unknown> }
  | {
      ok: false;
      error: {
        code: string;
        backend: 'colab-cli';
        message: string;
        data?: Record<string, unknown>;
      };
    };

export interface ColabActionOptions {
  execFn?: ColabExecFn;
  platform?: NodeJS.Platform;
  bin?: string;
  homeDir?: string;
}

export interface ColabUsageInfo {
  computeUnitsBalance: number | null;
  usageRatePerHour: number | null;
  activeAssignments: number | null;
}

export interface ColabSessionInfo {
  name: string;
  endpoint: string;
  hardware: string;
  shape: string;
  variant: string;
  status: string | null;
  busy: boolean;
  lastExecution: string | null;
}

export const COLAB_READ_ACTIONS = [
  'doctor',
  'overview',
  'version',
  'whoami',
  'sessions',
  'status',
  'usage',
  'url',
  'ls',
  'log',
] as const;

export const COLAB_WRITE_ACTIONS = [
  'login-start',
  'login-complete',
  'new',
  'stop',
  'restart-kernel',
  'exec',
  'run',
  'install',
  'upload',
  'download',
  'rm',
  'drivemount',
  'auth',
  'logout',
  'ssh-exec',
] as const;

export const COLAB_ACTIONS = [...COLAB_READ_ACTIONS, ...COLAB_WRITE_ACTIONS, 'cli'] as const;

const VALID_GPUS = ['T4', 'L4', 'G4', 'A100', 'H100'] as const;
const VALID_TPUS = ['v5e1', 'v6e1'] as const;
const SESSION_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const PACKAGE_SPEC_RE = /^[A-Za-z0-9._\-\[\]<>=!~,@:/+]{1,128}$/;

class ColabValidationError extends Error {
  readonly code: 'VALIDATION' | 'FORBIDDEN';
  constructor(code: 'VALIDATION' | 'FORBIDDEN', message: string) {
    super(message);
    this.name = 'ColabValidationError';
    this.code = code;
  }
}

function defaultExec(
  cmd: string,
  args: string[],
  opts: { stdin?: string; timeoutMs?: number } = {},
): Promise<ColabExecResult> {
  const timeoutMs = clampTimeout(opts.timeoutMs, 120_000);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      const errObj = e as NodeJS.ErrnoException;
      resolve({
        code: -1,
        stdout: '',
        stderr: errObj?.message || String(e),
        errno: errObj?.code,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore kill error
      }
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer | string) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer | string) => {
      stderr += d.toString();
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: -1,
        stdout,
        stderr: e?.message || String(e),
        timedOut,
        errno: e?.code,
      });
    });
    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: typeof code === 'number' ? code : -1,
        stdout,
        stderr,
        timedOut,
      });
    });

    if (opts.stdin !== undefined) {
      child.stdin?.write(opts.stdin);
    }
    child.stdin?.end();
  });
}

export function resolveColabBinary(platform: NodeJS.Platform = process.platform): string {
  const fromEnv = process.env.LM_ASSIST_COLAB_BIN?.trim();
  if (fromEnv) return fromEnv;

  if (platform !== 'win32') {
    const localBin = path.join(os.homedir(), '.local', 'bin', 'colab');
    try {
      if (fs.existsSync(localBin)) {
        fs.accessSync(localBin, fs.constants.X_OK);
        return localBin;
      }
    } catch {
      // fall back to PATH lookup
    }
  }
  return 'colab';
}

export function redactColabText(text: string): string {
  if (!text) return text;
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{10,}/gi, '$1[REDACTED]')
    .replace(/\bya29\.[A-Za-z0-9._-]{12,}/g, 'ya29.[REDACTED]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, 'AIza[REDACTED]')
    .replace(/\b1\/\/[0-9A-Za-z_-]{15,}/g, '1//[REDACTED]');
}

export function truncateOutput(
  text: string,
  maxBytes = 65_536,
): { text: string; truncated: boolean } {
  if (!text) return { text: '', truncated: false };
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false };
  return {
    text: buf.subarray(0, maxBytes).toString('utf8'),
    truncated: true,
  };
}

export function parseColabUsage(text: string): ColabUsageInfo {
  const balMatch = text.match(/Current balance:\s*([0-9]+(?:\.[0-9]+)?)\s+compute units/i);
  const rateMatch = text.match(/Usage rate:\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*hr/i);
  const assignMatch = text.match(/Active assignments:\s*([0-9]+)/i);
  return {
    computeUnitsBalance: balMatch ? Number.parseFloat(balMatch[1]) : null,
    usageRatePerHour: rateMatch ? Number.parseFloat(rateMatch[1]) : null,
    activeAssignments: assignMatch ? Number.parseInt(assignMatch[1], 10) : null,
  };
}

export function parseColabSessions(text: string): ColabSessionInfo[] {
  const out: ColabSessionInfo[] = [];
  if (!text) return out;
  const lineRe =
    /^\[([^\]]+)\]\s+(\S+)\s*\|\s*Hardware:\s*([^|]+)\|\s*Shape:\s*([^|]+)\|\s*Variant:\s*([^|\r\n]+?)(?:\s*\|\s*Status:\s*(.+))?$/;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const m = line.match(lineRe);
    if (m) {
      const statusText = m[6] ? m[6].trim() : null;
      out.push({
        name: m[1].trim(),
        endpoint: m[2].trim(),
        hardware: m[3].trim(),
        shape: m[4].trim(),
        variant: m[5].trim(),
        status: statusText,
        busy: Boolean(statusText && /^BUSY\b/i.test(statusText)),
        lastExecution: null,
      });
      continue;
    }
    const execMatch = line.match(/^\s+Last Execution:\s*(.+)$/i);
    if (execMatch && out.length > 0) {
      out[out.length - 1].lastExecution = execMatch[1].trim();
    }
  }
  return out;
}

function assertCleanString(v: unknown, label: string): string {
  if (typeof v !== 'string') {
    throw new ColabValidationError('VALIDATION', `${label} must be a string`);
  }
  if (v.includes('\0')) {
    throw new ColabValidationError('VALIDATION', `${label} contains null byte`);
  }
  return v;
}

export function validateSessionName(v: unknown): string {
  const s = assertCleanString(v, 'session').trim();
  if (!SESSION_NAME_RE.test(s)) {
    throw new ColabValidationError(
      'VALIDATION',
      'session must match /^[A-Za-z0-9._-]{1,64}$/',
    );
  }
  return s;
}

export function validateGpu(v: unknown): (typeof VALID_GPUS)[number] {
  const upper = assertCleanString(v, 'gpu').trim().toUpperCase();
  const hit = VALID_GPUS.find((g) => g === upper);
  if (!hit) {
    throw new ColabValidationError('VALIDATION', `gpu must be one of: ${VALID_GPUS.join(', ')}`);
  }
  return hit;
}

export function validateTpu(v: unknown): (typeof VALID_TPUS)[number] {
  const lower = assertCleanString(v, 'tpu').trim().toLowerCase();
  const hit = VALID_TPUS.find((t) => t === lower);
  if (!hit) {
    throw new ColabValidationError('VALIDATION', `tpu must be one of: ${VALID_TPUS.join(', ')}`);
  }
  return hit;
}

export function validateRemotePath(v: unknown, label = 'remotePath'): string {
  const s = assertCleanString(v, label).trim();
  if (!s) {
    throw new ColabValidationError('VALIDATION', `${label} must be a non-empty string`);
  }
  if (s.startsWith('-')) {
    throw new ColabValidationError('VALIDATION', `${label} must not start with '-'`);
  }
  return s;
}

export function validatePackageSpec(v: unknown): string {
  const s = assertCleanString(v, 'package').trim();
  if (!s || s.startsWith('-') || !PACKAGE_SPEC_RE.test(s)) {
    throw new ColabValidationError(
      'VALIDATION',
      `Invalid package spec "${s}": must match ${PACKAGE_SPEC_RE.source} and not start with '-'`,
    );
  }
  return s;
}

function validateAllowedLocalPath(v: unknown, label: string): string {
  const raw = assertCleanString(v, label).trim();
  if (!raw) {
    throw new ColabValidationError('VALIDATION', `${label} must be a non-empty path`);
  }
  const resolved = path.resolve(raw);
  if (!isCwdAllowed(resolved)) {
    throw new ColabValidationError(
      'FORBIDDEN',
      `${label} "${resolved}" is outside allowed directories (${describeCwdPolicy()})`,
    );
  }
  return resolved;
}

function clampTimeout(v: unknown, fallbackMs: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallbackMs;
  return Math.min(Math.max(1000, Math.floor(v)), 600_000);
}

function clampInt(v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ColabValidationError('VALIDATION', `Expected integer between ${min} and ${max}`);
  }
  return Math.min(Math.max(min, Math.floor(v)), max);
}

function optSessionArgs(params: Record<string, unknown>): string[] {
  if (params.session === undefined || params.session === null || params.session === '') {
    return [];
  }
  return ['-s', validateSessionName(params.session)];
}

export function buildGlobalArgs(params: Record<string, unknown> = {}): string[] {
  const out: string[] = [];
  if (params.auth !== undefined && params.auth !== null && params.auth !== '') {
    const mode = assertCleanString(params.auth, 'auth').trim().toLowerCase();
    if (mode !== 'oauth2' && mode !== 'adc') {
      throw new ColabValidationError('VALIDATION', 'auth must be "oauth2" or "adc"');
    }
    out.push('--auth', mode);
  }
  if (params.oauthConfig !== undefined && params.oauthConfig !== null && params.oauthConfig !== '') {
    const p = assertCleanString(params.oauthConfig, 'oauthConfig').trim();
    if (!p || p.startsWith('-')) {
      throw new ColabValidationError('VALIDATION', 'oauthConfig must be a non-empty path');
    }
    out.push('-c', p);
  }
  if (params.config !== undefined && params.config !== null && params.config !== '') {
    const p = assertCleanString(params.config, 'config').trim();
    if (!p || p.startsWith('-')) {
      throw new ColabValidationError('VALIDATION', 'config must be a non-empty path');
    }
    out.push('--config', p);
  }
  return out;
}

export function buildColabArgs(
  action: string,
  params: Record<string, unknown> = {},
): { args: string[]; stdin?: string; timeoutMs: number } {
  const timeoutMs = clampTimeout(params.timeoutMs, 120_000);

  switch (action) {
    case 'version':
      return { args: ['version'], timeoutMs: clampTimeout(params.timeoutMs, 15_000) };
    case 'whoami':
      return { args: ['whoami'], timeoutMs: clampTimeout(params.timeoutMs, 15_000) };
    case 'sessions':
      return { args: ['sessions'], timeoutMs };
    case 'status':
      return { args: ['status', ...optSessionArgs(params)], timeoutMs };
    case 'usage':
      return { args: ['usage'], timeoutMs };
    case 'url':
      return { args: ['url', ...optSessionArgs(params)], timeoutMs };
    case 'ls': {
      const args = ['ls', ...optSessionArgs(params)];
      if (params.path !== undefined && params.path !== null && params.path !== '') {
        args.push(validateRemotePath(params.path, 'path'));
      }
      return { args, timeoutMs };
    }
    case 'log': {
      const args = ['log', ...optSessionArgs(params)];
      if (params.n !== undefined && params.n !== null) {
        args.push('-n', String(clampInt(params.n, 1, 200)));
      }
      if (params.outputFile !== undefined && params.outputFile !== null && params.outputFile !== '') {
        args.push('-o', validateAllowedLocalPath(params.outputFile, 'outputFile'));
      }
      return { args, timeoutMs };
    }
    case 'new': {
      if (params.gpu && params.tpu) {
        throw new ColabValidationError('VALIDATION', 'Specify at most one of gpu or tpu');
      }
      const args = ['new', ...optSessionArgs(params)];
      if (params.gpu) args.push('--gpu', validateGpu(params.gpu));
      if (params.tpu) args.push('--tpu', validateTpu(params.tpu));
      if (params.highMem === true) args.push('--high-mem');
      return { args, timeoutMs: clampTimeout(params.timeoutMs, 180_000) };
    }
    case 'stop':
      return {
        args: params.all === true ? ['stop', '--all'] : ['stop', ...optSessionArgs(params)],
        timeoutMs,
      };
    case 'restart-kernel':
      return { args: ['restart-kernel', ...optSessionArgs(params)], timeoutMs };
    case 'exec': {
      const hasCode = params.code !== undefined && params.code !== null && params.code !== '';
      const hasFile = params.file !== undefined && params.file !== null && params.file !== '';
      if (hasCode === hasFile) {
        throw new ColabValidationError('VALIDATION', 'exec requires exactly one of code or file');
      }
      const args = ['exec', ...optSessionArgs(params)];
      let stdin: string | undefined;
      if (hasCode) {
        stdin = assertCleanString(params.code, 'code');
        if (!stdin.trim()) {
          throw new ColabValidationError('VALIDATION', 'code must be non-empty');
        }
      } else {
        args.push('-f', validateAllowedLocalPath(params.file, 'file'));
      }
      if (params.outputImage !== undefined && params.outputImage !== null && params.outputImage !== '') {
        args.push('--output-image', validateAllowedLocalPath(params.outputImage, 'outputImage'));
      }
      return { args, stdin, timeoutMs: clampTimeout(params.timeoutMs, 180_000) };
    }
    case 'run': {
      if (params.gpu && params.tpu) {
        throw new ColabValidationError('VALIDATION', 'Specify at most one of gpu or tpu');
      }
      const script = validateAllowedLocalPath(params.script, 'script');
      const args = ['run'];
      if (params.gpu) args.push('--gpu', validateGpu(params.gpu));
      if (params.tpu) args.push('--tpu', validateTpu(params.tpu));
      if (params.highMem === true) args.push('--high-mem');
      if (params.keep === true) args.push('--keep');
      args.push(script);
      if (params.args !== undefined) {
        if (!Array.isArray(params.args)) {
          throw new ColabValidationError('VALIDATION', 'args must be an array of strings');
        }
        for (const a of params.args) {
          args.push(assertCleanString(a, 'args item'));
        }
      }
      return { args, timeoutMs: clampTimeout(params.timeoutMs, 300_000) };
    }
    case 'install': {
      const hasReq =
        params.requirementsFile !== undefined &&
        params.requirementsFile !== null &&
        params.requirementsFile !== '';
      const hasPkgs = Array.isArray(params.packages) && params.packages.length > 0;
      if (!hasReq && !hasPkgs) {
        throw new ColabValidationError(
          'VALIDATION',
          'install requires non-empty packages[] or requirementsFile',
        );
      }
      const args = ['install', ...optSessionArgs(params)];
      if (hasReq) {
        args.push('-r', validateAllowedLocalPath(params.requirementsFile, 'requirementsFile'));
      }
      if (hasPkgs) {
        for (const pkg of params.packages as unknown[]) {
          args.push(validatePackageSpec(pkg));
        }
      }
      return { args, timeoutMs: clampTimeout(params.timeoutMs, 180_000) };
    }
    case 'upload': {
      const localPath = validateAllowedLocalPath(params.localPath, 'localPath');
      const remotePath = validateRemotePath(params.remotePath, 'remotePath');
      return { args: ['upload', ...optSessionArgs(params), localPath, remotePath], timeoutMs };
    }
    case 'download': {
      const remotePath = validateRemotePath(params.remotePath, 'remotePath');
      const localPath = validateAllowedLocalPath(params.localPath, 'localPath');
      return { args: ['download', ...optSessionArgs(params), remotePath, localPath], timeoutMs };
    }
    case 'rm': {
      const remotePath = validateRemotePath(params.remotePath, 'remotePath');
      return { args: ['rm', ...optSessionArgs(params), remotePath], timeoutMs };
    }
    case 'drivemount': {
      const args = ['drivemount', ...optSessionArgs(params)];
      if (params.path !== undefined && params.path !== null && params.path !== '') {
        args.push(validateRemotePath(params.path, 'path'));
      }
      return { args, timeoutMs };
    }
    case 'auth':
      return { args: ['auth', ...optSessionArgs(params)], timeoutMs };
    case 'logout':
      return { args: ['logout'], timeoutMs };
    case 'ssh-exec': {
      if (!Array.isArray(params.command) || params.command.length === 0) {
        throw new ColabValidationError('VALIDATION', 'ssh-exec requires a non-empty command[] array');
      }
      const cmdArgs = params.command.map((c) => assertCleanString(c, 'command item'));
      return { args: ['ssh', ...optSessionArgs(params), '--', ...cmdArgs], timeoutMs };
    }
    case 'cli': {
      if (!Array.isArray(params.args) || params.args.length === 0) {
        throw new ColabValidationError('VALIDATION', 'cli requires a non-empty args[] array');
      }
      const cliArgs = params.args.map((a) => assertCleanString(a, 'args item'));
      const stdin =
        params.stdin !== undefined && params.stdin !== null
          ? assertCleanString(params.stdin, 'stdin')
          : undefined;
      return { args: cliArgs, stdin, timeoutMs };
    }
    default:
      throw new ColabValidationError('VALIDATION', `Unknown action "${action}"`);
  }
}

function classifyCliError(
  res: ColabExecResult,
  platform: NodeJS.Platform,
  bin: string,
  redactedOut: string,
  redactedErr: string,
): { code: string; message: string } {
  if (res.errno === 'ENOENT' || /ENOENT|not recognized as an internal or external/i.test(res.stderr)) {
    if (platform === 'win32') {
      return {
        code: 'UNSUPPORTED_PLATFORM',
        message:
          `google-colab-cli only supports Linux and macOS (binary "${bin}" not found on Windows). ` +
          'Run on a Linux/macOS node instead.',
      };
    }
    return {
      code: 'CLI_NOT_INSTALLED',
      message: `Colab CLI binary "${bin}" not found. Install via: uv tool install google-colab-cli`,
    };
  }
  if (res.timedOut) {
    return { code: 'TIMEOUT', message: `colab command timed out (exit ${res.code})` };
  }
  const combined = `${redactedErr}\n${redactedOut}`;
  if (
    /\b(oauth2?|credentials?|not logged in|login required|401|unauthenticated)\b/i.test(combined) ||
    /To authorize colab-cli|Enter the authorization code|EOFError|No valid default credentials found/i.test(combined)
  ) {
    return {
      code: 'AUTH_REQUIRED',
      message:
        (redactedErr.trim() || redactedOut.trim() || 'Google Colab CLI authentication required.') +
        ' Guide: call POST /colab/login/start (or colab_mutate action="login-start") for OAuth2, or configure gcloud ADC.',
    };
  }
  return {
    code: 'CLI_ERROR',
    message: redactedErr.trim() || redactedOut.trim() || `colab exited with code ${res.code}`,
  };
}

export async function runColabAction(
  action: string,
  params: Record<string, unknown> = {},
  opts: ColabActionOptions = {},
): Promise<ColabActionResult> {
  const platform = opts.platform ?? process.platform;
  const bin = opts.bin ?? resolveColabBinary(platform);
  const execFn = opts.execFn ?? defaultExec;
  const homeDir = opts.homeDir ?? os.homedir();

  if (!(COLAB_ACTIONS as readonly string[]).includes(action)) {
    return {
      ok: false,
      error: {
        code: 'UNKNOWN_ACTION',
        backend: 'colab-cli',
        message: `Unknown colab action "${action}". Valid: ${COLAB_ACTIONS.join(', ')}`,
      },
    };
  }

  if (action === 'doctor') {
    const sessionsFile = path.join(homeDir, '.config', 'colab-cli', 'sessions.json');
    const sessionsConfigExists = fs.existsSync(sessionsFile);
    const legacyTokenExists = fs.existsSync(path.join(homeDir, '.config', 'colab-cli', 'token.json'));
    const gacEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
    const defaultAdcFile = path.join(homeDir, '.config', 'gcloud', 'application_default_credentials.json');
    const adcCredentialsExists = Boolean((gacEnv && fs.existsSync(gacEnv)) || fs.existsSync(defaultAdcFile));

    const vRes = await execFn(bin, ['version'], { timeoutMs: 10_000 });
    const installed = vRes.code === 0 && vRes.errno !== 'ENOENT';
    const versionText = installed ? redactColabText(vRes.stdout || vRes.stderr).trim() : null;

    let globalArgs: string[] = [];
    try {
      globalArgs = buildGlobalArgs(params);
    } catch {
      globalArgs = [];
    }

    let loggedIn = false;
    let authRequired = false;
    let email: string | null = null;
    let authProvider: string | null = params.auth === 'adc' ? 'adc' : 'oauth2';
    let expiresIn: string | null = null;
    let keyringWarning: string | null = null;

    if (installed) {
      const wRes = await execFn(bin, [...globalArgs, 'whoami'], { stdin: '', timeoutMs: 12_000 });
      const wCombined = redactColabText(`${wRes.stdout || ''}\n${wRes.stderr || ''}`);
      keyringWarning = detectKeyringWarning(wCombined);
      if (wRes.code === 0) {
        loggedIn = true;
        const parsed = parseColabWhoami(wCombined);
        email = parsed.email;
        if (parsed.provider) authProvider = parsed.provider;
        expiresIn = parsed.expiresIn;
      } else {
        authRequired = true;
      }
    }

    return {
      ok: true,
      backend: 'colab-cli',
      data: {
        platform,
        supportedPlatform: platform !== 'win32',
        binary: bin,
        installed,
        version: versionText || null,
        loggedIn,
        authRequired,
        email,
        authProvider,
        expiresIn,
        keyringWarning,
        sessionsConfigExists,
        legacyTokenExists,
        adcCredentialsExists,
        installHint:
          platform === 'win32'
            ? 'google-colab-cli supports Linux/macOS only; invoke on a Linux/macOS lm-assist node.'
            : 'uv tool install google-colab-cli  # or: pip install google-colab-cli',
        loginGuide: !installed
          ? 'Install google-colab-cli first, then call POST /colab/login/start.'
          : loggedIn
            ? 'Authenticated and ready.'
            : authProvider === 'adc'
              ? `Run on target node: ${ADC_LOGIN_COMMAND}`
              : 'Call POST /colab/login/start (or colab_mutate action="login-start") to obtain the Google OAuth2 URL, then submit the code via POST /colab/login/complete (or action="login-complete").',
      },
    };
  }

  if (action === 'overview') {
    const docRes = await runColabAction('doctor', params, opts);
    const docData = docRes.ok ? docRes.data : null;
    if (!docData || !docData.installed || !docData.loggedIn) {
      return {
        ok: true,
        backend: 'colab-cli',
        data: {
          doctor: docData,
          usage: null,
          sessions: [],
          activeCount: 0,
        },
      };
    }

    const [usageRes, sessionsRes, statusRes] = await Promise.all([
      runColabAction('usage', params, opts),
      runColabAction('sessions', params, opts),
      runColabAction('status', params, opts),
    ]);

    const usage = usageRes.ok ? (usageRes.data.usage as ColabUsageInfo) : null;
    const rawSessions = sessionsRes.ok ? ((sessionsRes.data.sessions as ColabSessionInfo[]) ?? []) : [];
    const statusSessions = statusRes.ok ? ((statusRes.data.sessions as ColabSessionInfo[]) ?? []) : [];

    const byEndpoint = new Map<string, ColabSessionInfo>();
    const byName = new Map<string, ColabSessionInfo>();
    for (const st of statusSessions) {
      byEndpoint.set(st.endpoint, st);
      if (st.name && st.name !== '?') byName.set(st.name, st);
    }

    const baseList = rawSessions.length > 0 ? rawSessions : statusSessions;
    const mergedSessions = baseList.map((s) => {
      const match = byEndpoint.get(s.endpoint) || (s.name !== '?' ? byName.get(s.name) : undefined);
      if (!match) return s;
      return {
        ...s,
        status: match.status ?? s.status,
        busy: match.busy || s.busy,
        lastExecution: match.lastExecution ?? s.lastExecution,
      };
    });

    const activeCount = sessionsRes.ok
      ? mergedSessions.length
      : (usage?.activeAssignments ?? mergedSessions.length);

    return {
      ok: true,
      backend: 'colab-cli',
      data: {
        doctor: docData,
        usage,
        sessions: mergedSessions,
        activeCount,
      },
    };
  }

  if (action === 'login-start') {
    return startColabLogin(
      params as { auth?: ColabAuthMode; oauthConfig?: string; config?: string },
      { bin, platform },
    );
  }
  if (action === 'login-complete') {
    return completeColabLogin(params as { loginId?: string; code?: string });
  }

  let globalArgs: string[];
  let built: { args: string[]; stdin?: string; timeoutMs: number };
  try {
    globalArgs = buildGlobalArgs(params);
    built = buildColabArgs(action, params);
  } catch (e) {
    if (e instanceof ColabValidationError) {
      return {
        ok: false,
        error: { code: e.code, backend: 'colab-cli', message: e.message },
      };
    }
    return {
      ok: false,
      error: {
        code: 'VALIDATION',
        backend: 'colab-cli',
        message: e instanceof Error ? e.message : String(e),
      },
    };
  }

  const fullArgs = [...globalArgs, ...built.args];
  const execRes = await execFn(bin, fullArgs, {
    stdin: built.stdin,
    timeoutMs: built.timeoutMs,
  });

  const outRedacted = redactColabText(execRes.stdout || '');
  const errRedacted = redactColabText(execRes.stderr || '');
  const outTrunc = truncateOutput(outRedacted);
  const errTrunc = truncateOutput(errRedacted);

  if (execRes.code !== 0) {
    const classified = classifyCliError(execRes, platform, bin, outTrunc.text, errTrunc.text);
    return {
      ok: false,
      error: {
        code: classified.code,
        backend: 'colab-cli',
        message: classified.message,
        data: {
          action,
          args: fullArgs,
          exitCode: execRes.code,
          stdout: outTrunc.text,
          stderr: errTrunc.text,
          truncated: outTrunc.truncated || errTrunc.truncated,
        },
      },
    };
  }

  const extra: Record<string, unknown> = {};
  if (action === 'usage') {
    extra.usage = parseColabUsage(outTrunc.text);
  } else if (action === 'sessions' || action === 'status') {
    const parsedSessions = parseColabSessions(outTrunc.text);
    extra.sessions = parsedSessions;
    extra.activeCount = parsedSessions.length;
  }

  return {
    ok: true,
    backend: 'colab-cli',
    data: {
      action,
      args: fullArgs,
      exitCode: 0,
      stdout: outTrunc.text,
      stderr: errTrunc.text,
      truncated: outTrunc.truncated || errTrunc.truncated,
      ...extra,
    },
  };
}
