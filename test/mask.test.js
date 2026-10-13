import assert from 'node:assert/strict';
import test from 'node:test';
import { maskIdentifier, maskKeyId, maskSecret } from '../src/util/mask.js';

test('maskSecret keeps only a 4+4 window', () => {
  assert.equal(maskSecret('abcdefghijklmnop'), 'abcd\u2026mnop');
  assert.equal(maskSecret('short'), '*****');
  assert.equal(maskSecret(''), null);
  assert.equal(maskSecret(undefined), null);
});

test('maskIdentifier keeps only a 3+2 window', () => {
  assert.equal(maskIdentifier('fixture-uid-0000-1111-2222-333333333333'), 'fix\u202633');
  assert.equal(maskIdentifier('abc'), '***');
  assert.equal(maskIdentifier(''), null);
});

test('maskKeyId masks a 16-hex key id', () => {
  assert.equal(maskKeyId('0123456789abcdef'), '0123\u2026cdef');
  assert.equal(maskKeyId('abc'), '***');
});
