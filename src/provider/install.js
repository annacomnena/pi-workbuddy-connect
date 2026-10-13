// `install-provider` / `uninstall-provider` — put this gateway into pi's model list.
//
// What this module does, and deliberately does not do:
//
//   * It writes exactly one member of `~/.pi/agent/models.json` (`providers.workbuddy`)
//     and splices it into the file's existing bytes, so no other provider is reordered,
//     reformatted or otherwise touched (see models-json.js for why that matters).
//   * It backs the file up to `config-backups/models.json.<timestamp>.bak` before the
//     first write.
//   * It is idempotent: a second run with the same inputs reports `changed: false` and
//     leaves the file byte-identical.
//   * It never contacts an upstream. The model list comes from this project's own saved
//     catalog (written by `status --catalog`), or from the built-in placeholder roster
//     when there is no cache yet -- reported as `catalog.source`.
//   * It never prints the gateway bearer secret. The secret is either generated here
//     (and stored in gateway.json, 0600) or already present; when it has to be written
//     into models.json it is registered as a secret so the CLI's redaction self-check
//     can veto any output that would leak it.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { REASON, WbError } from '../errors.js';
import { ensureOwnDir, displayPath } from '../paths.js';
import { resolveCatalog } from '../catalog/index.js';
import { describeTokenSource, loadOrCreateToken, TOKEN_ENV, DEFAULT_PORT, readEndpointInfo, verifyEndpointIdentity } from '../gateway/secret.js';
import { SERVICE_NAME } from '../gateway/server.js';
import { filterModels, readModelsConfig, validateModelIds } from './models-config.js';
import { maskSecret } from '../util/mask.js';
import {
  PROVIDER_KEY,
  assertProviderEntryValid,
  assertSpliceSafe,
  buildProviderEntry,
  emptyModelsJson,
  findProvidersObject,
  jsonEqual,
  lineDiff,
  modelReference,
  spliceProvider,
  spliceProviderRemoval,
  stripBom,
} from './models-json.js';

export const DEFAULT_BASE_URL_PORT = DEFAULT_PORT;
export const BACKUP_DIR_NAME = 'config-backups';
const SCHEMA_VERSION = 1;

/** The models.json path pi itself would read (see pi's `getAgentDir()`). */
export function resolveModelsJsonPath({ modelsJsonPath, env = process.env, home = homedir() } = {}) {
  const explicit = typeof modelsJsonPath === 'string' ? modelsJsonPath.trim() : '';
  if (explicit !== '') return expandTilde(explicit, home);
  const agentDir = typeof env?.PI_CODING_AGENT_DIR === 'string' ? env.PI_CODING_AGENT_DIR.trim() : '';
  if (agentDir !== '') return join(expandTilde(agentDir, home), 'models.json');
  return join(home, '.pi', 'agent', 'models.json');
}

function expandTilde(value, home) {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(home, value.slice(2));
  return value;
}

/** A JSONC-style comment outside a string; pi tolerates these, this tool does not edit them. */
function looksLikeJsonc(text) {
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === '\\') i += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) return true;
  }
  return false;
}

function readExisting(path) {
  if (!existsSync(path)) return { existed: false, text: '' };
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new WbError(REASON.modelsJsonUnreadable, `${displayPath(path)} could not be read (${error?.code ?? 'error'})`);
  }
  return { existed: true, text };
}

function parseExisting(path, text) {
  try {
    const parsed = JSON.parse(stripBom(text));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('the top level is not a JSON object');
    }
    if (parsed.providers !== undefined && (typeof parsed.providers !== 'object' || parsed.providers === null || Array.isArray(parsed.providers))) {
      throw new Error('"providers" is not a JSON object');
    }
    return parsed;
  } catch (error) {
    const hint = looksLikeJsonc(text)
      ? ' (the file contains JSONC-style comments; pi tolerates them but this tool will not rewrite such a file -- remove them, or edit the provider in by hand)'
      : '';
    throw new WbError(REASON.modelsJsonUnreadable, `${displayPath(path)} is not plain JSON: ${error.message}${hint}`);
  }
}

