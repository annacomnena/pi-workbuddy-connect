// Self-made fixtures for the credential tests.
//
// Nothing here reads a real credential: the at-rest key is generated locally,
// the credential values are obviously fake, and the envelope is built by the
// same framing the tests then open.

import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { buildAad } from '../../src/credentials/at-rest.js';

/** Generate a protector key + helper payload the way the app would. */
export function makeAtRestKey() {
  const secret = randomBytes(32).toString('base64');
  const key = createHash('sha256').update(secret, 'utf8').digest();
  const keyId = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return {
    secret,
    key,
    keyId,
    payload: JSON.stringify({ version: 1, atRestSecretKey: secret }),
  };
}

/** Seal one field with the given key, using the observed envelope framing. */
export function wrapField(key, keyId, plaintext) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(buildAad(keyId, 1));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    $wbEncrypted: 1,
    envelope: Buffer.from(JSON.stringify({
      suite: 1,
      keyId,
      nonce: nonce.toString('base64'),
      authTag: authTag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    })).toString('base64'),
  };
}

export const FAKE_ACCESS_TOKEN = 'fixture-access-token-0123456789abcdef';
export const FAKE_REFRESH_TOKEN = 'fixture-refresh-token-fedcba9876543210';
export const FAKE_UID = 'fixture-uid-0000-1111-2222-333333333333';

/** A plaintext auth document (no envelopes), for shell-level tests. */
export function makePlainAuthDocument({
  accessToken = FAKE_ACCESS_TOKEN,
  refreshToken = FAKE_REFRESH_TOKEN,
  domain = 'www.codebuddy.cn',
  uid = FAKE_UID,
  enterpriseId,
  expiresInMs = 24 * 60 * 60 * 1000,
} = {}) {
  return {
    account: {
      uid,
      uin: '123456789012',
      nickname: 'fixture-nick',
      ...(enterpriseId === undefined ? {} : { enterpriseId }),
    },
    auth: {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresInMs,
      refreshExpiresAt: Date.now() + expiresInMs * 2,
      domain,
      tokenType: 'Bearer',
    },
  };
}

/** An encrypted auth document sealed with the given key. */
export function makeEncryptedAuthDocument(key, keyId, options = {}) {
  const document = makePlainAuthDocument(options);
  return {
    account: {
      ...document.account,
      nickname: wrapField(key, keyId, 'fixture-nick'),
    },
    auth: {
      ...document.auth,
      accessToken: wrapField(key, keyId, options.accessToken ?? FAKE_ACCESS_TOKEN),
      refreshToken: wrapField(key, keyId, options.refreshToken ?? FAKE_REFRESH_TOKEN),
    },
  };
}
