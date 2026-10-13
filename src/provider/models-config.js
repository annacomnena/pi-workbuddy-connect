// The model-exposure policy: one config source, three consumers.
//
// The user asked to choose which models the gateway exposes. That choice lives
// in exactly one place -- the `models` field of this project's `gateway.json`:
//
//   "models": { "mode": "all" | "allowlist", "expose": ["deepseek-v4.1-flash"] }
//
// and is read by all three surfaces, so they can never disagree:
//
//   * `serve` GET  /v1/models            -> advertises only the exposed set
//   * `serve` POST /v1/chat/completions  -> a hidden model is a clear 404
//   * `install-provider`                 -> writes only the exposed set into
//                                           `~/.pi/agent/models.json`, so pi and
//                                           subagent-win never see an ambiguous
//                                           short name for a hidden model
//
// This is a *policy filter*, not a security boundary: it shapes the advertised
// roster and rejects requests for hidden ids, but anyone who can reach the
// loopback gateway already holds the bearer secret. It is not a credential or
// billing control.

import { REASON, WbError } from '../errors.js';
import { readGatewayConfig, writeGatewayConfig } from '../gateway/secret.js';
import { canonicalModelId } from './models-json.js';

export const MODES = Object.freeze(['all', 'allowlist']);

/** Everything is exposed until the user says otherwise. */
export const DEFAULT_MODELS_CONFIG = Object.freeze({ mode: 'all', expose: [] });

/**
 * Normalize an arbitrary `models` value into `{ mode, expose }`.
 *
 * An explicit `mode` wins. When `mode` is omitted, a non-empty `expose` implies
 * `allowlist` (so a hand-written `{"expose":[...]}` does the obvious thing).
 * An empty allowlist is refused: it would hide every model, which is never what
 * a user means and would make `install-provider` write a provider with no models.
 */
export function normalizeModelsConfig(raw) {
  if (raw === undefined || raw === null) return { ...DEFAULT_MODELS_CONFIG, expose: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WbError(REASON.modelsConfigUnreadable, 'the "models" field in gateway.json must be an object');
  }
  let mode;
  if (raw.mode === undefined) {
    mode = Array.isArray(raw.expose) && raw.expose.length > 0 ? 'allowlist' : 'all';
  } else if (raw.mode === 'all' || raw.mode === 'allowlist') {
    mode = raw.mode;
  } else {
    throw new WbError(REASON.modelsConfigUnreadable, `the "models.mode" field in gateway.json must be "all" or "allowlist" (got ${JSON.stringify(raw.mode)})`);
  }
  const expose = [];
  const seen = new Set();
  for (const item of Array.isArray(raw.expose) ? raw.expose : []) {
    const id = canonicalModelId(typeof item === 'string' ? item : '');
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    expose.push(id);
  }
  if (mode === 'allowlist' && expose.length === 0) {
    throw new WbError(REASON.modelsConfigUnreadable, 'the model allowlist is empty, so every model would be hidden; use `models all` to expose everything');
  }
  return { mode, expose };
}

/** Read the policy from this project's `gateway.json`. */
export function readModelsConfig(dir) {
  return normalizeModelsConfig(readGatewayConfig(dir).models);
}

/** Persist the policy, preserving every unrelated field of `gateway.json`. */
export async function writeModelsConfig(dir, config, deps = {}) {
  const normalized = normalizeModelsConfig(config);
  await writeGatewayConfig(dir, { models: normalized }, deps);
  return normalized;
}

/** Is a (bare or legacy-prefixed) model id exposed by this policy? */
export function isExposed(id, config) {
  const canonical = canonicalModelId(id);
  if (config.mode === 'all') return true;
  return config.expose.includes(canonical);
}

/** Keep only the exposed rows, preserving catalog order. */
export function filterModels(models, config) {
  const list = Array.isArray(models) ? models : [];
  if (config.mode === 'all') return list;
  const exposed = new Set(config.expose);
  return list.filter((model) => exposed.has(canonicalModelId(model?.id)));
}

/**
 * Split requested ids into those the catalog knows and those it does not.
 * `available` is the candidate list a caller should show on a rejection.
 */
export function validateModelIds(ids, catalogModels) {
  const available = [];
  const availableSet = new Set();
  for (const model of Array.isArray(catalogModels) ? catalogModels : []) {
    const id = canonicalModelId(model?.id);
    if (id === '' || availableSet.has(id)) continue;
    availableSet.add(id);
    available.push(id);
  }
  const valid = [];
  const invalid = [];
  const seen = new Set();
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = canonicalModelId(typeof raw === 'string' ? raw : '');
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    if (availableSet.has(id)) valid.push(id);
    else invalid.push(id);
  }
  return { valid, invalid, available };
}
