// Runtime configuration: CLI flags over environment over defaults.
// Nothing here ever writes to the desktop app.

import { ownStateDir } from './paths.js';
import { variantFor } from './variant.js';

/**
 * Turn parsed flags into the runtime options every command uses.
 * @param {{ variant?: string, authFile?: string, electron?: string, noNetwork?: boolean,
 *   json?: boolean, catalog?: boolean, decrypt?: boolean }} flags
 */
export function resolveOptions(flags, env = process.env) {
  const variant = variantFor(flags.variant);
  return {
    variant,
    authFile: flags.authFile,
    electronPath: flags.electron,
    network: flags.noNetwork !== true,
    json: flags.json === true,
    refreshCatalog: flags.catalog === true,
    decrypt: flags.decrypt === true,
    ownDir: ownStateDir(env),
    env,
  };
}
