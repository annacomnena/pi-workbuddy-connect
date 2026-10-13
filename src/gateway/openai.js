// OpenAI-compatible surface: the model list, the error shape, and SSE folding.
//
// The gateway is a translator, not an accounting layer. It reports the models it
// can reach and forwards an answer; it never pre-deducts credit, never gates on
// a local balance, and never invents a usage number the upstream did not send.

import { withModelPrefix } from '../protocol/body.js';

/** Upstream failure class -> HTTP status presented to the client. */
export const KIND_STATUS = Object.freeze({
  hard_credit: 402,
  soft_rate: 429,
  session_dead: 401,
  not_found: 502,
  server: 502,
  client: 400,
});

/** A value-free description of each class, used in the error body. */
export const KIND_MESSAGE = Object.freeze({
  hard_credit: 'the account has no credit left for this model',
  soft_rate: 'the upstream is rate-limiting this model',
  session_dead: 'the local WorkBuddy sign-in is no longer valid; sign in again in the desktop app',
  not_found: 'the upstream does not know this model or route',
  server: 'the upstream failed or could not be reached',
  client: 'the upstream rejected the request',
});

/** Map a thrown upstream error into the status and OpenAI error type to send. */
export function mapUpstreamError(error) {
  const kind = error?.detail?.kind;
  if (typeof kind === 'string' && kind in KIND_STATUS) {
    return {
      status: KIND_STATUS[kind],
      type: kind,
      message: `${KIND_MESSAGE[kind]} (upstream http ${error?.detail?.status ?? '?'})`,
      retryAfterSeconds: error?.detail?.retryAfterSeconds,
      upstreamCode: error?.detail?.upstreamCode,
    };
  }
  if (error?.code === 'session-dead') {
    return { status: 401, type: 'session_dead', message: error.message };
  }
  if (error?.code === 'credential-missing') {
    return { status: 401, type: 'not_signed_in', message: error.message };
  }
  if (error?.code === 'credential-undecryptable' || error?.code === 'credential-unreadable') {
    // Fail closed: an unreadable credential is a local fault, not a 400.
    return { status: 502, type: error.code, message: error.message };
  }
  if (error?.code === 'credit-exhausted') {
    return { status: 402, type: 'hard_credit', message: error.message };
  }
  if (error?.code === 'rate-limited') {
    return { status: 429, type: 'soft_rate', message: error.message, retryAfterSeconds: error?.detail?.retryAfterSeconds };
  }
  return { status: 502, type: 'upstream_error', message: error?.message ?? 'the request failed' };
}

/**
 * The OpenAI model list document, annotated with the group, the context window
 * and the capabilities the catalog carries.
 */
