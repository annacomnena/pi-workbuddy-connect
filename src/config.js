// Runtime configuration: CLI flags over environment over defaults.
// Nothing here ever writes to the desktop app.

import { ownStateDir } from './paths.js';
import { variantFor } from './variant.js';
import { DEFAULT_PORT, PORT_ENV } from './gateway/secret.js';

/** Validate a port number. 0 means "let the OS choose" (used by tests). */
export function parsePort(value, source) {
  const number = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isInteger(number) || number < 0 || number > 65535) {
    throw new Error(`${source} must be an integer between 0 and 65535`);
  }
  return number;
}

/**
 * Turn parsed flags into the runtime options every command uses.
 * @param {{ variant?: string, authFile?: string, electron?: string, noNetwork?: boolean,
 *   json?: boolean, catalog?: boolean, decrypt?: boolean, port?: string|number }} flags
 */
export function resolveOptions(flags, env = process.env) {
  const variant = variantFor(flags.variant);
  const port = flags.port === undefined
    ? parsePort(env[PORT_ENV] ?? DEFAULT_PORT, PORT_ENV)
    : parsePort(flags.port, '--port');
  return {
    variant,
    authFile: flags.authFile,
    electronPath: flags.electron,
    network: flags.noNetwork !== true,
    json: flags.json === true,
    refreshCatalog: flags.catalog === true,
    decrypt: flags.decrypt === true,
    port,
    ownDir: ownStateDir(env),
    env,
  };
}
