// The model-exposure policy (S2.1): the config module, and the `models` command.
//
// Everything runs in a throwaway directory: the saved catalog and models.json are
// fixtures and APPDATA points inside the sandbox, so nothing reads the real
// `~/.pi/agent/models.json` or contacts an upstream.

import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';
import { variantFor } from '../src/variant.js';
import { writeGatewayConfig } from '../src/gateway/secret.js';
import {
  DEFAULT_MODELS_CONFIG,
  filterModels,
  isExposed,
  normalizeModelsConfig,
  readModelsConfig,
  validateModelIds,
  writeModelsConfig,
} from '../src/provider/models-config.js';

const CATALOG = {
  version: 1,
  fetchedAt: Date.UTC(2026, 9, 13),
  models: [
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek', contextWindow: 1000000, maxTokens: 131072 },
    { id: 'glm-5.3', name: 'GLM' },
  ],
};

const INSTALLED = '{\r\n  "providers": {\r\n    "workbuddy": { "baseUrl": "http://127.0.0.1:8799/v1", "api": "openai-completions", "apiKey": "k", "models": [ { "id": "glm-5.3" } ] }\r\n  }\r\n}\r\n';

function sandbox({ installed = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pwc-models-'));
  const ownDir = join(root, 'pi-workbuddy-connect');
  mkdirSync(ownDir, { recursive: true });
  writeFileSync(join(ownDir, variantFor('cn').catalogFilename), JSON.stringify(CATALOG));
  const modelsJson = join(root, 'models.json');
  if (installed) writeFileSync(modelsJson, INSTALLED);
  return { root, ownDir, modelsJson };
}

function sink() {
  const chunks = [];
  return { write: (chunk) => { chunks.push(chunk); }, text: () => chunks.join('') };
}

const envFor = (box) => ({ ...process.env, APPDATA: box.root });
const configPath = (box) => join(box.ownDir, 'gateway.json');

// ── module ──────────────────────────────────────────────────────────

test('normalizeModelsConfig defaults to all, infers allowlist, and refuses an empty one', () => {
  assert.deepEqual(normalizeModelsConfig(undefined), { ...DEFAULT_MODELS_CONFIG, expose: [] });
  assert.deepEqual(normalizeModelsConfig({ mode: 'all' }), { mode: 'all', expose: [] });
  assert.deepEqual(normalizeModelsConfig({ expose: ['glm-5.3'] }), { mode: 'allowlist', expose: ['glm-5.3'] });
  assert.deepEqual(normalizeModelsConfig({ mode: 'allowlist', expose: ['workbuddy/glm-5.3', 'glm-5.3'] }), { mode: 'allowlist', expose: ['glm-5.3'] });
  assert.throws(() => normalizeModelsConfig({ mode: 'allowlist', expose: [] }), /empty/u);
  assert.throws(() => normalizeModelsConfig({ mode: 'sometimes' }), /must be "all" or "allowlist"/u);
  assert.throws(() => normalizeModelsConfig([]), /must be an object/u);
});

test('isExposed and filterModels agree, and an unknown id is separated from the candidates', () => {
  const all = normalizeModelsConfig({ mode: 'all' });
  assert.equal(isExposed('anything', all), true);
  assert.equal(filterModels(CATALOG.models, all).length, 2);

  const allow = normalizeModelsConfig({ mode: 'allowlist', expose: ['glm-5.3'] });
  assert.equal(isExposed('glm-5.3', allow), true);
  assert.equal(isExposed('workbuddy/glm-5.3', allow), true, 'the legacy prefix resolves to the same id');
  assert.equal(isExposed('hy3', allow), false);
  assert.deepEqual(filterModels(CATALOG.models, allow).map((model) => model.id), ['glm-5.3']);

  const { valid, invalid, available } = validateModelIds(['glm-5.3', 'nope'], CATALOG.models);
  assert.deepEqual(valid, ['glm-5.3']);
  assert.deepEqual(invalid, ['nope']);
  assert.deepEqual(available, ['deepseek-v4.1-flash', 'glm-5.3']);
});

test('writing the policy preserves the gateway token and the user port', async () => {
  const box = sandbox();
  writeFileSync(configPath(box), JSON.stringify({ version: 1, token: 't'.repeat(40), port: 9001, note: 'keep me' }));
  await writeModelsConfig(box.ownDir, { mode: 'allowlist', expose: ['glm-5.3'] });
  const stored = JSON.parse(readFileSync(configPath(box), 'utf8'));
  assert.equal(stored.token, 't'.repeat(40));
  assert.equal(stored.port, 9001);
  assert.equal(stored.note, 'keep me');
  assert.deepEqual(stored.models, { mode: 'allowlist', expose: ['glm-5.3'] });
  assert.deepEqual(readModelsConfig(box.ownDir), { mode: 'allowlist', expose: ['glm-5.3'] });
});

test('a gateway.json edited between read and write is refused, not clobbered (S-5)', async () => {
  const box = sandbox();
  const path = configPath(box);
  writeFileSync(path, JSON.stringify({ version: 1, token: 't'.repeat(40), note: 'keep me' }));
  const concurrent = JSON.stringify({ version: 1, token: 't'.repeat(40), port: 9222, note: 'hand edit' });
  await assert.rejects(
    writeGatewayConfig(box.ownDir, { models: { mode: 'allowlist', expose: ['glm-5.3'] } }, { beforeWrite: () => writeFileSync(path, concurrent) }),
    (error) => error.code === 'gateway-config-changed' && /changed after it was read/u.test(error.message),
  );
  assert.equal(readFileSync(path, 'utf8'), concurrent, 'the concurrent edit must be preserved');
});

// ── CLI ─────────────────────────────────────────────────────────────

test('models list reports the default policy without writing anything', async () => {
  const box = sandbox();
  const out = sink();
  const code = await runCli(['models', 'list', '--json', '--models-json', box.modelsJson], { out, err: out, env: envFor(box) });
  assert.equal(code, 0, out.text());
  const document = JSON.parse(out.text());
  assert.equal(document.command, 'models');
  assert.equal(document.config.mode, 'all');
  assert.equal(document.catalog.count, 2);
  assert.equal(document.changed, false);
  assert.equal(existsSync(configPath(box)), false, 'list must not write the config');
});

test('models set writes the policy and auto-syncs an installed provider', async () => {
  const box = sandbox({ installed: true });
  const out = sink();
  const code = await runCli(
    ['models', 'set', 'deepseek-v4.1-flash', '--json', '--models-json', box.modelsJson],
    { out, err: out, env: envFor(box) },
  );
  assert.equal(code, 0, out.text());
  const document = JSON.parse(out.text());
  assert.equal(document.config.mode, 'allowlist');
  assert.deepEqual(document.config.expose, ['deepseek-v4.1-flash']);
  assert.equal(document.sync.attempted, true);
  assert.equal(document.sync.ok, true);

  const installed = JSON.parse(readFileSync(box.modelsJson, 'utf8'));
  assert.deepEqual(installed.providers.workbuddy.models.map((model) => model.id), ['deepseek-v4.1-flash']);
  assert.deepEqual(readModelsConfig(box.ownDir), { mode: 'allowlist', expose: ['deepseek-v4.1-flash'] });
});

test('models set with an unknown id fails closed, names the candidates, and writes nothing', async () => {
  const box = sandbox({ installed: true });
  const before = readFileSync(box.modelsJson, 'utf8');
  const out = sink();
  const code = await runCli(['models', 'set', 'nope', '--json', '--models-json', box.modelsJson], { out, err: out, env: envFor(box) });
  assert.equal(code, 1);
  const document = JSON.parse(out.text());
  assert.equal(document.ok, false);
  assert.equal(document.error.reasonCode, 'model-unknown');
  assert.match(document.error.message, /candidates: deepseek-v4\.1-flash, glm-5\.3/u);
  assert.equal(readFileSync(box.modelsJson, 'utf8'), before);
  assert.equal(existsSync(configPath(box)), false, 'no policy was written');
});

test('models add / remove / all keep the allowlist coherent and honour --dry-run', async () => {
  const box = sandbox({ installed: true });
  const run = (args) => runCli([...args, '--json', '--models-json', box.modelsJson], { out: sink(), err: sink(), env: envFor(box) });

  assert.equal(await run(['models', 'add', 'glm-5.3']), 0);
  assert.deepEqual(readModelsConfig(box.ownDir), { mode: 'allowlist', expose: ['deepseek-v4.1-flash', 'glm-5.3'] });
  assert.equal(await run(['models', 'remove', 'glm-5.3']), 0);
  assert.deepEqual(readModelsConfig(box.ownDir), { mode: 'allowlist', expose: ['deepseek-v4.1-flash'] });

  // A dry run reports the change but writes neither gateway.json nor models.json.
  const policyBefore = readFileSync(configPath(box), 'utf8');
  const out = sink();
  const code = await runCli(['models', 'all', '--dry-run', '--json', '--models-json', box.modelsJson], { out, err: out, env: envFor(box) });
  assert.equal(code, 0, out.text());
  const document = JSON.parse(out.text());
  assert.equal(document.changed, true);
  assert.equal(document.dryRun, true);
  assert.equal(readFileSync(configPath(box), 'utf8'), policyBefore);

  assert.equal(await run(['models', 'all']), 0);
  assert.deepEqual(readModelsConfig(box.ownDir), { mode: 'all', expose: [] });
});

test('models set on a machine without an installed provider says so instead of guessing', async () => {
  const box = sandbox();
  const out = sink();
  const code = await runCli(['models', 'set', 'glm-5.3', '--json', '--models-json', box.modelsJson], { out, err: out, env: envFor(box) });
  assert.equal(code, 0, out.text());
  const document = JSON.parse(out.text());
  assert.equal(document.sync.attempted, false);
  assert.match(document.sync.note, /run install-provider/u);
  assert.equal(readModelsConfig(box.ownDir).mode, 'allowlist');
});

test('models exits non-zero when the auto-sync of the installed provider fails (S-1)', async () => {
  const box = sandbox({ installed: true });
  // An empty saved catalog still satisfies the command, but install-provider
  // refuses to write a provider with no models, so the sync fails.
  writeFileSync(join(box.ownDir, variantFor('cn').catalogFilename), JSON.stringify({ version: 1, models: [] }));
  writeFileSync(configPath(box), JSON.stringify({ models: { mode: 'allowlist', expose: ['glm-5.3'] } }));
  const before = readFileSync(box.modelsJson, 'utf8');
  const out = sink();
  const code = await runCli(['models', 'all', '--json', '--models-json', box.modelsJson], { out, err: out, env: envFor(box) });
  assert.equal(code, 1, out.text());
  const document = JSON.parse(out.text());
  assert.equal(document.sync.attempted, true);
  assert.equal(document.sync.ok, false);
  assert.equal(document.sync.error.reasonCode, 'catalog-unreachable');
  assert.equal(readFileSync(box.modelsJson, 'utf8'), before, 'a failed sync must leave models.json alone');
});

test('serve and install-provider reject an unknown --models id with candidates (offline)', async () => {
  const box = sandbox();
  const serveOut = sink();
  const serveCode = await runCli(['serve', '--models', 'nope'], { out: serveOut, err: serveOut, env: envFor(box) });
  assert.equal(serveCode, 2);
  assert.match(serveOut.text(), /--models names unknown model\(s\).*candidates: deepseek-v4\.1-flash, glm-5\.3/u);

  const installOut = sink();
  const installCode = await runCli(['install-provider', '--json', '--models', 'nope', '--models-json', box.modelsJson], { out: installOut, err: installOut, env: envFor(box) });
  assert.equal(installCode, 1);
  assert.equal(JSON.parse(installOut.text()).error.reasonCode, 'model-unknown');
});

test('an unknown models action is a usage error', async () => {
  const box = sandbox();
  const out = sink();
  const code = await runCli(['models', 'frobnicate'], { out, err: out, env: envFor(box) });
  assert.equal(code, 2);
  assert.match(out.text(), /unknown models action/u);
});
