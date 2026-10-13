// Model catalog with an explicit degradation chain.
//
// live -> saved -> built-in. The active source is always reported, so a stale
// or placeholder answer is never mistaken for the live one (risk R2: the
// upstream is a private interface and will change).

import { readFileSync, writeFileSync } from 'node:fs';
import { REASON, WbError } from '../errors.js';
import { chatBaseFor, regionOfDomain } from '../upstream/domains.js';
import { CLIENT_UA, appUserAgent, catalogHeaders } from '../upstream/headers.js';
import { BUILTIN_MODELS, BUILTIN_STALE_NOTE } from './builtin-models.js';

const CATALOG_PATH = '/v3/config';
const EFFORT_VALUES = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveReasoning(wrapped) {
  const raw = wrapped.reasoning;
  let supportedEfforts;
  let defaultEffort;
  if (isObject(raw)) {
    if (Array.isArray(raw.supportedEfforts)) {
      const efforts = raw.supportedEfforts.filter((value) => typeof value === 'string' && EFFORT_VALUES.has(value));
      if (efforts.length > 0) supportedEfforts = efforts;
    }
    if (typeof raw.defaultEffort === 'string' && EFFORT_VALUES.has(raw.defaultEffort)) defaultEffort = raw.defaultEffort;
    else if (typeof raw.effort === 'string' && EFFORT_VALUES.has(raw.effort)) defaultEffort = raw.effort;
  }
  return {
    supportsReasoning: wrapped.supportsReasoning === true,
    ...(supportedEfforts === undefined ? {} : { supportedEfforts }),
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
  };
}

/** Normalize the credit-rate string, e.g. `"x0.79 credits"` -> `"x0.79"`. */
export function normalizeCredits(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return value.trim().replace(/\s*credits?\b.*$/iu, '') || undefined;
}

/**
 * Parse a `/v3/config` envelope into usable model rows.
 * Membership is the `cli` agent roster intersected with the usable rows.
 */
export function parseCatalog(envelope) {
  const data = isObject(envelope.data)
    ? envelope.data
    : (isObject(envelope.document) ? envelope.document : {});
  const rawModels = Array.isArray(data.models) ? data.models : [];
  const agents = Array.isArray(data.agents) ? data.agents : [];
  let cliIds;
  for (const agent of agents) {
    if (isObject(agent) && agent.name === 'cli' && Array.isArray(agent.models)) {
      cliIds = agent.models.filter((id) => typeof id === 'string');
      break;
    }
  }
  if (cliIds === undefined || cliIds.length === 0) {
    throw new WbError(REASON.upstreamClientError, 'the model catalog lists no cli agent models');
  }
  const byId = new Map();
  for (const model of rawModels) {
    if (!isObject(model)) continue;
    const id = typeof model.id === 'string' ? model.id : '';
    if (id === '' || model.disabled === true) continue;
    const input = positive(model.maxInputTokens) ? model.maxInputTokens : 0;
    const output = positive(model.maxOutputTokens) ? model.maxOutputTokens : 0;
    if (input <= 0 || output <= 0) continue;
    byId.set(id, {
      id,
      name: typeof model.name === 'string' && model.name !== '' ? model.name : id,
      contextWindow: input,
      maxTokens: output,
      supportsImages: model.supportsImages === true && model.disabledMultimodal !== true,
      credits: normalizeCredits(model.credits),
      ...resolveReasoning(model),
    });
  }
  const models = cliIds.map((id) => byId.get(id)).filter((model) => model !== undefined);
  if (models.length === 0) throw new WbError(REASON.upstreamClientError, 'the model catalog resolved to an empty list');
  return models;
}

/** Fetch the live catalog. `appVersion` is used only for the global variant. */
export async function fetchCatalog({ client, credential, appVersion }) {
  const international = regionOfDomain(credential.domain) === 'global';
  const userAgent = international && typeof appVersion === 'string'
    ? appUserAgent(appVersion)
    : CLIENT_UA;
  const result = await client.send({
    url: client.url(chatBaseFor(credential), CATALOG_PATH),
    method: 'GET',
    headers: catalogHeaders(credential, { userAgent, product: international }),
  });
  const envelope = client.ensureOk(result, 'the catalog read');
  return { models: parseCatalog(envelope), source: 'live', fetchedAt: Date.now() };
}

/** Read the saved catalog; undefined when absent or malformed. */
export function loadSavedCatalog(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
  if (!isObject(parsed) || !Array.isArray(parsed.models)) return undefined;
  return {
    models: parsed.models,
    source: 'saved',
    fetchedAt: typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : undefined,
  };
}

/** Persist a live catalog next to the credential copy. */
export function saveCatalog(filePath, catalog) {
  const payload = { version: 1, fetchedAt: catalog.fetchedAt ?? Date.now(), models: catalog.models };
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

/** The built-in placeholder, always available. */
export function builtinCatalog() {
  return { models: BUILTIN_MODELS.map((model) => ({ ...model })), source: 'builtin', note: BUILTIN_STALE_NOTE };
}

/**
 * Resolve the catalog according to policy.
 * @param {{ client: object, credential: object, savedPath: string, network: boolean,
 *   appVersion?: string, fresh?: boolean }} options
 */
export async function resolveCatalog({ client, credential, savedPath, network, appVersion, fresh = false }) {
  const saved = savedPath === undefined ? undefined : loadSavedCatalog(savedPath);
  if (network && fresh && client !== undefined) {
    try {
      const live = await fetchCatalog({ client, credential, appVersion });
      if (savedPath !== undefined) {
        try {
          saveCatalog(savedPath, live);
        } catch {
          /* a cache write must never fail the read */
        }
      }
      return live;
    } catch (error) {
      if (saved !== undefined) return { ...saved, degradedReason: error.code ?? 'catalog-unreachable' };
      return { ...builtinCatalog(), degradedReason: error.code ?? 'catalog-unreachable' };
    }
  }
  if (saved !== undefined) return saved;
  return builtinCatalog();
}
