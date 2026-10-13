// `install-provider` / `uninstall-provider` (S2).
//
// Every test runs in a throwaway directory: the sandbox's `models.json` is a
// fixture, and APPDATA points inside the sandbox so the gateway secret is created
// there too. Nothing here reads the real `~/.pi/agent/models.json`, contacts an
// upstream, or runs the desktop app's key helper.
//
// The two properties that matter most are asserted at the byte level:
//   * every provider we do not own is preserved verbatim (not merely re-parsed);
//   * the gateway secret never appears in a rendered document or preview diff.

import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCli, finalizeDocument } from '../src/cli.js';
import { variantFor } from '../src/variant.js';
import { installProvider, providerBaseUrl, resolveModelsJsonPath, uninstallProvider } from '../src/provider/install.js';
import { modelList } from '../src/gateway/openai.js';
import {
  PROVIDER_COMPAT,
  PROVIDER_KEY,
  assertProviderEntryValid,
  buildProviderEntry,
  canonicalModelId,
  jsonEqual,
  lineDiff,
  modelReference,
} from '../src/provider/models-json.js';

// ── fixtures ────────────────────────────────────────────────────────

// `alpha` is expanded and carries a `}` and a `,` inside a string, which is what
// the offset scanner has to survive; `beta` is written inline and compact, so a
// re-serializing editor would visibly reformat it.
const ALPHA = '{\r\n      "baseUrl": "https://alpha.example/v1",\r\n      "api": "openai-completions",\r\n      "apiKey": "alpha-key",\r\n      "models": [\r\n        { "id": "alpha-1", "name": "Alpha, with } brace and , comma" }\r\n      ]\r\n    }';
const BETA = '{ "baseUrl": "https://beta.example/v1", "api": "openai-completions", "apiKey": "beta-key", "models": [ { "id": "beta-1" } ] }';
const FILE = `{\r\n  "providers": {\r\n    "alpha": ${ALPHA},\r\n    "beta": ${BETA}\r\n  }\r\n}\r\n`;

const CATALOG = {
  source: 'saved',
  fetchedAt: Date.UTC(2026, 9, 13, 8, 0, 0),
  models: [
    { id: 'hy3', name: 'Hy3', contextWindow: 192000, maxTokens: 64000, supportsImages: false, supportsReasoning: true },
    { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1000000, maxTokens: 32768, supportsImages: true, supportsReasoning: true },
    // A catalog row that still carries the gateway's legacy prefix must be
    // canonicalized, otherwise pi would see `workbuddy/workbuddy/hy4-preview`.
    { id: 'workbuddy/hy4-preview', name: 'Hy4 preview', contextWindow: 960000, maxTokens: 32768, supportsImages: true },
  ],
};

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'pwc-provider-'));
  const ownDir = join(root, 'own');
  const agentDir = join(root, '.pi', 'agent');
  mkdirSync(agentDir, { recursive: true });
  return { root, ownDir, agentDir, modelsJson: join(agentDir, 'models.json') };
}

function optionsFor(sandboxed, extra = {}) {
  return {
    variant: variantFor('cn'),
    ownDir: sandboxed.ownDir,
    env: { APPDATA: sandboxed.root },
    port: 8317,
    dryRun: false,
    secrets: [],
    ...extra,
  };
}

function writeFixture(sandboxed, text = FILE) {
  writeFileSync(sandboxed.modelsJson, text);
  return text;
}

/**
 * Test dependencies for one sandbox. `home` must follow the sandbox under test:
 * passing another sandbox's home silently redirects the models.json path.
 */
function depsFor(sandboxed, { now = Date.UTC(2026, 9, 13, 9), catalog = CATALOG } = {}) {
  return { catalog, home: sandboxed.root, now };
}

function backupsOf(sandboxed) {
  const dir = join(sandboxed.agentDir, 'config-backups');
  return existsSync(dir) ? readdirSync(dir) : [];
}

function readToken(sandboxed) {
  return JSON.parse(readFileSync(join(sandboxed.ownDir, 'gateway.json'), 'utf8')).token;
}

function sink() {
  const chunks = [];
  return { write: (chunk) => { chunks.push(chunk); }, text: () => chunks.join('') };
}

/**
 * Locate pi's own models.json validator, so a test can prove the file we write
 * passes the very schema pi enforces. Returns undefined when pi is not installed
 * next to this checkout (a clone on its own machine); the test then skips.
 */
