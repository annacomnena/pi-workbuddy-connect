import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialStore } from '../src/credentials/index.js';
import { loadAtRestPayload, resolveElectronBinary } from '../src/credentials/electron.js';
import { parseOwnDocument, serializeOwn } from '../src/credentials/document.js';
import { readOwn, writeOwn } from '../src/credentials/store.js';
import { VARIANTS } from '../src/variant.js';
import { REASON } from '../src/errors.js';
import {
  makeAtRestKey,
  makeEncryptedAuthDocument,
  makePlainAuthDocument,
} from './support/fixtures.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'pwc-test-'));
}

function storeWith({ documentText, atRestPayload, variant = VARIANTS.cn, ownDir = tempDir() }) {
  return new CredentialStore({
    variant,
    authFile: join(tempDir(), 'workbuddy-desktop.info'),
    ownDir,
    electronPath: process.execPath, // any executable; the helper is faked below
    env: {},
    fileReader: async () => documentText,
    readAtRest: async () => atRestPayload,
  });
}

test('plaintext desktop document resolves without the key helper', async () => {
  const doc = JSON.stringify(makePlainAuthDocument());
  const store = storeWith({ documentText: doc, atRestPayload: undefined });
  const loaded = await store.readDesktop();
  assert.equal(loaded.format, 'plaintext');
  assert.equal(loaded.credential.accessToken, 'fixture-access-token-0123456789abcdef');
  assert.equal(loaded.credential.uid, 'fixture-uid-0000-1111-2222-333333333333');
});

test('encrypted desktop document unwraps with the derived key', async () => {
  const { key, keyId, payload } = makeAtRestKey();
  const doc = JSON.stringify(makeEncryptedAuthDocument(key, keyId));
  const store = storeWith({ documentText: doc, atRestPayload: payload });
  const loaded = await store.readDesktop();
  assert.equal(loaded.format, 'encrypted');
  assert.equal(loaded.keyIdMatched, true);
  assert.equal(loaded.credential.accessToken, 'fixture-access-token-0123456789abcdef');
  assert.equal(loaded.credential.refreshToken, 'fixture-refresh-token-fedcba9876543210');
});

test('an envelope sealed by a different key fails closed with a reason code', async () => {
  const sealedWith = makeAtRestKey();
  const app = makeAtRestKey();
  const doc = JSON.stringify(makeEncryptedAuthDocument(sealedWith.key, sealedWith.keyId));
  const store = storeWith({ documentText: doc, atRestPayload: app.payload });
  await assert.rejects(store.readDesktop(), (error) => {
    assert.equal(error.code, REASON.credentialUndecryptable);
    assert.equal(error.detail.keyIdMatched, false);
    return true;
  });
});

test('an unrecognized document is an explicit failure, not "signed out"', async () => {
  const store = storeWith({ documentText: '{broken' });
  await assert.rejects(store.readDesktop(), (error) => error.code === REASON.credentialUnreadable);
});

test('a region mismatch is rejected outright', async () => {
  const doc = JSON.stringify(makePlainAuthDocument({ domain: 'www.workbuddy.ai' }));
  const store = storeWith({ documentText: doc });
  await assert.rejects(store.current(), (error) => error.code === REASON.credentialRegionMismatch);
});

test('the effective credential prefers the later expiry for the same identity', async () => {
  const ownDir = tempDir();
  const desktopDoc = JSON.stringify(makePlainAuthDocument({ expiresInMs: 1000 }));
  const store = storeWith({ documentText: desktopDoc, ownDir });
  const own = {
    accessToken: 'own-access',
    refreshToken: 'own-refresh',
    expiresAtMs: Date.now() + 10_000_000,
    domain: 'www.codebuddy.cn',
    uid: 'fixture-uid-0000-1111-2222-333333333333',
    uin: '123456789012',
    source: 'own-copy',
  };
  writeOwn(store.ownPath, own);
  const loaded = await store.current();
  assert.equal(loaded.source, 'own-copy');
  assert.equal(loaded.credential.accessToken, 'own-access');
});

test('a different identity on the copy defers to the desktop file', async () => {
  const ownDir = tempDir();
  const desktopDoc = JSON.stringify(makePlainAuthDocument());
  const store = storeWith({ documentText: desktopDoc, ownDir });
  writeOwn(store.ownPath, {
    accessToken: 'other-access',
    refreshToken: '',
    expiresAtMs: Date.now() + 10_000_000,
    domain: 'www.codebuddy.cn',
    uid: 'another-uid',
    uin: '',
    source: 'own-copy',
  });
  const loaded = await store.current();
  assert.equal(loaded.source, 'desktop');
});

test('the own copy round-trips and is owner-only on POSIX', () => {
  const dir = tempDir();
  const file = join(dir, 'workbuddy-auth.json');
  const credential = { accessToken: 'a', refreshToken: 'b', expiresAtMs: Date.now(), domain: 'www.codebuddy.cn', uid: 'u', uin: '' };
  writeOwn(file, credential);
  const read = readOwn(file);
  assert.equal(read.accessToken, 'a');
  assert.equal(read.source, 'own-copy');
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  }
});

test('the own-copy parser rejects other versions', () => {
  assert.equal(parseOwnDocument('{"version":2,"credential":{"accessToken":"a"}}'), undefined);
  assert.equal(parseOwnDocument(serializeOwn({ accessToken: 'a', refreshToken: '', expiresAtMs: 0, domain: '', uid: '', uin: '' })).accessToken, 'a');
});

// MF-2: a resolved binary whose helper fails is an unwrapping failure, not a
// binary-resolution failure.
test('a resolved-but-failing key helper is credential-undecryptable', async () => {
  // process.execPath resolves and runs, but does not carry the app binding.
  await assert.rejects(loadAtRestPayload(process.execPath, { timeoutMs: 5000 }), (error) => {
    assert.equal(error.code, REASON.credentialUndecryptable);
    return true;
  });
});

test('electron-not-found is reserved for the binary-resolution path', async () => {
  await assert.rejects(
    resolveElectronBinary(VARIANTS.cn, { explicitPath: join(tempDir(), 'does-not-exist.exe'), env: {}, plat: 'win32' }),
    (error) => error.code === REASON.electronNotFound,
  );
});

// SF-7: a missing copy is "absent", but an unreadable one is a distinct state.
test('an unreadable own copy is credential-unreadable, never silently absent', () => {
  const dir = tempDir();
  assert.equal(readOwn(join(dir, 'missing.json')), undefined);
  assert.throws(() => readOwn(dir), (error) => error.code === REASON.credentialUnreadable);
});