export function modelList(models, { group, source, degradedReason } = {}) {
  return {
    object: 'list',
    data: models.map((model) => ({
      id: withModelPrefix(model.id),
      object: 'model',
      created: 0,
      owned_by: 'workbuddy',
      ...(group === undefined ? {} : { group }),
      name: model.name ?? model.id,
      ...(model.contextWindow === undefined ? {} : { context_window: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { max_output_tokens: model.maxTokens }),
      ...(model.credits === undefined ? {} : { credits: model.credits }),
      capabilities: {
        vision: model.supportsImages === true,
        reasoning: model.supportsReasoning === true,
        ...(model.supportedEfforts === undefined ? {} : { supported_efforts: model.supportedEfforts }),
        ...(model.defaultEffort === undefined ? {} : { default_effort: model.defaultEffort }),
      },
    })),
    // Non-standard provenance fields: which rung of live -> saved -> built-in
    // answered, so a stale list is never mistaken for the live one.
    ...(source === undefined ? {} : { workbuddy_source: source }),
    ...(degradedReason === undefined ? {} : { workbuddy_degraded_reason: degradedReason }),
  };
}

/** A per-answer id, shaped like the upstream's own. */
export function chatCompletionId() {
  return `chatcmpl-wb-${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
}

/**
 * The SSE frame that marks a truncated upstream stream. It is written before
 * the final `[DONE]`, so a client can tell a complete answer from a broken one;
 * the non-streaming fold uses the same `workbuddy_truncated` marker.
 */
export function truncatedStreamFrame(message) {
  return `data: ${JSON.stringify({
    error: { message, type: 'workbuddy_truncated', code: 'workbuddy_truncated' },
    workbuddy_truncated: true,
  })}\n\n`;
}

function normalizeUsage(usage) {
  if (typeof usage !== 'object' || usage === null) return undefined;
  const prompt = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined;
  const completion = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined;
  const total = typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined;
  if (prompt === undefined && completion === undefined && total === undefined) return undefined;
  return {
    ...(prompt === undefined ? {} : { prompt_tokens: prompt }),
    ...(completion === undefined ? {} : { completion_tokens: completion }),
    ...(total === undefined ? {} : { total_tokens: total }),
  };
}

function mergeToolCalls(state, deltas) {
  for (const delta of deltas) {
    if (typeof delta !== 'object' || delta === null) continue;
    const index = typeof delta.index === 'number' ? delta.index : state.toolCalls.size;
    const call = state.toolCalls.get(index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
    if (typeof delta.id === 'string' && delta.id !== '') call.id = delta.id;
    if (typeof delta.type === 'string' && delta.type !== '') call.type = delta.type;
    const fn = delta.function;
    if (typeof fn === 'object' && fn !== null) {
      if (typeof fn.name === 'string' && fn.name !== '') call.function.name += fn.name;
      if (typeof fn.arguments === 'string') call.function.arguments += fn.arguments;
    }
    state.toolCalls.set(index, call);
  }
}

/**
 * Fold an OpenAI SSE stream into one non-streaming completion.
 *
 * Also tracks whether the upstream sent `data: [DONE]`, so a truncated stream
 * can be reported instead of being presented as a finished answer.
 */
export class SseAccumulator {
  #buffer = '';

  constructor({ model, id = chatCompletionId(), created = Math.floor(Date.now() / 1000) } = {}) {
    this.model = model;
    this.id = id;
    this.created = created;
    this.done = false;
    this.usage = undefined;
    this.choices = new Map();
    this.rawChunks = 0;
  }

  push(text) {
    this.#buffer += String(text);
    let index;
    while ((index = this.#buffer.indexOf('\n\n')) !== -1) {
      const frame = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 2);
      this.#consumeFrame(frame);
    }
    return this;
  }

  #consumeFrame(frame) {
    const payloads = [];
    for (const line of frame.split('\n')) {
      const trimmed = line.replace(/\r$/u, '');
      if (!trimmed.startsWith('data:')) continue;
      payloads.push(trimmed.slice(5).trimStart());
    }
    const payload = payloads.join('');
    if (payload === '') return;
    if (payload === '[DONE]') {
      this.done = true;
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return;
    }
    this.rawChunks += 1;
    this.#merge(chunk);
  }

  #merge(chunk) {
    if (typeof chunk !== 'object' || chunk === null) return;
    if (typeof chunk.id === 'string' && chunk.id !== '') this.id = chunk.id;
    // The upstream answers with its own model id; the completion keeps the id
    // the client asked for, which is what OpenAI clients expect echoed back.
    if (typeof chunk.model === 'string' && chunk.model !== '' && this.model === undefined) this.model = chunk.model;
    if (typeof chunk.created === 'number') this.created = chunk.created;
    const usage = normalizeUsage(chunk.usage);
    if (usage !== undefined) this.usage = usage;
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const choice of choices) {
      if (typeof choice !== 'object' || choice === null) continue;
      const index = typeof choice.index === 'number' ? choice.index : 0;
      const state = this.choices.get(index) ?? {
        index,
        role: 'assistant',
        content: '',
        reasoning: '',
        toolCalls: new Map(),
        finishReason: null,
      };
      const delta = typeof choice.delta === 'object' && choice.delta !== null ? choice.delta : {};
      if (typeof delta.role === 'string' && delta.role !== '') state.role = delta.role;
      if (typeof delta.content === 'string') state.content += delta.content;
      if (typeof delta.reasoning_content === 'string') state.reasoning += delta.reasoning_content;
      if (Array.isArray(delta.tool_calls)) mergeToolCalls(state, delta.tool_calls);
      if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') state.finishReason = choice.finish_reason;
      this.choices.set(index, state);
    }
  }

  /** Consume any trailing frame and build the completion object. */
  finish() {
    if (this.#buffer.trim() !== '') {
      this.#consumeFrame(this.#buffer);
      this.#buffer = '';
    }
    const choices = [...this.choices.values()]
      .sort((left, right) => left.index - right.index)
      .map((state) => {
        const toolCalls = [...state.toolCalls.entries()]
          .sort((left, right) => left[0] - right[0])
          .map(([, call]) => call);
        return {
          index: state.index,
          message: {
            role: state.role,
            content: state.content === '' ? null : state.content,
            ...(state.reasoning === '' ? {} : { reasoning_content: state.reasoning }),
            ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
          },
          finish_reason: state.finishReason,
        };
      });
    return {
      id: this.id,
      object: 'chat.completion',
      created: this.created,
      model: this.model,
      choices,
      ...(this.usage === undefined ? {} : { usage: this.usage }),
    };
  }
}