function findPiModelConfig() {
  const relative = ['@earendil-works', 'pi-coding-agent', 'dist', 'core', 'model-config.js'];
  const candidates = [];
  try {
    candidates.push(createRequire(import.meta.url).resolve(join(...relative)));
  } catch {
    /* not a dependency of this package; the global install is next */
  }
  candidates.push(join(dirname(process.execPath), 'node_modules', ...relative));
  return candidates.find((candidate) => existsSync(candidate));
}

// ── naming alignment ────────────────────────────────────────────────

test('the pi model reference is provider/bare-id, and legacy prefixes are canonicalized', () => {
  assert.equal(PROVIDER_KEY, 'workbuddy');
  assert.equal(canonicalModelId('glm-5.3'), 'glm-5.3');
  assert.equal(canonicalModelId('workbuddy/glm-5.3'), 'glm-5.3');
  assert.equal(canonicalModelId('WORKBUDDY/glm-5.3'), 'glm-5.3');
  assert.equal(modelReference('glm-5.3'), 'workbuddy/glm-5.3');

  const entry = buildProviderEntry({ models: CATALOG.models, baseUrl: providerBaseUrl(8317), apiKey: 'k' });
  assert.deepEqual(entry.models.map((model) => model.id), ['hy3', 'glm-5.3', 'hy4-preview']);
  assert.deepEqual(entry.models.map((model) => modelReference(model.id)), ['workbuddy/hy3', 'workbuddy/glm-5.3', 'workbuddy/hy4-preview']);
  assert.equal(entry.baseUrl, 'http://127.0.0.1:8317/v1');
  assert.deepEqual(entry.compat, { ...PROVIDER_COMPAT });
  assert.deepEqual(entry.models[1].input, ['text', 'image']);
  assert.equal(entry.models[1].contextWindow, 1000000);
});

test('the three layers agree: /v1/models id == models.json id == request body model', () => {
  // The gateway advertises the bare upstream id; the pi reference is
  // `<provider>/<id>`; the legacy spelling stays visible as an alias. If any one
  // of these drifts, `model: workbuddy/<id>` silently stops resolving.
  const advertised = modelList([{ id: 'glm-5.3', name: 'GLM-5.3' }], { group: 'cn', source: 'saved' });
  assert.equal(advertised.workbuddy_id_style, 'bare');
  assert.equal(advertised.data[0].id, 'glm-5.3');
  assert.equal(modelReference(advertised.data[0].id), 'workbuddy/glm-5.3');
  assert.equal(advertised.data[0].workbuddy_prefixed_id, modelReference(advertised.data[0].id));

  const entry = buildProviderEntry({ models: [{ id: advertised.data[0].id }], baseUrl: providerBaseUrl(), apiKey: 'k' });
  assert.equal(entry.models[0].id, advertised.data[0].id);
  assert.equal(modelReference(entry.models[0].id), 'workbuddy/glm-5.3');
});

test('buildProviderEntry collapses a prefixed alias that sits next to its bare id', () => {
  const entry = buildProviderEntry({
    models: [{ id: 'hy3' }, { id: 'workbuddy/hy3' }],
    baseUrl: 'http://127.0.0.1:8317/v1',
    apiKey: 'k',
  });
  assert.deepEqual(entry.models.map((model) => model.id), ['hy3']);
});

test('the generated entry only uses keys pi accepts, and an unknown key is refused', () => {
  const entry = buildProviderEntry({ models: CATALOG.models, baseUrl: providerBaseUrl(), apiKey: 'k' });
  assert.equal(assertProviderEntryValid(entry), true);
  assert.throws(() => assertProviderEntryValid({ ...entry, surprise: 1 }), /unknown provider key/u);
  assert.throws(() => assertProviderEntryValid({ ...entry, models: [{ id: 'x', surprise: 1 }] }), /unknown model key/u);
  assert.throws(() => assertProviderEntryValid({ ...entry, compat: { nope: 1 } }), /unknown compat key/u);
  assert.throws(() => assertProviderEntryValid({ ...entry, models: [] }), /non-empty array/u);
});

// ── install ─────────────────────────────────────────────────────────

