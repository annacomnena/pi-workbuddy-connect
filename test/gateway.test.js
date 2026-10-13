// Gateway tests. Everything here is loopback-only: the server binds 127.0.0.1
// and the fake upstream is an injected object, so no test can reach the network.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { createGateway } from '../src/gateway/server.js';
import { ModelCooldowns } from '../src/gateway/cooldown.js';
import { createSessionResolver } from '../src/credentials/session.js';
import { upstreamError } from '../src/upstream/client.js';
import { REASON } from '../src/errors.js';

const TOKEN = 'test-secret-token-0123456789abcdef';
const ACCESS_TOKEN = 'upstream-access-token-must-never-appear';
const CREDENTIAL = {
  accessToken: ACCESS_TOKEN,
  refreshToken: 'upstream-refresh-token',
  expiresAtMs: Date.now() + 8 * 24 * 3600 * 1000,
  refreshExpiresAtMs: Date.now() + 20 * 24 * 3600 * 1000,
  domain: 'www.codebuddy.cn',
  uid: 'fixture-uid-1234567890',
  uin: '123456789012',
  source: 'desktop',
};

const MODELS = [
  { id: 'hy3', name: 'Hy3', contextWindow: 128000, maxTokens: 32000, supportsImages: false, supportsReasoning: true },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 200000, maxTokens: 64000, supportsImages: true, credits: 'x0.79' },
];

function sse(payloads) {
  return Readable.toWeb(Readable.from(payloads.map((payload) => `data: ${payload}\n\n`)));
}

const CHUNKS = [
  JSON.stringify({ id: 'up-1', object: 'chat.completion.chunk', created: 42, model: 'hy3', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }),
  JSON.stringify({ id: 'up-1', object: 'chat.completion.chunk', created: 42, model: 'hy3', choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] }),
  JSON.stringify({ id: 'up-1', object: 'chat.completion.chunk', created: 42, model: 'hy3', choices: [{ index: 0, delta: { content: ' world' }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } }),
];

/** A client whose chatStream is scripted per test. */
function scriptedClient(script = () => ({ ok: true })) {
  const calls = [];
  return {
    calls,
    async chatStream(args) {
      calls.push(args);
      const outcome = script(args, calls.length);
      if (outcome instanceof Error) throw outcome;
      return { status: 200, headers: new Headers(), stream: outcome.stream };
    },
    async refreshToken() {
      throw new Error('refresh must not be called by these tests');
    },
  };
}

const okClient = () => scriptedClient(() => ({ stream: sse([...CHUNKS, '[DONE]']) }));

/** A web stream that fails before its first frame; nothing was forwarded. */
function failingStream() {
  return new ReadableStream({
    start(controller) {
      controller.error(new Error('the upstream stream broke before any frame'));
    },
  });
}

/**
 * A web stream that forwards the given frames, then fails. The delay matters:
 * `Readable.fromWeb` discards buffered data when a synchronous enqueue+error
 * happens in the same tick, and a real mid-answer failure always follows frames
 * that already left the upstream.
 */
function erroringStream(payloads, { delayMs = 5 } = {}) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for (const payload of payloads) {
        controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      controller.error(new Error('the upstream stream broke mid-answer'));
    },
  });
}

function fakeStore(credential = CREDENTIAL) {
  const writes = [];
  return {
    writes,
    current: async () => ({ credential, source: 'desktop', format: 'encrypted' }),
    writeOwnCopy: async (next) => {
      writes.push(next);
      return { path: 'own.json', keySource: 'at-rest-key' };
    },
    lastProtection: { protection: 'aes-256-gcm', keySource: 'at-rest-key' },
  };
}

function buildGateway(options = {}) {
  const client = options.client ?? okClient();
  const store = options.store ?? fakeStore();
  const session = createSessionResolver({ store, client });
  const cooldowns = options.cooldowns ?? new ModelCooldowns();
  const gateway = createGateway({
    session,
    client,
    cooldowns,
    catalogSource: {
      current: async () => options.catalog ?? { models: MODELS, source: 'live' },
      snapshot: async () => options.catalog ?? { models: MODELS, source: 'live' },
    },
    token: options.token ?? TOKEN,
    variantId: 'cn',
    region: 'cn',
    userAgent: 'WorkBuddy/5.7.7 WorkBuddy/5.7.7',
    tokenSource: 'config',
    modelsFilter: options.modelsFilter,
    fetchCredits: options.fetchCredits ?? (async () => ({
      total: 4321,
      unlimited: false,
      packages: [{ name: 'Fixture Pack', remain: 4321, size: 5000 }],
      fetchedAt: Date.now(),
    })),
    startedAt: Date.now() - 5000,
  });
  return { gateway, client, store, cooldowns };
}

