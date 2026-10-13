// `serve` orchestration tests. The gateway binds loopback and the app version
// is injected, so nothing here reaches the network.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServe, describeOwnCopyProtection, FALLBACK_APP_VERSIONS } from '../src/serve.js';
import { removeStaleEndpointFile } from '../src/gateway/secret.js';
import { CredentialStore } from '../src/credentials/index.js';
import { VARIANTS } from '../src/variant.js';
import { makeAtRestKey, makeEncryptedAuthDocument, makePlainAuthDocument } from './support/fixtures.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'pwc-serve-'));
}

function quietLogger() {
  const lines = { info: [], warn: [] };
  return {
    lines,
    info: (message) => lines.info.push(message),
    warn: (message) => lines.warn.push(message),
    error: (message) => lines.warn.push(message),
  };
}

async function serve({ dir, plat, appVersion } = {}) {
  const authFile = join(dir, 'workbuddy-desktop.info');
  writeFileSync(authFile, JSON.stringify(makePlainAuthDocument()));
  const logger = quietLogger();
  const serving = await startServe({
    variant: VARIANTS.cn,
    port: 0,
    authFile,
    env: { APPDATA: dir },
    ownDir: join(dir, 'pi-workbuddy-connect'),
    network: true,
    json: true,
    plat,
  }, { logger, appVersion, env: { APPDATA: dir }, out: { write() {} } });
  return { serving, logger, authFile };
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('serve binds loopback, announces the endpoint, and clears it on close', async () => {
  const dir = tempDir();
  const { serving, logger } = await serve({ dir, appVersion: '5.7.7' });
  try {
    assert.match(serving.url, /^http:\/\/127\.0\.0\.1:\d+$/u);
    assert.equal(serving.document.host, '127.0.0.1');
    assert.equal(serving.document.token.value, 'not printed');
    assert.equal(serving.document.outbound.telemetry, 'none');
    assert.equal(serving.document.warnings.length, 0);
    assert.deepEqual(logger.lines.warn, []);

    const endpoint = JSON.parse(readFileSync(serving.endpointFile, 'utf8'));
    assert.equal(endpoint.host, '127.0.0.1');
    assert.equal(endpoint.url, serving.url);
    assert.equal(endpoint.tokenSource, 'generated');
    assert.equal(JSON.stringify(endpoint).includes('token"'), false);
    if (process.platform !== 'win32') assert.equal(statSync(serving.endpointFile).mode & 0o777, 0o600);

    const health = await get(serving.port, '/healthz');
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.text).service, 'pi-workbuddy-connect');
    assert.equal(JSON.parse(health.text).credential.state, 'active');
    assert.equal(health.text.includes('fixture-access-token'), false);
  } finally {
    await serving.close();
  }
  assert.equal(existsSync(serving.endpointFile), false);
});

test('the gateway secret is stable across restarts and env overrides it', async () => {
  const dir = tempDir();
  const first = await serve({ dir, appVersion: '5.7.7' });
  const tokenPath = join(dir, 'pi-workbuddy-connect', 'gateway.json');
  const token = JSON.parse(readFileSync(tokenPath, 'utf8')).token;
  await first.serving.close();
  const second = await serve({ dir, appVersion: '5.7.7' });
  assert.equal(second.serving.document.token.source, 'config');
  assert.equal(JSON.parse(readFileSync(tokenPath, 'utf8')).token, token);
  const envServed = await startServe({
    variant: VARIANTS.cn,
    port: 0,
    authFile: second.authFile,
    env: { APPDATA: dir, WORKBUDDY_GATEWAY_TOKEN: 'env-provided-token-0123456789' },
    ownDir: join(dir, 'pi-workbuddy-connect'),
    network: true,
  }, { logger: quietLogger(), appVersion: '5.7.7', env: { APPDATA: dir, WORKBUDDY_GATEWAY_TOKEN: 'env-provided-token-0123456789' }, out: { write() {} } });
  try {
    assert.equal(envServed.document.token.source, 'env');
    // The env token wins: the stored one is refused.
    const refused = await new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: envServed.port, path: '/v1/models', headers: { authorization: `Bearer ${token}` } }, (res) => {
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(refused, 401);
  } finally {
    await envServed.close();
    await second.serving.close();
  }
});

test('a platform without protection and a plaintext desktop warns loudly (SF-6)', async () => {
  const dir = tempDir();
  const { serving, logger } = await serve({ dir, plat: 'freebsd', appVersion: undefined });
  try {
    assert.equal(serving.document.credentialProtection.protected, false);
    assert.equal(serving.document.credentialProtection.osFacility, null);
    assert.equal(serving.document.credentialProtection.desktopFormat, 'plaintext');
    assert.equal(serving.document.warnings.some((line) => line.includes('SF-6 DEGRADED')), true);
    assert.equal(logger.lines.warn.some((line) => line.includes('SF-6 DEGRADED')), true);
    // The app version could not be read on that platform either: the fallback is
    // the documented *lower* one, and said out loud.
    assert.equal(serving.document.appVersion.source, 'fallback');
    assert.equal(serving.document.appVersion.value, FALLBACK_APP_VERSIONS.cn);
    assert.match(serving.document.userAgent, /WorkBuddy\/5\.5\.6/u);
    assert.equal(serving.document.warnings.some((line) => line.includes('fallback')), true);
  } finally {
    await serving.close();
  }
});

test('an endpoint.json left by a dead process is removed at startup (SF-5)', () => {
  const dir = tempDir();
  const file = join(dir, 'endpoint.json');
  writeFileSync(file, JSON.stringify({ version: 1, pid: 2147483647, port: 9 }));
  assert.equal(removeStaleEndpointFile(dir, { isAlive: () => false }), true);
  assert.equal(existsSync(file), false);

  // A live pid is left alone: another `serve` may still own that port.
  writeFileSync(file, JSON.stringify({ version: 1, pid: process.pid, port: 9 }));
  assert.equal(removeStaleEndpointFile(dir, { isAlive: () => true }), false);
  assert.equal(existsSync(file), true);

  // A malformed announcement cannot be trusted and is dropped.
  writeFileSync(file, 'not json');
  assert.equal(removeStaleEndpointFile(dir), true);
  assert.equal(existsSync(file), false);
});

test('describeOwnCopyProtection reports the at-rest key as available for an encrypted desktop', async () => {
  const dir = tempDir();
  const authFile = join(dir, 'workbuddy-desktop.info');
  const atRest = makeAtRestKey();
  writeFileSync(authFile, JSON.stringify(makeEncryptedAuthDocument(atRest.key, atRest.keyId)));
  const store = new CredentialStore({ variant: VARIANTS.cn, authFile, ownDir: join(dir, 'own'), env: {}, plat: 'freebsd' });
  const protection = await describeOwnCopyProtection(store);
  assert.equal(protection.desktopFormat, 'encrypted');
  assert.equal(protection.atRestKeyExpected, true);
  assert.equal(protection.protected, true);
});
