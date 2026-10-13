// The project-owned credential copy.
//
// Refreshed tokens are written here (never back to the desktop file). Since S1
// the copy is **sealed by default** (SF-6): the storage format records which
// protection was used, and a sealed copy whose key cannot be produced is
// reported as unreadable rather than silently treated as absent.
//
// On POSIX platforms the file is chmod 0600 and its directory 0700. On Windows
// there is no POSIX mode: `chmod` is a no-op and the copy is only as private as
// the user profile's inherited NTFS ACLs. The tool does not claim 0600 there;
// it says "inherited ACL". See docs/security.md.

import { readFileSync, writeFileSync, rmSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ensureOwnDir, ownStateDir } from '../paths.js';
import { REASON, WbError } from '../errors.js';
import { readOwnDocument, normalizeOwnCredential, serializeOwn, serializeOwnSealed } from './document.js';
import { openCredential } from './protection.js';

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** Read the project-owned copy's envelope; undefined when absent. */
export function readOwnRecord(filePath) {
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
  const record = readOwnDocument(text);
  if (record === undefined) {
    throw new WbError(
      REASON.credentialUnreadable,
      'the project\'s own credential copy is present but not in a recognised format',
    );
  }
  return record;
}

/** Write raw text with owner-only permissions, creating the directory first. */
export function writeOwnText(filePath, text, { plat = process.platform } = {}) {
  ensureOwnDir(join(filePath, '..'));
  writeFileSync(filePath, text, { mode: FILE_MODE });
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

/**
 * Write the credential to the project-owned copy.
 *
 * @param {string} filePath
 * @param {object} credential normalised credential
 * @param {{ protector?: { seal: (text: string) => Promise<{ sealed?: object, keySource: string,
 *   degraded?: object }> } }} [options]
 * @returns {Promise<{ path: string, keySource: string, degraded?: object }>}
 */
export async function writeOwn(filePath, credential, { protector } = {}) {
  const text = `${JSON.stringify(credential, null, 2)}\n`;
  if (protector === undefined) {
    writeOwnText(filePath, serializeOwn(credential, 'none'));
    return { path: filePath, keySource: 'none', degraded: { reason: 'no-protector' } };
  }
  const outcome = await protector.seal(text);
  const serialized = outcome.sealed === undefined
    ? serializeOwn(credential, outcome.keySource)
    : serializeOwnSealed(outcome.sealed, outcome.keySource);
  writeOwnText(filePath, serialized);
  return { path: filePath, keySource: outcome.keySource, ...(outcome.degraded === undefined ? {} : { degraded: outcome.degraded }) };
}

/**
 * Read the project-owned copy, opening it when it is sealed.
 *
 * @param {string} filePath
 * @param {{ openKey?: (record: object) => Promise<Buffer|undefined>, protector?: object }} [options]
 * @returns {Promise<{ credential: object, protection: string, keySource: string, legacy?: boolean } | undefined>}
 */
export async function readOwn(filePath, { openKey } = {}) {
  const record = readOwnRecord(filePath);
  if (record === undefined) return undefined;
  if (record.legacy === true) {
    const credential = normalizeOwnCredential(record.credential);
    if (credential === undefined) {
      throw new WbError(REASON.credentialUnreadable, 'the legacy project copy carries no access token');
    }
    return { credential, protection: 'plaintext', keySource: 'none', legacy: true };
  }
  if (record.protection === 'plaintext') {
    const credential = normalizeOwnCredential(record.credential);
    if (credential === undefined) {
      throw new WbError(REASON.credentialUnreadable, 'the project copy carries no access token');
    }
    return { credential, protection: 'plaintext', keySource: record.keySource };
  }
  // Sealed: the key must be producible. "Cannot open" is not "no copy".
  const key = openKey === undefined ? undefined : await openKey(record);
  if (key === undefined) {
    throw new WbError(
      REASON.credentialUndecryptable,
      `the project's own credential copy is sealed with ${record.keySource} and that key is unavailable; delete the copy or sign in again in the desktop app`,
      { detail: { protection: record.protection, keySource: record.keySource, keyId: record.keyId } },
    );
  }
  const text = openCredential(record.sealed, key);
  if (text === undefined) {
    throw new WbError(
      REASON.credentialUndecryptable,
      'the project\'s own credential copy could not be unsealed (wrong key or damaged blob)',
      { detail: { keySource: record.keySource, keyId: record.keyId } },
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WbError(REASON.credentialUnreadable, 'the unsealed project copy is not valid JSON');
  }
  const credential = normalizeOwnCredential(parsed);
  if (credential === undefined) {
    throw new WbError(REASON.credentialUnreadable, 'the unsealed project copy carries no access token');
  }
  return { credential, protection: record.protection, keySource: record.keySource };
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
