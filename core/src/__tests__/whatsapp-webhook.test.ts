import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { verifySignature } from '../whatsapp/webhook';
import { writeWhatsappConfig, WA_CONFIG_FILE } from '../whatsapp/config';

const SECRET = 'test-app-secret';
const BODY = '{"entry":[]}';

function sign(body: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

describe('whatsapp webhook verifySignature', () => {
  const preExisting = fs.existsSync(WA_CONFIG_FILE) ? fs.readFileSync(WA_CONFIG_FILE) : null;

  after(() => {
    if (preExisting) fs.writeFileSync(WA_CONFIG_FILE, preExisting);
    else fs.rmSync(WA_CONFIG_FILE, { force: true });
  });

  it('fails closed when no app secret is configured (no fail-open)', () => {
    fs.rmSync(WA_CONFIG_FILE, { force: true });
    assert.equal(verifySignature(BODY, sign(BODY, 'anything')), false);
    assert.equal(verifySignature(BODY, undefined), false);
  });

  describe('with an app secret configured', () => {
    before(() => {
      writeWhatsappConfig({ appSecret: SECRET });
    });

    it('rejects a missing signature header', () => {
      assert.equal(verifySignature(BODY, undefined), false);
    });

    it('rejects a wrong signature', () => {
      assert.equal(verifySignature(BODY, sign(BODY, 'wrong-secret')), false);
      assert.equal(verifySignature(BODY, 'sha256=not-even-hex-of-right-length-000000000000000000000000000000'), false);
    });

    it('accepts a correctly-signed body', () => {
      assert.equal(verifySignature(BODY, sign(BODY, SECRET)), true);
    });

    it('rejects the correct signature over a tampered body', () => {
      assert.equal(verifySignature(BODY + 'tampered', sign(BODY, SECRET)), false);
    });
  });
});
