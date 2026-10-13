// pi-workbuddy-connect CLI — `status` and `doctor`.
//
// Both commands are read-only with respect to the desktop app. `status`
// resolves the credential (unwrapping at-rest envelopes when needed) and, by
// default, reads the real credit balance once. `doctor` is diagnostic and, by
// default, neither runs the key helper nor opens a network connection.
//
// Every document that leaves this module is scanned for token shapes and for
// the exact secrets the process holds. A hit fails closed: the payload is
// replaced by an error document rather than printed.

import process from 'node:process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CredentialStore } from './credentials/index.js';
import { resolveAppVersion } from './credentials/electron.js';
import { REASON, WbError, describeError, reasonCodeOf } from './errors.js';
import { resolveOptions, parsePort } from './config.js';
import { UpstreamClient } from './upstream/client.js';
import { fetchCredits } from './billing/index.js';
import { resolveCatalog, loadSavedCatalog } from './catalog/index.js';
import { LEAK_PATTERNS, findLeaks } from './util/redact.js';
import { maskIdentifier, maskKeyId, maskSecret } from './util/mask.js';
import { displayPath, ensureOwnDir } from './paths.js';
import { DEFAULT_PORT, TOKEN_ENV, PORT_ENV, readGatewayConfig } from './gateway/secret.js';
import { startServe } from './serve.js';
import { installProvider, resolveModelsJsonPath, uninstallProvider } from './provider/install.js';
import { normalizeModelsConfig, readModelsConfig, validateModelIds, writeModelsConfig } from './provider/models-config.js';
import { PROVIDER_KEY, canonicalModelId, jsonEqual, stripBom } from './provider/models-json.js';

export const SCHEMA_VERSION = 1;

export const USAGE = `pi-workbuddy-connect — local WorkBuddy access (S3 read-only CLI + S1 gateway)

Usage:
  pi-workbuddy-connect status [options]   read the local sign-in and credit balance
  pi-workbuddy-connect doctor [options]   diagnose why the local sign-in is unusable
  pi-workbuddy-connect serve [options]    run the loopback OpenAI-compatible gateway
  pi-workbuddy-connect models <action>    choose which models the gateway exposes
  pi-workbuddy-connect install-provider [options]    add providers.workbuddy to pi's models.json
  pi-workbuddy-connect uninstall-provider [options]  remove providers.workbuddy again

Models actions:
  models list                 show the current policy and the known models
  models set <id...>          expose exactly these models (allowlist)
  models add <id...>          add models to the allowlist
  models remove <id...>       remove models from the allowlist
  models all                  expose every model the catalog knows

Options:
  --json                 machine-readable output
  --variant <cn|ai>      which desktop app to read (default: cn)
  --auth-file <path>     explicit auth file (env: WORKBUDDY_AUTH_FILE / WORKBUDDY_AI_AUTH_FILE)
  --electron <path>      explicit app binary (env: WORKBUDDY_ELECTRON_BIN / WORKBUDDY_AI_ELECTRON_BIN)
  --no-network           local only; do not contact any upstream host
  --catalog              status: refresh the model catalog live (one extra request)
  --decrypt              doctor: actually unwrap the credential (runs the app's key helper)
  --port <n>             serve: listening port on 127.0.0.1 (default ${DEFAULT_PORT}; env: ${PORT_ENV})
                         install-provider: the port the generated baseUrl points at
                         (default: the live endpoint.json port, then gateway.json.port)
  --models <a,b,...>     serve/install-provider: expose only these models for this run
  --dry-run              install/uninstall-provider/models: write nothing, back up nothing
  --models-json <path>   install/uninstall-provider: edit this file instead of
                         <agent dir>/models.json (default: $PI_CODING_AGENT_DIR or ~/.pi/agent)
  --api-key-env <NAME>   install-provider: store \`$NAME\` instead of the gateway secret itself
  --help                 this text
  --version              print the version

Notes:
  * status decrypts the credential when it is encrypted (this runs the app's own
    binary once, locally) and then reads the balance. That is the only upstream
    request it makes unless --catalog is given.
  * doctor never sends credentials and never prints one; it reports reason codes.
  * serve binds 127.0.0.1 ONLY and requires a random per-process bearer secret
    (this project's gateway.json, overridable with ${TOKEN_ENV}).
    GET /healthz needs no bearer; every other route does. A preferred port that
    is already taken falls back to an OS-chosen free port and the real port is
    written to endpoint.json. The gateway does no local billing: the upstream
    charges per token on the server side.
  * The model-exposure policy is one setting in gateway.json, shared by
    \`GET /v1/models\`, \`POST /v1/chat/completions\` and install-provider. It is a
    policy filter, not a security boundary; the bearer secret is the gate.
  * install-provider never contacts an upstream and never runs the app's key
    helper: the model list comes from this project's saved catalog (refresh it
    with \`status --catalog\`) or from the built-in placeholder roster. It edits
    ONLY providers.workbuddy in models.json, backs the file up first, and is
    idempotent. The gateway must be running (\`serve\`) for the models to answer.

This tool is unofficial and unrelated to Tencent. It only reuses the sign-in of
your own local app, spends your own credits, and writes nothing to the app.
`;

