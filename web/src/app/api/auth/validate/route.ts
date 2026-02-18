import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { timingSafeEqual } from 'crypto';
import { homedir } from 'os';
import path from 'path';

const CONFIG_FILE = path.join(homedir(), '.lm-assist', 'assist-config.json');

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

/**
 * POST /api/auth/validate — Validate a LAN access token
 *
 * Body: { token: string }
 * Returns: { valid: true } or { valid: false }
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const { token } = body;

  if (!token || typeof token !== 'string') {
    return NextResponse.json({ valid: false });
  }

  const config = readConfig();
  const lanAuthEnabled = config.lanAuthEnabled ?? true;

  if (!lanAuthEnabled) {
    // Auth explicitly disabled — treat as valid (no gate)
    return NextResponse.json({ valid: true });
  }

  if (!config.lanAccessToken) {
    // Auth enabled but no token configured — cannot validate
    return NextResponse.json({ valid: false });
  }

  const expected = config.lanAccessToken;
  const valid = token.length === expected.length
    && timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  return NextResponse.json({ valid });
}
