import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinCatalog, parseCatalog, resolveCatalog } from '../src/catalog/index.js';
import { WbError, REASON } from '../src/errors.js';

const envelope = {
  code: 0,
  data: {
    agents: [{ name: 'cli', models: ['hy3', 'glm-5.3'] }, { name: 'app', models: ['x'] }],
    models: [
      { id: 'hy3', name: 'Hy3', maxInputTokens: 192000, maxOutputTokens: 64000, supportsImages: true, credits: 'x0.00 credits', supportsReasoning: true, reasoning: { supportedEfforts: ['high', 'medium'], defaultEffort: 'high' } },
      { id: 'glm-5.3', name: 'GLM-5.3', maxInputTokens: 1000000, maxOutputTokens: 64000, supportsImages: true, credits: 'x0.79 credits' },
      { id: 'not-in-roster', name: 'Nope', maxInputTokens: 1000, maxOutputTokens: 1000 },
      { id: 'disabled', name: 'Off', maxInputTokens: 1000, maxOutputTokens: 1000, disabled: true },
    ],
  },
};

test('the catalog keeps the cli roster intersected with usable rows', () => {
  const models = parseCatalog(envelope);
  assert.deepEqual(models.map((model) => model.id), ['hy3', 'glm-5.3']);
  assert.equal(models[0].credits, 'x0.00');
  assert.equal(models[0].contextWindow, 192000);
  assert.deepEqual(models[0].supportedEfforts, ['high', 'medium']);
});

test('a catalog with no cli roster is an explicit failure', () => {
  assert.throws(() => parseCatalog({ code: 0, data: { models: [] } }), (error) => error.code === REASON.upstreamClientError);
});

test('degradation: no saved catalog falls back to built-in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pwc-catalog-'));
  const catalog = await resolveCatalog({ savedPath: join(dir, 'missing.json'), network: false });
  assert.equal(catalog.source, 'builtin');
  assert.ok(catalog.count === undefined || catalog.models.length > 0);
  assert.equal(builtinCatalog().source, 'builtin');
});

test('degradation: a saved catalog is preferred over built-in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pwc-catalog-'));
  const saved = join(dir, 'saved.json');
  writeFileSync(saved, JSON.stringify({ version: 1, fetchedAt: 123, models: [{ id: 'saved', name: 'Saved' }] }));
  const catalog = await resolveCatalog({ savedPath: saved, network: false });
  assert.equal(catalog.source, 'saved');
  assert.equal(catalog.models[0].id, 'saved');
});

test('degradation: a failed live fetch degrades and names the reason', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pwc-catalog-'));
  const client = {
    url: (base, path) => new URL(path, base),
    send: async () => { throw new WbError(REASON.upstreamUnreachable, 'down'); },
    ensureOk: (result) => result.envelope,
  };
  const catalog = await resolveCatalog({ client, credential: { domain: 'www.codebuddy.cn' }, savedPath: join(dir, 'missing.json'), network: true, fresh: true });
  assert.equal(catalog.source, 'builtin');
  assert.equal(catalog.degradedReason, REASON.upstreamUnreachable);
});