export const SERVE_STOP_HINT = 'press Ctrl+C to stop the gateway';

/** Parse argv into a command and flags. */
export function parseArgs(argv) {
  const flags = {};
  let command;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case 'status':
      case 'doctor':
      case 'serve':
      case 'models':
      case 'install-provider':
      case 'uninstall-provider':
        if (command !== undefined) return { error: `unexpected command ${JSON.stringify(token)}` };
        command = token;
        break;
      case '--json': flags.json = true; break;
      case '--no-network': flags.noNetwork = true; break;
      case '--catalog': flags.catalog = true; break;
      case '--decrypt': flags.decrypt = true; break;
      case '--dry-run': flags.dryRun = true; break;
      case '--help': case '-h': flags.help = true; break;
      case '--version': case '-v': flags.version = true; break;
      case '--variant': flags.variant = argv[++index]; break;
      case '--auth-file': flags.authFile = argv[++index]; break;
      case '--electron': flags.electron = argv[++index]; break;
      case '--port': flags.port = argv[++index]; break;
      case '--api-key-env': flags.apiKeyEnv = argv[++index]; break;
      case '--models-json': flags.modelsJson = argv[++index]; break;
      case '--models': flags.models = argv[++index]; break;
      default:
        if (token.startsWith('--variant=')) flags.variant = token.slice('--variant='.length);
        else if (token.startsWith('--auth-file=')) flags.authFile = token.slice('--auth-file='.length);
        else if (token.startsWith('--electron=')) flags.electron = token.slice('--electron='.length);
        else if (token.startsWith('--port=')) flags.port = token.slice('--port='.length);
        else if (token.startsWith('--api-key-env=')) flags.apiKeyEnv = token.slice('--api-key-env='.length);
        else if (token.startsWith('--models-json=')) flags.modelsJson = token.slice('--models-json='.length);
        else if (token.startsWith('--models=')) flags.models = token.slice('--models='.length);
        else if (command === 'models' && !token.startsWith('-')) {
          // `models <action> <id...>`: the first bare token is the action, the
          // rest are model ids.
          if (flags.modelsAction === undefined) flags.modelsAction = token;
          else (flags.modelsIds ??= []).push(token);
        } else return { error: `unknown argument ${JSON.stringify(token)}` };
    }
  }
  return { command, flags };
}

function toJson(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Render a document, run the leak self-check over the rendered text, and
 * replace it with a safe error document on a hit.
 */
export function finalizeDocument(document, secrets, json) {
  const withCheck = {
    ...document,
    redactionSelfCheck: { ok: true, patternsChecked: LEAK_PATTERNS.length },
  };
  const text = json ? toJson(withCheck) : renderHuman(withCheck);
  const leaks = findLeaks(text, secrets);
  if (leaks.length === 0) return { text, ok: true };
  const safe = {
    schema: SCHEMA_VERSION,
    command: document.command,
    ok: false,
    error: { reasonCode: 'redaction-self-check-failed', message: 'output was withheld because it failed the token redaction self-check' },
    redactionSelfCheck: { ok: false, patterns: [...new Set(leaks.map((hit) => hit.pattern))] },
  };
  return { text: json ? toJson(safe) : `${safe.error.message}\n`, ok: false };
}

function sessionState(credential, now = Date.now()) {
  const { expiresAtMs, refreshExpiresAtMs, refreshToken } = credential;
  if (expiresAtMs <= 0) return { state: 'unknown' };
  if (expiresAtMs > now) {
    return { state: 'active', secondsRemaining: Math.floor((expiresAtMs - now) / 1000) };
  }
  const refreshUsable = refreshToken !== '' && refreshExpiresAtMs !== undefined && refreshExpiresAtMs > now;
  return refreshUsable
    ? { state: 'refreshable', secondsSinceExpiry: Math.floor((now - expiresAtMs) / 1000) }
    : { state: 'expired', secondsSinceExpiry: Math.floor((now - expiresAtMs) / 1000) };
}

function isoOrNull(ms) {
  return typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : null;
}

function catalogSummary(catalog) {
  const models = Array.isArray(catalog.models) ? catalog.models : [];
  return {
    source: catalog.source,
    count: models.length,
    fetchedAt: isoOrNull(catalog.fetchedAt),
    ...(catalog.note === undefined ? {} : { note: catalog.note }),
    ...(catalog.degradedReason === undefined ? {} : { degradedReason: catalog.degradedReason }),
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      ...(model.credits === undefined ? {} : { credits: model.credits }),
    })),
  };
}

function billingSummary(billing) {
  if (!billing.ok) return billing;
  return {
    ok: true,
    total: billing.total,
    unlimited: billing.unlimited === true,
    ...(billing.cycleResetTime === undefined ? {} : { cycleResetTime: billing.cycleResetTime }),
    fetchedAt: isoOrNull(billing.fetchedAt),
    packages: billing.packages.map((pack) => ({
      name: pack.name,
      remain: pack.remain,
      size: pack.size,
      ...(pack.unlimited === true ? { unlimited: true } : {}),
      ...(pack.endTimeMs === undefined ? {} : { endTime: isoOrNull(pack.endTimeMs) }),
    })),
  };
}

