import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { readAssistConfig } from '@/lib/assist-config';

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

  const config = readAssistConfig();
  const lanAuthEnabled = config.lanAuthEnabled ?? true;

  if (!lanAuthEnabled) {
    // LAN access is switched OFF (only this machine may use the dashboard), so no
    // LAN key is valid — Core refuses LAN-key grants in this state too. This used
    // to answer true ("no gate"), which is the opposite of what the setting means now.
    return NextResponse.json({ valid: false });
  }

  if (!config.lanAccessToken) {
    // Auth enabled but no token configured — cannot validate
    return NextResponse.json({ valid: false });
  }

  // Compare BYTE lengths: equal string lengths can still differ in bytes (non-ASCII
  // input), and timingSafeEqual throws on a length mismatch.
  const given = Buffer.from(token);
  const expected = Buffer.from(config.lanAccessToken);
  const valid = given.length === expected.length && timingSafeEqual(given, expected);
  return NextResponse.json({ valid });
}
