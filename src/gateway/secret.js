// The gateway's own material: the bearer secret, and the endpoint announcement.
//
// The secret is generated fresh with `randomBytes(32)` and stored in this
// project's own directory so the same client can reconnect after a restart. The
// environment variable wins over the file, so a user who prefers an ephemeral
// (or externally managed) secret can have one. The value is never logged and
// never written into `endpoint.json`.

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ensureOwnDir } from '../paths.js';

export const TOKEN_ENV = 'WORKBUDDY_GATEWAY_TOKEN';
export const PORT_ENV = 'WORKBUDDY_GATEWAY_PORT';
export const GATEWAY_CONFIG_FILENAME = 'gateway.json';
export const ENDPOINT_FILENAME = 'endpoint.json';
export const DEFAULT_PORT = 8317;
export const MIN_TOKEN_LENGTH = 16;

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
  const configPath = join(dir, GATEWAY_CONFIG_FILENAME);
  if (fromEnv !== undefined) return { token: fromEnv, source: 'env', path: configPath };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      // A present-but-corrupt config must not be silently replaced: the client
      // holding the old secret would start failing with 401 that looks like a bug.
      throw new Error(`the gateway config at ${GATEWAY_CONFIG_FILENAME} could not be read (${error?.code ?? 'error'})`);
    }
  }
  if (typeof parsed?.token === 'string' && parsed.token.length >= MIN_TOKEN_LENGTH) {
    return { token: parsed.token, source: 'config', path: configPath };
  }
  const token = randomBytes(32).toString('base64url');
  ensureOwnDir(dir);
  writeFileSync(configPath, `${JSON.stringify({
    version: 1,
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
