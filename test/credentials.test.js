import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
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
  await writeOwn(store.ownPath, own);
  const loaded = await store.current();
  assert.equal(loaded.source, 'own-copy');
  assert.equal(loaded.credential.accessToken, 'own-access');
});

test('a different identity on the copy defers to the desktop file', async () => {
  const ownDir = tempDir();
  const desktopDoc = JSON.stringify(makePlainAuthDocument());
  const store = storeWith({ documentText: desktopDoc, ownDir });
  await writeOwn(store.ownPath, {
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

test('the own copy round-trips and is owner-only on POSIX', async () => {
  const dir = tempDir();
  const file = join(dir, 'workbuddy-auth.json');
  const credential = { accessToken: 'a', refreshToken: 'b', expiresAtMs: Date.now(), domain: 'www.codebuddy.cn', uid: 'u', uin: '' };
  await writeOwn(file, credential);
  const read = await readOwn(file);
  assert.equal(read.credential.accessToken, 'a');
  assert.equal(read.credential.source, 'own-copy');
  // Without a protector the copy is the explicitly-degraded plaintext shape.
  assert.equal(read.protection, 'plaintext');
  assert.equal(read.keySource, 'none');
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
test('an unreadable own copy is credential-unreadable, never silently absent', async () => {
  const dir = tempDir();
  assert.equal(await readOwn(join(dir, 'missing.json')), undefined);
  await assert.rejects(readOwn(dir), (error) => error.code === REASON.credentialUnreadable);
});

// SF-6: the own copy is sealed, and a copy whose key is gone fails closed.
test('a sealed own copy is not readable when its key is unavailable', async () => {
  const dir = tempDir();
  const file = join(dir, 'workbuddy-auth.json');
  const sealed = {
    protection: 'aes-256-gcm',
    keyId: '0123456789abcdef',
    nonce: Buffer.alloc(12, 1).toString('base64'),
    authTag: Buffer.alloc(16, 2).toString('base64'),
    ciphertext: Buffer.from('nope').toString('base64'),
  };
  const { serializeOwnSealed } = await import('../src/credentials/document.js');
  const { writeOwnText } = await import('../src/credentials/store.js');
  writeOwnText(file, serializeOwnSealed(sealed, 'at-rest-key'));
  await assert.rejects(readOwn(file, { openKey: async () => undefined }), (error) => {
    assert.equal(error.code, REASON.credentialUndecryptable);
    return true;
  });
});

// SF-6 degradation: when neither the at-rest key nor an OS facility exists, the
// copy is written as plaintext and the caller is told, rather than pretending.
test('without any protection the copy degrades explicitly to plaintext', async () => {
  const dir = tempDir();
  const doc = JSON.stringify(makePlainAuthDocument());
  const warnings = [];
  const store = new CredentialStore({
    variant: VARIANTS.cn,
    authFile: join(tempDir(), 'workbuddy-desktop.info'),
    ownDir: dir,
    env: {},
    plat: 'freebsd',
    fileReader: async () => doc,
    readAtRest: async () => { throw new Error('no helper on this platform'); },
    logger: { warn: (message) => warnings.push(message) },
  });
  const credential = { accessToken: 'degraded-access', refreshToken: '', expiresAtMs: Date.now() + 1000, domain: 'www.codebuddy.cn', uid: 'u', uin: '' };
  const written = await store.writeOwnCopy(credential);
  assert.equal(written.keySource, 'none');
  assert.equal(written.degraded.reason, 'no-protection-available');
  assert.equal(store.lastProtection.protection, 'plaintext');
  assert.equal(readFileSync(store.ownPath, 'utf8').includes('degraded-access'), true);
  assert.equal((await store.readOwnCopy()).accessToken, 'degraded-access');
  // SF-3: a runtime degradation is logged, once, with the reason and impact.
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /SF-6 DEGRADED at runtime/u);
  assert.match(warnings[0], /plaintext/u);
  await store.writeOwnCopy({ ...credential, expiresAtMs: Date.now() + 2000 });
  assert.equal(warnings.length, 1, 'the degradation warning must not repeat on every write');
  store.removeOwnCopy();
  assert.equal(existsSync(store.ownPath), false);
});

test('the store seals a refreshed copy with the app at-rest key', async () => {
  const atRest = makeAtRestKey();
  const doc = JSON.stringify(makeEncryptedAuthDocument(atRest.key, atRest.keyId));
  const store = storeWith({ documentText: doc, atRestPayload: atRest.payload });
  await store.current();
  const credential = { accessToken: 'sealed-access', refreshToken: 'sealed-refresh', expiresAtMs: Date.now() + 30 * 24 * 3600 * 1000, domain: 'www.codebuddy.cn', uid: 'fixture-uid-0000-1111-2222-333333333333', uin: '' };
  const written = await store.writeOwnCopy(credential);
  assert.equal(written.keySource, 'at-rest-key');
  const raw = readFileSync(store.ownPath, 'utf8');
  assert.equal(raw.includes('sealed-access'), false, 'the sealed copy must not contain the token');
  // The copy is what the store reads back, independent of the desktop merge.
  const fromCopy = await store.readOwnCopy();
  assert.equal(fromCopy.accessToken, 'sealed-access');
  assert.equal(store.lastProtection.protection, 'aes-256-gcm');
  assert.equal(store.lastProtection.keySource, 'at-rest-key');
  const loaded = await store.current();
  assert.equal(loaded.source, 'own-copy');
  assert.equal(loaded.credential.accessToken, 'sealed-access');
});
