import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { networkInterfaces } from 'os';
import { randomBytes } from 'crypto';
import path from 'path';

const CONFIG_FILE = 'assist-config.json';

interface AssistConfig {
  lanEnabled?: boolean;
  lanAuthEnabled?: boolean;
  lanAccessToken?: string;
}

/**
 * Resolve the tier-agent project root.
 *
 * Normal:    /home/ubuntu/langmart-assistant  →  /home/ubuntu/tier-agent
 * Worktree:  /home/ubuntu/langmart-assistant-wt-2  →  /home/ubuntu/tier-agent-wt-2
 */
function getTierAgentDir(): string {
  const assistDir = process.cwd();
  const base = path.basename(assistDir);

  // Worktree: langmart-assistant-wt-N → tier-agent-wt-N
  const wtMatch = base.match(/^langmart-assistant(-wt-\d+)$/);
  if (wtMatch) {
    return path.join(path.dirname(assistDir), `tier-agent${wtMatch[1]}`);
  }

  // Normal
  return path.join(path.dirname(assistDir), 'tier-agent');
}

/** Get the first non-internal IPv4 address */
function getLocalIp(): string {
  const nets = networkInterfaces();
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

function getConfigPath(): string {
  return path.join(process.cwd(), CONFIG_FILE);
}

function readConfig(): AssistConfig {
  try {
    const raw = readFileSync(getConfigPath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeConfig(config: AssistConfig): void {
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + '\n');
}

/**
 * POST /api/server  — Start the tier-agent API server via core.sh
 *
 * Body (optional):
 *   { action: 'start' }   default: 'start'
 *
 * Returns:
 *   { success, message, output? }
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const action: string = body.action || 'start';

  const tierDir = getTierAgentDir();
  const coreScript = path.join(tierDir, 'core.sh');

  if (!existsSync(coreScript)) {
    return NextResponse.json(
      { success: false, message: `core.sh not found at ${tierDir}` },
      { status: 404 },
    );
  }

  if (action === 'start') {
    return new Promise<NextResponse>((resolve) => {
      execFile(
        'bash',
        [coreScript, 'start'],
        { cwd: tierDir, timeout: 30_000, env: { ...process.env, FORCE_COLOR: '0' } },
        (error, stdout, stderr) => {
          const output = (stdout + '\n' + stderr).trim();
          if (error && error.killed) {
            resolve(
              NextResponse.json(
                { success: false, message: 'Start command timed out', output },
                { status: 504 },
              ),
            );
          } else {
            resolve(
              NextResponse.json({
                success: !error,
                message: error ? 'Start command returned an error' : 'Server start initiated',
                output,
              }),
            );
          }
        },
      );
    });
  }

  return NextResponse.json(
    { success: false, message: `Unknown action: ${action}` },
    { status: 400 },
  );
}

/**
 * GET /api/server  — Server info + config
 */
export async function GET() {
  const tierDir = getTierAgentDir();
  const coreScript = path.join(tierDir, 'core.sh');
  const exists = existsSync(coreScript);
  const config = readConfig();

  return NextResponse.json({
    tierAgentDir: tierDir,
    coreShExists: exists,
    localIp: getLocalIp(),
    lanEnabled: config.lanEnabled ?? true,
    lanAuthEnabled: config.lanAuthEnabled ?? false,
  });
}

/**
 * PUT /api/server  — Update assist config (e.g. lanEnabled)
 *
 * Body: { lanEnabled?: boolean }
 * Returns: { success, config, restartRequired? }
 */
export async function PUT(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const config = readConfig();
  let restartRequired = false;

  if (typeof body.lanEnabled === 'boolean') {
    if (config.lanEnabled !== body.lanEnabled) {
      restartRequired = true;
    }
    config.lanEnabled = body.lanEnabled;
  }

  if (typeof body.lanAuthEnabled === 'boolean') {
    config.lanAuthEnabled = body.lanAuthEnabled;
    // Auto-generate token when enabling if none exists
    if (body.lanAuthEnabled && !config.lanAccessToken) {
      config.lanAccessToken = randomBytes(32).toString('hex');
    }
  }

  writeConfig(config);

  return NextResponse.json({
    success: true,
    config: {
      lanEnabled: config.lanEnabled ?? true,
      lanAuthEnabled: config.lanAuthEnabled ?? false,
    },
    restartRequired,
  });
}