/**
 * Build the `status` document.
 * @returns {Promise<{ document: object, ok: boolean, secrets: string[] }>}
 */
export async function buildStatus(options) {
  const { variant } = options;
  const store = new CredentialStore({
    variant,
    authFile: options.authFile,
    electronPath: options.electronPath,
    env: options.env,
    ownDir: options.ownDir,
  });
  // The caller (runCli) passes the array so that an error thrown after this
  // point still lets the top-level error path run the leak self-check against
  // the secrets already collected, instead of an empty list.
  const secrets = options.secrets ?? [];
  const desktopPath = store.desktopCandidates()[0];
  const base = {
    schema: SCHEMA_VERSION,
    command: 'status',
    variant: variant.id,
    variantName: variant.displayName,
    generatedAt: new Date().toISOString(),
    network: options.network,
  };
  const auth = {
    desktopPath: displayPath(desktopPath),
    ownCopyPath: displayPath(store.ownPath),
  };

  let loaded;
  let failure;
  try {
    loaded = await store.current();
  } catch (error) {
    failure = error;
  }

  if (failure !== undefined || loaded === undefined) {
    const reasonCode = failure === undefined ? REASON.credentialMissing : (reasonCodeOf(failure) ?? REASON.credentialUnreadable);
    const message = failure === undefined
      ? `no signed-in ${variant.appName} account was found at the expected location`
      : describeError(failure);
    const authInfo = { ...auth, ...(failure === undefined ? { format: 'absent' } : {}) };
    const catalog = await resolveCatalog({
      client: options.network ? new UpstreamClient() : undefined,
      credential: undefined,
      savedPath: `${options.ownDir}/${variant.catalogFilename}`,
      network: false,
    });
    return {
      ok: false,
      secrets,
      document: {
        ...base,
        ok: false,
        auth: authInfo,
        error: { reasonCode, message },
        reasonCodes: [reasonCode],
        billing: { ok: false, reason: reasonCode },
        catalog: catalogSummary(catalog),
      },
    };
  }

  const credential = loaded.credential;
  secrets.push(credential.accessToken, credential.refreshToken, credential.uid, credential.uin);
  const session = sessionState(credential);
  const reasonCodes = [];
  // A dead session means the credential is unusable: the data is still reported,
  // but `ok` must be false so `$?` and `ok`-only scripts do not read it as success.
  const sessionDead = session.state === 'expired';
  if (sessionDead) reasonCodes.push(REASON.sessionDead);

  let billing;
  if (options.network) {
    try {
      billing = billingSummary(await fetchCredits({ client: new UpstreamClient(), credential }));
    } catch (error) {
      const reason = reasonCodeOf(error) ?? REASON.billingUnreachable;
      reasonCodes.push(reason);
      billing = { ok: false, reason, message: describeError(error) };
    }
  } else {
    reasonCodes.push(REASON.networkDisabled);
    billing = { ok: false, reason: REASON.networkDisabled, message: '--no-network: the balance was not read' };
  }

  const catalog = await resolveCatalog({
    client: options.network && options.refreshCatalog ? new UpstreamClient() : undefined,
    credential,
    savedPath: `${options.ownDir}/${variant.catalogFilename}`,
    network: options.network && options.refreshCatalog,
    fresh: options.refreshCatalog,
    appVersion: variant.region === 'global' ? await resolveAppVersion(variant) : undefined,
  });

  const document = {
    ...base,
    ok: !sessionDead,
    ...(sessionDead
      ? { error: { reasonCode: REASON.sessionDead, message: 'the access and refresh tokens are expired; sign in again in the app' } }
      : {}),
    auth: {
      ...auth,
      format: loaded.format,
      source: loaded.source,
      decryptable: loaded.format === 'encrypted' ? true : null,
      ...(loaded.keyId === undefined ? {} : { keyIdMasked: maskKeyId(loaded.keyId), keyIdMatched: loaded.keyIdMatched === true }),
      ...(store.lastElectronPath === undefined ? {} : { electron: { path: displayPath(store.lastElectronPath), source: loaded.electronSource } }),
    },
    account: {
      uidMasked: maskIdentifier(credential.uid),
      uinMasked: maskIdentifier(credential.uin),
      enterprise: credential.enterpriseId !== undefined,
      ...(credential.enterpriseId === undefined ? {} : { enterpriseIdMasked: maskIdentifier(credential.enterpriseId) }),
      nickname: null,
    },
    region: credential.domain === '' ? 'cn' : (credential.domain.endsWith('workbuddy.ai') ? 'global' : 'cn'),
    domain: credential.domain,
    session: {
      ...session,
      expiresAt: isoOrNull(credential.expiresAtMs),
      refreshExpiresAt: isoOrNull(credential.refreshExpiresAtMs),
      accessTokenMasked: maskSecret(credential.accessToken),
      refreshTokenMasked: maskSecret(credential.refreshToken),
    },
    billing,
    catalog: catalogSummary(catalog),
    reasonCodes,
  };
  return { ok: !sessionDead, secrets, document };
}

