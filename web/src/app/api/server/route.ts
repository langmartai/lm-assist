import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir, networkInterfaces } from 'os';
import { randomBytes } from 'crypto';
import path from 'path';
import { getHubDomain } from '@/lib/utils';

const CONFIG_DIR = path.join(homedir(), '.lm-assist');
const CONFIG_FILE = path.join(CONFIG_DIR, 'assist-config.json');
// Hub config — prod uses hub.json, dev uses hub-dev.json. We only read the
// non-secret fields (hubUrl + whether an apiKey is present) to tell the
// /lan-blocked page if a cloud account is bound and which hub to sign in against.
const HUB_FILE = path.join(CONFIG_DIR, 'hub.json');
const HUB_DEV_FILE = path.join(CONFIG_DIR, 'hub-dev.json');

interface AssistConfig {
  lanEnabled?: boolean;
  lanAuthEnabled?: boolean;
  lanAccessToken?: string;
}

interface HubConfig {
  hubUrl?: string;
  apiKey?: string;
}

function readHubConfig(): HubConfig {
  // Dev web (:3200) pairs with hub-dev.json; prod web with hub.json. Prefer the
  // matching one, fall back to the other (single-install hosts have only one).
  const devFirst = process.env.NEXT_PUBLIC_LOCAL_API_PORT === '3200';
  const order = devFirst ? [HUB_DEV_FILE, HUB_FILE] : [HUB_FILE, HUB_DEV_FILE];
  for (const f of order) {
    try {
      return JSON.parse(readFileSync(f, 'utf8')) as HubConfig;
    } catch {
      /* try next */
    }
  }
  return {};
}

/**
 * Resolve the tier-agent project root.
 *
 * Normal:    /home/ubuntu/lm-assist/web  →  /home/ubuntu/tier-agent
 * Worktree:  /home/ubuntu/lm-assist-wt-2/web  →  /home/ubuntu/tier-agent-wt-2
 */
function getTierAgentDir(): string {
  // Walk up from web/ to project root, then resolve sibling tier-agent
  const projectRoot = path.resolve(process.cwd(), '..');
  const base = path.basename(projectRoot);

  // Worktree: lm-assist-wt-N → tier-agent-wt-N
  const wtMatch = base.match(/^lm-assist(-wt-\d+)$/);
  if (wtMatch) {
    return path.join(path.dirname(projectRoot), `tier-agent${wtMatch[1]}`);
  }

  // Normal
  return path.join(path.dirname(projectRoot), 'tier-agent');
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

function readConfig(): AssistConfig {
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeConfig(config: AssistConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
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
  const hub = readHubConfig();

  return NextResponse.json({
    tierAgentDir: tierDir,
    coreShExists: exists,
    localIp: getLocalIp(),
    lanEnabled: config.lanEnabled ?? true,
    lanAuthEnabled: config.lanAuthEnabled ?? true,
    // For the /lan-blocked page (reachable same-origin, no worker token):
    // is a cloud account bound to this device, and which hub to sign in against.
    cloudBound: !!hub.apiKey,
    hubDomain: getHubDomain(hub.hubUrl),
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
      lanAuthEnabled: config.lanAuthEnabled ?? true,
    },
    restartRequired,
  });
}