function backupPathFor(path, now) {
  // Millisecond precision, plus a counter as the last resort: two writes inside the
  // same millisecond (or a test with a fixed clock) must never silently overwrite
  // an earlier backup.
  const stamp = new Date(now).toISOString().replace(/[-:.]/gu, '');
  const dir = join(dirname(path), BACKUP_DIR_NAME);
  const base = join(dir, `models.json.${stamp}.bak`);
  if (!existsSync(base)) return base;
  for (let attempt = 2; attempt < 1000; attempt += 1) {
    const candidate = join(dir, `models.json.${stamp}-${attempt}.bak`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new WbError(REASON.modelsJsonUnreadable, `${displayPath(dir)} already holds an unreasonable number of backups for one timestamp`);
}

/** Copy the current file aside. Returns the backup path, or null when there was nothing to copy. */
function writeBackup(path, existed, now) {
  if (!existed) return null;
  const backup = backupPathFor(path, now);
  mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
  copyFileSync(path, backup);
  return backup;
}

/**
 * Write the file, keeping its permissions.
 *
 * The atomic path (temp file + rename) is tried first. On Windows, renaming over a
 * file another process holds open fails with EPERM/EBUSY even though a plain write
 * succeeds -- observed on this project's own machine, where a running pi session
 * holds models.json. Because the pre-edit state is already in config-backups/, an
 * in-place rewrite is the honest fallback; its mode is reported in the document.
 *
 * @returns {{ mode: 'atomic' | 'in-place', reason?: string }}
 */
export function writeModelsJson(path, text, { rename = renameSync } = {}) {
  let mode = 0o600;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    /* a fresh file keeps the default */
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text, { mode });
    rename(tmp, path);
    return { mode: 'atomic' };
  } catch (error) {
    rmSync(tmp, { force: true });
    if (!['EPERM', 'EBUSY', 'EACCES', 'ENOTSUP'].includes(error?.code)) throw error;
    writeFileSync(path, text, { mode });
    return { mode: 'in-place', reason: error.code };
  }
}

/** Replace every occurrence of the secret with a marker, so a preview can never print it. */
function redactSecret(text, secret) {
  if (typeof secret !== 'string' || secret === '') return text;
  return text.split(secret).join('<redacted>');
}

function catalogSummary(catalog) {
  const fetchedAt = typeof catalog.fetchedAt === 'number' ? catalog.fetchedAt : undefined;
  return {
    source: catalog.source,
    count: Array.isArray(catalog.models) ? catalog.models.length : 0,
    ...(fetchedAt === undefined ? {} : { fetchedAt: new Date(fetchedAt).toISOString() }),
    ...(catalog.note === undefined ? {} : { note: catalog.note }),
    ...(catalog.degradedReason === undefined ? {} : { degradedReason: catalog.degradedReason }),
  };
}

function catalogWarnings(catalog, now = Date.now()) {
  const warnings = [];
  if (catalog.source === 'builtin') {
    warnings.push('the model list is the built-in placeholder (no saved catalog yet): run `pi-workbuddy-connect status --catalog` once, then re-run install-provider to write the real roster');
  }
  if (typeof catalog.degradedReason === 'string') {
    warnings.push(`the saved catalog is stale (${catalog.degradedReason}): re-run install-provider after a successful catalog refresh`);
  } else if (catalog.source === 'saved' && typeof catalog.fetchedAt === 'number') {
    const ageDays = (now - catalog.fetchedAt) / 86_400_000;
    if (ageDays > 7) {
      warnings.push(`the saved catalog is ${Math.floor(ageDays)} days old; run \`status --catalog\` and re-run install-provider to pick up roster changes`);
    }
  }
  return warnings;
}

/** The gateway base URL pi will talk to. */
export function providerBaseUrl(port = DEFAULT_BASE_URL_PORT) {
  return `http://127.0.0.1:${port}/v1`;
}

/** sha256 of the file, or null when it does not exist (SF-2 read/write guard). */
function fileSha256(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new WbError(REASON.modelsJsonUnreadable, `${displayPath(path)} could not be read (${error?.code ?? 'error'})`);
  }
}

/**
 * Which port the generated `baseUrl` should point at.
 *
 * The bug this fixes: `install-provider` used to default the baseUrl to 8317
 * even when the real gateway had bound a different port, so pi talked to
 * whatever else owned 8317. Now the default follows the live `endpoint.json`
 * announcement (the actual gateway), then `gateway.json.port`, then the default.
 * An explicit `--port` / env port still wins.
 */
