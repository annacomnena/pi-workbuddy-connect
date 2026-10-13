// The gateway's own material: the bearer secret, and the endpoint announcement.
//
// The secret is generated fresh with `randomBytes(32)` and stored in this
// project's own directory so the same client can reconnect after a restart. The
// environment variable wins over the file, so a user who prefers an ephemeral
// (or externally managed) secret can have one. The value is never logged and
// never written into `endpoint.json`.

import { createHash, randomBytes } from 'node:crypto';
import { get as httpGet } from 'node:http';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ensureOwnDir } from '../paths.js';
import { REASON, WbError } from '../errors.js';

export const TOKEN_ENV = 'WORKBUDDY_GATEWAY_TOKEN';
export const PORT_ENV = 'WORKBUDDY_GATEWAY_PORT';
export const GATEWAY_CONFIG_FILENAME = 'gateway.json';
export const ENDPOINT_FILENAME = 'endpoint.json';
// A deliberately uncommon first choice. The real machine has EasyCLIProxyAPI on
// 8317, so 8317 is *not* this project's port: it is only a candidate, and the
// server falls back to an OS-chosen free port when it is taken.
export const DEFAULT_PORT = 8799;
export const MIN_TOKEN_LENGTH = 16;

/** The path of this project's `gateway.json`. */
export function gatewayConfigPath(dir) {
  return join(dir, GATEWAY_CONFIG_FILENAME);
}

/**
 * Read `gateway.json` as an object. A missing file is an empty config; a
 * present-but-corrupt one is reported by name (never silently replaced).
 */
export function readGatewayConfig(dir) {
  let text;
  try {
    text = readFileSync(gatewayConfigPath(dir), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new WbError(REASON.modelsConfigUnreadable, `the gateway config at ${GATEWAY_CONFIG_FILENAME} could not be read (${error?.code ?? 'error'})`);
  }
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('the top level is not a JSON object');
    return parsed;
  } catch (error) {
    throw new WbError(REASON.modelsConfigUnreadable, `the gateway config at ${GATEWAY_CONFIG_FILENAME} is not plain JSON: ${error.message}`);
  }
}

