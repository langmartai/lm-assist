/**
 * OpenClaw Channel Plugin
 *
 * Implements the ChannelPlugin interface for OpenClaw integration.
 * This makes lm-assist available as a channel in OpenClaw, allowing
 * users to interact with Claude Code through any chat platform that
 * OpenClaw supports (WhatsApp, Telegram, Discord, Slack, etc.).
 *
 * Architecture:
 * - Inbound: OpenClaw routes user messages → MessageHandler → lm-assist API
 * - Outbound: EventBridge subscribes to SSE → formats → sends via OpenClaw
 */

import type {
  LmAssistAccount,
  ResolvedAccount,
  OpenClawChannelConfig,
  NotificationConfig,
  InboundMessage,
  OutboundMessage,
  SseUserQuestion,
  SsePermissionRequest,
} from './types';
import { LmAssistClient } from './api-client';
import { SessionMap } from './session-map';
import { EventBridge } from './event-bridge';
import { MessageHandler } from './message-handler';

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  progress: true,
  toolUse: false,
  taskUpdates: true,
  minIntervalMs: 5000,
  level: 'normal',
};

const DEFAULT_CONFIG: OpenClawChannelConfig = {
  enabled: true,
  apiUrl: 'http://localhost:3100',
  dmPolicy: 'allowlist',
  allowFrom: [],
  notifications: DEFAULT_NOTIFICATION_CONFIG,
  accounts: {
    default: {
      apiUrl: 'http://localhost:3100',
      enabled: true,
    },
  },
};

// ============================================================================
// Channel Plugin Types (OpenClaw ChannelPlugin interface)
// ============================================================================

/**
 * OpenClaw ChannelPlugin interface (simplified — real interface comes from OpenClaw SDK)
 *
 * This is a structural type that matches OpenClaw's ChannelPlugin pattern.
 * When OpenClaw publishes an SDK package, these types should be imported from there.
 */

export interface ChannelMeta {
  id: string;
  name: string;
  description: string;
  icon?: string;
  capabilities: {
    directMessages: boolean;
    groups: boolean;
    threads: boolean;
    media: boolean;
    reactions: boolean;
    polls: boolean;
  };
}

export interface ChannelConfigAdapter<TAccount = LmAssistAccount> {
  /** Get default configuration */
  getDefaultConfig(): OpenClawChannelConfig;
  /** Validate configuration */
  validateConfig(config: unknown): { valid: boolean; errors?: string[] };
  /** Resolve account from config */
  resolveAccount(accountId: string, config: OpenClawChannelConfig): ResolvedAccount | null;
  /** List configured accounts */
  listAccounts(config: OpenClawChannelConfig): Array<{ id: string; account: TAccount }>;
}

export interface ChannelSecurityAdapter {
  /** Check if a sender is allowed */
  isAllowed(senderId: string, config: OpenClawChannelConfig): boolean;
}

export interface ChannelMessagingAdapter {
  /** Normalize a target identifier */
  normalizeTarget(target: string): string;
}

export interface ChannelOutboundAdapter {
  /** Send a message to a target */
  send(message: OutboundMessage): Promise<void>;
}

export interface ChannelStatusAdapter {
  /** Get channel health status */
  getStatus(): Promise<{ connected: boolean; lastError?: string }>;
}

// ============================================================================
// Plugin Runtime
// ============================================================================

/**
 * OpenClaw PluginRuntime — provided by OpenClaw when the plugin is loaded
 */
export interface PluginRuntime {
  /** Send a message through the gateway */
  sendMessage(channel: string, accountId: string, target: string, text: string): Promise<void>;
  /** Get plugin configuration */
  getConfig(): OpenClawChannelConfig;
  /** Log */
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

// ============================================================================
// Channel Plugin Implementation
// ============================================================================

/**
 * lm-assist Channel Plugin for OpenClaw
 */
export class LmAssistChannelPlugin {
  readonly id = 'lm-assist';

  readonly meta: ChannelMeta = {
    id: 'lm-assist',
    name: 'LM Assist',
    description: 'Bridge chat to Claude Code sessions via lm-assist',
    capabilities: {
      directMessages: true,
      groups: false,
      threads: false,
      media: false,
      reactions: false,
      polls: false,
    },
  };

  // Internal components (initialized on start)
  private client: LmAssistClient | null = null;
  private sessionMap: SessionMap | null = null;
  private eventBridge: EventBridge | null = null;
  private messageHandler: MessageHandler | null = null;
  private runtime: PluginRuntime | null = null;
  private config: OpenClawChannelConfig = DEFAULT_CONFIG;
  private started = false;

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /**
   * Initialize the plugin with OpenClaw runtime
   */
  init(runtime: PluginRuntime): void {
    this.runtime = runtime;
    this.config = { ...DEFAULT_CONFIG, ...runtime.getConfig() };
  }