export async function resolveInstallPort(options, ownDir, deps = {}) {
  if (options.portSource === 'flag' || options.portSource === 'env') {
    return { port: options.port, source: options.portSource };
  }
  const fallback = configOrDefaultPort(options);
  const endpoint = readEndpointInfo(ownDir);
  if (endpoint !== undefined && typeof endpoint.port === 'number' && endpoint.port > 0 && endpoint.alive !== false) {
    // S-6: a live pid is not proof the announcement is still ours -- Windows
    // recycles pids, so a stale file can name an unrelated live process. Ask
    // the port itself (loopback /healthz, no credential, no upstream).
    const verify = deps.verifyEndpoint ?? verifyEndpointIdentity;
    if (await verify(endpoint)) return { port: endpoint.port, source: 'endpoint', endpoint };
    return { ...fallback, endpointRejected: true, endpoint };
  }
  return fallback;
}

/** `gateway.json.port`, then the resolved option, then the default. */
function configOrDefaultPort(options) {
  const configPort = options.gatewayConfig?.port;
  if (configPort !== undefined && Number.isInteger(configPort) && configPort > 0) {
    return { port: configPort, source: 'config' };
  }
  if (typeof options.port === 'number' && options.port > 0) {
    return { port: options.port, source: options.portSource ?? 'default' };
  }
  return { port: DEFAULT_PORT, source: 'default' };
}

/**
 * How the credential should appear in models.json.
 * - the gateway secret came from the environment: interpolate the same variable, so
 *   nothing secret is written down at all;
 * - `--api-key-env NAME` was given: interpolate NAME;
 * - otherwise: the literal secret (models.json is user-private, like gateway.json).
 */
function apiKeyField({ token, tokenSource, apiKeyEnv }) {
  const envName = typeof apiKeyEnv === 'string' ? apiKeyEnv.trim() : '';
  if (tokenSource === 'env') return { value: `$${TOKEN_ENV}`, style: 'env', envName: TOKEN_ENV };
  if (envName !== '') return { value: `$${envName}`, style: 'env', envName };
  return { value: token, style: 'literal' };
}

/** Does this environment carry a non-empty value for `name`? */
function envCarries(env, name) {
  return typeof name === 'string' && name !== '' && typeof env?.[name] === 'string' && env[name].trim() !== '';
}

/**
 * Build (and optionally write) the `providers.workbuddy` entry.
 *
 * @param {object} options resolved CLI options: variant, ownDir, env, port, dryRun,
 *   apiKeyEnv, modelsJsonPath, secrets
 * @param {object} [deps] injectable seams for tests: home, now, catalog
 */