test('a dry run writes nothing, takes no backup, and never previews the secret', async () => {
  const box = sandbox();
  writeFixture(box);
  const built = await installProvider(optionsFor(box, { dryRun: true }), { catalog: CATALOG, home: box.root, now: Date.UTC(2026, 9, 13, 9) });

  assert.equal(built.document.ok, true);
  assert.equal(built.document.dryRun, true);
  assert.equal(built.document.changed, true);
  assert.equal(built.document.backup, null);
  assert.equal(built.document.apiKey.style, 'literal');
  assert.equal(readFileSync(box.modelsJson, 'utf8'), FILE, 'the file must be untouched');
  assert.deepEqual(backupsOf(box), [], 'a dry run must not create a backup');

  const token = readToken(box);
  assert.equal(built.document.diff.includes('+    "workbuddy": {'), true);
  assert.equal(built.document.diff.includes(token), false, 'the preview diff must not carry the bearer secret');
  assert.equal(JSON.stringify(built.document).includes(token), false, 'no rendered field may carry the bearer secret');

  // The whole rendered document passes the CLI's own leak self-check.
  const { ok, text } = finalizeDocument(built.document, built.secrets, true);
  assert.equal(ok, true);
  assert.equal(text.includes(token), false);
});

test('install splices only our provider, keeps the others byte-identical, and backs the file up', async () => {
  const box = sandbox();
  writeFixture(box);
  const built = await installProvider(optionsFor(box), { catalog: CATALOG, home: box.root, now: Date.UTC(2026, 9, 13, 9) });

  assert.equal(built.document.changed, true);
  assert.equal(built.document.replaced, false);
  assert.equal(built.document.catalog.source, 'saved');
  assert.equal(built.document.catalog.count, 3);

  const after = readFileSync(box.modelsJson, 'utf8');
  // Byte-level preservation of the providers we do not own.
  assert.equal(after.includes(ALPHA), true, 'alpha must survive verbatim');
  assert.equal(after.includes(BETA), true, 'beta must survive verbatim');
  assert.equal(after.startsWith('{\r\n  "providers": {\r\n    "alpha": '), true, 'nothing before alpha may move');
  assert.equal(after.endsWith('\r\n  }\r\n}\r\n'), true, 'the CRLF tail must be preserved');
  assert.equal(/\r\n/u.test(after) && !/[^\r]\n/u.test(after), true, 'the file must stay CRLF throughout');

  const parsed = JSON.parse(after);
  assert.deepEqual(Object.keys(parsed.providers), ['alpha', 'beta', 'workbuddy']);
  assert.deepEqual(parsed.providers.alpha, JSON.parse(`{ "providers": { "alpha": ${ALPHA} } }`).providers.alpha);
  assert.deepEqual(parsed.providers.beta, JSON.parse(`{ "providers": { "beta": ${BETA} } }`).providers.beta);
  assert.equal(parsed.providers.workbuddy.baseUrl, 'http://127.0.0.1:8317/v1');
  assert.equal(parsed.providers.workbuddy.api, 'openai-completions');
  assert.deepEqual(parsed.providers.workbuddy.models.map((model) => model.id), ['hy3', 'glm-5.3', 'hy4-preview']);

  const backups = backupsOf(box);
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(box.agentDir, 'config-backups', backups[0]), 'utf8'), FILE, 'the backup must be the untouched original');
  assert.equal(built.document.backup.endsWith(backups[0]), true);
});

test('install is idempotent: the second run reports changed=false and rewrites nothing', async () => {
  const box = sandbox();
  writeFixture(box);
  const deps = depsFor(box);
  const first = await installProvider(optionsFor(box), deps);
  const afterFirst = readFileSync(box.modelsJson, 'utf8');
  const second = await installProvider(optionsFor(box), deps);
  const afterSecond = readFileSync(box.modelsJson, 'utf8');

  assert.equal(first.document.changed, true);
  assert.equal(second.document.changed, false);
  assert.equal(second.document.replaced, false);
  assert.equal(second.document.backup, null);
  assert.equal(second.document.diff, '');
  assert.equal(afterSecond, afterFirst);
  assert.equal(backupsOf(box).length, 1, 'an unchanged run must not add a backup');
});

test('a missing models.json is created, an empty providers object is filled', async () => {
  const box = sandbox();
  const deps = depsFor(box);
  const created = await installProvider(optionsFor(box), deps);
  assert.equal(created.document.modelsJsonExisted, false);
  assert.equal(created.document.backup, null);
  const parsed = JSON.parse(readFileSync(box.modelsJson, 'utf8'));
  assert.deepEqual(Object.keys(parsed.providers), ['workbuddy']);

  const box2 = sandbox();
  writeFixture(box2, '{\r\n  "providers": {}\r\n}\r\n');
  await installProvider(optionsFor(box2), depsFor(box2));
  const after = readFileSync(box2.modelsJson, 'utf8');
  assert.equal(after.startsWith('{\r\n  "providers": {\r\n    "workbuddy": {'), true);
  assert.equal(JSON.parse(after).providers.workbuddy.models.length, 3);

  const box3 = sandbox();
  writeFixture(box3, '{\r\n}\r\n');
  await installProvider(optionsFor(box3), depsFor(box3));
  const withProviders = JSON.parse(readFileSync(box3.modelsJson, 'utf8'));
  assert.deepEqual(Object.keys(withProviders), ['providers']);
  assert.deepEqual(Object.keys(withProviders.providers), ['workbuddy']);
});

