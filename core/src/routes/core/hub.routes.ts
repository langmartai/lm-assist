/**
 * Hub Client Routes
 *
 * API endpoints for managing the hub client connection.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { RouteContext, RouteHandler, ParsedRequest } from '../index';
import { getHubClient, resetHubClient, reconnectHubClient, isHubConfigured, getHubConfig } from '../../hub-client';

export function createHubRoutes(ctx: RouteContext): RouteHandler[] {
  return [
    // GET /hub/status - Get hub client connection status
    {
      method: 'GET',
      pattern: /^\/hub\/status$/,
      handler: async () => {
        const configured = isHubConfigured();
        const config = getHubConfig();

        // Mask the API key - show only first 12 chars
        const apiKey = config.apiKey || '';
        const apiKeyPrefix = apiKey.length > 12
          ? apiKey.substring(0, 12) + '...'
          : apiKey.length > 0 ? '***' : null;

        if (!configured) {
          return {
            success: true,
            data: {
              configured: false,
              connected: false,
              authenticated: false,
              hubUrl: config.hubUrl || null,
              apiKeyConfigured: !!config.apiKey,
              apiKeyPrefix,
              reconnectAttempts: 0,
              gatewayId: null,
            },
          };
        }

        try {
          const hubClient = getHubClient();
          const status = hubClient.getStatus();

          return {
            success: true,
            data: {
              configured: true,
              connected: status.connected,
              authenticated: status.authenticated,
              gatewayId: status.gatewayId,
              hubUrl: status.hubUrl || config.hubUrl,
              apiKeyConfigured: !!config.apiKey,
              apiKeyPrefix,
              reconnectAttempts: status.reconnectAttempts,
              lastConnected: status.lastConnected,
            },
          };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to get hub status',
          };
        }
      },
    },

    // POST /hub/disconnect - Disconnect from hub (stops auto-reconnect)
    {
      method: 'POST',
      pattern: /^\/hub\/disconnect$/,
      handler: async () => {
        try {
          const hubClient = getHubClient();
          await hubClient.disconnect();

          return {
            success: true,
            data: {
              message: 'Disconnected from hub',
              connected: false,
            },
          };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to disconnect',
          };
        }
      },
    },

    // POST /hub/connect - Connect to hub (resets shutdown flag, enables auto-reconnect)
    {
      method: 'POST',
      pattern: /^\/hub\/connect$/,
      handler: async () => {
        if (!isHubConfigured()) {
          return {
            success: false,
            error: 'No API key configured. Set an API key first.',
          };
        }

        try {
          await resetHubClient();
          const hubClient = getHubClient();
          await hubClient.connect();

          const status = hubClient.getStatus();

          return {
            success: true,
            data: {
              message: 'Connected to hub',
              connected: status.connected,
              authenticated: status.authenticated,
              gatewayId: status.gatewayId,
            },
          };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to connect',
          };
        }
      },
    },

    // PUT /hub/config - Update hub configuration (API key + auto hub URL)
    {
      method: 'PUT',
      pattern: /^\/hub\/config$/,
      handler: async (req: ParsedRequest) => {
        const { apiKey, hubUrl, reconnect } = req.body || {};

        if (apiKey !== undefined && typeof apiKey !== 'string') {
          return { success: false, error: 'apiKey must be a string' };
        }

        try {
          const updates: Record<string, string> = {};

          if (apiKey !== undefined) {
            process.env.TIER_AGENT_API_KEY = apiKey;
            updates['TIER_AGENT_API_KEY'] = apiKey;
          }

          // Allow explicit hubUrl override, otherwise keep existing
          if (hubUrl !== undefined && typeof hubUrl === 'string') {
            process.env.TIER_AGENT_HUB_URL = hubUrl;
            updates['TIER_AGENT_HUB_URL'] = hubUrl;
          }

          // Persist to .env file
          if (Object.keys(updates).length > 0) {
            persistToEnvFile(updates);
          }

          // If API key was cleared, disconnect
          if (apiKey === '') {
            try {
              await resetHubClient();
            } catch { /* ignore disconnect errors */ }

            return {
              success: true,
              data: {
                message: 'API key removed. Disconnected from hub.',
                connected: false,
              },
            };
          }

          // Optionally reconnect with new config
          if (reconnect && isHubConfigured()) {
            await resetHubClient();
            const hubClient = getHubClient();
            await hubClient.connect();

            // Wait a moment for auth to complete
            await new Promise(resolve => setTimeout(resolve, 1500));

            const status = hubClient.getStatus();

            return {
              success: true,
              data: {
                message: status.authenticated
                  ? 'API key saved. Connected and authenticated.'
                  : status.connected
                    ? 'API key saved. Connected but authentication pending...'
                    : 'API key saved. Connection failed.',
                connected: status.connected,
                authenticated: status.authenticated,
                gatewayId: status.gatewayId,
              },
            };
          }

          return {
            success: true,
            data: {
              message: 'Configuration saved',
              updated: Object.keys(updates),
            },
          };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update config',
          };
        }
      },
    },

    // POST /hub/reconnect - Reconnect the hub client
    {
      method: 'POST',
      pattern: /^\/hub\/reconnect$/,
      handler: async () => {
        if (!isHubConfigured()) {
          return {
            success: false,
            error: 'Hub client not configured. Set an API key first.',
          };
        }

        const result = await reconnectHubClient();

        if (result.success) {
          const hubClient = getHubClient();
          const status = hubClient.getStatus();

          return {
            success: true,
            data: {
              message: 'Hub client reconnected',
              connected: status.connected,
              gatewayId: status.gatewayId,
            },
          };
        }

        return {
          success: false,
          error: result.error || 'Failed to reconnect',
        };
      },
    },
    // GET /hub/user - Get authenticated user info from hub
    {
      method: 'GET',
      pattern: /^\/hub\/user$/,
      handler: async () => {
        if (!isHubConfigured()) {
          return { success: false, error: 'Hub not configured' };
        }

        const hubClient = getHubClient();
        const status = hubClient.getStatus();
        if (!status.authenticated) {
          return { success: false, error: 'Not authenticated' };
        }

        try {
          const config = getHubConfig();
          // Convert ws:// to http:// or wss:// to https://
          const hubHttpUrl = (config.hubUrl || '')
            .replace(/^ws:/, 'http:')
            .replace(/^wss:/, 'https:');

          const res = await fetch(`${hubHttpUrl}/auth/validate`, {
            headers: { 'Authorization': `Bearer ${config.apiKey}` },
          });

          if (!res.ok) {
            return { success: false, error: `Hub returned ${res.status}` };
          }

          const json = await res.json() as { valid?: boolean; user?: Record<string, any> };
          if (!json.valid || !json.user) {
            return { success: false, error: 'Invalid auth response' };
          }

          const u = json.user;
          return {
            success: true,
            data: {
              id: u.id,
              email: u.email,
              displayName: u.displayName || u.display_name,
              avatarUrl: u.avatarUrl || u.avatar_url,
              oauthProvider: u.oauthProvider || u.oauth_provider,
              organizationId: u.organizationId || u.organization_id,
            },
          };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to fetch user info',
          };
        }
      },
    },
  ];
}