export async function installProvider(options, deps = {}) {
  const env = options.env ?? process.env;
  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now();
  const ownDir = deps.ownDir ?? ensureOwnDir(options.ownDir);
  const path = resolveModelsJsonPath({ modelsJsonPath: options.modelsJsonPath, env, home });
  const dryRun = options.dryRun === true;

  const tokenInfo = loadOrCreateToken(ownDir, env);
  const secrets = options.secrets ?? [];
  secrets.push(tokenInfo.token);

  const catalog = deps.catalog ?? await resolveCatalog({
    savedPath: join(ownDir, options.variant.catalogFilename),
    network: false,
  });

  const portResolution = await resolveInstallPort(options, ownDir, deps);
  if (portResolution.port === 0) {
    throw new WbError(REASON.invalidRequest, 'port 0 means "let the OS choose" and cannot be written into a baseUrl; pass the real port the gateway will listen on');
  }
  const baseUrl = providerBaseUrl(portResolution.port);
  const apiKey = apiKeyField({ token: tokenInfo.token, tokenSource: tokenInfo.source, apiKeyEnv: options.apiKeyEnv });
  if (!Array.isArray(catalog.models) || catalog.models.length === 0) {
    // Never write an empty model list: pi would reject the entry, and an empty
    // `providers.workbuddy` would look installed while resolving nothing.
    throw new WbError(REASON.catalogUnreachable, `the ${catalog.source} model catalog is empty; run \`pi-workbuddy-connect status --catalog\` and try again`);
  }
  // The exposure policy (S2.1): only the exposed models go into models.json, so
  // pi / subagent-win never see a short name that the gateway would then reject.
  const modelsFilter = options.modelsFilter ?? readModelsConfig(ownDir);
  if (modelsFilter.mode === 'allowlist') {
    const { invalid, available } = validateModelIds(modelsFilter.expose, catalog.models);
    if (invalid.length > 0) {
      throw new WbError(
        REASON.modelUnknown,
        `the model allowlist names ${invalid.map((id) => JSON.stringify(id)).join(', ')}, which the ${catalog.source} catalog does not know; candidates: ${available.join(', ')}`,
      );
    }
  }
  const exposedModels = filterModels(catalog.models, modelsFilter);
  if (exposedModels.length === 0) {
    throw new WbError(REASON.catalogUnreachable, `the exposed model set is empty for the ${catalog.source} catalog; run \`pi-workbuddy-connect models all\` or add a known model`);
  }
  const entry = buildProviderEntry({ models: exposedModels, baseUrl, apiKey: apiKey.value });
  assertProviderEntryValid(entry);

  const warnings = catalogWarnings(catalog, now);
  if (portResolution.source === 'endpoint' && portResolution.endpoint?.alive === undefined) {
    warnings.push('endpoint.json carried no pid, so its port is trusted as-is; start `serve` to confirm the real port');
  }
  if (portResolution.endpointRejected === true) {
    warnings.push(`the endpoint.json announcement (port ${portResolution.endpoint.port}${typeof portResolution.endpoint.pid === 'number' ? `, pid ${portResolution.endpoint.pid}` : ''}) did not answer as ${SERVICE_NAME} on 127.0.0.1: a stale announcement or a recycled pid (S-6), so the baseUrl falls back to ${portResolution.source}`);
  }
  const { existed, text } = readExisting(path);
  // SF-2: snapshot the exact bytes we are about to edit, so a concurrent edit
  // in the read->write window can be detected and refused (fail closed).
  const beforeSha = fileSha256(path);
  const beforeText = existed ? text : emptyModelsJson();
  const before = parseExisting(path, beforeText);
  const located = findProvidersObject(beforeText);
  const current = (before.providers ?? {})[PROVIDER_KEY];
  const changed = current === undefined || !jsonEqual(current, entry);

  let nextText = beforeText;
  let replaced = false;
  if (changed) {
    const spliced = spliceProvider(beforeText, located, PROVIDER_KEY, entry);
    nextText = spliced.text;
    replaced = spliced.replaced;
    assertSpliceSafe({ before, afterText: nextText, key: PROVIDER_KEY, entry, expectPresent: true });
  }

  const previewEntry = { ...entry, apiKey: '<gateway bearer secret>' };
  const previewText = changed
    ? redactSecret(spliceProvider(beforeText, located, PROVIDER_KEY, previewEntry).text, tokenInfo.token)
    : beforeText;
  const diff = changed ? lineDiff(redactSecret(beforeText, tokenInfo.token), previewText, { path: displayPath(path, home) }) : '';

  const document = {
    schema: SCHEMA_VERSION,
    command: 'install-provider',
    ok: true,
    variant: options.variant.id,
    variantName: options.variant.displayName,
    generatedAt: new Date(now).toISOString(),
    provider: PROVIDER_KEY,
    modelRefPattern: `${PROVIDER_KEY}/<model-id>`,
    modelRefs: entry.models.map((model) => modelReference(model.id)),
    modelsJson: displayPath(path, home),
    modelsJsonExisted: existed,
    dryRun,
    changed,
    replaced,
    backup: null,
    baseUrl,
    portSource: portResolution.source,
    exposure: { mode: modelsFilter.mode, ...(modelsFilter.mode === 'allowlist' ? { expose: [...modelsFilter.expose] } : {}) },
    apiKey: {
      style: apiKey.style,
      ...(apiKey.envName === undefined ? {} : { env: apiKey.envName }),
      tokenSource: tokenInfo.source,
      tokenSourceDescription: describeTokenSource(tokenInfo.source),
      masked: apiKey.style === 'literal' ? maskSecret(tokenInfo.token) : `$${apiKey.envName}`,
      value: 'not printed',
      ...(apiKey.style === 'env'
        ? { note: `models.json stores $${apiKey.envName}; set that variable in the environment that starts both \`serve\` and pi` }
        : {}),
    },
    catalog: catalogSummary(catalog),
    warnings,
    diff,
  };
  if (apiKey.style === 'literal') {
    // SF-1: pi supports `$NAME`/`${NAME}` interpolation, so the literal is the
    // fallback, not the recommendation. Say it first, loudly.
    document.securityWarning = `PLAINTEXT SECRET: providers.${PROVIDER_KEY}.apiKey now holds the gateway bearer in cleartext inside models.json. Prefer \`install-provider --api-key-env ${TOKEN_ENV}\` and set ${TOKEN_ENV} for both \`serve\` and pi, so no secret is stored here.`;
  } else if (!envCarries(env, apiKey.envName)) {
    // S-2: the interpolation is only resolvable in the environment that starts
    // pi. This process not seeing the variable is the first warning sign.
    document.warnings.push(`the environment variable ${apiKey.envName} is not set in this process; models.json stores $${apiKey.envName}, so set it in the environment that starts pi (and use the same value for \`serve\`)`);
  }

  if (!changed) {
    document.note = `providers.${PROVIDER_KEY} already matches; the file was not written`;
    return { ok: true, secrets, document };
  }
  if (dryRun) {
    document.note = 'dry run: nothing was written and no backup was taken';
    return { ok: true, secrets, document };
  }

  if (deps.beforeWrite !== undefined) await deps.beforeWrite(path);
  const nowSha = fileSha256(path);
  if (nowSha !== beforeSha) {
    throw new WbError(REASON.modelsJsonChanged, `${displayPath(path)} changed after it was read (another process edited it); nothing was written, re-run to retry`);
  }
  const backup = writeBackup(path, existed, now);
  document.backup = backup === null ? null : displayPath(backup, home);
  document.write = writeModelsJson(path, nextText, deps.rename === undefined ? undefined : { rename: deps.rename });
  if (document.write.mode !== 'atomic') {
    document.warnings.push(`the file was rewritten in place (the atomic rename was refused with ${document.write.reason}); a running pi very likely holds models.json open, so the pre-edit state is in the backup`);
  }
  if (apiKey.style === 'literal') {
    document.warnings.push('the gateway bearer secret is now also stored in models.json (user-private); remove the provider with uninstall-provider when you no longer need it');
  }
  return { ok: true, secrets, document };
}

