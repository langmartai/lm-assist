/**
 * Hub Configuration
 *
 * Manages configuration for connecting to LangMart Hub:
 * - Hub URL and API key from environment
 * - Machine ID (hardware fingerprint)
 * - Gateway ID (persisted after first registration)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { getDataDir } from '../utils/path-utils';

export interface HubConfig {
  /** Hub WebSocket URL */
  hubUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** Machine ID (hardware fingerprint) */
  machineId: string;
  /** Gateway ID (assigned by hub, persisted for reconnection) */
  gatewayId: string | null;
  /** Hostname for display */
  hostname: string;
  /** Platform (linux, darwin, win32) */
  platform: string;
  /** tier-agent version */
  version: string;
}

/**
 * Get the config directory path
 */
function getConfigDir(): string {
  const configDir = getDataDir();
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  return configDir;
}

/**
 * Generate a stable machine ID from hardware characteristics
 */
function generateMachineId(): string {
  const configDir = getConfigDir();
  const machineIdFile = path.join(configDir, 'machine-id');

  // If we have a saved machine ID, use it
  if (fs.existsSync(machineIdFile)) {
    try {
      const savedId = fs.readFileSync(machineIdFile, 'utf-8').trim();
      if (savedId && savedId.length === 36) { // UUID length
        return savedId;
      }
    } catch {
      // Fall through to generate new ID
    }
  }

  // Generate new machine ID from hardware characteristics
  const cpus = os.cpus();
  const networkInterfaces = os.networkInterfaces();

  // Create fingerprint from:
  // - CPU model
  // - Number of CPUs
  // - Total memory (rounded to nearest GB to be stable)
  // - MAC address of first non-internal interface
  const fingerprint = [
    cpus[0]?.model || 'unknown-cpu',
    cpus.length.toString(),
    Math.round(os.totalmem() / (1024 * 1024 * 1024)).toString(),
    os.hostname(),
    os.platform(),
    os.arch(),
  ];

  // Add first MAC address
  outer: for (const interfaces of Object.values(networkInterfaces)) {
    if (!interfaces) continue;
    for (const iface of interfaces) {
      if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
        fingerprint.push(iface.mac);
        break outer; // Only add one MAC address
      }
    }
  }

  // Hash the fingerprint to create a UUID-like ID
  const hash = crypto.createHash('sha256').update(fingerprint.join('|')).digest('hex');

  // Format as UUID v4-like (not truly random, but looks like one)
  const machineId = [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16), // Version 4
    '8' + hash.slice(17, 20), // Variant
    hash.slice(20, 32),
  ].join('-');

  // Save for future use
  try {
    fs.writeFileSync(machineIdFile, machineId);
  } catch (err) {
    console.warn('[HubConfig] Failed to save machine ID:', err);
  }

  return machineId;
}

/**
 * Load gateway ID from config file
 */
function loadGatewayId(): string | null {
  const configDir = getConfigDir();
  const gatewayIdFile = path.join(configDir, 'gateway-id');

  if (fs.existsSync(gatewayIdFile)) {
    try {
      const gatewayId = fs.readFileSync(gatewayIdFile, 'utf-8').trim();
      if (gatewayId && gatewayId.startsWith('gw4-')) {
        return gatewayId;
      }
    } catch {
      // Return null
    }
  }

  return null;
}

/**
 * Save gateway ID to config file
 */
export function saveGatewayId(gatewayId: string): void {
  const configDir = getConfigDir();
  const gatewayIdFile = path.join(configDir, 'gateway-id');

  try {
    fs.writeFileSync(gatewayIdFile, gatewayId);
    console.log(`[HubConfig] Saved gateway ID: ${gatewayId}`);
  } catch (err) {
    console.warn('[HubConfig] Failed to save gateway ID:', err);
  }
}

/**
 * Clear gateway ID (for re-registration)
 */
export function clearGatewayId(): void {
  const configDir = getConfigDir();
  const gatewayIdFile = path.join(configDir, 'gateway-id');

  try {
    if (fs.existsSync(gatewayIdFile)) {
      fs.unlinkSync(gatewayIdFile);
      console.log('[HubConfig] Cleared gateway ID');
    }
  } catch (err) {
    console.warn('[HubConfig] Failed to clear gateway ID:', err);
  }
}

/**
 * Get tier-agent version from package.json
 */
function getVersion(): string {
  // Try root package.json first (npm install), then core package.json (local dev)
  for (const rel of ['../../../package.json', '../../package.json']) {
    try {
      const packagePath = path.join(__dirname, rel);
      if (fs.existsSync(packagePath)) {
        const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8')) as { version?: string };
        if (pkg.version) return pkg.version;
      }
    } catch {
      // Try next path
    }
  }
  return '0.0.0';
}

/**
 * Load persisted hub connection config from ~/.lm-assist/hub.json
 */
interface HubConnectionConfig {
  apiKey?: string;
  hubUrl?: string;
  /** Persist assist web port so reconnects and tier-agent can discover it */
  assistWebPort?: number;
  /** Persist API port for discovery */
  apiPort?: number;
}

function loadHubConnectionConfig(): HubConnectionConfig {
  const configFile = path.join(getConfigDir(), 'hub.json');
  try {
    if (fs.existsSync(configFile)) {
      return JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    }
  } catch {
    // Fall through
  }
  return {};
}

/**
 * Save hub connection config to ~/.lm-assist/hub.json
 */
export function saveHubConnectionConfig(updates: HubConnectionConfig): void {
  const configDir = getConfigDir();
  const configFile = path.join(configDir, 'hub.json');
  const existing = loadHubConnectionConfig();
  const merged = { ...existing, ...updates };

  // Remove empty string values (but keep numeric 0 as valid)
  if (!merged.apiKey) delete merged.apiKey;
  if (!merged.hubUrl) delete merged.hubUrl;

  fs.writeFileSync(configFile, JSON.stringify(merged, null, 2) + '\n');
}

/**
 * Load persisted service ports from ~/.lm-assist/hub.json
 * Used by hub-client to discover assist web port without env vars
 */
export function loadServicePorts(): { assistWebPort?: number; apiPort?: number } {
  const config = loadHubConnectionConfig();
  return {
    assistWebPort: config.assistWebPort,
    apiPort: config.apiPort,
  };
}

/**
 * Get hub configuration from config file, falling back to environment variables
 */
export function getHubConfig(): HubConfig {
  const saved = loadHubConnectionConfig();
  return {
    hubUrl: saved.hubUrl || process.env.TIER_AGENT_HUB_URL || '',
    apiKey: saved.apiKey || process.env.TIER_AGENT_API_KEY || '',
    machineId: generateMachineId(),
    gatewayId: loadGatewayId(),
    hostname: os.hostname(),
    platform: os.platform(),
    version: getVersion(),
  };
}

/**
 * Check if hub connection is configured (config file or environment)
 */
export function isHubConfigured(): boolean {
  const saved = loadHubConnectionConfig();
  const hubUrl = saved.hubUrl || process.env.TIER_AGENT_HUB_URL || '';
  const apiKey = saved.apiKey || process.env.TIER_AGENT_API_KEY || '';
  return !!hubUrl && !!apiKey;
}
