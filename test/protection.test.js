import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  KEY_SOURCE_AT_REST,
  PROTECTION_AES_GCM,
  createOsKeyStore,
  describeOsKeySource,
  openCredential,
  osKeySourceFor,
  sealCredential,
} from '../src/credentials/protection.js';
import { ownFileMode } from '../src/credentials/store.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'pwc-prot-'));
}

test('a sealed blob round-trips and rejects the wrong key or a damaged blob', () => {
  const key = randomBytes(32);
  const sealed = sealCredential('{"accessToken":"abc"}', key);
  assert.equal(sealed.protection, PROTECTION_AES_GCM);
  assert.equal(sealed.keyId.length, 16);
  assert.equal(openCredential(sealed, key), '{"accessToken":"abc"}');
  assert.equal(openCredential(sealed, randomBytes(32)), undefined);
  const tampered = { ...sealed, ciphertext: Buffer.from('zzzz').toString('base64') };
  assert.equal(openCredential(tampered, key), undefined);
  const badTag = { ...sealed, authTag: randomBytes(16).toString('base64') };
  assert.equal(openCredential(badTag, key), undefined);
  assert.equal(openCredential({ protection: 'plaintext' }, key), undefined);
});

test('the OS key facility is platform-bound', () => {
  assert.equal(osKeySourceFor('win32'), 'os-dpapi');
  assert.equal(osKeySourceFor('darwin'), 'os-keychain');
  assert.equal(osKeySourceFor('linux'), 'os-libsecret');
  assert.equal(osKeySourceFor('freebsd'), undefined);
  assert.match(describeOsKeySource('os-dpapi'), /DPAPI/);
  assert.match(describeOsKeySource('os-keychain'), /Keychain/);
  assert.match(describeOsKeySource('os-libsecret'), /libsecret/);
});

/** Decode a `powershell.exe -EncodedCommand` argument. */
function decodeEncoded(args) {
  const index = args.indexOf('-EncodedCommand');
  return Buffer.from(args[index + 1], 'base64').toString('utf16le');
}

/** A fake runner that emulates the three OS facilities well enough to round-trip. */
function fakeRun(plat) {
  const calls = [];
  let stored;
  const run = async (file, args, options = {}) => {
    calls.push({ file, args, input: options.input });
    if (plat === 'win32') {
      const script = decodeEncoded(args);
      const payload = /\$b=\[Convert\]::FromBase64String\('([^']+)'\)/u.exec(script)?.[1];
      if (script.includes(']::Protect(')) return { ok: true, stdout: `WRAP(${payload})`, stderr: '' };
      if (script.includes(']::Unprotect(')) {
        const match = /^WRAP\((.+)\)$/u.exec(payload ?? '');
        return match === null ? { ok: false, stdout: '', stderr: 'nope' } : { ok: true, stdout: match[1], stderr: '' };
      }
      return { ok: false, stdout: '', stderr: 'unexpected script' };
    }
    if (plat === 'darwin') {
      if (args.includes('add-generic-password')) {
        stored = args[args.indexOf('-w') + 1];
        return { ok: true, stdout: '', stderr: '' };
      }
      return stored === undefined ? { ok: false, stdout: '', stderr: 'not found' } : { ok: true, stdout: `${stored}\n`, stderr: '' };
    }
    if (args[0] === 'store') {
      stored = String(options.input ?? '').trim();
      return { ok: true, stdout: '', stderr: '' };
    }
    return stored === undefined ? { ok: false, stdout: '', stderr: 'not found' } : { ok: true, stdout: `${stored}\n`, stderr: '' };
  };
  return { run, calls, stored: () => stored };
}

for (const [plat, source] of [['win32', 'os-dpapi'], ['darwin', 'os-keychain'], ['linux', 'os-libsecret']]) {
  test(`${source} stores and reloads the own-copy key through the OS facility`, async () => {
    const dir = tempDir();
    const { run, calls } = fakeRun(plat);
    const store = createOsKeyStore({ plat, dir, run, env: {} });
    assert.equal(store.source, source);
    assert.equal(store.available(), true);
    assert.equal(await store.load(), undefined, 'nothing stored yet');
    assert.equal(await store.store(), true);
    const key = await store.load();
    assert.equal(key.length, 32);
    assert.equal(await store.store(key), true, 'storing an explicit key is idempotent');
    assert.deepEqual(await store.load(), key);
    assert.ok(calls.length >= 4);
    if (plat === 'win32') {
      assert.equal(existsSync(join(dir, 'own-copy.key')), true);
      assert.match(decodeEncoded(calls[0].args), /ProtectedData\]::Protect/);
      assert.match(decodeEncoded(calls[0].args), /CurrentUser/);
      assert.equal(ownFileMode(join(dir, 'own-copy.key')) !== undefined, true);
    }
  });
}

test('a platform without an OS facility degrades explicitly', async () => {
  const store = createOsKeyStore({ plat: 'freebsd', dir: tempDir(), env: {} });
  assert.equal(store.source, undefined);
  assert.equal(store.available(), false);
  assert.equal(await store.load(), undefined);
  assert.equal(await store.store(randomBytes(32)), false);
});

test('a DPAPI blob that cannot be unprotected yields no key', async () => {
  const dir = tempDir();
  const { run } = fakeRun('win32');
  const store = createOsKeyStore({ plat: 'win32', dir, run, env: {} });
  await store.store();
  // Corrupt the wrapped blob.
  writeFileSync(join(dir, 'own-copy.key'), 'NOT-A-WRAP\n');
  assert.equal(await store.load(), undefined);
});

test('the at-rest key source label is stable', () => {
  assert.equal(KEY_SOURCE_AT_REST, 'at-rest-key');
  // The sealed file never contains the credential, only the protected blob.
  const key = randomBytes(32);
  const sealed = sealCredential('{"accessToken":"supersecret"}', key);
  assert.equal(JSON.stringify(sealed).includes('supersecret'), false);
});
