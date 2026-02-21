/**
 * lm-assist OpenClaw Plugin
 *
 * Entry point for the OpenClaw plugin. Registers lm-assist as a channel
 * so users can interact with Claude Code sessions from any chat platform.
 *
 * Installation:
 *   1. In OpenClaw config, add to extensions: "lm-assist-openclaw"
 *   2. Configure the channel:
 *      ```json5
 *      {
 *        channels: {
 *          "lm-assist": {
 *            enabled: true,
 *            apiUrl: "http://localhost:3100",
 *            dmPolicy: "allowlist",
 *            allowFrom: ["your-peer-id"],
 *            defaultProject: "/path/to/project",
 *            notifications: {
 *              progress: true,
 *              toolUse: false,
 *              taskUpdates: true,
 *              minIntervalMs: 5000,
 *              level: "normal"
 *            }
 *          }
 *        }
 *      }
 *      ```
 *   3. Start OpenClaw gateway — lm-assist plugin auto-connects
 *
 * Usage (from any chat app connected to OpenClaw):
 *   - Send any text → executes as Claude Code prompt
 *   - /status    → connection and session status
 *   - /sessions  → list active sessions
 *   - /abort     → abort current execution
 *   - /history   → recent conversation
 *   - /allow     → approve pending permission
 *   - /deny      → deny pending permission
 *   - /help      → show all commands
 */

import { LmAssistChannelPlugin } from './channel';

export type { LmAssistAccount, ResolvedAccount, OpenClawChannelConfig } from './types';
export type { ChannelMeta, PluginRuntime } from './channel';
export { LmAssistChannelPlugin } from './channel';
export { LmAssistClient } from './api-client';
export { SessionMap } from './session-map';
export { EventBridge } from './event-bridge';
export { MessageHandler } from './message-handler';

/**
 * OpenClaw Plugin Registration
 *
 * This follows the OpenClaw plugin convention:
 * ```typescript
 * const plugin = {
 *   id: string,
 *   name: string,
 *   register(api: OpenClawPluginApi) { ... }
 * };
 * export default plugin;
 * ```
 */

/** OpenClaw Plugin API (provided by OpenClaw at registration time) */
interface OpenClawPluginApi {
  registerChannel(options: { plugin: LmAssistChannelPlugin }): void;
}

const channelPlugin = new LmAssistChannelPlugin();

const plugin = {
  id: 'lm-assist',
  name: 'LM Assist',
  version: '0.1.0',
  description: 'Bridge chat apps to Claude Code sessions via lm-assist',

  /**
   * Called by OpenClaw when the plugin is loaded
   */
  register(api: OpenClawPluginApi): void {
    api.registerChannel({ plugin: channelPlugin });
  },

  /**
   * Direct access to the channel plugin instance
   * Useful for standalone usage (without OpenClaw framework)
   */
  getChannelPlugin(): LmAssistChannelPlugin {
    return channelPlugin;
  },
};

export default plugin;
