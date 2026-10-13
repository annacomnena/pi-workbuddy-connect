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
 *
 * `port` is left undefined when neither `--port` nor the environment names one:
 * the caller then resolves it from `gateway.json` (and, for install, the live
 * `endpoint.json`) before falling back to {@link DEFAULT_PORT}. `portExplicit`
 * records whether the user asked for a specific port, which decides whether a
 * busy port may fall back to an OS-chosen one.
 *
 * @param {{ variant?: string, authFile?: string, electron?: string, noNetwork?: boolean,
 *   json?: boolean, catalog?: boolean, decrypt?: boolean, port?: string|number,
 *   dryRun?: boolean, apiKeyEnv?: string, modelsJson?: string, models?: string,
 *   modelsAction?: string, modelsIds?: string[] }} flags
 */
export function resolveOptions(flags, env = process.env) {
  const variant = variantFor(flags.variant);
  const fromEnv = env[PORT_ENV] === undefined ? undefined : parsePort(env[PORT_ENV], PORT_ENV);
  const port = flags.port === undefined ? fromEnv : parsePort(flags.port, '--port');
  const portSource = flags.port !== undefined ? 'flag' : (fromEnv === undefined ? undefined : 'env');
  return {
    variant,
    authFile: flags.authFile,
    electronPath: flags.electron,
    network: flags.noNetwork !== true,
    json: flags.json === true,
    refreshCatalog: flags.catalog === true,
    decrypt: flags.decrypt === true,
    port,
    portSource,
    portExplicit: flags.port !== undefined,
    // `install-provider` / `uninstall-provider` (S2). `--dry-run` never writes and
    // never takes a backup; `--api-key-env` swaps the literal gateway secret for an
    // environment interpolation; `--models-json` exists for tests and non-default
    // agent directories.
    dryRun: flags.dryRun === true,
    apiKeyEnv: flags.apiKeyEnv,
    modelsJsonPath: flags.modelsJson,
    // Model-exposure policy (S2.1). `--models a,b` is a process-only override for
    // `serve` / `install-provider`; the `models` command uses `modelsAction` and
    // `modelsIds` to edit the persisted policy in gateway.json.
    modelsFlag: flags.models === undefined ? undefined : parseModelList(flags.models),
    modelsAction: flags.modelsAction,
    modelsIds: flags.modelsIds ?? [],
    ownDir: ownStateDir(env),
    env,
  };
}

/** Parse a comma- or space-separated `--models` list into bare ids. */
export function parseModelList(value) {
  return String(value ?? '')
    .split(/[,\s]+/u)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}
