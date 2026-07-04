/**
 * WeChat connector — configuration (WeCom / 企业微信 微信客服 backend).
 *
 * Personal WeChat (the desktop Weixin app) has NO official automation API, and
 * the new Weixin 4.x UI is native Qt with no accessible message DOM — so unlike
 * the WhatsApp connector there is no local/CDP provider here. The ONLY official
 * way to read + respond to real WeChat users is WeCom's 微信客服 (WeChat Customer
 * Service) API: a verified business receives inbound messages via an encrypted
 * callback, pulls them with `kf/sync_msg`, and replies with `kf/send_msg`.
 *
 * This is the direct analog of the WhatsApp *server* (Meta Cloud API) backend:
 * the hub/node owns the credentials, receives over a webhook, and mirrors what
 * it ingests into a shared append-only message store (see store.ts). The MCP
 * surface + store schema mirror the WhatsApp connector.
 *
 * Credentials live in `~/.lm-assist/wechat[-dev].json` (0600); the message log +
 * sync cursor live under `~/.lm-assist/wechat[-dev]/`. Every field may also be
 * supplied via env (WECHAT_KF_*), which takes precedence — handy for the hub.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mirror the dev/prod split used by the WhatsApp config + connectors.ts: a build
// that runs from the repo (not node_modules) talks to the dev files.
const IS_DEV_REPO = process.env.LM_ASSIST_PROD === 'true' ? false : !__dirname.includes('node_modules');
const DEV_SUFFIX = IS_DEV_REPO ? '-dev' : '';

const LM_DIR = path.join(os.homedir(), '.lm-assist');
export const WECHAT_CONFIG_FILE = path.join(LM_DIR, `wechat${DEV_SUFFIX}.json`);
/** Directory holding the message log + sync cursor for this env. */
export const WECHAT_DATA_DIR = path.join(LM_DIR, `wechat${DEV_SUFFIX}`);

/** WeCom API base. Overridable for a regional proxy via WECHAT_QYAPI_BASE. */
export const QYAPI_BASE = (process.env.WECHAT_QYAPI_BASE || 'https://qyapi.weixin.qq.com').replace(/\/+$/, '');

export interface WechatConfig {
  /** WeCom corp id (企业ID) — 我的企业 → 企业信息. Also the callback `receiveid`. */
  corpId?: string;
  /** 微信客服 app secret — 客户联系 → 微信客服 → API. Used with corpId for access_token. */
  kfSecret?: string;
  /** Callback Token you choose in the 微信客服 receive-message config. */
  callbackToken?: string;
  /** 43-char EncodingAESKey from the same config (base64 for the AES-256 key). */
  encodingAesKey?: string;
  /** Optional: pin one 客服账号 (open_kfid) as the default send/receive account. */
  openKfid?: string;
}

/** Fields a caller may set via PUT /wechat/config. */
export const CONFIG_FIELDS: ReadonlyArray<keyof WechatConfig> = [
  'corpId',
  'kfSecret',
  'callbackToken',
  'encodingAesKey',
  'openKfid',
];

const ENV_MAP: Record<keyof WechatConfig, string> = {
  corpId: 'WECHAT_KF_CORPID',
  kfSecret: 'WECHAT_KF_SECRET',
  callbackToken: 'WECHAT_KF_TOKEN',
  encodingAesKey: 'WECHAT_KF_AESKEY',
  openKfid: 'WECHAT_KF_OPEN_KFID',
};

function readFileConfig(): WechatConfig {
  try {
    return JSON.parse(fs.readFileSync(WECHAT_CONFIG_FILE, 'utf-8')) as WechatConfig;
  } catch {
    return {};
  }
}

/** Effective config: file values overlaid by any WECHAT_KF_* env vars. */
export function readWechatConfig(): WechatConfig {
  const cfg = readFileConfig();
  for (const key of CONFIG_FIELDS) {
    const env = process.env[ENV_MAP[key]];
    if (env) cfg[key] = env;
  }
  return cfg;
}

/** Merge `patch` into the saved config file and persist (0600). Returns effective config. */
export function writeWechatConfig(patch: Partial<WechatConfig>): WechatConfig {
  const next = { ...readFileConfig(), ...patch };
  fs.mkdirSync(LM_DIR, { recursive: true });
  fs.writeFileSync(WECHAT_CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return readWechatConfig();
}

/** Pulling/sending needs corp id + kf secret. */
export function isConfigured(cfg: WechatConfig = readWechatConfig()): boolean {
  return Boolean(cfg.corpId && cfg.kfSecret);
}

/** Webhook verify/decrypt needs the callback token + AES key + corp id. */
export function isWebhookConfigured(cfg: WechatConfig = readWechatConfig()): boolean {
  return Boolean(cfg.corpId && cfg.callbackToken && cfg.encodingAesKey);
}
