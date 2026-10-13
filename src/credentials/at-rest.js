// At-rest field envelopes (WorkBuddy 5.6+).
//
// Modern builds store `accessToken` / `refreshToken` as per-field envelopes
// `{ "$wbEncrypted": 1, envelope: <base64 of {suite,keyId,nonce,authTag,ciphertext}> }`.
// The document itself is plaintext. The key is not derivable offline: it is
// obtained by asking the installed app (see electron.js) for its at-rest
// secret, then hashing that secret's UTF-8 form.
//
// Failure is explicit. An envelope that cannot be opened means "wrong key /
// not this format" and is reported as such, never retried against other
// framings and never silently read as "no credential".
//
// Protocol facts derived from dsh-workbuddy-connect (MIT, (c) 2026 Corrine Hu):
// the AAD frame layout (the `WB-AAD\0` prefix, the length-prefixed framing and
// suite tags, the key id, the fixed trailer) and the envelope field names are
// byte-for-byte interoperability facts -- an envelope sealed by the app can
// only be opened with this exact framing. The surrounding code is an
// independent re-expression. See THIRD-PARTY-NOTICES.md.

import { createDecipheriv, createHash } from 'node:crypto';

/** Credential fields carrying envelopes. Account labels are not used by this tool. */
export const AUTH_FIELDS = Object.freeze(['accessToken', 'refreshToken']);

const SUITE_FIELD_FRAMING = 1;
const AAD_PREFIX = Buffer.from('WB-AAD\0', 'ascii');
const AAD_FRAMING = 'WBEV1';
const AAD_SUITE = 'sym-v1';
const KEY_ID_PATTERN = /^[0-9a-f]{16}$/u;

function lengthPrefixed(value) {
  const bytes = Buffer.from(value, 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(bytes.length);
  return Buffer.concat([header, bytes]);
}

/**
 * The authenticated context (AAD) for one field envelope, transcribed from
 * the observed framing: a fixed prefix, the framing family, the suite, the key
 * id and a fixed trailer. `suite` is only ever 1 for credential fields.
 */
export function buildAad(keyId, suite = SUITE_FIELD_FRAMING) {
  const suiteBytes = Buffer.allocUnsafe(4);
  suiteBytes.writeUInt32BE(suite);
  return Buffer.concat([
    AAD_PREFIX,
    Buffer.from([1]),
    lengthPrefixed(AAD_FRAMING),
    lengthPrefixed(AAD_SUITE),
    suiteBytes,
    lengthPrefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
}

/** Decode base64 and, when given, require an exact byte length. */
export function parseBase64(value, length) {
  if (typeof value !== 'string' || value === '') return undefined;
  let decoded;
  try {
    decoded = Buffer.from(value, 'base64');
  } catch {
    return undefined;
  }
  if (decoded.length === 0) return undefined;
  // Reject non-canonical padding so a corrupt envelope cannot be half-read.
  if (decoded.toString('base64').replace(/=+$/u, '') !== value.replace(/=+$/u, '')) return undefined;
  return length === undefined || decoded.length === length ? decoded : undefined;
}

/**
 * Parse one wrapped field. Returns undefined when the value does not claim the
 * wrapper, or claims it with an envelope that can never be decoded.
 */
export function parseWrappedField(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  if (value.$wbEncrypted !== 1 || typeof value.envelope !== 'string') return undefined;
  let inner;
  try {
    inner = JSON.parse(Buffer.from(value.envelope, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return undefined;
  const nonce = parseBase64(inner.nonce, 12);
  const authTag = parseBase64(inner.authTag, 16);
  const ciphertext = parseBase64(inner.ciphertext);
  if (nonce === undefined || authTag === undefined || ciphertext === undefined) return undefined;
  if (!Number.isInteger(inner.suite) || inner.suite !== SUITE_FIELD_FRAMING) return undefined;
  if (typeof inner.keyId !== 'string' || !KEY_ID_PATTERN.test(inner.keyId)) return undefined;
  return {
    envelope: {
      suite: inner.suite,
      keyId: inner.keyId,
      nonce,
      authTag,
      ciphertext,
    },
  };
}

/**
 * Classify an auth document's text.
 *
 * - `absent`: empty file.
 * - `plaintext`: parseable; no field uses the wrapper.
 * - `encrypted`: at least one field uses a decodable wrapper.
 * - `unrecognized`: unparsable, a non-object, or a wrapper that cannot be
 *   decoded (which means no key could ever open it).
 *
 * @returns {{ format: 'absent' | 'plaintext' | 'unrecognized' }
 *   | { format: 'encrypted', wrapped: { document: object, fields: { field: string, envelope: object }[] } }}
 */
export function classifyAuthDocument(text) {
  if (typeof text !== 'string' || text.trim() === '') return { format: 'absent' };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { format: 'unrecognized' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { format: 'unrecognized' };
  }
  const auth = typeof parsed.auth === 'object' && parsed.auth !== null ? parsed.auth : parsed;
  const fields = [];
  for (const field of AUTH_FIELDS) {
    const value = auth[field];
    if (typeof value === 'string') continue;
    const wrapped = parseWrappedField(value);
    if (wrapped === undefined && value !== undefined) return { format: 'unrecognized' };
    if (wrapped !== undefined) fields.push({ field, envelope: wrapped.envelope });
  }
  if (fields.length === 0) return { format: 'plaintext' };
  return { format: 'encrypted', wrapped: { document: parsed, fields } };
}

/** Distinct key ids across envelopes, in encounter order. */
export function keyIdsOf(fields) {
  return [...new Set(fields.map(({ envelope }) => envelope.keyId))];
}

/** Open one envelope with a protector key; undefined when it will not open. */
export function openField(key, envelope) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, envelope.nonce, { authTagLength: 16 });
    decipher.setAAD(buildAad(envelope.keyId, envelope.suite));
    decipher.setAuthTag(envelope.authTag);
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}

/** Rebuild a document, replacing wrapped fields with their opened plaintext. */
export function unwrapDocument(classification, openFieldFn) {
  const { document, fields } = classification.wrapped;
  const rebuilt = structuredClone(document);
  const auth = typeof rebuilt.auth === 'object' && rebuilt.auth !== null ? rebuilt.auth : rebuilt;
  for (const { field, envelope } of fields) {
    auth[field] = openFieldFn(field, envelope);
  }
  return rebuilt;
}

/** Validate the helper payload: `{ version: 1, atRestSecretKey: <canonical base64, 32 bytes> }`. */
export function parseAtRestPayload(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  if (parsed.version !== 1) return undefined;
  const secret = parsed.atRestSecretKey;
  if (typeof secret !== 'string' || secret === '') return undefined;
  let decoded;
  try {
    decoded = Buffer.from(secret, 'base64');
  } catch {
    return undefined;
  }
  if (decoded.length !== 32) return undefined;
  if (decoded.toString('base64') !== secret) return undefined;
  if (decoded.every((byte) => byte === 0)) return undefined;
  return { atRestSecretKey: secret };
}

/** Derive the protector key: sha256 over the secret string's UTF-8 bytes. */
export function deriveProtectorKey(secret) {
  return createHash('sha256').update(secret, 'utf8').digest();
}

/** The 16-hex key id a protector key would present in an envelope. */
export function keyIdOf(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** Turn a helper payload into `{ key, keyId }`, or undefined when unusable. */
export function protectorKeysFromPayload(text) {
  const payload = parseAtRestPayload(text);
  if (payload === undefined) return undefined;
  const key = deriveProtectorKey(payload.atRestSecretKey);
  return { key, keyId: keyIdOf(key) };
}