test('a models.json that is not plain JSON is refused, with the file left alone', async () => {
  const box = sandbox();
  const jsonc = '{\r\n  // my note\r\n  "providers": {}\r\n}\r\n';
  writeFixture(box, jsonc);
  await assert.rejects(
    installProvider(optionsFor(box), { catalog: CATALOG, home: box.root }),
    (error) => error.code === 'models-json-unreadable' && /JSONC/u.test(error.message),
  );
  assert.equal(readFileSync(box.modelsJson, 'utf8'), jsonc);
  assert.deepEqual(backupsOf(box), []);

  const box2 = sandbox();
  writeFixture(box2, '{ this is not json');
  await assert.rejects(
    installProvider(optionsFor(box2), { catalog: CATALOG, home: box2.root }),
    (error) => error.code === 'models-json-unreadable',
  );
  assert.equal(readFileSync(box2.modelsJson, 'utf8'), '{ this is not json');
});

test('the api key is a literal by default, an interpolation when the secret comes from the env', async () => {
  const box = sandbox();
  writeFixture(box);
  await installProvider(optionsFor(box), { catalog: CATALOG, home: box.root });
  const literal = JSON.parse(readFileSync(box.modelsJson, 'utf8')).providers.workbuddy.apiKey;
  assert.equal(literal, readToken(box));
  assert.equal(literal.length >= 16, true);

  const box2 = sandbox();
  writeFixture(box2);
  const envToken = 'w'.repeat(43);
  const built = await installProvider(optionsFor(box2, { env: { APPDATA: box2.root, WORKBUDDY_GATEWAY_TOKEN: envToken } }), { catalog: CATALOG, home: box2.root });
  assert.equal(JSON.parse(readFileSync(box2.modelsJson, 'utf8')).providers.workbuddy.apiKey, '$WORKBUDDY_GATEWAY_TOKEN');
  assert.equal(built.document.apiKey.style, 'env');
  assert.equal(existsSync(join(box2.ownDir, 'gateway.json')), false, 'an env-supplied secret is not persisted');
  assert.equal(JSON.stringify(built.document).includes(envToken), false);

  const box3 = sandbox();
  writeFixture(box3);
  await installProvider(optionsFor(box3, { apiKeyEnv: 'MY_GATEWAY_TOKEN' }), { catalog: CATALOG, home: box3.root });
  assert.equal(JSON.parse(readFileSync(box3.modelsJson, 'utf8')).providers.workbuddy.apiKey, '$MY_GATEWAY_TOKEN');
});

test('a builtin (placeholder) catalog is reported instead of being passed off as the roster', async () => {
  const box = sandbox();
  writeFixture(box);
  const built = await installProvider(optionsFor(box), { home: box.root });
  assert.equal(built.document.catalog.source, 'builtin');
  assert.equal(built.document.warnings.some((warning) => /built-in placeholder/u.test(warning)), true);
  assert.equal(built.document.ok, true);
});

test('an empty catalog and a very old saved catalog are both called out', async () => {
  const box = sandbox();
  writeFixture(box);
  await assert.rejects(
    installProvider(optionsFor(box), { catalog: { source: 'saved', models: [] }, home: box.root }),
    (error) => error.code === 'catalog-unreachable' && /catalog is empty/u.test(error.message),
  );
  assert.equal(readFileSync(box.modelsJson, 'utf8'), FILE);

  const stale = await installProvider(optionsFor(box), {
    catalog: { source: 'saved', fetchedAt: Date.UTC(2026, 8, 1), models: CATALOG.models },
    home: box.root,
    now: Date.UTC(2026, 9, 13),
  });
  assert.equal(stale.document.warnings.some((warning) => /days old/u.test(warning)), true);
  assert.equal(stale.document.modelRefs[0], 'workbuddy/hy3');
});

