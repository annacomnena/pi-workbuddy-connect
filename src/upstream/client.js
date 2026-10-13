// The single outbound module.
//
// Every request to an upstream host goes through here, so the credential
// surface, the timeout policy and the error classification live in one place.
// There is no retry logic: a 402 or a 429 is surfaced to the caller, never
// replayed, and never retried under a different identity.

import { REASON, WbError } from '../errors.js';
import { upstreamUrl, chatBaseFor } from './domains.js';
import { chatHeaders, refreshHeaders } from './headers.js';

export const JSON_TIMEOUT_MS = 30_000;
/** A streamed answer may legitimately run for minutes; this is a total cap, not an idle one. */
export const CHAT_TIMEOUT_MS = 15 * 60_000;
/** Error messages carry at most this many body bytes; the parse itself uses the full body. */
export const ERROR_BODY_LIMIT = 4096;

export const CHAT_PATH = '/v2/chat/completions';
export const REFRESH_PATH = '/v2/plugin/auth/token/refresh';

/** A value-free description of a response body, for diagnostics. */
export function describeBodyShape(text) {
  const trimmed = String(text ?? '').replace(/^\uFEFF/u, '').trim();
  if (trimmed === '') return 'empty';
  if (/^</u.test(trimmed)) return 'html-like';
  if (/^[{\[]/u.test(trimmed)) return 'json-prefix';
  return `unexpected-prefix(${trimmed.length} bytes)`;
}

/**
 * Insufficient-credit markers (ASCII lowercase plus the original Chinese).
 * A body carrying one of these is "hard credit" even when the status is 200.
 */
export const HARD_CREDIT_MARKERS = Object.freeze([
  'insufficient credit',
  'no credit',
  'credit exhausted',
  'credits exhausted',
  'out of credit',
  'quota exceeded',
  'quota exhaust',
  'payment required',
  'credit not enough',
  'not enough credit',
  '\u79ef\u5206\u4e0d\u8db3',
  '\u989d\u5ea6\u4e0d\u8db3',
  '\u4f59\u989d\u4e0d\u8db3',
  '\u79ef\u5206\u7528\u5b8c',
  '\u989d\u5ea6\u7528\u5c3d',
  '\u6ca1\u6709\u79ef\u5206',
]);

/** Session-invalidation markers: "sign in again in the desktop app". */
export const SESSION_DEAD_MARKERS = Object.freeze(['Offline user session not found', '12153']);

/**
 * Classify an upstream failure from its HTTP status and body excerpt.
 * @returns {'hard_credit'|'session_dead'|'soft_rate'|'not_found'|'server'|'client'}
 */
export function classifyUpstreamError(status, body = '') {
  if (status === 402) return 'hard_credit';
  if (status === 401) return 'session_dead';
  const lower = String(body).toLowerCase();
  for (const marker of HARD_CREDIT_MARKERS) {
    if (lower.includes(marker.toLowerCase()) || String(body).includes(marker)) return 'hard_credit';
  }
  for (const marker of SESSION_DEAD_MARKERS) {
    if (String(body).includes(marker)) return 'session_dead';
  }
  if (status === 429) return 'soft_rate';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server';
  return 'client';
}

const KIND_TO_REASON = Object.freeze({
  hard_credit: REASON.creditExhausted,
  session_dead: REASON.sessionDead,
  soft_rate: REASON.rateLimited,
  not_found: REASON.upstreamClientError,
  server: REASON.upstreamServerError,
  client: REASON.upstreamClientError,
});

/** Extract the upstream's localized display message, when present. */
export function extractDisplayMessage(body) {
  const trimmed = String(body).trim();
  if (!trimmed.startsWith('{')) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const displayMsg = parsed.displayMsg;
  if (typeof displayMsg === 'object' && displayMsg !== null && !Array.isArray(displayMsg)) {
    if (typeof displayMsg.zh === 'string' && displayMsg.zh.trim() !== '') return displayMsg.zh.trim();
    if (typeof displayMsg.en === 'string' && displayMsg.en.trim() !== '') return displayMsg.en.trim();
  }
  if (typeof parsed.msg === 'string' && parsed.msg.trim() !== '') return parsed.msg.trim();
  return undefined;
}

/** The business code of an envelope body, when it carries one. */
export function envelopeCode(body) {
  const trimmed = String(body).trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed?.code === 'number' ? parsed.code : undefined;
  } catch {
    return undefined;
  }
}

/** Parse the envelope document; `{ code, msg, data, document }`. */
export function readEnvelope(text, status) {
  // A UTF-8 BOM is not whitespace to JSON.parse; strip it before parsing.
  const source = String(text).replace(/^\uFEFF/u, '');
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new WbError(
      REASON.upstreamServerError,
      `upstream returned a non-JSON body (http ${status}, ${describeBodyShape(source)})`,
      { detail: { status, bodyShape: describeBodyShape(source) } },
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new WbError(REASON.upstreamServerError, `upstream returned an unexpected document (http ${status})`);
  }
  return {
    code: typeof parsed.code === 'number' ? parsed.code : 0,
    msg: typeof parsed.msg === 'string' ? parsed.msg : '',
    data: 'data' in parsed ? parsed.data : undefined,
    document: parsed,
  };
}

/**
 * Parse a `Retry-After` header (delta-seconds or HTTP-date) into seconds.
 * This tool records the hint; it does not use it to schedule a retry.
 */
export function parseRetryAfter(headers) {
  const value = headers?.get?.('retry-after') ?? headers?.['retry-after'];
  if (value === undefined || value === null || value === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const at = Date.parse(String(value));
  if (Number.isFinite(at)) return Math.max(0, Math.round((at - Date.now()) / 1000));
  return undefined;
}

/** A classified error for an upstream failure, with a 429 hint when present. */
export function upstreamError({ status, body, headers, context }) {
  const kind = classifyUpstreamError(status, body);
  const retryAfterSeconds = kind === 'soft_rate' ? parseRetryAfter(headers) : undefined;
  const code = envelopeCode(body);
  const detail = {
    status,
    kind,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    ...(code === undefined ? {} : { upstreamCode: code }),
    ...(context === undefined ? {} : { context }),
  };
  const suffix = context === undefined ? '' : ` during ${context}`;
  return new WbError(
    KIND_TO_REASON[kind],
    `upstream ${kind} (http ${status})${suffix}${retryAfterSeconds === undefined ? '' : `; retry after ${retryAfterSeconds}s`}`,
    {
      detail: {
        ...detail,
        // The excerpt is carried for in-process classification (cooldown hints,
        // localized messages). It is never logged or echoed verbatim.
        bodyExcerpt: String(body ?? '').slice(0, ERROR_BODY_LIMIT),
      },
    },
  );
}

/** One upstream request/response pair, plus the parsed envelope. */
export class UpstreamClient {
  /**
   * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
   */
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? JSON_TIMEOUT_MS;
  }

  /**
   * Send one request. Transport failures become `upstream-unreachable`; every
   * HTTP/business failure is left to the caller via {@link ensureOk} so the
   * caller can name the operation in its error.
   *
   * @returns {Promise<{ status: number, ok: boolean, headers: Headers, text: string, envelope: object }>}
   */
  async send({ url, method = 'GET', headers, body, timeoutMs = this.timeoutMs, signal }) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: combined,
      });
    } catch (error) {
      throw new WbError(REASON.upstreamUnreachable, 'the upstream host could not be reached', { cause: error });
    }
    const text = await response.text();
    // Parse the FULL body: an envelope is JSON and JSON is not truncatable.
    // The excerpt is only for error messages and diagnostics.
    const excerpt = text.slice(0, ERROR_BODY_LIMIT);
    let envelope;
    try {
      envelope = readEnvelope(text, response.status);
    } catch (error) {
      if (!response.ok) throw upstreamError({ status: response.status, body: excerpt, headers: response.headers });
      throw error;
    }
    return { status: response.status, ok: response.ok, headers: response.headers, text: excerpt, envelope };
  }

  /** Throw a classified error unless the response is ok and `code === 0`. */
  ensureOk(result, context) {
    if (!result.ok || result.envelope.code !== 0) {
      throw upstreamError({
        status: result.status,
        body: result.text !== '' ? result.text : result.envelope.msg,
        headers: result.headers,
        context,
      });
    }
    return result.envelope;
  }

  /** Absolute upstream URL for a base and path, with a host allow-list check. */
  url(base, path) {
    return upstreamUrl(base, path);
  }

  /**
   * POST a chat completion and hand back the raw SSE response.
   *
   * Unlike {@link send}, this does not read the body: a chat answer is a
   * stream (the upstream rejects non-streaming bodies), so the body is returned
   * unconsumed for the gateway to pipe. A non-2xx answer is read, classified and
   * thrown, so the caller never has to guess a status.
   *
   * @returns {Promise<{ status: number, headers: Headers, stream: ReadableStream }>}
   */
  async chatStream({ credential, body, userAgent, clientVersion, signal, timeoutMs = CHAT_TIMEOUT_MS }) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
    let response;
    try {
      response = await this.fetchImpl(this.url(chatBaseFor(credential), CHAT_PATH), {
        method: 'POST',
        headers: chatHeaders(credential, { userAgent, clientVersion }),
        body,
        signal: combined,
      });
    } catch (error) {
      throw new WbError(REASON.upstreamUnreachable, 'the chat upstream could not be reached', { cause: error });
    }
    if (!response.ok) {
      const text = await response.text();
      throw upstreamError({
        status: response.status,
        body: text.slice(0, ERROR_BODY_LIMIT),
        headers: response.headers,
        context: 'the chat request',
      });
    }
    if (response.body === null || response.body === undefined) {
      throw new WbError(REASON.upstreamServerError, `the chat upstream returned an empty body (http ${response.status})`);
    }
    return { status: response.status, headers: response.headers, stream: response.body };
  }

  /**
   * Exchange the refresh token for a fresh access token.
   *
   * The refresh token appears on this endpoint only. The answer is returned as
   * data; writing it is the credential layer's job (and it is written to this
   * project's own copy, never to the desktop app's file).
   *
   * @returns {Promise<{ accessToken: string, refreshToken?: string, expiresInSec?: number,
   *   refreshExpiresInSec?: number, domain?: string }>}
   */
  async refreshToken({ credential, timeoutMs = JSON_TIMEOUT_MS }) {
    let response;
    try {
      response = await this.fetchImpl(this.url(chatBaseFor(credential), REFRESH_PATH), {
        method: 'POST',
        headers: refreshHeaders(credential),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new WbError(REASON.upstreamUnreachable, 'the token refresh endpoint could not be reached', { cause: error });
    }
    const text = await response.text();
    const excerpt = text.slice(0, ERROR_BODY_LIMIT);
    let envelope;
    try {
      envelope = readEnvelope(text, response.status);
    } catch (error) {
      if (!response.ok) {
        throw upstreamError({ status: response.status, body: excerpt, headers: response.headers, context: 'the token refresh' });
      }
      throw error;
    }
    if (!response.ok || envelope.code !== 0) {
      throw upstreamError({ status: response.status, body: excerpt, headers: response.headers, context: 'the token refresh' });
    }
    const data = typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : {};
    const accessToken = typeof data.accessToken === 'string' ? data.accessToken : '';
    if (accessToken === '') {
      throw new WbError(REASON.sessionDead, 'the token refresh returned no access token; sign in again in the desktop app');
    }
    return {
      accessToken,
      ...(typeof data.refreshToken === 'string' && data.refreshToken !== '' ? { refreshToken: data.refreshToken } : {}),
      ...(typeof data.expiresIn === 'number' && data.expiresIn > 0 ? { expiresInSec: data.expiresIn } : {}),
      ...(typeof data.refreshExpiresIn === 'number' && data.refreshExpiresIn > 0
        ? { refreshExpiresInSec: data.refreshExpiresIn }
        : {}),
      ...(typeof data.domain === 'string' && data.domain !== '' ? { domain: data.domain } : {}),
    };
  }
}