async function startGateway(options = {}) {
  const built = buildGateway(options);
  const port = await built.gateway.listen(0);
  return { ...built, port };
}

function call(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const auth = (extra = {}) => ({ authorization: `Bearer ${TOKEN}`, ...extra });
const chatBody = (body) => JSON.stringify({ model: 'workbuddy/hy3', messages: [{ role: 'user', content: 'hi' }], ...body });

async function withGateway(options, run) {
  const started = await startGateway(options);
  try {
    return await run(started);
  } finally {
    await started.gateway.close();
  }
}

test('gate 1: a non-loopback Host is refused with 403 before routing', async () => {
  await withGateway({}, async ({ port }) => {
    const res = await call(port, { path: '/v1/models', headers: auth({ Host: 'evil.example' }) });
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.text).error.type, 'host_not_allowed');
  });
});

test('gate 2: a non-loopback Origin is refused with 403', async () => {
  await withGateway({}, async ({ port }) => {
    const res = await call(port, { path: '/v1/models', headers: auth({ Origin: 'https://evil.example' }) });
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.text).error.type, 'origin_not_allowed');
  });
});

test('gate 3: a missing or wrong bearer is 401, and a loopback Origin passes', async () => {
  await withGateway({}, async ({ port }) => {
    const missing = await call(port, { path: '/v1/models' });
    assert.equal(missing.status, 401);
    assert.equal(JSON.parse(missing.text).error.type, 'invalid_api_key');
    const wrong = await call(port, { path: '/v1/models', headers: auth({ authorization: 'Bearer nope' }) });
    assert.equal(wrong.status, 401);
    const okOrigin = await call(port, { path: '/v1/models', headers: auth({ Origin: 'http://127.0.0.1:9999' }) });
    assert.equal(okOrigin.status, 200);
  });
});

test('/healthz needs no bearer but carries no credential material', async () => {
  await withGateway({}, async ({ port }) => {
    const res = await call(port, { path: '/healthz' });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.text);
    assert.equal(body.ok, true);
    assert.equal(body.service, 'pi-workbuddy-connect');
    assert.equal(body.bind, '127.0.0.1');
    assert.equal(body.credential.state, 'active');
    assert.equal(body.credential.account.uidMasked, `${CREDENTIAL.uid.slice(0, 3)}\u2026${CREDENTIAL.uid.slice(-2)}`);
    assert.equal(body.cooldowns.constructor, Object);
    assert.equal(res.text.includes(ACCESS_TOKEN), false);
    assert.equal(res.text.includes(TOKEN), false);
    assert.equal(body.nonStandard.includes('GET /v1/workbuddy/credits'), true);
    assert.equal(res.headers['cache-control'], 'no-store');
  });
});

test('gate 4: a non-JSON content type on POST is 415', async () => {
  await withGateway({}, async ({ port }) => {
    const res = await call(port, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: auth({ 'content-type': 'text/plain' }),
      body: chatBody(),
    });
    assert.equal(res.status, 415);
    assert.equal(JSON.parse(res.text).error.type, 'unsupported_media_type');
  });
});

test('/v1/models emits the OpenAI list shape with bare ids and the legacy alias', async () => {
  await withGateway({}, async ({ port }) => {
    const res = await call(port, { path: '/v1/models', headers: auth() });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.text);
    assert.equal(body.object, 'list');
    assert.equal(body.data.length, 2);
    assert.equal(body.workbuddy_id_style, 'bare');
    const [first] = body.data;
    // The advertised id is the bare upstream id, so an installed `workbuddy`
    // provider makes the pi model reference `workbuddy/hy3` while the request
    // body keeps `hy3`.
    assert.equal(first.id, 'hy3');
    assert.equal(first.workbuddy_prefixed_id, 'workbuddy/hy3');
    assert.equal(first.object, 'model');
    assert.equal(first.owned_by, 'workbuddy');
    assert.equal(first.group, 'cn');
    assert.equal(first.context_window, 128000);
    assert.equal(first.max_output_tokens, 32000);
    assert.equal(first.capabilities.reasoning, true);
    assert.equal(body.data[1].credits, 'x0.79');
    assert.equal(body.workbuddy_source, 'live');
  });
});

