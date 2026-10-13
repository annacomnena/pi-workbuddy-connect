// The loopback OpenAI-compatible gateway.
//
// Routes:
//   GET  /healthz                  no bearer; status + masked account + cooldowns
//   GET  /v1/models                bearer; OpenAI list, ids are the upstream's own
//                                  (`workbuddy_prefixed_id` carries the legacy
//                                  `workbuddy/<id>` spelling); filtered to the
//                                  exposure policy from gateway.json
//   POST /v1/chat/completions      bearer; `stream: true` (SSE) or `false`;
//                                  a model the policy hides is a 404
//                                  `model_not_found` (+ `workbuddy_reason_code`)
//   GET  /v1/workbuddy/credits     bearer; NON-STANDARD, masked balance
//
// The exposure policy is a local *filter*, not a security boundary: the bearer
// secret is the gate. The gateway does not do billing. Usage and charging are
// computed server-side by the upstream; this process has no local ledger, no
// pre-deduction and no balance gate.
// Its only admission control is the per-model cooldown the upstream itself
// signals with a 429 (or a hard-credit 402).

import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { Readable } from 'node:stream';
import { REASON, WbError, describeError, reasonCodeOf } from '../errors.js';
import { UPSTREAM_HOSTS } from '../upstream/domains.js';
import { extractDisplayMessage, parseRetryAfter } from '../upstream/client.js';
import { parseChatRequest, prepareChatBody, stripModelPrefix } from '../protocol/body.js';
import { maskIdentifier, maskSecret } from '../util/mask.js';
import {
  REQUEST_BODY_LIMIT,
  hostIsLoopback,
  isJsonContentType,
  originIsLoopback,
  readBody,
  writeJson,
  writeOpenAiError,
} from './http.js';
import {
  KIND_MESSAGE,
  SseAccumulator,
  chatCompletionId,
  mapUpstreamError,
  modelList,
  truncatedStreamFrame,
} from './openai.js';
import { cooldownSecondsFrom } from './cooldown.js';
import { sessionStateOf } from '../credentials/session.js';
import { DEFAULT_MODELS_CONFIG, filterModels, isExposed } from '../provider/models-config.js';

export const SERVICE_NAME = 'pi-workbuddy-connect';
export const BIND_HOST = '127.0.0.1';
const SSE_HEADERS = Object.freeze({
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
});