/**
 * Remove `providers.workbuddy` and nothing else.
 *
 * @param {object} options resolved CLI options
 * @param {object} [deps] injectable seams for tests: home, now
 */
export async function uninstallProvider(options, deps = {}) {
  const env = options.env ?? process.env;
  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now();
  const dryRun = options.dryRun === true;
  const path = resolveModelsJsonPath({ modelsJsonPath: options.modelsJsonPath, env, home });

  const document = {
    schema: SCHEMA_VERSION,
    command: 'uninstall-provider',
    ok: true,
    provider: PROVIDER_KEY,
    generatedAt: new Date(now).toISOString(),
    modelsJson: displayPath(path, home),
    dryRun,
    changed: false,
    removed: false,
    backup: null,
  };

  if (!existsSync(path)) {
    document.note = `${document.modelsJson} does not exist; nothing to remove`;
    return { ok: true, secrets: [], document };
  }

  const { text } = readExisting(path);
  const beforeSha = fileSha256(path);
  const before = parseExisting(path, text);
  if ((before.providers ?? {})[PROVIDER_KEY] === undefined) {
    document.note = `providers.${PROVIDER_KEY} is not present; the file was not written`;
    return { ok: true, secrets: [], document };
  }
  const located = findProvidersObject(text);
  const removal = spliceProviderRemoval(text, located, PROVIDER_KEY);
  assertSpliceSafe({ before, afterText: removal.text, key: PROVIDER_KEY, expectPresent: false });

  document.changed = true;
  document.removed = removal.removed;
  document.diff = lineDiff(text, removal.text, { path: document.modelsJson });

  if (dryRun) {
    document.note = 'dry run: nothing was written and no backup was taken';
    return { ok: true, secrets: [], document };
  }
  if (deps.beforeWrite !== undefined) await deps.beforeWrite(path);
  if (fileSha256(path) !== beforeSha) {
    throw new WbError(REASON.modelsJsonChanged, `${displayPath(path)} changed after it was read (another process edited it); nothing was written, re-run to retry`);
  }
  const backup = writeBackup(path, true, now);
  document.backup = backup === null ? null : displayPath(backup, home);
  document.write = writeModelsJson(path, removal.text, deps.rename === undefined ? undefined : { rename: deps.rename });
  return { ok: true, secrets: [], document };
}