/**
 * Build the `doctor` document. By default this neither runs the key helper nor
 * opens a network connection; `--decrypt` and `--network` opt in.
 * @returns {Promise<{ document: object, ok: boolean, secrets: string[] }>}
 */
export async function buildDoctor(options) {
  const { variant } = options;
  const store = new CredentialStore({
    variant,
    authFile: options.authFile,
    electronPath: options.electronPath,
    env: options.env,
    ownDir: options.ownDir,
  });
  const secrets = options.secrets ?? [];
  const checks = [];
  const add = (id, status, detail, reasonCode) => {
    checks.push({ id, status, ...(detail === undefined ? {} : { detail }), ...(reasonCode === undefined ? {} : { reasonCode }) });
  };

  add('node', process.versions.node.startsWith('22.') || Number(process.versions.node.split('.')[0]) >= 24 ? 'pass' : 'warn', `node ${process.versions.node}`);
  add('variant', 'pass', `${variant.id} (${variant.displayName}, region ${variant.region})`);
  add('network', options.network ? 'pass' : 'skip', options.network ? 'enabled' : 'disabled (--no-network)', options.network ? undefined : REASON.networkDisabled);

  let desktop;
  try {
    desktop = await store.classifyDesktop();
  } catch (error) {
    add('desktop-auth-file', 'fail', describeError(error), reasonCodeOf(error) ?? REASON.credentialUnreadable);
  }
  if (desktop !== undefined) {
    if (desktop.path !== undefined) add('desktop-auth-file', desktop.format === 'absent' ? 'fail' : 'pass', displayPath(desktop.path), desktop.format === 'absent' ? REASON.credentialMissing : undefined);
    else add('desktop-auth-file', 'fail', 'no candidate path on this platform', REASON.credentialMissing);
    if (desktop.format === 'unrecognized') {
      add('document-format', 'fail', 'neither plaintext credential nor decodable envelope', REASON.credentialUnreadable);
    } else {
      add('document-format', desktop.format === 'absent' ? 'skip' : 'pass', desktop.format);
    }
    if (desktop.format === 'encrypted') {
      try {
        const binary = await store.keyProvider.binary();
        add('electron-binary', 'pass', `${displayPath(binary.path)} (${binary.source}); not run`);
      } catch (error) {
        add('electron-binary', 'fail', describeError(error), reasonCodeOf(error) ?? REASON.electronNotFound);
      }
    }
  }

  let loaded;
  if (options.decrypt) {
    try {
      loaded = await store.readDesktop();
      if (loaded === undefined) {
        add('credential', 'fail', 'no desktop credential to unwrap', REASON.credentialMissing);
      } else {
        secrets.push(loaded.credential.accessToken, loaded.credential.refreshToken, loaded.credential.uid, loaded.credential.uin);
        add('credential', 'pass', `${loaded.format}; unwrapped`, undefined);
      }
    } catch (error) {
      add('credential', 'fail', describeError(error), reasonCodeOf(error) ?? REASON.credentialUndecryptable);
    }
  } else {
    add('credential', 'skip', 'not unwrapped (pass --decrypt to run the key helper)');
  }

  if (loaded !== undefined) {
    const session = sessionState(loaded.credential);
    if (session.state === 'active' || session.state === 'unknown') add('session', 'pass', session.state);
    else if (session.state === 'refreshable') add('session', 'warn', 'access token expired; refresh token still valid', REASON.sessionDead);
    else add('session', 'fail', 'access and refresh tokens are expired; sign in again in the app', REASON.sessionDead);
  } else {
    add('session', 'skip', 'requires --decrypt');
  }

  if (options.network && loaded !== undefined) {
    try {
      const credits = await fetchCredits({ client: new UpstreamClient(), credential: loaded.credential });
      add('billing', 'pass', `${credits.total} credit across ${credits.packages.length} package(s)`, undefined);
    } catch (error) {
      add('billing', 'fail', describeError(error), reasonCodeOf(error) ?? REASON.billingUnreachable);
    }
  } else if (options.network) {
    add('billing', 'skip', 'requires --decrypt', REASON.credentialUndecryptable);
  } else {
    add('billing', 'skip', 'not contacted (--no-network)', REASON.networkDisabled);
  }

  const fails = checks.filter((check) => check.status === 'fail');
  const reasonCodes = [...new Set(fails.map((check) => check.reasonCode).filter((code) => code !== undefined))];
  const document = {
    schema: SCHEMA_VERSION,
    command: 'doctor',
    variant: variant.id,
    variantName: variant.displayName,
    generatedAt: new Date().toISOString(),
    network: options.network,
    decryptAttempted: options.decrypt === true,
    auth: {
      desktopPath: displayPath(store.desktopCandidates()[0]),
      ownCopyPath: displayPath(store.ownPath),
    },
    ok: fails.length === 0,
    checks,
    reasonCodes,
    ...(fails.length === 0 ? {} : { error: { reasonCode: reasonCodes[0] ?? REASON.credentialUnreadable, message: fails[0].detail } }),
  };
  return { document, ok: fails.length === 0, secrets };
}