/** Constant-time bearer check against this process's secret. */
function bearerMatches(header, expected) {
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(.+)$/iu.exec(header.trim());
  if (match === null) return false;
  const presented = Buffer.from(match[1], 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  if (presented.length !== wanted.length) return false;
  return timingSafeEqual(presented, wanted);
}

// Imported separately so the length check above is obviously before the compare.
import { timingSafeEqual } from 'node:crypto';

/**
 * Is something already listening on this loopback port?
 *
 * A plain `listen()` cannot be trusted on Windows: two sockets may bind the
 * same port when the first did not ask for exclusive use (observed with
 * EasyCLIProxyAPI on 8317), so the bind *succeeds* and the traffic is split
 * unpredictably. An explicit connect probe is what actually tells us the port
 * is taken.
 */
function portBusy(port, host = BIND_HOST, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    let settled = false;
    const done = (busy) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * Create the gateway server.
 *
 * @param {object} deps
 * @param {{ resolve: Function, peek: Function, invalidate: Function }} deps.session
 * @param {object} deps.client            the single outbound module
 * @param {object} deps.cooldowns         ModelCooldowns
 * @param {object} deps.catalogSource     { current({refresh}) }
 * @param {string} deps.token             the per-process bearer secret
 * @param {string} deps.variantId
 * @param {'cn'|'global'} deps.region
 * @param {string} deps.userAgent
 * @param {{ mode: 'all'|'allowlist', expose: string[] }} [deps.modelsFilter]
 *   the exposure policy read from gateway.json; defaults to "expose all"
 * @param {Function} [deps.fetchCredits]  injectable for tests
 * @param {object} [deps.logger]
 * @param {number} [deps.startedAt]
 */
export function createGateway({
  session,
  client,
  cooldowns,
  catalogSource,
  token,
  variantId,
  region,
  userAgent,
  clientVersion,
  tokenSource,
  version = '0.1.0',
  fetchCredits: fetchCreditsFn,
  logger,
  startedAt = Date.now(),
  now = Date.now,
  modelsFilter = DEFAULT_MODELS_CONFIG,
}) {
  const exposure = modelsFilter ?? DEFAULT_MODELS_CONFIG;
  let sessionDead = null;
  let lastAnswer = null;

  const log = (level, message) => {
    if (logger !== undefined && typeof logger[level] === 'function') logger[level](message);
  };

  /** The masked credential view used by `/healthz`. */
  async function credentialView() {
    let peeked;
    try {
      peeked = await session.peek();
    } catch (error) {
      return { state: 'error', error: { reasonCode: reasonCodeOf(error) ?? 'unknown', message: describeError(error) } };
    }
    if (peeked.error !== undefined) {
      return { state: 'error', error: { reasonCode: reasonCodeOf(peeked.error) ?? 'unknown', message: describeError(peeked.error) } };
    }
    const effective = peeked.effective;
    if (effective === undefined || effective.credential === undefined) {
      return { state: 'absent', reasonCode: REASON.credentialMissing };
    }
    const credential = effective.credential;
    const state = sessionStateOf(credential, now());
    return {
      state: state.state,
      source: effective.source,
      format: effective.format,
      decryptable: effective.format === 'encrypted' ? true : null,
      protection: effective.protection ?? undefined,
      account: {
        uidMasked: maskIdentifier(credential.uid),
        uinMasked: maskIdentifier(credential.uin),
        enterprise: credential.enterpriseId !== undefined && credential.enterpriseId !== '',
        ...(credential.enterpriseId === undefined
          ? {}
          : { enterpriseIdMasked: maskIdentifier(credential.enterpriseId) }),
      },
      token: {
        accessTokenMasked: maskSecret(credential.accessToken),
        refreshTokenMasked: maskSecret(credential.refreshToken),
      },
      session: {
        ...state,
        expiresAt: credential.expiresAtMs > 0 ? new Date(credential.expiresAtMs).toISOString() : null,
      },
      ...(sessionDead === null ? {} : { lastSessionDead: sessionDead }),
    };
  }

  async function health(res) {
    let catalog;
    try {
      // `snapshot` never contacts the upstream: a readiness probe must not
      // spend a request, and `/healthz` needs no bearer.
      catalog = await catalogSource.snapshot();
    } catch (error) {
      catalog = { source: 'unavailable', count: 0, degradedReason: reasonCodeOf(error) ?? 'unknown' };
    }
    const credential = await credentialView();
    writeJson(res, 200, {
      ok: true,
      service: SERVICE_NAME,
      version,
      startedAt: new Date(startedAt).toISOString(),
      uptimeSeconds: Math.floor((now() - startedAt) / 1000),
      bind: BIND_HOST,
      variant: variantId,
      region,
      tokenSource,
      credential,
      catalog: { source: catalog.source, count: catalog.models?.length ?? 0, ...(catalog.degradedReason === undefined ? {} : { degradedReason: catalog.degradedReason }) },
      exposedModels: {
        mode: exposure.mode,
        count: filterModels(catalog.models ?? [], exposure).length,
        ...(exposure.mode === 'allowlist' ? { allowlist: [...exposure.expose] } : {}),
      },
      cooldowns: cooldowns.snapshot(),
      upstreamHosts: [...UPSTREAM_HOSTS],
      limits: { requestBodyBytes: REQUEST_BODY_LIMIT },
      lastAnswer,
      nonStandard: ['GET /v1/workbuddy/credits'],
    });
  }

  async function models(res, url) {
    const refresh = url.searchParams.get('refresh') === '1';
    let catalog;
    try {
      catalog = await catalogSource.current({ refresh });
    } catch (error) {
      const mapped = mapUpstreamError(error);
      return writeOpenAiError(res, mapped.status, mapped.type, mapped.message);
    }
    const allModels = Array.isArray(catalog.models) ? catalog.models : [];
    const exposed = filterModels(allModels, exposure);
    const doc = modelList(exposed, {
      group: variantId,
      source: catalog.source,
      degradedReason: catalog.degradedReason,
    });
    // Say out loud that a filter is in force, so a short list is never mistaken
    // for the full upstream roster.
    doc.workbuddy_exposed = {
      mode: exposure.mode,
      exposed: exposed.length,
      total: allModels.length,
      ...(exposure.mode === 'allowlist' ? { allowlist: [...exposure.expose] } : {}),
    };
    if (exposure.mode === 'allowlist') {
      const present = new Set(exposed.map((model) => model.id));
      const missing = exposure.expose.filter((id) => !present.has(id));
      if (missing.length > 0) doc.workbuddy_exposed.missing = missing;
    }
    writeJson(res, 200, doc);
  }

  async function credits(res) {
    let effective;
    try {
      effective = await session.resolve();
    } catch (error) {
      const mapped = mapUpstreamError(error);
      return writeOpenAiError(res, mapped.status, mapped.type, mapped.message);
    }
    session.invalidate();
    try {
      const billing = await fetchCreditsFn({ client, credential: effective.credential, now: now() });
      writeJson(res, 200, {
        object: 'workbuddy.credits',
        nonStandard: true,
        account: {
          uidMasked: maskIdentifier(effective.credential.uid),
          enterprise: effective.credential.enterpriseId !== undefined && effective.credential.enterpriseId !== '',
        },
        total: billing.total,
        unlimited: billing.unlimited === true,
        ...(billing.cycleResetTime === undefined ? {} : { cycleResetTime: billing.cycleResetTime }),
        packages: billing.packages.map((pack) => ({
          name: pack.name,
          remain: pack.remain,
          size: pack.size,
          ...(pack.unlimited === true ? { unlimited: true } : {}),
          ...(pack.endTimeMs === undefined ? {} : { endTime: new Date(pack.endTimeMs).toISOString() }),
        })),
        fetchedAt: new Date(billing.fetchedAt ?? now()).toISOString(),
        note: 'non-standard endpoint; usage and charging are computed server-side by the upstream, this is a read-only view',
      });
    } catch (error) {
      const mapped = mapUpstreamError(error);
      return writeOpenAiError(res, mapped.status, mapped.type, mapped.message);
    }
  }

  async function chat(req, res) {
    let raw;
    try {
      raw = (await readBody(req)).toString('utf8');
    } catch (error) {
      if (error?.code === 'body-too-large') {
        return writeOpenAiError(res, 413, 'invalid_request_error', `request body exceeds ${REQUEST_BODY_LIMIT} bytes`);
      }
      return writeOpenAiError(res, 400, 'invalid_request_error', 'the request body could not be read');
    }
    const parsed = parseChatRequest(raw);
    if (!parsed.ok) return writeOpenAiError(res, 400, 'invalid_request_error', parsed.message);
    const request = parsed.value;
    // Read the advertised id before prepareChatBody strips the prefix in place.
    const advertisedModel = request.model;
    const upstreamModel = stripModelPrefix(request.model);
    const wantsStream = request.stream === true;

    // Policy filter (S2.1): a model the user chose not to expose is refused
    // with a clear OpenAI-shaped 404 carrying this project's own reason code.
    // It is a local policy, not a security boundary -- the bearer is the gate.
    if (!isExposed(upstreamModel, exposure)) {
      return writeOpenAiError(
        res,
        404,
        'model_not_found',
        `the gateway does not expose the model ${JSON.stringify(upstreamModel)} (a local policy filter, not a security boundary); run \`pi-workbuddy-connect models add ${upstreamModel}\` or \`models all\``,
        {},
        { workbuddy_reason_code: REASON.modelNotExposed },
      );
    }

    const cooling = cooldowns.status(upstreamModel, now());
    if (cooling.cooling) {
      writeOpenAiError(
        res,
        429,
        'soft_rate',
        `${KIND_MESSAGE.soft_rate}; this model is in a local cooldown, retry in ${cooling.retryAfterSeconds}s`,
        { 'Retry-After': String(cooling.retryAfterSeconds) },
      );
      return;
    }

    let effective;
    try {
      effective = await session.resolve();
    } catch (error) {
      const mapped = mapUpstreamError(error);
      return writeOpenAiError(res, mapped.status, mapped.type, mapped.message);
    }
    session.invalidate();

    const body = prepareChatBody(request, { region });
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    const at = Date.now();
    // One failure path for "the answer never got going": map the upstream
    // class, apply the cooldown it implies, and answer with an OpenAI error.
    const failAttempt = (error) => {
      const mapped = mapUpstreamError(error);
      const detail = error?.detail ?? {};
      if (mapped.status === 429) {
        cooldowns.penalize(upstreamModel, cooldownSecondsFrom({
          retryAfterSeconds: detail.retryAfterSeconds,
          body: detail.bodyExcerpt,
          now: now(),
        }), now());
      } else if (mapped.status === 402) {
        cooldowns.penalize(upstreamModel, undefined, now());
      }
      if (mapped.status === 401 && mapped.type === 'session_dead') {
        sessionDead = { at: new Date(now()).toISOString(), reasonCode: reasonCodeOf(error) ?? REASON.sessionDead };
      }
      const display = extractDisplayMessage(detail.bodyExcerpt ?? '');
      const message = display === undefined ? mapped.message : `${mapped.message}: ${display}`;
      const extra = {};
      if (mapped.retryAfterSeconds !== undefined) extra['Retry-After'] = String(mapped.retryAfterSeconds);
      else if (cooldowns.status(upstreamModel, now()).cooling) {
        extra['Retry-After'] = String(cooldowns.status(upstreamModel, now()).retryAfterSeconds);
      }
      lastAnswer = { at: new Date(at).toISOString(), model: request.model, status: mapped.status, type: mapped.type, stream: wantsStream, ms: now() - at };
      log('warn', `chat ${upstreamModel} failed: ${mapped.type} (http ${mapped.status})`);
      writeOpenAiError(res, mapped.status, mapped.type, message, extra);
    };

    let result;
    try {
      result = await client.chatStream({
        credential: effective.credential,
        body,
        userAgent,
        ...(clientVersion === undefined ? {} : { clientVersion }),
        signal: controller.signal,
      });
    } catch (error) {
      return failAttempt(error);
    }

    if (wantsStream) {
      const upstream = Readable.fromWeb(result.stream);
      const iterator = upstream[Symbol.asyncIterator]();
      let sawDone = false;
      /** Forward one upstream chunk, remembering whether it was the terminator. */
      const forward = (chunk) => {
        if (chunk === undefined) return;
        if (String(chunk).includes('[DONE]')) sawDone = true;
        if (!res.writableEnded && !res.destroyed) res.write(chunk);
      };
      // Read the first chunk *before* committing to 200. An upstream that fails
      // with nothing forwarded must surface as an upstream error, not as a
      // successful but empty answer.
      let first;
      try {
        first = await iterator.next();
      } catch (error) {
        return failAttempt(error);
      }
      res.writeHead(200, SSE_HEADERS);
      let streamError = null;
      if (first.done !== true) {
        forward(first.value);
        try {
          for (;;) {
            const next = await iterator.next();
            if (next.done === true) break;
            forward(next.value);
          }
        } catch (error) {
          streamError = error;
        }
      }
      // A stream that stops without [DONE] is truncated. Say so before the
      // terminator, so a client can tell a complete answer from a broken one.
      if (streamError !== null || !sawDone) {
        const message = streamError === null
          ? 'the upstream stream ended without [DONE]; the answer is truncated'
          : `the upstream stream failed mid-answer (${streamError?.name ?? 'Error'}); the answer is truncated`;
        log('warn', message);
        if (!res.writableEnded && !res.destroyed) {
          res.write(truncatedStreamFrame(message));
          res.write('data: [DONE]\n\n');
        }
        if (!res.writableEnded) res.end();
        lastAnswer = { at: new Date(at).toISOString(), model: request.model, status: 200, type: 'truncated', stream: true, ms: now() - at };
        return;
      }
      if (!res.writableEnded) res.end();
      lastAnswer = { at: new Date(at).toISOString(), model: request.model, status: 200, type: 'ok', stream: true, ms: now() - at };
      log('info', `chat ${upstreamModel} streamed in ${now() - at}ms`);
      return;
    }

    // Non-streaming client: fold the upstream's SSE into one completion.
    const accumulator = new SseAccumulator({ model: advertisedModel, id: chatCompletionId() });
    const upstream = Readable.fromWeb(result.stream);
    let streamError = null;
    try {
      for await (const chunk of upstream) accumulator.push(chunk);
    } catch (error) {
      streamError = error;
    }
    const completion = accumulator.finish();
    if (!accumulator.done) {
      if (streamError !== null && accumulator.rawChunks === 0) {
        // Nothing usable arrived: this is the same shape as a stream that fails
        // before its first frame, so answer with an upstream error rather than
        // a misleading success.
        return failAttempt(streamError);
      }
      // Keep the partial answer, but mark it truncated (as the streaming path
      // does) instead of discarding it into a 500 internal error.
      completion.workbuddy_truncated = true;
      log('warn', streamError === null
        ? 'the upstream stream ended without [DONE]; the answer is marked truncated'
        : `the upstream stream failed mid-answer (${streamError?.name ?? 'Error'}); the partial answer is marked truncated`);
    } else if (streamError !== null) {
      log('warn', `the upstream stream failed after [DONE]; the answer is complete (${streamError?.name ?? 'Error'})`);
    }
    lastAnswer = { at: new Date(at).toISOString(), model: request.model, status: 200, type: 'ok', stream: false, ms: now() - at, ...(completion.usage === undefined ? {} : { usage: completion.usage }) };
    log('info', `chat ${upstreamModel} answered in ${now() - at}ms (non-streaming)`);
    writeJson(res, 200, completion);
  }

  const ROUTES = Object.freeze([
    { path: '/healthz', methods: ['GET'] },
    { path: '/v1/models', methods: ['GET'] },
    { path: '/v1/chat/completions', methods: ['POST'] },
    { path: '/v1/workbuddy/credits', methods: ['GET'] },
  ]);

  async function handle(req, res) {
    try {
      if (!hostIsLoopback(req.headers.host)) {
        return writeOpenAiError(res, 403, 'host_not_allowed', 'the Host header must name the loopback interface');
      }
      if (!originIsLoopback(req.headers.origin)) {
        return writeOpenAiError(res, 403, 'origin_not_allowed', 'the Origin header must be a loopback origin');
      }
      const url = new URL(req.url ?? '/', `http://${BIND_HOST}`);
      const path = url.pathname.replace(/\/+$/u, '') || '/';
      const route = ROUTES.find((candidate) => candidate.path === path);
      if (route === undefined) {
        return writeOpenAiError(res, 404, 'not_found', `no such route: ${req.method} ${path}`);
      }
      // `/healthz` is the one route served without the bearer: it is the
      // readiness probe and carries no credential material. Everything else
      // requires this process's secret.
      if (path !== '/healthz' && !bearerMatches(req.headers.authorization, token)) {
        return writeOpenAiError(
          res,
          401,
          'invalid_api_key',
          `missing or invalid Authorization bearer; read the secret from ${tokenSource === 'env' ? 'the gateway environment variable' : 'this project\'s gateway config'}`,
        );
      }
      if (req.method !== 'GET' && !isJsonContentType(req)) {
        return writeOpenAiError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json');
      }
      if (!route.methods.includes(req.method)) {
        writeOpenAiError(res, 405, 'method_not_allowed', `${req.method} is not allowed on ${path}`, { Allow: route.methods.join(', ') });
        return;
      }
      if (path === '/healthz') return await health(res);
      if (path === '/v1/models') return await models(res, url);
      if (path === '/v1/workbuddy/credits') return await credits(res);
      return await chat(req, res);
    } catch (error) {
      log('error', `unhandled gateway error: ${error?.name ?? 'Error'}`);
      if (!res.headersSent) writeOpenAiError(res, 500, 'internal', 'the gateway failed to handle the request');
      else if (!res.writableEnded) res.end();
    }
  }

  const server = createServer((req, res) => {
    handle(req, res);
  });

  return {
    server,
    handle,
    /** Bind to loopback only. Nothing else is ever permitted here. */
    async listen(port, { allowFallback = false } = {}) {
      // A preferred (config/default) port that is already serving must not be
      // shared; probe it first, then fall back to an OS-chosen free port. An
      // explicitly requested port stays explicit and fails loudly.
      let candidate = port;
      let fallback = false;
      if (candidate !== 0 && await portBusy(candidate)) {
        if (allowFallback) {
          candidate = 0;
          fallback = true;
        } else {
          // S-3: the caller asked for this port explicitly. Report the declared
          // reason code instead of a bare EADDRINUSE so the failure is diagnosable.
          throw new WbError(
            REASON.portUnavailable,
            `the requested port 127.0.0.1:${candidate} is already in use; pass a different --port or stop whatever holds it`,
            { detail: { port: candidate } },
          );
        }
      }
      return new Promise((resolve, reject) => {
        const attempt = (target, isFallback) => {
          const onError = (error) => {
            server.removeListener('error', onError);
            if (!isFallback && allowFallback && target !== 0 && (error.code === 'EADDRINUSE' || error.code === 'EACCES')) {
              attempt(0, true);
              return;
            }
            if (error.code === 'EADDRINUSE' && target !== 0) {
              // The probe above lost a race; keep the same contract.
              reject(new WbError(
                REASON.portUnavailable,
                `the requested port 127.0.0.1:${target} is already in use; pass a different --port or stop whatever holds it`,
                { cause: error, detail: { port: target } },
              ));
              return;
            }
            reject(error);
          };
          server.once('error', onError);
          server.listen(target, BIND_HOST, () => {
            server.removeListener('error', onError);
            const address = server.address();
            resolve(typeof address === 'object' && address !== null ? address.port : target);
          });
        };
        attempt(candidate, fallback);
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
    address() {
      const address = server.address();
      return typeof address === 'object' && address !== null ? address.port : undefined;
    },
  };
}

export { sessionStateOf };
