/**
 * WeCom (企业微信) 微信客服 API client.
 *
 * Thin wrapper over qyapi.weixin.qq.com covering exactly what the connector
 * needs: an access-token cache, incremental message pull (`kf/sync_msg`),
 * reply (`kf/send_msg`), 客服账号 listing, customer name resolution, and media
 * download. Every call surfaces WeCom's `{errcode,errmsg}` as a typed WeError.
 *
 * Access tokens are corp+secret scoped and last ~2h; we cache until shortly
 * before expiry and transparently refresh on the token-expired errcodes.
 */

import { QYAPI_BASE, readWechatConfig, isConfigured, type WechatConfig } from './config';

export class WeError extends Error {
  code: string;
  errcode?: number;
  constructor(message: string, code = 'WECHAT_API', errcode?: number) {
    super(message);
    this.name = 'WeError';
    this.code = code;
    this.errcode = errcode;
  }
}

interface WeComBase {
  errcode: number;
  errmsg: string;
}

/** errcodes that mean "access_token no longer valid" — refetch + retry once. */
const TOKEN_EXPIRED = new Set([40014, 41001, 42001]);

let tokenCache: { key: string; token: string; expiresAt: number } | null = null;

function cfgKey(cfg: WechatConfig): string {
  return `${cfg.corpId}:${cfg.kfSecret}`;
}

/** Fetch (and cache) an access_token for the configured corp id + 微信客服 secret. */
export async function getAccessToken(force = false): Promise<string> {
  const cfg = readWechatConfig();
  if (!isConfigured(cfg)) {
    throw new WeError('WeChat 微信客服 is not configured (need corpId + kfSecret)', 'NOT_CONFIGURED');
  }
  const key = cfgKey(cfg);
  const now = Date.now();
  if (!force && tokenCache && tokenCache.key === key && tokenCache.expiresAt > now + 30_000) {
    return tokenCache.token;
  }
  const url = `${QYAPI_BASE}/cgi-bin/gettoken?corpid=${encodeURIComponent(cfg.corpId!)}&corpsecret=${encodeURIComponent(cfg.kfSecret!)}`;
  const resp = await fetch(url);
  const data = (await resp.json()) as WeComBase & { access_token?: string; expires_in?: number };
  if (data.errcode && data.errcode !== 0) {
    throw new WeError(`gettoken failed: ${data.errmsg} (${data.errcode})`, 'TOKEN_FAILED', data.errcode);
  }
  if (!data.access_token) throw new WeError('gettoken returned no access_token', 'TOKEN_FAILED');
  tokenCache = { key, token: data.access_token, expiresAt: now + (data.expires_in || 7200) * 1000 };
  return data.access_token;
}