function renderSessionHuman(session) {
  if (session.state === 'active') return `active, expires ${session.expiresAt} (in ${Math.floor(session.secondsRemaining / 3600)}h)`;
  if (session.state === 'refreshable') return `access token expired, refresh token still valid`;
  if (session.state === 'expired') return `expired; sign in again in the app`;
  return 'unknown';
}

function renderHuman(document) {
  const lines = [];
  if (document.command === 'install-provider' && document.ok === true && document.securityWarning) {
    // SF-1: the plaintext-secret warning is the first thing the user sees.
    lines.push(`!! ${document.securityWarning}`, '');
  }
  if (document.command === 'models') {
    lines.push(`pi-workbuddy-connect models ${document.action}`);
    lines.push(`policy: mode=${document.config.mode}${document.config.mode === 'allowlist' ? ` expose=${document.config.expose.join(', ')}` : ''}`);
    lines.push(`catalog: ${document.catalog.source} (${document.catalog.count} models)`);
    if (document.changed === false) lines.push(document.note ?? 'no change');
    else if (document.dryRun) lines.push('dry run: gateway.json and models.json were not written');
    else lines.push('wrote the policy to gateway.json');
    if (document.sync !== undefined) {
      if (document.sync.attempted === false) lines.push(`sync: ${document.sync.note}`);
      else if (document.sync.ok === true) lines.push(`sync: providers.${document.provider} ${document.sync.changed ? 'updated' : 'already matched'} (${document.sync.models} models, baseUrl ${document.sync.baseUrl})`);
      else lines.push(`sync: FAILED — ${document.sync.error.reasonCode}: ${document.sync.error.message}`);
    }
    lines.push(`redaction self-check: ${document.redactionSelfCheck?.ok === false ? 'FAILED' : 'ok'}`);
    return `${lines.join('\n')}\n`;
  }
  if (document.command === 'install-provider' || document.command === 'uninstall-provider') {
    lines.push(`pi-workbuddy-connect ${document.command}${document.variantName === undefined ? '' : ` — ${document.variantName} (${document.variant})`}`);
    if (document.ok === false) {
      lines.push(`models.json: ${document.modelsJson ?? '(unresolved)'}`);
      lines.push(`FAILED — ${document.error?.reasonCode ?? 'unknown'}${document.error?.message ? `: ${document.error.message}` : ''}`);
      lines.push(`redaction self-check: ${document.redactionSelfCheck?.ok === false ? 'FAILED' : 'ok'}`);
      return `${lines.join('\n')}\n`;
    }
    lines.push(`models.json: ${document.modelsJson}${document.modelsJsonExisted ? '' : ' (created)'}`);
  }
  if (document.command === 'install-provider') {
    lines.push(`provider: ${document.provider} → ${document.baseUrl} (port from ${document.portSource ?? 'default'})`);
    lines.push(`exposure: mode=${document.exposure?.mode ?? 'all'}${document.exposure?.mode === 'allowlist' ? ` (${document.exposure.expose.length} model(s))` : ''}`);
    lines.push(`api key: ${document.apiKey.style === 'literal' ? `literal (${document.apiKey.masked}), from ${document.apiKey.tokenSource}` : `$${document.apiKey.env} (from ${document.apiKey.tokenSource})`} — value never printed`);
    // S-2: the interpolation only works if the variable exists in the
    // environment that starts pi; say so in human output too, not only in --json.
    if (document.apiKey.note !== undefined) lines.push(`note: ${document.apiKey.note}`);
    lines.push(`catalog: ${document.catalog.source} (${document.catalog.count} models)${document.catalog.fetchedAt ? ` @ ${document.catalog.fetchedAt}` : ''}${document.catalog.note ? ` — ${document.catalog.note}` : ''}`);
    if (document.dryRun) lines.push('dry run: nothing was written, no backup was taken');
    else if (!document.changed) lines.push('already installed and up to date: the file was not written');
    else lines.push(`wrote 1 provider member${document.replaced ? ' (replaced)' : ''}; backup: ${document.backup ?? '(none needed)'}; write: ${document.write?.mode ?? 'atomic'}`);
    if (document.diff) lines.push('', document.diff.replace(/\n$/u, ''));
    for (const warning of document.warnings ?? []) lines.push(`warning: ${warning}`);
    lines.push(`redaction self-check: ${document.redactionSelfCheck?.ok === false ? 'FAILED' : 'ok'}`);
    return `${lines.join('\n')}\n`;
  }
  if (document.command === 'uninstall-provider') {
    lines.push(`provider: ${document.provider}`);
    if (document.dryRun) lines.push('dry run: nothing was written, no backup was taken');
    else if (!document.changed) lines.push(document.note ?? 'nothing to remove');
    else lines.push(`removed 1 provider member; backup: ${document.backup ?? '(none needed)'}; write: ${document.write?.mode ?? 'atomic'}`);
    if (document.diff) lines.push('', document.diff.replace(/\n$/u, ''));
    lines.push(`redaction self-check: ${document.redactionSelfCheck?.ok === false ? 'FAILED' : 'ok'}`);
    return `${lines.join('\n')}\n`;
  }
  if (document.command === 'serve') {
    lines.push(`pi-workbuddy-connect serve — ${document.variantName} (${document.variant}, region ${document.region})`);
    lines.push(`listening: ${document.url} (${document.bind ?? document.host} only)`);
    if (document.portFallback !== undefined) lines.push(`port: preferred ${document.portFallback.requested} was busy (${document.portFallback.source}); bound ${document.portFallback.actual}`);
    lines.push(`exposed models: ${document.modelsExposed?.mode === 'allowlist' ? `allowlist (${document.modelsExposed.allowlist.length})` : 'all'}`);
    lines.push(`bearer: ${document.token.source} — ${document.token.path} (value not printed)`);
    lines.push(`user-agent: ${document.userAgent} (app version ${document.appVersion.value}, ${document.appVersion.source})`);
    lines.push(`endpoint file: ${document.endpointFile}`);
    lines.push(`routes: /healthz (no bearer) · /v1/models · /v1/chat/completions · /v1/workbuddy/credits (non-standard)`);
    lines.push(`outbound: ${document.outbound.hosts.join(', ')} — telemetry ${document.outbound.telemetry}`);
    for (const warning of document.warnings ?? []) lines.push(`warning: ${warning}`);
    return `${lines.join('\n')}\n`;
  }
  if (document.command === 'status') {
    lines.push(`pi-workbuddy-connect status — ${document.variantName} (${document.variant})`);
    lines.push(`auth file: ${document.auth?.desktopPath ?? '(none)'}${document.auth?.format ? ` [${document.auth.format}]` : ''}`);
    if (document.ok !== true) {
      const reasonCode = document.error?.reasonCode ?? ((document.reasonCodes ?? []).join(', ') || 'unknown');
      lines.push(`status: FAILED — ${reasonCode}${document.error?.message ? `: ${document.error.message}` : ''}`);
    }
    if (document.account !== undefined) {
      lines.push(`credential: ${document.auth.source} — ${document.auth.decryptable === true ? 'decryptable' : 'plaintext'}${document.auth.keyIdMasked ? ` (keyId ${document.auth.keyIdMasked}, matched ${document.auth.keyIdMatched})` : ''}`);
      lines.push(`account: uid ${document.account.uidMasked ?? '-'} · uin ${document.account.uinMasked ?? '-'} · enterprise ${document.account.enterprise ? 'yes' : 'no'}`);
      lines.push(`region: ${document.region}${document.domain ? ` (${document.domain})` : ''}`);
      lines.push(`token: access ${document.session.accessTokenMasked ?? '-'} · refresh ${document.session.refreshTokenMasked ?? '-'}`);
      lines.push(`session: ${renderSessionHuman(document.session)}`);
      if (document.billing?.ok) {
        lines.push(`balance: ${document.billing.total} credit${document.billing.unlimited ? ' (unlimited)' : ''} across ${document.billing.packages.length} package(s)`);
        for (const pack of document.billing.packages) {
          lines.push(`  - ${pack.name}: ${pack.remain}${pack.size ? ` / ${pack.size}` : ''}${pack.endTime ? ` (ends ${pack.endTime})` : ''}`);
        }
      } else {
        lines.push(`balance: unavailable (${document.billing?.reason ?? 'unknown'})${document.billing?.message ? ` — ${document.billing.message}` : ''}`);
      }
      lines.push(`catalog: ${document.catalog.source} (${document.catalog.count} models)${document.catalog.note ? ` — ${document.catalog.note}` : ''}`);
    }
  } else {
    lines.push(`pi-workbuddy-connect doctor — ${document.variantName} (${document.variant})`);
    for (const check of document.checks) {
      lines.push(`  [${check.status}] ${check.id}${check.reasonCode ? ` (${check.reasonCode})` : ''}${check.detail ? `: ${check.detail}` : ''}`);
    }
    lines.push(document.ok ? 'doctor: OK' : `doctor: FAILED — ${document.reasonCodes.join(', ') || 'unknown'}`);
  }
  lines.push(`redaction self-check: ${document.redactionSelfCheck?.ok === false ? 'FAILED' : 'ok'}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Resolve the persisted exposure policy and preferred port for the commands
 * that need them. `--models` is a process-only override; otherwise the `models`
 * field of gateway.json is the single source of truth.
 */
function applyGatewayConfig(options) {
  const ownDir = ensureOwnDir(options.ownDir);
  const gatewayConfig = readGatewayConfig(ownDir);
  options.gatewayConfig = gatewayConfig;
  options.modelsFilter = options.modelsFlag === undefined
    ? normalizeModelsConfig(gatewayConfig.models)
    : normalizeModelsConfig({ mode: 'allowlist', expose: options.modelsFlag });
  // An explicit `--models` list is validated against the saved roster when there
  // is one; with only the built-in placeholder we cannot know the real roster, so
  // it is left to the live catalog at request time.
  if (options.modelsFlag !== undefined) {
    const saved = loadSavedCatalog(join(ownDir, options.variant.catalogFilename));
    if (saved !== undefined) {
      const { invalid, available } = validateModelIds(options.modelsFlag, saved.models);
      if (invalid.length > 0) {
        throw new WbError(REASON.modelUnknown, `--models names unknown model(s) ${invalid.map((id) => JSON.stringify(id)).join(', ')}; candidates: ${available.join(', ')}`);
      }
    }
  }
  if (options.port === undefined) {
    if (gatewayConfig.port !== undefined) {
      options.port = parsePort(gatewayConfig.port, 'gateway.json port');
      options.portSource = 'config';
    } else {
      options.port = DEFAULT_PORT;
      options.portSource = 'default';
    }
  }
  return options;
}

/**
 * After the policy changes, keep the installed provider in step. Chosen
 * behaviour (documented in README): auto-sync when `providers.workbuddy` is
 * already installed; otherwise say so instead of silently doing nothing.
 */
async function syncInstalledProvider(options, nextConfig, catalog, secrets) {
  const env = options.env ?? process.env;
  const path = resolveModelsJsonPath({ modelsJsonPath: options.modelsJsonPath, env });
  if (!existsSync(path)) {
    return { attempted: false, installed: false, note: `no models.json at ${displayPath(path)}; run install-provider when you want pi to see these models` };
  }
  let parsed;
  try {
    parsed = JSON.parse(stripBom(readFileSync(path, 'utf8')));
  } catch {
    return { attempted: false, installed: false, note: 'models.json could not be parsed; run install-provider to re-check it' };
  }
  if (parsed?.providers?.[PROVIDER_KEY] === undefined) {
    return { attempted: false, installed: false, note: 'providers.workbuddy is not installed; run install-provider to apply the policy' };
  }
  try {
    const built = await installProvider({ ...options, modelsFilter: nextConfig, secrets }, { catalog });
    return {
      attempted: true,
      installed: true,
      ok: true,
      changed: built.document.changed,
      baseUrl: built.document.baseUrl,
      models: built.document.modelRefs.length,
      backup: built.document.backup,
    };
  } catch (error) {
    return {
      attempted: true,
      installed: true,
      ok: false,
      error: { reasonCode: reasonCodeOf(error) ?? 'unexpected-error', message: describeError(error) },
    };
  }
}

const MODELS_ACTIONS = new Set(['list', 'set', 'add', 'remove', 'all']);

/** `models` — read and edit the exposure policy in gateway.json. */
async function runModels(options, { out, err }) {
  const action = options.modelsAction ?? 'list';
  if (!MODELS_ACTIONS.has(action)) {
    err.write(`unknown models action ${JSON.stringify(action)}\n\n${USAGE}`);
    return 2;
  }
  const ownDir = ensureOwnDir(options.ownDir);
  const secrets = options.secrets ?? [];
  options.secrets = secrets;
  try {
    const config = readModelsConfig(ownDir);
    const catalog = await resolveCatalog({ savedPath: join(ownDir, options.variant.catalogFilename), network: false });
    const catalogModels = Array.isArray(catalog.models) ? catalog.models : [];
    const available = catalogModels.map((model) => canonicalModelId(model.id));
    const document = {
      schema: SCHEMA_VERSION,
      command: 'models',
      action,
      generatedAt: new Date().toISOString(),
      ok: true,
      provider: PROVIDER_KEY,
      variant: options.variant.id,
      previous: config,
      config,
      changed: false,
      dryRun: options.dryRun === true,
      catalog: { source: catalog.source, count: available.length, models: available },
    };

    let next = config;
    if (action === 'all') {
      next = { mode: 'all', expose: [] };
    } else if (action !== 'list') {
      if (options.modelsIds.length === 0) {
        throw new WbError(REASON.invalidRequest, `\`models ${action}\` needs at least one model id (known: ${available.join(', ')})`);
      }
      const { valid, invalid, available: candidates } = validateModelIds(options.modelsIds, catalogModels);
      if (invalid.length > 0) {
        throw new WbError(REASON.modelUnknown, `unknown model id(s) ${invalid.map((id) => JSON.stringify(id)).join(', ')}; candidates: ${candidates.join(', ')}`);
      }
      const base = action === 'set' ? [] : (config.mode === 'allowlist' ? config.expose : available);
      let expose = [...base];
      if (action === 'remove') expose = expose.filter((id) => !valid.includes(id));
      else for (const id of valid) if (!expose.includes(id)) expose.push(id);
      next = normalizeModelsConfig({ mode: 'allowlist', expose });
    }
    document.changed = !jsonEqual(config, next);
    document.config = next;

    if (document.changed && !document.dryRun) {
      await writeModelsConfig(ownDir, next);
      document.written = true;
      document.sync = await syncInstalledProvider(options, next, catalog, secrets);
    } else if (document.changed) {
      document.note = 'dry run: gateway.json and models.json were not written';
    } else {
      document.note = `the policy already is mode=${next.mode}${next.mode === 'allowlist' ? ` expose=${next.expose.join(',')}` : ''}; nothing was written`;
    }

    const { text, ok } = finalizeDocument(document, secrets, options.json);
    out.write(text);
    // S-1: the policy was written, but if the installed provider could not be
    // brought in step, the run is not a success; exit non-zero instead of
    // leaving a green exit code on a `sync: FAILED` line.
    return ok && document.sync?.ok !== false ? 0 : 1;
  } catch (error) {
    const reasonCode = reasonCodeOf(error) ?? 'unexpected-error';
    const document = {
      schema: SCHEMA_VERSION,
      command: 'models',
      action,
      ok: false,
      error: { reasonCode, message: describeError(error) },
    };
    const { text } = finalizeDocument(document, secrets, options.json);
    out.write(text);
    return 1;
  }
}