test('the exposure policy filters /v1/models and refuses a hidden model with 404 (S2.1)', async () => {
  const modelsFilter = { mode: 'allowlist', expose: ['glm-5.3'] };
  await withGateway({ modelsFilter }, async ({ port }) => {
    const list = await call(port, { path: '/v1/models', headers: auth() });
    assert.equal(list.status, 200);
    const body = JSON.parse(list.text);
    assert.deepEqual(body.data.map((model) => model.id), ['glm-5.3']);
    assert.equal(body.workbuddy_exposed.mode, 'allowlist');
    assert.equal(body.workbuddy_exposed.total, 2);
    assert.equal(body.workbuddy_exposed.exposed, 1);

    // A hidden model is a clear OpenAI-shaped 404 carrying this project's code.
    const hidden = await call(port, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: auth({ 'content-type': 'application/json' }),
      body: chatBody(),
    });
    assert.equal(hidden.status, 404);
    const error = JSON.parse(hidden.text).error;
    assert.equal(error.type, 'model_not_found');
    assert.equal(error.code, 'model_not_found');
    assert.equal(error.workbuddy_reason_code, 'model-not-exposed');

    // The exposed model still answers.
    const allowed = await call(port, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: auth({ 'content-type': 'application/json' }),
      body: JSON.stringify({ model: 'workbuddy/glm-5.3', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(allowed.status, 200);
  });
});

test('unknown routes are 404 and wrong methods are 405 with Allow', async () => {
  await withGateway({}, async ({ port }) => {
    const missing = await call(port, { path: '/v1/nope', headers: auth() });
    assert.equal(missing.status, 404);
    const wrong = await call(port, { method: 'GET', path: '/v1/chat/completions', headers: auth() });
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.allow, 'POST');
  });
});

test('a streamed answer is forwarded as SSE frames in order, ending with [DONE]', async () => {
  await withGateway({}, async ({ port }) => {
    const res = await call(port, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: auth({ 'content-type': 'application/json' }),
      body: chatBody({ stream: true }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/event-stream/);
    const frames = res.text.split('\n\n').filter((frame) => frame.trim() !== '');
    assert.equal(frames.length, 4);
    assert.match(frames[0], /"role":"assistant"/);
    assert.match(frames[1], /"content":"Hello"/);
    assert.match(frames[2], /"content":" world"/);
    assert.equal(frames[3], 'data: [DONE]');
    assert.equal(res.text.endsWith('data: [DONE]\n\n'), true);
    assert.equal(res.text.includes('workbuddy_truncated'), false);
    assert.equal(res.text.includes(TOKEN), false);
  });
});

test('a stream that fails before its first frame is 502, not an empty 200 (MF-1)', async () => {
  const client = scriptedClient(() => ({ stream: failingStream() }));
  await withGateway({ client }, async ({ port }) => {
    const res = await call(port, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: auth({ 'content-type': 'application/json' }),
      body: chatBody({ stream: true }),
    });
    // The 200 header must not have been sent: the failure is reported as a real
    // upstream error rather than a "successful but empty" answer.
    assert.equal(res.status, 502);
    assert.equal(JSON.parse(res.text).error.type, 'upstream_error');
    assert.match(res.headers['content-type'], /application\/json/);
    assert.equal(res.text.includes('[DONE]'), false);
  });
});

test('a stream that fails mid-answer is marked workbuddy_truncated before [DONE] (MF-1)', async () => {
  const client = scriptedClient(() => ({ stream: erroringStream([CHUNKS[0], CHUNKS[1]]) }));
  await withGateway({ client }, async ({ port }) => {
    const res = await call(port, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: auth({ 'content-type': 'application/json' }),
      body: chatBody({ stream: true }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/event-stream/);
    assert.match(res.text, /"content":"Hello"/);
    assert.match(res.text, /"workbuddy_truncated":true/);
    assert.match(res.text, /"type":"workbuddy_truncated"/);
    const frames = res.text.split('\n\n').filter((frame) => frame.trim() !== '');
    assert.equal(frames.at(-1), 'data: [DONE]');
    assert.equal(frames.at(-2).includes('workbuddy_truncated'), true);
  });
});

test('a stream that ends without [DONE] is marked truncated (MF-1)', async () => {
  const client = scriptedClient(() => ({ stream: sse([CHUNKS[0], CHUNKS[1]]) }));
  await withGateway({ client }, async ({ port }) => {
    const res = await call(port, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: auth({ 'content-type': 'application/json' }),
      body: chatBody({ stream: true }),
    });
    assert.equal(res.status, 200);
    assert.match(res.text, /"workbuddy_truncated":true/);
    assert.equal(res.text.endsWith('data: [DONE]\n\n'), true);
  });
});

test('stream:false folds the upstream SSE into one chat.completion', async () => {
  await withGateway({}, async ({ port }) => {
    const res = await call(port, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: auth({ 'content-type': 'application/json' }),
      body: chatBody({ stream: false }),
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.text);
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.choices[0].message.role, 'assistant');
    assert.equal(body.choices[0].message.content, 'Hello world');
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.deepEqual(body.usage, { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 });
    assert.equal(body.model, 'workbuddy/hy3');
  });
});