/**
 * Persist environment variable updates to the .env file.
 * Creates the file if it doesn't exist. Updates existing keys or appends new ones.
 * If value is empty string, removes the key from .env.
 */
function persistToEnvFile(updates: Record<string, string>): void {
  // Walk up from tier-agent-core to find the project root .env
  let envPath = path.resolve(process.cwd(), '.env');

  // If CWD doesn't have .env, try the parent (tier-agent project root)
  if (!fs.existsSync(envPath)) {
    const parentEnv = path.resolve(process.cwd(), '..', '.env');
    if (fs.existsSync(parentEnv)) {
      envPath = parentEnv;
    }
  }

  let lines: string[] = [];
  if (fs.existsSync(envPath)) {
    lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  }

  for (const [key, value] of Object.entries(updates)) {
    const idx = lines.findIndex(l => l.startsWith(`${key}=`));

    if (value === '') {
      // Remove the key entirely
      if (idx >= 0) {
        lines.splice(idx, 1);
      }
    } else {
      const line = `${key}=${value}`;
      if (idx >= 0) {
        lines[idx] = line;
      } else {
        lines.push(line);
      }
    }
  }

  // Remove trailing empty lines, then ensure single trailing newline
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  lines.push('');

  fs.writeFileSync(envPath, lines.join('\n'), 'utf-8');
}