test('a refused atomic rename falls back to an in-place write and says so', async () => {
  const box = sandbox();
  writeFixture(box);
  const built = await installProvider(optionsFor(box), {
    catalog: CATALOG,
    home: box.root,
    now: Date.UTC(2026, 9, 13, 9),
    // Windows refuses the rename over a models.json another process holds open
    // (observed with a running pi session); the file must still be written.
    rename: () => {
      const error = new Error('EPERM: operation not permitted, rename');
      error.code = 'EPERM';
      throw error;
    },
  });
  assert.equal(built.document.write.mode, 'in-place');
  assert.equal(built.document.write.reason, 'EPERM');
  assert.equal(built.document.warnings.some((warning) => /rewritten in place/u.test(warning)), true);
  // S-4: the warning must name the likely cause, not just the errno.
  assert.equal(built.document.warnings.some((warning) => /running pi/u.test(warning)), true);
  const after = readFileSync(box.modelsJson, 'utf8');
  assert.equal(after.includes(ALPHA), true);
  assert.equal(JSON.parse(after).providers.workbuddy.models.length, 3);
  assert.deepEqual(readdirSync(box.agentDir).sort(), ['config-backups', 'models.json'], 'no temp file may be left behind');
});

// ── uninstall ───────────────────────────────────────────────────────

test('uninstall removes only our provider and restores the original bytes', async () => {
  const box = sandbox();
  writeFixture(box);
  const deps = depsFor(box);
  await installProvider(optionsFor(box), deps);
  const removed = await uninstallProvider(optionsFor(box), deps);

  assert.equal(removed.document.changed, true);
  assert.equal(removed.document.removed, true);
  assert.equal(removed.document.backup.endsWith('.bak'), true);
  assert.equal(readFileSync(box.modelsJson, 'utf8'), FILE, 'install + uninstall must round-trip to the original bytes');
  assert.equal(backupsOf(box).length, 2, 'each write is backed up');

  const again = await uninstallProvider(optionsFor(box), deps);
  assert.equal(again.document.changed, false);
  assert.equal(again.document.backup, null);
  assert.equal(readFileSync(box.modelsJson, 'utf8'), FILE);

  const fresh = sandbox();
  writeFixture(fresh);
  const never = await uninstallProvider(optionsFor(fresh), { home: fresh.root });
  assert.equal(never.document.ok, true);
  assert.equal(never.document.changed, false);
  assert.equal(readFileSync(fresh.modelsJson, 'utf8'), FILE);

  const missing = sandbox();
  const absent = await uninstallProvider(optionsFor(missing), { home: missing.root });
  assert.equal(absent.document.ok, true);
  assert.equal(absent.document.changed, false);
  assert.equal(existsSync(missing.modelsJson), false);
});

test('uninstall of a first-position provider keeps the rest verbatim', async () => {
  const box = sandbox();
  const file = `{\r\n  "providers": {\r\n    "workbuddy": { "baseUrl": "http://127.0.0.1:1/v1", "api": "openai-completions", "apiKey": "x", "models": [ { "id": "m" } ] },\r\n    "alpha": ${ALPHA}\r\n  }\r\n}\r\n`;
  writeFixture(box, file);
  const removed = await uninstallProvider(optionsFor(box), { home: box.root });
  assert.equal(removed.document.changed, true);
  const after = readFileSync(box.modelsJson, 'utf8');
  assert.equal(after.includes(ALPHA), true);
  assert.deepEqual(Object.keys(JSON.parse(after).providers), ['alpha']);
});

test('a dry-run uninstall reports the diff and removes nothing', async () => {
  const box = sandbox();
  writeFixture(box);
  const deps = depsFor(box, { now: undefined });
  await installProvider(optionsFor(box), deps);
  const installed = readFileSync(box.modelsJson, 'utf8');
  const built = await uninstallProvider(optionsFor(box, { dryRun: true }), deps);
  assert.equal(built.document.changed, true);
  assert.equal(built.document.diff.includes('-    "workbuddy": {'), true);
  assert.equal(readFileSync(box.modelsJson, 'utf8'), installed);
  assert.equal(backupsOf(box).length, 1);
});

// ── pi's own validation ─────────────────────────────────────────────