test('a truncated stream is marked instead of being reported as complete', async () => {
  const client = scriptedClient(() => ({ stream: sse([CHUNKS[0], CHUNKS[1]]) }));
  await withGateway({ client }, async ({ port }) => {
    const res = await call(port, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: auth({ 'content-type': 'application/json' }),
      body: chatBody({ stream: false }),
    });
    assert.equal(JSON.parse(res.text).workbuddy_truncated, true);
  });
});

test('a non-streaming fold that fails before any frame is 502, not 500 internal (SF-1)', async () => {
  const client = scriptedClient(() => ({ stream: failingStream() }));
  await withGateway({ client }, async ({ port }) => {
    const res = await call(port, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: auth({ 'content-type': 'application/json' }),
      body: chatBody({ stream: false }),
    });
    assert.equal(res.status, 502);
    assert.equal(JSON.parse(res.text).error.type, 'upstream_error');
  });
});

test('a non-streaming fold that fails mid-answer keeps the partial answer, marked truncated (SF-1)', async () => {
  const client = scriptedClient(() => ({ stream: erroringStream([CHUNKS[0], CHUNKS[1]]) }));
  await withGateway({ client }, async ({ port }) => {
    const res = await call(port, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: auth({ 'content-type': 'application/json' }),
      body: chatBody({ stream: false }),
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.text);
    assert.equal(body.choices[0].message.content, 'Hello');
    assert.equal(body.workbuddy_truncated, true);
  });
});

test('the OpenAI body is mapped to the upstream wire shape', async () => {
  const client = okClient();
  await withGateway({ client }, async ({ port }) => {
    const res = await call(port, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: auth({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        model: 'workbuddy/glm-5.3',
        stream: false,
        reasoning_effort: 'off',
        tool_choice: { type: 'function', function: { name: 'get_weather' } },
        messages: [{ role: 'developer', content: 'sys' }, { role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(res.status, 200);
    const upstream = JSON.parse(client.calls[0].body);
    assert.equal(upstream.model, 'glm-5.3');
    assert.equal(upstream.stream, true);
    assert.equal(upstream.reasoning_effort, undefined);
    assert.equal(upstream.tool_choice, 'get_weather');
    assert.equal(upstream.messages[0].role, 'system');
    assert.equal(client.calls[0].userAgent, 'WorkBuddy/5.7.7 WorkBuddy/5.7.7');
  });
});

test('a malformed request is 400 without touching the upstream', async () => {
  const client = okClient();
  await withGateway({ client }, async ({ port }) => {
    for (const body of ['not json', '{"messages":[]}', '{"model":"hy3"}']) {
      const res = await call(port, {
        method: 'POST',
        path: '/v1/chat/completions',
        headers: auth({ 'content-type': 'application/json' }),
        body,
      });
      assert.equal(res.status, 400, body);
      assert.equal(JSON.parse(res.text).error.type, 'invalid_request_error');
    }
    assert.equal(client.calls.length, 0);
  });
});

test('a 429 starts a per-model cooldown; other models keep working and /healthz shows it', async () => {
  let failing = true;
  const client = scriptedClient((args, count) => {
    if (failing && JSON.parse(args.body).model === 'hy3') {
      return upstreamError({ status: 429, body: JSON.stringify({ code: 6004 }), headers: { get: () => '7' } });
    }
    return { stream: sse([...CHUNKS, '[DONE]']) };
  });
  await withGateway({ client }, async ({ port, cooldowns }) => {
    const first = await call(port, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: auth({ 'content-type': 'application/json' }),
      body: chatBody({ stream: false }),
    });
    assert.equal(first.status, 429);
    assert.equal(first.headers['retry-after'], '7');
    const cooldown = cooldowns.status('hy3');
    assert.equal(cooldown.cooling, true);
    assert.equal(cooldown.retryAfterSeconds, 7);

    // The same model is refused immediately: no second upstream call, no storm.
    const second = await call(port, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: auth({ 'content-type': 'application/json' }),
      body: chatBody({ stream: false }),
    });
    assert.equal(second.status, 429);
    assert.match(JSON.parse(second.text).error.message, /local cooldown/);
    assert.equal(client.calls.length, 1);

    const health = await call(port, { path: '/healthz' });
    assert.equal(JSON.parse(health.text).cooldowns.hy3 > 0, true);
    assert.equal(JSON.parse(health.text).lastAnswer.type, 'soft_rate');

    // A different model is unaffected.
    failing = false;
    const other = await call(port, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: auth({ 'content-type': 'application/json' }),
      body: chatBody({ stream: false, model: 'workbuddy/glm-5.3' }),
    });
    assert.equal(other.status, 200);
    assert.equal(client.calls.length, 2);
  });
});

test('a 402 is a hard-credit failure and is never retried', async () => {
  const client = scriptedClient(() => upstreamError({ status: 402, body: '{"msg":"insufficient credit"}' }));
  await withGateway({ client }, async ({ port, cooldowns }) => {
    const res = await call(port, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: auth({ 'content-type': 'application/json' }),
      body: chatBody({ stream: false }),
    });
    assert.equal(res.status, 402);
    assert.equal(client.calls.length, 1);
    assert.equal(cooldowns.status('hy3').cooling, true);
  });
});

test('an upstream session death is 401 and never falls back to another identity', async () => {
  const client = scriptedClient(() => upstreamError({ status: 401, body: '{"msg":"Offline user session not found"}' }));
  await withGateway({ client }, async ({ port }) => {
    const res = await call(port, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: auth({ 'content-type': 'application/json' }),
      body: chatBody({ stream: false }),
    });
    assert.equal(res.status, 401);
    assert.equal(JSON.parse(res.text).error.type, 'session_dead');
    assert.equal(client.calls.length, 1);
    const health = JSON.parse((await call(port, { path: '/healthz' })).text);
    assert.equal(typeof health.credential.lastSessionDead.at, 'string');
  });
});

