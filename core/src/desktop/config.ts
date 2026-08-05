/**
 * Desktop automation — deployment facts only (paths, defaults, dev/prod split).
 *
 * ── What lives HERE vs in the backends ───────────────────────────────────────
 * This file owns DEPLOYMENT facts: the scratch dir screenshots are written to,
 * the image-return defaults/ceilings, the per-operation timeouts. A backend
 * command (an xdotool flag, a PowerShell shim) must never appear here, and a
 * file path must never appear in a backend — same rule as gmail/config.ts.
 */

import * as os from 'os';
import * as path from 'path';

// Mirror the connector dev/prod split: a build running from the repo (not
// node_modules) uses the -dev scratch dir so dev and prod never collide.
const IS_DEV_REPO = process.env.LM_ASSIST_PROD === 'true' ? false : !__dirname.includes('node_modules');
const DEV_SUFFIX = IS_DEV_REPO ? '-dev' : '';

const LM_DIR = path.join(os.homedir(), '.lm-assist');
/** Directory screenshots are written to before being read back + encoded. */
export const DESKTOP_TMP_DIR = path.join(LM_DIR, `desktop${DEV_SUFFIX}`, 'tmp');

// ─── image-return defaults (bytes budget is real — MCP clients choke ~1MB) ────

/** Default long-edge cap of the RETURNED image. 1568px is safe across all
 *  current models; Opus/Sonnet-5-gen accept up to 2576. */
export const DEFAULT_MAX_PX = 1568;
/** Allowed range for a caller-set max_px. */
export const MIN_MAX_PX = 256;
export const MAX_MAX_PX = 2576;

/** Default JPEG quality for downscaled/large captures. */
export const DEFAULT_JPEG_QUALITY = 85;

/** Area (pixels) at or below which a capture is returned as crisp PNG rather
 *  than JPEG — small zoom regions stay lossless; big overviews go JPEG. */
export const PNG_AREA_THRESHOLD = 1_200_000; // ~1.2 MP

/** Hard ceiling on returned image bytes (pre-base64). service.ts downscales /
 *  drops quality until under this — survey shows ~1MB is where clients fail. */
export const MAX_IMAGE_BYTES = 700 * 1024;

/** Max windows listed by desktop_windows before an explicit truncation note. */
export const MAX_WINDOWS = 100;

// ─── per-operation backend timeouts (ms) — every spawn is kill-on-expiry ──────

export const CAPTURE_TIMEOUT_MS = 10_000;
export const INPUT_TIMEOUT_MS = 5_000;
export const WINDOW_TIMEOUT_MS = 5_000;
export const STATUS_TIMEOUT_MS = 8_000;

/** Single-flight queue: how long a desktop write waits for the mutex before BUSY. */
export const MUTEX_WAIT_MS = 8_000;

/** Settle delay (ms) after activating a window as a convenience step, before
 *  the following input lands — mirrors the reference impl's post-action settle. */
export const ACTIVATE_SETTLE_MS = 250;
