import { NextRequest, NextResponse } from 'next/server';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { homedir } from 'os';
import path from 'path';

const CONFIG_DIR = path.join(homedir(), '.lm-assist');
const CONFIG_FILE = path.join(CONFIG_DIR, 'assist-config.json');

interface AssistConfig {
  lanEnabled?: boolean;
  lanAuthEnabled?: boolean;
  lanAccessToken?: string;
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
 * POST /api/auth/cloud-verify — Verify OAuth user matches device-bound user
 *
 * Used by the lan-blocked page to authenticate LAN users via Cloud OAuth.
 * The flow:
 * 1. User on LAN opens OAuth popup on langmart.ai (mode=verify)
 * 2. Popup sends user's API key via postMessage
 * 3. This endpoint validates the key against the gateway to get user identity
 * 4. Compares with the device-bound user (from tier-agent's hub connection)
 * 5. If same user → returns the LAN access token
 *
 * Body: { apiKey: string }
 * Returns: { valid: true, token: string } or { valid: false, error: string }
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const { apiKey } = body;

  if (!apiKey || typeof apiKey !== 'string') {
    return NextResponse.json({ valid: false, error: 'Missing API key' }, { status: 400 });
  }

  // Check that LAN auth is actually enabled
  const config = readConfig();
  const lanAuthEnabled = config.lanAuthEnabled ?? true;
  if (!lanAuthEnabled) {
    return NextResponse.json({ valid: false, error: 'LAN authentication is not enabled' }, { status: 400 });
  }

  // Auto-generate token if none exists
  if (!config.lanAccessToken) {
    config.lanAuthEnabled = true;
    config.lanAccessToken = randomBytes(32).toString('hex');
    writeConfig(config);
  }

  const gatewayUrl = process.env.GATEWAY_URL || 'http://localhost:8081';
  const apiPort = process.env.NEXT_PUBLIC_LOCAL_API_PORT || '3100';
  const tierAgentUrl = `http://localhost:${apiPort}`;

  try {
    // 1. Validate the OAuth user's API key against the gateway
    const oauthRes = await fetch(`${gatewayUrl}/auth/validate`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!oauthRes.ok) {
      return NextResponse.json({ valid: false, error: 'Invalid credentials' }, { status: 403 });
    }

    const oauthData = await oauthRes.json();
    if (!oauthData.valid || !oauthData.user) {
      return NextResponse.json({ valid: false, error: 'Invalid credentials' }, { status: 403 });
    }

    const oauthUserId = oauthData.user.id;

    // 2. Get the device-bound user from tier-agent
    const deviceRes = await fetch(`${tierAgentUrl}/hub/user`);
    if (!deviceRes.ok) {
      return NextResponse.json(
        { valid: false, error: 'Device is not connected to cloud. Connect on localhost first.' },
        { status: 503 },
      );
    }

    const deviceData = await deviceRes.json();
    if (!deviceData.success || !deviceData.data) {
      return NextResponse.json(
        { valid: false, error: 'Device is not authenticated with cloud. Set up on localhost first.' },
        { status: 503 },
      );
    }

    const deviceUserId = deviceData.data.id;

    // 3. Compare user IDs
    if (oauthUserId !== deviceUserId) {
      return NextResponse.json({
        valid: false,
        error: 'This account does not match the device owner. Sign in with the same account configured on localhost.',
      }, { status: 403 });
    }

    // 4. User matches — return the LAN access token
    return NextResponse.json({
      valid: true,
      token: config.lanAccessToken,
    });
  } catch (error) {
    console.error('[cloud-verify] Error:', error);
    return NextResponse.json({ valid: false, error: 'Verification failed' }, { status: 500 });
  }
}