test('a missing credential fails closed with 401 not_signed_in', async () => {
  const client = okClient();
  const store = {
    current: async () => undefined,
    writeOwnCopy: async () => ({ path: 'x', keySource: 'none' }),
    lastProtection: undefined,
  };
  await withGateway({ client, store }, async ({ port }) => {
    const res = await call(port, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: auth({ 'content-type': 'application/json' }),
      body: chatBody({ stream: false }),
    });
    assert.equal(res.status, 401);
    assert.equal(JSON.parse(res.text).error.type, 'not_signed_in');
    assert.equal(client.calls.length, 0);
  });
});

test('an unreachable upstream is 502', async () => {
  const { WbError } = await import('../src/errors.js');
  const client = scriptedClient(() => new WbError(REASON.upstreamUnreachable, 'the chat upstream could not be reached'));
  await withGateway({ client }, async ({ port }) => {
    const res = await call(port, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: auth({ 'content-type': 'application/json' }),
      body: chatBody({ stream: false }),
    });
    assert.equal(res.status, 502);
  });
});

test('the non-standard credits endpoint is masked and labelled', async () => {
  await withGateway({}, async ({ port }) => {
    const res = await call(port, { path: '/v1/workbuddy/credits', headers: auth() });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.text);
    assert.equal(body.object, 'workbuddy.credits');
    assert.equal(body.nonStandard, true);
    assert.equal(body.total, 4321);
    assert.equal(body.packages[0].name, 'Fixture Pack');
    assert.equal(body.account.uidMasked, 'fix\u202690');
    assert.equal(res.text.includes(ACCESS_TOKEN), false);
  });
});

test('a failing balance read is reported with the upstream class, not swallowed', async () => {
  const fetchCredits = async () => {
    throw upstreamError({ status: 429, body: '{}', headers: { get: () => '3' }, context: 'the billing read' });
  };
  await withGateway({ fetchCredits }, async ({ port }) => {
    // The billing failure is classified; the gateway maps it to the upstream class.
    const res = await call(port, { path: '/v1/workbuddy/credits', headers: auth() });
    assert.equal(res.status, 429);
    assert.equal(JSON.parse(res.text).error.type, 'soft_rate');
  });
});

test('an explicitly requested port that is taken reports the declared reason code (S-3)', async () => {
  const blocker = createServer(() => {});
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const taken = blocker.address().port;
  const { gateway } = buildGateway();
  try {
    await assert.rejects(
      gateway.listen(taken, { allowFallback: false }),
      (error) => error.name === 'WbError' && error.code === REASON.portUnavailable && error.detail.port === taken && /already in use/u.test(error.message),
    );
  } finally {
    await gateway.close();
    await new Promise((resolve) => blocker.close(resolve));
  }
});