  /**
   * Start the plugin (connect to lm-assist API)
   */
  async start(): Promise<void> {
    if (this.started) return;

    const apiUrl = this.config.apiUrl;
    this.client = new LmAssistClient(apiUrl);

    // Verify API is reachable
    const healthy = await this.client.healthCheck();
    if (!healthy) {
      this.log('warn', `lm-assist API not reachable at ${apiUrl}`);
    }

    this.sessionMap = new SessionMap();

    // Create send callback that routes through OpenClaw
    const sendCallback = async (msg: OutboundMessage): Promise<void> => {
      if (this.runtime) {
        await this.runtime.sendMessage('lm-assist', 'default', msg.peerId, msg.text);
      }
    };

    // Create blocking event callback
    const blockingCallback = (
      peerId: string,
      event: SseUserQuestion | SsePermissionRequest
    ): void => {
      this.messageHandler?.registerBlockingEvent(peerId, event);
    };

    this.eventBridge = new EventBridge({
      apiUrl,
      apiClient: this.client,
      sendCallback,
      blockingCallback,
      sessionMap: this.sessionMap,
      notificationConfig: this.config.notifications,
    });

    this.messageHandler = new MessageHandler({
      client: this.client,
      sessionMap: this.sessionMap,
      eventBridge: this.eventBridge,
      sendFn: sendCallback,
      defaultProject: this.config.defaultProject,
    });

    this.started = true;
    this.log('info', `lm-assist plugin started (API: ${apiUrl})`);
  }

  /**
   * Stop the plugin
   */
  async stop(): Promise<void> {
    if (!this.started) return;

    this.eventBridge?.unsubscribeAll();
    this.client = null;
    this.sessionMap = null;
    this.eventBridge = null;
    this.messageHandler = null;
    this.started = false;

    this.log('info', 'lm-assist plugin stopped');
  }

  // ============================================================================
  // Inbound Message Handling
  // ============================================================================

  /**
   * Handle an inbound message from a chat user (called by OpenClaw gateway)
   */
  async handleMessage(message: InboundMessage): Promise<void> {
    if (!this.started || !this.messageHandler) {
      this.log('warn', 'Plugin not started, ignoring message');
      return;
    }

    // Security: check allowlist
    if (!this.isAllowed(message.peerId)) {
      this.log('warn', `Rejected message from unauthorized peer: ${message.peerId}`);
      return;
    }

    await this.messageHandler.handle(message);
  }

  // ============================================================================
  // Config Adapter
  // ============================================================================

  readonly configAdapter: ChannelConfigAdapter = {
    getDefaultConfig: () => DEFAULT_CONFIG,

    validateConfig: (config: unknown): { valid: boolean; errors?: string[] } => {
      const errors: string[] = [];
      if (typeof config !== 'object' || config === null) {
        return { valid: false, errors: ['Config must be an object'] };
      }
      const c = config as Partial<OpenClawChannelConfig>;
      if (c.apiUrl && typeof c.apiUrl !== 'string') {
        errors.push('apiUrl must be a string');
      }
      if (c.dmPolicy && !['pairing', 'allowlist', 'open', 'disabled'].includes(c.dmPolicy)) {
        errors.push('dmPolicy must be pairing|allowlist|open|disabled');
      }
      return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
    },

    resolveAccount: (
      accountId: string,
      config: OpenClawChannelConfig
    ): ResolvedAccount | null => {
      const account = config.accounts[accountId];
      if (!account) return null;
      return { ...account, accountId };
    },

    listAccounts: (
      config: OpenClawChannelConfig
    ): Array<{ id: string; account: LmAssistAccount }> => {
      return Object.entries(config.accounts).map(([id, account]) => ({ id, account }));
    },
  };

  // ============================================================================
  // Security Adapter
  // ============================================================================

  readonly securityAdapter: ChannelSecurityAdapter = {
    isAllowed: (senderId: string, config: OpenClawChannelConfig): boolean => {
      if (config.dmPolicy === 'disabled') return false;
      if (config.dmPolicy === 'open') return true;
      if (config.dmPolicy === 'allowlist') {
        return config.allowFrom.includes(senderId) || config.allowFrom.includes('*');
      }
      // 'pairing' — needs separate pairing flow (TODO)
      return false;
    },
  };

  /**
   * Internal isAllowed check using current config
   */
  private isAllowed(senderId: string): boolean {
    return this.securityAdapter.isAllowed(senderId, this.config);
  }

  // ============================================================================
  // Messaging Adapter
  // ============================================================================

  readonly messagingAdapter: ChannelMessagingAdapter = {
    normalizeTarget: (target: string): string => {
      // lm-assist peer IDs are opaque — pass through
      return target.trim();
    },
  };

  // ============================================================================
  // Outbound Adapter
  // ============================================================================

  readonly outboundAdapter: ChannelOutboundAdapter = {
    send: async (message: OutboundMessage): Promise<void> => {
      if (this.runtime) {
        await this.runtime.sendMessage('lm-assist', 'default', message.peerId, message.text);
      }
    },
  };

  // ============================================================================
  // Status Adapter
  // ============================================================================

  readonly statusAdapter: ChannelStatusAdapter = {
    getStatus: async (): Promise<{ connected: boolean; lastError?: string }> => {
      if (!this.client) {
        return { connected: false, lastError: 'Plugin not started' };
      }
      const healthy = await this.client.healthCheck();
      return {
        connected: healthy,
        lastError: healthy ? undefined : 'lm-assist API unreachable',
      };
    },
  };

  // ============================================================================
  // Utilities
  // ============================================================================

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    if (this.runtime) {
      this.runtime.log(level, `[lm-assist] ${message}`);
    } else {
      const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      fn(`[lm-assist] ${message}`);
    }
  }
}
