import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAKE_ACCESS_TOKEN, FAKE_REFRESH_TOKEN, FAKE_UID, makeAtRestKey, makeEncryptedAuthDocument, makePlainAuthDocument } from './support/fixtures.js';
import { finalizeDocument, runCli } from '../src/cli.js';

const BIN = fileURLToPath(new URL('../bin/pi-workbuddy-connect.js', import.meta.url));

function run(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, timeout: 20_000 }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

function fixtureDir(document) {
  const dir = mkdtempSync(join(tmpdir(), 'pwc-cli-'));
  const file = join(dir, 'workbuddy-desktop.info');
  writeFileSync(file, typeof document === 'string' ? document : JSON.stringify(document));
  return { dir, file };
}

test('status --json --no-network on a plaintext fixture is masked and credential-free', async () => {
  const { dir, file } = fixtureDir(makePlainAuthDocument());
  const { code, stdout } = await run(['status', '--json', '--no-network', '--auth-file', file], { APPDATA: dir });
  assert.equal(code, 0, stdout);
  const document = JSON.parse(stdout);
  assert.equal(document.ok, true);
  assert.equal(document.command, 'status');
  assert.equal(document.billing.reason, 'network-disabled');
  assert.equal(document.catalog.source, 'builtin');
  assert.equal(document.auth.format, 'plaintext');
  assert.equal(document.account.uidMasked, 'fix\u202633');
  // No raw credential material, anywhere.
  for (const secret of [FAKE_ACCESS_TOKEN, FAKE_REFRESH_TOKEN, FAKE_UID]) {
    assert.equal(stdout.includes(secret), false, `leaked ${secret.slice(0, 4)}`);
  }
  assert.equal(document.redactionSelfCheck.ok, true);
});

test('status without a credential fails closed with credential-missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pwc-cli-'));
  const missing = join(dir, 'nope.info');
  const { code, stdout } = await run(['status', '--json', '--no-network', '--auth-file', missing], { APPDATA: dir });
  assert.equal(code, 1);
  const document = JSON.parse(stdout);
  assert.equal(document.ok, false);
  assert.equal(document.error.reasonCode, 'credential-missing');
  assert.equal(stdout.toLowerCase().includes('signed out'), false);
});

test('doctor --json --no-network reports format and reason codes without unwrapping', async () => {
  const { dir, file } = fixtureDir(makePlainAuthDocument());
  const { code, stdout } = await run(['doctor', '--json', '--no-network', '--auth-file', file], { APPDATA: dir });
  assert.equal(code, 0, stdout);
  const document = JSON.parse(stdout);
  assert.equal(document.ok, true);
  assert.equal(document.decryptAttempted, false);
  const format = document.checks.find((check) => check.id === 'document-format');
  assert.equal(format.detail, 'plaintext');
  const billing = document.checks.find((check) => check.id === 'billing');
  assert.equal(billing.reasonCode, 'network-disabled');
});

test('doctor fails closed on an unrecognized document', async () => {
  const { dir, file } = fixtureDir('{not json at all');
  const { code, stdout } = await run(['doctor', '--json', '--no-network', '--auth-file', file], { APPDATA: dir });
  assert.equal(code, 1);
  const document = JSON.parse(stdout);
  assert.equal(document.ok, false);
  assert.ok(document.reasonCodes.includes('credential-unreadable'));
});

test('a region mismatch is reported, never coerced', async () => {
  const { dir, file } = fixtureDir(makePlainAuthDocument({ domain: 'www.workbuddy.ai' }));
  const { code, stdout } = await run(['status', '--json', '--no-network', '--auth-file', file], { APPDATA: dir });
  assert.equal(code, 1);
  assert.equal(JSON.parse(stdout).error.reasonCode, 'credential-region-mismatch');
});

