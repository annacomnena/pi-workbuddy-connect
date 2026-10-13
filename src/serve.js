// `serve` — start the loopback OpenAI-compatible gateway.
//
// Wiring only: the credential store, the single outbound client, the session
// resolver, the catalog cache, the cooldown table and the HTTP server are all
// separate modules. This file makes them one process, announces the listening
// endpoint in this project's own directory, and says out loud what protection
// the credential copy will get (SF-6).

import process from 'node:process';
import { join } from 'node:path';
import { CredentialStore } from './credentials/index.js';
import { createSessionResolver } from './credentials/session.js';
import { resolveAppVersion } from './credentials/electron.js';
import { UpstreamClient } from './upstream/client.js';
import { UPSTREAM_HOSTS } from './upstream/domains.js';
import { desktopUserAgent } from './upstream/headers.js';
import { fetchCredits } from './billing/index.js';
import { createCatalogSource } from './gateway/catalog-cache.js';
import { ModelCooldowns } from './gateway/cooldown.js';
import { createGateway, SERVICE_NAME } from './gateway/server.js';
import { describeTokenSource, loadOrCreateToken, writeEndpointFile, removeEndpointFile, removeStaleEndpointFile, DEFAULT_PORT } from './gateway/secret.js';
import { readModelsConfig } from './provider/models-config.js';
import { ensureOwnDir, displayPath } from './paths.js';

/** Versions used only when the local app's own version cannot be read. */
export const FALLBACK_APP_VERSIONS = Object.freeze({ cn: '5.5.6', global: '5.5.2' });

const DO_NOT = Object.freeze([
  'no multi-account pooling or rotation',
  'no automated check-in or credit farming',
  'no rate-limit or billing bypass (including identity switching during a cooldown)',
  'no telemetry and no reporting',
  'credentials never leave the three upstream hosts',
]);

/**
 * What protection the own credential copy will get, decided without running the
 * key helper (startup must stay cheap).
 */
export async function describeOwnCopyProtection(store) {
  let desktopFormat = 'unknown';
  try {
    desktopFormat = (await store.classifyDesktop()).format;
  } catch {
    desktopFormat = 'error';
  }
  const osAvailable = store.osKeyStore?.available() === true;
  const atRestExpected = desktopFormat === 'encrypted';
  return {
    desktopFormat,
    atRestKeyExpected: atRestExpected,
    osFacility: osAvailable ? store.osKeyStore.source : null,
    protected: osAvailable || atRestExpected,
  };
}

/**
 * Start the gateway. The caller owns signals and lifetime.
 *
 * @param {object} options resolved CLI options (variant, port, ownDir, ...)
 * @param {object} [deps] injectable dependencies (tests)
 */