test("pi's own models.json validator accepts the generated file", async (t) => {
  const modulePath = findPiModelConfig();
  if (modulePath === undefined) {
    t.skip('@earendil-works/pi-coding-agent is not installed here');
    return;
  }
  const { ModelConfig } = await import(pathToFileURL(modulePath).href);
  const box = sandbox();
  writeFixture(box);
  await installProvider(optionsFor(box), { catalog: CATALOG, home: box.root });

  const config = await ModelConfig.load(box.modelsJson);
  assert.equal(config.getError(), undefined, 'pi must not report a schema error');
  assert.deepEqual(config.getProviderIds(), ['alpha', 'beta', 'workbuddy']);
  const provider = config.getProvider('workbuddy');
  assert.equal(provider.baseUrl, 'http://127.0.0.1:8317/v1');
  assert.equal(provider.api, 'openai-completions');
  assert.equal(provider.apiKey.length >= 16, true);
  assert.deepEqual(provider.models.map((model) => model.id), ['hy3', 'glm-5.3', 'hy4-preview']);
  assert.deepEqual(provider.models.find((model) => model.id === 'glm-5.3').input, ['text', 'image']);
});

// ── path resolution and helpers ─────────────────────────────────────

test('the models.json path follows --models-json, then PI_CODING_AGENT_DIR, then ~/.pi/agent', () => {
  assert.equal(resolveModelsJsonPath({ modelsJsonPath: '/tmp/x.json', env: { PI_CODING_AGENT_DIR: '/tmp/agent' }, home: '/home/u' }), '/tmp/x.json');
  assert.equal(resolveModelsJsonPath({ env: { PI_CODING_AGENT_DIR: '/tmp/agent' }, home: '/home/u' }), join('/tmp/agent', 'models.json'));
  assert.equal(resolveModelsJsonPath({ env: {}, home: '/home/u' }), join('/home/u', '.pi', 'agent', 'models.json'));
  assert.equal(resolveModelsJsonPath({ env: { PI_CODING_AGENT_DIR: '~/agent' }, home: '/home/u' }), join('/home/u', 'agent', 'models.json'));
});

test('the dry-run diff is a real prefix/suffix diff, not a whole-file rewrite', () => {
  const before = 'a\nb\nc\nd\ne\n';
  const after = 'a\nb\nX\nd\ne\n';
  const diff = lineDiff(before, after, { path: 'm.json' });
  assert.equal(diff.includes('-c'), true);
  assert.equal(diff.includes('+X'), true);
  assert.equal(diff.includes('-a'), false, 'unchanged context must not be removed');
  assert.equal(lineDiff(before, before), '');
  assert.equal(jsonEqual({ a: [1, 2] }, { a: [1, 2] }), true);
  assert.equal(jsonEqual({ a: 1 }, { a: 1, b: 2 }), false);
});

// ── S2.1: inline providers (MF-1), the write guard (SF-2), exposure policy ──

test('an inline, non-empty providers object installs without a misleading error (MF-1)', async () => {
  const box = sandbox();
  const inline = `{\r\n  "providers": { "alpha": ${ALPHA} }\r\n}\r\n`;
  writeFixture(box, inline);
  const built = await installProvider(optionsFor(box), depsFor(box));
  assert.equal(built.document.changed, true);
  const after = readFileSync(box.modelsJson, 'utf8');
  assert.equal(after.includes(ALPHA), true, 'the inline alpha member must survive verbatim');
  assert.deepEqual(Object.keys(JSON.parse(after).providers), ['alpha', 'workbuddy']);
  assert.equal(JSON.parse(after).providers.workbuddy.models.length, 3);

  // A fully-inline one-line file works too.
  const box2 = sandbox();
  writeFixture(box2, '{"providers":{"alpha":{"baseUrl":"https://a.example/v1","api":"openai-completions","apiKey":"k","models":[{"id":"a1"}]}}}');
  const built2 = await installProvider(optionsFor(box2), depsFor(box2));
  assert.equal(built2.document.changed, true);
  const parsed2 = JSON.parse(readFileSync(box2.modelsJson, 'utf8'));
  assert.deepEqual(Object.keys(parsed2.providers), ['alpha', 'workbuddy']);
  assert.equal(parsed2.providers.alpha.models[0].id, 'a1');

  // Uninstall removes only ours and leaves alpha byte-identical.
  await uninstallProvider(optionsFor(box2), depsFor(box2));
  const roundTrip = readFileSync(box2.modelsJson, 'utf8');
  assert.equal(roundTrip.includes('"a1"'), true);
  assert.equal(roundTrip.includes('workbuddy'), false);
});

