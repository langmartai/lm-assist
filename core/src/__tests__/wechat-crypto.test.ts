/**
 * WeCom (企业微信) callback crypto — WXBizMsgCrypt port unit tests.
 *
 * Validates the AES-256-CBC + manual-PKCS7 + [random|len|msg|receiveid] framing
 * and the sorted-sha1 signature against our own round-trip, plus the XML helpers.
 * The live callback (real EncodingAESKey from the WeCom console) is the final
 * check, but this proves the framing/signature pipeline is self-consistent.
 */

import { test } from 'node:test';
import * as assert from 'node:assert';
import {
  aesKeyFromEncoding,
  computeSignature,
  verifySignature,
  encrypt,
  decrypt,
  extractEncrypt,
  xmlField,
  WechatCryptoError,
} from '../wechat/crypto';

// base64 of 32 bytes without the trailing '=' → a valid 43-char EncodingAESKey.
const AESKEY = 'A'.repeat(43);
const CORP = 'ww1234567890abcdef';
const FIXED_RAND = Buffer.alloc(16, 7);

test('aesKeyFromEncoding rejects wrong length', () => {
  assert.throws(() => aesKeyFromEncoding('too-short'), WechatCryptoError);
  assert.strictEqual(aesKeyFromEncoding(AESKEY).length, 32);
});

test('encrypt → decrypt round-trips message + receiveid', () => {
  const msg = '<xml><ToUserName>kf</ToUserName><Event>kf_msg_or_event</Event><Token>ENQ123</Token></xml>';
  const enc = encrypt(AESKEY, msg, CORP, FIXED_RAND);
  const { message, receiveId } = decrypt(AESKEY, enc, CORP);
  assert.strictEqual(message, msg);
  assert.strictEqual(receiveId, CORP);
});

test('decrypt round-trips a unicode (echostr-style) payload', () => {
  const msg = '你好，微信客服 verification 1699999999';
  const enc = encrypt(AESKEY, msg, CORP, FIXED_RAND);
  assert.strictEqual(decrypt(AESKEY, enc, CORP).message, msg);
});

test('decrypt enforces the expected receiveid', () => {
  const enc = encrypt(AESKEY, 'hello', CORP, FIXED_RAND);
  assert.throws(() => decrypt(AESKEY, enc, 'ww_other_corp'), (e: unknown) => {
    return e instanceof WechatCryptoError && e.code === 'RECEIVEID_MISMATCH';
  });
});

test('signature is order-independent and verifies', () => {
  const token = 'MyCallbackToken';
  const ts = '1699999999';
  const nonce = 'abc123';
  const enc = 'CIPHERTEXT==';
  const sig = computeSignature(token, ts, nonce, enc);
  // sha1 hex is 40 chars.
  assert.strictEqual(sig.length, 40);
  assert.ok(verifySignature(token, ts, nonce, enc, sig));
  // tampering any input fails verification.
  assert.ok(!verifySignature(token, ts, nonce, enc, sig.replace(/.$/, '0')));
  assert.ok(!verifySignature(token, ts, 'different-nonce', enc, sig));
});

test('extractEncrypt pulls the CDATA-wrapped ciphertext', () => {
  const xml = '<xml><ToUserName><![CDATA[ww1]]></ToUserName><Encrypt><![CDATA[ABC123==]]></Encrypt></xml>';
  assert.strictEqual(extractEncrypt(xml), 'ABC123==');
  // also handles a bare (non-CDATA) value.
  assert.strictEqual(extractEncrypt('<xml><Encrypt>XYZ</Encrypt></xml>'), 'XYZ');
  assert.strictEqual(extractEncrypt('<xml></xml>'), null);
});

test('xmlField reads callback fields (CDATA + bare)', () => {
  const xml = '<xml><Event><![CDATA[kf_msg_or_event]]></Event><Token>ENQ_TOKEN_9</Token></xml>';
  assert.strictEqual(xmlField(xml, 'Event'), 'kf_msg_or_event');
  assert.strictEqual(xmlField(xml, 'Token'), 'ENQ_TOKEN_9');
  assert.strictEqual(xmlField(xml, 'Missing'), null);
});
