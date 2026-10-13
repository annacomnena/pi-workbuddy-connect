import assert from 'node:assert/strict';
import test from 'node:test';
import {
  UpstreamClient,
  classifyUpstreamError,
  parseRetryAfter,
  upstreamError,
} from '../src/upstream/client.js';
import { REASON } from '../src/errors.js';

test('HTTP status classification covers the documented classes', () => {
  assert.equal(classifyUpstreamError(402, ''), 'hard_credit');
  assert.equal(classifyUpstreamError(401, ''), 'session_dead');
  assert.equal(classifyUpstreamError(429, ''), 'soft_rate');
  assert.equal(classifyUpstreamError(404, ''), 'not_found');
  assert.equal(classifyUpstreamError(500, ''), 'server');
  assert.equal(classifyUpstreamError(400, 'bad request'), 'client');
});

test('credit and session markers classify even on a 200 body', () => {
  assert.equal(classifyUpstreamError(200, '\u79ef\u5206\u4e0d\u8db3'), 'hard_credit');
  assert.equal(classifyUpstreamError(200, 'Offline user session not found'), 'session_dead');
  assert.equal(classifyUpstreamError(200, '{"msg":"err 12153"}'), 'session_dead');
});

test('Retry-After parses as seconds or an HTTP date', () => {
  assert.equal(parseRetryAfter({ get: () => '12' }), 12);
  assert.ok(parseRetryAfter({ get: () => new Date(Date.now() + 5000).toUTCString() }) >= 4);
  assert.equal(parseRetryAfter({ get: () => null }), undefined);
});

function fakeResponse({ status = 200, body = '{"code":0,"data":{}}', headers = {} }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
    async json() { return JSON.parse(body); },
  };
}

test('a 429 becomes rate-limited with the upstream hint and no retry', async () => {
  const client = new UpstreamClient({
    fetchImpl: async () => fakeResponse({ status: 429, body: '{"code":6004,"msg":"too many"}', headers: { 'retry-after': '30' } }),
  });
  const result = await client.send({ url: new URL('https://www.codebuddy.cn/x'), headers: {} });
  assert.throws(() => client.ensureOk(result, 'the billing read'), (error) => {
    assert.equal(error.code, REASON.rateLimited);
    assert.equal(error.detail.retryAfterSeconds, 30);
    assert.equal(error.detail.upstreamCode, 6004);
    return true;
  });
});

test('a 401 is session-dead', async () => {
  const client = new UpstreamClient({ fetchImpl: async () => fakeResponse({ status: 401, body: '{"code":1,"msg":"unauthorized"}' }) });
  const result = await client.send({ url: new URL('https://www.codebuddy.cn/x'), headers: {} });
  assert.throws(() => client.ensureOk(result, 'the billing read'), (error) => error.code === REASON.sessionDead);
});

test('a transport failure is upstream-unreachable', async () => {
  const client = new UpstreamClient({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(
    client.send({ url: new URL('https://www.codebuddy.cn/x'), headers: {} }),
    (error) => error.code === REASON.upstreamUnreachable,
  );
});

test('a non-zero business code on a 200 is classified too', async () => {
  const error = upstreamError({ status: 200, body: '{"code":1,"msg":"quota exceeded"}' });
  assert.equal(error.code, REASON.creditExhausted);
});

test('a response larger than the error limit is still parsed in full', async () => {
  // Regression: parsing a 4 KiB excerpt instead of the whole body broke a
  // large billing envelope with a misleading "non-JSON body" error.
  const accounts = Array.from({ length: 200 }, (_, index) => ({ PackageName: `pack-${index}`, CycleCapacityRemain: index }));
  const body = JSON.stringify({ code: 0, data: { Response: { Data: { Accounts: accounts } } } });
  assert.ok(body.length > 4096);
  const client = new UpstreamClient({ fetchImpl: async () => fakeResponse({ status: 200, body }) });
  const result = await client.send({ url: new URL('https://www.codebuddy.cn/x'), headers: {} });
  assert.equal(result.envelope.code, 0);
  assert.equal(result.envelope.data.Response.Data.Accounts.length, 200);
  assert.ok(result.text.length <= 4096);
});

test('a UTF-8 BOM does not make a JSON envelope unreadable', async () => {
  const client = new UpstreamClient({ fetchImpl: async () => fakeResponse({ status: 200, body: `\uFEFF{"code":0,"data":{}}` }) });
  const result = await client.send({ url: new URL('https://www.codebuddy.cn/x'), headers: {} });
  assert.equal(result.envelope.code, 0);
});

test('a non-JSON 200 body is reported with a value-free shape', async () => {
  const client = new UpstreamClient({ fetchImpl: async () => fakeResponse({ status: 200, body: '<!DOCTYPE html><html></html>' }) });
  await assert.rejects(
    client.send({ url: new URL('https://www.codebuddy.cn/x'), headers: {} }),
    (error) => {
      assert.equal(error.code, REASON.upstreamServerError);
      assert.equal(error.detail.bodyShape, 'html-like');
      return true;
    },
  );
});

test('the host allow-list rejects a non-upstream URL', () => {
  const client = new UpstreamClient();
  assert.throws(() => client.url('https://evil.example.com', '/x'));
  assert.equal(client.url('https://www.codebuddy.cn', '/x').hostname, 'www.codebuddy.cn');
});