export async function startServe(options, deps = {}) {
  const env = options.env ?? process.env;
  const out = deps.out ?? process.stdout;
  const logger = deps.logger ?? console;
  const warnings = [];

  const ownDir = deps.ownDir ?? ensureOwnDir(options.ownDir);
  // A hard kill leaves `endpoint.json` behind pointing at a dead port.
  if (removeStaleEndpointFile(ownDir)) {
    logger.info?.('removed a stale endpoint.json left by a process that is no longer running');
  }
  const tokenInfo = loadOrCreateToken(ownDir, env);
  // The exposure policy (S2.1): read once, hand to the gateway and report it.
  const modelsFilter = options.modelsFilter ?? readModelsConfig(ownDir);
  const store = deps.store ?? new CredentialStore({
    variant: options.variant,
    authFile: options.authFile,
    electronPath: options.electronPath,
    env,
    ownDir,
    plat: options.plat,
    logger,
  });
  const client = deps.client ?? new UpstreamClient();
  const session = deps.session ?? createSessionResolver({ store, client, logger });

  // User-Agent policy (risk R3): the version comes from the locally installed
  // app. When that cannot be read, the documented *lower* fallback is used and
  // said out loud -- never a higher, invented version.
  let appVersion = deps.appVersion ?? options.appVersion;
  let appVersionSource = 'local-app';
  if (appVersion === undefined) {
    try {
      appVersion = await resolveAppVersion(options.variant, { plat: options.plat });
    } catch {
      appVersion = undefined;
    }
    if (appVersion === undefined) {
      appVersion = FALLBACK_APP_VERSIONS[options.variant.region];
      appVersionSource = 'fallback';
      const warning = `the local ${options.variant.appName} version could not be read; using the documented lower fallback ${appVersion} for the User-Agent (never a higher version)`;
      warnings.push(warning);
      logger.warn?.(warning);
    }
  }
  const userAgent = desktopUserAgent({ product: options.variant.appName, appVersion });

  const protection = deps.protection ?? await describeOwnCopyProtection(store);
  if (!protection.protected) {
    const warning = 'SF-6 DEGRADED: neither the app at-rest key (desktop credential is not encrypted) nor an OS key facility is available, so a refreshed credential copy would be written as PLAINTEXT with best-effort 0600/inherited-ACL permissions. See docs/security.md.';
    warnings.push(warning);
    logger.warn?.(warning);
  }

  const cooldowns = deps.cooldowns ?? new ModelCooldowns({ now: options.now });
  const catalogSource = deps.catalogSource ?? createCatalogSource({
    session,
    client,
    savedPath: join(ownDir, options.variant.catalogFilename),
    appVersion,
    logger,
  });
  const gateway = createGateway({
    session,
    client,
    cooldowns,
    catalogSource,
    token: tokenInfo.token,
    variantId: options.variant.id,
    region: options.variant.region,
    userAgent,
    tokenSource: tokenInfo.source,
    version: deps.version ?? '0.1.0',
    fetchCredits: deps.fetchCredits ?? fetchCredits,
    logger,
    startedAt: deps.startedAt ?? Date.now(),
    now: options.now,
    modelsFilter,
  });

  // Port policy: `--port` > env/config > default. A preferred port that is
  // already taken falls back to an OS-chosen free port (the real machine has
  // EasyCLIProxyAPI on the old default); an explicit `--port` fails loudly.
  const requestedPort = options.port ?? DEFAULT_PORT;
  const port = await gateway.listen(requestedPort, { allowFallback: options.portExplicit !== true });
  const portFallback = port !== requestedPort && requestedPort !== 0
    ? { requested: requestedPort, actual: port, source: options.portSource ?? 'default' }
    : undefined;
  if (portFallback !== undefined) {
    const warning = `the preferred port ${requestedPort} (${portFallback.source}) was already in use, so the gateway bound ${port} instead; endpoint.json records the real port`;
    warnings.push(warning);
    logger.warn?.(warning);
  }
  const url = `http://127.0.0.1:${port}`;
  const endpointFile = writeEndpointFile(ownDir, {
    port,
    variant: options.variant.id,
    tokenSource: tokenInfo.source,
    startedAt: new Date(deps.startedAt ?? Date.now()).toISOString(),
    plat: options.plat ?? process.platform,
  });

  const document = {
    schema: 1,
    command: 'serve',
    ok: true,
    service: SERVICE_NAME,
    url,
    baseUrl: `${url}/v1`,
    host: '127.0.0.1',
    port,
    ...(portFallback === undefined ? {} : { portFallback }),
    modelsExposed: {
      mode: modelsFilter.mode,
      ...(modelsFilter.mode === 'allowlist' ? { allowlist: [...modelsFilter.expose] } : {}),
    },
    variant: options.variant.id,
    variantName: options.variant.displayName,
    region: options.variant.region,
    network: true,
    endpointFile: displayPath(endpointFile, deps.home),
    token: { source: tokenInfo.source, path: displayPath(tokenInfo.path, deps.home), value: 'not printed' },
    userAgent,
    appVersion: { value: appVersion, source: appVersionSource },
    credentialProtection: protection,
    cooldowns: {},
    outbound: { hosts: [...UPSTREAM_HOSTS], telemetry: 'none' },
    warnings,
    doNot: [...DO_NOT],
    usage: {
      models: `${url}/v1/models`,
      chat: `${url}/v1/chat/completions`,
      health: `${url}/healthz`,
      credits: `${url}/v1/workbuddy/credits (non-standard)`,
      bearer: describeTokenSource(tokenInfo.source),
    },
  };

  logger.info?.(`${SERVICE_NAME} gateway listening on ${url} (loopback only)`);
  logger.info?.(`bearer secret: ${describeTokenSource(tokenInfo.source)}; not printed`);
  logger.info?.(`outbound hosts: ${UPSTREAM_HOSTS.join(', ')} — no telemetry`);

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await gateway.close();
    removeEndpointFile(ownDir);
  }

  return { gateway, store, client, cooldowns, catalogSource, session, port, url, endpointFile, document, warnings, close };
}
