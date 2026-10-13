import assert from 'node:assert/strict';
import test from 'node:test';
import { findLeaks, isClean } from '../src/util/redact.js';

test('detects a JWT-shaped token', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  assert.ok(!isClean(`{"token":"${jwt}"}`));
  assert.equal(findLeaks(`x ${jwt}`)[0].pattern, 'jwt');
});

test('detects a Bearer header', () => {
  const hits = findLeaks('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345');
  assert.ok(hits.some((hit) => hit.pattern === 'bearer-header'));
});

test('detects an exact secret regardless of shape', () => {
  const secret = 'not-a-token-shape-but-secret';
  assert.ok(!isClean(`value=${secret}`, [secret]));
  assert.ok(isClean('value=redacted', [secret]));
});

test('detects a raw envelope', () => {
  assert.ok(!isClean('{"$wbEncrypted":1,"envelope":"AAAA"}'));
});

test('a masked document is clean', () => {
  const document = '{"accessTokenMasked":"eyJh\u2026w5c","reasonCode":"credential-missing"}';
  assert.ok(isClean(document, []));
});