test('a models.json edited between read and write is refused, not clobbered (SF-2)', async () => {
  const box = sandbox();
  writeFixture(box);
  const concurrent = '{\r\n  "providers": {\r\n    "other": { "baseUrl": "x", "api": "openai-completions", "apiKey": "k", "models": [ { "id": "m" } ] }\r\n  }\r\n}\r\n';
  await assert.rejects(
    installProvider(optionsFor(box), {
      catalog: CATALOG,
      home: box.root,
      beforeWrite: () => writeFileSync(box.modelsJson, concurrent),
    }),
    (error) => error.code === 'models-json-changed' && /changed after it was read/u.test(error.message),
  );
  assert.equal(readFileSync(box.modelsJson, 'utf8'), concurrent, 'the concurrent edit must be preserved');
  assert.deepEqual(backupsOf(box), [], 'a refused write takes no backup');
});

test('install-provider writes only the exposed models and rejects an unknown id (S2.1)', async () => {
  const box = sandbox();
  writeFixture(box);
  const built = await installProvider(
    optionsFor(box, { modelsFilter: { mode: 'allowlist', expose: ['glm-5.3'] } }),
    depsFor(box),
  );
  assert.deepEqual(
    JSON.parse(readFileSync(box.modelsJson, 'utf8')).providers.workbuddy.models.map((model) => model.id),
    ['glm-5.3'],
  );
  assert.equal(built.document.exposure.mode, 'allowlist');
  assert.deepEqual(built.document.modelRefs, ['workbuddy/glm-5.3']);

  const box2 = sandbox();
  writeFixture(box2);
  await assert.rejects(
    installProvider(optionsFor(box2, { modelsFilter: { mode: 'allowlist', expose: ['nope'] } }), depsFor(box2)),
    (error) => error.code === 'model-unknown' && /candidates:.*glm-5\.3/u.test(error.message),
  );
  assert.equal(readFileSync(box2.modelsJson, 'utf8'), FILE, 'an unknown id must write nothing');
});

test('install-provider follows the live endpoint.json port by default (S2.1)', async () => {
  const box = sandbox();
  writeFixture(box);
  mkdirSync(box.ownDir, { recursive: true });
  writeFileSync(join(box.ownDir, 'endpoint.json'), JSON.stringify({ version: 1, port: 9123, pid: process.pid }));
  const built = await installProvider(
    { ...optionsFor(box), port: undefined, portSource: undefined },
    { ...depsFor(box), verifyEndpoint: async () => true },
  );
  assert.equal(built.document.baseUrl, 'http://127.0.0.1:9123/v1');
  assert.equal(built.document.portSource, 'endpoint');
});

test('a live pid whose port is not our gateway is not trusted (S-6)', async () => {
  const box = sandbox();
  writeFixture(box);
  mkdirSync(box.ownDir, { recursive: true });
  writeFileSync(join(box.ownDir, 'endpoint.json'), JSON.stringify({ version: 1, port: 9123, pid: process.pid }));
  // `process.pid` is alive, but that only proves *a* process holds the pid: a
  // recycled pid must not make a stale announcement authoritative.
  const built = await installProvider(
    { ...optionsFor(box), port: undefined, portSource: undefined },
    { ...depsFor(box), verifyEndpoint: async () => false },
  );
  assert.equal(built.document.portSource, 'default');
  assert.equal(built.document.baseUrl, providerBaseUrl());
  assert.equal(built.document.warnings.some((warning) => /did not answer as pi-workbuddy-connect/u.test(warning)), true);
});

test('the plaintext api key is warned about first; the env form is not (SF-1)', async () => {
  const box = sandbox();
  writeFixture(box);
  const built = await installProvider(optionsFor(box), depsFor(box));
  assert.equal(built.document.apiKey.style, 'literal');
  assert.match(built.document.securityWarning, /PLAINTEXT SECRET/u);
  assert.equal(built.document.securityWarning.includes(readToken(box)), false);
  const { text, ok } = finalizeDocument(built.document, built.secrets, false);
  assert.equal(ok, true);
  assert.equal(text.startsWith('!! PLAINTEXT SECRET'), true, 'the warning is the first line');

  const box2 = sandbox();
  writeFixture(box2);
  const envBuilt = await installProvider(optionsFor(box2, { apiKeyEnv: 'WORKBUDDY_GATEWAY_TOKEN' }), depsFor(box2));
  assert.equal(envBuilt.document.apiKey.style, 'env');
  assert.equal(envBuilt.document.securityWarning, undefined);
});

