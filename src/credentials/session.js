// Credential session: resolve the effective credential, refresh it in good
// time, and fail closed when it cannot be made usable.
//
// Refresh contract (docs/protocol.md): when the access token is within the
// margin of expiry, POST the refresh endpoint with the refresh token, then write
// the result to **this project's own copy only**. The desktop app's file is
// never written. If the refresh fails but the access token is still valid for a
// while, the old token is kept (single-flight, with a failure backoff so a broken
// refresh endpoint cannot become a retry storm). If it is not, the state is an
// explicit `session-dead` -- never a silent downgrade.

import { REASON, WbError, describeError, reasonCodeOf } from '../errors.js';

/** Refresh once the access token is this close to expiry. */
export const REFRESH_MARGIN_MS = 5 * 60_000;
/** An old access token is still safe to use for this long after a failed refresh. */
export const KEEP_ALIVE_MARGIN_MS = 30_000;
/** After a failed refresh, do not try again for this long. */
export const REFRESH_FAILURE_BACKOFF_MS = 30_000;
/** `/healthz` reads the local credential at most this often. */
export const PEEK_TTL_MS = 30_000;

/**
 * Describe a credential's session state without contacting anything.
 * @returns {{ state: 'active'|'refreshable'|'expired'|'unknown', secondsRemaining?: number,
 *   secondsSinceExpiry?: number }}
 */
export function sessionStateOf(credential, now = Date.now()) {
  const expiresAtMs = credential?.expiresAtMs ?? 0;
  if (expiresAtMs <= 0) return { state: 'unknown' };
  if (expiresAtMs > now) return { state: 'active', secondsRemaining: Math.floor((expiresAtMs - now) / 1000) };
  const refreshUsable = typeof credential.refreshToken === 'string'
    && credential.refreshToken !== ''
    && typeof credential.refreshExpiresAtMs === 'number'
    && credential.refreshExpiresAtMs > now;
  return {
    state: refreshUsable ? 'refreshable' : 'expired',
    secondsSinceExpiry: Math.floor((now - expiresAtMs) / 1000),
  };
}

/** Whether the credential is close enough to expiry to warrant a refresh. */
export function needsRefresh(credential, now = Date.now()) {
  if (typeof credential?.expiresAtMs !== 'number' || credential.expiresAtMs <= 0) return false;
  if (credential.expiresAtMs - now > REFRESH_MARGIN_MS) return false;
  if (typeof credential.refreshToken !== 'string' || credential.refreshToken === '') return false;
  if (typeof credential.refreshExpiresAtMs === 'number' && credential.refreshExpiresAtMs > 0) {
    return credential.refreshExpiresAtMs > now;
  }
  return true;
}

/** Fold a refresh answer into a new credential. Identity fields are preserved. */
export function applyRefresh(credential, outcome, now = Date.now()) {
  return {
    ...credential,
    accessToken: outcome.accessToken,
    refreshToken: outcome.refreshToken ?? credential.refreshToken,
    expiresAtMs: typeof outcome.expiresInSec === 'number'
      ? now + outcome.expiresInSec * 1000
      : credential.expiresAtMs,
    ...(typeof outcome.refreshExpiresInSec === 'number'
      ? { refreshExpiresAtMs: now + outcome.refreshExpiresInSec * 1000 }
      : {}),
    ...(typeof outcome.domain === 'string' && outcome.domain !== '' ? { domain: outcome.domain } : {}),
    source: 'own-copy',
  };
}

/**
 * Build a resolver around a credential store and an outbound client.
 *
 * @param {{ store: object, client: object, now?: () => number, logger?: object,
 *   persist?: boolean }} options
 */
export function createSessionResolver({ store, client, now = Date.now, logger, persist = true }) {
  let inflight;
  let lastRefreshFailure;
  let peekCache;

  const log = (level, message) => {
    if (logger !== undefined && typeof logger[level] === 'function') logger[level](message);
  };

  /** The effective credential, refreshing first when it is due. */
  async function resolve() {
    const effective = await store.current();
    if (effective === undefined) {
      throw new WbError(
        REASON.credentialMissing,
        'no usable local sign-in was found; sign in inside the desktop app',
      );
    }
    const at = now();
    if (!needsRefresh(effective.credential, at)) return { ...effective, refreshed: false };
    const coolingSince = lastRefreshFailure === undefined ? undefined : at - lastRefreshFailure;
    if (coolingSince !== undefined && coolingSince < REFRESH_FAILURE_BACKOFF_MS) {
      return { ...effective, refreshed: false, refreshSkipped: true };
    }
    inflight ??= refresh(effective).finally(() => {
      inflight = undefined;
    });
    return inflight;
  }

  async function refresh(effective) {
    const at = now();
    try {
      const outcome = await client.refreshToken({ credential: effective.credential });
      const credential = applyRefresh(effective.credential, outcome, at);
      let persisted;
      if (persist) persisted = await store.writeOwnCopy(credential);
      lastRefreshFailure = undefined;
      log('info', 'access token refreshed; the new credential was written to this project\'s own copy only');
      return {
        ...effective,
        credential,
        source: 'own-copy',
        refreshed: true,
        ...(persisted === undefined ? {} : { protection: store.lastProtection }),
      };
    } catch (error) {
      const code = reasonCodeOf(error) ?? REASON.sessionRefreshFailed;
      lastRefreshFailure = at;
      const stillValid = effective.credential.expiresAtMs === 0
        || effective.credential.expiresAtMs - at > KEEP_ALIVE_MARGIN_MS;
      if (stillValid) {
        log('warn', `token refresh failed (${code}); the current access token is still valid`);
        return {
          ...effective,
          refreshed: false,
          refreshError: { code, message: describeError(error) },
        };
      }
      throw new WbError(
        REASON.sessionDead,
        `the access token expired and refreshing it failed (${code}); sign in again in the desktop app`,
        { cause: error, detail: { refreshFailure: code } },
      );
    }
  }

  /** Local-only view of the credential, cached briefly for `/healthz`. */
  async function peek() {
    const at = now();
    if (peekCache !== undefined && at - peekCache.at < PEEK_TTL_MS) return peekCache;
    let entry;
    try {
      entry = { at, effective: await store.current(), error: undefined };
    } catch (error) {
      entry = { at, effective: undefined, error };
    }
    peekCache = entry;
    return entry;
  }

  return {
    resolve,
    peek,
    /** Drop the `/healthz` cache (used after a resolve so the view is current). */
    invalidate() {
      peekCache = undefined;
    },
  };
}