/** POST JSON to a cgi-bin path with the access token, retrying once on token expiry. */
async function apiPost<T extends WeComBase>(cgiPath: string, body: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getAccessToken(attempt === 1);
    const url = `${QYAPI_BASE}${cgiPath}${cgiPath.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await resp.json()) as T;
    if (data.errcode && TOKEN_EXPIRED.has(data.errcode) && attempt === 0) continue;
    if (data.errcode && data.errcode !== 0) {
      throw new WeError(`${cgiPath} failed: ${data.errmsg} (${data.errcode})`, 'API_ERROR', data.errcode);
    }
    return data;
  }
  throw new WeError(`${cgiPath} failed after token refresh`, 'API_ERROR');
}

// ─── 微信客服 message pull ──────────────────────────────────────────────────

export interface KfMsgItem {
  msgid: string;
  open_kfid?: string;
  external_userid?: string;
  send_time?: number;
  /** 3 = user, 4 = system event, 5 = servicer/kf reply. */
  origin?: number;
  servicer_userid?: string;
  msgtype: string;
  text?: { content?: string; menu_id?: string };
  image?: { media_id?: string };
  voice?: { media_id?: string };
  video?: { media_id?: string };
  file?: { media_id?: string };
  location?: { name?: string; address?: string; latitude?: number; longitude?: number };
  link?: { title?: string; desc?: string; url?: string };
  event?: Record<string, unknown> & { event_type?: string };
  [k: string]: unknown;
}

export interface SyncMsgResult {
  next_cursor?: string;
  has_more?: number;
  msg_list?: KfMsgItem[];
}

/**
 * Pull the next batch of 微信客服 messages. `token` is the short-lived push token
 * from the callback event (recommended, scopes the pull to the new activity);
 * `cursor` continues a prior pull. Both optional on a cold start.
 */
export async function syncMsg(opts: {
  cursor?: string;
  token?: string;
  limit?: number;
  openKfid?: string;
}): Promise<SyncMsgResult> {
  const body: Record<string, unknown> = { limit: Math.min(Math.max(opts.limit || 1000, 1), 1000) };
  if (opts.cursor) body.cursor = opts.cursor;
  if (opts.token) body.token = opts.token;
  if (opts.openKfid) body.open_kfid = opts.openKfid;
  return apiPost<WeComBase & SyncMsgResult>('/cgi-bin/kf/sync_msg', body);
}

// ─── 微信客服 reply ─────────────────────────────────────────────────────────

/** Send a text reply to a WeChat user within the 48h service window. Returns msgid. */
export async function sendText(touser: string, openKfid: string, content: string): Promise<string> {
  const data = await apiPost<WeComBase & { msgid?: string }>('/cgi-bin/kf/send_msg', {
    touser,
    open_kfid: openKfid,
    msgtype: 'text',
    text: { content },
  });
  return data.msgid || '';
}

// ─── 客服账号 + customer resolution ─────────────────────────────────────────

export interface KfAccount {
  open_kfid: string;
  name?: string;
  avatar?: string;
}

/** List the corp's 客服账号 (customer-service accounts). */
export async function listKfAccounts(): Promise<KfAccount[]> {
  const data = await apiPost<WeComBase & { account_list?: KfAccount[] }>('/cgi-bin/kf/account/list', {
    offset: 0,
    limit: 100,
  });
  return data.account_list || [];
}

export interface KfCustomer {
  external_userid: string;
  nickname?: string;
  avatar?: string;
}

/** Resolve up to 100 external_userids to their nickname/avatar. */
export async function batchGetCustomers(externalUserids: string[]): Promise<KfCustomer[]> {
  if (externalUserids.length === 0) return [];
  const data = await apiPost<WeComBase & { customer_list?: KfCustomer[] }>('/cgi-bin/kf/customer/batchget', {
    external_userid_list: externalUserids.slice(0, 100),
    need_enter_session_context: 0,
  });
  return data.customer_list || [];
}

// ─── Media ──────────────────────────────────────────────────────────────────

export interface MediaResult {
  buffer: Buffer;
  contentType: string;
  filename?: string;
}

/** Download an inbound media object by media_id. */
export async function getMedia(mediaId: string): Promise<MediaResult> {
  const token = await getAccessToken();
  const url = `${QYAPI_BASE}/cgi-bin/media/get?access_token=${encodeURIComponent(token)}&media_id=${encodeURIComponent(mediaId)}`;
  const resp = await fetch(url);
  const contentType = resp.headers.get('content-type') || 'application/octet-stream';
  // An error comes back as JSON, not the binary.
  if (contentType.includes('application/json')) {
    const data = (await resp.json()) as WeComBase;
    throw new WeError(`media/get failed: ${data.errmsg} (${data.errcode})`, 'API_ERROR', data.errcode);
  }
  const disposition = resp.headers.get('content-disposition') || '';
  const fnMatch = /filename="?([^"]+)"?/.exec(disposition);
  const buffer = Buffer.from(await resp.arrayBuffer());
  return { buffer, contentType, filename: fnMatch ? fnMatch[1] : undefined };
}

/** Test-only: clear the token cache. */
export function _resetTokenCacheForTest(): void {
  tokenCache = null;
}
