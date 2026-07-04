/**
 * WeCom (企业微信) callback cryptography — WXBizMsgCrypt, ported to Node crypto.
 *
 * The 微信客服 receive-message callback is signed + AES-encrypted exactly like
 * every WeCom callback:
 *
 *   - AES key   = base64decode(EncodingAESKey + "=")   → 32 bytes (AES-256)
 *   - IV        = first 16 bytes of the AES key
 *   - cipher    = AES-256-CBC, PKCS#7 padding applied MANUALLY (setAutoPadding
 *                 false), because Tencent pads to a 32-byte block and prepends a
 *                 16-byte random prefix + a 4-byte big-endian length.
 *   - plaintext = [16 random][4 msgLen BE][msg (msgLen bytes)][receiveid]
 *   - signature = sha1( sort([token, timestamp, nonce, encrypt]).join('') )
 *
 * `receiveid` is the corp id (企业ID) for a 微信客服 callback; we verify it to
 * reject payloads meant for another corp.
 *
 * Reference: Tencent "加解密方案说明" / WXBizMsgCrypt sample implementations.
 */

import * as crypto from 'crypto';

export class WechatCryptoError extends Error {
  code: string;
  constructor(message: string, code = 'WECHAT_CRYPTO') {
    super(message);
    this.name = 'WechatCryptoError';
    this.code = code;
  }
}

/** Decode a 43-char EncodingAESKey into the raw 32-byte AES-256 key. */
export function aesKeyFromEncoding(encodingAesKey: string): Buffer {
  const k = String(encodingAesKey || '').trim();
  if (k.length !== 43) {
    throw new WechatCryptoError(`EncodingAESKey must be 43 chars, got ${k.length}`, 'BAD_AESKEY');
  }
  const key = Buffer.from(k + '=', 'base64');
  if (key.length !== 32) {
    throw new WechatCryptoError(`decoded AES key must be 32 bytes, got ${key.length}`, 'BAD_AESKEY');
  }
  return key;
}

/** sha1(sorted([token, timestamp, nonce, encrypt]).join('')) as lowercase hex. */
export function computeSignature(token: string, timestamp: string, nonce: string, encrypt: string): string {
  const arr = [token, timestamp, nonce, encrypt].sort();
  return crypto.createHash('sha1').update(arr.join(''), 'utf8').digest('hex');
}

/** Constant-time compare of a caller-supplied msg_signature against the computed one. */
export function verifySignature(
  token: string,
  timestamp: string,
  nonce: string,
  encrypt: string,
  msgSignature: string,
): boolean {
  const expected = computeSignature(token, timestamp, nonce, encrypt);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(msgSignature || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function stripPkcs7(buf: Buffer): Buffer {
  if (buf.length === 0) return buf;
  let pad = buf[buf.length - 1];
  if (pad < 1 || pad > 32) pad = 0;
  return buf.subarray(0, buf.length - pad);
}

function pkcs7Pad(buf: Buffer, blockSize = 32): Buffer {
  let padLen = blockSize - (buf.length % blockSize);
  if (padLen === 0) padLen = blockSize;
  return Buffer.concat([buf, Buffer.alloc(padLen, padLen)]);
}

export interface DecryptResult {
  /** The decrypted message payload (XML for POST callbacks, echostr text for GET verify). */
  message: string;
  /** The `receiveid` trailer — the corp id for a 微信客服 callback. */
  receiveId: string;
}

/**
 * Decrypt a base64 `Encrypt`/`echostr` ciphertext. If `expectedReceiveId` is
 * given, throws when the trailing receive id does not match (wrong corp).
 */
export function decrypt(encodingAesKey: string, encrypted: string, expectedReceiveId?: string): DecryptResult {
  const key = aesKeyFromEncoding(encodingAesKey);
  const iv = key.subarray(0, 16);
  const cipherText = Buffer.from(String(encrypted || ''), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);
  let decoded: Buffer;
  try {
    decoded = Buffer.concat([decipher.update(cipherText), decipher.final()]);
  } catch (e) {
    throw new WechatCryptoError(`AES decrypt failed: ${e instanceof Error ? e.message : String(e)}`, 'DECRYPT_FAILED');
  }
  const content = stripPkcs7(decoded);
  if (content.length < 20) {
    throw new WechatCryptoError('decrypted payload too short', 'DECRYPT_FAILED');
  }
  // [16 random][4 msgLen BE][msg][receiveid]
  const msgLen = content.readUInt32BE(16);
  if (20 + msgLen > content.length) {
    throw new WechatCryptoError('declared message length exceeds payload', 'DECRYPT_FAILED');
  }
  const message = content.subarray(20, 20 + msgLen).toString('utf8');
  const receiveId = content.subarray(20 + msgLen).toString('utf8');
  if (expectedReceiveId && receiveId !== expectedReceiveId) {
    throw new WechatCryptoError(`receiveid mismatch (got "${receiveId}")`, 'RECEIVEID_MISMATCH');
  }
  return { message, receiveId };
}

/**
 * Encrypt a plaintext message into the base64 `Encrypt` form. Used by tests and
 * available for passive-XML replies; the 微信客服 active model replies via the
 * API instead, so production ingest only needs `decrypt`.
 *
 * `random16` is injected in tests for determinism; production uses random bytes.
 */
export function encrypt(
  encodingAesKey: string,
  message: string,
  receiveId: string,
  random16?: Buffer,
): string {
  const key = aesKeyFromEncoding(encodingAesKey);
  const iv = key.subarray(0, 16);
  const rand = random16 && random16.length === 16 ? random16 : crypto.randomBytes(16);
  const msgBuf = Buffer.from(message, 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgBuf.length, 0);
  const raw = Buffer.concat([rand, lenBuf, msgBuf, Buffer.from(receiveId, 'utf8')]);
  const padded = pkcs7Pad(raw, 32);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  cipher.setAutoPadding(false);
  const out = Buffer.concat([cipher.update(padded), cipher.final()]);
  return out.toString('base64');
}

/** Pull the `<Encrypt>…</Encrypt>` value out of a WeCom callback XML body. */
export function extractEncrypt(xml: string): string | null {
  const m = /<Encrypt>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/Encrypt>/.exec(String(xml || ''));
  return m ? m[1].trim() : null;
}

/** Minimal field extractor for the decrypted callback XML (CDATA-aware). */
export function xmlField(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`);
  const m = re.exec(String(xml || ''));
  return m ? m[1].trim() : null;
}
