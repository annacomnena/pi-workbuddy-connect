import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KEEP_ALIVE_MARGIN_MS,
  REFRESH_FAILURE_BACKOFF_MS,
  REFRESH_MARGIN_MS,
  applyRefresh,
  createSessionResolver,
  needsRefresh,
  sessionStateOf,
} from '../src/credentials/session.js';
import { REASON, WbError } from '../src/errors.js';
import { upstreamError } from '../src/upstream/client.js';

const HOUR = 3600_000;

function credential(overrides = {}) {
  return {
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAtMs: Date.now() + 8 * 24 * HOUR,
    refreshExpiresAtMs: Date.now() + 20 * 24 * HOUR,
    domain: 'www.codebuddy.cn',
    uid: 'uid-1',
    uin: 'uin-1',
    source: 'desktop',
    ...overrides,
  };
}

/** A store that records writes and has no desktop writer at all (by design). */
function fakeStore(credentialValue) {
  const writes = [];
  return {
    writes,
    current: async () => (credentialValue === undefined ? undefined : { credential: credentialValue, source: 'desktop', format: 'encrypted' }),
    writeOwnCopy: async (next) => {
      writes.push(next);
      return { path: 'own.json', keySource: 'at-rest-key' };
    },
    lastProtection: { protection: 'aes-256-gcm', keySource: 'at-rest-key' },
  };
}

test('needsRefresh fires inside the margin and only when a refresh token exists', () => {
  const now = Date.now();
  assert.equal(needsRefresh(credential({ expiresAtMs: now + REFRESH_MARGIN_MS + 1000 }), now), false);
  assert.equal(needsRefresh(credential({ expiresAtMs: now + REFRESH_MARGIN_MS - 1000 }), now), true);
  assert.equal(needsRefresh(credential({ expiresAtMs: now + 1000, refreshToken: '' }), now), false);
  assert.equal(needsRefresh(credential({ expiresAtMs: now + 1000, refreshExpiresAtMs: now - 1 }), now), false);
  assert.equal(needsRefresh(credential({ expiresAtMs: 0 }), now), false);
});

test('applyRefresh keeps identity and derives the new expiry from expiresIn', () => {
  const now = 5_000_000;
  const next = applyRefresh(credential(), { accessToken: 'new-access', expiresInSec: 3600, refreshToken: 'new-refresh' }, now);
  assert.equal(next.accessToken, 'new-access');
  assert.equal(next.refreshToken, 'new-refresh');
  assert.equal(next.expiresAtMs, now + 3600_000);
  assert.equal(next.uid, 'uid-1');
  assert.equal(next.domain, 'www.codebuddy.cn');
  assert.equal(next.source, 'own-copy');
});

test('a due credential is refreshed once and the result goes only to the own copy', async () => {
  const due = credential({ expiresAtMs: Date.now() + 60_000 });
  const store = fakeStore(due);
  let refreshCalls = 0;
  const client = {
    refreshToken: async () => {
      refreshCalls += 1;
      return { accessToken: 'new-access', refreshToken: 'new-refresh', expiresInSec: 28 * 24 * 3600 };
    },
  };
  const session = createSessionResolver({ store, client });
  const resolved = await session.resolve();
  assert.equal(refreshCalls, 1);
  assert.equal(resolved.refreshed, true);
  assert.equal(resolved.credential.accessToken, 'new-access');
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0].accessToken, 'new-access');
  // The desktop credential was never rewritten: the store has no such method.
  assert.equal(typeof store.writeDesktop, 'undefined');
});

test('concurrent resolves share one refresh (single flight)', async () => {
  const due = credential({ expiresAtMs: Date.now() + 60_000 });
  const store = fakeStore(due);
  let refreshCalls = 0;
  const client = {
    refreshToken: async () => {
      refreshCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { accessToken: 'new-access', expiresInSec: 3600 };
    },
  };
  const session = createSessionResolver({ store, client });
  const [a, b] = await Promise.all([session.resolve(), session.resolve()]);
  assert.equal(refreshCalls, 1);
  assert.equal(a.credential.accessToken, 'new-access');
  assert.equal(b.credential.accessToken, 'new-access');
});

test('a failed refresh keeps a still-valid access token and backs off', async () => {
  const due = credential({ expiresAtMs: Date.now() + 4 * 60_000 });
  const store = fakeStore(due);
  let refreshCalls = 0;
  const client = {
    refreshToken: async () => {
      refreshCalls += 1;
      throw upstreamError({ status: 500, body: '{}', context: 'the token refresh' });
    },
  };
  const session = createSessionResolver({ store, client });
  const first = await session.resolve();
  assert.equal(first.refreshed, false);
  assert.equal(first.credential.accessToken, 'old-access');
  assert.equal(first.refreshError.code, REASON.upstreamServerError);
  const second = await session.resolve();
  assert.equal(second.refreshSkipped, true);
  assert.equal(refreshCalls, 1, 'the failure backoff must prevent a retry storm');
  assert.equal(store.writes.length, 0);
  assert.ok(REFRESH_FAILURE_BACKOFF_MS > 0 && KEEP_ALIVE_MARGIN_MS > 0);
});

test('a failed refresh on an expired token fails closed as session-dead', async () => {
  const expired = credential({ expiresAtMs: Date.now() - 60_000 });
  const store = fakeStore(expired);
  const client = {
    refreshToken: async () => {
      throw upstreamError({ status: 401, body: '{"msg":"Offline user session not found"}', context: 'the token refresh' });
    },
  };
  const session = createSessionResolver({ store, client });
  await assert.rejects(session.resolve(), (error) => {
    assert.equal(error.code, REASON.sessionDead);
    assert.equal(error.detail.refreshFailure, REASON.sessionDead);
    return true;
  });
  assert.equal(store.writes.length, 0);
});

test('a missing credential is credential-missing, never a silent empty answer', async () => {
  const session = createSessionResolver({ store: fakeStore(undefined), client: {} });
  await assert.rejects(session.resolve(), (error) => error.code === REASON.credentialMissing);
});

test('sessionStateOf distinguishes active, refreshable, expired and unknown', () => {
  const now = Date.now();
  assert.equal(sessionStateOf(credential({ expiresAtMs: now + HOUR }), now).state, 'active');
  assert.equal(sessionStateOf(credential({ expiresAtMs: now - HOUR, refreshExpiresAtMs: now + HOUR }), now).state, 'refreshable');
  assert.equal(sessionStateOf(credential({ expiresAtMs: now - HOUR, refreshExpiresAtMs: now - HOUR }), now).state, 'expired');
  assert.equal(sessionStateOf(credential({ expiresAtMs: 0 }), now).state, 'unknown');
});

test('peek is local-only and cached, and a store failure is reported', async () => {
  const store = fakeStore(credential());
  const session = createSessionResolver({ store, client: {} });
  const first = await session.peek();
  assert.equal(first.effective.source, 'desktop');
  const failing = createSessionResolver({
    store: { current: async () => { throw new WbError(REASON.credentialUnreadable, 'boom'); } },
    client: {},
  });
  const peeked = await failing.peek();
  assert.equal(peeked.error.code, REASON.credentialUnreadable);
});