test('--api-key-env renders the note and warns when the variable is unset (S-2)', async () => {
  const box = sandbox();
  writeFixture(box);
  // The secret comes from gateway.json (not the environment), so naming a
  // variable that this process does not carry is the interesting case.
  const built = await installProvider(optionsFor(box, { apiKeyEnv: 'WORKBUDDY_PI_TOKEN' }), depsFor(box));
  assert.equal(built.document.apiKey.style, 'env');
  assert.match(built.document.apiKey.note, /environment that starts/u);
  assert.equal(built.document.warnings.some((warning) => /WORKBUDDY_PI_TOKEN is not set/u.test(warning)), true);
  const { text, ok } = finalizeDocument(built.document, built.secrets, false);
  assert.equal(ok, true);
  assert.match(text, /note: models\.json stores \$WORKBUDDY_PI_TOKEN/u);
  assert.match(text, /warning: the environment variable WORKBUDDY_PI_TOKEN is not set/u);

  // With the variable present, the warning is gone (the note stays).
  const box2 = sandbox();
  writeFixture(box2);
  const carried = await installProvider(
    { ...optionsFor(box2, { apiKeyEnv: 'WORKBUDDY_PI_TOKEN' }), env: { APPDATA: box2.root, WORKBUDDY_PI_TOKEN: 'x'.repeat(43) } },
    depsFor(box2),
  );
  assert.equal(carried.document.warnings.some((warning) => /is not set/u.test(warning)), false);
});

// ── CLI surface ─────────────────────────────────────────────────────

test('the CLI installs, is idempotent, and uninstalls against --models-json', async () => {
  const box = sandbox();
  writeFixture(box);
  const env = { ...process.env, APPDATA: box.root, WORKBUDDY_GATEWAY_TOKEN: 'c'.repeat(43) };

  const dry = sink();
  const dryCode = await runCli(['install-provider', '--json', '--dry-run', '--models-json', box.modelsJson, '--port', '9123'], { out: dry, err: dry, env });
  assert.equal(dryCode, 0, dry.text());
  const dryDocument = JSON.parse(dry.text());
  assert.equal(dryDocument.dryRun, true);
  assert.equal(dryDocument.baseUrl, 'http://127.0.0.1:9123/v1');
  assert.equal(readFileSync(box.modelsJson, 'utf8'), FILE);

  const install = sink();
  assert.equal(await runCli(['install-provider', '--json', '--models-json', box.modelsJson, '--port', '9123'], { out: install, err: install, env }), 0, install.text());
  const installDocument = JSON.parse(install.text());
  assert.equal(installDocument.changed, true);
  assert.equal(installDocument.provider, 'workbuddy');
  assert.equal(installDocument.catalog.source, 'builtin');
  assert.equal(JSON.parse(readFileSync(box.modelsJson, 'utf8')).providers.workbuddy.models.length, 8);

  const second = sink();
  assert.equal(await runCli(['install-provider', '--json', '--models-json', box.modelsJson, '--port', '9123'], { out: second, err: second, env }), 0);
  assert.equal(JSON.parse(second.text()).changed, false);

  const remove = sink();
  assert.equal(await runCli(['uninstall-provider', '--json', '--models-json', box.modelsJson], { out: remove, err: remove, env }), 0, remove.text());
  assert.equal(readFileSync(box.modelsJson, 'utf8'), FILE);

  // The human renderer stays truthful about the dry run and never prints the secret.
  const human = sink();
  assert.equal(await runCli(['install-provider', '--dry-run', '--models-json', box.modelsJson], { out: human, err: human, env }), 0);
  assert.equal(human.text().includes('dry run: nothing was written'), true);
  assert.equal(human.text().includes('c'.repeat(43)), false);
});

test('an unusable models.json fails closed through the CLI with a reason code', async () => {
  const box = sandbox();
  writeFixture(box, '{ not json');
  const out = sink();
  const code = await runCli(['install-provider', '--json', '--models-json', box.modelsJson], { out, err: out, env: { ...process.env, APPDATA: box.root } });
  assert.equal(code, 1);
  const document = JSON.parse(out.text());
  assert.equal(document.ok, false);
  assert.equal(document.error.reasonCode, 'models-json-unreadable');
  assert.equal(readFileSync(box.modelsJson, 'utf8'), '{ not json');
});

test('--help documents the provider commands', async () => {
  const out = sink();
  assert.equal(await runCli(['--help'], { out, err: out, env: process.env }), 0);
  assert.equal(out.text().includes('install-provider'), true);
  assert.equal(out.text().includes('--api-key-env'), true);
});
