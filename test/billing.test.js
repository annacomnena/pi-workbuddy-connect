import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchCredits, parseCycleEndTime } from '../src/billing/index.js';
import { REASON, WbError } from '../src/errors.js';

function clientReturning(envelope, { status = 200 } = {}) {
  return {
    url: (base, path) => new URL(path, base),
    send: async () => ({ status, ok: status < 300, headers: { get: () => null }, envelope, text: '' }),
    ensureOk(result) {
      if (!result.ok || result.envelope.code !== 0) throw new WbError(REASON.upstreamServerError, 'failed');
      return result.envelope;
    },
  };
}

const crnCredential = { accessToken: 'a', refreshToken: 'b', expiresAtMs: 0, domain: 'www.codebuddy.cn', uid: 'u', uin: '' };

test('the personal path sums package remainders', async () => {
  const envelope = {
    code: 0,
    data: {
      Response: {
        Data: {
          Accounts: [
            { PackageName: 'cycle', CycleCapacitySize: 2000, CycleCapacityRemain: 1500, CycleCapacityUsed: 500, CycleEndTime: '2026-11-01 00:00:00' },
            { PackageName: 'bonus', CapacitySize: 100, CapacityRemain: 40 },
          ],
        },
      },
    },
  };
  const credits = await fetchCredits({ client: clientReturning(envelope), credential: crnCredential, now: Date.UTC(2026, 9, 13) });
  assert.equal(credits.ok, true);
  assert.equal(credits.total, 1540);
  assert.equal(credits.packages.length, 2);
  assert.equal(credits.packages[0].name, 'cycle');
  assert.equal(credits.packages[0].remain, 1500);
  assert.equal(typeof credits.packages[0].endTimeMs, 'number');
});

test('the enterprise path accepts both field spellings', async () => {
  const credential = { ...crnCredential, enterpriseId: 'ent-1' };
  const envelope = { code: 0, data: { data: { limit_num: 1000, used_num: 250, cycleResetTime: '2026-11-01' } } };
  const credits = await fetchCredits({ client: clientReturning(envelope), credential, now: Date.now() });
  assert.equal(credits.total, 750);
  assert.equal(credits.packages[0].name, 'enterprise');
});

test('a sentinel limit means unlimited', async () => {
  const credential = { ...crnCredential, enterpriseId: 'ent-1' };
  const envelope = { code: 0, data: { data: { limitNum: -1, credit: 0 } } };
  const credits = await fetchCredits({ client: clientReturning(envelope), credential, now: Date.now() });
  assert.equal(credits.unlimited, true);
});

test('an unreachable host maps to billing-unreachable', async () => {
  const client = {
    url: (base, path) => new URL(path, base),
    send: async () => { throw new WbError(REASON.upstreamUnreachable, 'down'); },
    ensureOk: (result) => result.envelope,
  };
  await assert.rejects(
    fetchCredits({ client, credential: crnCredential, now: Date.now() }),
    (error) => error.code === REASON.billingUnreachable,
  );
});

test('an enterprise answer with no quota field is a hard error, not a zero', async () => {
  const credential = { ...crnCredential, enterpriseId: 'ent-1' };
  const client = clientReturning({ code: 0, data: { data: { something: 1 } } });
  await assert.rejects(fetchCredits({ client, credential, now: Date.now() }), (error) => error.code === REASON.upstreamClientError);
});

test('cycle end times must be real calendar moments', () => {
  assert.equal(parseCycleEndTime('2026-11-01 12:30:00'), new Date(2026, 10, 1, 12, 30, 0).getTime());
  assert.equal(parseCycleEndTime('2026-02-31 00:00:00'), undefined);
  assert.equal(parseCycleEndTime('not a date'), undefined);
});
