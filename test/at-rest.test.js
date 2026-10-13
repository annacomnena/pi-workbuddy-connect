import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAad,
  classifyAuthDocument,
  deriveProtectorKey,
  keyIdOf,
  keyIdsOf,
  openField,
  parseAtRestPayload,
  parseWrappedField,
  protectorKeysFromPayload,
  unwrapDocument,
} from '../src/credentials/at-rest.js';
import { makeAtRestKey, makeEncryptedAuthDocument, makePlainAuthDocument, wrapField } from './support/fixtures.js';

test('the helper payload derives a protector key stable across calls', () => {
  const { secret, key, keyId, payload } = makeAtRestKey();
  assert.deepEqual(deriveProtectorKey(secret), key);
  const keys = protectorKeysFromPayload(payload);
  assert.equal(keys.keyId, keyId);
  assert.equal(keyIdsOf([{ envelope: { keyId } }])[0], keyId);
  assert.equal(keyIdOf(key), keyId);
});

test('the payload validator rejects malformed and all-zero secrets', () => {
  assert.equal(parseAtRestPayload('{"version":2,"atRestSecretKey":"AAAA"}'), undefined);
  assert.equal(parseAtRestPayload('{"version":1,"atRestSecretKey":"AAAA"}'), undefined);
  assert.equal(parseAtRestPayload(`{"version":1,"atRestSecretKey":"${Buffer.alloc(32).toString('base64')}"}`), undefined);
  assert.notEqual(parseAtRestPayload(makeAtRestKey().payload), undefined);
});

test('AAD is a Buffer with the fixed framing prefix', () => {
  const aad = buildAad('0123456789abcdef', 1);
  assert.ok(Buffer.isBuffer(aad));
  assert.equal(aad.subarray(0, 7).toString('ascii'), 'WB-AAD\0');
});

test('encrypted document classifies, unwraps and opens to the original values', () => {
  const { key, keyId } = makeAtRestKey();
  const original = makeEncryptedAuthDocument(key, keyId);
  const classification = classifyAuthDocument(JSON.stringify(original));
  assert.equal(classification.format, 'encrypted');
  assert.equal(keyIdsOf(classification.wrapped.fields).length, 1);

  const rebuilt = unwrapDocument(classification, (field, envelope) => {
    const plaintext = openField(key, envelope);
    assert.notEqual(plaintext, undefined, `field ${field} must open`);
    return plaintext;
  });
  assert.equal(rebuilt.auth.accessToken, 'fixture-access-token-0123456789abcdef');
  assert.equal(rebuilt.auth.refreshToken, 'fixture-refresh-token-fedcba9876543210');
  assert.equal(classification.wrapped.document.auth.accessToken.$wbEncrypted, 1);
});

test('a wrong key fails to open the envelope', () => {
  const { keyId } = makeAtRestKey();
  const sealed = wrapField(makeAtRestKey().key, keyId, 'secret');
  const parsed = parseWrappedField(sealed);
  assert.equal(openField(makeAtRestKey().key, parsed.envelope), undefined);
  // keyId mismatch is reported, not silently accepted
  assert.notEqual(parsed.envelope.keyId, makeAtRestKey().keyId);
});

test('classifyAuthDocument distinguishes absent / plaintext / unrecognized', () => {
  assert.equal(classifyAuthDocument('').format, 'absent');
  assert.equal(classifyAuthDocument('   ').format, 'absent');
  assert.equal(classifyAuthDocument(JSON.stringify(makePlainAuthDocument())).format, 'plaintext');
  assert.equal(classifyAuthDocument('{not json').format, 'unrecognized');
  assert.equal(classifyAuthDocument('[]').format, 'unrecognized');
  // A wrapper claiming the flag with a broken envelope is unrecognized, never
  // treated as plaintext.
  assert.equal(classifyAuthDocument('{"auth":{"accessToken":{"$wbEncrypted":1,"envelope":"!!!"}}}').format, 'unrecognized');
});