/** sha256 of a file as bytes, or null when it does not exist. */
function fileSha256(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Merge `patch` into `gateway.json`, preserving every unrelated field (the
 * token, the note, a user-set port, ...). Written 0600.
 *
 * S-5: read-merge-write loses an update if another process edits the file in
 * the window (a hand edit racing `models set`). Like models.json's SF-2 guard,
 * the bytes read are snapshotted and re-checked before the write; a mismatch
 * fails closed instead of clobbering the other edit.
 *
 * @param {string} dir this project's own directory
 * @param {object} patch fields to merge in
 * @param {{ beforeWrite?: (path: string) => void | Promise<void> }} [deps] test seam
 */
export async function writeGatewayConfig(dir, patch, deps = {}) {
  const path = gatewayConfigPath(dir);
  const current = readGatewayConfig(dir);
  const beforeSha = fileSha256(path);
  const next = { ...current, ...patch };
  if (deps.beforeWrite !== undefined) await deps.beforeWrite(path);
  if (fileSha256(path) !== beforeSha) {
    throw new WbError(
      REASON.gatewayConfigChanged,
      `the gateway config at ${GATEWAY_CONFIG_FILENAME} changed after it was read (another process edited it); nothing was written, re-run to retry`,
    );
  }
  ensureOwnDir(dir);
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

/** The secret from the environment, or undefined when unset/unusable. */
export function tokenFromEnv(env = process.env) {
  const value = typeof env[TOKEN_ENV] === 'string' ? env[TOKEN_ENV].trim() : '';
  if (value === '') return undefined;
  if (value.length < MIN_TOKEN_LENGTH) {
    throw new Error(`${TOKEN_ENV} must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  return value;
}

/**
 * Load the gateway secret, creating and persisting one on first use.
 * @returns {{ token: string, source: 'env'|'config'|'generated', path: string }}
 */
export function loadOrCreateToken(dir, env = process.env) {
  const fromEnv = tokenFromEnv(env);
  const configPath = gatewayConfigPath(dir);
  if (fromEnv !== undefined) return { token: fromEnv, source: 'env', path: configPath };
  let parsed;
  try {
    parsed = readGatewayConfig(dir);
  } catch (error) {
    // A present-but-corrupt config must not be silently replaced: the client
    // holding the old secret would start failing with 401 that looks like a bug.
    throw new Error(`the gateway config at ${GATEWAY_CONFIG_FILENAME} could not be read (${error?.code ?? 'error'})`);
  }
  if (typeof parsed?.token === 'string' && parsed.token.length >= MIN_TOKEN_LENGTH) {
    return { token: parsed.token, source: 'config', path: configPath };
  }
  const token = randomBytes(32).toString('base64url');
  ensureOwnDir(dir);
  // Merge instead of overwriting: a `models` policy (or a user-set `port`)
  // written before the first `serve` must survive token creation.
  writeFileSync(configPath, `${JSON.stringify({
    ...parsed,
    version: typeof parsed.version === 'number' ? parsed.version : 1,
    token,
    createdAt: new Date().toISOString(),
    note: 'Bearer secret for the loopback gateway. Override with WORKBUDDY_GATEWAY_TOKEN.',
  }, null, 2)}\n`, { mode: 0o600 });
  return { token, source: 'generated', path: configPath };
}

/** A value-free description of where the secret came from. */
export function describeTokenSource(source) {
  if (source === 'env') return `environment (${TOKEN_ENV})`;
  if (source === 'config') return `this project's config file (${GATEWAY_CONFIG_FILENAME})`;
  return `newly generated and stored in ${GATEWAY_CONFIG_FILENAME}`;
}

/**
 * Announce the listening endpoint in this project's own directory. The document
 * never contains the secret, only its provenance.
 */
export function writeEndpointFile(dir, info) {
  ensureOwnDir(dir);
  const file = join(dir, ENDPOINT_FILENAME);
  writeFileSync(file, `${JSON.stringify({
    version: 1,
    url: `http://127.0.0.1:${info.port}`,
    baseUrl: `http://127.0.0.1:${info.port}/v1`,
    host: '127.0.0.1',
    port: info.port,
    variants: info.variants ?? [info.variant],
    pid: info.pid ?? process.pid,
    startedAt: info.startedAt ?? new Date().toISOString(),
    tokenSource: info.tokenSource,
    security: {
      bind: '127.0.0.1 only',
      fileMode: info.plat === 'win32'
        ? '0600 requested; on Windows this is only as private as the inherited NTFS ACL for the user profile'
        : '0600',
    },
    nonStandard: ['GET /v1/workbuddy/credits'],
  }, null, 2)}\n`, { mode: 0o600 });
  return file;
}

/** Remove the endpoint announcement (graceful shutdown). */
export function removeEndpointFile(dir) {
  rmSync(join(dir, ENDPOINT_FILENAME), { force: true });
}

/** Is a local process with this pid still running? */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error?.code === 'EPERM';
  }
}

/**
 * Read the endpoint announcement. Returns undefined when there is none, and an
 * object carrying `alive` (whether the recorded pid is still running) so a
 * caller can decide whether to trust a stale port.
 *
 * `alive` is deliberately weak: `process.kill(pid, 0)` only says *a* process
 * with that pid exists, and pids are recycled (S-6). A caller that will act on
 * the port must additionally confirm the port is still answered by this
 * service -- see `verifyEndpointIdentity`, used by `install-provider`.
 */
export function readEndpointInfo(dir, { isAlive = processAlive } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(dir, ENDPOINT_FILENAME), 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  return {
    port: typeof parsed.port === 'number' ? parsed.port : undefined,
    url: typeof parsed.url === 'string' ? parsed.url : undefined,
    baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : undefined,
    pid: typeof parsed.pid === 'number' ? parsed.pid : undefined,
    alive: typeof parsed.pid === 'number' ? isAlive(parsed.pid) : undefined,
  };
}

/**
 * Confirm that the port named by an `endpoint.json` announcement is still served
 * by this gateway (S-6). `process.kill(pid, 0)` cannot tell our own process from
 * an unrelated one that inherited a recycled pid, so the port itself is asked:
 * only pi-workbuddy-connect answers `/healthz` with the expected `service`.
 *
 * Loopback only, no credential, no upstream traffic. Any error, timeout or
 * unexpected answer is `false` (fail closed: the caller then falls back).
 *
 * @param {{ port?: number }} endpoint
 * @param {{ service?: string, timeoutMs?: number, request?: Function }} [options]
 */
export function verifyEndpointIdentity(endpoint, { service = 'pi-workbuddy-connect', timeoutMs = 500, request } = {}) {
  const port = endpoint?.port;
  if (typeof port !== 'number' || port <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const send = request ?? httpGet;
    let req;
    try {
      req = send({ host: '127.0.0.1', port, path: '/healthz', timeout: timeoutMs }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            done(JSON.parse(Buffer.concat(chunks).toString('utf8'))?.service === service);
          } catch {
            done(false);
          }
        });
      });
    } catch {
      done(false);
      return;
    }
    req.on('timeout', () => { req.destroy(); done(false); });
    req.on('error', () => done(false));
  });
}

/**
 * Remove an `endpoint.json` left behind by a process that is no longer running
 * (a hard kill never runs the graceful shutdown). A stale announcement points
 * clients at a dead port. Returns true when a file was removed.
 */
export function removeStaleEndpointFile(dir, { isAlive = processAlive } = {}) {
  const file = join(dir, ENDPOINT_FILENAME);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    // An unreadable or malformed announcement cannot be trusted; drop it.
    rmSync(file, { force: true });
    return true;
  }
  if (typeof parsed?.pid === 'number' && isAlive(parsed.pid)) return false;
  rmSync(file, { force: true });
  return true;
}
