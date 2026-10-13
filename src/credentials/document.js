// Credential document parsing.
//
// Two on-disk shapes are accepted: the nested desktop form
// `{ auth: {...}, account: {...} }` and the flat form where the credential
// fields sit at the top level. A document with no access token yields nothing.

/** A normalised credential. Values stay in memory; callers mask before printing. */
/**
 * @typedef {object} Credential
 * @property {string} accessToken
 * @property {string} refreshToken
 * @property {number} expiresAtMs
 * @property {number|undefined} refreshExpiresAtMs
 * @property {string} domain
 * @property {string} uid
 * @property {string} uin
 * @property {string|undefined} enterpriseId
 * @property {string|undefined} nickname
 * @property {'desktop'|'own-copy'} source
 */

/** Normalise an expiry that may arrive in seconds or milliseconds. */
export function expiryToMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return value > 100_000_000_000 ? value : value * 1000;
}

function optionalString(value) {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Parse an auth document (already unwrapped, if it was encrypted).
 * @returns {Credential | undefined}
 */
export function parseAuthDocument(document, source = 'desktop') {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return undefined;
  const nested = typeof document.auth === 'object' && document.auth !== null;
  const auth = nested ? document.auth : document;
  const identity = nested && typeof document.account === 'object' && document.account !== null
    ? document.account
    : document;
  const accessToken = typeof auth.accessToken === 'string' ? auth.accessToken : '';
  if (accessToken === '') return undefined;
  const refreshExpiresAtMs = typeof auth.refreshExpiresAt === 'number' ? expiryToMs(auth.refreshExpiresAt) : undefined;
  const enterpriseId = optionalString(identity.enterpriseId);
  const nickname = optionalString(identity.nickname);
  return {
    accessToken,
    refreshToken: typeof auth.refreshToken === 'string' ? auth.refreshToken : '',
    expiresAtMs: typeof auth.expiresAt === 'number' ? expiryToMs(auth.expiresAt) : 0,
    ...(refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs }),
    domain: optionalString(auth.domain) ?? '',
    uid: optionalString(identity.uid) ?? '',
    uin: optionalString(identity.uin) ?? '',
    ...(enterpriseId === undefined ? {} : { enterpriseId }),
    ...(nickname === undefined ? {} : { nickname }),
    source,
  };
}

/** Parse credential text in either on-disk shape. */
export function parseAuthText(text, source = 'desktop') {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return parseAuthDocument(parsed, source);
}

export const OWN_FORMAT_VERSION = 2;
export const OWN_LEGACY_VERSION = 1;

/** Serialize a plaintext project-owned copy (the degraded path). */
export function serializeOwn(credential, keySource = 'none') {
  return `${JSON.stringify({
    version: OWN_FORMAT_VERSION,
    protection: 'plaintext',
    keySource,
    credential,
  }, null, 2)}\n`;
}

/** Serialize a sealed project-owned copy (SF-6 default). */
export function serializeOwnSealed(sealed, keySource) {
  return `${JSON.stringify({
    version: OWN_FORMAT_VERSION,
    protection: sealed.protection,
    keySource,
    keyId: sealed.keyId,
    nonce: sealed.nonce,
    authTag: sealed.authTag,
    ciphertext: sealed.ciphertext,
  }, null, 2)}\n`;
}

/**
 * Read the project-owned copy's envelope without opening it.
 *
 * @returns {{ version: number, protection: 'plaintext'|'aes-256-gcm', keySource: string,
 *   keyId?: string, sealed?: object, credential?: object, legacy?: boolean } | undefined}
 */
export function readOwnDocument(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  if (parsed.version === OWN_LEGACY_VERSION) {
    if (typeof parsed.credential !== 'object' || parsed.credential === null) return undefined;
    return { version: OWN_LEGACY_VERSION, protection: 'plaintext', keySource: 'none', credential: parsed.credential, legacy: true };
  }
  if (parsed.version !== OWN_FORMAT_VERSION) return undefined;
  if (parsed.protection === 'plaintext') {
    if (typeof parsed.credential !== 'object' || parsed.credential === null) return undefined;
    return {
      version: OWN_FORMAT_VERSION,
      protection: 'plaintext',
      keySource: typeof parsed.keySource === 'string' ? parsed.keySource : 'none',
      credential: parsed.credential,
    };
  }
  if (parsed.protection === 'aes-256-gcm') {
    if (typeof parsed.nonce !== 'string' || typeof parsed.authTag !== 'string' || typeof parsed.ciphertext !== 'string') {
      return undefined;
    }
    return {
      version: OWN_FORMAT_VERSION,
      protection: 'aes-256-gcm',
      keySource: typeof parsed.keySource === 'string' ? parsed.keySource : 'unknown',
      ...(typeof parsed.keyId === 'string' ? { keyId: parsed.keyId } : {}),
      sealed: {
        protection: 'aes-256-gcm',
        keyId: typeof parsed.keyId === 'string' ? parsed.keyId : '',
        nonce: parsed.nonce,
        authTag: parsed.authTag,
        ciphertext: parsed.ciphertext,
      },
    };
  }
  return undefined;
}

/** Parse an already-available plaintext project-owned copy; other shapes are rejected. */
export function parseOwnDocument(text) {
  const record = readOwnDocument(text);
  if (record === undefined || record.credential === undefined) return undefined;
  return normalizeOwnCredential(record.credential);
}

/** Normalize a stored credential object (shared by every own-copy shape). */
export function normalizeOwnCredential(stored) {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return undefined;
  if (typeof stored.accessToken !== 'string' || stored.accessToken === '') return undefined;
  const refreshExpiresAtMs = typeof stored.refreshExpiresAtMs === 'number' ? stored.refreshExpiresAtMs : undefined;
  const enterpriseId = optionalString(stored.enterpriseId);
  const nickname = optionalString(stored.nickname);
  return {
    accessToken: stored.accessToken,
    refreshToken: typeof stored.refreshToken === 'string' ? stored.refreshToken : '',
    expiresAtMs: typeof stored.expiresAtMs === 'number' ? stored.expiresAtMs : 0,
    ...(refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs }),
    domain: optionalString(stored.domain) ?? '',
    uid: optionalString(stored.uid) ?? '',
    uin: optionalString(stored.uin) ?? '',
    ...(enterpriseId === undefined ? {} : { enterpriseId }),
    ...(nickname === undefined ? {} : { nickname }),
    source: 'own-copy',
  };
}