// SF-1 regression: an expired session used to print ok:true and exit 0.
test('status marks a dead (expired) session as ok:false, not a silent success', async () => {
  const { dir, file } = fixtureDir(makePlainAuthDocument({ expiresInMs: -60_000 }));
  const { code, stdout } = await run(['status', '--json', '--no-network', '--auth-file', file], { APPDATA: dir });
  assert.equal(code, 1, stdout);
  const document = JSON.parse(stdout);
  assert.equal(document.ok, false);
  assert.equal(document.session.state, 'expired');
  assert.ok(document.reasonCodes.includes('session-dead'));
  assert.equal(document.error.reasonCode, 'session-dead');
  // The diagnostic data is still reported; only ok/exit code changed.
  assert.equal(document.account.uidMasked, 'fix\u202633');

  const human = await run(['status', '--no-network', '--auth-file', file], { APPDATA: dir });
  assert.equal(human.code, 1);
  assert.ok(human.stdout.includes('status: FAILED \u2014 session-dead'), human.stdout);
  assert.ok(human.stdout.includes('account: uid fix\u202633'), human.stdout);
});

// MF-2 regression: a resolved binary whose helper fails used to be reported as
// electron-not-found even though doctor itself showed electron-binary=pass.
test('doctor reports a resolved-but-failing helper as credential-undecryptable, not electron-not-found', async () => {
  const { key, keyId } = makeAtRestKey();
  const { dir, file } = fixtureDir(makeEncryptedAuthDocument(key, keyId));
  // process.execPath resolves as an executable, but it is not the app binary,
  // so running the helper fails (non-zero exit).
  const { code, stdout } = await run(
    ['doctor', '--json', '--no-network', '--decrypt', '--auth-file', file, '--electron', process.execPath],
    { APPDATA: dir },
  );
  assert.equal(code, 1, stdout);
  const document = JSON.parse(stdout);
  const binary = document.checks.find((check) => check.id === 'electron-binary');
  assert.equal(binary.status, 'pass', 'the binary did resolve');
  const credential = document.checks.find((check) => check.id === 'credential');
  assert.equal(credential.status, 'fail');
  assert.equal(credential.reasonCode, 'credential-undecryptable');
  assert.equal(document.reasonCodes.includes('electron-not-found'), false);
});

// SF-2 regression: the top-level error path used to pass an empty secrets list,
// so a held secret echoed into an error message would be printed verbatim.
test('the top-level error path self-checks against secrets collected before the failure', async () => {
  const secret = 'opaque-held-secret-without-any-token-shape';
  let out = '';
  const sink = { write: (chunk) => { out += chunk; } };
  const code = await runCli(['status', '--json', '--no-network'], {
    out: sink,
    err: sink,
    env: { ...process.env },
    builders: {
      status: async (options) => {
        options.secrets.push(secret);
        throw new Error(`unexpected failure mentioning ${secret}`);
      },
    },
  });
  assert.equal(code, 1);
  assert.equal(out.includes(secret), false, 'a held secret must never be printed');
  assert.equal(JSON.parse(out).redactionSelfCheck.ok, false);
});

test('--help and bad arguments behave', async () => {
  assert.equal((await run(['--help'])).code, 0);
  assert.equal((await run(['nonsense'])).code, 2);
});

test('finalizeDocument withholds output that would leak a held secret', () => {
  const secret = 'held-secret-value-that-must-not-print';
  const { text, ok } = finalizeDocument({ schema: 1, command: 'status', leaked: secret }, [secret], true);
  assert.equal(ok, false);
  assert.equal(text.includes(secret), false);
  const parsed = JSON.parse(text);
  assert.equal(parsed.error.reasonCode, 'redaction-self-check-failed');
  assert.equal(parsed.redactionSelfCheck.ok, false);
});

test('finalizeDocument passes a clean document', () => {
  const { text, ok } = finalizeDocument({ schema: 1, command: 'status', value: 'ok' }, ['a-secret'], true);
  assert.equal(ok, true);
  assert.equal(JSON.parse(text).redactionSelfCheck.ok, true);
});