/** Run the gateway until a termination signal arrives. */
export async function runServe(options, { out = process.stdout, err = process.stderr, env = process.env, start = startServe, home } = {}) {
  if (options.network === false) {
    err.write('serve needs upstream access: drop --no-network\n');
    return 2;
  }
  const logger = {
    info: (message) => out.write(`${message}\n`),
    warn: (message) => err.write(`warning: ${message}\n`),
    error: (message) => err.write(`error: ${message}\n`),
  };
  let serving;
  try {
    serving = await start(options, { out, logger, home, env });
  } catch (error) {
    err.write(`could not start the gateway: ${describeError(error)}\n`);
    return 1;
  }
  const { text } = finalizeDocument(serving.document, [], options.json);
  out.write(text);
  out.write(`${SERVE_STOP_HINT}\n`);
  await new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await serving.close();
  out.write('gateway stopped\n');
  return 0;
}

/** Run the CLI; returns the process exit code. */
export async function runCli(argv, { out = process.stdout, err = process.stderr, env = process.env, builders } = {}) {
  const parsed = parseArgs(argv);
  if (parsed.error !== undefined) {
    err.write(`${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.flags.help === true || parsed.command === undefined) {
    out.write(USAGE);
    return parsed.command === undefined && parsed.flags.help !== true ? 2 : 0;
  }
  if (parsed.flags.version === true) {
    out.write('0.1.0\n');
    return 0;
  }

  let options;
  try {
    options = resolveOptions(parsed.flags, env);
  } catch (error) {
    err.write(`${describeError(error)}\n`);
    return 2;
  }

  if (parsed.command === 'models') {
    try {
      applyGatewayConfig(options);
    } catch (error) {
      const document = { schema: SCHEMA_VERSION, command: 'models', action: parsed.flags.modelsAction ?? 'list', ok: false, error: { reasonCode: reasonCodeOf(error) ?? 'unexpected-error', message: describeError(error) } };
      const { text } = finalizeDocument(document, [], options.json);
      out.write(text);
      return 1;
    }
    return await runModels(options, { out, err });
  }

  if (parsed.command === 'serve') {
    try {
      applyGatewayConfig(options);
    } catch (error) {
      err.write(`${describeError(error)}\n`);
      return 2;
    }
    return await runServe(options, { out, err, env });
  }

  if (parsed.command === 'install-provider' || parsed.command === 'uninstall-provider') {
    const secrets = [];
    options.secrets = secrets;
    try {
      if (parsed.command === 'install-provider') applyGatewayConfig(options);
      const built = parsed.command === 'install-provider'
        ? await installProvider(options)
        : await uninstallProvider(options);
      const { text, ok } = finalizeDocument(built.document, secrets, options.json);
      out.write(text);
      return ok ? 0 : 1;
    } catch (error) {
      const reasonCode = reasonCodeOf(error) ?? 'unexpected-error';
      const document = {
        schema: SCHEMA_VERSION,
        command: parsed.command,
        ok: false,
        error: { reasonCode, message: describeError(error) },
      };
      const { text } = finalizeDocument(document, secrets, options.json);
      out.write(text);
      return 1;
    }
  }

  // Shared with buildStatus/buildDoctor so the catch below can self-check the
  // output against secrets collected before the failure (SF-2).
  const secrets = [];
  options.secrets = secrets;
  try {
    const statusBuilder = builders?.status ?? buildStatus;
    const doctorBuilder = builders?.doctor ?? buildDoctor;
    const built = parsed.command === 'status' ? await statusBuilder(options) : await doctorBuilder(options);
    const { text, ok } = finalizeDocument(built.document, built.secrets, options.json);
    out.write(text);
    if (!ok) return 1;
    return built.ok ? 0 : 1;
  } catch (error) {
    const reasonCode = reasonCodeOf(error) ?? 'unexpected-error';
    const document = {
      schema: SCHEMA_VERSION,
      command: parsed.command,
      ok: false,
      error: { reasonCode, message: describeError(error) },
    };
    const { text } = finalizeDocument(document, secrets, options.json);
    out.write(text);
    return 1;
  }
}
