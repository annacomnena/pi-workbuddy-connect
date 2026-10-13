// Masking helpers.
//
// Every value that leaves the process — human output, `--json`, error text,
// test snapshots — goes through these. A masked value keeps just enough shape
// to be recognisable ("is this the same token I saw before?") and never the
// body: token/refreshToken get a 4+4 window, identifiers (uid/uin) a 3+2 one.

const ELLIPSIS = '\u2026';

/**
 * Mask a secret (access token, refresh token, session value).
 * Returns null for absent values so callers can distinguish "none" from "masked".
 */
export function maskSecret(value) {
  if (typeof value !== 'string' || value === '') return null;
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}${ELLIPSIS}${value.slice(-4)}`;
}

/** Mask an account identifier (uid/uin/enterprise id). */
export function maskIdentifier(value) {
  if (typeof value !== 'string' || value === '') return null;
  if (value.length <= 5) return '*'.repeat(Math.max(value.length, 1));
  return `${value.slice(0, 3)}${ELLIPSIS}${value.slice(-2)}`;
}

/** Mask a key id (already public in the sense that it is not secret material). */
export function maskKeyId(value) {
  if (typeof value !== 'string' || value === '') return null;
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}${ELLIPSIS}${value.slice(-4)}`;
}
