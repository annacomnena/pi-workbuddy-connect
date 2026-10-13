// The project-owned credential copy.
//
// Refreshed tokens are written here (never back to the desktop file). On POSIX
// platforms the file is chmod 0600 and its directory 0700. On Windows there is
// no POSIX mode: `chmod` is a no-op and the copy is only as private as the user
// profile's inherited NTFS ACLs -- the tool does not claim 0600 there, and does
// not store more than the credential itself.

import { readFileSync, writeFileSync, rmSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ensureOwnDir, ownStateDir } from '../paths.js';
import { REASON, WbError } from '../errors.js';
import { parseOwnDocument, serializeOwn } from './document.js';

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** Read the project-owned copy; undefined when absent, a tagged error otherwise. */
export function readOwn(filePath) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    // A present-but-unreadable copy is a distinct state, never "no copy".
    throw new WbError(
      REASON.credentialUnreadable,
      `the project's own credential copy could not be read (${error?.code ?? 'error'})`,
      { cause: error },
    );
  }
  return parseOwnDocument(text);
}

/**
 * Write the project-owned copy atomically enough for this use: create the
 * directory, write, then tighten permissions. Credential material never
 * reaches a temp file that outlives the call.
 */
export function writeOwn(filePath, credential, { plat = process.platform } = {}) {
  ensureOwnDir(join(filePath, '..'));
  writeFileSync(filePath, serializeOwn(credential), { mode: FILE_MODE });
  if (plat !== 'win32') {
    try {
      chmodSync(filePath, FILE_MODE);
      chmodSync(join(filePath, '..'), DIR_MODE);
    } catch {
      /* best-effort; the mode option above already applied on create */
    }
  }
  return filePath;
}

/** Remove the project-owned copy (logout). The desktop file is untouched. */
export function removeOwn(filePath) {
  rmSync(filePath, { force: true });
  rmSync(`${filePath}.lock`, { force: true });
}

/** The file's permission bits as an octal string, for diagnostics. */
export function ownFileMode(filePath) {
  try {
    return (statSync(filePath).mode & 0o777).toString(8);
  } catch {
    return undefined;
  }
}

export { ownStateDir };
